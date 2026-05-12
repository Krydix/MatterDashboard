import { app } from "electron";
import { activateKioskTarget } from "./dashboard-runtime";
import { reconcileDaemon } from "./daemon-manager";
import { getDashboardTargetId } from "./execution-mode";
import { getConfig } from "./store";
import {
  createSettingsWindow,
  destroySettingsWindow,
  openExternalAppSession,
  openKioskWindow,
  showSettingsWindow,
} from "./windows";
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

    try {
      const activeTarget = await activateKioskTarget(target);
      if (activeTarget.presentation === "external-app") {
        const session = await openExternalAppSession(activeTarget.launch, target.durationSeconds * 1000, {
          restorePreviousApp: true,
          useStartupRestoreTargetFallback: true,
          onClosed: () => {
            void activeTarget.deactivate();
          },
        });
        await session.closed;
      } else {
        const kioskWindow = openKioskWindow(activeTarget.url, target.durationSeconds * 1000, {
          restorePreviousApp: true,
          useStartupRestoreTargetFallback: true,
          fullScreen: target.fullScreen ?? true,
          onClosed: () => {
            void activeTarget.deactivate();
          },
        });
        await kioskWindow.closed;
      }
    } catch (error) {
      console.error("[Dashboard] Failed to present target:", error);
    }

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
