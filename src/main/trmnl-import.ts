import path from "node:path";
import JSZip from "jszip";
import { load as loadYaml } from "js-yaml";
import {
  ImportedTrmnlTarget,
  TrmnlCustomField,
  TrmnlCustomFieldOption,
  TrmnlDashboardConfig,
  TrmnlPollExchange,
  TrmnlTransformConfig,
} from "../shared/types";

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

  const fields = normalizeCustomFields(Array.isArray(settings["custom_fields"]) ? settings["custom_fields"] : []);
  const data = buildImportedData(fields, settings["static_data"]);
  const transform = buildTransformConfig(archive, settings);
  const polling = transform ? undefined : buildPollingConfig(settings, fields, data);

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
    transform,
    darkMode: settings["dark_mode"] === "yes" ? true : undefined,
    noScreenPadding: settings["no_screen_padding"] === "yes" ? true : undefined,
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

function buildTransformConfig(
  archive: ArchiveFiles,
  settings: Record<string, unknown>,
): TrmnlTransformConfig | undefined {
  const script = archive["transform"]?.trim();
  if (!script) {
    return undefined;
  }

  return {
    enabled: true,
    intervalSeconds: Math.max(1, readInteger(settings["refresh_interval"]) ?? 60),
    timeoutMs: 15_000,
    script,
  };
}

function buildImportedData(fields: TrmnlCustomField[], rawStaticData: unknown): Record<string, unknown> {
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

function buildFieldDefaults(fields: TrmnlCustomField[]): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};

  for (const field of fields) {
    if (!("default" in field) || field.default === undefined) {
      continue;
    }

    defaults[field.keyname] = field.default;
  }

  return defaults;
}

function buildPollingConfig(
  settings: Record<string, unknown>,
  fields: TrmnlCustomField[],
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

function normalizeCustomFields(fields: unknown[]): TrmnlCustomField[] {
  return fields
    .map((field) => normalizeCustomField(field))
    .filter((field): field is TrmnlCustomField => field !== null);
}

function normalizeCustomField(value: unknown): TrmnlCustomField | null {
  if (!isRecord(value)) {
    return null;
  }

  const keyname = readNonEmptyString(value["keyname"]);
  const name = readNonEmptyString(value["name"]);
  const fieldType = readNonEmptyString(value["field_type"]);
  if (!keyname || !name || !fieldType) {
    return null;
  }

  const options = normalizeCustomFieldOptions(value["options"]);
  const normalized: TrmnlCustomField = {
    keyname,
    name,
    field_type: fieldType,
    description: readNonEmptyString(value["description"]),
    help_text: readNonEmptyString(value["help_text"]),
    placeholder: readNonEmptyString(value["placeholder"]),
    default: normalizeCustomFieldDefault(value["default"], value["multiple"] === true),
    optional: value["optional"] === true,
    category: readNonEmptyString(value["category"]),
    group: readNonEmptyString(value["group"]),
    multiple: value["multiple"] === true,
  };

  if (options.length > 0) {
    normalized.options = options;
  }

  const fieldValue = readNonEmptyString(value["value"]);
  if (fieldValue !== undefined) normalized.value = fieldValue;

  const rows = readPositiveInt(value["rows"]);
  if (rows !== undefined) normalized.rows = rows;

  const min = readFiniteNumber(value["min"]);
  if (min !== undefined) normalized.min = min;

  const max = readFiniteNumber(value["max"]);
  if (max !== undefined) normalized.max = max;

  const step = readFiniteNumber(value["step"]);
  if (step !== undefined) normalized.step = step;

  const maxlength = readPositiveInt(value["maxlength"]);
  if (maxlength !== undefined) normalized.maxlength = maxlength;

  return normalized;
}

function normalizeCustomFieldOptions(value: unknown): TrmnlCustomFieldOption[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => normalizeCustomFieldOption(entry))
    .filter((entry): entry is TrmnlCustomFieldOption => entry !== null);
}

function normalizeCustomFieldOption(value: unknown): TrmnlCustomFieldOption | null {
  if (typeof value === "string") {
    return {
      label: value,
      value: parameterizeOptionValue(value),
    };
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return {
      label: String(value),
      value: String(value),
    };
  }

  if (!isRecord(value)) {
    return null;
  }

  const entries = Object.entries(value);
  if (entries.length !== 1) {
    return null;
  }

  const [label, optionValue] = entries[0];
  return {
    label,
    value: String(optionValue),
  };
}

function normalizeCustomFieldDefault(value: unknown, isMultiple: boolean): TrmnlCustomField["default"] {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry));
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return isMultiple ? [String(value)] : value;
  }

  return undefined;
}

function parameterizeOptionValue(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || value.trim();
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

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readPositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.round(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}