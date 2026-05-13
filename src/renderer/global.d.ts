import {
  AppConfig,
  AppPickResult,
  BrightnessControlAvailability,
  CliInstallStatus,
  DaemonState,
  ImportedTrmnlTarget,
  MatterStatus,
  PresentationDisplay,
  VolumeControlAvailability,
} from "../shared/types";

interface MatterKioskAPI {
  platform: string;
  getConfig(): Promise<AppConfig>;
  saveConfig(config: AppConfig): Promise<void>;
  getPresentationDisplays(): Promise<PresentationDisplay[]>;
  getBrightnessControlAvailability(): Promise<BrightnessControlAvailability>;
  importTrmnlRecipe(source: string): Promise<ImportedTrmnlTarget>;
  getVolumeControlAvailability(): Promise<VolumeControlAvailability>;
  getMatterStatus(): Promise<MatterStatus>;
  getDaemonState(): Promise<DaemonState>;
  resetMatter(): Promise<void>;
  setLaunchAtLogin(enabled: boolean): Promise<void>;
  openKiosk(targetId: string): Promise<void>;
  browseRecipes(): Promise<string | null>;
  pickApp(): Promise<AppPickResult | null>;
  checkCliInstall(): Promise<CliInstallStatus>;
  installCli(): Promise<{ ok: boolean; installPath: string; error?: string }>;
  onTargetTriggered(callback: (targetId: string) => void): () => void;
  startWindowDrag(startX: number, startY: number): void;
  sendWindowDragMove(x: number, y: number): void;
  stopWindowDrag(): void;
}

declare global {
  interface Window {
    matterkiosk: MatterKioskAPI;
  }
}

export {};
