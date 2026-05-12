export type DashboardProvider = "url" | "trmnl" | "app";

export interface AppPickResult {
  applicationPath: string;
  applicationName: string | null;
  bundleId: string | null;
}

export interface AppTargetConfig {
  applicationName?: string;
  bundleId?: string;
  applicationPath?: string;
  arguments?: string[];
  /** When true the orchestrator does not auto-close the session after durationSeconds. */
  noTimeout?: boolean;
  /** When true the app is gracefully quit when the Matter target is turned off. */
  closeOnDeactivate?: boolean;
}

export type TrmnlAssetMode = "cached" | "remote";

export type TrmnlImportKind = "recipe";

export type TrmnlExchangeFormat = "auto" | "json" | "text" | "xml";

export interface TrmnlTransformConfig {
  enabled: boolean;
  intervalSeconds: number;
  timeoutMs: number;
  script: string;
}

export interface TrmnlImportedRecipe {
  kind: TrmnlImportKind;
  recipeId: string;
  source: string;
  archiveUrl?: string;
  importedAt: string;
}

export interface TrmnlPollExchange {
  id: string;
  label: string;
  urlTemplate: string;
  method: string;
  headers: Record<string, string>;
  bodyTemplate?: string;
  format: TrmnlExchangeFormat;
}

export interface TrmnlPollingConfig {
  enabled: boolean;
  intervalSeconds: number;
  exchanges: TrmnlPollExchange[];
}

export interface TrmnlCustomFieldOption {
  label: string;
  value: string;
}

export type TrmnlCustomFieldType = "string" | "select" | "multi_string" | "author_bio";

export interface TrmnlCustomField {
  keyname: string;
  name: string;
  field_type: TrmnlCustomFieldType | string;
  description?: string;
  help_text?: string;
  placeholder?: string;
  options?: TrmnlCustomFieldOption[];
  default?: string | number | boolean | string[];
  optional?: boolean;
  category?: string;
  group?: string;
  multiple?: boolean;
  /** For `text` / `code` fields: textarea row height. */
  rows?: number;
  /** For `number` fields. */
  min?: number;
  max?: number;
  step?: number;
  /** For string / text fields: maximum character length. */
  maxlength?: number;
  /** For `copyable` fields: the static value to display. */
  value?: string;
}

export interface TrmnlDashboardConfig {
  template: string;
  data: string;
  fields?: string;
  assetMode?: TrmnlAssetMode;
  cssUrl?: string;
  jsUrl?: string;
  importSource?: TrmnlImportedRecipe;
  polling?: TrmnlPollingConfig;
  transform?: TrmnlTransformConfig;
  darkMode?: boolean;
  noScreenPadding?: boolean;
}

export interface ImportedTrmnlTarget {
  name: string;
  trmnl: TrmnlDashboardConfig;
}

export interface KioskTarget {
  id: string;
  name: string;
  url: string;
  durationSeconds: number;
  enabled: boolean;
  fullScreen?: boolean;
  borderless?: boolean;
  provider: DashboardProvider;
  app?: AppTargetConfig;
  trmnl?: TrmnlDashboardConfig;
}

export interface VolumeControlConfig {
  enabled: boolean;
  name: string;
}

export interface VolumeControlAvailability {
  available: boolean;
  reason: string;
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
  "import-trmnl-recipe": (source: string) => ImportedTrmnlTarget;
  "get-volume-control-availability": () => VolumeControlAvailability;
  "get-matter-status": () => MatterStatus;
  "reset-matter": () => void;
  "set-launch-at-login": (enabled: boolean) => void;
  "target-triggered": (targetId: string) => void;
  "pick-app": () => AppPickResult | null;
};
