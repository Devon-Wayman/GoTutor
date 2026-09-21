import { app, BrowserWindow, ipcMain, screen, dialog } from "electron";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { KataGoGtp } from "../engines/katago.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const SETTINGS_PATH = path.join(ROOT, "config", "settings.json");
const KATAGO_PATHS_PATH = path.join(ROOT, "config", "katago.paths.json");
const DEBUG_ENABLED = process.argv.includes("--go-debug") || process.env.GO_TUTOR_DEBUG === "1";
const DEBUG_DIR = path.join(ROOT, "debug_logs");
const DEBUG_SESSION_ID = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const DEBUG_LOG_PATH = path.join(DEBUG_DIR, `app-${DEBUG_SESSION_ID}.jsonl`);

if (DEBUG_ENABLED) fs.mkdirSync(DEBUG_DIR,{recursive:true});

function debugLog(category,event,data=null) {
  if (!DEBUG_ENABLED) return;
  try {
    fs.appendFileSync(DEBUG_LOG_PATH,JSON.stringify({timestamp:new Date().toISOString(),category,event,data})+"\n");
  } catch (error) { console.error("[debug-log]",error); }
}

debugLog("app","process-start",{argv:process.argv,root:ROOT,debugLogPath:DEBUG_LOG_PATH});

let mainWindow = null;
let projectorWindow = null;
let visionProcess = null;
let kataGoEngine = null;
let kataGoEngineKey = null;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
  } catch {
    return {
      cameraDeviceId: null,
      projectorDisplayId: null,
      autoCalibrateOnLaunch: false,
      illuminateOnLaunch: true,
      boardIllumination: 0.72,
      visionUrl: "http://127.0.0.1:8765",
      calibration: null,
      katagoExecutablePath: "katago",
      katagoModelPath: "",
      katagoConfigPath: ""
    };
  }
}

function writeSettings(patch) {
  const current = readSettings();

  const next = {
    ...current,
    ...patch
  };

  fs.writeFileSync(
    SETTINGS_PATH,
    JSON.stringify(next, null, 2)
  );

  return next;
}

function pythonExecutable() {
  const candidates =
    process.platform === "win32"
      ? [
          path.join(ROOT, ".venv", "Scripts", "python.exe"),
          "python"
        ]
      : [
          path.join(ROOT, ".venv", "bin", "python"),
          "python3"
        ];

  for (const candidate of candidates) {
    if (
      candidate.includes(path.sep) &&
      fs.existsSync(candidate)
    ) {
      return candidate;
    }
  }

  return candidates[candidates.length - 1];
}

async function startVisionService() {
  /*
   * Two supported modes:
   *
   * MANUAL / EXTERNAL:
   *   The user already started vision/service.py. If /health
   *   answers, adopt it and do not spawn another process.
   *
   * ELECTRON-MANAGED:
   *   Nothing answers /health, so Electron starts the project
   *   venv Python service and later verifies that child's PID.
   */

  const existingHealth =
    await fetchVisionHealth();

  if (existingHealth?.ok) {
    visionProcess = null;

    debugLog(
      "vision",
      "adopt-existing-service",
      {
        processId:
          existingHealth.processId,
        sessionId:
          existingHealth.sessionId,
        debugEnabled:
          existingHealth.debugEnabled
      }
    );

    console.log(
      `[vision] Using already-running GoTutor vision service` +
      (
        existingHealth.processId
          ? ` (PID ${existingHealth.processId})`
          : ""
      )
    );

    return {
      mode: "external",
      health:
        existingHealth
    };
  }

  if (visionProcess) {
    return {
      mode: "spawned",
      pid:
        visionProcess.pid
    };
  }

  const py =
    pythonExecutable();

  const script =
    path.join(
      ROOT,
      "vision",
      "service.py"
    );

  const spawnedProcess =
    spawn(
      py,
      [script],
      {
        cwd: ROOT,
        stdio: [
          "ignore",
          "pipe",
          "pipe"
        ],
        env: {
          ...process.env,
          GO_TUTOR_DEBUG:
            DEBUG_ENABLED
              ? "1"
              : "0",
          GO_TUTOR_DEBUG_DIR:
            DEBUG_DIR
        }
      }
    );

  visionProcess =
    spawnedProcess;

  debugLog(
    "vision",
    "spawn",
    {
      pid:
        spawnedProcess.pid,
      python:
        py,
      script
    }
  );

  spawnedProcess.stdout.on(
    "data",
    data => {
      const message =
        data
          .toString()
          .trim();

      if (message) {
        console.log(
          `[vision] ${message}`
        );

        debugLog(
          "vision",
          "stdout",
          {
            message
          }
        );
      }
    }
  );

  spawnedProcess.stderr.on(
    "data",
    data => {
      const message =
        data
          .toString()
          .trim();

      if (message) {
        console.error(
          `[vision] ${message}`
        );

        debugLog(
          "vision",
          "stderr",
          {
            message
          }
        );

        mainWindow
          ?.webContents
          .send(
            "vision:error",
            message
          );
      }
    }
  );

  spawnedProcess.on(
    "exit",
    (
      code,
      signal
    ) => {
      console.log(
        `Vision service exited with code ${code}`
      );

      debugLog(
        "vision",
        "exit",
        {
          pid:
            spawnedProcess.pid,
          code,
          signal
        }
      );

      if (
        visionProcess ===
        spawnedProcess
      ) {
        visionProcess =
          null;
      }
    }
  );

  return {
    mode: "spawned",
    pid:
      spawnedProcess.pid
  };
}

function serializeDisplay(display) {
  return {
    id: String(display.id),

    label:
      display.label ||
      `Display ${display.id}`,

    bounds:
      display.bounds,

    workArea:
      display.workArea,

    size:
      display.size,

    scaleFactor:
      display.scaleFactor,

    rotation:
      display.rotation,

    internal:
      display.internal
  };
}

function getDisplays() {
  const primary =
    screen.getPrimaryDisplay();

  return screen
    .getAllDisplays()
    .map(display => ({
      ...serializeDisplay(display),

      primary:
        display.id ===
        primary.id
    }));
}

function resolveProjectorDisplay(
  requestedId = null
) {
  const displays =
    screen.getAllDisplays();

  const primary =
    screen.getPrimaryDisplay();

  if (requestedId != null) {
    const exact =
      displays.find(
        display =>
          String(display.id) ===
          String(requestedId)
      );

    if (exact) {
      return exact;
    }
  }

  return (
    displays.find(
      display =>
        display.id !==
        primary.id
    ) || null
  );
}

function createProjectorWindow(
  display
) {
  if (!display) {
    return null;
  }

  if (
    projectorWindow &&
    !projectorWindow.isDestroyed()
  ) {
    projectorWindow.close();
  }

  projectorWindow =
    new BrowserWindow({
      x:
        display.bounds.x,

      y:
        display.bounds.y,

      width:
        display.bounds.width,

      height:
        display.bounds.height,

      frame:
        false,

      fullscreen:
        false,

      simpleFullscreen:
        process.platform ===
        "darwin",

      kiosk:
        false,

      alwaysOnTop:
        true,

      backgroundColor:
        "#000000",

      show:
        false,

      webPreferences: {
        preload:
          path.join(
            __dirname,
            "preload.cjs"
          ),

        contextIsolation:
          true,

        nodeIntegration:
          false
      }
    });

  projectorWindow.loadFile(
    path.join(
      ROOT,
      "ui",
      "projector.html"
    )
  );

  projectorWindow.once(
    "ready-to-show",
    () => {
      projectorWindow.setBounds(
        display.bounds
      );

      if (
        process.platform ===
        "darwin"
      ) {
        projectorWindow
          .setSimpleFullScreen(
            true
          );
      } else {
        projectorWindow
          .setFullScreen(
            true
          );
      }

      projectorWindow
        .showInactive();
    }
  );

  return projectorWindow;
}

function sendPattern(
  pattern
) {
  if (!projectorWindow || projectorWindow.isDestroyed()) {
    debugLog("projector","pattern-skipped-no-window",pattern);
    return;
  }
  debugLog("projector","pattern",pattern);
  projectorWindow.webContents.send("projector:pattern",pattern);
}

function clamp01(value) {
  return Math.min(
    1,
    Math.max(
      0,
      Number(value) || 0
    )
  );
}

function sendSolidIllumination(
  level
) {
  sendPattern({
    type: "solid",
    level:
      clamp01(level)
  });
}

async function visionPost(
  pathname,
  body = null
) {
  const { visionUrl } = readSettings();
  debugLog("vision-api","request",{pathname,body});

  const response =
    await fetch(
      `${visionUrl}${pathname}`,
      {
        method:
          "POST",

        headers:
          body
            ? {
                "Content-Type":
                  "application/json"
              }
            : undefined,

        body:
          body
            ? JSON.stringify(
                body
              )
            : undefined
      }
    );

  if (!response.ok) {
    const responseText =
      await response.text();

    throw new Error(
      `${pathname}: ${response.status} ${responseText}`
    );
  }

  const result = await response.json();
  debugLog("vision-api","response",{pathname,result});
  return result;
}

async function fetchVisionHealth() {
  const {
    visionUrl
  } = readSettings();

  try {
    const response =
      await fetch(
        `${visionUrl}/health`
      );

    if (!response.ok) {
      return null;
    }

    return await response.json();
  } catch {
    return null;
  }
}


async function waitForVision(
  timeoutMs = 10000
) {
  const started =
    Date.now();

  /*
   * Snapshot the child PID, if Electron owns one.
   * If null, we are in manual/external mode.
   */
  const expectedPid =
    visionProcess?.pid ??
    null;

  while (
    Date.now() -
    started <
    timeoutMs
  ) {
    const health =
      await fetchVisionHealth();

    if (health?.ok) {
      /*
       * Manual service:
       * No Electron child exists, so a healthy GoTutor endpoint is
       * intentionally accepted.
       */
      if (
        expectedPid ==
        null
      ) {
        debugLog(
          "vision",
          "external-instance-confirmed",
          {
            processId:
              health.processId,
            sessionId:
              health.sessionId,
            debugEnabled:
              health.debugEnabled
          }
        );

        return true;
      }

      /*
       * Electron-managed service:
       * Keep the PID safety check.
       */
      if (
        Number(
          health.processId
        ) ===
        Number(
          expectedPid
        )
      ) {
        debugLog(
          "vision",
          "spawned-instance-confirmed",
          {
            processId:
              health.processId,
            sessionId:
              health.sessionId,
            debugEnabled:
              health.debugEnabled
          }
        );

        return true;
      }

      throw new Error(
        "Port 8765 is responding, but it belongs to a different " +
        `process than the Electron-managed vision service ` +
        `(expected PID ${expectedPid}, got ${health.processId}).`
      );
    }

    /*
     * In Electron-managed mode, if that exact child has died before
     * /health became available, surface the real failure.
     *
     * In manual mode there is intentionally no child process, so
     * visionProcess === null is NOT an error.
     */
    if (
      expectedPid != null &&
      (
        !visionProcess ||
        Number(
          visionProcess.pid
        ) !==
        Number(
          expectedPid
        )
      )
    ) {
      throw new Error(
        "The Electron-managed GoTutor vision service exited " +
        "before it became ready."
      );
    }

    await delay(
      250
    );
  }

  return false;
}

function linspace(
  start,
  end,
  count
) {
  if (count <= 1) {
    return [
      start
    ];
  }

  const values = [];

  for (
    let index = 0;
    index < count;
    index++
  ) {
    values.push(
      start +
      (
        (end - start) *
        index
      ) /
      (count - 1)
    );
  }

  return values;
}

async function sampleProjectedPoint(x,y,phase) {
  sendPattern({type:"black"});
  await delay(280);

  let reference;
  try {
    reference = await visionPost("/calibration/reference",{projector:{x,y},phase});
  } catch (error) {
    return {found:false,reason:"reference_error",error:error.message};
  }

  sendPattern({type:"dot",x,y,radius:0.014});
  await delay(300);

  let sample;
  try {
    sample = await visionPost("/calibration/sample",{projector:{x,y},phase});
  } catch (error) {
    sample = {found:false,reason:"request_error",error:error.message};
  }

  debugLog("calibration","sample-result",{x,y,phase,reference,sample});
  sendPattern({type:"black"});
  await delay(220);
  return sample;
}

function expandedRegion(
  samples,
  margin = 0.10
) {
  const xs =
    samples.map(
      sample =>
        sample.projector[0]
    );

  const ys =
    samples.map(
      sample =>
        sample.projector[1]
    );

  let minX =
    Math.min(...xs);

  let maxX =
    Math.max(...xs);

  let minY =
    Math.min(...ys);

  let maxY =
    Math.max(...ys);

  const width =
    Math.max(
      maxX - minX,
      0.08
    );

  const height =
    Math.max(
      maxY - minY,
      0.08
    );

  minX =
    Math.max(
      0.01,
      minX -
        width *
        margin
    );

  maxX =
    Math.min(
      0.99,
      maxX +
        width *
        margin
    );

  minY =
    Math.max(
      0.01,
      minY -
        height *
        margin
    );

  maxY =
    Math.min(
      0.99,
      maxY +
        height *
        margin
    );

  return {
    minX,
    maxX,
    minY,
    maxY
  };
}

async function runAutomaticCalibration(
  displayId = null
) {
  debugLog("calibration","run-start",{displayId});

  const display =
    resolveProjectorDisplay(
      displayId
    );

  if (!display) {
    throw new Error(
      "No external projector/display is available."
    );
  }

  /*
   * If the manually started service disappeared, or if Electron
   * never started one, make one more attempt to establish a valid
   * vision service before calibration.
   */
  if (
    !(await fetchVisionHealth())?.ok
  ) {
    await startVisionService();
  }

  const ready =
    await waitForVision();

  if (!ready) {
    throw new Error(
      "The OpenCV service did not start."
    );
  }

  if (
    !projectorWindow ||
    projectorWindow.isDestroyed()
  ) {
    createProjectorWindow(
      display
    );

    await delay(
      1000
    );
  }

  writeSettings({
    projectorDisplayId:
      String(
        display.id
      )
  });

  /*
   * CALIBRATION START
   *
   * IMPORTANT:
   * Lock board geometry while the board is still illuminated.
   * The previous implementation turned the projector black and
   * then re-ran contour detection. In the debug logs that caused
   * the selected board rectangle to jump by more than 100 camera
   * pixels between otherwise similar calibration runs.
   */
  const calibrationSettings =
    readSettings();

  const illuminationLevel =
    clamp01(
      calibrationSettings
        .boardIllumination ??
      0.72
    );

  sendSolidIllumination(
    illuminationLevel
  );

  await delay(
    900
  );

  await visionPost(
    "/calibration/reset"
  );

  /*
   * Give the camera several fresh illuminated frames after reset.
   * The Python service forms a median consensus from recent board
   * detections rather than trusting one contour.
   */
  await delay(
    650
  );

  const boardLock =
    await visionPost(
      "/calibration/board-lock"
    );

  debugLog(
    "calibration",
    "board-locked",
    boardLock
  );

  mainWindow
    ?.webContents
    .send(
      "calibration:progress",
      {
        stage:
          "board",

        message:
          `Board geometry locked from ` +
          `${boardLock.sampleCount} illuminated frames — ` +
          `${boardLock.maxDeviation.toFixed(1)} px max variation, ` +
          `${Math.round(
            boardLock.score *
            100
          )}% confidence`
      }
    );

  /*
   * Geometry is now frozen. Switch black only for optical dot
   * calibration/reference capture; do not redetect board edges.
   */
  sendPattern({
    type:
      "black"
  });

  await delay(
    650
  );

  await visionPost(
    "/calibration/baseline"
  );

  const coarseXs =
    linspace(
      0.04,
      0.96,
      9
    );

  const coarseYs =
    linspace(
      0.06,
      0.94,
      7
    );

  const coarseSamples = [];

  let coarseAttempt = 0;
  const coarseRejected = {};

  for (
    const y of coarseYs
  ) {
    for (
      const x of coarseXs
    ) {
      coarseAttempt++;

      const sample =
        await sampleProjectedPoint(
          x,
          y,
          "coarse"
        );

      if (sample?.found) {
        coarseSamples.push(sample);
      } else {
        const reason = sample?.reason || "not_found";
        coarseRejected[reason] = (coarseRejected[reason] || 0) + 1;
      }

      mainWindow
        ?.webContents
        .send(
          "calibration:progress",
          {
            stage:
              "coarse",

            message:
              `Coarse scan: ${coarseSamples.length} accepted / ${coarseAttempt} tested`
          }
        );
    }
  }

  if (
    coarseSamples.length <
    4
  ) {
    sendPattern({
      type:
        "black"
    });

    throw new Error(
      `Only ${coarseSamples.length} projector points ` +
      `were visible during the coarse scan. ` +
      `The camera needs to see more of the projected area.`
    );
  }

  const coarseModel = await visionPost("/calibration/coarse-model");
  debugLog("calibration","coarse-model",coarseModel);
  mainWindow?.webContents.send("calibration:progress",{
    stage:"roi",
    message:`Coarse model: ${coarseModel.inliers} inliers, ${coarseModel.medianError.toFixed(1)} px median error. Dense points are now position-validated.`
  });

  const region =
    expandedRegion(
      coarseSamples,
      0.18
    );

  mainWindow
    ?.webContents
    .send(
      "calibration:progress",
      {
        stage:
          "roi",

        message:
          "Visible projector region found. " +
          "Starting dense calibration scan."
      }
    );

  const denseXs =
    linspace(
      region.minX,
      region.maxX,
      9
    );

  const denseYs =
    linspace(
      region.minY,
      region.maxY,
      9
    );

  let denseFound =
    0;

  let denseAttempt = 0;
  const denseRejected = {not_visible:0,wrong_location:0,low_confidence:0,stale_frame:0,reference_mismatch:0,other:0};

  for (
    const y of denseYs
  ) {
    for (
      const x of denseXs
    ) {
      denseAttempt++;

      const sample =
        await sampleProjectedPoint(
          x,
          y,
          "dense"
        );

      if (sample?.found) {
        denseFound++;
      } else {
        const reason = sample?.reason || "other";
        if (Object.hasOwn(denseRejected,reason)) denseRejected[reason]++;
        else denseRejected.other++;
      }

      mainWindow
        ?.webContents
        .send(
          "calibration:progress",
          {
            stage:
              "dense",

            message:
              `Dense: ${denseFound} accepted / ${denseAttempt} tested — ` +
              `${denseRejected.not_visible} not visible, ${denseRejected.wrong_location} wrong location, ` +
              `${denseRejected.low_confidence} low confidence, ${denseRejected.stale_frame} stale`
          }
        );
    }
  }

  sendPattern({
    type:
      "black"
  });

  const solved = await visionPost("/calibration/solve");
  debugLog("calibration","solve-complete",{solved,coarseRejected,denseRejected});

  writeSettings({
    projectorDisplayId:
      String(
        display.id
      ),

    calibration:
      solved
  });

  /*
   * Show the solved 19x19 grid briefly so the user can
   * visually verify alignment.
   */
  const currentSettings =
    readSettings();

  sendPattern({
    type:
      "board-test",

    homography:
      solved
        .boardToProjectorHomography,

    boardQuad:
      solved
        .boardQuadProjector,

    gridInsetX:
      Number(
        currentSettings.gridInsetX ??
        0.035
      ),

    gridInsetY:
      Number(
        currentSettings.gridInsetY ??
        0.035
      )
  });

  mainWindow
    ?.webContents
    .send(
      "calibration:complete",
      solved
    );

  /*
   * IMPORTANT:
   * The verification grid must not remain active during
   * physical stone tracking.
   */
  setTimeout(
    () => {
      sendPattern({
        type:
          "black"
      });
    },
    3000
  );

  return solved;
}



function ensureConfigDirectory() {
  fs.mkdirSync(
    path.dirname(KATAGO_PATHS_PATH),
    { recursive: true }
  );
}

function toStoredPath(value) {
  const raw = String(value || "").trim();

  if (!raw) return "";

  if (!path.isAbsolute(raw)) {
    return raw;
  }

  const relative = path.relative(ROOT, raw);

  if (
    relative &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  ) {
    return `./${relative.replaceAll(path.sep, "/")}`;
  }

  return raw;
}

function fromStoredPath(value) {
  const raw = String(value || "").trim();

  if (!raw) return "";

  if (
    raw.startsWith("./") ||
    raw.startsWith("../")
  ) {
    return path.resolve(ROOT, raw);
  }

  return raw;
}

function readKataGoPaths() {
  try {
    const data = JSON.parse(
      fs.readFileSync(
        KATAGO_PATHS_PATH,
        "utf8"
      )
    );

    return {
      executablePath:
        data.executablePath || "katago",

      modelPath:
        data.modelPath || "",

      configPath:
        data.configPath || ""
    };
  } catch {
    const settings = readSettings();

    return {
      executablePath:
        settings.katagoExecutablePath ||
        "katago",

      modelPath:
        settings.katagoModelPath ||
        "",

      configPath:
        settings.katagoConfigPath ||
        ""
    };
  }
}

function writeKataGoPaths(values) {
  ensureConfigDirectory();

  const stored = {
    version: 1,

    executablePath:
      toStoredPath(
        values.executablePath ||
        "katago"
      ),

    modelPath:
      toStoredPath(
        values.modelPath ||
        ""
      ),

    configPath:
      toStoredPath(
        values.configPath ||
        ""
      )
  };

  fs.writeFileSync(
    KATAGO_PATHS_PATH,
    JSON.stringify(
      stored,
      null,
      2
    ) + "\n"
  );

  writeSettings({
    katagoExecutablePath:
      stored.executablePath,

    katagoModelPath:
      stored.modelPath,

    katagoConfigPath:
      stored.configPath
  });

  return {
    version:
      stored.version,

    executablePath:
      fromStoredPath(
        stored.executablePath
      ),

    modelPath:
      fromStoredPath(
        stored.modelPath
      ),

    configPath:
      fromStoredPath(
        stored.configPath
      )
  };
}

function resolvedKataGoPaths() {
  const saved = readKataGoPaths();

  return {
    executablePath:
      fromStoredPath(
        saved.executablePath
      ) || "katago",

    modelPath:
      fromStoredPath(
        saved.modelPath
      ),

    configPath:
      fromStoredPath(
        saved.configPath
      )
  };
}

function findFirstFile(
  directory,
  predicate,
  maxDepth = 3,
  depth = 0
) {
  if (
    !directory ||
    depth > maxDepth ||
    !fs.existsSync(directory)
  ) {
    return null;
  }

  let entries;

  try {
    entries = fs.readdirSync(
      directory,
      { withFileTypes: true }
    );
  } catch {
    return null;
  }

  for (const entry of entries) {
    const full = path.join(
      directory,
      entry.name
    );

    if (
      entry.isFile() &&
      predicate(entry.name, full)
    ) {
      return full;
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const found = findFirstFile(
      path.join(
        directory,
        entry.name
      ),
      predicate,
      maxDepth,
      depth + 1
    );

    if (found) {
      return found;
    }
  }

  return null;
}

function detectKataGoPaths() {
  const saved =
    resolvedKataGoPaths();

  const detected = {
    executablePath:
      saved.executablePath ||
      "katago",

    modelPath:
      saved.modelPath ||
      "",

    configPath:
      saved.configPath ||
      "",

    source: []
  };

  const localRoot = path.join(
    ROOT,
    "local",
    "katago"
  );

  const localExecutableCandidates =
    process.platform === "win32"
      ? [
          path.join(
            localRoot,
            "katago.exe"
          ),
          path.join(
            localRoot,
            "bin",
            "katago.exe"
          )
        ]
      : [
          path.join(
            localRoot,
            "katago"
          ),
          path.join(
            localRoot,
            "bin",
            "katago"
          )
        ];

  const localExecutable =
    localExecutableCandidates.find(
      candidate =>
        fs.existsSync(candidate)
    );

  const isModel = name =>
    name.endsWith(".bin.gz") ||
    name.endsWith(".bin") ||
    name.endsWith(".onnx");

  const localModel =
    findFirstFile(
      path.join(
        localRoot,
        "models"
      ),
      isModel
    ) ||
    findFirstFile(
      localRoot,
      isModel
    );

  const localConfig =
    findFirstFile(
      path.join(
        localRoot,
        "configs"
      ),
      name =>
        name.endsWith(".cfg")
    ) ||
    findFirstFile(
      localRoot,
      name =>
        name.endsWith(".cfg")
    );

  if (localExecutable) {
    detected.executablePath =
      localExecutable;

    detected.source.push(
      "project-local executable"
    );
  }

  if (localModel) {
    detected.modelPath =
      localModel;

    detected.source.push(
      "project-local model"
    );
  }

  if (localConfig) {
    detected.configPath =
      localConfig;

    detected.source.push(
      "project-local config"
    );
  }

  if (process.platform === "darwin") {
    const brew = spawnSync(
      "brew",
      [
        "--prefix",
        "katago"
      ],
      {
        encoding: "utf8"
      }
    );

    if (brew.status === 0) {
      const prefix =
        brew.stdout.trim();

      if (prefix) {
        const brewExecutable =
          path.join(
            prefix,
            "bin",
            "katago"
          );

        const shareRoot =
          path.join(
            prefix,
            "share"
          );

        const brewModel =
          findFirstFile(
            shareRoot,
            isModel,
            5
          );

        const brewConfig =
          findFirstFile(
            shareRoot,
            name =>
              name === "gtp_example.cfg" ||
              name.endsWith(".cfg"),
            5
          );

        if (
          !localExecutable &&
          fs.existsSync(
            brewExecutable
          )
        ) {
          detected.executablePath =
            brewExecutable;

          detected.source.push(
            "Homebrew executable"
          );
        }

        if (
          !localModel &&
          brewModel
        ) {
          detected.modelPath =
            brewModel;

          detected.source.push(
            "Homebrew model"
          );
        }

        if (
          !localConfig &&
          brewConfig
        ) {
          detected.configPath =
            brewConfig;

          detected.source.push(
            "Homebrew config"
          );
        }
      }
    }
  }

  if (
    !localExecutable &&
    (
      !detected.executablePath ||
      detected.executablePath === "katago"
    )
  ) {
    detected.executablePath =
      "katago";

    detected.source.push(
      "PATH executable"
    );
  }

  const savedResult =
    writeKataGoPaths(
      detected
    );

  return {
    ...savedResult,
    source:
      detected.source
  };
}


function kataGoSettingsFrom(override = {}) {
  const saved =
    resolvedKataGoPaths();

  return {
    executablePath:
      override.executablePath ||
      saved.executablePath ||
      "katago",

    modelPath:
      override.modelPath ||
      saved.modelPath ||
      "",

    configPath:
      override.configPath ||
      saved.configPath ||
      ""
  };
}

async function ensureKataGo(override = {}) {
  const config = kataGoSettingsFrom(override);
  const key = JSON.stringify(config);

  if (kataGoEngine && kataGoEngineKey !== key) {
    kataGoEngine.stop();
    kataGoEngine = null;
    kataGoEngineKey = null;
  }

  if (!kataGoEngine) {
    kataGoEngine = new KataGoGtp(config);
    kataGoEngineKey = key;
  }

  await kataGoEngine.start();
  return kataGoEngine;
}

function createMainWindow() {
  mainWindow =
    new BrowserWindow({
      width:
        1280,

      height:
        850,

      minWidth:
        1000,

      minHeight:
        700,

      backgroundColor:
        "#111318",

      webPreferences: {
        preload:
          path.join(
            __dirname,
            "preload.cjs"
          ),

        contextIsolation:
          true,

        nodeIntegration:
          false
      }
    });

  mainWindow.loadFile(
    path.join(
      ROOT,
      "ui",
      "index.html"
    )
  );
}

app.whenReady().then(
  async () => {
    await startVisionService();

    createMainWindow();

    screen.on(
      "display-added",
      (
        _event,
        display
      ) => {
        mainWindow
          ?.webContents
          .send(
            "displays:changed",
            getDisplays()
          );

        /*
         * Do NOT automatically calibrate anymore.
         *
         * The renderer will decide whether to open/illuminate
         * the newly connected projector, then wait for board
         * detection before enabling calibration.
         */
        mainWindow
          ?.webContents
          .send(
            "projector:detected",
            serializeDisplay(
              display
            )
          );
      }
    );

    screen.on(
      "display-removed",
      () => {
        mainWindow
          ?.webContents
          .send(
            "displays:changed",
            getDisplays()
          );
      }
    );

    screen.on(
      "display-metrics-changed",
      () => {
        mainWindow
          ?.webContents
          .send(
            "displays:changed",
            getDisplays()
          );
      }
    );
  }
);

app.on(
  "window-all-closed",
  () => {
    if (
      process.platform !==
      "darwin"
    ) {
      app.quit();
    }
  }
);

app.on(
  "before-quit",
  () => {
    if (
      visionProcess
    ) {
      visionProcess.kill();

      visionProcess =
        null;
    }

    if (
      kataGoEngine
    ) {
      kataGoEngine.stop();
      kataGoEngine = null;
      kataGoEngineKey = null;
    }
  }
);

ipcMain.handle(
  "settings:get",
  () =>
    readSettings()
);

ipcMain.handle(
  "settings:set",
  (
    _event,
    patch
  ) =>
    writeSettings(
      patch
    )
);

ipcMain.handle(
  "displays:list",
  () =>
    getDisplays()
);

ipcMain.handle(
  "projector:open",
  (
    _event,
    displayId
  ) => {
    const display =
      resolveProjectorDisplay(
        displayId
      );

    if (!display) {
      throw new Error(
        "Selected display not found."
      );
    }

    createProjectorWindow(
      display
    );

    writeSettings({
      projectorDisplayId:
        String(
          display.id
        )
    });

    return serializeDisplay(
      display
    );
  }
);

ipcMain.handle(
  "projector:close",
  () => {
    if (
      projectorWindow &&
      !projectorWindow.isDestroyed()
    ) {
      projectorWindow.close();

      projectorWindow =
        null;
    }

    return true;
  }
);

/*
 * NEW:
 * Generic solid illumination control.
 *
 * level:
 *   0.0 = black
 *   1.0 = full white
 */
ipcMain.handle(
  "projector:solid",
  (
    _event,
    level
  ) => {
    sendSolidIllumination(
      level
    );

    return true;
  }
);

/*
 * Convenience command used by gameplay/stone capture.
 */
ipcMain.handle(
  "projector:black",
  () => {
    sendPattern({
      type:
        "black"
    });

    return true;
  }
);

ipcMain.handle(
  "projector:identify",
  async () => {
    const displays =
      screen.getAllDisplays();

    for (
      const display
      of displays
    ) {
      const win =
        new BrowserWindow({
          x:
            display.bounds.x,

          y:
            display.bounds.y,

          width:
            display.bounds.width,

          height:
            display.bounds.height,

          frame:
            false,

          alwaysOnTop:
            true,

          focusable:
            false,

          backgroundColor:
            "#000000",

          webPreferences: {
            contextIsolation:
              true,

            nodeIntegration:
              false
          }
        });

      const label =
        display.label ||
        `Display ${display.id}`;

      const html =
        encodeURIComponent(`
          <!doctype html>
          <html>
            <body style="
              margin:0;
              background:#000;
              color:#fff;
              width:100vw;
              height:100vh;
              display:grid;
              place-items:center;
              font-family:system-ui;
              text-align:center">
              <div>
                <div style="
                  font-size:12vw;
                  font-weight:900">
                  ${display.id}
                </div>

                <div style="
                  font-size:3vw">
                  ${label}
                </div>
              </div>
            </body>
          </html>
        `);

      win.loadURL(
        `data:text/html;charset=utf-8,${html}`
      );

      setTimeout(
        () => {
          if (
            !win.isDestroyed()
          ) {
            win.close();
          }
        },
        2500
      );
    }

    return true;
  }
);

ipcMain.handle(
  "calibration:auto",
  (
    _event,
    displayId
  ) =>
    runAutomaticCalibration(
      displayId
    )
);


ipcMain.handle("debug:log",(_event,payload) => {
  debugLog(payload?.category || "renderer",payload?.event || "event",payload?.data ?? null);
  return true;
});

// ============================================================
// KATAGO / GAMEPLAY IPC
// ============================================================


ipcMain.handle(
  "katago:paths:get",
  () =>
    resolvedKataGoPaths()
);

ipcMain.handle(
  "katago:paths:set",
  (
    _event,
    values
  ) =>
    writeKataGoPaths(values)
);

ipcMain.handle(
  "katago:paths:detect",
  () =>
    detectKataGoPaths()
);


ipcMain.handle("katago:choose-file", async (_event, kind) => {
  const filters =
    kind === "config"
      ? [{name:"KataGo config",extensions:["cfg"]},{name:"All files",extensions:["*"]}]
      : kind === "model"
        ? [{name:"KataGo model",extensions:["gz","bin","txt","onnx"]},{name:"All files",extensions:["*"]}]
        : [{name:"All files",extensions:["*"]}];

  const result = await dialog.showOpenDialog(mainWindow,{
    properties:["openFile"],
    filters
  });

  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle("katago:test", async (_event, config) => {
  debugLog("katago","test-request",config);
  const engine = await ensureKataGo(config || {});
  const result = await engine.test();
  debugLog("katago","test-result",result);
  return result;
});

ipcMain.handle("katago:genmove", async (_event, payload) => {
  debugLog("katago","genmove-request",payload);
  const engine = await ensureKataGo(payload.katago || {});
  const result = await engine.genMove({
    boardSize: payload.boardSize || 19,
    komi: Number(payload.komi ?? 6.5),
    history: payload.history || [],
    color: payload.color
  });
  debugLog("katago","genmove-result",result);
  return result;
});

ipcMain.handle("game:render", (_event, payload) => {
  const settings = readSettings();
  const homography = settings.calibration?.boardToProjectorHomography;
  if (!homography) throw new Error("Projector calibration is not available.");

  sendPattern({
    type:"game",
    homography,
    virtualBoard: payload.virtualBoard || [],
    captureMarkers: payload.captureMarkers || [],
    hintMarkers: payload.hintMarkers || [],
    orientation: payload.orientation || "bottom",
    showSeatLabels: payload.showSeatLabels === true,
    gridInsetX: Number(
      payload.gridInsetX ??
      settings.gridInsetX ??
      0.035
    ),
    gridInsetY: Number(
      payload.gridInsetY ??
      settings.gridInsetY ??
      0.035
    ),

    projectedStoneScale: Number(
      payload.projectedStoneScale ??
      settings.projectedStoneScale ??
      0.78
    )
  });
  return true;
});

ipcMain.handle("game:orientation-preview", (_event, payload) => {
  const settings = readSettings();
  const homography = settings.calibration?.boardToProjectorHomography;
  if (!homography) throw new Error("Projector calibration is not available.");

  sendPattern({
    type:"orientation-preview",
    homography,
    orientation: payload?.orientation || "bottom",
    showSeatLabels: payload?.showSeatLabels !== false,
    gridInsetX: Number(
      payload?.gridInsetX ??
      settings.gridInsetX ??
      0.035
    ),
    gridInsetY: Number(
      payload?.gridInsetY ??
      settings.gridInsetY ??
      0.035
    )
  });
  return true;
});

ipcMain.handle(
  "projector:stone-zone-preview",
  (
    _event,
    payload
  ) => {
    const settings = readSettings();
    const homography =
      settings.calibration?.boardToProjectorHomography;

    if (!homography) {
      throw new Error(
        "Projector calibration is not available."
      );
    }

    sendPattern({
      type: "stone-zone-preview",
      homography,
      gridInsetX:
        Number(
          payload?.gridInsetX ??
          settings.gridInsetX ??
          0.035
        ),
      gridInsetY:
        Number(
          payload?.gridInsetY ??
          settings.gridInsetY ??
          0.035
        ),
      outsideTolerance:
        Number(
          payload?.outsideTolerance ??
          settings.stoneOutsideTolerance ??
          0.012
        )
    });

    return true;
  }
);


ipcMain.handle("projector:grid-preview", (_event, payload) => {
  const settings = readSettings();
  const homography = settings.calibration?.boardToProjectorHomography;

  if (!homography) {
    throw new Error("Projector calibration is not available.");
  }

  sendPattern({
    type: "board-test",
    homography,
    gridInsetX: Number(
      payload?.gridInsetX ??
      settings.gridInsetX ??
      0.035
    ),
    gridInsetY: Number(
      payload?.gridInsetY ??
      settings.gridInsetY ??
      0.035
    )
  });

  return true;
});

ipcMain.handle("game:clear-projection", () => {
  sendPattern({type:"black"});
  return true;
});
