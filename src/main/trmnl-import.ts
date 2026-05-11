import path from "node:path";
import JSZip from "jszip";
import { load as loadYaml } from "js-yaml";
import { ImportedTrmnlTarget, TrmnlDashboardConfig, TrmnlPollExchange } from "../shared/types";

const RECIPE_PATH_PATTERN = /\/recipes\/(?<id>\d+)(?:\/|$)/;
const ARCHIVE_PATH_PATTERN = /\/api\/plugin_settings\/(?<id>\d+)\/archive(?:\/|$)/;

const DEFAULT_LAYOUT = `<div class="{{extension.css_classes}}">
  <div class="view view--full">
    %CONTENT%
  </div>
</div>`;

interface ParsedRecipeSource {
  recipeId: string;
  source: string;
  archiveCandidates: string[];
}

type ArchiveFiles = Record<string, string>;

export async function importTrmnlRecipe(source: string): Promise<ImportedTrmnlTarget> {
  const parsed = parseRecipeSource(source);
  const { archive, archiveUrl } = await downloadRecipeArchive(parsed);
  const settings = parseRecipeSettings(archive);

  const fields = Array.isArray(settings["custom_fields"]) ? settings["custom_fields"] : [];
  const data = buildImportedData(fields, settings["static_data"]);
  const polling = buildPollingConfig(settings, fields, data);

  const trmnl: TrmnlDashboardConfig = {
    template: buildTemplate(archive),
    data: JSON.stringify(data, null, 2),
    fields: fields.length > 0 ? JSON.stringify(fields, null, 2) : undefined,
    assetMode: "cached",
    importSource: {
      kind: "recipe",
      recipeId: parsed.recipeId,
      source: parsed.source,
      archiveUrl,
      importedAt: new Date().toISOString(),
    },
    polling,
  };

  return {
    name: readNonEmptyString(settings["name"]) ?? `TRMNL Recipe ${parsed.recipeId}`,
    trmnl,
  };
}

function parseRecipeSource(source: string): ParsedRecipeSource {
  const trimmed = source.trim();
  if (!trimmed) {
    throw new Error("Enter a TRMNL recipe URL, recipe ID, or archive URL.");
  }

  if (/^\d+$/.test(trimmed)) {
    return {
      recipeId: trimmed,
      source: trimmed,
      archiveCandidates: defaultArchiveCandidates(trimmed),
    };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Recipe source must be a TRMNL recipe URL, recipe ID, or archive URL.");
  }

  const recipeMatch = url.pathname.match(RECIPE_PATH_PATTERN);
  const archiveMatch = url.pathname.match(ARCHIVE_PATH_PATTERN);
  const recipeId = recipeMatch?.groups?.["id"] ?? archiveMatch?.groups?.["id"];
  if (!recipeId) {
    throw new Error("Could not determine a TRMNL recipe ID from that source.");
  }

  const directArchiveUrl = archiveMatch ? url.toString() : undefined;
  const archiveCandidates = new Set<string>();
  if (directArchiveUrl) {
    archiveCandidates.add(directArchiveUrl);
  }
  archiveCandidates.add(new URL(`/api/plugin_settings/${recipeId}/archive`, url.origin).toString());
  for (const candidate of defaultArchiveCandidates(recipeId)) {
    archiveCandidates.add(candidate);
  }

  return {
    recipeId,
    source: trimmed,
    archiveCandidates: Array.from(archiveCandidates),
  };
}

function defaultArchiveCandidates(recipeId: string): string[] {
  return [
    `https://usetrmnl.com/api/plugin_settings/${recipeId}/archive`,
    `https://trmnl.com/api/plugin_settings/${recipeId}/archive`,
  ];
}

async function downloadRecipeArchive(parsed: ParsedRecipeSource): Promise<{
  archive: ArchiveFiles;
  archiveUrl: string;
}> {
  const failures: string[] = [];

  for (const archiveUrl of parsed.archiveCandidates) {
    try {
      const response = await fetch(archiveUrl, {
        headers: {
          accept: "application/zip, application/octet-stream;q=0.9, */*;q=0.1",
        },
      });
      if (!response.ok) {
        failures.push(`${archiveUrl} (${response.status})`);
        continue;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      return {
        archive: await readArchive(buffer),
        archiveUrl,
      };
    } catch (error) {
      failures.push(`${archiveUrl} (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  throw new Error(`Unable to download TRMNL recipe archive. Tried: ${failures.join(", ")}`);
}

async function readArchive(buffer: Buffer): Promise<ArchiveFiles> {
  const zip = await JSZip.loadAsync(buffer);
  const archive: ArchiveFiles = {};

  await Promise.all(
    Object.values(zip.files)
      .filter((entry) => !entry.dir)
      .map(async (entry) => {
        const extension = path.extname(entry.name);
        const baseName = path.basename(entry.name, extension).toLowerCase();
        archive[baseName] = await entry.async("string");
      }),
  );

  return archive;
}

function parseRecipeSettings(archive: ArchiveFiles): Record<string, unknown> {
  if (archive["transform"]) {
    throw new Error("This recipe uses a server-side transform, which MatterKiosk does not support yet.");
  }

  const rawSettings = archive["settings"];
  if (!rawSettings) {
    throw new Error("The recipe archive is missing settings.yml.");
  }

  const parsed = loadYaml(rawSettings);
  if (!isRecord(parsed)) {
    throw new Error("The recipe settings could not be parsed.");
  }

  return parsed;
}

function buildImportedData(fields: unknown[], rawStaticData: unknown): Record<string, unknown> {
  const staticData = isRecord(rawStaticData) ? { ...rawStaticData } : {};
  const defaults = buildFieldDefaults(fields);
  const explicitValues = isRecord(staticData["values"]) ? staticData["values"] : {};
  const values = {
    ...defaults,
    ...explicitValues,
  };

  if (Object.keys(values).length > 0) {
    staticData["values"] = values;
  }

  return staticData;
}

function buildFieldDefaults(fields: unknown[]): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};

  for (const field of fields) {
    if (!isRecord(field)) {
      continue;
    }

    const keyname = readNonEmptyString(field["keyname"]);
    if (!keyname || !("default" in field)) {
      continue;
    }

    defaults[keyname] = field["default"];
  }

  return defaults;
}

function buildPollingConfig(
  settings: Record<string, unknown>,
  fields: unknown[],
  data: Record<string, unknown>,
): TrmnlDashboardConfig["polling"] {
  const strategy = readNonEmptyString(settings["strategy"]);
  if (strategy !== "polling") {
    return undefined;
  }

  const rawTemplates = readNonEmptyString(settings["polling_url"]);
  const templates = splitPollTemplates(rawTemplates);
  if (templates.length === 0) {
    return undefined;
  }

  const headers = coerceHeaderRecord(settings["polling_headers"]);
  const bodyTemplate = coerceBodyTemplate(settings["polling_body"]);
  const method = readNonEmptyString(settings["polling_verb"])?.toUpperCase() ?? "GET";
  const intervalSeconds = Math.max(1, readInteger(settings["refresh_interval"]) ?? 60);

  const exchanges: TrmnlPollExchange[] = templates.map((urlTemplate, index) => ({
    id: `source-${index + 1}`,
    label: `Source ${index + 1}`,
    urlTemplate: transformTemplateKeys(urlTemplate),
    method,
    headers,
    bodyTemplate,
    format: "auto",
  }));

  const defaults = buildFieldDefaults(fields);
  if (Object.keys(defaults).length > 0 && !isRecord(data["values"])) {
    data["values"] = defaults;
  }

  return {
    enabled: true,
    intervalSeconds,
    exchanges,
  };
}

function splitPollTemplates(content: string | undefined): string[] {
  if (!content) {
    return [];
  }

  const trimmed = content.trim();
  if (!trimmed) {
    return [];
  }

  if (/\{\{.+\}\}/ms.test(trimmed)) {
    return [trimmed];
  }

  return trimmed.split(/\r\n|\n|\r|\s+/).map((item) => item.trim()).filter(Boolean);
}

function coerceHeaderRecord(value: unknown): Record<string, string> {
  if (!value) {
    return {};
  }

  if (isRecord(value)) {
    return Object.entries(value).reduce<Record<string, string>>((all, [key, entryValue]) => {
      if (typeof entryValue === "string") {
        all[key] = entryValue;
      }
      return all;
    }, {});
  }

  if (typeof value === "string") {
    const params = new URLSearchParams(value);
    const headers: Record<string, string> = {};
    for (const [key, entryValue] of params.entries()) {
      headers[key] = entryValue;
    }
    return headers;
  }

  return {};
}

function coerceBodyTemplate(value: unknown): string | undefined {
  if (!value) {
    return undefined;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (typeof value === "object") {
    return JSON.stringify(value, null, 2);
  }

  return undefined;
}

function buildTemplate(archive: ArchiveFiles): string {
  const full = archive["full"]?.trim();
  if (!full) {
    throw new Error("The recipe archive is missing its main Liquid template.");
  }

  const shared = archive["shared"]?.trim();
  const wrapped = DEFAULT_LAYOUT.replace("%CONTENT%", full);
  return transformTemplateKeys([shared, wrapped].filter(Boolean).join("\n\n"));
}

function transformTemplateKeys(content: string): string {
  return content
    .replace(/IDX_(\d+)/g, (_match, index: string) => `source_${Number(index) + 1}`)
    .replaceAll("source_1.data", "source_1")
    .replaceAll("trmnl.plugin_settings.instance_name", "extension.label")
    .replaceAll("trmnl.plugin_settings.custom_fields_values", "extension.values")
    .replaceAll("trmnl.plugin_settings.custom_fields", "extension.fields")
    .replaceAll("rss.", "source_1.rss.");
}

function readInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}