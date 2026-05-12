import { Buffer } from "node:buffer";
import { BrowserWindow } from "electron";

const RUNNER_PAGE_URL = `data:text/html;charset=utf-8,${encodeURIComponent(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8" /><title>MatterKiosk TRMNL Transform Runner</title></head><body></body></html>`)}`;

const WORKER_SCRIPT = String.raw`
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const MAX_RESULT_BYTES = 2 * 1024 * 1024;
const MAX_LOG_ENTRIES = 200;

function stringifyValue(value) {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item);
    }
    return value;
  }

  for (const key of Object.keys(value)) {
    deepFreeze(value[key]);
  }

  return value;
}

function normalizeSource(source) {
  return String(source)
    .replace(/export\s+default\s+async\s+function\s+run/g, "async function run")
    .replace(/export\s+async\s+function\s+run/g, "async function run")
    .replace(/export\s+function\s+run/g, "function run")
    .replace(/export\s+default\s+async\s+function\s+transform/g, "async function transform")
    .replace(/export\s+async\s+function\s+transform/g, "async function transform")
    .replace(/export\s+function\s+transform/g, "function transform");
}

self.importScripts = undefined;
self.XMLHttpRequest = undefined;
self.WebSocket = undefined;
self.EventSource = undefined;

self.onmessage = async (event) => {
  const payload = event.data || {};
  const logs = [];
  const recordLog = (level, args) => {
    if (logs.length >= MAX_LOG_ENTRIES) {
      return;
    }

    logs.push({
      level,
      message: args.map(stringifyValue).join(" "),
    });
  };

  const consoleShim = {
    log: (...args) => recordLog("log", args),
    info: (...args) => recordLog("info", args),
    warn: (...args) => recordLog("warn", args),
    error: (...args) => recordLog("error", args),
    debug: (...args) => recordLog("debug", args),
  };

  try {
    const frozenInput = deepFreeze(structuredClone(payload.input));
    const source = normalizeSource(payload.source);
    const functionBody = [
      '"use strict";',
      'const console = __helpers.console;',
      'const fetch = __helpers.fetch;',
      'const URL = __helpers.URL;',
      'const URLSearchParams = __helpers.URLSearchParams;',
      'const Headers = __helpers.Headers;',
      'const Request = __helpers.Request;',
      'const Response = __helpers.Response;',
      'const AbortController = __helpers.AbortController;',
      'const TextEncoder = __helpers.TextEncoder;',
      'const TextDecoder = __helpers.TextDecoder;',
      'const crypto = __helpers.crypto;',
      'const atob = __helpers.atob;',
      'const btoa = __helpers.btoa;',
      'const setTimeout = __helpers.setTimeout;',
      'const clearTimeout = __helpers.clearTimeout;',
      'let module = { exports: {} };',
      'let exports = module.exports;',
      source,
      'const __candidate = typeof run === "function" ? run : (typeof transform === "function" ? transform : (typeof module.exports === "function" ? module.exports : (module.exports && typeof module.exports.run === "function" ? module.exports.run : (module.exports && typeof module.exports.transform === "function" ? module.exports.transform : (exports && typeof exports.run === "function" ? exports.run : (exports && typeof exports.transform === "function" ? exports.transform : null))))));',
      'if (typeof __candidate !== "function") { throw new Error("transform.js must define a run(input) or transform(input) function."); }',
      'return await __candidate(__input);',
    ].join("\n");

    const execute = new AsyncFunction("__input", "__helpers", functionBody);
    const result = await execute(frozenInput, {
      console: consoleShim,
      fetch: (...args) => fetch(...args),
      URL,
      URLSearchParams,
      Headers,
      Request,
      Response,
      AbortController,
      TextEncoder,
      TextDecoder,
      crypto,
      atob,
      btoa,
      setTimeout,
      clearTimeout,
    });

    const serialized = JSON.stringify(result ?? null);
    if (serialized.length > MAX_RESULT_BYTES) {
      throw new Error("Transform result exceeds 2MB.");
    }

    self.postMessage({
      ok: true,
      result: JSON.parse(serialized),
      logs,
    });
  } catch (error) {
    self.postMessage({
      ok: false,
      error: error && error.stack ? error.stack : String(error),
      logs,
    });
  }
};
`;

const RUNNER_BOOTSTRAP_SCRIPT = [
  "(() => {",
  "function normalizeSource(source) {",
  "  return String(source)",
  "    .replace(/export\\s+default\\s+async\\s+function\\s+run/g, \"async function run\")",
  "    .replace(/export\\s+async\\s+function\\s+run/g, \"async function run\")",
  "    .replace(/export\\s+function\\s+run/g, \"function run\")",
  "    .replace(/export\\s+default\\s+async\\s+function\\s+transform/g, \"async function transform\")",
  "    .replace(/export\\s+async\\s+function\\s+transform/g, \"async function transform\")",
  "    .replace(/export\\s+function\\s+transform/g, \"function transform\");",
  "}",
  "function decodeUtf8Base64(value) {",
  "  const binary = atob(value);",
  "  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));",
  "  return new TextDecoder().decode(bytes);",
  "}",
  `const WORKER_SCRIPT = ${JSON.stringify(WORKER_SCRIPT)};`,
  "window.__matterkioskRunTransform = function (sourceBase64, input, timeoutMs) {",
  "  return new Promise((resolve) => {",
  "    const blob = new Blob([WORKER_SCRIPT], { type: \"text/javascript\" });",
  "    const workerUrl = URL.createObjectURL(blob);",
  "    const worker = new Worker(workerUrl, { name: \"matterkiosk-trmnl-transform\" });",
  "",
  "    const cleanup = () => {",
  "      clearTimeout(timer);",
  "      worker.terminate();",
  "      URL.revokeObjectURL(workerUrl);",
  "    };",
  "",
  "    const timer = setTimeout(() => {",
  "      cleanup();",
  "      resolve({ ok: false, error: `Transform timed out after ${timeoutMs}ms.`, logs: [] });",
  "    }, timeoutMs);",
  "",
  "    worker.onmessage = (event) => {",
  "      cleanup();",
  "      resolve(event.data);",
  "    };",
  "",
  "    worker.onerror = (event) => {",
  "      cleanup();",
  "      resolve({ ok: false, error: event.message || \"Transform worker crashed.\", logs: [] });",
  "    };",
  "",
  "    worker.postMessage({ source: normalizeSource(decodeUtf8Base64(sourceBase64)), input: structuredClone(input) });",
  "  });",
  "};",
  "})();",
].join("\n");

export interface TrmnlTransformRunResult {
  data: unknown;
  logs: string[];
}

export interface TrmnlTransformRunnerHandle {
  run: (script: string, input: Record<string, unknown>, timeoutMs: number) => Promise<TrmnlTransformRunResult>;
  dispose: () => Promise<void>;
}

interface RunnerPageResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  logs?: Array<{ level?: string; message?: string }>;
}

export async function createTrmnlTransformRunner(): Promise<TrmnlTransformRunnerHandle> {
  const runnerWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  await runnerWindow.loadURL(RUNNER_PAGE_URL);
  await runnerWindow.webContents.executeJavaScript(RUNNER_BOOTSTRAP_SCRIPT, true);

  return {
    run: async (script: string, input: Record<string, unknown>, timeoutMs: number) => {
      const sourceBase64 = Buffer.from(script, "utf8").toString("base64");
      const payload = (await runnerWindow.webContents.executeJavaScript(
        `window.__matterkioskRunTransform(${JSON.stringify(sourceBase64)}, ${JSON.stringify(input)}, ${Math.max(1000, timeoutMs)})`,
        true,
      )) as RunnerPageResult;

      if (!payload.ok) {
        throw new Error(payload.error || "Transform execution failed.");
      }

      return {
        data: payload.result,
        logs: (payload.logs ?? []).map((entry) => {
          const level = entry.level ? `[${entry.level}] ` : "";
          return `${level}${entry.message ?? ""}`.trim();
        }),
      };
    },
    dispose: async () => {
      if (!runnerWindow.isDestroyed()) {
        runnerWindow.destroy();
      }
    },
  };
}