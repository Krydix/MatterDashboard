import { ipcMain } from "electron";
import { getDaemonState, getMatterStatus, reconcileDaemon, resetMatter } from "./daemon-manager";
import { getConfig, saveConfig } from "./store";
import { openKioskWindow, showSettingsWindow } from "./windows";
import { AppConfig, MatterStatus } from "../shared/types";

const STOPPED_STATUS: MatterStatus = {
  started: false,
  paired: false,
  qrCode: "",
  manualPairingCode: "",
};

export function registerIpcHandlers(): void {
  ipcMain.handle("get-config", () => {
    return getConfig();
  });

  ipcMain.handle("save-config", async (_event, config: AppConfig) => {
    saveConfig(config);
    await reconcileDaemon(config);
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
      await openKioskWindow(target.url, target.durationSeconds * 1000).closed;
    }
  });

  // Show settings window from renderer request
  ipcMain.on("show-settings", () => {
    showSettingsWindow();
  });
}
