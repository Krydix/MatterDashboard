export interface KioskTarget {
  id: string;
  name: string;
  url: string;
  durationSeconds: number;
  enabled: boolean;
}

export interface AppConfig {
  targets: KioskTarget[];
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
