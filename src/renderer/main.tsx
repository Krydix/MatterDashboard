import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

// Expose platform to CSS so styles can adapt per OS
document.body.dataset.platform = window.matterkiosk.platform;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
