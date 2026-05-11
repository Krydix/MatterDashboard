import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { XMLParser } from "fast-xml-parser";
import { Liquid } from "liquidjs";
import { KioskTarget, TrmnlAssetMode, TrmnlDashboardConfig, TrmnlPollExchange } from "../shared/types";
import { getRuntimeDir } from "./app-paths";

const DEFAULT_TRMNL_CSS_URL = "https://trmnl.com/css/latest/plugins.css";
const DEFAULT_TRMNL_JS_URL = "https://trmnl.com/js/latest/plugins.js";
const FRAMEWORK_CACHE_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7;

interface TrmnlRuntimeState {
  target: KioskTarget;
  renderPromise?: Promise<string>;
  refreshTimer?: NodeJS.Timeout;
  refreshIntervalMs?: number;
  exchangeData?: unknown[];
  exchangeErrors?: Record<string, string>;
  exchangeFetchedAt?: number;
}

const liquid = new Liquid({
  strictFilters: false,
  strictVariables: false,
});

const xmlParser = new XMLParser({
  attributeNamePrefix: "",
  ignoreAttributes: false,
  parseTagValue: true,
});

const runtimeStates = new Map<string, TrmnlRuntimeState>();

export async function resolveKioskTargetUrl(target: KioskTarget): Promise<string> {
  if (target.provider !== "trmnl") {
    return target.url;
  }

  return await renderTrmnlRuntime(target);
}

async function renderTrmnlRuntime(target: KioskTarget): Promise<string> {
  const state = runtimeStates.get(target.id) ?? { target };
  state.target = target;
  runtimeStates.set(target.id, state);

  if (!state.renderPromise) {
    state.renderPromise = buildTrmnlRuntimeUrl(state).finally(() => {
      const latest = runtimeStates.get(target.id);
      if (latest) {
        latest.renderPromise = undefined;
      }
    });
  }

  return await state.renderPromise;
}

async function buildTrmnlRuntimeUrl(state: TrmnlRuntimeState): Promise<string> {
  const target = state.target;
  const trmnl = target.trmnl;
  if (!trmnl || !trmnl.template.trim()) {
    throw new Error(`Target "${target.name}" is missing TRMNL template content.`);
  }

  const data = parseTrmnlData(target);
  const fields = parseTrmnlFields(target);
  const sources = await resolveExchangeSources(state, data, fields);
  const renderedMarkup = await liquid.parseAndRender(
    trmnl.template,
    buildLiquidScope(target, data, fields, sources, state.exchangeErrors ?? {}),
  );
  const assets = await resolveFrameworkAssets(trmnl);
  const refreshMs = getPollingRefreshMs(trmnl);
  const html = buildRuntimeDocument({
    title: target.name,
    cssUrl: assets.cssUrl,
    jsUrl: assets.jsUrl,
    markup: renderedMarkup,
    refreshMs,
  });

  const runtimeDir = path.join(getRuntimeDir(), "dashboards");
  mkdirSync(runtimeDir, { recursive: true });

  const filePath = path.join(runtimeDir, `${target.id}.html`);
  writeFileSync(filePath, html, "utf8");

  configureRefreshTimer(state, refreshMs);

  return pathToFileURL(filePath).toString();
}

async function resolveExchangeSources(
  state: TrmnlRuntimeState,
  data: unknown,
  fields: unknown[],
): Promise<unknown[]> {
  const polling = state.target.trmnl?.polling;
  if (!polling?.enabled || polling.exchanges.length === 0) {
    clearRefreshTimer(state);
    state.exchangeData = undefined;
    state.exchangeErrors = undefined;
    state.exchangeFetchedAt = undefined;
    return [];
  }

  const now = Date.now();
  const refreshMs = getPollingRefreshMs(state.target.trmnl);
  if (state.exchangeData && state.exchangeFetchedAt && now - state.exchangeFetchedAt < refreshMs) {
    return state.exchangeData;
  }

  const requestScope = buildLiquidScope(state.target, data, fields, [], state.exchangeErrors ?? {});
  const previousData = state.exchangeData ?? [];
  const nextData: unknown[] = [];
  const errors: Record<string, string> = {};

  await Promise.all(
    polling.exchanges.map(async (exchange, index) => {
      try {
        nextData[index] = await fetchExchangeSource(exchange, requestScope);
      } catch (error) {
        nextData[index] = previousData[index] ?? {};
        errors[`source_${index + 1}`] = error instanceof Error ? error.message : String(error);
      }
    }),
  );

  state.exchangeData = nextData;
  state.exchangeErrors = errors;
  state.exchangeFetchedAt = now;

  return nextData;
}

async function fetchExchangeSource(
  exchange: TrmnlPollExchange,
  scope: Record<string, unknown>,
): Promise<unknown> {
  const method = exchange.method.trim().toUpperCase() || "GET";
  const url = (await liquid.parseAndRender(exchange.urlTemplate, scope)).trim();
  if (!url) {
    throw new Error(`Exchange "${exchange.label}" resolved to an empty URL.`);
  }

  const headers = await renderExchangeHeaders(exchange.headers, scope);
  const body = method === "GET" ? undefined : await renderExchangeBody(exchange.bodyTemplate, scope);
  const response = await fetch(url, { method, headers, body });
  if (!response.ok) {
    throw new Error(`${exchange.label} returned ${response.status} ${response.statusText}`.trim());
  }

  const text = await response.text();
  return parseExchangePayload(text, response.headers.get("content-type"), exchange.format);
}

async function renderExchangeHeaders(
  headers: Record<string, string>,
  scope: Record<string, unknown>,
): Promise<Record<string, string>> {
  const rendered: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    rendered[key] = (await liquid.parseAndRender(value, scope)).trim();
  }
  return rendered;
}

async function renderExchangeBody(
  template: string | undefined,
  scope: Record<string, unknown>,
): Promise<string | undefined> {
  if (!template?.trim()) {
    return undefined;
  }

  const rendered = await liquid.parseAndRender(template, scope);
  return rendered.trim().length > 0 ? rendered : undefined;
}

function parseExchangePayload(
  payload: string,
  contentType: string | null,
  format: TrmnlPollExchange["format"],
): unknown {
  const normalizedFormat = format === "auto" ? inferExchangeFormat(payload, contentType) : format;

  if (normalizedFormat === "json") {
    return JSON.parse(payload);
  }

  if (normalizedFormat === "xml") {
    return xmlParser.parse(payload);
  }

  return payload;
}

function inferExchangeFormat(payload: string, contentType: string | null): "json" | "text" | "xml" {
  const type = contentType?.toLowerCase() ?? "";
  if (type.includes("json")) {
    return "json";
  }

  if (type.includes("xml") || type.includes("rss") || type.includes("atom")) {
    return "xml";
  }

  const trimmed = payload.trim();
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    return "json";
  }

  if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
    return "xml";
  }

  return "text";
}

function parseTrmnlData(target: KioskTarget): unknown {
  const raw = target.trmnl?.data?.trim();
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Target "${target.name}" has invalid TRMNL JSON data: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseTrmnlFields(target: KioskTarget): unknown[] {
  const raw = target.trmnl?.fields?.trim();
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    throw new Error(
      `Target "${target.name}" has invalid TRMNL field data: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function buildLiquidScope(
  target: KioskTarget,
  data: unknown,
  fields: unknown[],
  sources: unknown[],
  exchangeErrors: Record<string, string>,
): Record<string, unknown> {
  const objectData = isRecord(data) ? data : {};
  const fieldValues = buildFieldValues(fields, objectData);
  const resolvedSources = sources.length > 0 ? sources : [data];
  const sourceMap = resolvedSources.reduce<Record<string, unknown>>((all, entry, index) => {
    all[`source_${index + 1}`] = entry;
    return all;
  }, {});

  return {
    ...objectData,
    ...sourceMap,
    extension: {
      label: target.name,
      css_classes: "screen",
      data: objectData,
      fields,
      values: fieldValues,
    },
    matterkiosk: {
      target: {
        id: target.id,
        name: target.name,
      },
      exchange_errors: exchangeErrors,
    },
    trmnl: {
      plugin_settings: {
        instance_name: target.name,
        custom_fields: fields,
        custom_fields_values: fieldValues,
      },
    },
  };
}

function buildFieldValues(fields: unknown[], data: Record<string, unknown>): Record<string, unknown> {
  const defaults = fields.reduce<Record<string, unknown>>((all, field) => {
    if (!isRecord(field)) {
      return all;
    }

    const keyname = typeof field["keyname"] === "string" ? field["keyname"] : undefined;
    if (!keyname || !("default" in field)) {
      return all;
    }

    all[keyname] = field["default"];
    return all;
  }, {});

  const overrides = isRecord(data["values"]) ? data["values"] : {};
  return {
    ...defaults,
    ...overrides,
  };
}

function buildRuntimeDocument(input: {
  title: string;
  cssUrl: string;
  jsUrl: string;
  markup: string;
  refreshMs: number;
}): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(input.title)}</title>
    <link rel="stylesheet" href="${escapeAttribute(input.cssUrl)}" />
    <script src="${escapeAttribute(input.jsUrl)}"></script>
    <style>
      :root {
        color-scheme: light;
      }

      html,
      body {
        margin: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
        background: #ece8de;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      body.environment.trmnl {
        display: grid;
        place-items: center;
      }

      .matterkiosk-trmnl-stage {
        width: 800px;
        height: 480px;
        transform: scale(min(calc(100vw / 800), calc(100vh / 480)));
        transform-origin: center center;
      }
    </style>
    ${input.refreshMs > 0 ? `<script>window.setTimeout(() => window.location.reload(), ${input.refreshMs});</script>` : ""}
  </head>
  <body class="environment trmnl">
    <div class="matterkiosk-trmnl-stage">${input.markup}</div>
  </body>
</html>
`;
}

async function resolveFrameworkAssets(
  trmnl: TrmnlDashboardConfig,
): Promise<{ cssUrl: string; jsUrl: string }> {
  const assetMode = sanitizeAssetMode(trmnl.assetMode);
  const cssUrl = trmnl.cssUrl?.trim() || DEFAULT_TRMNL_CSS_URL;
  const jsUrl = trmnl.jsUrl?.trim() || DEFAULT_TRMNL_JS_URL;

  if (assetMode === "remote") {
    return { cssUrl, jsUrl };
  }

  return {
    cssUrl: await resolveCachedFrameworkAsset("css", cssUrl),
    jsUrl: await resolveCachedFrameworkAsset("js", jsUrl),
  };
}

async function resolveCachedFrameworkAsset(kind: "css" | "js", remoteUrl: string): Promise<string> {
  const extension = kind === "css" ? "css" : "js";
  const filePath = path.join(
    getRuntimeDir(),
    "trmnl-framework",
    `${kind}-${createHash("sha1").update(remoteUrl).digest("hex").slice(0, 12)}.${extension}`,
  );

  mkdirSync(path.dirname(filePath), { recursive: true });

  if (shouldRefreshCachedAsset(filePath)) {
    try {
      const response = await fetch(remoteUrl);
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`.trim());
      }

      writeFileSync(filePath, Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      if (!hasCachedFile(filePath)) {
        console.warn("[TRMNL] Falling back to remote framework asset:", error);
        return remoteUrl;
      }
    }
  }

  return pathToFileURL(filePath).toString();
}

function shouldRefreshCachedAsset(filePath: string): boolean {
  try {
    const stat = statSync(filePath);
    return Date.now() - stat.mtimeMs > FRAMEWORK_CACHE_MAX_AGE_MS;
  } catch {
    return true;
  }
}

function hasCachedFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function sanitizeAssetMode(mode: TrmnlAssetMode | undefined): TrmnlAssetMode {
  return mode === "remote" ? "remote" : "cached";
}

function getPollingRefreshMs(trmnl: TrmnlDashboardConfig | undefined): number {
  const intervalSeconds = trmnl?.polling?.enabled ? trmnl.polling.intervalSeconds : 0;
  return intervalSeconds > 0 ? intervalSeconds * 1000 : 0;
}

function configureRefreshTimer(state: TrmnlRuntimeState, refreshMs: number): void {
  if (refreshMs <= 0) {
    clearRefreshTimer(state);
    return;
  }

  if (state.refreshTimer && state.refreshIntervalMs === refreshMs) {
    return;
  }

  clearRefreshTimer(state);
  state.refreshIntervalMs = refreshMs;
  state.refreshTimer = setInterval(() => {
    void renderTrmnlRuntime(state.target).catch((error) => {
      console.warn(`[TRMNL] Failed to refresh ${state.target.name}:`, error);
    });
  }, refreshMs);
  state.refreshTimer.unref();
}

function clearRefreshTimer(state: TrmnlRuntimeState): void {
  if (state.refreshTimer) {
    clearInterval(state.refreshTimer);
    state.refreshTimer = undefined;
    state.refreshIntervalMs = undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}