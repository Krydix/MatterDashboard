export interface KioskTarget {
  id: string;
  name: string;
  url: string;
  durationSeconds: number;
  enabled: boolean;
}

export interface VolumeControlConfig {
  enabled: boolean;
  name: string;
}

export type MatterAccessoryKind = "dashboard" | "volume";

export type MatterAccessoryDeviceType = "on-off-plug-in-unit" | "dimmable-light";

interface MatterAccessoryBase {
  id: string;
  name: string;
  kind: MatterAccessoryKind;
  deviceType: MatterAccessoryDeviceType;
  enabled: boolean;
  on: boolean;
}

export interface DashboardMatterAccessory extends MatterAccessoryBase {
  kind: "dashboard";
  deviceType: "on-off-plug-in-unit";
  url: string;
  durationSeconds: number;
}

export interface VolumeMatterAccessory extends MatterAccessoryBase {
  kind: "volume";
  deviceType: "dimmable-light";
  level: number;
}

export type MatterAccessory = DashboardMatterAccessory | VolumeMatterAccessory;

export interface AppConfig {
  targets: KioskTarget[];
  volumeControl: VolumeControlConfig;
  launchAtLogin: boolean;
  backgroundDaemonEnabled: boolean;
}

export interface MatterStatus {
  started: boolean;
  paired: boolean;
  qrCode: string;
  manualPairingCode: string;
}

export interface DaemonState {
  enabled: boolean;
  running: boolean;
  launchAtLogin: boolean;
}

export type IpcChannels = {
  "get-config": () => AppConfig;
  "save-config": (config: AppConfig) => void;
  "get-matter-status": () => MatterStatus;
  "reset-matter": () => void;
  "set-launch-at-login": (enabled: boolean) => void;
  "target-triggered": (targetId: string) => void;
};
