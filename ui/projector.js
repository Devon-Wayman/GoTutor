const canvas = document.querySelector("#canvas");
const ctx = canvas.getContext("2d");

let pattern = { type: "black" };

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

window.addEventListener("resize", resize);
resize();

function applyHomography(H, x, y) {
  const d = H[2][0] * x + H[2][1] * y + H[2][2];

  return [
    (H[0][0] * x + H[0][1] * y + H[0][2]) / d,
    (H[1][0] * x + H[1][1] * y + H[1][2]) / d
  ];
}

function projectorPixelFromNormalized(x, y) {
  return [x * window.innerWidth, y * window.innerHeight];
}

function drawBoardTest(H) {
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);

  if (!H) return;

  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.5;
  ctx.globalAlpha = 0.75;

  // Draw 19 horizontal and 19 vertical grid lines through the solved
  // board-normalized -> projector-normalized homography.
  for (let i = 0; i < 19; i++) {
    const t = i / 18;

    let a = applyHomography(H, 0, t);
    let b = applyHomography(H, 1, t);
    a = projectorPixelFromNormalized(...a);
    b = projectorPixelFromNormalized(...b);

    ctx.beginPath();
    ctx.moveTo(...a);
    ctx.lineTo(...b);
    ctx.stroke();

    a = applyHomography(H, t, 0);
    b = applyHomography(H, t, 1);
    a = projectorPixelFromNormalized(...a);
    b = projectorPixelFromNormalized(...b);

    ctx.beginPath();
    ctx.moveTo(...a);
    ctx.lineTo(...b);
    ctx.stroke();
  }

  // Mark corner points distinctly.
  ctx.globalAlpha = 1;
  const corners = [[0,0], [1,0], [1,1], [0,1]];

  for (const [x, y] of corners) {
    let p = applyHomography(H, x, y);
    p = projectorPixelFromNormalized(...p);

    ctx.beginPath();
    ctx.arc(p[0], p[1], 10, 0, Math.PI * 2);
    ctx.fillStyle = "#fff";
    ctx.fill();
  }
}

function render() {
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);

  if (pattern.type === "dot") {
    const x = pattern.x * window.innerWidth;
    const y = pattern.y * window.innerHeight;
    const r = pattern.radius * Math.min(window.innerWidth, window.innerHeight);

    // Bright white central dot with a thin black ring produces a stable
    // centroid even if the physical Go board beneath it is bright.
    ctx.beginPath();
    ctx.arc(x, y, r * 1.18, 0, Math.PI * 2);
    ctx.fillStyle = "#000";
    ctx.fill();

    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = "#fff";
    ctx.fill();
  }

  if (pattern.type === "board-test") {
    drawBoardTest(pattern.homography);
  }
}

window.goAR.onProjectorPattern(next => {
  pattern = next;
  render();
});

render();
