import React, { useState } from "react";
import {
  DashboardProvider,
  KioskTarget,
  TrmnlAssetMode,
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
      if (!trmnl.template.trim()) {
        newErrors["template"] = "TRMNL template is required";
      }

      try {
        JSON.parse(trmnl.data);
      } catch {
        newErrors["data"] = "TRMNL data must be valid JSON";
      }

      if (trmnl.fields?.trim()) {
        try {
          const parsedFields = JSON.parse(trmnl.fields);
          if (!Array.isArray(parsedFields)) {
            newErrors["fields"] = "TRMNL fields must be a JSON array";
          }
        } catch {
          newErrors["fields"] = "TRMNL fields must be valid JSON";
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
      setErrors((prev) => ({ ...prev, template: "", data: "", fields: "" }));
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error));
    } finally {
      setImporting(false);
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
              <div className="field import-block">
                <label htmlFor="recipe-source">Import TRMNL Recipe</label>
                <div className="import-row">
                  <input
                    id="recipe-source"
                    type="text"
                    placeholder="Recipe URL, recipe ID, or archive URL"
                    value={recipeSource}
                    onChange={(e) => setRecipeSource(e.target.value)}
                  />
                  <button
                    type="button"
                    className="secondary import-button"
                    onClick={handleImportRecipe}
                    disabled={importing}
                  >
                    {importing ? "Importing…" : "Import"}
                  </button>
                </div>
                <span className="field-help">
                  Accepts recipe pages like https://trmnl.com/recipes/123456, a raw recipe ID,
                  or a plugin archive URL.
                </span>
                {importError && <span className="field-error">{importError}</span>}
                {trmnl.importSource && (
                  <span className="field-help">
                    Imported recipe #{trmnl.importSource.recipeId} on{" "}
                    {new Date(trmnl.importSource.importedAt).toLocaleString()}.
                  </span>
                )}
                {trmnl.polling?.enabled && (
                  <span className="field-help">
                    Polls {trmnl.polling.exchanges.length} source
                    {trmnl.polling.exchanges.length === 1 ? "" : "s"} every{" "}
                    {trmnl.polling.intervalSeconds}s and rewrites the local runtime automatically.
                  </span>
                )}
              </div>

              <div className="field">
                <label htmlFor="asset-mode">Framework Assets</label>
                <select
                  id="asset-mode"
                  value={trmnl.assetMode ?? "cached"}
                  onChange={(e) => updateTrmnl("assetMode", e.target.value as TrmnlAssetMode)}
                >
                  <option value="cached">Local cached assets</option>
                  <option value="remote">Remote trmnl.com assets</option>
                </select>
                <span className="field-help">
                  Cached assets are downloaded once and then loaded locally by MatterKiosk.
                </span>
              </div>

              <div className="field">
                <label htmlFor="template">TRMNL Template</label>
                <textarea
                  id="template"
                  className="code-area"
                  rows={12}
                  value={trmnl.template}
                  onChange={(e) => updateTrmnl("template", e.target.value)}
                />
                {errors["template"] && <span className="field-error">{errors["template"]}</span>}
              </div>

              <div className="field">
                <label htmlFor="data">TRMNL Data (JSON)</label>
                <textarea
                  id="data"
                  className="code-area"
                  rows={10}
                  value={trmnl.data}
                  onChange={(e) => updateTrmnl("data", e.target.value)}
                />
                {errors["data"] && <span className="field-error">{errors["data"]}</span>}
              </div>
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
  };
}
