import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const projectRoot = path.resolve(new URL("..", import.meta.url).pathname);
const platform = process.platform;
const arch = process.arch;
const buildDir = path.join(projectRoot, "native", "daemon", "build", `${platform}-${arch}`);
const sourceDir = path.join(projectRoot, "native", "daemon");
const outputDir = path.join(projectRoot, "assets", "native", `${platform}-${arch}`);
const binaryName = platform === "win32" ? "matterkiosk-daemon.exe" : "matterkiosk-daemon";
const chipBridgeBinaryName = platform === "win32" ? "chip-bridge-app.exe" : "chip-bridge-app";
const connectedhomeipRoot = path.resolve(
  process.env["MATTERKIOSK_CONNECTEDHOMEIP_ROOT"] ?? path.join(projectRoot, "third_party", "connectedhomeip"),
);
const connectedhomeipBootstrapPaths = [
  path.join(connectedhomeipRoot, "third_party", "boringssl", "repo", "src"),
  path.join(connectedhomeipRoot, "third_party", "pigweed", "repo", "pw_env_setup", "util.sh"),
  path.join(connectedhomeipRoot, "third_party", "openthread", "repo"),
  path.join(connectedhomeipRoot, "third_party", "editline", "repo"),
];
const builtBinaryPath =
  platform === "win32"
    ? path.join(buildDir, "Release", binaryName)
    : path.join(buildDir, binaryName);

// On macOS the binary is staged inside a .app bundle so the OS can associate an icon with it.
const daemonAppBundleDir =
  platform === "darwin"
    ? path.join(outputDir, "matterkiosk-daemon.app", "Contents")
    : null;
const stagedBinaryDir =
  daemonAppBundleDir ? path.join(daemonAppBundleDir, "MacOS") : outputDir;
const stagedBinaryPath = path.join(stagedBinaryDir, binaryName);
const chipBridgeArtifactsDir = path.join(buildDir, "chip-bridge-artifacts");
const stagedChipBridgeBinaryPath = path.join(outputDir, chipBridgeBinaryName);
const connectedhomeipPatchPath = path.join(projectRoot, "patches", "connectedhomeip", "matterkiosk-bridge.patch");

let shouldRevertConnectedhomeipPatch = false;

if (existsSync(connectedhomeipRoot)) {
  console.log(`Using connectedhomeip checkout: ${path.relative(projectRoot, connectedhomeipRoot)}`);
  if (connectedhomeipBootstrapPaths.some((bootstrapPath) => !existsSync(bootstrapPath))) {
    console.log("Initializing connectedhomeip nested submodules...");
    run("git", ["-C", connectedhomeipRoot, "submodule", "update", "--init", "--recursive", "--depth", "1"]);
  }

  shouldRevertConnectedhomeipPatch = ensureConnectedhomeipPatchApplied();
} else {
  console.log(
    `connectedhomeip checkout not found at ${path.relative(projectRoot, connectedhomeipRoot)}; continuing with the legacy worker-backed runtime build.`,
  );
}

try {
  run("cmake", [
    "-S",
    sourceDir,
    "-B",
    buildDir,
    "-DCMAKE_BUILD_TYPE=Release",
    `-DMATTERKIOSK_CONNECTEDHOMEIP_ROOT=${connectedhomeipRoot}`,
  ]);
  run("cmake", ["--build", buildDir, "--config", "Release"]);

  if (!existsSync(builtBinaryPath)) {
    throw new Error(`Native daemon binary not found after build: ${builtBinaryPath}`);
  }

  mkdirSync(stagedBinaryDir, { recursive: true });
  copyFileSync(builtBinaryPath, stagedBinaryPath);
  console.log(`Staged native daemon: ${path.relative(projectRoot, stagedBinaryPath)}`);

  if (daemonAppBundleDir) {
    // Write Info.plist for the daemon .app bundle so macOS shows the correct icon.
    const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>com.matterkiosk.daemon</string>
  <key>CFBundleName</key>
  <string>MatterKiosk Daemon</string>
  <key>CFBundleDisplayName</key>
  <string>MatterKiosk Daemon</string>
  <key>CFBundleExecutable</key>
  <string>matterkiosk-daemon</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>LSBackgroundOnly</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`;
    writeFileSync(path.join(daemonAppBundleDir, "Info.plist"), infoPlist, "utf8");

    // Copy the app icon into the bundle resources.
    const resourcesDir = path.join(daemonAppBundleDir, "Resources");
    mkdirSync(resourcesDir, { recursive: true });
    const icnsSource = path.join(projectRoot, "assets", "icon.icns");
    if (existsSync(icnsSource)) {
      copyFileSync(icnsSource, path.join(resourcesDir, "AppIcon.icns"));
      console.log("Staged daemon .app bundle icon.");
    } else {
      console.warn("icon.icns not found at assets/icon.icns — daemon bundle will have no icon.");
    }
  }

  const chipBridgeTarget = getConnectedhomeipBridgeTarget(platform, arch);
  if (chipBridgeTarget !== null && existsSync(connectedhomeipRoot)) {
    buildConnectedhomeipBridge(chipBridgeTarget);
  }
} finally {
  if (shouldRevertConnectedhomeipPatch) {
    revertConnectedhomeipPatch();
  }
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}.`);
  }
}

function runCapture(command, args, cwd = projectRoot) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function runShell(command, cwd) {
  const result = spawnSync("/bin/zsh", ["-lc", command], {
    cwd,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error(`Shell command failed with exit code ${result.status ?? "unknown"}.`);
  }
}

function ensureConnectedhomeipPatchApplied() {
  if (!existsSync(connectedhomeipPatchPath)) {
    return false;
  }

  const alreadyApplied = runCapture("git", ["-C", connectedhomeipRoot, "apply", "--reverse", "--check", connectedhomeipPatchPath]);
  if (alreadyApplied.status === 0) {
    console.log(`connectedhomeip patch already applied: ${path.relative(projectRoot, connectedhomeipPatchPath)}`);
    return false;
  }

  const localStatus = runCapture(
    "git",
    [
      "-C",
      connectedhomeipRoot,
      "status",
      "--short",
      "--",
      "examples/bridge-app/linux/main.cpp",
      "examples/platform/linux/NamedPipeCommands.cpp",
    ],
  );
  if (localStatus.status !== 0) {
    throw new Error(`Failed to inspect connectedhomeip status: ${localStatus.stderr.trim()}`);
  }

  if (localStatus.stdout.trim() !== "") {
    throw new Error(
      "connectedhomeip has local changes in MatterKiosk-patched files. Commit, stash, or discard them before building.",
    );
  }

  const canApply = runCapture("git", ["-C", connectedhomeipRoot, "apply", "--check", connectedhomeipPatchPath]);
  if (canApply.status !== 0) {
    throw new Error(
      `Failed to apply connectedhomeip patch ${path.relative(projectRoot, connectedhomeipPatchPath)}:\n${canApply.stderr.trim()}`,
    );
  }

  run("git", ["-C", connectedhomeipRoot, "apply", connectedhomeipPatchPath]);
  console.log(`Applied connectedhomeip patch: ${path.relative(projectRoot, connectedhomeipPatchPath)}`);
  return true;
}

function revertConnectedhomeipPatch() {
  const canReverse = runCapture("git", ["-C", connectedhomeipRoot, "apply", "--reverse", "--check", connectedhomeipPatchPath]);
  if (canReverse.status !== 0) {
    throw new Error(
      `Failed to revert connectedhomeip patch ${path.relative(projectRoot, connectedhomeipPatchPath)}:\n${canReverse.stderr.trim()}`,
    );
  }

  run("git", ["-C", connectedhomeipRoot, "apply", "--reverse", connectedhomeipPatchPath]);
  console.log(`Reverted connectedhomeip patch: ${path.relative(projectRoot, connectedhomeipPatchPath)}`);
}

function getConnectedhomeipBridgeTarget(currentPlatform, currentArch) {
  if (currentPlatform === "darwin" && currentArch === "arm64") {
    return "darwin-arm64-bridge-clang-boringssl";
  }

  if (currentPlatform === "darwin" && currentArch === "x64") {
    return "darwin-x64-bridge-clang-boringssl";
  }

  if (currentPlatform === "linux" && currentArch === "x64") {
    return "linux-x64-bridge-clang-boringssl";
  }

  if (currentPlatform === "linux" && currentArch === "arm64") {
    return "linux-arm64-bridge-clang-boringssl";
  }

  console.log(`Skipping native CHIP bridge build for unsupported host: ${currentPlatform}-${currentArch}`);
  return null;
}

function buildConnectedhomeipBridge(target) {
  mkdirSync(chipBridgeArtifactsDir, { recursive: true });

  const command =
    `source ./scripts/activate.sh && python3 scripts/build/build_examples.py ` +
    `--target ${shellQuote(target)} build --copy-artifacts-to ${shellQuote(chipBridgeArtifactsDir)}`;

  runShell(command, connectedhomeipRoot);

  const builtChipBridgeBinaryPath = path.join(chipBridgeArtifactsDir, target, chipBridgeBinaryName);
  if (!existsSync(builtChipBridgeBinaryPath)) {
    throw new Error(`Native CHIP bridge binary not found after build: ${builtChipBridgeBinaryPath}`);
  }

  copyFileSync(builtChipBridgeBinaryPath, stagedChipBridgeBinaryPath);
  console.log(`Staged native CHIP bridge: ${path.relative(projectRoot, stagedChipBridgeBinaryPath)}`);
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}