import React, { useEffect, useState } from "react";
import {
  AppConfig,
  BrightnessControlAvailability,
  DaemonState,
  PresentationDisplay,
  VolumeControlAvailability,
} from "../../shared/types";

const VOLUME_AVAILABILITY_REFRESH_MS = 3000;

export default function SettingsPage(): React.ReactElement {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [daemonState, setDaemonState] = useState<DaemonState | null>(null);
  const [presentationDisplays, setPresentationDisplays] = useState<PresentationDisplay[]>([]);
  const [brightnessAvailability, setBrightnessAvailability] = useState<BrightnessControlAvailability | null>(null);
  const [volumeAvailability, setVolumeAvailability] = useState<VolumeControlAvailability | null>(null);
  const [saving, setSaving] = useState(false);
  const [brightnessName, setBrightnessName] = useState("");
  const [volumeName, setVolumeName] = useState("");

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    let disposed = false;

    const refresh = () => {
      if (!disposed) {
        void load();
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        refresh();
      }
    };

    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        refresh();
      }
    }, VOLUME_AVAILABILITY_REFRESH_MS);

    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    const mediaDevices = navigator.mediaDevices;
    if (typeof mediaDevices?.addEventListener === "function") {
      mediaDevices.addEventListener("devicechange", refresh);
    }

    return () => {
      disposed = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (typeof mediaDevices?.removeEventListener === "function") {
        mediaDevices.removeEventListener("devicechange", refresh);
      }
    };
  }, []);

  useEffect(() => {
    setBrightnessName(config?.brightnessControl.name ?? "");
  }, [config?.brightnessControl.name]);

  useEffect(() => {
    setVolumeName(config?.volumeControl.name ?? "");
  }, [config?.volumeControl.name]);

  async function load() {
    let [nextConfig, nextDaemonState, nextPresentationDisplays, nextBrightnessAvailability, nextVolumeAvailability] = await Promise.all([
      window.matterkiosk.getConfig(),
      window.matterkiosk.getDaemonState(),
      window.matterkiosk.getPresentationDisplays(),
      window.matterkiosk.getBrightnessControlAvailability(),
      window.matterkiosk.getVolumeControlAvailability(),
    ]);

    const preferredDisplayId =
      nextPresentationDisplays.find((display) => display.isPrimary)?.id ?? nextPresentationDisplays[0]?.id ?? null;
    const selectedDisplayStillAvailable =
      nextConfig.presentationDisplayId !== null &&
      nextPresentationDisplays.some((display) => display.id === nextConfig.presentationDisplayId);
    const shouldUpdatePresentationDisplay =
      preferredDisplayId !== nextConfig.presentationDisplayId &&
      (nextConfig.presentationDisplayId === null || !selectedDisplayStillAvailable || nextPresentationDisplays.length <= 1);

    if (shouldUpdatePresentationDisplay) {
      nextConfig = {
        ...nextConfig,
        presentationDisplayId: preferredDisplayId,
      };
      await window.matterkiosk.saveConfig(nextConfig);
      nextDaemonState = await window.matterkiosk.getDaemonState();
      nextBrightnessAvailability = await window.matterkiosk.getBrightnessControlAvailability();
    }

    if (nextConfig.brightnessControl.enabled && !nextBrightnessAvailability.available) {
      nextConfig = {
        ...nextConfig,
        brightnessControl: {
          ...nextConfig.brightnessControl,
          enabled: false,
        },
      };
      await window.matterkiosk.saveConfig(nextConfig);
      nextDaemonState = await window.matterkiosk.getDaemonState();
    }

    if (nextConfig.volumeControl.enabled && !nextVolumeAvailability.available) {
      nextConfig = {
        ...nextConfig,
        volumeControl: {
          ...nextConfig.volumeControl,
          enabled: false,
        },
      };
      await window.matterkiosk.saveConfig(nextConfig);
      nextDaemonState = await window.matterkiosk.getDaemonState();
    }

    setConfig(nextConfig);
    setDaemonState(nextDaemonState);
    setPresentationDisplays(nextPresentationDisplays);
    setBrightnessAvailability(nextBrightnessAvailability);
    setVolumeAvailability(nextVolumeAvailability);
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

  async function handlePresentationDisplayChange(e: React.ChangeEvent<HTMLSelectElement>) {
    if (!config || presentationDisplays.length <= 1) return;

    const nextDisplayId = Number(e.target.value);
    await save({
      ...config,
      presentationDisplayId: Number.isInteger(nextDisplayId) ? nextDisplayId : config.presentationDisplayId,
    });
  }

  async function handleBrightnessControlChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (!config || !brightnessAvailability?.available) return;
    await save({
      ...config,
      brightnessControl: {
        ...config.brightnessControl,
        enabled: e.target.checked,
      },
    });
  }

  async function commitBrightnessName() {
    if (!config || !brightnessAvailability?.available) return;

    const name = brightnessName.trim() || "Brightness";
    if (name !== brightnessName) {
      setBrightnessName(name);
    }

    if (name === config.brightnessControl.name) {
      return;
    }

    await save({
      ...config,
      brightnessControl: {
        ...config.brightnessControl,
        name,
      },
    });
  }

  async function handleVolumeControlChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (!config || !volumeAvailability?.available) return;
    await save({
      ...config,
      volumeControl: {
        ...config.volumeControl,
        enabled: e.target.checked,
      },
    });
  }

  async function commitVolumeName() {
    if (!config || !volumeAvailability?.available) return;

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

  const hasMultipleDisplays = presentationDisplays.length > 1;
  const selectedPresentationDisplay =
    config.presentationDisplayId !== null
      ? presentationDisplays.find((display) => display.id === config.presentationDisplayId) ?? null
      : null;
  const effectivePresentationDisplay = selectedPresentationDisplay ?? presentationDisplays[0] ?? null;
  const presentationDisplayHelperText = hasMultipleDisplays
    ? `Window-based dashboards open on ${effectivePresentationDisplay?.name ?? "the selected display"}. App targets are moved there best-effort on macOS after launch.`
    : effectivePresentationDisplay
      ? `Only one display is active, so MatterKiosk uses ${effectivePresentationDisplay.name}.`
      : "Connect a display to choose where dashboards open.";
  const brightnessControlLocked = saving || !(brightnessAvailability?.available ?? false);
  const brightnessControlHelperText = brightnessAvailability?.available
    ? `Available on ${effectivePresentationDisplay?.name ?? "the selected display"} when m1ddc can control that display over DDC.`
    : (brightnessAvailability?.reason ?? "Checking selected display brightness support...");
  const volumeControlLocked = saving || !(volumeAvailability?.available ?? false);
  const volumeControlHelperText = volumeAvailability?.available
    ? "Available on macOS when the current output device exposes adjustable system volume."
    : (volumeAvailability?.reason ?? "Checking current audio output support...");

  return (
    <div>
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
        <div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Presentation Display</div>
          <div style={{ color: "var(--text-muted)", fontSize: 13 }}>
            Choose which display MatterKiosk uses for dashboards. Future brightness control will target this display too.
          </div>
        </div>

        {hasMultipleDisplays ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label htmlFor="presentation-display">
              Display
            </label>
            <select
              id="presentation-display"
              value={effectivePresentationDisplay ? String(effectivePresentationDisplay.id) : ""}
              onChange={handlePresentationDisplayChange}
              disabled={saving}
            >
              {presentationDisplays.map((display) => (
                <option key={display.id} value={String(display.id)}>
                  {display.name}{display.isPrimary ? " (Primary)" : ""}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        <div style={{ color: "var(--text-muted)", fontSize: 12 }}>
          {presentationDisplayHelperText}
        </div>
      </div>

      <div className="card" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
          <div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Bridge Display Brightness</div>
            <div style={{ color: "var(--text-muted)", fontSize: 13 }}>
              Expose the selected display brightness as a Matter dimmable light and allow dashboards to request launch-time brightness overrides.
            </div>
          </div>
          <label className="toggle">
            <input
              type="checkbox"
              checked={config.brightnessControl.enabled}
              onChange={handleBrightnessControlChange}
              disabled={brightnessControlLocked}
            />
            <span className="toggle-slider" />
          </label>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label htmlFor="brightness-accessory-name">
            Accessory Name
          </label>
          <input
            id="brightness-accessory-name"
            type="text"
            value={brightnessName}
            placeholder="Brightness"
            onChange={(e) => setBrightnessName(e.target.value)}
            onBlur={() => {
              void commitBrightnessName();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.currentTarget.blur();
              }
            }}
            disabled={brightnessControlLocked}
          />
          <div style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 8 }}>
            {brightnessControlHelperText}
          </div>
        </div>
      </div>

      <div className="card" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
          <div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Bridge System Volume</div>
            <div style={{ color: "var(--text-muted)", fontSize: 13 }}>
              Expose the host output volume as a Matter dimmable light named Volume. On macOS, on/off mutes or
              unmutes and the slider controls the output level.
            </div>
          </div>
          <label className="toggle">
            <input
              type="checkbox"
              checked={config.volumeControl.enabled}
              onChange={handleVolumeControlChange}
              disabled={volumeControlLocked}
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
            disabled={volumeControlLocked}
          />
          <div style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 8 }}>
            {volumeControlHelperText}
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
