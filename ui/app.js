import {
  EMPTY,
  BLACK,
  WHITE,
  createBoard,
  hashBoard,
  applyMove
} from "../game/rules.js";

// ============================================================
// DOM HELPERS
// ============================================================

const $ = selector =>
  document.querySelector(
    selector
  );


function sleep(ms) {
  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );
}

function debugLog(event,data=null,category="renderer") {
  try { window.goAR?.debugLog?.(category,event,data); } catch {}
}


// ============================================================
// CAMERA / PROJECTOR UI
// ============================================================

const cameraSelect =
  $("#cameraSelect");

const displaySelect =
  $("#displaySelect");

const resolutionSelect =
  $("#resolutionSelect");

const preview =
  $("#cameraPreview");

const frameCanvas =
  $("#frameCanvas");

const overlayCanvas =
  $("#overlayCanvas");

const visionStatus =
  $("#visionStatus");

const cameraStatus =
  $("#cameraStatus");

const projectorStatus =
  $("#projectorStatus");

const boardDetectionStatus =
  $("#boardDetectionStatus");

const runCalibrationButton =
  $("#runCalibration");

const calibrationStatus =
  $("#calibrationStatus");

const calibrationProgress =
  $("#calibrationProgress");

const gridInsetX =
  $("#gridInsetX");

const gridInsetY =
  $("#gridInsetY");

const gridInsetXValue =
  $("#gridInsetXValue");

const gridInsetYValue =
  $("#gridInsetYValue");

const toggleGridPreviewButton =
  $("#toggleGridPreview");

const resetGridInsetButton =
  $("#resetGridInset");

const stoneOutsideTolerance =
  $("#stoneOutsideTolerance");

const stoneOutsideToleranceValue =
  $("#stoneOutsideToleranceValue");

const stoneHardMaskInset =
  $("#stoneHardMaskInset");

const stoneHardMaskInsetValue =
  $("#stoneHardMaskInsetValue");

const stoneConfirmFrames =
  $("#stoneConfirmFrames");

const stoneConfirmFramesValue =
  $("#stoneConfirmFramesValue");

const showStoneMaskOnCamera =
  $("#showStoneMaskOnCamera");

const stoneMaskOverlay =
  $("#stoneMaskOverlay");

const toggleStoneZonePreviewButton =
  $("#toggleStoneZonePreview");

const resetStoneZoneButton =
  $("#resetStoneZone");

const cameraInfo =
  $("#cameraInfo");


// ============================================================
// NEW: BOARD ILLUMINATION UI
// ============================================================

const illuminationLevel =
  $("#illuminationLevel");

const illuminationValue =
  $("#illuminationValue");

const illuminateOnLaunch =
  $("#illuminateOnLaunch");


// ============================================================
// PHYSICAL STONE TRACKING UI
// ============================================================

const stoneStatus =
  $("#stoneStatus");

const logicalBoard =
  $("#logicalBoard");

const logicalBoardContext =
  logicalBoard.getContext(
    "2d"
  );


// ============================================================
// GAME / KATAGO UI
// ============================================================

const gameMode = $("#gameMode");
const projectedStoneScale = $("#projectedStoneScale");
const projectedStoneScaleValue = $("#projectedStoneScaleValue");
const boardOrientation = $("#boardOrientation");
const showSeatLabels = $("#showSeatLabels");
const previewOrientationButton = $("#previewOrientation");
const gameKomi = $("#gameKomi");
const katagoExecutable = $("#katagoExecutable");
const katagoModel = $("#katagoModel");
const katagoConfig = $("#katagoConfig");
const katagoStatus = $("#katagoStatus");
const gameStatus = $("#gameStatus");
const passMoveButton = $("#passMove");
const teachHintButton = $("#teachHint");
const resignGameButton = $("#resignGame");


// ============================================================
// APPLICATION STATE
// ============================================================

let stream = null;

let frameTimer = null;

let settings = null;

let latestBoard = null;

let latestBoardScore = 0;

let boardDetected = false;

// NEW:
// While calibration is running, live camera/board-detection updates
// must not alter calibration controls or status text.
let isCalibrating = false;

let projectorOpen = false;

let stoneTrackingTimer = null;

let physicalBoard =
  Array.from(
    {
      length: 19
    },
    () =>
      Array(19).fill(0)
  );

const GO_COLUMNS =
  "ABCDEFGHJKLMNOPQRST";


// ============================================================
// GAME STATE
// ============================================================

const GAME_IDLE = "IDLE";
const GAME_WAITING_HUMAN = "WAITING_HUMAN";
const GAME_AI_THINKING = "AI_THINKING";
const GAME_WAITING_CAPTURE_REMOVAL = "WAITING_CAPTURE_REMOVAL";
const GAME_WAITING_ILLEGAL_REMOVAL = "WAITING_ILLEGAL_REMOVAL";
const GAME_OVER = "GAME_OVER";

let gameActive = false;
let gameState = GAME_IDLE;
let logicalGameBoard = createBoard(19);
let gameHistory = [];
let gameBoardHashes = [hashBoard(logicalGameBoard)];
let pendingCaptureRemoval = [];
let illegalPhysicalMove = null;
let teachHint = null;
let stoneBaselineCaptured = false;
let stonePollBusy = false;
let orientationPreviewActive = false;
let gridPreviewActive = false;
let stoneZonePreviewActive = false;


// ============================================================
// CONSTANTS
// ============================================================

const BOARD_DETECTION_THRESHOLD =
  0.50;


// ============================================================
// STATUS HELPERS
// ============================================================

function setPill(
  element,
  text,
  kind = ""
) {
  element.textContent =
    text;

  element.className =
    `pill ${kind}`.trim();
}


// ============================================================
// PROJECTOR ILLUMINATION
// ============================================================

function currentIllumination() {
  return (
    Number(
      illuminationLevel.value
    ) /
    100
  );
}


async function applyBoardIllumination() {
  /*
   * Calibration owns the projector output exclusively.
   * display-metrics-changed can fire when the projector window
   * enters fullscreen; without this guard it can re-apply the
   * white/gray illumination field over calibration dots.
   */
  if (isCalibrating) {
    return;
  }

  if (
    !displaySelect.value
  ) {
    return;
  }

  if (!projectorOpen) {
    const display =
      await window.goAR
        .openProjector(
          displaySelect.value
        );

    projectorOpen =
      true;

    setPill(
      projectorStatus,
      `Projector: ${display.label}`,
      "good"
    );
  }

  await window.goAR
    .setProjectorIllumination(
      currentIllumination()
    );
}


async function setProjectorBlack() {
  await window.goAR
    .blackProjector();
}



// ============================================================
// GRID ALIGNMENT
// ============================================================

function currentGridInsetX() {
  return Number(
    gridInsetX.value
  ) / 100;
}

function currentGridInsetY() {
  return Number(
    gridInsetY.value
  ) / 100;
}


function currentProjectedStoneScale() {
  return Number(
    projectedStoneScale.value
  ) / 100;
}

function updateProjectedStoneScaleLabel() {
  projectedStoneScaleValue.textContent =
    `${Math.round(
      Number(
        projectedStoneScale.value
      )
    )}%`;
}

function updateGridInsetLabels() {
  gridInsetXValue.textContent =
    `${Number(gridInsetX.value).toFixed(1)}%`;

  gridInsetYValue.textContent =
    `${Number(gridInsetY.value).toFixed(1)}%`;
}

async function pushGridInsetToVision() {
  if (!settings?.visionUrl) {
    return;
  }

  const response =
    await fetch(
      `${settings.visionUrl}/stones/grid-inset`,
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/json"
        },
        body: JSON.stringify({
          x:
            currentGridInsetX(),
          y:
            currentGridInsetY()
        })
      }
    );

  if (!response.ok) {
    throw new Error(
      await response.text()
    );
  }
}

async function saveGridInsets() {
  settings =
    await window.goAR
      .setSettings({
        gridInsetX:
          currentGridInsetX(),

        gridInsetY:
          currentGridInsetY()
      });

  await pushGridInsetToVision();
}

async function refreshGridPreview() {
  if (!gridPreviewActive) {
    return;
  }

  await window.goAR
    .renderGridPreview({
      gridInsetX:
        currentGridInsetX(),

      gridInsetY:
        currentGridInsetY()
    });
}


function currentStoneOutsideTolerance() {
  return Number(
    stoneOutsideTolerance.value
  ) / 100;
}


function currentStoneHardMaskInset() {
  return Number(
    stoneHardMaskInset.value
  ) / 100;
}

function currentStoneConfirmFrames() {
  return Math.max(
    2,
    Math.min(
      8,
      Number(
        stoneConfirmFrames.value
      ) || 4
    )
  );
}

function updateStoneHardMaskLabels() {
  stoneHardMaskInsetValue.textContent =
    `${Number(
      stoneHardMaskInset.value
    ).toFixed(1)}%`;

  stoneConfirmFramesValue.textContent =
    String(
      currentStoneConfirmFrames()
    );
}

function drawStoneMaskOverlay() {
  if (
    !stoneMaskOverlay ||
    !cameraPreview
  ) {
    return;
  }

  const rect =
    cameraPreview.getBoundingClientRect();

  const dpr =
    window.devicePixelRatio ||
    1;

  stoneMaskOverlay.width =
    Math.max(
      1,
      Math.round(
        rect.width *
        dpr
      )
    );

  stoneMaskOverlay.height =
    Math.max(
      1,
      Math.round(
        rect.height *
        dpr
      )
    );

  stoneMaskOverlay.style.width =
    `${rect.width}px`;

  stoneMaskOverlay.style.height =
    `${rect.height}px`;

  const ctx =
    stoneMaskOverlay.getContext(
      "2d"
    );

  ctx.setTransform(
    dpr,
    0,
    0,
    dpr,
    0,
    0
  );

  ctx.clearRect(
    0,
    0,
    rect.width,
    rect.height
  );

  if (
    !showStoneMaskOnCamera.checked ||
    !latestBoard ||
    latestBoard.length !== 4 ||
    !cameraPreview.videoWidth ||
    !cameraPreview.videoHeight
  ) {
    return;
  }

  const videoAspect =
    cameraPreview.videoWidth /
    cameraPreview.videoHeight;

  const viewAspect =
    rect.width /
    rect.height;

  let drawWidth;
  let drawHeight;
  let offsetX;
  let offsetY;

  if (
    viewAspect >
    videoAspect
  ) {
    drawHeight =
      rect.height;
    drawWidth =
      drawHeight *
      videoAspect;
    offsetX =
      (
        rect.width -
        drawWidth
      ) /
      2;
    offsetY =
      0;
  } else {
    drawWidth =
      rect.width;
    drawHeight =
      drawWidth /
      videoAspect;
    offsetX =
      0;
    offsetY =
      (
        rect.height -
        drawHeight
      ) /
      2;
  }

  const sx =
    drawWidth /
    cameraPreview.videoWidth;

  const sy =
    drawHeight /
    cameraPreview.videoHeight;

  const corners =
    latestBoard.map(
      point => [
        offsetX +
          point[0] *
          sx,
        offsetY +
          point[1] *
          sy
      ]
    );

  function bilerp(
    u,
    v
  ) {
    const top = [
      corners[0][0] +
        (
          corners[1][0] -
          corners[0][0]
        ) *
        u,
      corners[0][1] +
        (
          corners[1][1] -
          corners[0][1]
        ) *
        u
    ];

    const bottom = [
      corners[3][0] +
        (
          corners[2][0] -
          corners[3][0]
        ) *
        u,
      corners[3][1] +
        (
          corners[2][1] -
          corners[3][1]
        ) *
        u
    ];

    return [
      top[0] +
        (
          bottom[0] -
          top[0]
        ) *
        v,
      top[1] +
        (
          bottom[1] -
          top[1]
        ) *
        v
    ];
  }

  const gridX =
    currentGridInsetX();

  const gridY =
    currentGridInsetY();

  const tolerance =
    currentStoneOutsideTolerance();

  const hardInset =
    currentStoneHardMaskInset();

  const left =
    Math.max(
      0,
      gridX +
      hardInset -
      tolerance
    );

  const right =
    Math.min(
      1,
      1 -
      gridX -
      hardInset +
      tolerance
    );

  const top =
    Math.max(
      0,
      gridY +
      hardInset -
      tolerance
    );

  const bottom =
    Math.min(
      1,
      1 -
      gridY -
      hardInset +
      tolerance
    );

  const validPoly = [
    bilerp(
      left,
      top
    ),
    bilerp(
      right,
      top
    ),
    bilerp(
      right,
      bottom
    ),
    bilerp(
      left,
      bottom
    )
  ];

  ctx.save();

  ctx.fillStyle =
    "rgba(0,0,0,0.68)";

  ctx.fillRect(
    0,
    0,
    rect.width,
    rect.height
  );

  ctx.globalCompositeOperation =
    "destination-out";

  ctx.beginPath();

  validPoly.forEach(
    (
      point,
      index
    ) => {
      if (index === 0) {
        ctx.moveTo(
          point[0],
          point[1]
        );
      } else {
        ctx.lineTo(
          point[0],
          point[1]
        );
      }
    }
  );

  ctx.closePath();
  ctx.fill();
  ctx.restore();

  ctx.beginPath();

  validPoly.forEach(
    (
      point,
      index
    ) => {
      if (index === 0) {
        ctx.moveTo(
          point[0],
          point[1]
        );
      } else {
        ctx.lineTo(
          point[0],
          point[1]
        );
      }
    }
  );

  ctx.closePath();

  ctx.strokeStyle =
    "rgba(255,64,64,0.95)";

  ctx.lineWidth =
    3;

  ctx.stroke();
}

function updateStoneOutsideToleranceLabel() {
  stoneOutsideToleranceValue.textContent =
    `${Number(
      stoneOutsideTolerance.value
    ).toFixed(1)}%`;
}

async function pushStoneBoundaryToVision() {
  if (!settings?.visionUrl) {
    return;
  }

  const response =
    await fetch(
      `${settings.visionUrl}/stones/detection-boundary`,
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/json"
        },
        body:
          JSON.stringify({
            outsideTolerance:
              currentStoneOutsideTolerance(),
            hardMaskInset:
              currentStoneHardMaskInset(),
            confirmFrames:
              currentStoneConfirmFrames()
          })
      }
    );

  if (!response.ok) {
    throw new Error(
      await response.text()
    );
  }
}

async function saveStoneBoundary() {
  settings =
    await window.goAR
      .setSettings({
        stoneOutsideTolerance:
          currentStoneOutsideTolerance(),
        stoneHardMaskInset:
          currentStoneHardMaskInset(),
        stoneConfirmFrames:
          currentStoneConfirmFrames(),
        showStoneMaskOnCamera:
          showStoneMaskOnCamera.checked
      });

  await pushStoneBoundaryToVision();
}

async function refreshStoneZonePreview() {
  if (!stoneZonePreviewActive) {
    return;
  }

  await window.goAR
    .renderStoneZonePreview({
      gridInsetX:
        currentGridInsetX(),

      gridInsetY:
        currentGridInsetY(),

      outsideTolerance:
        currentStoneOutsideTolerance()
    });
}

// ============================================================
// BOARD DETECTION STATE
// ============================================================

function updateBoardDetectionUI() {
  if (!stream) {
    boardDetected = false;

    if (!isCalibrating) {
      runCalibrationButton.disabled = true;
    }

    boardDetectionStatus.textContent =
      "Start the camera to detect the board.";

    return;
  }

  if (
    latestBoard?.length === 4 &&
    latestBoardScore >= BOARD_DETECTION_THRESHOLD
  ) {
    boardDetected = true;

    /*
     * IMPORTANT:
     * Board detection and calibration now own separate UI areas.
     *
     * This function is called for every incoming camera frame,
     * so it must NEVER overwrite calibrationStatus while a
     * calibration scan is running.
     */
    if (!isCalibrating) {
      runCalibrationButton.disabled = false;
    }

    boardDetectionStatus.innerHTML =
      `<strong>Board found</strong><br>` +
      `Confidence: ` +
      `${Math.round(
        latestBoardScore * 100
      )}%`;

    return;
  }

  boardDetected = false;

  if (!isCalibrating) {
    runCalibrationButton.disabled = true;
  }

  boardDetectionStatus.innerHTML =
    `<strong>Searching for board…</strong><br>` +
    `Current confidence: ` +
    `${Math.round(
      latestBoardScore * 100
    )}%`;
}

// ============================================================
// VISION SERVICE HEALTH
// ============================================================

async function healthCheck() {
  try {
    const response =
      await fetch(
        `${settings.visionUrl}/health`
      );

    if (!response.ok) {
      throw new Error(
        "Vision service not ready."
      );
    }

    setPill(
      visionStatus,
      "Vision ready",
      "good"
    );

    return true;
  }

  catch {
    setPill(
      visionStatus,
      "Vision unavailable",
      "bad"
    );

    return false;
  }
}


// ============================================================
// CAMERA ENUMERATION
// ============================================================

async function enumerateCameras() {
  try {
    const temporaryStream =
      await navigator
        .mediaDevices
        .getUserMedia({
          video:
            true,

          audio:
            false
        });

    temporaryStream
      .getTracks()
      .forEach(
        track =>
          track.stop()
      );
  }

  catch (error) {
    cameraInfo.textContent =
      `Camera permission error: ${error.message}`;
  }

  const devices =
    await navigator
      .mediaDevices
      .enumerateDevices();

  const cameras =
    devices.filter(
      device =>
        device.kind ===
        "videoinput"
    );

  cameraSelect.innerHTML =
    "";

  for (
    const [
      index,
      camera
    ] of cameras.entries()
  ) {
    const option =
      document.createElement(
        "option"
      );

    option.value =
      camera.deviceId;

    option.textContent =
      camera.label ||
      `Camera ${index + 1}`;

    cameraSelect.append(
      option
    );
  }

  if (
    settings.cameraDeviceId &&
    [
      ...cameraSelect.options
    ].some(
      option =>
        option.value ===
        settings.cameraDeviceId
    )
  ) {
    cameraSelect.value =
      settings.cameraDeviceId;
  }

  return cameras;
}


// ============================================================
// DISPLAY ENUMERATION
// ============================================================

async function enumerateDisplays() {
  const displays =
    await window.goAR
      .listDisplays();

  displaySelect.innerHTML =
    "";

  for (
    const display
    of displays
  ) {
    const option =
      document.createElement(
        "option"
      );

    option.value =
      display.id;

    const role =
      display.primary
        ? "Primary"
        : "External";

    const internal =
      display.internal
        ? ", internal"
        : "";

    option.textContent =
      `${display.label} — ` +
      `${display.size.width}×${display.size.height} ` +
      `(${role}${internal})`;

    displaySelect.append(
      option
    );
  }

  const external =
    displays.find(
      display =>
        !display.primary
    );

  if (
    settings.projectorDisplayId &&
    displays.some(
      display =>
        display.id ===
        settings.projectorDisplayId
    )
  ) {
    displaySelect.value =
      settings.projectorDisplayId;
  }

  else if (external) {
    displaySelect.value =
      external.id;
  }

  if (external) {
    setPill(
      projectorStatus,
      `External display: ${external.label}`,
      "good"
    );
  }

  else {
    setPill(
      projectorStatus,
      "No external display",
      "warn"
    );
  }

  return displays;
}


// ============================================================
// CAMERA STARTUP
// ============================================================

function parseResolution() {
  const [
    width,
    height
  ] =
    resolutionSelect
      .value
      .split("x")
      .map(Number);

  return {
    width,
    height
  };
}


async function startCamera() {
  if (stream) {
    stream
      .getTracks()
      .forEach(
        track =>
          track.stop()
      );
  }

  const {
    width,
    height
  } =
    parseResolution();

  const deviceId =
    cameraSelect.value;

  const constraints = {
    audio:
      false,

    video: {
      deviceId:
        deviceId
          ? {
              exact:
                deviceId
            }
          : undefined,

      width: {
        ideal:
          width
      },

      height: {
        ideal:
          height
      },

      frameRate: {
        ideal:
          30,

        max:
          30
      }
    }
  };

  stream =
    await navigator
      .mediaDevices
      .getUserMedia(
        constraints
      );

  preview.srcObject =
    stream;

  await new Promise(
    resolve => {
      if (
        preview.readyState >=
        2
      ) {
        resolve();
      }

      else {
        preview.onloadedmetadata =
          resolve;
      }
    }
  );

  const track =
    stream
      .getVideoTracks()[0];

  const actual =
    track.getSettings();

  settings =
    await window.goAR
      .setSettings({
        cameraDeviceId:
          deviceId ||
          actual.deviceId ||
          null
      });

  setPill(
    cameraStatus,
    track.label ||
      "Camera active",
    "good"
  );

  cameraInfo.textContent =
    `${actual.width || "?"}×` +
    `${actual.height || "?"} @ ` +
    `${actual.frameRate
      ? actual.frameRate.toFixed(
          1
        )
      : "?"} FPS`;

  frameCanvas.width =
    actual.width ||
    preview.videoWidth ||
    width;

  frameCanvas.height =
    actual.height ||
    preview.videoHeight ||
    height;

  overlayCanvas.width =
    frameCanvas.width;

  overlayCanvas.height =
    frameCanvas.height;

  if (
    frameTimer
  ) {
    clearInterval(
      frameTimer
    );
  }

  frameTimer =
    setInterval(
      sendFrame,
      125
    );

  await healthCheck();

  updateBoardDetectionUI();
}


// ============================================================
// CAMERA -> PYTHON
// ============================================================

async function sendFrame() {
  if (
    !stream ||
    preview.readyState < 2
  ) {
    return;
  }

  const context =
    frameCanvas.getContext(
      "2d",
      {
        alpha:
          false
      }
    );

  context.drawImage(
    preview,
    0,
    0,
    frameCanvas.width,
    frameCanvas.height
  );

  const blob =
    await new Promise(
      resolve =>
        frameCanvas.toBlob(
          resolve,
          "image/jpeg",
          0.78
        )
    );

  if (!blob) {
    return;
  }

  try {
    const response =
      await fetch(
        `${settings.visionUrl}/frame`,
        {
          method:
            "POST",

          headers: {
            "Content-Type":
              "image/jpeg"
          },

          body:
            blob
        }
      );

    if (
      !response.ok
    ) {
      return;
    }

    const result =
      await response.json();

    latestBoardScore =
      Number(
        result.boardScore ||
        0
      );

    if (
      result.boardCorners
    ) {
      latestBoard =
        result.boardCorners;

      drawBoardOverlay();
      drawStoneMaskOverlay();
    }

    updateBoardDetectionUI();
  }

  catch {
    setPill(
      visionStatus,
      "Vision disconnected",
      "bad"
    );
  }
}


// ============================================================
// CAMERA DEBUG OVERLAY
// ============================================================

function drawBoardOverlay() {
  const context =
    overlayCanvas.getContext(
      "2d"
    );

  context.clearRect(
    0,
    0,
    overlayCanvas.width,
    overlayCanvas.height
  );

  if (
    !latestBoard?.length
  ) {
    return;
  }

  context.strokeStyle =
    "#00ff88";

  context.lineWidth =
    Math.max(
      2,
      overlayCanvas.width /
        500
    );

  context.beginPath();

  latestBoard.forEach(
    (
      [
        x,
        y
      ],
      index
    ) => {
      if (
        index === 0
      ) {
        context.moveTo(
          x,
          y
        );
      }

      else {
        context.lineTo(
          x,
          y
        );
      }
    }
  );

  context.closePath();

  context.stroke();

  for (
    const [
      x,
      y
    ]
    of latestBoard
  ) {
    context.beginPath();

    context.arc(
      x,
      y,
      7,
      0,
      Math.PI * 2
    );

    context.fillStyle =
      "#00ff88";

    context.fill();
  }
}


// ============================================================
// CALIBRATION
// ============================================================

async function runCalibration() {
  if (!stream) {
    throw new Error(
      "Start a camera first."
    );
  }

  if (!boardDetected) {
    throw new Error(
      "The physical board has not been detected confidently enough yet."
    );
  }

  if (isCalibrating) {
    return;
  }

  isCalibrating = true;

  calibrationProgress.max = 100;
  calibrationProgress.value = 0;

  /*
   * Keep this disabled for the ENTIRE calibration process.
   * updateBoardDetectionUI() will respect isCalibrating.
   */
  runCalibrationButton.disabled = true;

  calibrationStatus.textContent =
    "Starting calibration. Projector switching to black…";

  const displayId =
    displaySelect.value;

  try {
    await window.goAR
      .openProjector(
        displayId
      );

    projectorOpen = true;

    const solved =
      await window.goAR
        .autoCalibrate(
          displayId
        );

    calibrationStatus.innerHTML = `
      <strong>
        Calibration ${solved.quality}
      </strong>
      <br>

      Samples:
      ${solved.sampleCount}
      <br>

      RANSAC inliers:
      ${solved.inliers}
      <br>

      Mean error:
      ${solved.meanReprojectionError.toFixed(2)} px
      <br>

      Max error:
      ${solved.maxReprojectionError.toFixed(2)} px
    `;

    calibrationProgress.value = 100;

    return solved;
  }

  finally {
    isCalibrating = false;

    /*
     * Restore the button state using the latest live board
     * detection result after calibration finishes or throws.
     */
    runCalibrationButton.disabled =
      !boardDetected;
  }
}

// ============================================================
// GO COORDINATES
// ============================================================

function goCoordinate(
  x,
  y
) {
  return (
    GO_COLUMNS[x] +
    String(
      19 -
      y
    )
  );
}


function physicalToLogical(
  physicalX,
  physicalY,
  orientation = boardOrientation.value
) {
  const max = 18;
  switch (orientation) {
    case "top":
      return {x:max-physicalX, y:max-physicalY};
    case "left":
      return {x:physicalY, y:max-physicalX};
    case "right":
      return {x:max-physicalY, y:physicalX};
    case "bottom":
    default:
      return {x:physicalX, y:physicalY};
  }
}

function logicalToPhysical(
  logicalX,
  logicalY,
  orientation = boardOrientation.value
) {
  const max = 18;
  switch (orientation) {
    case "top":
      return {x:max-logicalX, y:max-logicalY};
    case "left":
      return {x:max-logicalY, y:logicalX};
    case "right":
      return {x:logicalY, y:max-logicalX};
    case "bottom":
    default:
      return {x:logicalX, y:logicalY};
  }
}


// ============================================================
// LOGICAL PHYSICAL BOARD
// ============================================================

function drawLogicalBoard() {
  const context = logicalBoardContext;
  const width = logicalBoard.width;
  const height = logicalBoard.height;

  context.clearRect(0,0,width,height);
  context.fillStyle = "#d5a95e";
  context.fillRect(0,0,width,height);

  const margin = 28;
  const boardWidth = width - margin*2;
  const step = boardWidth/18;

  context.strokeStyle = "#242424";
  context.lineWidth = 1;

  for (let i=0;i<19;i++) {
    const p = margin+i*step;
    context.beginPath();
    context.moveTo(margin,p);
    context.lineTo(width-margin,p);
    context.stroke();

    context.beginPath();
    context.moveTo(p,margin);
    context.lineTo(p,height-margin);
    context.stroke();
  }

  const stars = [[3,3],[9,3],[15,3],[3,9],[9,9],[15,9],[3,15],[9,15],[15,15]];
  context.fillStyle = "#222";

  for (const [x,y] of stars) {
    context.beginPath();
    context.arc(margin+x*step,margin+y*step,3,0,Math.PI*2);
    context.fill();
  }

  const boardToDraw = gameActive ? logicalGameBoard : physicalBoard;

  for (let y=0;y<19;y++) {
    for (let x=0;x<19;x++) {
      const value = boardToDraw[y][x];
      if (value === EMPTY) continue;

      const px = margin+x*step;
      const py = margin+y*step;

      context.beginPath();
      context.arc(px,py,step*0.43,0,Math.PI*2);

      if (value === BLACK) {
        context.fillStyle = "#080808";
        context.fill();
      } else if (value === WHITE) {
        context.fillStyle = "#f7f7f7";
        context.fill();
        context.strokeStyle = "#333";
        context.lineWidth = 1.5;
        context.stroke();
      }
    }
  }
}

// ============================================================
// EMPTY BOARD BASELINE
// ============================================================

async function captureEmptyBoard() {
  if (!stream) {
    stoneStatus.textContent =
      "Start the camera first.";

    return;
  }

  try {
    stoneStatus.textContent =
      "Preparing clean board image…";

    /*
     * Gameplay/stone recognition must use a clean black projector
     * background rather than the board-detection illumination.
     */
    await setProjectorBlack();

    await sleep(
      1000
    );

    stoneStatus.textContent =
      "Capturing empty-board reference…";

    /*
     * Keep physical-stone sampling aligned with the same grid
     * insets used by the projector.
     */
    await pushGridInsetToVision();
    await pushStoneBoundaryToVision();

    const response =
      await fetch(
        `${settings.visionUrl}/stones/baseline`,
        {
          method:
            "POST"
        }
      );

    if (
      !response.ok
    ) {
      throw new Error(
        await response.text()
      );
    }

    physicalBoard =
      Array.from(
        {
          length:
            19
        },
        () =>
          Array(19).fill(0)
      );

    drawLogicalBoard();

    stoneBaselineCaptured = true;

    stoneStatus.textContent =
      "Empty-board reference captured. You can now start a game.";
  }

  catch (error) {
    stoneStatus.textContent =
      `Baseline error: ${error.message}`;
  }
}



// ============================================================
// KATAGO SETTINGS / GAMEPLAY
// ============================================================

function kataGoConfigFromUi() {
  return {
    executablePath: katagoExecutable.value.trim() || "katago",
    modelPath: katagoModel.value.trim(),
    configPath: katagoConfig.value.trim()
  };
}

async function saveKataGoSettings() {
  const config =
    kataGoConfigFromUi();

  const saved =
    await window.goAR
      .setKataGoPaths(
        config
      );

  katagoExecutable.value =
    saved.executablePath ||
    "katago";

  katagoModel.value =
    saved.modelPath ||
    "";

  katagoConfig.value =
    saved.configPath ||
    "";

  return {
    executablePath:
      saved.executablePath ||
      "katago",

    modelPath:
      saved.modelPath ||
      "",

    configPath:
      saved.configPath ||
      ""
  };
}

async function autoDetectKataGoPaths() {
  katagoStatus.textContent =
    "Searching project-local and Homebrew KataGo paths…";

  const detected =
    await window.goAR
      .detectKataGoPaths();

  katagoExecutable.value =
    detected.executablePath ||
    "katago";

  katagoModel.value =
    detected.modelPath ||
    "";

  katagoConfig.value =
    detected.configPath ||
    "";

  const sources =
    detected.source?.length
      ? detected.source.join(", ")
      : "saved/default paths";

  katagoStatus.innerHTML =
    `<strong>KataGo paths saved.</strong><br>` +
    `Sources: ${sources}`;

  return detected;
}


async function testKataGo() {
  const config = await saveKataGoSettings();
  katagoStatus.textContent = "Starting KataGo…";

  const result = await window.goAR.testKataGo(config);

  katagoStatus.innerHTML =
    `<strong>KataGo ready</strong><br>${result.name || "KataGo"} ${result.version || ""}`;

  return result;
}

function virtualWhiteBoard() {
  return logicalGameBoard.map(row =>
    row.map(value => value === WHITE ? WHITE : EMPTY)
  );
}

async function renderGameProjection() {
  if (!gameActive) {
    await window.goAR.clearGameProjection();
    return;
  }

  await window.goAR.renderGame({
    virtualBoard: virtualWhiteBoard(),
    captureMarkers: pendingCaptureRemoval,
    hintMarkers: teachHint ? [teachHint] : [],
    orientation: boardOrientation.value,
    showSeatLabels: showSeatLabels.checked,
    gridInsetX: currentGridInsetX(),
    gridInsetY: currentGridInsetY(),
    projectedStoneScale:
      currentProjectedStoneScale()
  });
}

function updateGameButtons() {
  const humanTurn = gameActive && gameState === GAME_WAITING_HUMAN;
  passMoveButton.disabled = !humanTurn;
  resignGameButton.disabled = !gameActive || gameState === GAME_OVER;
  teachHintButton.disabled = !humanTurn || gameMode.value !== "teach";
  boardOrientation.disabled = gameActive && gameState !== GAME_OVER;
}

async function startNewGame() {
  debugLog("new-game-request",{mode:gameMode.value,komi:Number(gameKomi.value||6.5),orientation:boardOrientation.value},"game");
  if (!settings?.calibration)
    throw new Error("Calibrate the projector before starting a game.");

  if (!stoneBaselineCaptured)
    throw new Error("Capture an empty-board reference before starting a game.");

  await testKataGo();
  await setProjectorBlack();

  logicalGameBoard = createBoard(19);
  gameHistory = [];
  gameBoardHashes = [hashBoard(logicalGameBoard)];
  pendingCaptureRemoval = [];
  illegalPhysicalMove = null;
  teachHint = null;
  gameActive = true;
  gameState = GAME_WAITING_HUMAN;

  drawLogicalBoard();
  await renderGameProjection();
  startStoneTracking();

  gameStatus.innerHTML =
    `<strong>Your turn — Black</strong><br>Place one physical black stone.`;

  updateGameButtons();
}

async function acceptHumanMove(x,y) {
  debugLog("human-move-detected",{x,y,coordinate:goCoordinate(x,y)},"game");
  if (!gameActive || gameState !== GAME_WAITING_HUMAN) return;

  teachHint = null;

  const koHash =
    gameBoardHashes.length >= 2
      ? gameBoardHashes[gameBoardHashes.length-2]
      : null;

  const result = applyMove(logicalGameBoard,x,y,BLACK,koHash);

  if (!result.ok) {
    debugLog("human-move-rejected",{x,y,coordinate:goCoordinate(x,y),error:result.error},"game");
    illegalPhysicalMove = {x,y};
    pendingCaptureRemoval = [{x,y}];
    gameState = GAME_WAITING_ILLEGAL_REMOVAL;

    gameStatus.innerHTML =
      `<strong>Illegal move at ${goCoordinate(x,y)}</strong><br>` +
      `${result.error}<br>Remove that stone to continue.`;

    await renderGameProjection();
    updateGameButtons();
    return;
  }

  logicalGameBoard = result.board;
  gameHistory.push({color:"B",move:goCoordinate(x,y)});
  gameBoardHashes.push(result.hash);
  debugLog("human-move-accepted",{coordinate:goCoordinate(x,y),historyLength:gameHistory.length},"game");
  gameState = GAME_AI_THINKING;

  gameStatus.innerHTML =
    `<strong>You played ${goCoordinate(x,y)}.</strong><br>KataGo is thinking…`;

  drawLogicalBoard();
  await renderGameProjection();
  updateGameButtons();

  await requestAiMove();
}

async function requestAiMove() {
  const config = await saveKataGoSettings();
  debugLog("ai-think-start",{history:gameHistory},"game");

  const result = await window.goAR.kataGoGenMove({
    katago: config,
    boardSize: 19,
    komi: Number(gameKomi.value || 6.5),
    history: gameHistory,
    color: "W"
  });

  debugLog("ai-move-result",result,"game");

  if (result.type === "resign") {
    gameState = GAME_OVER;
    gameStatus.innerHTML = `<strong>KataGo resigned.</strong><br>Game over.`;
    updateGameButtons();
    return;
  }

  if (result.type === "pass") {
    gameHistory.push({color:"W",move:"PASS"});
    gameBoardHashes.push(hashBoard(logicalGameBoard));
    gameState = GAME_WAITING_HUMAN;
    gameStatus.innerHTML = `<strong>KataGo passed.</strong><br>Your turn.`;
    updateGameButtons();
    return;
  }

  const koHash =
    gameBoardHashes.length >= 2
      ? gameBoardHashes[gameBoardHashes.length-2]
      : null;

  const applied = applyMove(
    logicalGameBoard,
    result.x,
    result.y,
    WHITE,
    koHash
  );

  if (!applied.ok)
    throw new Error(`Local rules rejected KataGo move ${result.move}: ${applied.error}`);

  logicalGameBoard = applied.board;
  gameHistory.push({color:"W",move:result.move});
  gameBoardHashes.push(applied.hash);

  pendingCaptureRemoval = applied.captured
    .filter(stone => stone.color === BLACK)
    .map(stone => ({x:stone.x,y:stone.y}));

  drawLogicalBoard();

  if (pendingCaptureRemoval.length) {
    gameState = GAME_WAITING_CAPTURE_REMOVAL;
    gameStatus.innerHTML =
      `<strong>KataGo played ${result.move}.</strong><br>` +
      `Remove the ${pendingCaptureRemoval.length} marked captured black ` +
      `stone${pendingCaptureRemoval.length === 1 ? "" : "s"}.`;
  } else {
    gameState = GAME_WAITING_HUMAN;
    gameStatus.innerHTML =
      `<strong>KataGo played ${result.move}.</strong><br>Your turn — Black.`;
  }

  await renderGameProjection();
  updateGameButtons();
}

async function updatePendingPhysicalRemoval(detectedBoard) {
  if (gameState === GAME_WAITING_CAPTURE_REMOVAL) {
    const allRemoved = pendingCaptureRemoval.every(marker => {
      const physical = logicalToPhysical(marker.x,marker.y);
      return detectedBoard[physical.y][physical.x] === EMPTY;
    });

    if (!allRemoved) return;

    pendingCaptureRemoval = [];
    gameState = GAME_WAITING_HUMAN;
    gameStatus.innerHTML =
      `<strong>Capture confirmed.</strong><br>Your turn — Black.`;
    await renderGameProjection();
    updateGameButtons();
    return;
  }

  if (gameState === GAME_WAITING_ILLEGAL_REMOVAL && illegalPhysicalMove) {
    const physical =
      logicalToPhysical(
        illegalPhysicalMove.x,
        illegalPhysicalMove.y
      );

    if (detectedBoard[physical.y][physical.x] !== EMPTY) return;

    illegalPhysicalMove = null;
    pendingCaptureRemoval = [];
    gameState = GAME_WAITING_HUMAN;
    gameStatus.innerHTML =
      `<strong>Illegal stone removed.</strong><br>Try another move.`;
    await renderGameProjection();
    updateGameButtons();
  }
}

async function humanPass() {
  if (!gameActive || gameState !== GAME_WAITING_HUMAN) return;

  teachHint = null;
  gameHistory.push({color:"B",move:"PASS"});
  gameBoardHashes.push(hashBoard(logicalGameBoard));
  gameState = GAME_AI_THINKING;
  gameStatus.textContent = "You passed. KataGo is thinking…";

  await renderGameProjection();
  updateGameButtons();
  await requestAiMove();
}

async function resignGame() {
  if (!gameActive) return;

  gameState = GAME_OVER;
  teachHint = null;
  pendingCaptureRemoval = [];
  gameStatus.innerHTML = `<strong>You resigned.</strong><br>Game over.`;

  await renderGameProjection();
  updateGameButtons();
}

async function requestTeachHint() {
  if (!gameActive || gameState !== GAME_WAITING_HUMAN || gameMode.value !== "teach")
    return;

  const config = await saveKataGoSettings();
  gameStatus.textContent = "KataGo is calculating a hint…";

  const result = await window.goAR.kataGoGenMove({
    katago: config,
    boardSize: 19,
    komi: Number(gameKomi.value || 6.5),
    history: gameHistory,
    color: "B"
  });

  if (result.type === "move") {
    teachHint = {x:result.x,y:result.y};
    gameStatus.innerHTML =
      `<strong>Hint: consider ${result.move}</strong><br>` +
      `A cyan ring is projected on that intersection.`;
    await renderGameProjection();
  } else {
    gameStatus.textContent = `KataGo suggests ${result.move}.`;
  }
}


// ============================================================
// PHYSICAL STONE POLLING
// ============================================================

async function pollStones() {
  if (stonePollBusy) return;
  stonePollBusy = true;

  try {
    const response = await fetch(
      `${settings.visionUrl}/stones/detect`,
      {cache:"no-store"}
    );

    if (!response.ok) throw new Error(await response.text());

    const result = await response.json();

    if (result.unstable) {
      stoneStatus.textContent =
        `Waiting for board to stabilize — ${result.rawChangeCount} intersections changed at once.`;
      return;
    }

    physicalBoard = result.board;
    drawLogicalBoard();

    if (gameActive) {
      await updatePendingPhysicalRemoval(physicalBoard);

      if (
        gameState === GAME_WAITING_HUMAN &&
        result.added.length === 1 &&
        result.removed.length === 0
      ) {
        const physicalMove = result.added[0];
        const move =
          physicalToLogical(
            physicalMove.x,
            physicalMove.y
          );
        stoneStatus.textContent =
          `Physical Black detected at ${goCoordinate(move.x,move.y)}`;
        await acceptHumanMove(move.x,move.y);
        return;
      }

      if (gameState === GAME_AI_THINKING) {
        stoneStatus.textContent = "Tracking physical board — AI is thinking.";
        return;
      }

      if (gameState === GAME_WAITING_CAPTURE_REMOVAL) {
        stoneStatus.textContent = "Remove the marked captured black stone(s).";
        return;
      }

      if (gameState === GAME_WAITING_ILLEGAL_REMOVAL) {
        stoneStatus.textContent = "Remove the illegal physical stone.";
        return;
      }

      stoneStatus.textContent =
        `Tracking — ${result.occupiedCount} physical black stones detected.`;
      return;
    }

    if (result.added.length === 1 && result.removed.length === 0) {
      const physicalMove = result.added[0];
      const move =
        physicalToLogical(
          physicalMove.x,
          physicalMove.y
        );
      stoneStatus.textContent =
        `Black stone detected at ${goCoordinate(move.x,move.y)}`;
    } else if (result.added.length || result.removed.length) {
      stoneStatus.textContent =
        `Board changed — ${result.occupiedCount} physical black stones detected.`;
    } else {
      stoneStatus.textContent =
        `Tracking — ${result.occupiedCount} physical black stones detected.`;
    }
  } catch (error) {
    stoneStatus.textContent = `Stone detection error: ${error.message}`;
  } finally {
    stonePollBusy = false;
  }
}

function startStoneTracking() {
  if (
    stoneTrackingTimer
  ) {
    clearInterval(
      stoneTrackingTimer
    );
  }

  pollStones();

  stoneTrackingTimer =
    setInterval(
      pollStones,
      500
    );

  stoneStatus.textContent =
    "Stone tracking started.";
}


function stopStoneTracking() {
  if (
    stoneTrackingTimer
  ) {
    clearInterval(
      stoneTrackingTimer
    );

    stoneTrackingTimer =
      null;
  }

  stoneStatus.textContent =
    "Stone tracking stopped.";
}


// ============================================================
// CAMERA BUTTONS
// ============================================================

$("#startCamera")
  .addEventListener(
    "click",
    () => {
      startCamera()
        .catch(
          error => {
            setPill(
              cameraStatus,
              "Camera error",
              "bad"
            );

            cameraInfo.textContent =
              error.message;
          }
        );
    }
  );


$("#refreshCameras")
  .addEventListener(
    "click",
    enumerateCameras
  );


// ============================================================
// PROJECTOR BUTTONS
// ============================================================

$("#openProjector")
  .addEventListener(
    "click",
    async () => {
      const display =
        await window.goAR
          .openProjector(
            displaySelect.value
          );

      projectorOpen =
        true;

      settings =
        await window.goAR
          .setSettings({
            projectorDisplayId:
              display.id
          });

      setPill(
        projectorStatus,
        `Projector: ${display.label}`,
        "good"
      );
    }
  );


$("#illuminateBoard")
  .addEventListener(
    "click",
    () => {
      applyBoardIllumination()
        .catch(
          error => {
            calibrationStatus.textContent =
              `Projector illumination error: ${error.message}`;
          }
        );
    }
  );


$("#blackProjector")
  .addEventListener(
    "click",
    () => {
      setProjectorBlack()
        .catch(
          error => {
            calibrationStatus.textContent =
              `Projector error: ${error.message}`;
          }
        );
    }
  );


$("#identifyDisplays")
  .addEventListener(
    "click",
    () =>
      window.goAR
        .identifyDisplays()
  );


$("#runCalibration")
  .addEventListener(
    "click",
    () => {
      runCalibration()
        .catch(
          error => {
            calibrationStatus.textContent =
              `Calibration failed: ${error.message}`;
          }
        );
    }
  );



// ============================================================
// GAME / KATAGO BUTTONS
// ============================================================

async function chooseKataGoFile(kind,input) {
  const selected = await window.goAR.chooseKataGoFile(kind);
  if (!selected) return;
  input.value = selected;
  await saveKataGoSettings();
}

$("#browseKatagoExecutable").addEventListener(
  "click",
  () => chooseKataGoFile("executable",katagoExecutable)
);

$("#browseKatagoModel").addEventListener(
  "click",
  () => chooseKataGoFile("model",katagoModel)
);

$("#browseKatagoConfig").addEventListener(
  "click",
  () => chooseKataGoFile("config",katagoConfig)
);

$("#detectKatagoPaths").addEventListener(
  "click",
  () => {
    autoDetectKataGoPaths()
      .catch(
        error => {
          katagoStatus.textContent =
            `Path detection error: ${error.message}`;
        }
      );
  }
);

$("#testKatago").addEventListener(
  "click",
  () => testKataGo().catch(
    error => {
      katagoStatus.textContent = `KataGo error: ${error.message}`;
    }
  )
);

$("#newGame").addEventListener(
  "click",
  () => startNewGame().catch(
    error => {
      gameStatus.textContent = `Cannot start game: ${error.message}`;
    }
  )
);

passMoveButton.addEventListener(
  "click",
  () => humanPass().catch(
    error => {
      gameStatus.textContent = `Pass failed: ${error.message}`;
    }
  )
);

teachHintButton.addEventListener(
  "click",
  () => requestTeachHint().catch(
    error => {
      gameStatus.textContent = `Hint failed: ${error.message}`;
    }
  )
);

resignGameButton.addEventListener(
  "click",
  () => resignGame().catch(
    error => {
      gameStatus.textContent = `Resign failed: ${error.message}`;
    }
  )
);


projectedStoneScale.addEventListener(
  "input",
  () => {
    (async () => {
      updateProjectedStoneScaleLabel();

      settings =
        await window.goAR
          .setSettings({
            projectedStoneScale:
              currentProjectedStoneScale()
          });

      if (gameActive) {
        await renderGameProjection();
      }
    })().catch(
      error => {
        gameStatus.textContent =
          `Projected stone size error: ${error.message}`;
      }
    );
  }
);


async function toggleOrientationPreview() {
  if (!settings?.calibration) {
    gameStatus.textContent =
      "Calibrate the projector before previewing orientation.";
    return;
  }

  orientationPreviewActive =
    !orientationPreviewActive;

  if (orientationPreviewActive) {
    gridPreviewActive =
      false;

    stoneZonePreviewActive =
      false;

    toggleGridPreviewButton.textContent =
      "Show Alignment Grid";

    toggleStoneZonePreviewButton.textContent =
      "Show Detection Boundary";
    await window.goAR.renderOrientationPreview({
      orientation: boardOrientation.value,
      showSeatLabels: showSeatLabels.checked,
      gridInsetX: currentGridInsetX(),
      gridInsetY: currentGridInsetY()
    });

    previewOrientationButton.textContent =
      "Stop Orientation Preview";

    gameStatus.innerHTML =
      `<strong>Orientation preview active.</strong><br>` +
      `Verify A19, T19, A1, T1 and the Player / AI sides.`;
  } else {
    previewOrientationButton.textContent =
      "Preview Orientation";

    if (gameActive) {
      await renderGameProjection();
    } else {
      await window.goAR.clearGameProjection();
    }
  }
}

previewOrientationButton.addEventListener(
  "click",
  () => {
    toggleOrientationPreview().catch(error => {
      gameStatus.textContent =
        `Orientation preview error: ${error.message}`;
    });
  }
);

boardOrientation.addEventListener(
  "change",
  async () => {
    settings = await window.goAR.setSettings({
      boardOrientation: boardOrientation.value
    });

    if (orientationPreviewActive) {
      await window.goAR.renderOrientationPreview({
        orientation: boardOrientation.value,
        showSeatLabels: showSeatLabels.checked,
        gridInsetX: currentGridInsetX(),
        gridInsetY: currentGridInsetY()
      });
    }
  }
);

showSeatLabels.addEventListener(
  "change",
  async () => {
    settings = await window.goAR.setSettings({
      showSeatLabels: showSeatLabels.checked
    });

    if (orientationPreviewActive) {
      await window.goAR.renderOrientationPreview({
        orientation: boardOrientation.value,
        showSeatLabels: showSeatLabels.checked,
        gridInsetX: currentGridInsetX(),
        gridInsetY: currentGridInsetY()
      });
    } else if (gameActive) {
      await renderGameProjection();
    }
  }
);

gameMode.addEventListener(
  "change",
  () => {
    teachHint = null;
    updateGameButtons();
    if (gameActive) renderGameProjection();
  }
);

katagoExecutable.addEventListener("change",saveKataGoSettings);
katagoModel.addEventListener("change",saveKataGoSettings);
katagoConfig.addEventListener("change",saveKataGoSettings);



// ============================================================
// GRID ALIGNMENT CONTROLS
// ============================================================

async function handleGridInsetChange() {
  updateGridInsetLabels();

  await saveGridInsets();

  if (gridPreviewActive) {
    await refreshGridPreview();
  } else if (stoneZonePreviewActive) {
    await refreshStoneZonePreview();
  } else if (orientationPreviewActive) {
    await window.goAR
      .renderOrientationPreview({
        orientation:
          boardOrientation.value,

        showSeatLabels:
          showSeatLabels.checked,

        gridInsetX:
          currentGridInsetX(),

        gridInsetY:
          currentGridInsetY()
      });
  } else if (gameActive) {
    await renderGameProjection();
  }
}

gridInsetX.addEventListener(
  "input",
  () => {
    handleGridInsetChange()
      .catch(
        error => {
          calibrationStatus.textContent =
            `Grid inset error: ${error.message}`;
        }
      );
  }
);

gridInsetY.addEventListener(
  "input",
  () => {
    handleGridInsetChange()
      .catch(
        error => {
          calibrationStatus.textContent =
            `Grid inset error: ${error.message}`;
        }
      );
  }
);

toggleGridPreviewButton.addEventListener(
  "click",
  () => {
    (async () => {
      if (!settings?.calibration) {
        calibrationStatus.textContent =
          "Calibrate the projector before showing the alignment grid.";

        return;
      }

      gridPreviewActive =
        !gridPreviewActive;

      if (gridPreviewActive) {
        orientationPreviewActive =
          false;

        stoneZonePreviewActive =
          false;

        previewOrientationButton.textContent =
          "Preview Orientation";

        toggleStoneZonePreviewButton.textContent =
          "Show Detection Boundary";

        toggleGridPreviewButton.textContent =
          "Hide Alignment Grid";

        await refreshGridPreview();
      } else {
        toggleGridPreviewButton.textContent =
          "Show Alignment Grid";

        if (gameActive) {
          await renderGameProjection();
        } else {
          await window.goAR
            .clearGameProjection();
        }
      }
    })().catch(
      error => {
        calibrationStatus.textContent =
          `Grid preview error: ${error.message}`;
      }
    );
  }
);

resetGridInsetButton.addEventListener(
  "click",
  () => {
    gridInsetX.value =
      "3.5";

    gridInsetY.value =
      "3.5";

    handleGridInsetChange()
      .catch(
        error => {
          calibrationStatus.textContent =
            `Grid inset reset error: ${error.message}`;
        }
      );
  }
);



// ============================================================
// STONE DETECTION BOUNDARY
// ============================================================

async function handleStoneBoundaryChange() {
  updateStoneOutsideToleranceLabel();
  updateStoneHardMaskLabels();

  await saveStoneBoundary();

  drawStoneMaskOverlay();

  if (stoneZonePreviewActive) {
    await refreshStoneZonePreview();
  }
}

stoneOutsideTolerance.addEventListener(
  "input",
  () => {
    handleStoneBoundaryChange()
      .catch(
        error => {
          stoneStatus.textContent =
            `Stone boundary error: ${error.message}`;
        }
      );
  }
);


stoneHardMaskInset.addEventListener(
  "input",
  () => {
    handleStoneBoundaryChange()
      .catch(
        error => {
          stoneStatus.textContent =
            `Hard-mask error: ${error.message}`;
        }
      );
  }
);

stoneConfirmFrames.addEventListener(
  "input",
  () => {
    handleStoneBoundaryChange()
      .catch(
        error => {
          stoneStatus.textContent =
            `Confirmation error: ${error.message}`;
        }
      );
  }
);

showStoneMaskOnCamera.addEventListener(
  "change",
  () => {
    handleStoneBoundaryChange()
      .catch(
        error => {
          stoneStatus.textContent =
            `Mask preview error: ${error.message}`;
        }
      );
  }
);

window.addEventListener(
  "resize",
  drawStoneMaskOverlay
);

cameraPreview.addEventListener(
  "loadedmetadata",
  drawStoneMaskOverlay
);

toggleStoneZonePreviewButton.addEventListener(
  "click",
  () => {
    (async () => {
      if (!settings?.calibration) {
        stoneStatus.textContent =
          "Calibrate the projector before showing the detection boundary.";
        return;
      }

      stoneZonePreviewActive =
        !stoneZonePreviewActive;

      if (stoneZonePreviewActive) {
        gridPreviewActive = false;
        orientationPreviewActive = false;

        toggleGridPreviewButton.textContent =
          "Show Alignment Grid";

        previewOrientationButton.textContent =
          "Preview Orientation";

        toggleStoneZonePreviewButton.textContent =
          "Hide Detection Boundary";

        await refreshStoneZonePreview();
      } else {
        toggleStoneZonePreviewButton.textContent =
          "Show Detection Boundary";

        if (gameActive) {
          await renderGameProjection();
        } else {
          await window.goAR
            .clearGameProjection();
        }
      }
    })().catch(
      error => {
        stoneStatus.textContent =
          `Detection boundary preview error: ${error.message}`;
      }
    );
  }
);

resetStoneZoneButton.addEventListener(
  "click",
  () => {
    stoneOutsideTolerance.value =
      "1.2";

    handleStoneBoundaryChange()
      .catch(
        error => {
          stoneStatus.textContent =
            `Stone boundary reset error: ${error.message}`;
        }
      );
  }
);


// ============================================================
// ILLUMINATION SETTINGS
// ============================================================

illuminationLevel
  .addEventListener(
    "input",
    async event => {
      const percent =
        Number(
          event.target.value
        );

      illuminationValue.textContent =
        `${percent}%`;

      settings =
        await window.goAR
          .setSettings({
            boardIllumination:
              percent /
              100
          });

      /*
       * Update the live projector immediately when it is open.
       */
      if (
        projectorOpen &&
        !isCalibrating
      ) {
        await window.goAR
          .setProjectorIllumination(
            percent /
            100
          );
      }
    }
  );


illuminateOnLaunch
  .addEventListener(
    "change",
    async event => {
      settings =
        await window.goAR
          .setSettings({
            illuminateOnLaunch:
              event.target.checked
          });
    }
  );


// ============================================================
// PHYSICAL BOARD BUTTONS
// ============================================================

$("#captureEmptyBoard")
  .addEventListener(
    "click",
    captureEmptyBoard
  );


$("#startStoneTracking")
  .addEventListener(
    "click",
    startStoneTracking
  );


$("#stopStoneTracking")
  .addEventListener(
    "click",
    stopStoneTracking
  );


// ============================================================
// DEVICE SETTINGS
// ============================================================

cameraSelect
  .addEventListener(
    "change",
    async () => {
      settings =
        await window.goAR
          .setSettings({
            cameraDeviceId:
              cameraSelect.value
          });
    }
  );


displaySelect
  .addEventListener(
    "change",
    async () => {
      settings =
        await window.goAR
          .setSettings({
            projectorDisplayId:
              displaySelect.value
          });
    }
  );


// ============================================================
// CALIBRATION PROGRESS EVENTS
// ============================================================

window.goAR
  .onCalibrationProgress(
    data => {
      if (!isCalibrating) {
        return;
      }

      calibrationStatus.textContent =
        data.message;

      if (
        data.stage ===
        "board"
      ) {
        calibrationProgress.value =
          5;
      }

      if (
        data.stage ===
        "coarse"
      ) {
        calibrationProgress.value =
          25;
      }

      if (
        data.stage ===
        "roi"
      ) {
        calibrationProgress.value =
          50;
      }

      if (
        data.stage ===
        "dense"
      ) {
        calibrationProgress.value =
          75;
      }
    }
  );


window.goAR
  .onCalibrationComplete(
    result => {
      calibrationProgress.max =
        100;

      calibrationProgress.value =
        100;

      calibrationStatus.innerHTML = `
        <strong>
          Calibration ${result.quality}
        </strong>
        <br>

        Samples:
        ${result.sampleCount}
        <br>

        RANSAC inliers:
        ${result.inliers}
        <br>

        Mean reprojection error:
        ${result.meanReprojectionError.toFixed(2)} px
        <br>

        Median error:
        ${result.medianReprojectionError.toFixed(2)} px
        <br>

        Maximum error:
        ${result.maxReprojectionError.toFixed(2)} px
      `;
    }
  );


// ============================================================
// DISPLAY HOTPLUG EVENTS
// ============================================================

window.goAR
  .onDisplaysChanged(
    async () => {
      if (isCalibrating) {
        return;
      }

      const displays =
        await enumerateDisplays();

      const external =
        displays.find(
          display =>
            !display.primary
        );

      if (
        external &&
        settings.illuminateOnLaunch !==
          false
      ) {
        displaySelect.value =
          external.id;

        await applyBoardIllumination();
      }
    }
  );


window.goAR
  .onProjectorDetected(
    async display => {
      if (isCalibrating) {
        return;
      }

      await enumerateDisplays();

      if (
        display.internal
      ) {
        return;
      }

      displaySelect.value =
        display.id;

      if (
        settings.illuminateOnLaunch !==
          false
      ) {
        await applyBoardIllumination();
      }
    }
  );


// ============================================================
// CAMERA HOTPLUG EVENTS
// ============================================================

navigator.mediaDevices
  .addEventListener?.(
    "devicechange",
    enumerateCameras
  );


// ============================================================
// INITIALIZATION
// ============================================================

async function init() {
  settings =
    await window.goAR
      .getSettings();


  boardOrientation.value =
    settings.boardOrientation ||
    "bottom";

  showSeatLabels.checked =
    settings.showSeatLabels !== false;

  projectedStoneScale.value =
    String(
      Math.round(
        Number(
          settings.projectedStoneScale ??
          0.78
        ) *
        100
      )
    );

  updateProjectedStoneScaleLabel();

  gridInsetX.value =
    String(
      Number(
        settings.gridInsetX ??
        0.035
      ) * 100
    );

  gridInsetY.value =
    String(
      Number(
        settings.gridInsetY ??
        0.035
      ) * 100
    );

  updateGridInsetLabels();

  stoneOutsideTolerance.value =
    String(
      Number(
        settings.stoneOutsideTolerance ??
        0.012
      ) * 100
    );

  stoneHardMaskInset.value =
    String(
      Number(
        settings.stoneHardMaskInset ??
        0.0
      ) * 100
    );

  stoneConfirmFrames.value =
    String(
      Number(
        settings.stoneConfirmFrames ??
        4
      )
    );

  showStoneMaskOnCamera.checked =
    settings.showStoneMaskOnCamera !==
    false;

  updateStoneOutsideToleranceLabel();
  updateStoneHardMaskLabels();

  const savedKataGoPaths =
    await window.goAR
      .getKataGoPaths();

  katagoExecutable.value =
    savedKataGoPaths.executablePath ||
    "katago";

  katagoModel.value =
    savedKataGoPaths.modelPath ||
    "";

  katagoConfig.value =
    savedKataGoPaths.configPath ||
    "";

  updateGameButtons();

  /*
   * Backward compatibility with older settings.json files.
   */
  if (
    settings.illuminateOnLaunch ===
    undefined
  ) {
    settings.illuminateOnLaunch =
      true;
  }

  if (
    settings.boardIllumination ===
    undefined
  ) {
    settings.boardIllumination =
      0.72;
  }

  illuminateOnLaunch.checked =
    settings.illuminateOnLaunch !==
    false;

  const initialPercent =
    Math.round(
      settings.boardIllumination *
      100
    );

  illuminationLevel.value =
    String(
      initialPercent
    );

  illuminationValue.textContent =
    `${initialPercent}%`;

  await healthCheck();

  try {
    await pushGridInsetToVision();
    await pushStoneBoundaryToVision();
  } catch (error) {
    console.warn(
      "Could not initialize stone detection geometry:",
      error
    );
  }

  await enumerateCameras();

  const displays =
    await enumerateDisplays();

  drawLogicalBoard();

  /*
   * NEW STARTUP BEHAVIOR:
   *
   * If an external projector is already attached, open it and
   * illuminate the board. Do not begin calibration.
   */
  const external =
    displays.find(
      display =>
        !display.primary
    );

  if (
    external &&
    settings.illuminateOnLaunch !==
      false
  ) {
    displaySelect.value =
      settings.projectorDisplayId &&
      displays.some(
        display =>
          display.id ===
          settings.projectorDisplayId &&
          !display.primary
      )
        ? settings.projectorDisplayId
        : external.id;

    try {
      await applyBoardIllumination();
    }

    catch (error) {
      calibrationStatus.textContent =
        `Could not illuminate projector: ${error.message}`;
    }
  }

  /*
   * Auto-start a previously selected camera if available.
   *
   * The camera then begins sending frames, which drives live
   * board detection and eventually enables Begin Calibration.
   */
  if (
    settings.cameraDeviceId &&
    [
      ...cameraSelect.options
    ].some(
      option =>
        option.value ===
        settings.cameraDeviceId
    )
  ) {
    cameraSelect.value =
      settings.cameraDeviceId;

    try {
      await startCamera();
    }

    catch (error) {
      cameraInfo.textContent =
        `Could not auto-start camera: ${error.message}`;
    }
  }

  updateBoardDetectionUI();
}


init();
