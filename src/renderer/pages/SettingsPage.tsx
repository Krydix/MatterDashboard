import React, { useEffect, useState } from "react";
import { AppConfig, DaemonState } from "../../shared/types";

export default function SettingsPage(): React.ReactElement {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [daemonState, setDaemonState] = useState<DaemonState | null>(null);
  const [saving, setSaving] = useState(false);
  const [volumeName, setVolumeName] = useState("");

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    setVolumeName(config?.volumeControl.name ?? "");
  }, [config?.volumeControl.name]);

  async function load() {
    const [nextConfig, nextDaemonState] = await Promise.all([
      window.matterkiosk.getConfig(),
      window.matterkiosk.getDaemonState(),
    ]);

    setConfig(nextConfig);
    setDaemonState(nextDaemonState);
  }

  async function save(updated: AppConfig) {
    setSaving(true);
    const previousConfig = config;
    setConfig(updated);
    try {
      await window.matterkiosk.saveConfig(updated);
      setDaemonState(await window.matterkiosk.getDaemonState());
    } catch (error) {
      setConfig(previousConfig);
      setDaemonState(await window.matterkiosk.getDaemonState());
      throw error;
    } finally {
      setSaving(false);
    }
  }

  async function handleBackgroundDaemonChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (!config) return;
    await save({ ...config, backgroundDaemonEnabled: e.target.checked });
  }

  async function handleLaunchAtLoginChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (!config) return;
    await save({ ...config, launchAtLogin: e.target.checked });
  }

  async function handleVolumeControlChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (!config) return;
    await save({
      ...config,
      volumeControl: {
        ...config.volumeControl,
        enabled: e.target.checked,
      },
    });
  }

  async function commitVolumeName() {
    if (!config) return;

    const name = volumeName.trim() || "Volume";
    if (name !== volumeName) {
      setVolumeName(name);
    }

    if (name === config.volumeControl.name) {
      return;
    }

    await save({
      ...config,
      volumeControl: {
        ...config.volumeControl,
        name,
      },
    });
  }

  if (!config) return <p style={{ color: "var(--text-muted)" }}>Loading…</p>;

  return (
    <div>
      <h1 className="page-title">Settings</h1>
      <p className="page-subtitle">Application preferences.</p>

      <div className="card" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
        <div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Background Matter Process</div>
          <div style={{ color: "var(--text-muted)", fontSize: 13 }}>
            Keep the Matter bridge running after you close this config app. Dashboards are launched on demand,
            so Electron stays closed while idle.
          </div>
          <div style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 8 }}>
            Status: {daemonState?.running ? "Running" : "Stopped"}
          </div>
        </div>
        <label className="toggle">
          <input
            type="checkbox"
            checked={config.backgroundDaemonEnabled}
            onChange={handleBackgroundDaemonChange}
            disabled={saving}
          />
          <span className="toggle-slider" />
        </label>
      </div>

      <div className="card" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
        <div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Launch at Login</div>
          <div style={{ color: "var(--text-muted)", fontSize: 13 }}>
            Start the background Matter process automatically when you log in.
          </div>
        </div>
        <label className="toggle">
          <input
            type="checkbox"
            checked={config.launchAtLogin}
            onChange={handleLaunchAtLoginChange}
            disabled={saving || !config.backgroundDaemonEnabled}
          />
          <span className="toggle-slider" />
        </label>
      </div>

      <div className="card" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
          <div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Bridge System Volume</div>
            <div style={{ color: "var(--text-muted)", fontSize: 13 }}>
              Expose the host output volume as a Matter dimmable light named Volume. On macOS, on/off mutes or
              unmutes and brightness controls the output level.
            </div>
          </div>
          <label className="toggle">
            <input
              type="checkbox"
              checked={config.volumeControl.enabled}
              onChange={handleVolumeControlChange}
              disabled={saving || window.matterkiosk.platform !== "darwin"}
            />
            <span className="toggle-slider" />
          </label>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label htmlFor="volume-accessory-name">
            Accessory Name
          </label>
          <input
            id="volume-accessory-name"
            type="text"
            value={volumeName}
            placeholder="Volume"
            onChange={(e) => setVolumeName(e.target.value)}
            onBlur={() => {
              void commitVolumeName();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.currentTarget.blur();
              }
            }}
            disabled={saving || window.matterkiosk.platform !== "darwin"}
          />
          <div style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 8 }}>
            {window.matterkiosk.platform === "darwin"
              ? "Available on macOS in this build. Linux and Windows can plug into the same accessory abstraction later."
              : "This build only enables the host volume backend on macOS for now."}
          </div>
        </div>
      </div>

      <div className="card">
        <div style={{ fontWeight: 600, marginBottom: 4 }}>Version</div>
        <div style={{ color: "var(--text-muted)", fontSize: 13 }}>MatterKiosk 0.1.0</div>
      </div>
    </div>
  );
}
