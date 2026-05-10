import { app, ipcMain } from "electron";
import { getConfig, saveConfig } from "./store";
import { getMatterBridge } from "./matter";
import { openKioskWindow, showSettingsWindow } from "./windows";
import { AppConfig } from "../shared/types";

export function registerIpcHandlers(): void {
  ipcMain.handle("get-config", () => {
    return getConfig();
  });

  ipcMain.handle("save-config", async (_event, config: AppConfig) => {
    saveConfig(config);
    // Sync Matter bridge to the new config
    const bridge = getMatterBridge();
    if (bridge) {
      await bridge.syncTargets(config.targets);
    }
    // Sync launch-at-login
    app.setLoginItemSettings({ openAtLogin: config.launchAtLogin });
  });

  ipcMain.handle("get-matter-status", async () => {
    const bridge = getMatterBridge();
    if (!bridge) {
      return { started: false, paired: false, qrCode: "", manualPairingCode: "" };
    }
    return await bridge.getStatus();
  });

  ipcMain.handle("reset-matter", async () => {
    const bridge = getMatterBridge();
    if (bridge) {
      await bridge.reset();
    }
  });

  ipcMain.handle("set-launch-at-login", (_event, enabled: boolean) => {
    app.setLoginItemSettings({ openAtLogin: enabled });
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
