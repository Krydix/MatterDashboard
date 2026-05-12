import React, { useCallback, useState } from "react";
import PairingPage from "./pages/PairingPage";
import TargetsPage from "./pages/TargetsPage";
import SettingsPage from "./pages/SettingsPage";
import "./App.css";

type Page = "targets" | "pairing" | "settings";

const PAGE_LABELS: Record<Page, string> = {
  targets: "Dashboards",
  pairing: "Pairing",
  settings: "Settings",
};

export default function App(): React.ReactElement {
  const [page, setPage] = useState<Page>("targets");

  // Custom window drag via IPC — avoids -webkit-app-region overlap conflicts
  const handleTopbarMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    // Only primary button; ignore clicks on interactive children
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button, input, select, a, label")) return;

    window.matterkiosk.startWindowDrag(e.screenX, e.screenY);

    const onMove = (ev: MouseEvent) => {
      window.matterkiosk.sendWindowDragMove(ev.screenX, ev.screenY);
    };
    const onUp = () => {
      window.matterkiosk.stopWindowDrag();
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  return (
    <div className="app-layout">
      <nav className="sidebar">
        <div className="sidebar-logo">
          <span className="logo-icon">⬡</span>
          <span className="logo-text">MatterKiosk</span>
        </div>
        <ul className="sidebar-nav">
          <li>
            <button
              className={`nav-item ${page === "targets" ? "active" : ""}`}
              onClick={() => setPage("targets")}
            >
              <span className="nav-icon">⊞</span>
              Dashboards
            </button>
          </li>
          <li>
            <button
              className={`nav-item ${page === "pairing" ? "active" : ""}`}
              onClick={() => setPage("pairing")}
            >
              <span className="nav-icon">◈</span>
              Pairing
            </button>
          </li>
          <li>
            <button
              className={`nav-item ${page === "settings" ? "active" : ""}`}
              onClick={() => setPage("settings")}
            >
              <span className="nav-icon">⚙</span>
              Settings
            </button>
          </li>
        </ul>
      </nav>
      <main className="main-content">
        <div className="page-topbar" onMouseDown={handleTopbarMouseDown}>
          <span className="page-topbar-title">{PAGE_LABELS[page]}</span>
        </div>
        <div className="page-scroll-area">
          {page === "targets" && <TargetsPage />}
          {page === "pairing" && <PairingPage />}
          {page === "settings" && <SettingsPage />}
        </div>
      </main>
    </div>
  );
}
