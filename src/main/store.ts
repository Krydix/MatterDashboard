import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  AppConfig,
  DashboardProvider,
  KioskTarget,
  TrmnlAssetMode,
  TrmnlDashboardConfig,
  TrmnlImportedRecipe,
  TrmnlPollExchange,
  TrmnlPollingConfig,
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
    provider,
    trmnl: provider === "trmnl" ? sanitizeTrmnlConfig(target.trmnl) : undefined,
  };
}

function sanitizeProvider(provider: DashboardProvider | undefined): DashboardProvider {
  return provider === "trmnl" ? "trmnl" : "url";
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
