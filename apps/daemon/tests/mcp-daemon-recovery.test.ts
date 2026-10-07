import { describe, expect, it, vi } from 'vitest';

import { McpUserQuitError } from '../src/mcp-bootstrap.js';
import { _listMcpResources, _readMcpResource, createMcpDaemonTarget } from '../src/mcp.js';

const USER_QUIT_MESSAGE = 'Open Design is not running because the user quit it. Ask the user to open the Open Design app, then retry.';

function unreachable(url: string) {
  return {
    content: [{ type: 'text' as const, text: `cannot reach the OpenDesign daemon at ${url}.` }],
    isError: true,
  };
}

describe('MCP daemon target recovery', () => {
  it('refreshes the discovered daemon URL before a tool call', async () => {
    const resolveDaemonUrl = vi.fn(async () => 'http://127.0.0.1:62002');
    const call = vi.fn(async (url: string) => ({
      content: [{ type: 'text' as const, text: url }],
    }));
    const target = createMcpDaemonTarget({
      daemonUrl: 'http://127.0.0.1:62001',
      resolveDaemonUrl,
    });

    await target.call('get_project', {}, call);

    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith('http://127.0.0.1:62002');
    expect(target.currentUrl()).toBe('http://127.0.0.1:62002');
  });

  it('rediscovers and retries one safe read when the daemon changes between discovery and fetch', async () => {
    const resolveDaemonUrl = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce('http://127.0.0.1:62001')
      .mockResolvedValueOnce('http://127.0.0.1:62002');
    const call = vi
      .fn<(url: string) => Promise<ReturnType<typeof unreachable>>>()
      .mockResolvedValueOnce(unreachable('http://127.0.0.1:62001'))
      .mockResolvedValueOnce({
        content: [{ type: 'text' as const, text: '{"id":"project-1"}' }],
        isError: false,
      });
    const target = createMcpDaemonTarget({
      daemonUrl: 'http://127.0.0.1:62000',
      resolveDaemonUrl,
    });

    const result = await target.call('get_project', { project: 'project-1' }, call);

    expect(result.isError).not.toBe(true);
    expect(call.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:62001',
      'http://127.0.0.1:62002',
    ]);
  });

  it('refreshes after an ambiguous write failure without replaying the write', async () => {
    const resolveDaemonUrl = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce('http://127.0.0.1:62001')
      .mockResolvedValueOnce('http://127.0.0.1:62002');
    const call = vi.fn(async (url: string) => unreachable(url));
    const target = createMcpDaemonTarget({
      daemonUrl: 'http://127.0.0.1:62000',
      resolveDaemonUrl,
    });

    const result = await target.call(
      'create_project',
      { name: 'must-not-be-replayed' },
      call,
    );

    expect(result.isError).toBe(true);
    expect(call).toHaveBeenCalledTimes(1);
    expect(target.currentUrl()).toBe('http://127.0.0.1:62002');
    // The caller learns the write is ambiguous because the service restarted.
    expect(result.content.map((item) => item.text).join('\n')).toContain(
      'may or may not have been applied',
    );
  });

  it('keeps the plain unreachable error when the daemon did not move', async () => {
    const resolveDaemonUrl = vi.fn(async () => 'http://127.0.0.1:62001');
    const call = vi.fn(async (url: string) => unreachable(url));
    const target = createMcpDaemonTarget({
      daemonUrl: 'http://127.0.0.1:62001',
      resolveDaemonUrl,
    });

    const result = await target.call('create_project', { name: 'x' }, call);

    expect(result).toEqual(unreachable('http://127.0.0.1:62001'));
  });

  it('reports a user quit detected on the retry refresh without replaying a read', async () => {
    const resolveDaemonUrl = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce('http://127.0.0.1:62001')
      .mockRejectedValueOnce(new McpUserQuitError());
    const call = vi.fn(async (url: string) => unreachable(url));
    const target = createMcpDaemonTarget({
      daemonUrl: 'http://127.0.0.1:62001',
      resolveDaemonUrl,
    });

    await expect(target.call('list_projects', {}, call)).resolves.toMatchObject({
      isError: true,
      content: [{ type: 'text', text: USER_QUIT_MESSAGE }],
    });
    expect(call).toHaveBeenCalledOnce();
  });

  it('keeps the ambiguous-write warning when a user quit is detected on the retry refresh', async () => {
    const resolveDaemonUrl = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce('http://127.0.0.1:62001')
      .mockRejectedValueOnce(new McpUserQuitError());
    const call = vi.fn(async (url: string) => unreachable(url));
    const target = createMcpDaemonTarget({
      daemonUrl: 'http://127.0.0.1:62001',
      resolveDaemonUrl,
    });

    const result = await target.call('create_project', { name: 'must-not-be-replayed' }, call);

    expect(result.isError).toBe(true);
    expect(call).toHaveBeenCalledOnce();
    const text = result.content.map((item) => item.text).join('\n');
    expect(text).toContain('may or may not have been applied');
    expect(text).toContain(USER_QUIT_MESSAGE);
  });

  it('reports the user-quit state for tools and recovers on the next call after the marker clears', async () => {
    let userQuit = true;
    const resolveDaemonUrl = vi.fn(async () => {
      if (userQuit) throw new McpUserQuitError();
      return 'http://127.0.0.1:62002';
    });
    const call = vi.fn(async (url: string) => ({
      content: [{ type: 'text' as const, text: url }],
      isError: false,
    }));
    const target = createMcpDaemonTarget({
      daemonUrl: 'http://127.0.0.1:62001',
      resolveDaemonUrl,
    });

    await expect(target.call('list_projects', {}, call)).resolves.toMatchObject({
      isError: true,
      content: [{ type: 'text', text: USER_QUIT_MESSAGE }],
    });
    expect(call).not.toHaveBeenCalled();

    userQuit = false;
    await expect(target.call('list_projects', {}, call)).resolves.toMatchObject({
      isError: false,
      content: [{ text: 'http://127.0.0.1:62002' }],
    });
    expect(call).toHaveBeenCalledOnce();
  });

  it('returns the user-quit message from resource listing and reads', async () => {
    const target = createMcpDaemonTarget({
      daemonUrl: 'http://127.0.0.1:1',
      resolveDaemonUrl: async () => { throw new McpUserQuitError(); },
    });

    await expect(_listMcpResources(target)).rejects.toThrow(USER_QUIT_MESSAGE);
    await expect(_readMcpResource(target, 'od://focus/active')).rejects.toThrow(USER_QUIT_MESSAGE);
  });

  it('keeps the current URL when a refresh fails for another reason', async () => {
    const target = createMcpDaemonTarget({
      daemonUrl: 'http://127.0.0.1:62001',
      resolveDaemonUrl: async () => { throw new Error('ordinary refresh failure'); },
    });
    const call = vi.fn(async (url: string) => ({
      content: [{ type: 'text' as const, text: url }],
      isError: false,
    }));

    await expect(target.call('list_projects', {}, call)).resolves.toMatchObject({
      content: [{ text: 'http://127.0.0.1:62001' }],
      isError: false,
    });
  });
});
