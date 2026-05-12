import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BrowserWindow, screen } from "electron";
import path from "path";
import { readDisplayBrightness, setDisplayBrightness } from "./brightness-control";
import { acquireKioskPowerAssertion } from "./power-management";
import { PresentationDisplay } from "../shared/types";

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
  targetDisplayId?: number | null;
  brightnessBridgeEnabled?: boolean;
  brightnessOverridePercent?: number;
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

export function getPresentationDisplays(): PresentationDisplay[] {
  const allDisplays = screen.getAllDisplays();
  const primaryDisplayId = screen.getPrimaryDisplay().id;

  return allDisplays
    .slice()
    .sort((left, right) => {
      if (left.id === primaryDisplayId) {
        return -1;
      }
      if (right.id === primaryDisplayId) {
        return 1;
      }
      if (left.bounds.x !== right.bounds.x) {
        return left.bounds.x - right.bounds.x;
      }
      return left.bounds.y - right.bounds.y;
    })
    .map((display, index) => ({
      id: display.id,
      name: buildPresentationDisplayName(display, index + 1),
      isPrimary: display.id === primaryDisplayId,
      bounds: {
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.bounds.width,
        height: display.bounds.height,
      },
    }));
}

function buildPresentationDisplayName(display: Electron.Display, displayNumber: number): string {
  const detail = `${display.bounds.width}x${display.bounds.height}`;
  const label = typeof display.label === "string" ? display.label.trim() : "";
  const prefix = label.length > 0 ? label : `Display ${displayNumber}`;
  return display.internal ? `${prefix} (${detail}, built-in)` : `${prefix} (${detail})`;
}

function resolvePresentationDisplay(targetDisplayId: number | null | undefined): Electron.Display {
  const allDisplays = screen.getAllDisplays();
  if (typeof targetDisplayId === "number") {
    const selectedDisplay = allDisplays.find((display) => display.id === targetDisplayId);
    if (selectedDisplay) {
      return selectedDisplay;
    }
  }

  return screen.getPrimaryDisplay();
}

async function moveFrontmostMacWindowToDisplay(targetDisplayId: number | null | undefined): Promise<void> {
  if (process.platform !== "darwin") {
    return;
  }

  if (typeof targetDisplayId !== "number") {
    return;
  }

  const targetDisplay = resolvePresentationDisplay(targetDisplayId);
  const { x, y, width, height } = targetDisplay.bounds;
  const positionScript = [
    'tell application "System Events"',
    'set frontProcess to first application process whose frontmost is true',
    'if (count of windows of frontProcess) is 0 then error "No windows available"',
    'tell front window of frontProcess',
    `set position to {${x}, ${y}}`,
    `set size to {${width}, ${height}}`,
    'end tell',
    'end tell',
  ];

  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await execFileAsync("osascript", positionScript.flatMap((line) => ["-e", line]), { timeout: 1500 });
      return;
    } catch {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 250);
      });
    }
  }
}

async function beginBrightnessOverride(options: KioskWindowOptions): Promise<(() => Promise<void>) | null> {
  if (!options.brightnessBridgeEnabled || typeof options.brightnessOverridePercent !== "number") {
    return null;
  }

  const targetDisplay = resolvePresentationDisplay(options.targetDisplayId);

  try {
    const previousBrightness = await readDisplayBrightness(targetDisplay.id);
    await setDisplayBrightness(targetDisplay.id, options.brightnessOverridePercent);
    if (previousBrightness <= 0) {
      return null;
    }
    return async () => {
      try {
        await setDisplayBrightness(targetDisplay.id, previousBrightness);
      } catch {
        // Best-effort restore only.
      }
    };
  } catch {
    return null;
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
  const targetDisplay = resolvePresentationDisplay(options.targetDisplayId);
  const { width, height } = targetDisplay.bounds;
  const restoreTargetPromise = options.restorePreviousApp
    ? getMacApplicationRestoreTarget(options.useStartupRestoreTargetFallback ?? false)
    : Promise.resolve(null);
  const powerAssertion = acquireKioskPowerAssertion();

  const useFullScreen = options.fullScreen ?? true;

  const kiosk = new BrowserWindow({
    x: targetDisplay.bounds.x,
    y: targetDisplay.bounds.y,
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
    let restoreBrightness: (() => Promise<void>) | null = null;

    void (async () => {
      restoreBrightness = await beginBrightnessOverride(options);
      await kiosk.loadURL(url).catch(() => {
        close();
      });
    })();

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
      void Promise.resolve(restoreBrightness?.())
        .then(() => restoreTargetPromise)
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
  const restoreBrightness = await beginBrightnessOverride(options);

  try {
    await launch();
    await moveFrontmostMacWindowToDisplay(options.targetDisplayId);
  } catch (error) {
    await restoreBrightness?.();
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

    void Promise.resolve(restoreBrightness?.())
      .then(() => restoreTargetPromise)
      .then((target) => restoreMacApplication(target))
      .finally(() => {
        options.onClosed?.();
        resolveClosed?.();
      });
  };

  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
    // When durationMs is not finite (e.g. Infinity for no-timeout app targets),
    // skip the auto-close timer — the session runs until explicitly closed.
    if (Number.isFinite(durationMs)) {
      timer = setTimeout(finish, durationMs);
    }
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
