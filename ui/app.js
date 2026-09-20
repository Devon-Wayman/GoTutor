const $ = selector => document.querySelector(selector);

const cameraSelect = $("#cameraSelect");
const displaySelect = $("#displaySelect");
const resolutionSelect = $("#resolutionSelect");
const preview = $("#cameraPreview");
const frameCanvas = $("#frameCanvas");
const overlayCanvas = $("#overlayCanvas");

const visionStatus = $("#visionStatus");
const cameraStatus = $("#cameraStatus");
const projectorStatus = $("#projectorStatus");
const calibrationStatus = $("#calibrationStatus");
const calibrationProgress = $("#calibrationProgress");
const cameraInfo = $("#cameraInfo");

let stream = null;
let frameTimer = null;
let settings = null;
let latestBoard = null;

function setPill(el, text, kind = "") {
  el.textContent = text;
  el.className = `pill ${kind}`.trim();
}

async function healthCheck() {
  try {
    const response = await fetch(`${settings.visionUrl}/health`);
    if (!response.ok) throw new Error("not ready");
    setPill(visionStatus, "Vision ready", "good");
    return true;
  } catch {
    setPill(visionStatus, "Vision unavailable", "bad");
    return false;
  }
}

async function enumerateCameras() {
  // Browser/Electron won't reveal useful labels until permission exists.
  try {
    const temporary = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: false
    });
    temporary.getTracks().forEach(track => track.stop());
  } catch (err) {
    cameraInfo.textContent = `Camera permission error: ${err.message}`;
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  const cameras = devices.filter(device => device.kind === "videoinput");

  cameraSelect.innerHTML = "";

  for (const [index, camera] of cameras.entries()) {
    const option = document.createElement("option");
    option.value = camera.deviceId;
    option.textContent = camera.label || `Camera ${index + 1}`;
    cameraSelect.append(option);
  }

  if (settings.cameraDeviceId &&
      [...cameraSelect.options].some(o => o.value === settings.cameraDeviceId)) {
    cameraSelect.value = settings.cameraDeviceId;
  }

  return cameras;
}

async function enumerateDisplays() {
  const displays = await window.goAR.listDisplays();

  displaySelect.innerHTML = "";

  for (const display of displays) {
    const option = document.createElement("option");
    option.value = display.id;

    const role = display.primary ? "Primary" : "External";
    const internal = display.internal ? ", internal" : "";

    option.textContent =
      `${display.label} — ${display.size.width}×${display.size.height} ` +
      `(${role}${internal})`;

    displaySelect.append(option);
  }

  const external = displays.find(d => !d.primary);

  if (settings.projectorDisplayId &&
      displays.some(d => d.id === settings.projectorDisplayId)) {
    displaySelect.value = settings.projectorDisplayId;
  } else if (external) {
    displaySelect.value = external.id;
  }

  if (external) {
    setPill(projectorStatus, `External display: ${external.label}`, "good");
  } else {
    setPill(projectorStatus, "No external display", "warn");
  }

  return displays;
}

function parseResolution() {
  const [width, height] = resolutionSelect.value.split("x").map(Number);
  return { width, height };
}

async function startCamera() {
  if (stream) {
    stream.getTracks().forEach(track => track.stop());
  }

  const { width, height } = parseResolution();
  const deviceId = cameraSelect.value;

  const constraints = {
    audio: false,
    video: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      width: { ideal: width },
      height: { ideal: height },
      frameRate: { ideal: 30, max: 30 }
    }
  };

  stream = await navigator.mediaDevices.getUserMedia(constraints);
  preview.srcObject = stream;

  await new Promise(resolve => {
    if (preview.readyState >= 2) resolve();
    else preview.onloadedmetadata = resolve;
  });

  const track = stream.getVideoTracks()[0];
  const actual = track.getSettings();

  settings = await window.goAR.setSettings({
    cameraDeviceId: deviceId || actual.deviceId || null
  });

  setPill(cameraStatus, track.label || "Camera active", "good");

  cameraInfo.textContent =
    `${actual.width || "?"}×${actual.height || "?"} @ ` +
    `${actual.frameRate ? actual.frameRate.toFixed(1) : "?"} FPS`;

  frameCanvas.width = actual.width || preview.videoWidth || width;
  frameCanvas.height = actual.height || preview.videoHeight || height;

  overlayCanvas.width = frameCanvas.width;
  overlayCanvas.height = frameCanvas.height;

  if (frameTimer) clearInterval(frameTimer);

  // 8 fps is plenty for initial board/calibration work and keeps CPU/network use low.
  frameTimer = setInterval(sendFrame, 125);

  await healthCheck();

  const displays = await window.goAR.listDisplays();
  const external = displays.find(d => !d.primary);

  if (settings.autoCalibrateOnLaunch && external) {
    calibrationStatus.textContent =
      "Camera ready and projector detected. Starting automatic calibration…";

    try {
      await runCalibration();
    } catch (err) {
      calibrationStatus.textContent = `Automatic calibration failed: ${err.message}`;
    }
  }
}

async function sendFrame() {
  if (!stream || preview.readyState < 2) return;

  const ctx = frameCanvas.getContext("2d", { alpha: false });
  ctx.drawImage(preview, 0, 0, frameCanvas.width, frameCanvas.height);

  const blob = await new Promise(resolve =>
    frameCanvas.toBlob(resolve, "image/jpeg", 0.78)
  );

  if (!blob) return;

  try {
    const response = await fetch(`${settings.visionUrl}/frame`, {
      method: "POST",
      headers: { "Content-Type": "image/jpeg" },
      body: blob
    });

    if (!response.ok) return;

    const result = await response.json();

    if (result.boardCorners) {
      latestBoard = result.boardCorners;
      drawBoardOverlay();
    }
  } catch {
    setPill(visionStatus, "Vision disconnected", "bad");
  }
}

function drawBoardOverlay() {
  const ctx = overlayCanvas.getContext("2d");
  ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

  if (!latestBoard?.length) return;

  ctx.strokeStyle = "#00ff88";
  ctx.lineWidth = Math.max(2, overlayCanvas.width / 500);
  ctx.beginPath();

  latestBoard.forEach(([x, y], index) => {
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });

  ctx.closePath();
  ctx.stroke();

  for (const [x, y] of latestBoard) {
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fillStyle = "#00ff88";
    ctx.fill();
  }
}

async function runCalibration() {
  if (!stream) {
    throw new Error("Start a camera first.");
  }

  calibrationProgress.value = 0;
  calibrationStatus.textContent = "Starting automatic calibration…";

  const displayId = displaySelect.value;
  await window.goAR.openProjector(displayId);

  const solved = await window.goAR.autoCalibrate(displayId);

  calibrationStatus.textContent =
    `Calibrated with ${solved.inliers}/${solved.sampleCount} usable projection points.`;

  return solved;
}

$("#startCamera").addEventListener("click", () => {
  startCamera().catch(err => {
    setPill(cameraStatus, "Camera error", "bad");
    cameraInfo.textContent = err.message;
  });
});

$("#refreshCameras").addEventListener("click", enumerateCameras);

$("#openProjector").addEventListener("click", async () => {
  const display = await window.goAR.openProjector(displaySelect.value);
  settings = await window.goAR.setSettings({
    projectorDisplayId: display.id
  });
  setPill(projectorStatus, `Projector: ${display.label}`, "good");
});

$("#identifyDisplays").addEventListener("click", () =>
  window.goAR.identifyDisplays()
);

$("#runCalibration").addEventListener("click", () => {
  runCalibration().catch(err => {
    calibrationStatus.textContent = `Calibration failed: ${err.message}`;
  });
});

$("#autoCalibrate").addEventListener("change", async event => {
  settings = await window.goAR.setSettings({
    autoCalibrateOnLaunch: event.target.checked
  });
});

cameraSelect.addEventListener("change", async () => {
  settings = await window.goAR.setSettings({
    cameraDeviceId: cameraSelect.value
  });
});

displaySelect.addEventListener("change", async () => {
  settings = await window.goAR.setSettings({
    projectorDisplayId: displaySelect.value
  });
});

window.goAR.onCalibrationProgress(data => {
  calibrationStatus.textContent = data.message;

  if (data.stage === "sampling") {
    const match = data.message.match(/(\d+)\/(\d+)/);
    if (match) {
      calibrationProgress.max = Number(match[2]);
      calibrationProgress.value = Number(match[1]);
    }
  }
});

window.goAR.onCalibrationComplete(result => {
  calibrationProgress.value = calibrationProgress.max;
  calibrationStatus.textContent =
    `Calibration complete — ${result.inliers}/${result.sampleCount} inliers.`;
});

window.goAR.onDisplaysChanged(async () => {
  await enumerateDisplays();
});

window.goAR.onProjectorDetected(async display => {
  await enumerateDisplays();

  if (settings.autoCalibrateOnLaunch && stream) {
    displaySelect.value = display.id;

    try {
      await runCalibration();
    } catch (err) {
      calibrationStatus.textContent = `Auto-calibration failed: ${err.message}`;
    }
  }
});

navigator.mediaDevices.addEventListener?.("devicechange", enumerateCameras);

async function init() {
  settings = await window.goAR.getSettings();
  $("#autoCalibrate").checked = settings.autoCalibrateOnLaunch;

  await healthCheck();
  await enumerateCameras();
  await enumerateDisplays();

  // If a previously selected camera is present, start it automatically.
  if (settings.cameraDeviceId &&
      [...cameraSelect.options].some(o => o.value === settings.cameraDeviceId)) {
    cameraSelect.value = settings.cameraDeviceId;
    try {
      await startCamera();
    } catch (err) {
      cameraInfo.textContent = `Could not auto-start camera: ${err.message}`;
    }
  }
}

init();
