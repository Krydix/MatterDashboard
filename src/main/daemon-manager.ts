import { app } from "electron";
import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { AppConfig, DaemonState, MatterStatus } from "../shared/types";
import {
  DAEMON_LAUNCH_AGENT_LABEL,
  getDaemonPidPath,
  getDaemonSocketPath,
  getNativeDaemonBinaryName,
  getNativeDaemonBundlePath,
  getLaunchAgentPath,
  getRuntimeDir,
} from "./app-paths";
import {
  getMatterStatusFromDaemon,
  pingDaemon,
  resetMatterFromDaemon,
  shutdownDaemon,
  syncDaemonConfig,
} from "./daemon-client";

const execFileAsync = promisify(execFile);

const STOPPED_STATUS: MatterStatus = {
  started: false,
  paired: false,
  qrCode: "",
  manualPairingCode: "",
};

export async function reconcileDaemon(config: AppConfig): Promise<void> {
  const useLaunchAgent = shouldUseLaunchAgent(config);
  const daemonRunning = await pingDaemon();
  const launchAgentInstalled = existsSync(getLaunchAgentPath());

  if (!config.backgroundDaemonEnabled) {
    await uninstallLaunchAgent();
    await stopDaemon();
    return;
  }

  if (useLaunchAgent) {
    if (daemonRunning && !launchAgentInstalled) {
      await stopDaemon();
      await installLaunchAgent();
    } else if (!daemonRunning) {
      await installLaunchAgent();
    }
  } else {
    await uninstallLaunchAgent();
    if (!daemonRunning) {
      await startDaemonDetached();
    }
  }

  await syncDaemonConfig(config);
}

export async function getDaemonState(config: AppConfig): Promise<DaemonState> {
  return {
    enabled: config.backgroundDaemonEnabled,
    running: await pingDaemon(),
    launchAtLogin: config.launchAtLogin,
  };
}

export async function getMatterStatus(config: AppConfig): Promise<MatterStatus> {
  if (!config.backgroundDaemonEnabled) {
    return STOPPED_STATUS;
  }

  try {
    await reconcileDaemon(config);
    return await getMatterStatusFromDaemon();
  } catch (error) {
    console.error("[Matter] Failed to read daemon status:", error);
    return STOPPED_STATUS;
  }
}

export async function resetMatter(config: AppConfig): Promise<void> {
  if (!config.backgroundDaemonEnabled) {
    return;
  }

  await reconcileDaemon(config);
  await resetMatterFromDaemon();
}

async function startDaemonDetached(): Promise<void> {
  const launch = getDaemonLaunchConfig();
  mkdirSync(getRuntimeDir(), { recursive: true });

  const child = spawn(launch.executable, launch.args, {
    detached: true,
    env: launch.env,
    stdio: "ignore",
  });

  child.unref();
  await waitForDaemon();
}

async function stopDaemon(): Promise<void> {
  if (!(await pingDaemon())) {
    cleanupDaemonArtifacts();
    return;
  }

  try {
    await shutdownDaemon();
  } catch {
    await killDaemonProcess();
  }

  await waitForDaemonToStop();
  cleanupDaemonArtifacts();
}

async function killDaemonProcess(): Promise<void> {
  try {
    const pid = Number(readFileSync(getDaemonPidPath(), "utf8").trim());
    if (!Number.isFinite(pid)) {
      return;
    }

    process.kill(pid, "SIGTERM");
  } catch {
    // Best effort only.
  }
}

async function waitForDaemon(): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await pingDaemon()) {
      return;
    }

    await delay(200);
  }

  throw new Error("Matter daemon did not start in time.");
}

async function waitForDaemonToStop(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!(await pingDaemon())) {
      return;
    }

    await delay(150);
  }
}

function cleanupDaemonArtifacts(): void {
  const socketPath = getDaemonSocketPath();
  if (process.platform !== "win32") {
    rmSync(socketPath, { force: true });
  }
  rmSync(getDaemonPidPath(), { force: true });
}

function getDaemonLaunchConfig(): { executable: string; args: string[]; env: NodeJS.ProcessEnv } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MATTERKIOSK_ELECTRON_EXECUTABLE: process.execPath,
    MATTERKIOSK_WORKER_EXECUTABLE: process.execPath,
    MATTERKIOSK_WORKER_SCRIPT: getMatterWorkerScriptPath(),
  };

  if (!supportsMatterNativeCrypto()) {
    env["MATTER_NODEJS_CRYPTO"] = "false";
  }

  if (!app.isPackaged) {
    env["MATTERKIOSK_UI_APP_PATH"] = path.resolve(__dirname, "../..");
  }

  return {
    executable: getNativeDaemonBinaryPath(),
    args: [],
    env,
  };
}

function supportsMatterNativeCrypto(): boolean {
  return crypto.getCiphers().includes("aes-128-ccm");
}

function shouldUseLaunchAgent(config: AppConfig): boolean {
  return process.platform === "darwin" && app.isPackaged && config.launchAtLogin;
}

async function installLaunchAgent(): Promise<void> {
  if (process.platform !== "darwin" || !app.isPackaged) {
    return;
  }

  const launchAgentPath = getLaunchAgentPath();
  const launch = getDaemonLaunchConfig();

  mkdirSync(path.dirname(launchAgentPath), { recursive: true });
  mkdirSync(getRuntimeDir(), { recursive: true });

  writeFileSync(launchAgentPath, createLaunchAgentPlist(launch), "utf8");

  await bootoutLaunchAgent();
  await runLaunchctl(["bootstrap", `gui/${getGuiUserId()}`, launchAgentPath]);
  await waitForDaemon();
}

async function uninstallLaunchAgent(): Promise<void> {
  if (process.platform !== "darwin" || !app.isPackaged) {
    return;
  }

  await bootoutLaunchAgent();
  unlinkQuietly(getLaunchAgentPath());
}

async function bootoutLaunchAgent(): Promise<void> {
  const userId = getGuiUserId();

  try {
    await runLaunchctl(["bootout", `gui/${userId}/${DAEMON_LAUNCH_AGENT_LABEL}`]);
    return;
  } catch {
    // Fall back to plist-path bootout if the label form is not loaded.
  }

  try {
    await runLaunchctl(["bootout", `gui/${userId}`, getLaunchAgentPath()]);
  } catch {
    // Ignore if not loaded.
  }
}

async function runLaunchctl(args: string[]): Promise<void> {
  await execFileAsync("/bin/launchctl", args);
}

function getGuiUserId(): number {
  if (typeof process.getuid === "function") {
    return process.getuid();
  }

  return Number(process.env["UID"] ?? os.userInfo().uid);
}

function unlinkQuietly(filePath: string): void {
  if (!existsSync(filePath)) {
    return;
  }

  try {
    unlinkSync(filePath);
  } catch {
    // Best effort only.
  }
}

function createLaunchAgentPlist(launch: {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}): string {
  const stdoutPath = path.join(getRuntimeDir(), "daemon.stdout.log");
  const stderrPath = path.join(getRuntimeDir(), "daemon.stderr.log");
  const envEntries = Object.entries({
    MATTER_NODEJS_CRYPTO: launch.env["MATTER_NODEJS_CRYPTO"],
    MATTERKIOSK_ELECTRON_EXECUTABLE: launch.env["MATTERKIOSK_ELECTRON_EXECUTABLE"],
    MATTERKIOSK_UI_APP_PATH: launch.env["MATTERKIOSK_UI_APP_PATH"],
    MATTERKIOSK_WORKER_EXECUTABLE: launch.env["MATTERKIOSK_WORKER_EXECUTABLE"],
    MATTERKIOSK_WORKER_SCRIPT: launch.env["MATTERKIOSK_WORKER_SCRIPT"],
  }).filter(([, value]) => value !== undefined);

  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
    "<plist version=\"1.0\">",
    "<dict>",
    `  <key>Label</key><string>${DAEMON_LAUNCH_AGENT_LABEL}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    `    <string>${escapeXml(launch.executable)}</string>`,
    ...launch.args.map((arg) => `    <string>${escapeXml(arg)}</string>`),
    "  </array>",
    "  <key>RunAtLoad</key><true/>",
    "  <key>KeepAlive</key><true/>",
    "  <key>StandardOutPath</key>",
    `  <string>${escapeXml(stdoutPath)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${escapeXml(stderrPath)}</string>`,
    envEntries.length > 0 ? "  <key>EnvironmentVariables</key>" : "",
    envEntries.length > 0 ? "  <dict>" : "",
    ...envEntries.map(([key, value]) => `    <key>${escapeXml(key)}</key><string>${escapeXml(value ?? "")}</string>`),
    envEntries.length > 0 ? "  </dict>" : "",
    "</dict>",
    "</plist>",
  ]
    .filter(Boolean)
    .join("\n");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function getMatterWorkerScriptPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "app.asar", "dist", "main", "matter-worker.js");
  }

  return path.join(__dirname, "matter-worker.js");
}

function getNativeDaemonBinaryPath(): string {
  const packagedBinary = path.join(process.resourcesPath, getNativeDaemonBundlePath());
  if (app.isPackaged) {
    return packagedBinary;
  }

  const assetBinary = path.resolve(process.cwd(), "assets", getNativeDaemonBundlePath());
  if (existsSync(assetBinary)) {
    return assetBinary;
  }

  const buildBinary = path.resolve(
    process.cwd(),
    "native",
    "daemon",
    "build",
    `${process.platform}-${process.arch}`,
    getNativeDaemonBinaryName(),
  );

  if (existsSync(buildBinary)) {
    return buildBinary;
  }

  throw new Error(
    `Native Matter daemon binary not found. Expected one of: ${assetBinary}, ${buildBinary}`,
  );
}