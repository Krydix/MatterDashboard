import React, { useEffect, useState } from "react";
import { AppConfig } from "../../shared/types";

export default function SettingsPage(): React.ReactElement {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    window.matterkiosk.getConfig().then(setConfig);
  }, []);

  async function handleLaunchAtLoginChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (!config) return;
    const updated = { ...config, launchAtLogin: e.target.checked };
    setSaving(true);
    try {
      await window.matterkiosk.saveConfig(updated);
      setConfig(updated);
    } finally {
      setSaving(false);
    }
  }

  if (!config) return <p style={{ color: "var(--text-muted)" }}>Loading…</p>;

  return (
    <div>
      <h1 className="page-title">Settings</h1>
      <p className="page-subtitle">Application preferences.</p>

      <div className="card" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
        <div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Launch at Login</div>
          <div style={{ color: "var(--text-muted)", fontSize: 13 }}>
            Start MatterKiosk automatically when you log in. The app will run in the tray and the
            Matter bridge will be available immediately.
          </div>
        </div>
        <label className="toggle">
          <input
            type="checkbox"
            checked={config.launchAtLogin}
            onChange={handleLaunchAtLoginChange}
            disabled={saving}
          />
          <span className="toggle-slider" />
        </label>
      </div>

      <div className="card">
        <div style={{ fontWeight: 600, marginBottom: 4 }}>Version</div>
        <div style={{ color: "var(--text-muted)", fontSize: 13 }}>MatterKiosk 0.1.0</div>
      </div>
    </div>
  );
}
