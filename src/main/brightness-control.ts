import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { app, screen } from "electron";
import { AppConfig, BrightnessControlAvailability } from "../shared/types";

const execFileAsync = promisify(execFile);

const MAC_HELPER_NAME = "m1ddc";
const MAC_HELPER_UNAVAILABLE_REASON = "Display brightness control requires an m1ddc helper for Apple Silicon external displays.";
const MAC_DISPLAY_UNAVAILABLE_REASON = "The selected display does not expose DDC brightness control through m1ddc.";

function getBundledHelperPath(): string {
  const relativePath = path.join("native", `${process.platform}-${process.arch}`, MAC_HELPER_NAME);
  if (app.isPackaged) {
    return path.join(process.resourcesPath, relativePath);
  }

  return path.resolve(__dirname, "../../assets", relativePath);
}

async function resolveHelperExecutable(): Promise<string | null> {
  const bundledPath = getBundledHelperPath();
  if (existsSync(bundledPath)) {
    return bundledPath;
  }

  try {
    const { stdout } = await execFileAsync("/usr/bin/which", [MAC_HELPER_NAME], { timeout: 1000 });
    const executable = stdout.trim();
    return executable.length > 0 ? executable : null;
  } catch {
    return null;
  }
}

function resolveEffectiveDisplayId(selectedDisplayId: number | null): number | null {
  if (typeof selectedDisplayId === "number") {
    return selectedDisplayId;
  }

  const primaryDisplay = screen.getPrimaryDisplay();
  return typeof primaryDisplay?.id === "number" ? primaryDisplay.id : null;
}

function parseBrightnessValue(stdout: string): number {
  const match = stdout.match(/-?\d+(?:\.\d+)?/);
  if (!match) {
    throw new Error("Unexpected m1ddc brightness response.");
  }

  return Math.max(0, Math.min(100, Math.round(Number(match[0]))));
}

async function runBrightnessHelper(args: string[], helperExecutable?: string): Promise<string> {
  const executable = helperExecutable ?? (await resolveHelperExecutable());
  if (!executable) {
    throw new Error(MAC_HELPER_UNAVAILABLE_REASON);
  }

  const { stdout } = await execFileAsync(executable, args, { timeout: 3000 });
  return stdout.trim();
}

export async function readDisplayBrightness(displayId: number): Promise<number> {
  const stdout = await runBrightnessHelper(["display", `id=${displayId}`, "get", "luminance"]);
  return parseBrightnessValue(stdout);
}

export async function setDisplayBrightness(displayId: number, level: number): Promise<void> {
  const clampedLevel = Math.max(0, Math.min(100, Math.round(level)));
  await runBrightnessHelper(["display", `id=${displayId}`, "set", "luminance", String(clampedLevel)]);
}

export async function getBrightnessControlAvailability(config: AppConfig): Promise<BrightnessControlAvailability> {
  if (process.platform !== "darwin") {
    return {
      available: false,
      reason: "This build only enables host brightness bridging on macOS.",
    };
  }

  if (process.arch !== "arm64") {
    return {
      available: false,
      reason: "This macOS brightness backend currently supports Apple Silicon Macs only.",
    };
  }

  const helperExecutable = await resolveHelperExecutable();
  if (!helperExecutable) {
    return {
      available: false,
      reason: MAC_HELPER_UNAVAILABLE_REASON,
    };
  }

  const displayId = resolveEffectiveDisplayId(config.presentationDisplayId);
  if (displayId === null) {
    return {
      available: false,
      reason: "No active display is available for brightness control.",
    };
  }

  try {
    await runBrightnessHelper(["display", `id=${displayId}`, "get", "luminance"], helperExecutable);
    return { available: true, reason: "" };
  } catch (error) {
    console.warn("[Brightness] Failed to probe host brightness availability:", error);
    return {
      available: false,
      reason: MAC_DISPLAY_UNAVAILABLE_REASON,
    };
  }
}
