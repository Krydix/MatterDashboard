import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BrowserWindow, ipcMain, session } from "electron";
import { getDaemonState, getMatterStatus, reconcileDaemon, resetMatter } from "./daemon-manager";
import { activateKioskTarget } from "./dashboard-runtime";
import { importTrmnlRecipe } from "./trmnl-import";
import { getConfig, saveConfig } from "./store";
import { openKioskWindow, showSettingsWindow } from "./windows";
import { AppConfig, MatterStatus, VolumeControlAvailability } from "../shared/types";

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
  ipcMain.handle("get-config", () => {
    return getConfig();
  });

  ipcMain.handle("save-config", async (_event, config: AppConfig) => {
    saveConfig(config);
    await reconcileDaemon(config);
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
      await openKioskWindow(activeTarget.url, target.durationSeconds * 1000, {
        restorePreviousApp: true,
        fullScreen: target.fullScreen ?? true,
        onClosed: () => {
          void activeTarget.deactivate();
        },
      }).closed;
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
}
