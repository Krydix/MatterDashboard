import React, { useState } from "react";
import {
  AppTargetConfig,
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
  const [pickingApp, setPickingApp] = useState(false);

  function update<K extends keyof KioskTarget>(key: K, value: KioskTarget[K]) {
    setTarget((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => ({ ...prev, [key]: "" }));
  }

  function updateProvider(provider: DashboardProvider) {
    setTarget((prev) => ({
      ...prev,
      provider,
      app: provider === "app" ? ensureAppConfig(prev.app) : prev.app,
      trmnl: provider === "trmnl" ? ensureTrmnlConfig(prev.trmnl) : prev.trmnl,
    }));
    setErrors({});
  }

  async function handlePickApp() {
    setPickingApp(true);
    try {
      const picked = await window.matterkiosk.pickApp();
      if (!picked) return;
      const guessedName = picked.applicationName ?? picked.applicationPath.split("/").pop()?.replace(/\.app$/i, "") ?? "";
      setTarget((prev) => ({
        ...prev,
        name: prev.name.trim() ? prev.name : guessedName,
        app: {
          ...ensureAppConfig(prev.app),
          applicationName: picked.applicationName ?? undefined,
          bundleId: picked.bundleId ?? undefined,
          applicationPath: picked.applicationPath,
        },
      }));
      setErrors({});
    } finally {
      setPickingApp(false);
    }
  }

  function updateApp<K extends keyof AppTargetConfig>(key: K, value: AppTargetConfig[K]) {
    setTarget((prev) => ({
      ...prev,
      app: {
        ...ensureAppConfig(prev.app),
        [key]: value,
      },
    }));
    setErrors((prev) => ({ ...prev, app: "" }));
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
    if (
      target.brightnessPercent !== undefined &&
      (!Number.isFinite(target.brightnessPercent) || target.brightnessPercent < 0 || target.brightnessPercent > 100)
    ) {
      newErrors["brightnessPercent"] = "Brightness must be between 0 and 100";
    }
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
    } else if (target.provider === "trmnl") {
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
    } else {
      const appConfig = ensureAppConfig(target.app);
      if (!appConfig.applicationName && !appConfig.bundleId && !appConfig.applicationPath) {
        newErrors["app"] = "Provide an app name, bundle identifier, or application path";
      }
    }
    const isNoTimeout = target.provider === "app" && ensureAppConfig(target.app).noTimeout;
    if (!isNoTimeout && target.durationSeconds < 1) newErrors["durationSeconds"] = "Must be at least 1 second";
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
      url: target.provider === "url" ? target.url.trim() : "",
      app: target.provider === "app" ? ensureAppConfig(target.app) : undefined,
      trmnl: target.provider === "trmnl" ? ensureTrmnlConfig(target.trmnl) : undefined,
    });
  }

  const appConfig = ensureAppConfig(target.app);
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
        <h2 className="modal-title">{initial.name ? "Edit Target" : "Add Target"}</h2>
        <form onSubmit={handleSubmit} className="modal-form">
          <div className="field">
            <label htmlFor="name">Name</label>
            <input
              id="name"
              type="text"
              placeholder="e.g. Weather, Grafana, Kodi"
              value={target.name}
              onChange={(e) => update("name", e.target.value)}
              autoFocus
            />
            {errors["name"] && <span className="field-error">{errors["name"]}</span>}
          </div>

          <div className="field">
            <label htmlFor="brightness-percent">Launch Brightness Override</label>
            <input
              id="brightness-percent"
              type="number"
              min={0}
              max={100}
              placeholder="Leave blank to keep current brightness"
              value={target.brightnessPercent ?? ""}
              onChange={(e) => {
                const nextValue = e.target.value.trim();
                update(
                  "brightnessPercent",
                  nextValue.length > 0 ? Math.max(0, Math.min(100, Number(nextValue))) : undefined,
                );
              }}
            />
            <span className="field-help">
              Optional. When display brightness bridging is enabled, this target will request the selected display brightness before launch and restore it when the session ends.
            </span>
            {errors["brightnessPercent"] && <span className="field-error">{errors["brightnessPercent"]}</span>}
          </div>

          <div className="field">
            <label htmlFor="provider">Dashboard Type</label>
            <select
              id="provider"
              value={target.provider}
              onChange={(e) => updateProvider(e.target.value as DashboardProvider)}
            >
              <option value="url">Web URL</option>
              <option value="app">Native App</option>
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
          ) : target.provider === "trmnl" ? (
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
          ) : (
            <>
              {/* Picker button + picked-app card */}
              <div className="app-pick-row">
                <button
                  type="button"
                  className="secondary"
                  onClick={handlePickApp}
                  disabled={pickingApp}
                >
                  {pickingApp ? "Picking…" : "Browse Apps…"}
                </button>
                {!appConfig.applicationPath && !appConfig.applicationName && !appConfig.bundleId && (
                  <span className="app-pick-hint">or fill in the fields below manually</span>
                )}
              </div>

              {(appConfig.applicationPath || appConfig.applicationName || appConfig.bundleId) && (
                <div className="app-picked-card">
                  <div className="app-picked-title">
                    {appConfig.applicationName ?? appConfig.applicationPath?.split("/").pop()?.replace(/\.app$/i, "") ?? "App"}
                  </div>
                  {appConfig.bundleId && (
                    <div className="app-picked-meta">{appConfig.bundleId}</div>
                  )}
                  {appConfig.applicationPath && (
                    <div className="app-picked-meta app-picked-path">{appConfig.applicationPath}</div>
                  )}
                  <button
                    type="button"
                    className="app-picked-clear"
                    title="Clear"
                    onClick={() => {
                      setTarget((prev) => ({ ...prev, app: { arguments: prev.app?.arguments ?? [] } }));
                    }}
                  >
                    ✕
                  </button>
                </div>
              )}

              {errors["app"] && <span className="field-error">{errors["app"]}</span>}

              {/* Manual override fields */}
              <details className="app-manual-details">
                <summary>Manual override</summary>
                <div className="app-manual-fields">
                  <div className="field">
                    <label htmlFor="app-name">Application Name</label>
                    <input
                      id="app-name"
                      type="text"
                      placeholder="Kodi"
                      value={appConfig.applicationName ?? ""}
                      onChange={(e) => updateApp("applicationName", e.target.value || undefined as unknown as string)}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="app-bundle-id">Bundle Identifier</label>
                    <input
                      id="app-bundle-id"
                      type="text"
                      placeholder="tv.kodi.Kodi"
                      value={appConfig.bundleId ?? ""}
                      onChange={(e) => updateApp("bundleId", e.target.value || undefined as unknown as string)}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="app-path">Application Path</label>
                    <input
                      id="app-path"
                      type="text"
                      placeholder="/Applications/Kodi.app"
                      value={appConfig.applicationPath ?? ""}
                      onChange={(e) => updateApp("applicationPath", e.target.value || undefined as unknown as string)}
                    />
                  </div>
                </div>
              </details>

              {/* Launch arguments */}
              <div className="field">
                <div className="app-args-header">
                  <label htmlFor="app-arguments">Launch Arguments</label>
                  <div className="app-args-presets">
                    <span className="app-args-preset-label">Presets:</span>
                    <button
                      type="button"
                      className="app-preset-chip"
                      onClick={() => updateApp("arguments", ["-bigpicture"])}
                    >
                      Steam Big Picture
                    </button>
                    <button
                      type="button"
                      className="app-preset-chip"
                      onClick={() => updateApp("arguments", ["--fullscreen"])}
                    >
                      Fullscreen
                    </button>
                    <button
                      type="button"
                      className="app-preset-chip"
                      title="Clear all arguments"
                      onClick={() => updateApp("arguments", [])}
                    >
                      Clear
                    </button>
                  </div>
                </div>
                <textarea
                  id="app-arguments"
                  className="code-area"
                  rows={3}
                  placeholder="One argument per line, e.g.\n-bigpicture"
                  value={(appConfig.arguments ?? []).join("\n")}
                  onChange={(e) => updateApp("arguments", parseLaunchArguments(e.target.value))}
                />
                <span className="field-help">
                  These are passed directly to the app after launch.
                  {(appConfig.arguments ?? []).length > 0 && (
                    <> Current: <code>{(appConfig.arguments ?? []).join(" ")}</code></>
                  )}
                </span>
              </div>

              {/* App session behaviour */}
              <div className="field field-row">
                <label className="toggle" htmlFor="app-no-timeout">
                  <input
                    id="app-no-timeout"
                    type="checkbox"
                    checked={appConfig.noTimeout ?? false}
                    onChange={(e) => updateApp("noTimeout", e.target.checked || undefined as unknown as boolean)}
                  />
                  <span className="toggle-slider" />
                </label>
                <span style={{ marginLeft: 10, color: "var(--text-muted)" }}>
                  Run indefinitely — don’t auto-close after a timeout
                </span>
              </div>

              <div className="field field-row">
                <label className="toggle" htmlFor="app-close-on-deactivate">
                  <input
                    id="app-close-on-deactivate"
                    type="checkbox"
                    checked={appConfig.closeOnDeactivate ?? false}
                    onChange={(e) => updateApp("closeOnDeactivate", e.target.checked || undefined as unknown as boolean)}
                  />
                  <span className="toggle-slider" />
                </label>
                <span style={{ marginLeft: 10, color: "var(--text-muted)" }}>
                  Quit app when Matter target is turned off
                </span>
              </div>
            </>
          )}

          {!(target.provider === "app" && appConfig.noTimeout) && (
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
          )}

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

function ensureAppConfig(config: KioskTarget["app"]): AppTargetConfig {
  return {
    applicationName: config?.applicationName,
    bundleId: config?.bundleId,
    applicationPath: config?.applicationPath,
    arguments: config?.arguments ?? [],
    noTimeout: config?.noTimeout,
    closeOnDeactivate: config?.closeOnDeactivate,
  };
}

function parseLaunchArguments(value: string): string[] {
  return value
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
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
