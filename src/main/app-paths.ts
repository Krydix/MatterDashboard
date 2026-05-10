import os from "node:os";
import path from "node:path";

const APP_DIR_NAME = "matter-kiosk";

export const DAEMON_LAUNCH_AGENT_LABEL = "com.matterkiosk.daemon";

export function getAppDataDir(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", APP_DIR_NAME);
  }

  if (process.platform === "win32") {
    return path.join(process.env["APPDATA"] ?? path.join(os.homedir(), "AppData", "Roaming"), APP_DIR_NAME);
  }

  return path.join(process.env["XDG_CONFIG_HOME"] ?? path.join(os.homedir(), ".config"), APP_DIR_NAME);
}

export function getConfigPath(): string {
  return path.join(getAppDataDir(), "config.json");
}

export function getMatterStoragePath(): string {
  return path.join(getAppDataDir(), "matter-storage");
}

export function getRuntimeDir(): string {
  return path.join(getAppDataDir(), "runtime");
}

export function getDaemonSocketPath(): string {
  if (process.platform === "win32") {
    return "\\\\.\\pipe\\matterkiosk-daemon";
  }

  return path.join(getRuntimeDir(), "daemon.sock");
}

export function getDaemonPidPath(): string {
  return path.join(getRuntimeDir(), "daemon.pid");
}

export function getNativeDaemonBinaryName(platform = process.platform): string {
  return platform === "win32" ? "matterkiosk-daemon.exe" : "matterkiosk-daemon";
}

export function getNativeChipBridgeBinaryName(platform = process.platform): string {
  return platform === "win32" ? "chip-bridge-app.exe" : "chip-bridge-app";
}

export function getNativeDaemonBundleDir(platform = process.platform, arch = process.arch): string {
  return path.join("native", `${platform}-${arch}`);
}

export function getNativeDaemonBundlePath(platform = process.platform, arch = process.arch): string {
  if (platform === "darwin") {
    return path.join(
      getNativeDaemonBundleDir(platform, arch),
      "matterkiosk-daemon.app",
      "Contents",
      "MacOS",
      getNativeDaemonBinaryName(platform),
    );
  }
  return path.join(getNativeDaemonBundleDir(platform, arch), getNativeDaemonBinaryName(platform));
}

export function getNativeChipBridgeBundlePath(platform = process.platform, arch = process.arch): string {
  return path.join(getNativeDaemonBundleDir(platform, arch), getNativeChipBridgeBinaryName(platform));
}

export function getLaunchAgentPath(): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${DAEMON_LAUNCH_AGENT_LABEL}.plist`);
}