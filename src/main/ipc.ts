import { execFile } from "node:child_process";
import { promises as fsPromises, constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { app, BrowserWindow, dialog, ipcMain, session } from "electron";
import { getBrightnessControlAvailability } from "./brightness-control";
import { getDaemonState, getMatterStatus, reconcileDaemon, resetMatter } from "./daemon-manager";
import { activateKioskTarget } from "./dashboard-runtime";
import { importTrmnlRecipe } from "./trmnl-import";
import { getConfig, saveConfig } from "./store";
import { getPresentationDisplays, openExternalAppSession, openKioskWindow, showSettingsWindow } from "./windows";
import { AppConfig, CliInstallStatus, MatterStatus, VolumeControlAvailability } from "../shared/types";

const execFileAsync = promisify(execFile);

const STOPPED_STATUS: MatterStatus = {
  started: false,
  paired: false,
  qrCode: "",
  manualPairingCode: "",
};

const VOLUME_UNAVAILABLE_REASON = "The current audio output does not expose adjustable system volume.";

async function getVolumeControlAvailability(): Promise<VolumeControlAvailability> {
  if (process.platform !== "darwin") {
    return {
      available: false,
      reason: "This build only enables host volume bridging on macOS.",
    };
  }

  try {
    const { stdout } = await execFileAsync("/usr/bin/osascript", [
      "-e",
      "set v to output volume of (get volume settings)",
      "-e",
      "set m to output muted of (get volume settings)",
      "-e",
      'return (v as string) & "," & (m as string)',
    ]);

    const output = stdout.trim();
    const separator = output.indexOf(",");
    if (separator === -1) {
      return { available: false, reason: VOLUME_UNAVAILABLE_REASON };
    }

    const levelText = output.slice(0, separator).trim();
    const mutedText = output.slice(separator + 1).trim();
    const level = Number(levelText);
    const hasMissingValue = levelText === "missing value" || mutedText === "missing value";
    const validMute = mutedText === "true" || mutedText === "false";
    if (hasMissingValue || !Number.isFinite(level) || !validMute) {
      return { available: false, reason: VOLUME_UNAVAILABLE_REASON };
    }

    return { available: true, reason: "" };
  } catch (error) {
    console.warn("[Volume] Failed to probe host volume availability:", error);
    return { available: false, reason: VOLUME_UNAVAILABLE_REASON };
  }
}

export function registerIpcHandlers(): void {
  // Custom window drag — used by the topbar so -webkit-app-region conflicts are avoided.
  // The renderer sends the initial screen position on mousedown; main tracks delta on each move.
  ipcMain.on("start-window-drag", (event, { startX, startY }: { startX: number; startY: number }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;

    let lastX = startX;
    let lastY = startY;

    const onMove = (_: Electron.IpcMainEvent, { x, y }: { x: number; y: number }) => {
      if (!win || win.isDestroyed()) return;
      const dx = x - lastX;
      const dy = y - lastY;
      lastX = x;
      lastY = y;
      const [wx, wy] = win.getPosition();
      win.setPosition(wx + dx, wy + dy);
    };

    const onStop = () => {
      ipcMain.removeListener("drag-window-move", onMove);
      ipcMain.removeListener("stop-window-drag", onStop);
    };

    ipcMain.on("drag-window-move", onMove);
    ipcMain.once("stop-window-drag", onStop);
  });

  ipcMain.handle("get-config", () => {
    return getConfig();
  });

  ipcMain.handle("save-config", async (_event, config: AppConfig) => {
    saveConfig(config);
    await reconcileDaemon(config);
  });

  ipcMain.handle("get-presentation-displays", () => {
    return getPresentationDisplays();
  });

  ipcMain.handle("get-brightness-control-availability", async () => {
    return await getBrightnessControlAvailability(getConfig());
  });

  ipcMain.handle("import-trmnl-recipe", async (_event, source: string) => {
    return await importTrmnlRecipe(source);
  });

  ipcMain.handle("get-volume-control-availability", async () => {
    return await getVolumeControlAvailability();
  });

  ipcMain.handle("get-matter-status", async () => {
    const config = getConfig();
    return await getMatterStatus(config);
  });

  ipcMain.handle("get-daemon-state", async () => {
    const config = getConfig();
    return await getDaemonState(config);
  });

  ipcMain.handle("reset-matter", async () => {
    const config = getConfig();
    if (!config.backgroundDaemonEnabled) {
      return;
    }
    await resetMatter(config);
  });

  ipcMain.handle("set-launch-at-login", (_event, enabled: boolean) => {
    const config = getConfig();
    const updated = { ...config, launchAtLogin: enabled };
    saveConfig(updated);
    return reconcileDaemon(updated);
  });

  // Renderer can trigger a kiosk window manually (for testing)
  ipcMain.handle("open-kiosk", async (_event, targetId: string) => {
    const config = getConfig();
    const target = config.targets.find((t) => t.id === targetId);
    if (target) {
      const activeTarget = await activateKioskTarget(target);
      if (activeTarget.presentation === "external-app") {
        const appDurationMs =
          target.provider === "app" && (target.app?.noTimeout ?? false)
            ? Infinity
            : target.durationSeconds * 1000;
        const session = await openExternalAppSession(activeTarget.launch, appDurationMs, {
          restorePreviousApp: true,
          targetDisplayId: config.presentationDisplayId,
          brightnessBridgeEnabled: config.brightnessControl.enabled,
          brightnessOverridePercent: target.brightnessPercent,
          onClosed: () => {
            void activeTarget.deactivate();
          },
        });
        await session.closed;
      } else {
        await openKioskWindow(activeTarget.url, target.durationSeconds * 1000, {
          restorePreviousApp: true,
          targetDisplayId: config.presentationDisplayId,
          brightnessBridgeEnabled: config.brightnessControl.enabled,
          brightnessOverridePercent: target.brightnessPercent,
          fullScreen: target.fullScreen ?? true,
          onClosed: () => {
            void activeTarget.deactivate();
          },
        }).closed;
      }
    }
  });

  // Show settings window from renderer request
  ipcMain.on("show-settings", () => {
    showSettingsWindow();
  });

  // Open the TRMNL recipe browser. Resolves with the selected recipe URL,
  // or null if the user closed the window without picking anything.
  ipcMain.handle("browse-trmnl-recipes", (_event) => {
    return new Promise<string | null>((resolve) => {
      const RECIPE_URL_PATTERN = /\/recipes\/(\d+)(?:\/|$|\?|#)/;

      const win = new BrowserWindow({
        width: 1024,
        height: 768,
        title: "Browse TRMNL Recipes",
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          // Use a separate session so TRMNL cookies don't mix with app state
          session: session.fromPartition("persist:trmnl-browser"),
        },
      });

      let resolved = false;

      function tryResolveUrl(url: string) {
        if (resolved) return;
        const match = url.match(RECIPE_URL_PATTERN);
        if (match) {
          resolved = true;
          resolve(url);
          win.close();
        }
      }

      win.webContents.on("will-navigate", (_e, url) => tryResolveUrl(url));
      win.webContents.on("did-navigate", (_e, url) => tryResolveUrl(url));
      win.webContents.on("did-navigate-in-page", (_e, url) => tryResolveUrl(url));

      win.on("closed", () => {
        if (!resolved) {
          resolved = true;
          resolve(null);
        }
      });

      void win.loadURL("https://trmnl.com/recipes");
    });
  });

  // Open a native macOS file picker filtered to .app bundles.
  // Reads the app's Info.plist to resolve name and bundle identifier automatically.
  ipcMain.handle("pick-app", async () => {
    if (process.platform !== "darwin") {
      return null;
    }

    const result = await dialog.showOpenDialog({
      title: "Select Application",
      defaultPath: "/Applications",
      buttonLabel: "Select",
      properties: ["openFile"],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const applicationPath = result.filePaths[0];
    let applicationName: string | null = null;
    let bundleId: string | null = null;

    try {
      const plistPath = `${applicationPath}/Contents/Info.plist`;
      const { stdout } = await execFileAsync("/usr/bin/plutil", ["-convert", "json", "-o", "-", plistPath], {
        timeout: 3000,
      });
      const info = JSON.parse(stdout) as Record<string, unknown>;
      applicationName =
        (info["CFBundleDisplayName"] as string | undefined)?.trim() ||
        (info["CFBundleName"] as string | undefined)?.trim() ||
        null;
      bundleId = (info["CFBundleIdentifier"] as string | undefined)?.trim() || null;
    } catch {
      // Plist read failed — still return the path; the user can fill in fields manually.
    }

    return { applicationPath, applicationName, bundleId };
  });

  ipcMain.handle("check-cli-install", async (): Promise<CliInstallStatus> => {
    return getCliInstallStatus();
  });

  ipcMain.handle("install-cli", async (): Promise<{ ok: boolean; installPath: string; error?: string }> => {
    const status = await getCliInstallStatus();
    try {
      await fsPromises.mkdir(path.dirname(status.installPath), { recursive: true });
      // Remove any pre-existing symlink or file at the target path
      await fsPromises.rm(status.installPath, { force: true });
      await fsPromises.symlink(status.cliSourcePath, status.installPath);
      return { ok: true, installPath: status.installPath };
    } catch (error) {
      return {
        ok: false,
        installPath: status.installPath,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

function getCliBinarySourcePath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "bin", "matterkiosk");
  }
  // In development: __dirname is dist/main/, project root is two levels up
  return path.resolve(__dirname, "../../assets/bin/matterkiosk");
}

async function resolveCliInstallDir(): Promise<string> {
  // Try standard PATH-included directories in priority order.
  // /opt/homebrew/bin is the Homebrew prefix on Apple Silicon;
  // /usr/local/bin is the Homebrew prefix on Intel and is always in PATH.
  const candidates = ["/usr/local/bin", "/opt/homebrew/bin"];
  for (const dir of candidates) {
    try {
      await fsPromises.access(dir, fsConstants.W_OK);
      return dir;
    } catch {
      // not writable or doesn't exist — try next
    }
  }
  return path.join(homedir(), ".local", "bin");
}

// Directories that macOS includes in PATH by default or that package managers
// (Homebrew) guarantee are on PATH. If the CLI lands here, no shell config is needed.
const WELL_KNOWN_PATH_DIRS = new Set([
  "/usr/local/bin",
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/opt/local/bin",   // MacPorts
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
]);

async function getCliInstallStatus(): Promise<CliInstallStatus> {
  const cliSourcePath = getCliBinarySourcePath();
  const installDir = await resolveCliInstallDir();
  const installPath = path.join(installDir, "matterkiosk");

  let installed = false;
  try {
    const stat = await fsPromises.lstat(installPath);
    if (stat.isSymbolicLink()) {
      const linkTarget = await fsPromises.readlink(installPath);
      installed = linkTarget === cliSourcePath;
    } else {
      installed = stat.isFile();
    }
  } catch {
    installed = false;
  }

  const pathDirs = (process.env.PATH ?? "").split(":");
  const inPath = WELL_KNOWN_PATH_DIRS.has(installDir) || pathDirs.includes(installDir);

  return { installed, installPath, cliSourcePath, inPath };
}
