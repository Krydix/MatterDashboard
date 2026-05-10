import { AppConfig, DaemonState, MatterStatus } from "../shared/types";

interface MatterKioskAPI {
  platform: string;
  getConfig(): Promise<AppConfig>;
  saveConfig(config: AppConfig): Promise<void>;
  getMatterStatus(): Promise<MatterStatus>;
  getDaemonState(): Promise<DaemonState>;
  resetMatter(): Promise<void>;
  setLaunchAtLogin(enabled: boolean): Promise<void>;
  openKiosk(targetId: string): Promise<void>;
  onTargetTriggered(callback: (targetId: string) => void): () => void;
}

declare global {
  interface Window {
    matterkiosk: MatterKioskAPI;
  }
}

export {};
