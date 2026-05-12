import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  AppTargetConfig,
  AppConfig,
  DashboardProvider,
  KioskTarget,
  TrmnlAssetMode,
  TrmnlDashboardConfig,
  TrmnlImportedRecipe,
  TrmnlPollExchange,
  TrmnlPollingConfig,
  TrmnlTransformConfig,
  VolumeControlConfig,
} from "../shared/types";
import { getAppDataDir, getConfigPath } from "./app-paths";

const defaultConfig: AppConfig = {
  targets: [],
  volumeControl: {
    enabled: false,
    name: "Volume",
  },
  launchAtLogin: false,
  backgroundDaemonEnabled: false,
};

export function getConfig(): AppConfig {
  try {
    const raw = readFileSync(getConfigPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<AppConfig>;

    return {
      targets: sanitizeTargets(parsed.targets),
      volumeControl: sanitizeVolumeControl(parsed.volumeControl),
      launchAtLogin: parsed.launchAtLogin ?? defaultConfig.launchAtLogin,
      backgroundDaemonEnabled:
        parsed.backgroundDaemonEnabled ?? parsed.launchAtLogin ?? defaultConfig.backgroundDaemonEnabled,
    };
  } catch {
    return { ...defaultConfig };
  }
}

export function saveConfig(config: AppConfig): void {
  mkdirSync(getAppDataDir(), { recursive: true });
  writeFileSync(getConfigPath(), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function sanitizeTargets(targets: AppConfig["targets"] | undefined): KioskTarget[] {
  if (!Array.isArray(targets)) {
    return [];
  }

  return targets.map(sanitizeTarget).filter((target): target is KioskTarget => target !== null);
}

function sanitizeVolumeControl(value: Partial<VolumeControlConfig> | undefined): VolumeControlConfig {
  if (!value || typeof value !== "object") {
    return { ...defaultConfig.volumeControl };
  }

  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : defaultConfig.volumeControl.enabled,
    name:
      typeof value.name === "string" && value.name.trim().length > 0
        ? value.name.trim()
        : defaultConfig.volumeControl.name,
  };
}

function sanitizeTarget(value: unknown): KioskTarget | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const target = value as Partial<KioskTarget>;
  if (
    typeof target.id !== "string" ||
    typeof target.name !== "string" ||
    typeof target.url !== "string" ||
    typeof target.durationSeconds !== "number" ||
    target.durationSeconds < 1 ||
    typeof target.enabled !== "boolean"
  ) {
    return null;
  }

  const provider = sanitizeProvider(target.provider);

  return {
    id: target.id,
    name: target.name,
    url: target.url,
    durationSeconds: target.durationSeconds,
    enabled: target.enabled,
    fullScreen: target.fullScreen === true ? true : undefined,
    borderless: typeof target.borderless === "boolean" ? target.borderless : undefined,
    provider,
    app: provider === "app" ? sanitizeAppConfig(target.app) : undefined,
    trmnl: provider === "trmnl" ? sanitizeTrmnlConfig(target.trmnl) : undefined,
  };
}

function sanitizeProvider(provider: DashboardProvider | undefined): DashboardProvider {
  if (provider === "trmnl" || provider === "app") {
    return provider;
  }

  return "url";
}

function sanitizeAppConfig(value: Partial<AppTargetConfig> | undefined): AppTargetConfig {
  if (!value || typeof value !== "object") {
    return {
      arguments: [],
    };
  }

  return {
    applicationName:
      typeof value.applicationName === "string" && value.applicationName.trim().length > 0
        ? value.applicationName.trim()
        : undefined,
    bundleId:
      typeof value.bundleId === "string" && value.bundleId.trim().length > 0
        ? value.bundleId.trim()
        : undefined,
    applicationPath:
      typeof value.applicationPath === "string" && value.applicationPath.trim().length > 0
        ? value.applicationPath.trim()
        : undefined,
    arguments: Array.isArray(value.arguments)
      ? value.arguments
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
      : [],
    noTimeout: value.noTimeout === true ? true : undefined,
    closeOnDeactivate: value.closeOnDeactivate === true ? true : undefined,
  };
}

function sanitizeTrmnlConfig(value: Partial<TrmnlDashboardConfig> | undefined): TrmnlDashboardConfig {
  if (!value || typeof value !== "object") {
    return {
      template: "",
      data: "{}",
      assetMode: "cached",
    };
  }

  return {
    template: typeof value.template === "string" ? value.template : "",
    data: typeof value.data === "string" && value.data.trim().length > 0 ? value.data : "{}",
    fields: typeof value.fields === "string" && value.fields.trim().length > 0 ? value.fields : undefined,
    assetMode: sanitizeTrmnlAssetMode(value.assetMode),
    cssUrl: typeof value.cssUrl === "string" && value.cssUrl.trim().length > 0 ? value.cssUrl.trim() : undefined,
    jsUrl: typeof value.jsUrl === "string" && value.jsUrl.trim().length > 0 ? value.jsUrl.trim() : undefined,
    importSource: sanitizeImportedRecipe(value.importSource),
    polling: sanitizePollingConfig(value.polling),
    transform: sanitizeTransformConfig(value.transform),
    darkMode: value.darkMode === true ? true : undefined,
    noScreenPadding: value.noScreenPadding === true ? true : undefined,
  };
}

function sanitizeTrmnlAssetMode(value: TrmnlAssetMode | undefined): TrmnlAssetMode {
  return value === "remote" ? "remote" : "cached";
}

function sanitizeImportedRecipe(value: unknown): TrmnlImportedRecipe | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const recipe = value as Partial<TrmnlImportedRecipe>;
  if (
    recipe.kind !== "recipe" ||
    typeof recipe.recipeId !== "string" ||
    recipe.recipeId.trim().length === 0 ||
    typeof recipe.source !== "string" ||
    recipe.source.trim().length === 0 ||
    typeof recipe.importedAt !== "string" ||
    recipe.importedAt.trim().length === 0
  ) {
    return undefined;
  }

  return {
    kind: "recipe",
    recipeId: recipe.recipeId.trim(),
    source: recipe.source.trim(),
    importedAt: recipe.importedAt.trim(),
    archiveUrl:
      typeof recipe.archiveUrl === "string" && recipe.archiveUrl.trim().length > 0
        ? recipe.archiveUrl.trim()
        : undefined,
  };
}

function sanitizePollingConfig(value: unknown): TrmnlPollingConfig | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const polling = value as Partial<TrmnlPollingConfig>;
  const exchanges = Array.isArray(polling.exchanges)
    ? polling.exchanges.map(sanitizePollExchange).filter((item): item is TrmnlPollExchange => item !== null)
    : [];
  if (exchanges.length === 0) {
    return undefined;
  }

  return {
    enabled: polling.enabled !== false,
    intervalSeconds:
      typeof polling.intervalSeconds === "number" && Number.isFinite(polling.intervalSeconds) && polling.intervalSeconds > 0
        ? Math.round(polling.intervalSeconds)
        : 60,
    exchanges,
  };
}

function sanitizePollExchange(value: unknown): TrmnlPollExchange | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const exchange = value as Partial<TrmnlPollExchange>;
  if (
    typeof exchange.id !== "string" ||
    exchange.id.trim().length === 0 ||
    typeof exchange.label !== "string" ||
    exchange.label.trim().length === 0 ||
    typeof exchange.urlTemplate !== "string" ||
    exchange.urlTemplate.trim().length === 0 ||
    typeof exchange.method !== "string" ||
    exchange.method.trim().length === 0
  ) {
    return null;
  }

  return {
    id: exchange.id.trim(),
    label: exchange.label.trim(),
    urlTemplate: exchange.urlTemplate,
    method: exchange.method.trim().toUpperCase(),
    headers: sanitizeHeaderRecord(exchange.headers),
    bodyTemplate:
      typeof exchange.bodyTemplate === "string" && exchange.bodyTemplate.trim().length > 0
        ? exchange.bodyTemplate
        : undefined,
    format: exchange.format === "json" || exchange.format === "text" || exchange.format === "xml" ? exchange.format : "auto",
  };
}

function sanitizeHeaderRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") {
    return {};
  }

  return Object.entries(value).reduce<Record<string, string>>((all, [key, item]) => {
    if (typeof item === "string") {
      all[key] = item;
    }
    return all;
  }, {});
}

function sanitizeTransformConfig(value: unknown): TrmnlTransformConfig | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const transform = value as Partial<TrmnlTransformConfig>;
  if (typeof transform.script !== "string" || transform.script.trim().length === 0) {
    return undefined;
  }

  return {
    enabled: transform.enabled !== false,
    intervalSeconds:
      typeof transform.intervalSeconds === "number" && Number.isFinite(transform.intervalSeconds) && transform.intervalSeconds > 0
        ? Math.round(transform.intervalSeconds)
        : 60,
    timeoutMs:
      typeof transform.timeoutMs === "number" && Number.isFinite(transform.timeoutMs) && transform.timeoutMs >= 1000
        ? Math.round(transform.timeoutMs)
        : 15000,
    script: transform.script,
  };
}
