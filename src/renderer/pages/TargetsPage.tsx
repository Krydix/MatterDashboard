import React, { useEffect, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import { AppConfig, DashboardProvider, KioskTarget } from "../../shared/types";
import TargetModal from "../components/TargetModal";
import "./TargetsPage.css";

export default function TargetsPage(): React.ReactElement {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [editingTarget, setEditingTarget] = useState<KioskTarget | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [lastTriggered, setLastTriggered] = useState<string | null>(null);
  const [draftProvider, setDraftProvider] = useState<DashboardProvider>("url");

  useEffect(() => {
    window.matterkiosk.getConfig().then(setConfig);

    const unsub = window.matterkiosk.onTargetTriggered((targetId) => {
      setLastTriggered(targetId);
      setTimeout(() => setLastTriggered((prev) => (prev === targetId ? null : prev)), 3000);
    });
    return unsub;
  }, []);

  async function save(updated: AppConfig) {
    await window.matterkiosk.saveConfig(updated);
    setConfig(updated);
  }

  function openAdd(provider: DashboardProvider = "url") {
    setDraftProvider(provider);
    setEditingTarget(null);
    setShowModal(true);
  }

  function openEdit(target: KioskTarget) {
    setDraftProvider(target.provider);
    setEditingTarget(target);
    setShowModal(true);
  }

  async function handleSaveTarget(target: KioskTarget) {
    if (!config) return;
    const existing = config.targets.find((t) => t.id === target.id);
    const updatedTargets = existing
      ? config.targets.map((t) => (t.id === target.id ? target : t))
      : [...config.targets, target];
    await save({ ...config, targets: updatedTargets });
    setShowModal(false);
  }

  async function handleDelete(id: string) {
    if (!config) return;
    if (!confirm("Delete this dashboard?")) return;
    await save({ ...config, targets: config.targets.filter((t) => t.id !== id) });
  }

  async function handleToggle(id: string) {
    if (!config) return;
    const updatedTargets = config.targets.map((t) =>
      t.id === id ? { ...t, enabled: !t.enabled } : t,
    );
    await save({ ...config, targets: updatedTargets });
  }

  async function handleTest(target: KioskTarget) {
    await window.matterkiosk.openKiosk(target.id);
  }

  if (!config) return <p className="text-muted">Loading…</p>;

  return (
    <div>
      <div className="targets-header">
        <div>
          <h1 className="page-title">Dashboards</h1>
          <p className="page-subtitle">
            Each enabled dashboard becomes a Matter outlet in your smart home app.
          </p>
        </div>
        <div className="targets-actions">
          <button className="secondary" onClick={() => openAdd("trmnl")}>
            Import TRMNL Recipe
          </button>
          <button className="primary" onClick={() => openAdd("url")}>
            + Add Dashboard
          </button>
        </div>
      </div>

      {config.targets.length === 0 && (
        <div className="card empty-state">
          <p>No dashboards configured yet.</p>
          <p className="text-muted" style={{ marginTop: 8 }}>
            Add a dashboard URL or build a native TRMNL-style template and it will appear as a
            Matter outlet in your controller.
          </p>
        </div>
      )}

      <div className="target-list">
        {config.targets.map((target) => (
          <div
            key={target.id}
            className={`target-card card ${lastTriggered === target.id ? "triggered" : ""}`}
          >
            <div className="target-card-left">
              <div className="target-name">{target.name}</div>
              <div className="target-url text-muted">{describeTarget(target)}</div>
              <div className="target-meta text-muted">
                <span className={`target-provider provider-${target.provider}`}>{providerLabel(target)}</span>
                Display for {target.durationSeconds}s
                {lastTriggered === target.id && (
                  <span className="trigger-badge">▶ Triggered!</span>
                )}
              </div>
            </div>
            <div className="target-card-right">
              <label className="toggle" title={target.enabled ? "Enabled" : "Disabled"}>
                <input
                  type="checkbox"
                  checked={target.enabled}
                  onChange={() => handleToggle(target.id)}
                />
                <span className="toggle-slider" />
              </label>
              <button className="ghost" onClick={() => handleTest(target)} title="Preview now">
                ▶
              </button>
              <button className="ghost" onClick={() => openEdit(target)} title="Edit">
                ✎
              </button>
              <button className="ghost" onClick={() => handleDelete(target.id)} title="Delete">
                🗑
              </button>
            </div>
          </div>
        ))}
      </div>

      {showModal && (
        <TargetModal
          initial={
            editingTarget ?? {
              id: uuidv4(),
              name: "",
              url: "",
              durationSeconds: 30,
              enabled: true,
              provider: draftProvider,
            }
          }
          onSave={handleSaveTarget}
          onCancel={() => setShowModal(false)}
        />
      )}
    </div>
  );
}

function describeTarget(target: KioskTarget): string {
  if (target.provider === "trmnl") {
    const recipeId = target.trmnl?.importSource?.recipeId;
    if (recipeId) {
      if (target.trmnl?.transform?.enabled) {
        return `TRMNL recipe #${recipeId} (local transform sandbox)`;
      }

      return `TRMNL recipe #${recipeId}`;
    }

    const pollingCount = target.trmnl?.polling?.enabled ? target.trmnl.polling.exchanges.length : 0;
    if (pollingCount > 0) {
      return `Native TRMNL runtime (${pollingCount} exchange${pollingCount === 1 ? "" : "s"})`;
    }

    if (target.trmnl?.transform?.enabled) {
      return "Native TRMNL runtime (local transform + Liquid)";
    }

    return "Native TRMNL runtime (Liquid template + JSON data)";
  }

  return target.url;
}

function providerLabel(target: KioskTarget): string {
  return target.provider === "trmnl" ? "TRMNL" : "URL";
}
