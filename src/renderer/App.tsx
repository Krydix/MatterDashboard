import React, { useState } from "react";
import PairingPage from "./pages/PairingPage";
import TargetsPage from "./pages/TargetsPage";
import SettingsPage from "./pages/SettingsPage";
import "./App.css";

type Page = "targets" | "pairing" | "settings";

export default function App(): React.ReactElement {
  const [page, setPage] = useState<Page>("targets");

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
        {page === "targets" && <TargetsPage />}
        {page === "pairing" && <PairingPage />}
        {page === "settings" && <SettingsPage />}
      </main>
    </div>
  );
}
