import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { AppConfig, KioskTarget } from "../shared/types";
import { getAppDataDir, getConfigPath } from "./app-paths";

const defaultConfig: AppConfig = {
  targets: [],
  launchAtLogin: false,
  backgroundDaemonEnabled: false,
};

export function getConfig(): AppConfig {
  try {
    const raw = readFileSync(getConfigPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<AppConfig>;

    return {
      targets: sanitizeTargets(parsed.targets),
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

  return targets.filter(isKioskTarget).map((target) => ({ ...target }));
}

function isKioskTarget(value: unknown): value is KioskTarget {
  if (!value || typeof value !== "object") {
    return false;
  }

  const target = value as Partial<KioskTarget>;
  return (
    typeof target.id === "string" &&
    typeof target.name === "string" &&
    typeof target.url === "string" &&
    typeof target.durationSeconds === "number" &&
    target.durationSeconds >= 1 &&
    typeof target.enabled === "boolean"
  );
}
