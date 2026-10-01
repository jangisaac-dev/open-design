import { join } from "node:path";

import { Menu, Tray, nativeImage } from "electron";

/**
 * macOS menu bar icon for the packaged app. Left click opens the window and
 * right click offers Open / Quit. The bundled 18x18 icon thumbnail loads
 * asynchronously, and this function returns a Promise<Tray>. `setContextMenu`
 * is deliberately unused: it would pop the menu on left click too. Callers
 * must keep the returned Tray referenced; a collected Tray removes the icon.
 */
export async function createMenubarTray(options: { onOpen: () => void; onQuit: () => void }): Promise<Tray> {
  let icon: ReturnType<typeof nativeImage.createEmpty> | undefined;
  let loadError: unknown;
  let hasLoadError = false;
  try {
    const thumbnail = await nativeImage.createThumbnailFromPath(join(process.resourcesPath, "icon.icns"), {
      width: 18,
      height: 18,
    });
    if (!thumbnail.isEmpty()) icon = thumbnail;
  } catch (error) {
    loadError = error;
    hasLoadError = true;
  }

  const tray = new Tray(icon ?? nativeImage.createEmpty());
  if (icon == null) {
    // An empty image alone is a zero-width, invisible menu bar item.
    console.warn("[open-design desktop] menu bar icon unavailable; using a text label", {
      resourcesPath: process.resourcesPath,
      ...(hasLoadError ? { error: loadError } : {}),
    });
    tray.setTitle("OD");
  }
  const menu = Menu.buildFromTemplate([
    { label: "Open", click: options.onOpen },
    { label: "Quit", click: options.onQuit },
  ]);
  tray.on("click", options.onOpen);
  tray.on("right-click", () => tray.popUpContextMenu(menu));
  return tray;
}
