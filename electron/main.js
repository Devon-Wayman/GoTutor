import { app, BrowserWindow, ipcMain, screen } from "electron";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const SETTINGS_PATH = path.join(ROOT, "config", "settings.json");

let mainWindow = null;
let projectorWindow = null;
let visionProcess = null;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
  } catch {
    return {
      cameraDeviceId: null,
      projectorDisplayId: null,
      autoCalibrateOnLaunch: true,
      visionUrl: "http://127.0.0.1:8765",
      calibration: null
    };
  }
}

function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2));
  return next;
}

function pythonExecutable() {
  const candidates = process.platform === "win32"
    ? [
        path.join(ROOT, ".venv", "Scripts", "python.exe"),
        "python"
      ]
    : [
        path.join(ROOT, ".venv", "bin", "python"),
        "python3"
      ];

  for (const candidate of candidates) {
    if (candidate.includes(path.sep) && fs.existsSync(candidate)) return candidate;
  }

  return candidates[candidates.length - 1];
}

function startVisionService() {
  if (visionProcess) return;

  const py = pythonExecutable();
  const script = path.join(ROOT, "vision", "service.py");

  visionProcess = spawn(py, [script], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"]
  });

  visionProcess.stdout.on("data", data => {
    const text = data.toString().trim();
    if (text) console.log(`[vision] ${text}`);
  });

  visionProcess.stderr.on("data", data => {
    const text = data.toString().trim();
    if (text) console.error(`[vision] ${text}`);
  });

  visionProcess.on("exit", code => {
    console.log(`Vision service exited with code ${code}`);
    visionProcess = null;
  });
}

function serializeDisplay(display) {
  return {
    id: String(display.id),
    label: display.label || `Display ${display.id}`,
    bounds: display.bounds,
    workArea: display.workArea,
    size: display.size,
    scaleFactor: display.scaleFactor,
    rotation: display.rotation,
    internal: display.internal
  };
}

function getDisplays() {
  const primary = screen.getPrimaryDisplay();
  return screen.getAllDisplays().map(display => ({
    ...serializeDisplay(display),
    primary: display.id === primary.id
  }));
}

function resolveProjectorDisplay(requestedId = null) {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();

  if (requestedId != null) {
    const exact = displays.find(d => String(d.id) === String(requestedId));
    if (exact) return exact;
  }

  // Prefer a non-primary external display.
  return displays.find(d => d.id !== primary.id) || null;
}

function createProjectorWindow(display) {
  if (!display) return null;

  if (projectorWindow && !projectorWindow.isDestroyed()) {
    projectorWindow.close();
  }

  projectorWindow = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    frame: false,
    fullscreen: false,
    simpleFullscreen: process.platform === "darwin",
    kiosk: false,
    alwaysOnTop: true,
    backgroundColor: "#000000",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  projectorWindow.loadFile(path.join(ROOT, "ui", "projector.html"));

  projectorWindow.once("ready-to-show", () => {
    // Position exactly over the selected display, then use simple fullscreen
    // on macOS to avoid creating a separate Spaces animation.
    projectorWindow.setBounds(display.bounds);
    if (process.platform === "darwin") {
      projectorWindow.setSimpleFullScreen(true);
    } else {
      projectorWindow.setFullScreen(true);
    }
    projectorWindow.showInactive();
  });

  return projectorWindow;
}

function sendPattern(pattern) {
  if (!projectorWindow || projectorWindow.isDestroyed()) return;
  projectorWindow.webContents.send("projector:pattern", pattern);
}

async function visionPost(pathname, body = null) {
  const { visionUrl } = readSettings();

  const response = await fetch(`${visionUrl}${pathname}`, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${pathname}: ${response.status} ${text}`);
  }

  return response.json();
}

async function waitForVision(timeoutMs = 10000) {
  const { visionUrl } = readSettings();
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${visionUrl}/health`);
      if (response.ok) return true;
    } catch {}
    await delay(250);
  }

  return false;
}

async function runAutomaticCalibration(displayId = null) {
  const display = resolveProjectorDisplay(displayId);

  if (!display) {
    throw new Error("No external projector/display is available.");
  }

  const ready = await waitForVision();

  if (!ready) {
    throw new Error(
      "The OpenCV service did not start. Create the Python venv and install vision/requirements.txt."
    );
  }

  if (!projectorWindow || projectorWindow.isDestroyed()) {
    createProjectorWindow(display);
    await delay(1000);
  }

  writeSettings({ projectorDisplayId: String(display.id) });

  // 1) Project black so OpenCV sees the unmodified physical board.
  sendPattern({ type: "black" });
  await delay(650);

  // 2) Ask OpenCV to locate the physical board/grid.
  const board = await visionPost("/board/detect");
  mainWindow?.webContents.send("calibration:progress", {
    stage: "board",
    message: `Board detected (${Math.round(board.score * 100)}% confidence)`
  });

  // 3) Save a black-projector baseline.
  await visionPost("/calibration/reset");
  await visionPost("/calibration/baseline");

  // Sequential points are intentionally used instead of one complex image.
  // Frame differencing makes a single projected dot very easy to identify.
  //
  // A 5x5 grid gives RANSAC many correspondences and allows dots that are
  // outside the camera's field of view to simply be skipped.
  const coords = [0.10, 0.30, 0.50, 0.70, 0.90];
  const samples = [];
  let attempted = 0;

  for (const y of coords) {
    for (const x of coords) {
      attempted++;

      sendPattern({
        type: "dot",
        x,
        y,
        radius: 0.018
      });

      await delay(180);

      try {
        const sample = await visionPost("/calibration/sample", {
          projector: { x, y }
        });

        if (sample.found) samples.push(sample);
      } catch {
        // A point outside the camera view is expected and is not fatal.
      }

      mainWindow?.webContents.send("calibration:progress", {
        stage: "sampling",
        message: `Projection samples: ${samples.length}/${attempted}`
      });

      sendPattern({ type: "black" });
      await delay(70);
    }
  }

  if (samples.length < 4) {
    sendPattern({ type: "black" });
    throw new Error(
      `Only ${samples.length} projected calibration points were visible. ` +
      "The camera needs to see more of the projector's illuminated area."
    );
  }

  // 4) OpenCV solves projector-normalized -> camera-pixel homography,
  // then maps the physical board corners back into projector coordinates.
  const solved = await visionPost("/calibration/solve");

  writeSettings({
    projectorDisplayId: String(display.id),
    calibration: solved
  });

  // 5) Push the solved board homography to the projection renderer.
  sendPattern({
    type: "board-test",
    homography: solved.boardToProjectorHomography,
    boardQuad: solved.boardQuadProjector
  });

  mainWindow?.webContents.send("calibration:complete", solved);

  return solved;
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 1000,
    minHeight: 700,
    backgroundColor: "#111318",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(ROOT, "ui", "index.html"));
}

app.whenReady().then(() => {
  startVisionService();
  createMainWindow();

  screen.on("display-added", (_event, display) => {
    mainWindow?.webContents.send("displays:changed", getDisplays());

    const settings = readSettings();
    if (settings.autoCalibrateOnLaunch && display.id !== screen.getPrimaryDisplay().id) {
      mainWindow?.webContents.send("projector:detected", serializeDisplay(display));
    }
  });

  screen.on("display-removed", () => {
    mainWindow?.webContents.send("displays:changed", getDisplays());
  });

  screen.on("display-metrics-changed", () => {
    mainWindow?.webContents.send("displays:changed", getDisplays());
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (visionProcess) {
    visionProcess.kill();
    visionProcess = null;
  }
});

ipcMain.handle("settings:get", () => readSettings());

ipcMain.handle("settings:set", (_event, patch) => writeSettings(patch));

ipcMain.handle("displays:list", () => getDisplays());

ipcMain.handle("projector:open", (_event, displayId) => {
  const display = resolveProjectorDisplay(displayId);
  if (!display) throw new Error("Selected display not found.");
  createProjectorWindow(display);
  writeSettings({ projectorDisplayId: String(display.id) });
  return serializeDisplay(display);
});

ipcMain.handle("projector:close", () => {
  if (projectorWindow && !projectorWindow.isDestroyed()) {
    projectorWindow.close();
    projectorWindow = null;
  }
  return true;
});

ipcMain.handle("projector:identify", async () => {
  const displays = screen.getAllDisplays();

  for (const display of displays) {
    const win = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      alwaysOnTop: true,
      focusable: false,
      backgroundColor: "#000000",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false
      }
    });

    const label = display.label || `Display ${display.id}`;
    const html = encodeURIComponent(`
      <!doctype html>
      <html>
      <body style="
        margin:0;background:#000;color:#fff;
        width:100vw;height:100vh;display:grid;place-items:center;
        font-family:system-ui;text-align:center">
        <div>
          <div style="font-size:12vw;font-weight:900">${display.id}</div>
          <div style="font-size:3vw">${label}</div>
        </div>
      </body>
      </html>
    `);

    win.loadURL(`data:text/html;charset=utf-8,${html}`);
    setTimeout(() => {
      if (!win.isDestroyed()) win.close();
    }, 2500);
  }

  return true;
});

ipcMain.handle("calibration:auto", (_event, displayId) =>
  runAutomaticCalibration(displayId)
);
