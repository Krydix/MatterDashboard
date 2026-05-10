import React, { useState } from "react";
import { KioskTarget } from "../../shared/types";
import "./TargetModal.css";

interface Props {
  initial: KioskTarget;
  onSave: (target: KioskTarget) => void;
  onCancel: () => void;
}

export default function TargetModal({ initial, onSave, onCancel }: Props): React.ReactElement {
  const [target, setTarget] = useState<KioskTarget>({ ...initial });
  const [errors, setErrors] = useState<Record<string, string>>({});

  function update<K extends keyof KioskTarget>(key: K, value: KioskTarget[K]) {
    setTarget((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => ({ ...prev, [key]: "" }));
  }

  function validate(): boolean {
    const newErrors: Record<string, string> = {};
    if (!target.name.trim()) newErrors["name"] = "Name is required";
    if (!target.url.trim()) {
      newErrors["url"] = "URL is required";
    } else {
      try {
        new URL(target.url);
      } catch {
        newErrors["url"] = "Enter a valid URL (e.g. https://example.com)";
      }
    }
    if (target.durationSeconds < 1) newErrors["durationSeconds"] = "Must be at least 1 second";
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (validate()) onSave(target);
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
