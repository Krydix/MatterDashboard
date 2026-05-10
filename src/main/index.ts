import { app } from "electron";
import { reconcileDaemon } from "./daemon-manager";
import { getDashboardTargetId } from "./execution-mode";
import { getConfig } from "./store";
import { createSettingsWindow, destroySettingsWindow, openKioskWindow, showSettingsWindow } from "./windows";
import { registerIpcHandlers } from "./ipc";

const dashboardTargetId = getDashboardTargetId(process.argv);
const isDashboardMode = dashboardTargetId !== null;

if (!isDashboardMode && !app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

async function bootstrap(): Promise<void> {
  const config = getConfig();

  if (isDashboardMode) {
    const target = config.targets.find((entry) => entry.id === dashboardTargetId && entry.enabled);
    if (!target) {
      app.quit();
      return;
    }

    const kioskWindow = openKioskWindow(target.url, target.durationSeconds * 1000);
    await kioskWindow.closed;
    app.quit();
    return;
  }

  registerIpcHandlers();
  await reconcileDaemon(config);
  createSettingsWindow();
}

app.on("ready", bootstrap);

if (!isDashboardMode) {
  app.on("second-instance", () => {
    showSettingsWindow();
  });

  app.on("window-all-closed", () => {
    app.quit();
  });

  app.on("before-quit", () => {
    destroySettingsWindow();
  });

  app.on("activate", () => {
    showSettingsWindow();
  });
}
