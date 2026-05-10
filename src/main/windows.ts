import { BrowserWindow, app, screen } from "electron";
import path from "path";

let settingsWindow: BrowserWindow | null = null;

const RENDERER_URL =
  process.env["VITE_DEV_SERVER_URL"] ?? `file://${path.join(__dirname, "../renderer/index.html")}`;

export function createSettingsWindow(): BrowserWindow {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return settingsWindow;
  }

  settingsWindow = new BrowserWindow({
    width: 900,
    height: 640,
    minWidth: 700,
    minHeight: 500,
    title: "MatterKiosk",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false, // preload needs Node.js access, renderer is isolated via contextBridge
    },
    show: false,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
  });

  settingsWindow.loadURL(RENDERER_URL);

  settingsWindow.once("ready-to-show", () => {
    settingsWindow!.show();
  });

  // Hide instead of close — keep running in tray
  settingsWindow.on("close", (event) => {
    event.preventDefault();
    settingsWindow!.hide();
  });

  return settingsWindow;
}

export function showSettingsWindow(): void {
  if (!settingsWindow || settingsWindow.isDestroyed()) {
    createSettingsWindow();
  } else {
    settingsWindow.show();
    settingsWindow.focus();
  }
}

/**
 * Open a fullscreen kiosk window for the given URL, then auto-close after durationMs.
 * Returns a promise that resolves when the window closes.
 */
export function openKioskWindow(url: string, durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.bounds;

    const kiosk = new BrowserWindow({
      x: primaryDisplay.bounds.x,
      y: primaryDisplay.bounds.y,
      width,
      height,
      frame: false,
      kiosk: true,
      alwaysOnTop: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true, // fully sandboxed — loads external URLs
      },
    });

    kiosk.loadURL(url).catch(() => {
      kiosk.destroy();
      resolve();
    });

    const timer = setTimeout(() => {
      if (!kiosk.isDestroyed()) {
        kiosk.destroy();
      }
    }, durationMs);

    kiosk.on("closed", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export function destroySettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.removeAllListeners("close");
    settingsWindow.destroy();
    settingsWindow = null;
  }
}
