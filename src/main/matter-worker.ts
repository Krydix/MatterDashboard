import "./electron-crypto-compat";
import "@matter/main/platform";
import readline from "node:readline";
import { Endpoint, Environment, ServerNode, VendorId, CommissioningServer } from "@matter/main";
import { BridgedDeviceBasicInformationServer } from "@matter/main/behaviors/bridged-device-basic-information";
import { LevelControlServer } from "@matter/main/behaviors/level-control";
import { OnOffServer } from "@matter/main/behaviors/on-off";
import { ControlBridgeDevice } from "@matter/main/devices/control-bridge";
import { DimmableLightDevice } from "@matter/main/devices/dimmable-light";
import { OnOffPlugInUnitDevice } from "@matter/main/devices/on-off-plug-in-unit";
import { AggregatorEndpoint } from "@matter/main/endpoints/aggregator";
import { MatterAccessory, MatterStatus } from "../shared/types";

interface EndpointEntry {
  endpoint: Endpoint;
  targetId: string;
  target: MatterAccessory;
}

type WorkerCommand =
  | { type: "start"; requestId: number; storagePath: string; targets: MatterAccessory[] }
  | { type: "sync-targets"; requestId: number; targets: MatterAccessory[] }
  | { type: "set-target-state"; requestId: number; target: MatterAccessory }
  | { type: "get-status"; requestId: number }
  | { type: "reset"; requestId: number }
  | { type: "set-target-off"; requestId: number; targetId: string }
  | { type: "stop"; requestId: number };

type WorkerResponse = {
  type: "response";
  requestId: number;
  ok: boolean;
  result?: MatterStatus;
  error?: string;
};

type WorkerEvent =
  | {
      type: "target-triggered" | "target-turned-off";
      targetId: string;
    }
  | {
      type: "target-level-changed";
      targetId: string;
      level: number;
    };

const STDIO_PROTOCOL_PREFIX = "MKP:";

class MatterBridgeWorker {
  private server: ServerNode | null = null;
  private aggregator: Endpoint | null = null;
  private endpoints = new Map<string, EndpointEntry>();
  private suppressedTargetEvents = new Map<string, number>();
  private storagePath = "";
  private targets: MatterAccessory[] = [];
  private qrCode = "";
  private manualPairingCode = "";
  private paired = false;

  async start(storagePath: string, targets: MatterAccessory[]): Promise<MatterStatus> {
    this.storagePath = storagePath;
    this.targets = cloneTargets(targets);

    Environment.default.vars.set("storage.path", this.storagePath);

    this.server = await ServerNode.create({
      id: "matter-kiosk-bridge",
      network: {
        port: 5540,
      },
      commissioning: {
        passcode: 20202021,
        discriminator: 3840,
      },
      productDescription: {
        name: "MatterKiosk",
        deviceType: ControlBridgeDevice.deviceType,
      },
      basicInformation: {
        vendorName: "MatterKiosk",
        vendorId: VendorId(0xfff1),
        nodeLabel: "MatterKiosk Bridge",
        productName: "MatterKiosk",
        productLabel: "MatterKiosk Bridge",
        productId: 0x8000,
        serialNumber: "matter-kiosk-bridge-1",
        uniqueId: "matter-kiosk-bridge-1",
      },
    });

    this.server.lifecycle.commissioned.on(() => {
      console.log("[Matter] Bridge commissioned!");
    });

    this.aggregator = new Endpoint(AggregatorEndpoint, { id: "aggregator" });
    await (this.server as unknown as Endpoint).add(this.aggregator);

    for (const target of targets.filter((entry) => entry.enabled)) {
      await this.addEndpoint(target);
    }

    await this.server.start();

    try {
      const commissioningState = this.server.stateOf(CommissioningServer);
      this.paired = commissioningState.commissioned;
      this.qrCode = commissioningState.pairingCodes.qrPairingCode;
      this.manualPairingCode = commissioningState.pairingCodes.manualPairingCode;
    } catch (error) {
      console.warn("[Matter] Could not read pairing codes:", error);
    }

    this.server.events.commissioning.commissioned.on(() => {
      console.log("[Matter] Bridge commissioned!");
      this.paired = true;
    });

    this.server.events.commissioning.decommissioned.on(() => {
      console.log("[Matter] Bridge decommissioned!");
      this.paired = false;
    });

    console.log("[Matter] Bridge started.");
    if (this.qrCode) console.log(`[Matter] QR Code: ${this.qrCode}`);
    if (this.manualPairingCode) console.log(`[Matter] Manual code: ${this.manualPairingCode}`);

    return this.getStatus();
  }

  async syncTargets(targets: MatterAccessory[]): Promise<MatterStatus> {
    if (!this.server || !this.aggregator) {
      return this.getStatus();
    }

    this.targets = cloneTargets(targets);

    const enabledTargets = targets.filter((target) => target.enabled);
    const enabledIds = new Set(enabledTargets.map((target) => target.id));
    const existingIds = new Set(this.endpoints.keys());

    for (const id of existingIds) {
      const target = enabledTargets.find((entry) => entry.id === id);
      const current = this.endpoints.get(id);
      if (!target || !current || current.target.deviceType !== target.deviceType) {
        await this.removeEndpoint(id);
      }
    }

    for (const target of enabledTargets) {
      if (target.enabled && !existingIds.has(target.id)) {
        await this.addEndpoint(target);
      }
    }

    for (const target of enabledTargets) {
      const entry = this.endpoints.get(target.id);
      if (!entry || !target.enabled) {
        continue;
      }

      try {
        await entry.endpoint.setStateOf(BridgedDeviceBasicInformationServer, {
          nodeLabel: target.name,
          productName: target.name,
          productLabel: target.name,
          uniqueId: getTargetUniqueId(target.id),
        });
        await this.applyEndpointState(entry.endpoint, target);
        entry.target = cloneTarget(target);
      } catch {
        // Best effort only.
      }
    }

    return this.getStatus();
  }

  async setTargetOff(targetId: string): Promise<void> {
    const entry = this.endpoints.get(targetId);
    if (!entry) {
      return;
    }

    try {
      await this.withSuppressedTargetEvents(targetId, async () => {
        await entry.endpoint.setStateOf(OnOffServer, { onOff: false });
      });
      entry.target = { ...entry.target, on: false };
    } catch (error) {
      console.warn(`[Matter] Failed to clear on/off state for target "${targetId}":`, error);
    }
  }

  async setTargetState(target: MatterAccessory): Promise<void> {
    const entry = this.endpoints.get(target.id);
    if (!entry) {
      return;
    }

    const nextTarget = cloneTarget(entry.target);
    nextTarget.on = target.on;
    if (nextTarget.deviceType === "dimmable-light" && target.deviceType === "dimmable-light") {
      nextTarget.level = normalizeMatterLevel(target.level);
    }

    const stateChanged =
      entry.target.on !== nextTarget.on ||
      (entry.target.deviceType === "dimmable-light" &&
        nextTarget.deviceType === "dimmable-light" &&
        entry.target.level !== nextTarget.level);

    if (!stateChanged) {
      return;
    }

    await this.withSuppressedTargetEvents(target.id, async () => {
      await this.applyEndpointState(entry.endpoint, nextTarget);
    });
    entry.target = nextTarget;
  }

  async reset(): Promise<MatterStatus> {
    if (!this.server) {
      return this.getStatus();
    }

    await this.server.erase();
    this.refreshStatusFromServer();
    return this.getStatus();
  }

  getStatus(): MatterStatus {
    this.refreshStatusFromServer();

    return {
      started: this.server !== null,
      paired: this.paired,
      qrCode: this.qrCode,
      manualPairingCode: this.manualPairingCode,
    };
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    try {
      await this.server.close();
    } finally {
      this.server = null;
      this.aggregator = null;
      this.endpoints.clear();
      this.paired = false;
      this.qrCode = "";
      this.manualPairingCode = "";
    }
  }

  private refreshStatusFromServer(): void {
    if (!this.server) {
      return;
    }

    try {
      const commissioningState = this.server.stateOf(CommissioningServer);
      this.paired = commissioningState.commissioned;
      this.qrCode = commissioningState.pairingCodes.qrPairingCode;
      this.manualPairingCode = commissioningState.pairingCodes.manualPairingCode;
    } catch (error) {
      console.warn("[Matter] Could not read pairing status:", error);
    }
  }

  private async addEndpoint(target: MatterAccessory): Promise<void> {
    if (!this.aggregator || this.endpoints.has(target.id)) {
      return;
    }

    const endpoint = new Endpoint(
      target.deviceType === "dimmable-light"
        ? DimmableLightDevice.with(BridgedDeviceBasicInformationServer)
        : OnOffPlugInUnitDevice.with(BridgedDeviceBasicInformationServer),
      {
        id: `kiosk-${target.id}`,
        bridgedDeviceBasicInformation: {
          nodeLabel: target.name,
          productName: target.name,
          productLabel: target.name,
          serialNumber: `mk-${target.id.substring(0, 25)}`,
          uniqueId: getTargetUniqueId(target.id),
          reachable: true,
        },
      },
    );

    await (this.aggregator as unknown as Endpoint).add(endpoint);
    await this.applyEndpointState(endpoint, target);

    endpoint.events.onOff.onOff$Changed.on((value: boolean) => {
      if (this.isTargetEventSuppressed(target.id)) {
        return;
      }

      if (value) {
        console.log(`[Matter] Target "${target.name}" turned ON`);
        sendWorkerEvent({ type: "target-triggered", targetId: target.id });
      } else {
        console.log(`[Matter] Target "${target.name}" turned OFF`);
        sendWorkerEvent({ type: "target-turned-off", targetId: target.id });
      }
    });

    if (target.deviceType === "dimmable-light") {
      endpoint.eventsOf(LevelControlServer).currentLevel$Changed.on((value: number | null) => {
        if (this.isTargetEventSuppressed(target.id)) {
          return;
        }

        if (typeof value !== "number") {
          return;
        }

        console.log(`[Matter] Target "${target.name}" level -> ${value}`);
        sendWorkerEvent({ type: "target-level-changed", targetId: target.id, level: value });
      });
    }

    this.endpoints.set(target.id, { endpoint, targetId: target.id, target: cloneTarget(target) });
    console.log(`[Matter] Added endpoint for target "${target.name}"`);
  }

  private isTargetEventSuppressed(targetId: string): boolean {
    return (this.suppressedTargetEvents.get(targetId) ?? 0) > 0;
  }

  private async withSuppressedTargetEvents(targetId: string, action: () => Promise<void>): Promise<void> {
    this.suppressedTargetEvents.set(targetId, (this.suppressedTargetEvents.get(targetId) ?? 0) + 1);

    try {
      await action();
    } finally {
      const remaining = (this.suppressedTargetEvents.get(targetId) ?? 1) - 1;
      if (remaining <= 0) {
        this.suppressedTargetEvents.delete(targetId);
      } else {
        this.suppressedTargetEvents.set(targetId, remaining);
      }
    }
  }

  private async applyEndpointState(endpoint: Endpoint, target: MatterAccessory): Promise<void> {
    await endpoint.setStateOf(OnOffServer, { onOff: target.on });

    if (target.deviceType !== "dimmable-light") {
      return;
    }

    await endpoint.setStateOf(LevelControlServer, {
      currentLevel: normalizeMatterLevel(target.level),
    });
  }

  private async removeEndpoint(targetId: string): Promise<void> {
    const entry = this.endpoints.get(targetId);
    if (!entry) {
      return;
    }

    await entry.endpoint.delete();
    this.endpoints.delete(targetId);
    console.log(`[Matter] Removed endpoint for target id "${targetId}"`);
  }
}

function cloneTargets(targets: MatterAccessory[]): MatterAccessory[] {
  return targets.map(cloneTarget);
}

function cloneTarget(target: MatterAccessory): MatterAccessory {
  return { ...target };
}

function getTargetUniqueId(targetId: string): string {
  return targetId.replace(/-/g, "").slice(0, 32);
}

function normalizeMatterLevel(level: number | undefined): number {
  if (typeof level !== "number" || Number.isNaN(level)) {
    return 127;
  }

  return Math.max(1, Math.min(254, Math.round(level)));
}

function sendWorkerEvent(event: WorkerEvent): void {
  if (typeof process.send === "function") {
    process.send(event);
    return;
  }

  stdoutWrite(`${STDIO_PROTOCOL_PREFIX}${JSON.stringify(event)}\n`);
}

function sendWorkerResponse(response: WorkerResponse): void {
  if (typeof process.send === "function") {
    process.send(response);
    return;
  }

  stdoutWrite(`${STDIO_PROTOCOL_PREFIX}${JSON.stringify(response)}\n`);
}

function asErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

const bridge = new MatterBridgeWorker();

const useStdioProtocol = typeof process.send !== "function";
const stdoutWrite = process.stdout.write.bind(process.stdout);

if (useStdioProtocol) {
  console.log = (...args: unknown[]) => {
    console.error(...args);
  };

  process.stdout.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding, callback?: (error?: Error | null) => void) => {
    if (typeof encoding === "function") {
      return process.stderr.write(chunk, encoding);
    }

    if (typeof callback === "function") {
      return process.stderr.write(chunk, encoding, callback);
    }

    return process.stderr.write(chunk, encoding);
  }) as typeof process.stdout.write;
}

async function handleCommand(message: WorkerCommand | undefined): Promise<void> {
  if (!message || typeof message !== "object" || !("type" in message)) {
    return;
  }

  try {
    switch (message.type) {
      case "start": {
        const result = await bridge.start(message.storagePath, message.targets);
        sendWorkerResponse({ type: "response", requestId: message.requestId, ok: true, result });
        break;
      }
      case "sync-targets": {
        const result = await bridge.syncTargets(message.targets);
        sendWorkerResponse({ type: "response", requestId: message.requestId, ok: true, result });
        break;
      }
      case "set-target-state": {
        await bridge.setTargetState(message.target);
        sendWorkerResponse({ type: "response", requestId: message.requestId, ok: true });
        break;
      }
      case "get-status": {
        sendWorkerResponse({
          type: "response",
          requestId: message.requestId,
          ok: true,
          result: bridge.getStatus(),
        });
        break;
      }
      case "reset": {
        const result = await bridge.reset();
        sendWorkerResponse({ type: "response", requestId: message.requestId, ok: true, result });
        break;
      }
      case "set-target-off": {
        await bridge.setTargetOff(message.targetId);
        sendWorkerResponse({ type: "response", requestId: message.requestId, ok: true });
        break;
      }
      case "stop": {
        await bridge.stop();
        sendWorkerResponse({ type: "response", requestId: message.requestId, ok: true });
        break;
      }
    }
  } catch (error) {
    sendWorkerResponse({
      type: "response",
      requestId: message.requestId,
      ok: false,
      error: asErrorMessage(error),
    });
  }
}

process.on("message", (message: WorkerCommand | undefined) => {
  void handleCommand(message);
});

if (useStdioProtocol) {
  const lineReader = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  lineReader.on("line", (line) => {
    try {
      void handleCommand(JSON.parse(line) as WorkerCommand);
    } catch (error) {
      sendWorkerResponse({
        type: "response",
        requestId: -1,
        ok: false,
        error: asErrorMessage(error),
      });
    }
  });

  lineReader.on("close", () => {
    bridge.stop().finally(() => process.exit(0));
  });
}

process.on("disconnect", () => {
  bridge.stop().finally(() => process.exit(0));
});