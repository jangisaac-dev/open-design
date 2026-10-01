import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MockTray = {
  handlers: Map<string, () => void>;
  image: unknown;
  popUpContextMenu: ReturnType<typeof vi.fn>;
  setContextMenu: ReturnType<typeof vi.fn>;
  setTitle: ReturnType<typeof vi.fn>;
};

const electron = vi.hoisted(() => ({
  emptyImageCalls: 0,
  thumbnailEmpty: false,
  thumbnailError: null as unknown,
  thumbnailRejects: false,
  thumbnailRequests: [] as Array<{ path: string; options: { width: number; height: number } }>,
  thumbnailImage: null as unknown,
  trays: [] as MockTray[],
}));

vi.mock("electron", () => {
  class Tray {
    handlers = new Map<string, () => void>();
    popUpContextMenu = vi.fn();
    setContextMenu = vi.fn();
    setTitle = vi.fn();
    constructor(public image: unknown) {
      electron.trays.push(this);
    }
    on(event: string, listener: () => void) {
      this.handlers.set(event, listener);
      return this;
    }
  }
  return {
    Menu: { buildFromTemplate: (template: unknown) => ({ template }) },
    Tray,
    nativeImage: {
      createEmpty: () => {
        electron.emptyImageCalls += 1;
        return { kind: "empty" };
      },
      createThumbnailFromPath: vi.fn(async (path: string, options: { width: number; height: number }) => {
        electron.thumbnailRequests.push({ path, options });
        if (electron.thumbnailRejects) throw electron.thumbnailError;
        const thumbnail = { isEmpty: () => electron.thumbnailEmpty };
        electron.thumbnailImage = thumbnail;
        return thumbnail;
      }),
    },
  };
});

import { createMenubarTray } from "../../src/main/menubar.js";

beforeEach(() => {
  electron.emptyImageCalls = 0;
  electron.thumbnailEmpty = false;
  electron.thumbnailError = null;
  electron.thumbnailRejects = false;
  electron.thumbnailImage = null;
  electron.thumbnailRequests.length = 0;
  electron.trays.length = 0;
  Object.defineProperty(process, "resourcesPath", { configurable: true, value: "/App/Contents/Resources" });
});

afterEach(() => vi.restoreAllMocks());

describe("createMenubarTray", () => {
  it("opens the window on left click without popping the menu", async () => {
    const onOpen = vi.fn();
    const onQuit = vi.fn();
    await createMenubarTray({ onOpen, onQuit });
    const tray = electron.trays[0]!;

    tray.handlers.get("click")?.();

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onQuit).not.toHaveBeenCalled();
    expect(tray.popUpContextMenu).not.toHaveBeenCalled();
    expect(tray.setContextMenu).not.toHaveBeenCalled();
  });

  it("offers Open and Quit on right click", async () => {
    await createMenubarTray({ onOpen: vi.fn(), onQuit: vi.fn() });
    const tray = electron.trays[0]!;

    tray.handlers.get("right-click")?.();
    const menu = tray.popUpContextMenu.mock.calls[0]?.[0] as {
      template: Array<{ click: () => void; label: string }>;
    };

    expect(menu.template.map((item) => item.label)).toEqual(["Open", "Quit"]);
    expect(tray.setContextMenu).not.toHaveBeenCalled();
  });

  it("calls only onOpen when the Open menu item is clicked", async () => {
    const onOpen = vi.fn();
    const onQuit = vi.fn();
    await createMenubarTray({ onOpen, onQuit });
    const tray = electron.trays[0]!;

    tray.handlers.get("right-click")?.();
    const menu = tray.popUpContextMenu.mock.calls[0]?.[0] as {
      template: Array<{ click: () => void; label: string }>;
    };
    menu.template[0]!.click();

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onQuit).not.toHaveBeenCalled();
  });

  it("calls only onQuit when the Quit menu item is clicked", async () => {
    const onOpen = vi.fn();
    const onQuit = vi.fn();
    await createMenubarTray({ onOpen, onQuit });
    const tray = electron.trays[0]!;

    tray.handlers.get("right-click")?.();
    const menu = tray.popUpContextMenu.mock.calls[0]?.[0] as {
      template: Array<{ click: () => void; label: string }>;
    };
    menu.template[1]!.click();

    expect(onQuit).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("loads and passes the bundled thumbnail directly to the tray", async () => {
    await createMenubarTray({ onOpen: vi.fn(), onQuit: vi.fn() });
    const tray = electron.trays[0]!;

    expect(electron.thumbnailRequests).toEqual([
      {
        path: "/App/Contents/Resources/icon.icns",
        options: { width: 18, height: 18 },
      },
    ]);
    expect(tray.image).toBe(electron.thumbnailImage);
    expect(tray.setTitle).not.toHaveBeenCalled();
    expect(electron.emptyImageCalls).toBe(0);
  });

  it("uses an empty image and text label for an empty thumbnail", async () => {
    electron.thumbnailEmpty = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await createMenubarTray({ onOpen: vi.fn(), onQuit: vi.fn() });
    const tray = electron.trays[0]!;

    expect(tray.image).toEqual({ kind: "empty" });
    expect(tray.setTitle).toHaveBeenCalledWith("OD");
    expect(electron.emptyImageCalls).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("menu bar icon unavailable"), {
      resourcesPath: "/App/Contents/Resources",
    });
  });

  it("uses an empty image and includes a thumbnail rejection in the warning", async () => {
    const error = new Error("thumbnail failed");
    electron.thumbnailRejects = true;
    electron.thumbnailError = error;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await createMenubarTray({ onOpen: vi.fn(), onQuit: vi.fn() });
    const tray = electron.trays[0]!;

    expect(tray.image).toEqual({ kind: "empty" });
    expect(tray.setTitle).toHaveBeenCalledWith("OD");
    expect(electron.emptyImageCalls).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("menu bar icon unavailable"), {
      resourcesPath: "/App/Contents/Resources",
      error,
    });
  });
});
