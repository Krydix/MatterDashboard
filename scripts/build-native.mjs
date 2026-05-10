import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const projectRoot = path.resolve(new URL("..", import.meta.url).pathname);
const platform = process.platform;
const arch = process.arch;
const buildDir = path.join(projectRoot, "native", "daemon", "build", `${platform}-${arch}`);
const sourceDir = path.join(projectRoot, "native", "daemon");
const outputDir = path.join(projectRoot, "assets", "native", `${platform}-${arch}`);
const binaryName = platform === "win32" ? "matterkiosk-daemon.exe" : "matterkiosk-daemon";
const builtBinaryPath =
  platform === "win32"
    ? path.join(buildDir, "Release", binaryName)
    : path.join(buildDir, binaryName);
const stagedBinaryPath = path.join(outputDir, binaryName);

run("cmake", ["-S", sourceDir, "-B", buildDir, "-DCMAKE_BUILD_TYPE=Release"]);
run("cmake", ["--build", buildDir, "--config", "Release"]);

if (!existsSync(builtBinaryPath)) {
  throw new Error(`Native daemon binary not found after build: ${builtBinaryPath}`);
}

mkdirSync(outputDir, { recursive: true });
copyFileSync(builtBinaryPath, stagedBinaryPath);
console.log(`Staged native daemon: ${path.relative(projectRoot, stagedBinaryPath)}`);

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}.`);
  }
}