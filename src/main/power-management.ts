import { spawn } from "node:child_process";
import { powerSaveBlocker } from "electron";

export interface PowerAssertionHandle {
  release: () => void;
}

const DISPLAY_WAKE_TIMEOUT_SECONDS = "2";

export function acquireKioskPowerAssertion(): PowerAssertionHandle {
  const blockerId = powerSaveBlocker.start("prevent-display-sleep");
  pulseDisplayWake();

  let released = false;

  return {
    release: () => {
      if (released) {
        return;
      }

      released = true;
      if (powerSaveBlocker.isStarted(blockerId)) {
        powerSaveBlocker.stop(blockerId);
      }
    },
  };
}

function pulseDisplayWake(): void {
  if (process.platform !== "darwin") {
    return;
  }

  try {
    const child = spawn(
      "/usr/bin/caffeinate",
      ["-u", "-d", "-t", DISPLAY_WAKE_TIMEOUT_SECONDS],
      {
        detached: true,
        stdio: "ignore",
      },
    );
    child.unref();
  } catch {
    // Best effort only.
  }
}