import net from "node:net";
import { AppConfig, MatterStatus } from "../shared/types";
import { DaemonRequest, DaemonResponse } from "../shared/daemon-contract";
import { getDaemonSocketPath } from "./app-paths";

export async function pingDaemon(): Promise<boolean> {
  try {
    await callDaemon<void>({ type: "ping" }, 1000);
    return true;
  } catch {
    return false;
  }
}

export function getMatterStatusFromDaemon(): Promise<MatterStatus> {
  return callDaemon<MatterStatus>({ type: "get-status" });
}

export function syncDaemonConfig(config: AppConfig): Promise<void> {
  return callDaemon<void>({ type: "sync-config", config });
}

export function resetMatterFromDaemon(): Promise<void> {
  return callDaemon<void>({ type: "reset" });
}

export function triggerTargetFromDaemon(targetId: string): Promise<boolean> {
  return callDaemon<boolean>({ type: "trigger-target", targetId });
}

export function stopTargetFromDaemon(targetId: string): Promise<boolean> {
  return callDaemon<boolean>({ type: "stop-target", targetId });
}

export function shutdownDaemon(): Promise<void> {
  return callDaemon<void>({ type: "shutdown" });
}

function callDaemon<T>(request: DaemonRequest, timeoutMs = 5000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const socket = net.createConnection(getDaemonSocketPath());
    let settled = false;
    let buffer = "";

    const timeout = setTimeout(() => {
      finish(new Error("Timed out waiting for Matter daemon response."));
    }, timeoutMs);

    const finish = (error?: Error, response?: T) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      socket.destroy();

      if (error) {
        reject(error);
        return;
      }

      resolve(response as T);
    };

    socket.once("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }

      const line = buffer.slice(0, newlineIndex);
      try {
        const response = JSON.parse(line) as DaemonResponse<T>;
        if (!response.ok) {
          finish(new Error(response.error ?? "Matter daemon request failed."));
          return;
        }

        finish(undefined, response.result);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });

    socket.once("error", (error) => {
      finish(error instanceof Error ? error : new Error(String(error)));
    });
  });
}