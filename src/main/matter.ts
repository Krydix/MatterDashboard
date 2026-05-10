import { app, BrowserWindow } from "electron";
import { ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { KioskTarget, MatterStatus } from "../shared/types";
import { KioskWindowHandle, openKioskWindow } from "./windows";

type MatterWorkerCommand =
  | { type: "start"; requestId: number; storagePath: string; targets: KioskTarget[] }
  | { type: "sync-targets"; requestId: number; targets: KioskTarget[] }
  | { type: "get-status"; requestId: number }
  | { type: "reset"; requestId: number }
  | { type: "set-target-off"; requestId: number; targetId: string }
  | { type: "stop"; requestId: number };

type MatterWorkerResponse = {
  type: "response";
  requestId: number;
  ok: boolean;
  result?: MatterStatus;
  error?: string;
};

type MatterWorkerEvent =
  | {
      type: "target-triggered";
      targetId: string;
    }
  | {
      type: "target-turned-off";
      targetId: string;
    };

const STOPPED_STATUS: MatterStatus = {
  started: false,
  paired: false,
  qrCode: "",
  manualPairingCode: "",
};

export class MatterBridge {
  private child: ChildProcess | null = null;
  private storagePath: string;
  private targets: KioskTarget[] = [];
  private nextRequestId = 1;
  private status: MatterStatus = STOPPED_STATUS;
  private pendingRequests = new Map<
    number,
    {
      resolve: (status: MatterStatus | undefined) => void;
      reject: (error: Error) => void;
    }
  >();
  private stopping = false;
  private activeKioskWindows = new Map<string, KioskWindowHandle>();

  constructor(storagePath: string) {
    this.storagePath = storagePath;
  }

  async start(targets: KioskTarget[]): Promise<void> {
    this.targets = cloneTargets(targets);

    if (!this.child) {
      this.spawnWorker();
    }

    const status = await this.request({
      type: "start",
      requestId: 0,
      storagePath: this.storagePath,
      targets: this.targets,
    });

    this.status = status ?? { ...STOPPED_STATUS, started: true };
  }

  async syncTargets(targets: KioskTarget[]): Promise<void> {
    if (!this.child) {
      return;
    }

    this.targets = cloneTargets(targets);
    const status = await this.request({
      type: "sync-targets",
      requestId: 0,
      targets: this.targets,
    });

    if (status) {
      this.status = status;
    }
  }

  async getStatus(): Promise<MatterStatus> {
    if (!this.child) {
      return this.status;
    }

    const status = await this.request({
      type: "get-status",
      requestId: 0,
    });

    if (status) {
      this.status = status;
    }

    return this.status;
  }

  async reset(): Promise<void> {
    if (!this.child) {
      return;
    }

    const status = await this.request({
      type: "reset",
      requestId: 0,
    });

    if (status) {
      this.status = status;
    }
  }

  async stop(): Promise<void> {
    if (!this.child) {
      this.status = STOPPED_STATUS;
      return;
    }

    this.stopping = true;

    try {
      await this.request({
        type: "stop",
        requestId: 0,
      });
    } catch {
      // Child is already stopping.
    }

    this.cleanupChild();
    this.stopping = false;
  }

  private spawnWorker(): void {
    const workerScript = path.join(__dirname, "matter-worker.js");
    const nodeExecutable =
      process.env["MATTERKIOSK_NODE_PATH"] ??
      process.env["npm_node_execpath"] ??
      process.env["NODE"] ??
      "node";

    this.child = spawn(nodeExecutable, [workerScript], {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      env: process.env,
    });

    this.child.on("message", (message: MatterWorkerResponse | MatterWorkerEvent) => {
      if (!message || typeof message !== "object" || !("type" in message)) {
        return;
      }

      if (message.type === "response") {
        this.handleResponse(message);
        return;
      }

      if (message.type === "target-triggered") {
        this.handleTargetTriggered(message.targetId);
        return;
      }

      if (message.type === "target-turned-off") {
        this.handleTargetTurnedOff(message.targetId);
      }
    });

    this.child.once("error", (error) => {
      this.closeActiveKioskWindows();
      this.rejectPendingRequests(error);
      this.status = STOPPED_STATUS;
      console.error("[Matter] Worker process failed:", error);
    });

    this.child.once("exit", (code, signal) => {
      const error = new Error(
        `[Matter] Worker exited${code !== null ? ` with code ${code}` : ""}${signal ? ` (signal ${signal})` : ""}.`,
      );

      if (!this.stopping) {
        console.error(error.message);
      }

      this.closeActiveKioskWindows();
      this.rejectPendingRequests(error);
      this.child = null;
      this.status = STOPPED_STATUS;
    });
  }

  private async request(command: MatterWorkerCommand): Promise<MatterStatus | undefined> {
    if (!this.child || !this.child.connected) {
      throw new Error("Matter worker is not running.");
    }

    const requestId = this.nextRequestId++;
    const message = { ...command, requestId };

    return new Promise<MatterStatus | undefined>((resolve, reject) => {
      this.pendingRequests.set(requestId, { resolve, reject });

      try {
        this.child!.send(message);
      } catch (error) {
        this.pendingRequests.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private handleResponse(message: MatterWorkerResponse): void {
    const pending = this.pendingRequests.get(message.requestId);
    if (!pending) {
      return;
    }

    this.pendingRequests.delete(message.requestId);

    if (!message.ok) {
      pending.reject(new Error(message.error ?? "Matter worker request failed."));
      return;
    }

    pending.resolve(message.result);
  }

  private handleTargetTriggered(targetId: string): void {
    const target = this.targets.find((entry) => entry.id === targetId);
    if (!target) {
      return;
    }

    if (this.activeKioskWindows.has(targetId)) {
      return;
    }

    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send("target-triggered", targetId);
      }
    }

    const kioskWindow = openKioskWindow(target.url, target.durationSeconds * 1000, {
      onClosed: () => {
        this.activeKioskWindows.delete(targetId);
        void this.setTargetOff(targetId);
      },
    });

    this.activeKioskWindows.set(targetId, kioskWindow);
    void kioskWindow.closed.catch(console.error);
  }

  private handleTargetTurnedOff(targetId: string): void {
    this.activeKioskWindows.get(targetId)?.close();
  }

  private async setTargetOff(targetId: string): Promise<void> {
    if (this.stopping || !this.child || !this.child.connected) {
      return;
    }

    try {
      await this.request({
        type: "set-target-off",
        requestId: 0,
        targetId,
      });
    } catch (error) {
      console.error(`[Matter] Failed to reset target "${targetId}" to off:`, error);
    }
  }

  private rejectPendingRequests(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private closeActiveKioskWindows(): void {
    for (const kioskWindow of this.activeKioskWindows.values()) {
      kioskWindow.close();
    }
    this.activeKioskWindows.clear();
  }

  private cleanupChild(): void {
    this.closeActiveKioskWindows();

    if (!this.child) {
      this.status = STOPPED_STATUS;
      return;
    }

    if (this.child.connected) {
      this.child.disconnect();
    }

    if (!this.child.killed) {
      this.child.kill();
    }

    this.child = null;
    this.status = STOPPED_STATUS;
    this.pendingRequests.clear();
  }
}

function cloneTargets(targets: KioskTarget[]): KioskTarget[] {
  return targets.map((target) => ({ ...target }));
}

let bridge: MatterBridge | null = null;

export function getMatterBridge(): MatterBridge | null {
  return bridge;
}

export async function startMatterBridge(targets: KioskTarget[]): Promise<MatterBridge> {
  if (bridge) {
    await bridge.syncTargets(targets);
    return bridge;
  }

  const storagePath = path.join(app.getPath("userData"), "matter-storage");
  bridge = new MatterBridge(storagePath);
  await bridge.start(targets);
  return bridge;
}

export async function stopMatterBridge(): Promise<void> {
  if (bridge) {
    await bridge.stop();
    bridge = null;
  }
}
