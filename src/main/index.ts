import { app } from "electron";

// Enable native macOS rubber-band (elastic) overscroll for overflow scroll containers.
// Must be called before app.ready.
app.commandLine.appendSwitch("enable-features", "ElasticOverscroll");

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
      let activeSession: ReturnType<typeof openKioskWindow> | Awaited<ReturnType<typeof openExternalAppSession>> | null =
        null;
      let shutdownPromise: Promise<void> | null = null;

      const shutdownDashboardTarget = (reason: string): Promise<void> => {
        if (shutdownPromise) {
          return shutdownPromise;
        }

        shutdownPromise = (async () => {
          if (activeSession) {
            activeSession.close();
            await activeSession.closed;
          }

          try {
            await activeTarget.deactivate();
          } catch (error) {
            console.error(`[Dashboard] Failed to deactivate target during ${reason}:`, error);
          }
        })();

        return shutdownPromise;
      };

      const handleTerminationSignal = (signal: string) => {
        void shutdownDashboardTarget(signal).finally(() => {
          app.quit();
        });
      };

      const onSigterm = () => {
        handleTerminationSignal("SIGTERM");
      };
      const onSigint = () => {
        handleTerminationSignal("SIGINT");
      };

      process.once("SIGTERM", onSigterm);
      process.once("SIGINT", onSigint);

      if (activeTarget.presentation === "external-app") {
        const appDurationMs =
          target.provider === "app" && (target.app?.noTimeout ?? false)
            ? Infinity
            : target.durationSeconds * 1000;
        activeSession = await openExternalAppSession(activeTarget.launch, appDurationMs, {
          restorePreviousApp: true,
          useStartupRestoreTargetFallback: true,
          targetDisplayId: config.presentationDisplayId,
          brightnessBridgeEnabled: config.brightnessControl.enabled,
          brightnessOverridePercent: target.brightnessPercent,
        });
        await activeSession.closed;
      } else {
        activeSession = openKioskWindow(activeTarget.url, target.durationSeconds * 1000, {
          restorePreviousApp: true,
          useStartupRestoreTargetFallback: true,
          targetDisplayId: config.presentationDisplayId,
          brightnessBridgeEnabled: config.brightnessControl.enabled,
          brightnessOverridePercent: target.brightnessPercent,
          fullScreen: target.fullScreen ?? true,
        });
        await activeSession.closed;
      }

      await shutdownDashboardTarget("session-end");

      process.removeListener("SIGTERM", onSigterm);
      process.removeListener("SIGINT", onSigint);
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
