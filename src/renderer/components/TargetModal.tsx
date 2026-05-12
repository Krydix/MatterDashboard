import React, { useState } from "react";
import {
  DashboardProvider,
  KioskTarget,
  TrmnlCustomField,
  TrmnlCustomFieldOption,
  TrmnlDashboardConfig,
} from "../../shared/types";
import "./TargetModal.css";

const DEFAULT_TRMNL_TEMPLATE = `<div class="screen">
  <div class="view view--full">
    <div class="layout layout--col gap--space-between">
      <div class="markdown">
        <span class="title">{{ title }}</span>
        <div class="content content--center">{{ body }}</div>
        <span class="label label--underline">{{ footer }}</span>
      </div>
    </div>
  </div>
</div>`;

const DEFAULT_TRMNL_DATA = JSON.stringify(
  {
    title: "MatterKiosk",
    body: "Native TRMNL runtime",
    footer: "Edit this template and JSON data",
  },
  null,
  2,
);

const TIME_ZONES: string[] = (() => {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return [];
  }
})();

interface Props {
  initial: KioskTarget;
  onSave: (target: KioskTarget) => void;
  onCancel: () => void;
}

export default function TargetModal({ initial, onSave, onCancel }: Props): React.ReactElement {
  const [target, setTarget] = useState<KioskTarget>({ ...initial });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [recipeSource, setRecipeSource] = useState(initial.trmnl?.importSource?.source ?? "");
  const [importing, setImporting] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [importError, setImportError] = useState("");

  function update<K extends keyof KioskTarget>(key: K, value: KioskTarget[K]) {
    setTarget((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => ({ ...prev, [key]: "" }));
  }

  function updateProvider(provider: DashboardProvider) {
    setTarget((prev) => ({
      ...prev,
      provider,
      trmnl: provider === "trmnl" ? ensureTrmnlConfig(prev.trmnl) : prev.trmnl,
    }));
    setErrors({});
  }

  function updateTrmnl<K extends keyof TrmnlDashboardConfig>(
    key: K,
    value: TrmnlDashboardConfig[K],
  ) {
    setTarget((prev) => ({
      ...prev,
      trmnl: {
        ...ensureTrmnlConfig(prev.trmnl),
        [key]: value,
      },
    }));
    setErrors((prev) => ({ ...prev, [key]: "" }));
  }

  function validate(): boolean {
    const newErrors: Record<string, string> = {};
    if (!target.name.trim()) newErrors["name"] = "Name is required";
    if (target.provider === "url") {
      if (!target.url.trim()) {
        newErrors["url"] = "URL is required";
      } else {
        try {
          new URL(target.url);
        } catch {
          newErrors["url"] = "Enter a valid URL (e.g. https://example.com)";
        }
      }
    } else {
      const trmnl = ensureTrmnlConfig(target.trmnl);
      if (!trmnl.importSource) {
        newErrors["recipe"] = "Import a TRMNL recipe to continue";
      } else {
        const customFields = parseCustomFields(trmnl.fields);
        const fieldValues = parseDataValues(trmnl.data);
        for (const field of customFields) {
          if (
            field.field_type === "author_bio" ||
            field.field_type === "boolean" ||
            field.field_type === "copyable" ||
            field.field_type === "copyable_webhook_url" ||
            field.field_type === "plugin_instance_select" ||
            field.optional
          ) continue;
          if (!hasFieldValue(fieldValues[field.keyname], field.multiple)) {
            newErrors[`rf-${field.keyname}`] = `${field.name} is required`;
          }
        }
      }
    }
    if (target.durationSeconds < 1) newErrors["durationSeconds"] = "Must be at least 1 second";
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }

  async function handleImportRecipe() {
    const source = recipeSource.trim();
    if (!source) {
      setImportError("Recipe URL or ID is required");
      return;
    }

    setImporting(true);
    setImportError("");
    try {
      const imported = await window.matterkiosk.importTrmnlRecipe(source);
      setTarget((prev) => ({
        ...prev,
        name: imported.name,
        provider: "trmnl",
        trmnl: {
          ...ensureTrmnlConfig(prev.trmnl),
          ...imported.trmnl,
        },
      }));
      setRecipeSource(imported.trmnl.importSource?.source ?? source);
      setErrors({});
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error));
    } finally {
      setImporting(false);
    }
  }

  async function handleBrowseRecipes() {
    setBrowsing(true);
    setImportError("");
    try {
      const url = await window.matterkiosk.browseRecipes();
      if (!url) return; // user closed the browser without picking
      setRecipeSource(url);
      // Auto-import immediately
      setImporting(true);
      try {
        const imported = await window.matterkiosk.importTrmnlRecipe(url);
        setTarget((prev) => ({
          ...prev,
          name: imported.name,
          provider: "trmnl",
          trmnl: {
            ...ensureTrmnlConfig(prev.trmnl),
            ...imported.trmnl,
          },
        }));
        setRecipeSource(imported.trmnl.importSource?.source ?? url);
        setErrors({});
      } catch (error) {
        setImportError(error instanceof Error ? error.message : String(error));
      } finally {
        setImporting(false);
      }
    } finally {
      setBrowsing(false);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) {
      return;
    }

    onSave({
      ...target,
      trmnl: target.provider === "trmnl" ? ensureTrmnlConfig(target.trmnl) : target.trmnl,
    });
  }

  const trmnl = ensureTrmnlConfig(target.trmnl);
  const customFields = parseCustomFields(trmnl.fields);
  const isRecipeMode = !!trmnl.importSource && customFields.some((f) => f.field_type !== "author_bio");
  const fieldValues = parseDataValues(trmnl.data);

  function handleFieldChange(keyname: string, value: string | string[] | boolean) {
    updateTrmnl("data", setDataValue(trmnl.data, keyname, value));
    setErrors((prev) => ({ ...prev, [`rf-${keyname}`]: "" }));
  }

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">{initial.name ? "Edit Dashboard" : "Add Dashboard"}</h2>
        <form onSubmit={handleSubmit} className="modal-form">
          <div className="field">
            <label htmlFor="name">Name</label>
            <input
              id="name"
              type="text"
              placeholder="e.g. Weather, Grafana, Home Assistant"
              value={target.name}
              onChange={(e) => update("name", e.target.value)}
              autoFocus
            />
            {errors["name"] && <span className="field-error">{errors["name"]}</span>}
          </div>

          <div className="field">
            <label htmlFor="provider">Dashboard Type</label>
            <select
              id="provider"
              value={target.provider}
              onChange={(e) => updateProvider(e.target.value as DashboardProvider)}
            >
              <option value="url">Web URL</option>
              <option value="trmnl">Native TRMNL Runtime</option>
            </select>
          </div>

          {target.provider === "url" ? (
            <div className="field">
              <label htmlFor="url">URL</label>
              <input
                id="url"
                type="text"
                placeholder="https://..."
                value={target.url}
                onChange={(e) => update("url", e.target.value)}
              />
              {errors["url"] && <span className="field-error">{errors["url"]}</span>}
            </div>
          ) : (
            <>
              <div className="field recipe-import-field">
                <div className="import-row">
                  <input
                    id="recipe-source"
                    type="text"
                    placeholder="Recipe URL or ID, e.g. trmnl.com/recipes/123456"
                    value={recipeSource}
                    onChange={(e) => setRecipeSource(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void handleImportRecipe(); } }}
                  />
                  <button
                    type="button"
                    className="secondary import-button"
                    onClick={handleImportRecipe}
                    disabled={importing || browsing}
                  >
                    {importing ? "Importing…" : trmnl.importSource ? "Re-import" : "Import"}
                  </button>
                  <button
                    type="button"
                    className="secondary import-button"
                    onClick={handleBrowseRecipes}
                    disabled={importing || browsing}
                    title="Browse the TRMNL recipe gallery"
                  >
                    {browsing ? "Browsing…" : "Browse"}
                  </button>
                </div>
                {importError && <span className="field-error">{importError}</span>}
                {errors["recipe"] && <span className="field-error">{errors["recipe"]}</span>}
                {trmnl.importSource && (
                  <span className="field-help">
                    Recipe #{trmnl.importSource.recipeId}
                    {trmnl.polling?.enabled && ` · polls every ${trmnl.polling.intervalSeconds}s`}
                    {trmnl.transform?.enabled && ` · transform every ${trmnl.transform.intervalSeconds}s`}
                  </span>
                )}
              </div>

              {isRecipeMode && (
                <div className="recipe-config">
                  {customFields.map((field) => {
                    if (field.field_type === "author_bio") {
                      return (
                        <div key={field.keyname} className="recipe-bio">
                          {field.description ?? field.name}
                        </div>
                      );
                    }
                    const value = fieldValues[field.keyname] ?? field.default ?? (field.multiple ? [] : "");
                    const errorKey = `rf-${field.keyname}`;
                    return (
                      <div key={field.keyname} className="field">
                        <label htmlFor={`rf-${field.keyname}`}>
                          {field.name}
                          {field.optional && (
                            <span className="field-optional"> (optional)</span>
                          )}
                        </label>
                    {renderFieldInput(
                      field,
                      value,
                      `rf-${field.keyname}`,
                      (v) => handleFieldChange(field.keyname, v),
                    )}
                        {field.description && (
                          <span className="field-help">{field.description}</span>
                        )}
                        {field.help_text && (
                          <span className="field-help" dangerouslySetInnerHTML={{ __html: field.help_text }} />
                        )}
                        {field.field_type === "multi_string" && (
                          <span className="field-help">Separate multiple values with commas.</span>
                        )}
                        {errors[errorKey] && (
                          <span className="field-error">{errors[errorKey]}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}

          <div className="field">
            <label htmlFor="duration">Display Duration (seconds)</label>
            <input
              id="duration"
              type="number"
              min={1}
              max={3600}
              value={target.durationSeconds}
              onChange={(e) => update("durationSeconds", Math.max(1, parseInt(e.target.value) || 1))}
            />
            {errors["durationSeconds"] && (
              <span className="field-error">{errors["durationSeconds"]}</span>
            )}
          </div>

          <div className="field field-row">
            <label className="toggle" htmlFor="enabled">
              <input
                id="enabled"
                type="checkbox"
                checked={target.enabled}
                onChange={(e) => update("enabled", e.target.checked)}
              />
              <span className="toggle-slider" />
            </label>
            <span style={{ marginLeft: 10, color: "var(--text-muted)" }}>
              Enabled (exposed as Matter device)
            </span>
          </div>

          {target.provider === "trmnl" && (
            <div className="field field-row">
              <label className="toggle" htmlFor="borderless">
                <input
                  id="borderless"
                  type="checkbox"
                  checked={target.borderless ?? true}
                  onChange={(e) => update("borderless", e.target.checked)}
                />
                <span className="toggle-slider" />
              </label>
              <span style={{ marginLeft: 10, color: "var(--text-muted)" }}>
                Fill screen (stretch to full window, no letterbox border)
              </span>
            </div>
          )}

          <div className="modal-actions">
            <button type="button" className="secondary" onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" className="primary">
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ensureTrmnlConfig(config: KioskTarget["trmnl"]): TrmnlDashboardConfig {
  return {
    template: config?.template ?? DEFAULT_TRMNL_TEMPLATE,
    data: config?.data ?? DEFAULT_TRMNL_DATA,
    fields: config?.fields,
    assetMode: config?.assetMode ?? "cached",
    cssUrl: config?.cssUrl,
    jsUrl: config?.jsUrl,
    importSource: config?.importSource,
    polling: config?.polling,
    transform: config?.transform,
    darkMode: config?.darkMode,
    noScreenPadding: config?.noScreenPadding,
  };
}

function parseCustomFields(fieldsJson: string | undefined): TrmnlCustomField[] {
  if (!fieldsJson) return [];
  try {
    const parsed = JSON.parse(fieldsJson);
    return Array.isArray(parsed)
      ? parsed
          .map((field) => normalizeCustomField(field))
          .filter((field): field is TrmnlCustomField => field !== null)
      : [];
  } catch {
    return [];
  }
}

function parseDataValues(dataJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(dataJson) as Record<string, unknown>;
    const values = parsed?.["values"];
    if (values && typeof values === "object" && !Array.isArray(values)) {
      return values as Record<string, unknown>;
    }
  } catch {
    /* ignore parse errors */
  }
  return {};
}

function setDataValue(dataJson: string, key: string, value: string | string[] | boolean): string {
  try {
    const parsed = JSON.parse(dataJson) as Record<string, unknown>;
    const values = (parsed["values"] ?? {}) as Record<string, unknown>;
    values[key] = value;
    parsed["values"] = values;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return dataJson;
  }
}

function hasFieldValue(value: unknown, isMultiple = false): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => String(entry).trim().length > 0);
  }

  if (isMultiple && typeof value === "string") {
    return value.split(",").some((entry) => entry.trim().length > 0);
  }

  return String(value ?? "").trim().length > 0;
}

function coerceSingleValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.length > 0 ? String(value[0]) : "";
  }

  return String(value ?? "");
}

function coerceMultiSelectValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry));
  }

  if (typeof value === "string" && value.trim().length > 0) {
    return value.split(",").map((entry) => entry.trim()).filter(Boolean);
  }

  return [];
}

function readSelectedValues(select: HTMLSelectElement): string[] {
  return Array.from(select.selectedOptions).map((option) => option.value);
}

function normalizeCustomField(value: unknown): TrmnlCustomField | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const keyname = readNonEmptyString(raw["keyname"]);
  const name = readNonEmptyString(raw["name"]);
  const fieldType = readNonEmptyString(raw["field_type"]);
  if (!keyname || !name || !fieldType) {
    return null;
  }

  const normalized: TrmnlCustomField = {
    keyname,
    name,
    field_type: fieldType,
    description: readNonEmptyString(raw["description"]),
    help_text: readNonEmptyString(raw["help_text"]),
    placeholder: readNonEmptyString(raw["placeholder"]),
    default: normalizeFieldDefault(raw["default"], raw["multiple"] === true),
    optional: raw["optional"] === true,
    category: readNonEmptyString(raw["category"]),
    group: readNonEmptyString(raw["group"]),
    multiple: raw["multiple"] === true,
    rows: typeof raw["rows"] === "number" && raw["rows"] > 0 ? Math.round(raw["rows"]) : undefined,
    min: typeof raw["min"] === "number" && Number.isFinite(raw["min"]) ? raw["min"] : undefined,
    max: typeof raw["max"] === "number" && Number.isFinite(raw["max"]) ? raw["max"] : undefined,
    step: typeof raw["step"] === "number" && Number.isFinite(raw["step"]) ? raw["step"] : undefined,
    maxlength: typeof raw["maxlength"] === "number" && raw["maxlength"] > 0 ? Math.round(raw["maxlength"]) : undefined,
    value: readNonEmptyString(raw["value"]),
  };

  const options = normalizeCustomFieldOptions(raw["options"]);
  if (options.length > 0) {
    normalized.options = options;
  }

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

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const obj = value as Record<string, unknown>;

  // Already-normalized { label, value } object (stored from a previous import)
  if (typeof obj["label"] === "string" && typeof obj["value"] === "string") {
    return { label: obj["label"], value: obj["value"] };
  }

  // TRMNL raw format: single-entry { "Label": "value" } object
  const entries = Object.entries(obj);
  if (entries.length !== 1) {
    return null;
  }

  const [label, optionValue] = entries[0];
  return {
    label,
    value: String(optionValue),
  };
}

function normalizeFieldDefault(value: unknown, isMultiple: boolean): TrmnlCustomField["default"] {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry));
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return isMultiple ? [String(value)] : value;
  }

  return undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parameterizeOptionValue(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || value.trim();
}

function renderFieldInput(
  field: TrmnlCustomField,
  value: unknown,
  id: string,
  onChange: (v: string | string[] | boolean) => void,
): React.ReactNode {
  const ft = field.field_type;

  // select / xhrSelect with pre-loaded options
  if ((ft === "select" || ft === "xhrSelect" || ft === "xhrSelectSearch") && field.options && field.options.length > 0) {
    if (field.multiple) {
      // Checkbox list for multi-select
      const selected = coerceMultiSelectValue(value);
      return (
        <div className="field-checkbox-list" role="group" aria-labelledby={id}>
          {field.options.map((opt) => {
            const checked = selected.includes(opt.value);
            const inputId = `${id}-${opt.value}`;
            return (
              <label key={opt.value} className="field-checkbox-item">
                <input
                  type="checkbox"
                  id={inputId}
                  value={opt.value}
                  checked={checked}
                  onChange={() => {
                    const next = checked
                      ? selected.filter((v) => v !== opt.value)
                      : [...selected, opt.value];
                    onChange(next);
                  }}
                />
                {opt.label}
              </label>
            );
          })}
        </div>
      );
    }

    return (
      <select
        id={id}
        value={coerceSingleValue(value)}
        onChange={(e) => onChange(e.target.value)}
      >
        {field.options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    );
  }

  // boolean — checkbox
  if (ft === "boolean") {
    return (
      <input
        type="checkbox"
        id={id}
        className="field-checkbox"
        checked={value === true || String(value) === "true"}
        onChange={(e) => onChange(e.target.checked)}
      />
    );
  }

  // textarea types
  if (ft === "text" || ft === "code") {
    return (
      <textarea
        id={id}
        className={ft === "code" ? "field-code" : undefined}
        rows={field.rows ?? 3}
        placeholder={field.placeholder ?? ""}
        value={coerceSingleValue(value)}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  // number
  if (ft === "number") {
    return (
      <input
        type="number"
        id={id}
        placeholder={field.placeholder ?? ""}
        value={coerceSingleValue(value)}
        min={field.min}
        max={field.max}
        step={field.step}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  // password
  if (ft === "password") {
    return (
      <input
        type="password"
        id={id}
        placeholder={field.placeholder ?? ""}
        value={coerceSingleValue(value)}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  // url
  if (ft === "url") {
    return (
      <input
        type="url"
        id={id}
        placeholder={field.placeholder ?? "https://"}
        value={coerceSingleValue(value)}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  // date
  if (ft === "date") {
    return (
      <input
        type="date"
        id={id}
        value={coerceSingleValue(value)}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  // time
  if (ft === "time") {
    return (
      <input
        type="time"
        id={id}
        value={coerceSingleValue(value)}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  // time_zone — select populated from Intl (or text fallback)
  if (ft === "time_zone") {
    if (TIME_ZONES.length > 0) {
      return (
        <select
          id={id}
          value={coerceSingleValue(value)}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">— Select timezone —</option>
          {TIME_ZONES.map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </select>
      );
    }
    return (
      <input
        type="text"
        id={id}
        placeholder="e.g. America/New_York"
        value={coerceSingleValue(value)}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  // copyable / copyable_webhook_url — read-only display
  if (ft === "copyable" || ft === "copyable_webhook_url") {
    const displayValue = ft === "copyable" ? (field.value ?? "") : "(generated by TRMNL)";
    return (
      <input
        type="text"
        id={id}
        readOnly
        value={displayValue}
        className="field-readonly"
      />
    );
  }

  // default: plain text (string, multi_string, xhrSelect/Search without options, etc.)
  return (
    <input
      type="text"
      id={id}
      placeholder={field.placeholder ?? ""}
      maxLength={field.maxlength}
      value={coerceSingleValue(value)}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
