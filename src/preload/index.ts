import { contextBridge, ipcRenderer } from "electron";
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

// Expose a typed API to the renderer through contextBridge.
// The renderer has NO access to Node.js — only the methods defined here.
contextBridge.exposeInMainWorld("matterkiosk", {
  platform: process.platform,

  getConfig: (): Promise<AppConfig> => ipcRenderer.invoke("get-config"),

  saveConfig: (config: AppConfig): Promise<void> => ipcRenderer.invoke("save-config", config),

  getPresentationDisplays: (): Promise<PresentationDisplay[]> =>
    ipcRenderer.invoke("get-presentation-displays"),

  getBrightnessControlAvailability: (): Promise<BrightnessControlAvailability> =>
    ipcRenderer.invoke("get-brightness-control-availability"),

  importTrmnlRecipe: (source: string): Promise<ImportedTrmnlTarget> =>
    ipcRenderer.invoke("import-trmnl-recipe", source),

  getVolumeControlAvailability: (): Promise<VolumeControlAvailability> =>
    ipcRenderer.invoke("get-volume-control-availability"),

  getMatterStatus: (): Promise<MatterStatus> => ipcRenderer.invoke("get-matter-status"),

  getDaemonState: (): Promise<DaemonState> => ipcRenderer.invoke("get-daemon-state"),

  resetMatter: (): Promise<void> => ipcRenderer.invoke("reset-matter"),

  setLaunchAtLogin: (enabled: boolean): Promise<void> =>
    ipcRenderer.invoke("set-launch-at-login", enabled),

  openKiosk: (targetId: string): Promise<void> => ipcRenderer.invoke("open-kiosk", targetId),

  browseRecipes: (): Promise<string | null> => ipcRenderer.invoke("browse-trmnl-recipes"),

  pickApp: (): Promise<AppPickResult | null> => ipcRenderer.invoke("pick-app"),

  checkCliInstall: (): Promise<CliInstallStatus> => ipcRenderer.invoke("check-cli-install"),

  installCli: (): Promise<{ ok: boolean; installPath: string; error?: string }> =>
    ipcRenderer.invoke("install-cli"),

  onTargetTriggered: (callback: (targetId: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, targetId: string) => callback(targetId);
    ipcRenderer.on("target-triggered", handler);
    // Return an unsubscribe function
    return () => ipcRenderer.removeListener("target-triggered", handler);
  },

  startWindowDrag: (startX: number, startY: number): void => {
    ipcRenderer.send("start-window-drag", { startX, startY });
  },
  sendWindowDragMove: (x: number, y: number): void => {
    ipcRenderer.send("drag-window-move", { x, y });
  },
  stopWindowDrag: (): void => {
    ipcRenderer.send("stop-window-drag");
  },
});
