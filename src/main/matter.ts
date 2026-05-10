import "@matter/main/platform";
import { app, BrowserWindow } from "electron";
import path from "path";
import { Endpoint, Environment, ServerNode, VendorId, CommissioningServer } from "@matter/main";
import { BridgedDeviceBasicInformationServer } from "@matter/main/behaviors/bridged-device-basic-information";
import { OnOffPlugInUnitDevice } from "@matter/main/devices/on-off-plug-in-unit";
import { AggregatorEndpoint } from "@matter/main/endpoints/aggregator";
import { KioskTarget, MatterStatus } from "../shared/types";
import { openKioskWindow } from "./windows";

// ─── Types ───────────────────────────────────────────────────────────────────

interface EndpointEntry {
  endpoint: Endpoint;
  targetId: string;
}

// ─── MatterBridge ────────────────────────────────────────────────────────────

export class MatterBridge {
  private server: ServerNode | null = null;
  private aggregator: Endpoint | null = null;
  private endpoints = new Map<string, EndpointEntry>(); // keyed by target id
  private storagePath: string;
  private targets: KioskTarget[] = [];
  private _qrCode = "";
  private _manualPairingCode = "";
  private _paired = false;

  constructor(storagePath: string) {
    this.storagePath = storagePath;
  }

  async start(targets: KioskTarget[]): Promise<void> {
    this.targets = targets.map((target) => ({ ...target }));

    // Set the matter.js storage path via environment variable
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
        deviceType: AggregatorEndpoint.deviceType,
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

    // Capture QR / pairing codes before starting
    this.server.lifecycle.commissioned.on(() => {
      console.log("[Matter] Bridge commissioned!");
    });

    this.aggregator = new Endpoint(AggregatorEndpoint, { id: "aggregator" });
    await (this.server as unknown as Endpoint).add(this.aggregator);

    // Add all currently enabled targets
    const enabledTargets = targets.filter((t) => t.enabled);
    for (const target of enabledTargets) {
      await this._addEndpoint(target);
    }

    await this.server.start();

    // Extract QR/pairing codes and commissioned state after start
    try {
      const commState = this.server.stateOf(CommissioningServer);
      this._paired = commState.commissioned;
      this._qrCode = commState.pairingCodes.qrPairingCode;
      this._manualPairingCode = commState.pairingCodes.manualPairingCode;
    } catch (e) {
      console.warn("[Matter] Could not read pairing codes:", e);
    }

    // Watch for commissioning changes
    this.server.events.commissioning.commissioned.on(() => {
      console.log("[Matter] Bridge commissioned!");
      this._paired = true;
    });

    this.server.events.commissioning.decommissioned.on(() => {
      console.log("[Matter] Bridge decommissioned!");
      this._paired = false;
    });
    console.log("[Matter] Bridge started.");
    if (this._qrCode) console.log(`[Matter] QR Code: ${this._qrCode}`);
    if (this._manualPairingCode) console.log(`[Matter] Manual code: ${this._manualPairingCode}`);
  }

  private async _addEndpoint(target: KioskTarget): Promise<void> {
    if (!this.aggregator) return;
    if (this.endpoints.has(target.id)) return; // already exists

    const name = target.name;

    const endpoint = new Endpoint(
      OnOffPlugInUnitDevice.with(BridgedDeviceBasicInformationServer),
      {
        // Use the target id as the stable endpoint id so it survives restarts
        id: `kiosk-${target.id}`,
        bridgedDeviceBasicInformation: {
          nodeLabel: name,
          productName: name,
          productLabel: name,
          serialNumber: `mk-${target.id.substring(0, 25)}`,  // max 32 chars
          reachable: true,
        },
      },
    );

    await (this.aggregator as unknown as Endpoint).add(endpoint);

    endpoint.events.onOff.onOff$Changed.on((value: boolean) => {
      if (value) {
        console.log(`[Matter] Target "${name}" turned ON — opening kiosk`);
        this._notifyRenderer(target.id);
        openKioskWindow(target.url, target.durationSeconds * 1000).catch(console.error);
      } else {
        console.log(`[Matter] Target "${name}" turned OFF`);
      }
    });

    this.endpoints.set(target.id, { endpoint, targetId: target.id });
    console.log(`[Matter] Added endpoint for target "${name}"`);
  }

  private async _removeEndpoint(targetId: string): Promise<void> {
    const entry = this.endpoints.get(targetId);
    if (!entry) return;

    await entry.endpoint.close();
    this.endpoints.delete(targetId);
    console.log(`[Matter] Removed endpoint for target id "${targetId}"`);
  }

  /**
   * Synchronise Matter endpoints to reflect the current list of enabled targets.
   * Adds new endpoints and removes deleted/disabled ones — no re-pairing required.
   */
  async syncTargets(targets: KioskTarget[]): Promise<void> {
    if (!this.server || !this.aggregator) return;

    this.targets = targets.map((target) => ({ ...target }));

    const enabledIds = new Set(targets.filter((t) => t.enabled).map((t) => t.id));
    const existingIds = new Set(this.endpoints.keys());

    // Remove endpoints for targets that are gone or disabled
    for (const id of existingIds) {
      if (!enabledIds.has(id)) {
        await this._removeEndpoint(id);
      }
    }

    // Add endpoints for new or newly enabled targets
    for (const target of targets) {
      if (target.enabled && !existingIds.has(target.id)) {
        await this._addEndpoint(target);
      }
    }

    // Update names for existing endpoints that may have been renamed
    for (const target of targets) {
      const entry = this.endpoints.get(target.id);
      if (entry && target.enabled) {
        try {
          await entry.endpoint.setStateOf(BridgedDeviceBasicInformationServer, {
            nodeLabel: target.name,
            productName: target.name,
            productLabel: target.name,
          });
        } catch {
          // Not critical if rename fails while bridge is offline
        }
      }
    }
  }

  getStatus(): MatterStatus {
    return {
      started: this.server !== null,
      paired: this._paired,
      qrCode: this._qrCode,
      manualPairingCode: this._manualPairingCode,
    };
  }

  async reset(): Promise<void> {
    if (!this.server) return;

    const targets = this.targets.map((target) => ({ ...target }));

    await this.server.reset();
    await this.stop();
    await this.start(targets);
    console.log("[Matter] Reset complete.");
  }

  async stop(): Promise<void> {
    if (this.server) {
      await this.server.close();
      this.server = null;
      this.aggregator = null;
      this.endpoints.clear();
      this._paired = false;
      this._qrCode = "";
      this._manualPairingCode = "";
    }
  }

  private _notifyRenderer(targetId: string): void {
    // Send to all renderer windows (settings window if open)
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send("target-triggered", targetId);
      }
    }
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

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
