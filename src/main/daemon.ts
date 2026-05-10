import "./electron-crypto-compat";
import { ChildProcess, spawn } from "node:child_process";
import crypto from "node:crypto";
import { createServer } from "node:net";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AppConfig, MatterStatus } from "../shared/types";
import { getDaemonPidPath, getDaemonSocketPath, getMatterStoragePath, getRuntimeDir } from "./app-paths";
import { getConfig } from "./store";

type DaemonRequest =
  | { type: "ping" }
  | { type: "get-status" }
  | { type: "sync-config"; config: AppConfig }
  | { type: "reset" }
  | { type: "shutdown" };

type DaemonResponse = {
  ok: boolean;
  result?: unknown;
  error?: string;
};

const activeDashboards = new Map<string, ChildProcess>();

let shuttingDown = false;

async function main(): Promise<void> {
  if (!supportsMatterNativeCrypto()) {
    process.env["MATTER_NODEJS_CRYPTO"] = "false";
  }

  const { MatterController } = await import("./matter-controller.js");

  const initialConfig = getConfig();
  if (!initialConfig.backgroundDaemonEnabled) {
    return;
  }

  mkdirSync(getRuntimeDir(), { recursive: true });
  if (process.platform !== "win32") {
    rmSync(getDaemonSocketPath(), { force: true });
  }

  writeFileSync(getDaemonPidPath(), `${process.pid}\n`, "utf8");

  const controller = new MatterController({
    onTargetTriggered: (targetId: string) => {
      void launchDashboard(currentConfig, targetId, controller);
    },
    onTargetTurnedOff: (targetId: string) => {
      activeDashboards.get(targetId)?.kill();
    },
  });

  let currentConfig = initialConfig;
  await controller.start(getMatterStoragePath(), currentConfig.targets);

  const server = createServer((socket) => {
    let buffer = "";

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }

      const line = buffer.slice(0, newlineIndex);
      void handleRequest(line).then((response) => {
        socket.end(`${JSON.stringify(response)}\n`);
      });
    });
  });

  const closeAll = async () => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;

    server.close();

    for (const dashboard of activeDashboards.values()) {
      dashboard.kill();
    }
    activeDashboards.clear();

    await controller.stop();
    if (process.platform !== "win32") {
      rmSync(getDaemonSocketPath(), { force: true });
    }
    rmSync(getDaemonPidPath(), { force: true });
  };

  const handleRequest = async (line: string): Promise<DaemonResponse> => {
    try {
      const request = JSON.parse(line) as DaemonRequest;

      switch (request.type) {
        case "ping":
          return { ok: true };
        case "get-status":
          return { ok: true, result: controller.getStatus() };
        case "sync-config":
          currentConfig = request.config;
          await controller.syncTargets(currentConfig.targets);
          return { ok: true };
        case "reset": {
          const result = await controller.reset();
          return { ok: true, result };
        }
        case "shutdown":
          await closeAll();
          setImmediate(() => process.exit(0));
          return { ok: true };
        default:
          return { ok: false, error: "Unknown daemon request." };
      }
    } catch (error) {
      return { ok: false, error: asErrorMessage(error) };
    }
  };

  process.on("SIGINT", () => {
    void closeAll().finally(() => process.exit(0));
  });

  process.on("SIGTERM", () => {
    void closeAll().finally(() => process.exit(0));
  });

  server.listen(getDaemonSocketPath());

  async function launchDashboard(
    config: AppConfig,
    targetId: string,
    matterController: { setTargetOff(targetId: string): Promise<void> },
  ): Promise<void> {
    if (activeDashboards.has(targetId)) {
      return;
    }

    const target = config.targets.find((entry) => entry.id === targetId && entry.enabled);
    if (!target) {
      return;
    }

    const launch = getDashboardLaunchConfig(targetId);
    const child = spawn(launch.executable, launch.args, {
      env: launch.env,
      stdio: "ignore",
    });

    activeDashboards.set(targetId, child);

    child.once("exit", () => {
      activeDashboards.delete(targetId);
      void matterController.setTargetOff(targetId).catch((error) => {
        console.error(`[Matter] Failed to clear target "${targetId}" after dashboard exit:`, error);
      });
    });
  }
}

function getDashboardLaunchConfig(targetId: string): {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
} {
  const appPath = process.env["MATTERKIOSK_UI_APP_PATH"];
  const modeArgs = [`--dashboard-target-id=${targetId}`];

  return {
    executable: process.execPath,
    args: appPath ? [appPath, ...modeArgs] : modeArgs,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
    },
  };
}

function supportsMatterNativeCrypto(): boolean {
  return crypto.getCiphers().includes("aes-128-ccm");
}

function asErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  return String(error);
}

void main().catch((error) => {
  console.error("[Daemon] Fatal error:", error);
  process.exit(1);
});