import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BrowserWindow, screen } from "electron";
import path from "path";
import { acquireKioskPowerAssertion } from "./power-management";

let settingsWindow: BrowserWindow | null = null;
const execFileAsync = promisify(execFile);

interface MacApplicationTarget {
  processIdentifier: number;
  bundleId: string | null;
  name: string | null;
}

const FRONTMOST_MAC_APPLICATION_SCRIPT = `
ObjC.import("AppKit");
const app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
const bundleId = app.bundleIdentifier ? ObjC.unwrap(app.bundleIdentifier) : null;
const name = app.localizedName ? ObjC.unwrap(app.localizedName) : null;
JSON.stringify({
  processIdentifier: Number(app.processIdentifier),
  bundleId,
  name,
});
`;

const startupFrontmostMacApplicationPromise =
  process.platform === "darwin" ? getFrontmostMacApplication() : Promise.resolve(null);

function parseMacApplicationTarget(stdout: string): MacApplicationTarget | null {
  const output = stdout.trim();
  if (!output) {
    return null;
  }

  const parsed = JSON.parse(output) as Record<string, unknown>;
  const processIdentifier = parsed["processIdentifier"];
  const bundleId = parsed["bundleId"];
  const name = parsed["name"];

  if (typeof processIdentifier !== "number") {
    return null;
  }

  return {
    processIdentifier,
    bundleId: typeof bundleId === "string" && bundleId.length > 0 ? bundleId : null,
    name: typeof name === "string" && name.length > 0 ? name : null,
  };
}

async function getFrontmostMacApplication(): Promise<MacApplicationTarget | null> {
  if (process.platform !== "darwin") {
    return null;
  }

  try {
    const { stdout } = await execFileAsync(
      "osascript",
      ["-l", "JavaScript", "-e", FRONTMOST_MAC_APPLICATION_SCRIPT],
      { timeout: 1500 },
    );
    return parseMacApplicationTarget(stdout);
  } catch {
    return null;
  }
}

async function getMacApplicationRestoreTarget(useStartupFallback: boolean): Promise<MacApplicationTarget | null> {
  const currentTarget = await getFrontmostMacApplication();
  if (currentTarget && currentTarget.processIdentifier !== process.pid) {
    return currentTarget;
  }

  if (!useStartupFallback) {
    return null;
  }

  const startupTarget = await startupFrontmostMacApplicationPromise;
  if (startupTarget && startupTarget.processIdentifier !== process.pid) {
    return startupTarget;
  }

  return null;
}

async function restoreMacApplication(target: MacApplicationTarget | null): Promise<void> {
  if (process.platform !== "darwin" || !target) {
    return;
  }

  try {
    if (target.bundleId) {
      await execFileAsync("open", ["-b", target.bundleId], { timeout: 1500 });
      return;
    }

    if (target.name) {
      await execFileAsync("open", ["-a", target.name], { timeout: 1500 });
    }
  } catch {
    // Best-effort restore only.
  }
}

async function applyLiquidGlass(win: BrowserWindow): Promise<void> {
  if (process.platform !== "darwin") return;
  try {
    // Dynamic import so non-macOS builds don't fail at load time.
    // addView() handles its own fallback: native NSGlassEffectView on macOS 26+,
    // NSVisualEffectView blur on older macOS — no guard needed here.
    const { default: liquidGlass } = await import("electron-liquid-glass");
    liquidGlass.addView(win.getNativeWindowHandle(), {
      cornerRadius: 12,
    });
  } catch {
    // Not on macOS or native module unavailable — degrade gracefully
  }
}

export interface KioskWindowHandle {
  close: () => void;
  closed: Promise<void>;
}

export interface KioskWindowOptions {
  onClosed?: () => void;
  restorePreviousApp?: boolean;
  useStartupRestoreTargetFallback?: boolean;
  fullScreen?: boolean;
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
    // Transparent so liquid glass (macOS) or CSS glassmorphism shows through the sidebar
    transparent: process.platform === "darwin",
    backgroundColor: process.platform === "darwin" ? "#00000000" : "#1a1a2e",
  });

  settingsWindow.loadURL(RENDERER_URL);

  settingsWindow.once("ready-to-show", () => {
    settingsWindow!.show();
  });

  // Apply native liquid glass after content is ready (macOS only, graceful fallback)
  settingsWindow.webContents.once("did-finish-load", () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      void applyLiquidGlass(settingsWindow);
    }
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
  options: KioskWindowOptions = {},
): KioskWindowHandle {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.bounds;
  const restoreTargetPromise = options.restorePreviousApp
    ? getMacApplicationRestoreTarget(options.useStartupRestoreTargetFallback ?? false)
    : Promise.resolve(null);
  const powerAssertion = acquireKioskPowerAssertion();

  const useFullScreen = options.fullScreen ?? true;

  const kiosk = new BrowserWindow({
    x: primaryDisplay.bounds.x,
    y: primaryDisplay.bounds.y,
    width,
    height,
    frame: false,
    fullscreen: useFullScreen,
    alwaysOnTop: useFullScreen,
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
      powerAssertion.release();
      void restoreTargetPromise
        .then((target) => restoreMacApplication(target))
        .finally(() => {
          options.onClosed?.();
          resolve();
        });
    });
  });

  return { close, closed };
}

export async function openExternalAppSession(
  launch: () => Promise<void>,
  durationMs: number,
  options: KioskWindowOptions = {},
): Promise<KioskWindowHandle> {
  const restoreTargetPromise = options.restorePreviousApp
    ? getMacApplicationRestoreTarget(options.useStartupRestoreTargetFallback ?? false)
    : Promise.resolve(null);
  const powerAssertion = acquireKioskPowerAssertion();

  try {
    await launch();
  } catch (error) {
    powerAssertion.release();
    throw error;
  }

  let timer: NodeJS.Timeout | undefined;
  let settled = false;
  let resolveClosed: (() => void) | undefined;

  const finish = () => {
    if (settled) {
      return;
    }

    settled = true;
    if (timer) {
      clearTimeout(timer);
    }
    powerAssertion.release();

    void restoreTargetPromise
      .then((target) => restoreMacApplication(target))
      .finally(() => {
        options.onClosed?.();
        resolveClosed?.();
      });
  };

  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
    timer = setTimeout(finish, durationMs);
  });

  return {
    close: finish,
    closed,
  };
}

export function destroySettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.removeAllListeners("close");
    settingsWindow.destroy();
    settingsWindow = null;
  }
}
