import Store from "electron-store";
import { AppConfig, KioskTarget } from "../shared/types";

const defaultConfig: AppConfig = {
  targets: [],
  launchAtLogin: false,
};

const store = new Store<AppConfig>({
  name: "config",
  defaults: defaultConfig,
  schema: {
    targets: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          url: { type: "string" },
          durationSeconds: { type: "number", minimum: 1 },
          enabled: { type: "boolean" },
        },
        required: ["id", "name", "url", "durationSeconds", "enabled"],
      },
      default: [],
    },
    launchAtLogin: {
      type: "boolean",
      default: false,
    },
  },
});

export function getConfig(): AppConfig {
  return {
    targets: store.get("targets") as KioskTarget[],
    launchAtLogin: store.get("launchAtLogin") as boolean,
  };
}

export function saveConfig(config: AppConfig): void {
  store.set("targets", config.targets);
  store.set("launchAtLogin", config.launchAtLogin);
}
