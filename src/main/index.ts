import { app, Menu, Tray, nativeImage } from "electron";
import path from "path";
import { createSettingsWindow, showSettingsWindow, destroySettingsWindow } from "./windows";
import { startMatterBridge, stopMatterBridge } from "./matter";
import { getConfig } from "./store";
import { registerIpcHandlers } from "./ipc";

// Prevent second instance
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let tray: Tray | null = null;

function createTray(): void {
  // Use a simple template icon (replace with actual icon in assets/)
  const iconPath = path.join(__dirname, "../../assets/tray-icon.png");
  let icon: Electron.NativeImage;
  try {
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) {
      icon = nativeImage.createEmpty();
    }
  } catch {
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  tray.setToolTip("MatterKiosk");

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Open Settings",
      click: () => showSettingsWindow(),
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on("click", () => showSettingsWindow());
}

async function bootstrap(): Promise<void> {
  // On macOS, don't show the app in the dock by default (tray-only)
  if (process.platform === "darwin" && app.dock) {
    app.dock.hide();
  }

  registerIpcHandlers();
  createTray();
  createSettingsWindow();

  const config = getConfig();
  app.setLoginItemSettings({ openAtLogin: config.launchAtLogin });

  // Start Matter bridge in the background
  startMatterBridge(config.targets).catch((err) => {
    console.error("[Matter] Failed to start bridge:", err);
  });
}

app.on("ready", bootstrap);

app.on("second-instance", () => {
  showSettingsWindow();
});

app.on("window-all-closed", () => {
  // Do NOT quit on window-all-closed; we live in the tray
  // Returning without calling app.quit() keeps the app alive
});

app.on("before-quit", async () => {
  destroySettingsWindow();
  await stopMatterBridge();
  tray?.destroy();
});

app.on("activate", () => {
  // macOS: clicking dock icon (if visible) shows settings
  showSettingsWindow();
});
