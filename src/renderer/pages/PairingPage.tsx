import React, { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { MatterStatus } from "../../shared/types";
import "./PairingPage.css";

export default function PairingPage(): React.ReactElement {
  const [status, setStatus] = useState<MatterStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [resetting, setResetting] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const s = await window.matterkiosk.getMatterStatus();
      setStatus(s);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, []);

  async function handleReset() {
    if (!confirm("Reset Matter pairing? You will need to re-add this bridge in your smart home app.")) return;
    setResetting(true);
    try {
      await window.matterkiosk.resetMatter();
      await load();
    } finally {
      setResetting(false);
    }
  }

  return (
    <div>
      <h1 className="page-title">Pairing</h1>
      <p className="page-subtitle">
        Pair MatterKiosk with Apple Home, Google Home, Home Assistant, or any Matter controller.
      </p>

      {loading && !status && <p className="text-muted">Starting Matter bridge…</p>}

      {status && (
        <>
          <div className="card status-card">
            <div className="status-row">
              <span className="status-label">Bridge</span>
              <span className={`status-badge ${status.started ? "ok" : "error"}`}>
                {status.started ? "Running" : "Stopped"}
              </span>
            </div>
            <div className="status-row">
              <span className="status-label">Paired</span>
              <span className={`status-badge ${status.paired ? "ok" : "idle"}`}>
                {status.paired ? "Yes — commissioned to a fabric" : "Not yet paired"}
              </span>
            </div>
          </div>

          {!status.paired && status.qrCode && (
            <div className="card qr-card">
              <h2 className="section-title">Scan QR Code</h2>
              <p className="text-muted qr-hint">
                Open your smart home app and add a new device, then scan this code.
              </p>
              <div className="qr-image-wrapper">
                <QRCodeSVG
                  value={status.qrCode}
                  size={220}
                  level="M"
                  style={{ display: "block", margin: "0 auto" }}
                />
              </div>
              <p className="qr-hint text-muted" style={{ marginTop: 12 }}>
                Or paste this code manually: <code className="qr-code-text">{status.qrCode}</code>
              </p>
            </div>
          )}

          {!status.paired && status.manualPairingCode && (
            <div className="card">
              <h2 className="section-title">Manual Pairing Code</h2>
              <p className="text-muted" style={{ marginBottom: 12 }}>
                Enter this code manually if QR scanning is not available.
              </p>
              <div className="manual-code">{status.manualPairingCode}</div>
            </div>
          )}

          {status.paired && (
            <div className="card">
              <h2 className="section-title">Bridge is commissioned</h2>
              <p className="text-muted">
                Your Matter controller can see all enabled dashboards as on/off outlets.
                Add or enable dashboards on the Dashboards page — they appear automatically
                without re-pairing.
              </p>
            </div>
          )}

          {status.paired && (
            <div className="card">
              <h2 className="section-title">Reset Pairing</h2>
              <p className="text-muted" style={{ marginBottom: 16 }}>
                Removes all commissioning data. Use this if you want to move the bridge to a different smart home ecosystem or start fresh.
              </p>
              <button className="danger" onClick={handleReset} disabled={resetting}>
                {resetting ? "Resetting…" : "Factory Reset Matter"}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
