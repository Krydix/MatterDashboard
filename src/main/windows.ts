import { BrowserWindow, screen } from "electron";
import path from "path";

let settingsWindow: BrowserWindow | null = null;

export interface KioskWindowHandle {
  close: () => void;
  closed: Promise<void>;
}

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
 * Returns a handle that can also close the window early.
 */
export function openKioskWindow(
  url: string,
  durationMs: number,
  options: { onClosed?: () => void } = {},
): KioskWindowHandle {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.bounds;

  const kiosk = new BrowserWindow({
    x: primaryDisplay.bounds.x,
    y: primaryDisplay.bounds.y,
    width,
    height,
    frame: false,
    fullscreen: true,
    alwaysOnTop: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true, // fully sandboxed — loads external URLs
    },
  });

  const close = () => {
    if (!kiosk.isDestroyed()) {
      kiosk.destroy();
    }
  };

  const closed = new Promise<void>((resolve) => {
    kiosk.loadURL(url).catch(() => {
      close();
    });

    kiosk.webContents.on("before-input-event", (_event, input) => {
      if (input.type === "keyDown" && input.key === "Escape") {
        close();
      }
    });

    const timer = setTimeout(() => {
      close();
    }, durationMs);

    kiosk.on("closed", () => {
      clearTimeout(timer);
      options.onClosed?.();
      resolve();
    });
  });

  return { close, closed };
}

export function destroySettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.removeAllListeners("close");
    settingsWindow.destroy();
    settingsWindow = null;
  }
}
