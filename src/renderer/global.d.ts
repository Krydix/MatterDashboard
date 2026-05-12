import { AppConfig, DaemonState, ImportedTrmnlTarget, MatterStatus, VolumeControlAvailability } from "../shared/types";

interface MatterKioskAPI {
  platform: string;
  getConfig(): Promise<AppConfig>;
  saveConfig(config: AppConfig): Promise<void>;
  importTrmnlRecipe(source: string): Promise<ImportedTrmnlTarget>;
  getVolumeControlAvailability(): Promise<VolumeControlAvailability>;
  getMatterStatus(): Promise<MatterStatus>;
  getDaemonState(): Promise<DaemonState>;
  resetMatter(): Promise<void>;
  setLaunchAtLogin(enabled: boolean): Promise<void>;
  openKiosk(targetId: string): Promise<void>;
  browseRecipes(): Promise<string | null>;
  onTargetTriggered(callback: (targetId: string) => void): () => void;
}

declare global {
  interface Window {
    matterkiosk: MatterKioskAPI;
  }
}

export {};
