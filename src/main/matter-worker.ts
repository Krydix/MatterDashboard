import "./electron-crypto-compat";
import "@matter/main/platform";
import { Endpoint, Environment, ServerNode, VendorId, CommissioningServer } from "@matter/main";
import { BridgedDeviceBasicInformationServer } from "@matter/main/behaviors/bridged-device-basic-information";
import { OnOffServer } from "@matter/main/behaviors/on-off";
import { ControlBridgeDevice } from "@matter/main/devices/control-bridge";
import { OnOffPlugInUnitDevice } from "@matter/main/devices/on-off-plug-in-unit";
import { AggregatorEndpoint } from "@matter/main/endpoints/aggregator";
import { KioskTarget, MatterStatus } from "../shared/types";

interface EndpointEntry {
  endpoint: Endpoint;
  targetId: string;
}

type WorkerCommand =
  | { type: "start"; requestId: number; storagePath: string; targets: KioskTarget[] }
  | { type: "sync-targets"; requestId: number; targets: KioskTarget[] }
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

type WorkerEvent = {
  type: "target-triggered";
  targetId: string;
};

class MatterBridgeWorker {
  private server: ServerNode | null = null;
  private aggregator: Endpoint | null = null;
  private endpoints = new Map<string, EndpointEntry>();
  private storagePath = "";
  private targets: KioskTarget[] = [];
  private qrCode = "";
  private manualPairingCode = "";
  private paired = false;

  async start(storagePath: string, targets: KioskTarget[]): Promise<MatterStatus> {
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

  async syncTargets(targets: KioskTarget[]): Promise<MatterStatus> {
    if (!this.server || !this.aggregator) {
      return this.getStatus();
    }

    this.targets = cloneTargets(targets);

    const enabledIds = new Set(targets.filter((target) => target.enabled).map((target) => target.id));
    const existingIds = new Set(this.endpoints.keys());

    for (const id of existingIds) {
      if (!enabledIds.has(id)) {
        await this.removeEndpoint(id);
      }
    }

    for (const target of targets) {
      if (target.enabled && !existingIds.has(target.id)) {
        await this.addEndpoint(target);
      }
    }

    for (const target of targets) {
      const entry = this.endpoints.get(target.id);
      if (!entry || !target.enabled) {
        continue;
      }

      try {
        await entry.endpoint.setStateOf(BridgedDeviceBasicInformationServer, {
          nodeLabel: target.name,
          productName: target.name,
          productLabel: target.name,
        });
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
      await entry.endpoint.setStateOf(OnOffServer, { onOff: false });
    } catch (error) {
      console.warn(`[Matter] Failed to clear on/off state for target "${targetId}":`, error);
    }
  }

  async reset(): Promise<MatterStatus> {
    if (!this.server) {
      return this.getStatus();
    }

    const targets = cloneTargets(this.targets);
    await this.server.reset();
    await this.stop();
    return this.start(this.storagePath, targets);
  }

  getStatus(): MatterStatus {
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

    await this.server.close();
    this.server = null;
    this.aggregator = null;
    this.endpoints.clear();
    this.paired = false;
    this.qrCode = "";
    this.manualPairingCode = "";
  }

  private async addEndpoint(target: KioskTarget): Promise<void> {
    if (!this.aggregator || this.endpoints.has(target.id)) {
      return;
    }

    const endpoint = new Endpoint(
      OnOffPlugInUnitDevice.with(BridgedDeviceBasicInformationServer),
      {
        id: `kiosk-${target.id}`,
        bridgedDeviceBasicInformation: {
          nodeLabel: target.name,
          productName: target.name,
          productLabel: target.name,
          serialNumber: `mk-${target.id.substring(0, 25)}`,
          reachable: true,
        },
      },
    );

    await (this.aggregator as unknown as Endpoint).add(endpoint);

    endpoint.events.onOff.onOff$Changed.on((value: boolean) => {
      if (value) {
        console.log(`[Matter] Target "${target.name}" turned ON`);
        sendWorkerEvent({ type: "target-triggered", targetId: target.id });
      } else {
        console.log(`[Matter] Target "${target.name}" turned OFF`);
      }
    });

    this.endpoints.set(target.id, { endpoint, targetId: target.id });
    console.log(`[Matter] Added endpoint for target "${target.name}"`);
  }

  private async removeEndpoint(targetId: string): Promise<void> {
    const entry = this.endpoints.get(targetId);
    if (!entry) {
      return;
    }

    await entry.endpoint.close();
    this.endpoints.delete(targetId);
    console.log(`[Matter] Removed endpoint for target id "${targetId}"`);
  }
}

function cloneTargets(targets: KioskTarget[]): KioskTarget[] {
  return targets.map((target) => ({ ...target }));
}

function sendWorkerEvent(event: WorkerEvent): void {
  if (typeof process.send === "function") {
    process.send(event);
  }
}

function sendWorkerResponse(response: WorkerResponse): void {
  if (typeof process.send === "function") {
    process.send(response);
  }
}

function asErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

const bridge = new MatterBridgeWorker();

process.on("message", async (message: WorkerCommand | undefined) => {
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
});

process.on("disconnect", () => {
  bridge.stop().finally(() => process.exit(0));
});