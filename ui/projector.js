const canvas =
  document.querySelector(
    "#canvas"
  );

const ctx =
  canvas.getContext(
    "2d"
  );

let pattern = {
  type:
    "black"
};

function resize() {
  const dpr =
    window.devicePixelRatio ||
    1;

  canvas.width =
    Math.round(
      window.innerWidth *
      dpr
    );

  canvas.height =
    Math.round(
      window.innerHeight *
      dpr
    );

  canvas.style.width =
    `${window.innerWidth}px`;

  canvas.style.height =
    `${window.innerHeight}px`;

  ctx.setTransform(
    dpr,
    0,
    0,
    dpr,
    0,
    0
  );

  render();
}

window.addEventListener(
  "resize",
  resize
);

function applyHomography(
  homography,
  x,
  y
) {
  const denominator =
    homography[2][0] * x +
    homography[2][1] * y +
    homography[2][2];

  return [
    (
      homography[0][0] * x +
      homography[0][1] * y +
      homography[0][2]
    ) /
    denominator,

    (
      homography[1][0] * x +
      homography[1][1] * y +
      homography[1][2]
    ) /
    denominator
  ];
}

function projectorPixelFromNormalized(
  x,
  y
) {
  return [
    x *
      window.innerWidth,

    y *
      window.innerHeight
  ];
}


function applyGridInset(
  x,
  y,
  gridInsetX = 0.035,
  gridInsetY = 0.035
) {
  const insetX =
    Math.max(
      0,
      Math.min(
        0.20,
        Number(gridInsetX) ||
        0
      )
    );

  const insetY =
    Math.max(
      0,
      Math.min(
        0.20,
        Number(gridInsetY) ||
        0
      )
    );

  return [
    insetX +
      x *
      (1 - 2 * insetX),

    insetY +
      y *
      (1 - 2 * insetY)
  ];
}


function drawBoardTest(
  homography,
  gridInsetX = 0.035,
  gridInsetY = 0.035
) {
  ctx.fillStyle =
    "#000";

  ctx.fillRect(
    0,
    0,
    window.innerWidth,
    window.innerHeight
  );

  if (!homography) {
    return;
  }

  ctx.strokeStyle =
    "#ffffff";

  ctx.lineWidth =
    1.5;

  ctx.globalAlpha =
    0.75;

  for (
    let index = 0;
    index < 19;
    index++
  ) {
    const position =
      index /
      18;

    const horizontalStart =
      applyGridInset(
        0,
        position,
        gridInsetX,
        gridInsetY
      );

    const horizontalEnd =
      applyGridInset(
        1,
        position,
        gridInsetX,
        gridInsetY
      );

    let start =
      applyHomography(
        homography,
        horizontalStart[0],
        horizontalStart[1]
      );

    let end =
      applyHomography(
        homography,
        horizontalEnd[0],
        horizontalEnd[1]
      );

    start =
      projectorPixelFromNormalized(
        ...start
      );

    end =
      projectorPixelFromNormalized(
        ...end
      );

    ctx.beginPath();

    ctx.moveTo(
      ...start
    );

    ctx.lineTo(
      ...end
    );

    ctx.stroke();

    const verticalStart =
      applyGridInset(
        position,
        0,
        gridInsetX,
        gridInsetY
      );

    const verticalEnd =
      applyGridInset(
        position,
        1,
        gridInsetX,
        gridInsetY
      );

    start =
      applyHomography(
        homography,
        verticalStart[0],
        verticalStart[1]
      );

    end =
      applyHomography(
        homography,
        verticalEnd[0],
        verticalEnd[1]
      );

    start =
      projectorPixelFromNormalized(
        ...start
      );

    end =
      projectorPixelFromNormalized(
        ...end
      );

    ctx.beginPath();

    ctx.moveTo(
      ...start
    );

    ctx.lineTo(
      ...end
    );

    ctx.stroke();
  }

  ctx.globalAlpha =
    1;

  const corners = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1]
  ];

  for (
    const [
      x,
      y
    ] of corners
  ) {
    const insetPoint =
      applyGridInset(
        x,
        y,
        gridInsetX,
        gridInsetY
      );

    let point =
      applyHomography(
        homography,
        insetPoint[0],
        insetPoint[1]
      );

    point =
      projectorPixelFromNormalized(
        ...point
      );

    ctx.beginPath();

    ctx.arc(
      point[0],
      point[1],
      10,
      0,
      Math.PI * 2
    );

    ctx.fillStyle =
      "#fff";

    ctx.fill();
  }
}


function logicalToPhysicalNormalized(x,y,orientation="bottom") {
  switch (orientation) {
    case "top": return [1-x,1-y];
    case "left": return [1-y,x];
    case "right": return [y,1-x];
    default: return [x,y];
  }
}

function logicalBoardPointToPixel(
  homography,
  x,
  y,
  orientation,
  gridInsetX = 0.035,
  gridInsetY = 0.035
) {
  const physical =
    logicalToPhysicalNormalized(
      x,
      y,
      orientation
    );

  const insetPhysical =
    applyGridInset(
      physical[0],
      physical[1],
      gridInsetX,
      gridInsetY
    );

  const projected =
    applyHomography(
      homography,
      insetPhysical[0],
      insetPhysical[1]
    );

  return projectorPixelFromNormalized(
    ...projected
  );
}

function physicalBoardPointToPixel(homography,x,y) {
  const projected = applyHomography(homography,x,y);
  return projectorPixelFromNormalized(...projected);
}

function oppositeSide(side) {
  if (side === "top") return "bottom";
  if (side === "left") return "right";
  if (side === "right") return "left";
  return "top";
}

function seatPoint(homography,side) {
  const center = physicalBoardPointToPixel(homography,0.5,0.5);
  const edgeN =
    side === "top" ? [0.5,0] :
    side === "left" ? [0,0.5] :
    side === "right" ? [1,0.5] :
    [0.5,1];

  const edge = physicalBoardPointToPixel(homography,edgeN[0],edgeN[1]);
  const dx = edge[0]-center[0];
  const dy = edge[1]-center[1];
  const length = Math.max(1,Math.hypot(dx,dy));
  const offset = Math.min(58,Math.max(26,length*0.14));

  return [
    edge[0] + dx/length*offset,
    edge[1] + dy/length*offset
  ];
}

function drawProjectedLabel(text,point,scale=0.032) {
  const fontSize = Math.max(
    18,
    Math.min(
      36,
      Math.min(window.innerWidth,window.innerHeight)*scale
    )
  );

  ctx.font = `700 ${fontSize}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const metrics = ctx.measureText(text);
  const padX = 12;
  const padY = 7;
  const width = metrics.width + padX*2;
  const height = fontSize + padY*2;

  ctx.fillStyle = "rgba(0,0,0,0.82)";
  ctx.fillRect(
    point[0]-width/2,
    point[1]-height/2,
    width,
    height
  );

  ctx.fillStyle = "#fff";
  ctx.fillText(text,point[0],point[1]);
}

function drawSeatLabels(homography,orientation) {
  drawProjectedLabel(
    "Player",
    seatPoint(homography,orientation)
  );

  drawProjectedLabel(
    "AI",
    seatPoint(homography,oppositeSide(orientation))
  );
}

function drawOrientationPreview(homography,orientation,showSeatLabels,gridInsetX=0.035,gridInsetY=0.035) {
  ctx.fillStyle = "#000";
  ctx.fillRect(0,0,window.innerWidth,window.innerHeight);
  if (!homography) return;

  const corners = [
    ["A19",0.055,0.055],
    ["T19",0.945,0.055],
    ["A1",0.055,0.945],
    ["T1",0.945,0.945]
  ];

  for (const [label,x,y] of corners) {
    const point = logicalBoardPointToPixel(
      homography,
      x,
      y,
      orientation,
      gridInsetX,
      gridInsetY
    );
    drawProjectedLabel(label,point,0.026);
  }

  if (showSeatLabels) {
    drawSeatLabels(homography,orientation);
  }
}


function logicalBoardNormalizedToPixel(
  homography,
  logicalX,
  logicalY,
  orientation,
  gridInsetX = 0.035,
  gridInsetY = 0.035
) {
  const physical =
    logicalToPhysicalNormalized(
      logicalX,
      logicalY,
      orientation
    );

  const insetPhysical =
    applyGridInset(
      physical[0],
      physical[1],
      gridInsetX,
      gridInsetY
    );

  const projected =
    applyHomography(
      homography,
      insetPhysical[0],
      insetPhysical[1]
    );

  return projectorPixelFromNormalized(
    ...projected
  );
}


function tracePerspectiveBoardCircle(
  homography,
  logicalX,
  logicalY,
  orientation,
  gridInsetX,
  gridInsetY,
  diameterInGridSpaces,
  segments = 48
) {
  const radius =
    (
      diameterInGridSpaces /
      2
    ) /
    18;

  ctx.beginPath();

  for (
    let i = 0;
    i <= segments;
    i++
  ) {
    const angle =
      (
        i /
        segments
      ) *
      Math.PI *
      2;

    const sampleX =
      logicalX +
      Math.cos(
        angle
      ) *
      radius;

    const sampleY =
      logicalY +
      Math.sin(
        angle
      ) *
      radius;

    const point =
      logicalBoardNormalizedToPixel(
        homography,
        sampleX,
        sampleY,
        orientation,
        gridInsetX,
        gridInsetY
      );

    if (i === 0) {
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

  ctx.closePath();
}


function fillPerspectiveBoardCircle(
  homography,
  logicalX,
  logicalY,
  orientation,
  gridInsetX,
  gridInsetY,
  diameterInGridSpaces,
  fillStyle
) {
  tracePerspectiveBoardCircle(
    homography,
    logicalX,
    logicalY,
    orientation,
    gridInsetX,
    gridInsetY,
    diameterInGridSpaces
  );

  ctx.fillStyle =
    fillStyle;

  ctx.fill();
}


function strokePerspectiveBoardCircle(
  homography,
  logicalX,
  logicalY,
  orientation,
  gridInsetX,
  gridInsetY,
  diameterInGridSpaces,
  strokeStyle,
  lineWidth = 4
) {
  tracePerspectiveBoardCircle(
    homography,
    logicalX,
    logicalY,
    orientation,
    gridInsetX,
    gridInsetY,
    diameterInGridSpaces
  );

  ctx.strokeStyle =
    strokeStyle;

  ctx.lineWidth =
    lineWidth;

  ctx.stroke();
}


function drawGame(
  homography,
  virtualBoard,
  captureMarkers=[],
  hintMarkers=[],
  orientation="bottom",
  showSeatLabels=false,
  gridInsetX=0.035,
  gridInsetY=0.035,
  projectedStoneScale=0.78
) {
  ctx.fillStyle = "#000";
  ctx.fillRect(
    0,
    0,
    window.innerWidth,
    window.innerHeight
  );

  if (!homography) return;

  const stoneScale =
    Math.max(
      0.35,
      Math.min(
        1.10,
        Number(
          projectedStoneScale
        ) ||
        0.78
      )
    );

  /*
   * White AI stones:
   * defined in board-space grid units, then projected through the
   * homography. This is perspective/keystone-correct and no longer
   * a fixed screen-space circle.
   */
  for (
    let y = 0;
    y < 19;
    y++
  ) {
    for (
      let x = 0;
      x < 19;
      x++
    ) {
      if (
        virtualBoard?.[y]?.[x] !==
        2
      ) {
        continue;
      }

      const logicalX =
        x /
        18;

      const logicalY =
        y /
        18;

      fillPerspectiveBoardCircle(
        homography,
        logicalX,
        logicalY,
        orientation,
        gridInsetX,
        gridInsetY,
        stoneScale *
          1.06,
        "#000"
      );

      fillPerspectiveBoardCircle(
        homography,
        logicalX,
        logicalY,
        orientation,
        gridInsetX,
        gridInsetY,
        stoneScale,
        "#fff"
      );
    }
  }

  /*
   * Captured physical Black stones:
   * X size follows the local projected grid geometry.
   */
  for (
    const marker
    of captureMarkers
  ) {
    const logicalX =
      marker.x /
      18;

    const logicalY =
      marker.y /
      18;

    const center =
      logicalBoardNormalizedToPixel(
        homography,
        logicalX,
        logicalY,
        orientation,
        gridInsetX,
        gridInsetY
      );

    const offset =
      (
        stoneScale *
        0.42
      ) /
      18;

    const plusX =
      logicalBoardNormalizedToPixel(
        homography,
        logicalX +
          offset,
        logicalY,
        orientation,
        gridInsetX,
        gridInsetY
      );

    const plusY =
      logicalBoardNormalizedToPixel(
        homography,
        logicalX,
        logicalY +
          offset,
        orientation,
        gridInsetX,
        gridInsetY
      );

    const vx = [
      plusX[0] -
        center[0],
      plusX[1] -
        center[1]
    ];

    const vy = [
      plusY[0] -
        center[0],
      plusY[1] -
        center[1]
    ];

    ctx.beginPath();

    ctx.moveTo(
      center[0] -
        vx[0] -
        vy[0],
      center[1] -
        vx[1] -
        vy[1]
    );

    ctx.lineTo(
      center[0] +
        vx[0] +
        vy[0],
      center[1] +
        vx[1] +
        vy[1]
    );

    ctx.moveTo(
      center[0] +
        vx[0] -
        vy[0],
      center[1] +
        vx[1] -
        vy[1]
    );

    ctx.lineTo(
      center[0] -
        vx[0] +
        vy[0],
      center[1] -
        vx[1] +
        vy[1]
    );

    ctx.strokeStyle =
      "#ff3030";

    ctx.lineWidth =
      Math.max(
        3,
        Math.min(
          Math.hypot(
            vx[0],
            vx[1]
          ),
          Math.hypot(
            vy[0],
            vy[1]
          )
        ) *
        0.22
      );

    ctx.stroke();
  }

  /*
   * Teaching hint ring also follows board-plane perspective.
   */
  for (
    const marker
    of hintMarkers
  ) {
    strokePerspectiveBoardCircle(
      homography,
      marker.x /
        18,
      marker.y /
        18,
      orientation,
      gridInsetX,
      gridInsetY,
      stoneScale *
        1.20,
      "#00ffff",
      4
    );
  }

  if (showSeatLabels) {
    drawSeatLabels(
      homography,
      orientation
    );
  }
}

function drawStoneZonePreview(
  homography,
  gridInsetX = 0.035,
  gridInsetY = 0.035,
  outsideTolerance = 0.012
) {
  ctx.fillStyle = "#000";
  ctx.fillRect(
    0,
    0,
    window.innerWidth,
    window.innerHeight
  );

  if (!homography) {
    return;
  }

  const insetX =
    Math.max(
      0,
      Math.min(
        0.20,
        Number(gridInsetX) || 0
      )
    );

  const insetY =
    Math.max(
      0,
      Math.min(
        0.20,
        Number(gridInsetY) || 0
      )
    );

  const tolerance =
    Math.max(
      0,
      Math.min(
        0.10,
        Number(outsideTolerance) || 0
      )
    );

  const clamp01 =
    value =>
      Math.max(
        0,
        Math.min(
          1,
          value
        )
      );

  const gridRect = [
    [insetX, insetY],
    [1 - insetX, insetY],
    [1 - insetX, 1 - insetY],
    [insetX, 1 - insetY]
  ];

  const detectionRect = [
    [
      clamp01(
        insetX -
        tolerance
      ),
      clamp01(
        insetY -
        tolerance
      )
    ],
    [
      clamp01(
        1 -
        insetX +
        tolerance
      ),
      clamp01(
        insetY -
        tolerance
      )
    ],
    [
      clamp01(
        1 -
        insetX +
        tolerance
      ),
      clamp01(
        1 -
        insetY +
        tolerance
      )
    ],
    [
      clamp01(
        insetX -
        tolerance
      ),
      clamp01(
        1 -
        insetY +
        tolerance
      )
    ]
  ];

  function drawRect(
    points,
    strokeStyle,
    lineWidth
  ) {
    ctx.beginPath();

    points.forEach(
      (
        point,
        index
      ) => {
        let projected =
          applyHomography(
            homography,
            point[0],
            point[1]
          );

        projected =
          projectorPixelFromNormalized(
            ...projected
          );

        if (index === 0) {
          ctx.moveTo(
            projected[0],
            projected[1]
          );
        } else {
          ctx.lineTo(
            projected[0],
            projected[1]
          );
        }
      }
    );

    ctx.closePath();
    ctx.strokeStyle =
      strokeStyle;
    ctx.lineWidth =
      lineWidth;
    ctx.stroke();
  }

  drawRect(
    detectionRect,
    "#ff3030",
    5
  );

  drawRect(
    gridRect,
    "#30ff7a",
    4
  );

  ctx.strokeStyle =
    "rgba(255,255,255,0.30)";

  ctx.lineWidth =
    1.5;

  for (
    let i = 0;
    i < 19;
    i++
  ) {
    const t =
      i /
      18;

    const h0 =
      applyGridInset(
        0,
        t,
        insetX,
        insetY
      );

    const h1 =
      applyGridInset(
        1,
        t,
        insetX,
        insetY
      );

    let p0 =
      applyHomography(
        homography,
        h0[0],
        h0[1]
      );

    let p1 =
      applyHomography(
        homography,
        h1[0],
        h1[1]
      );

    p0 =
      projectorPixelFromNormalized(
        ...p0
      );

    p1 =
      projectorPixelFromNormalized(
        ...p1
      );

    ctx.beginPath();
    ctx.moveTo(
      p0[0],
      p0[1]
    );
    ctx.lineTo(
      p1[0],
      p1[1]
    );
    ctx.stroke();

    const v0 =
      applyGridInset(
        t,
        0,
        insetX,
        insetY
      );

    const v1 =
      applyGridInset(
        t,
        1,
        insetX,
        insetY
      );

    p0 =
      applyHomography(
        homography,
        v0[0],
        v0[1]
      );

    p1 =
      applyHomography(
        homography,
        v1[0],
        v1[1]
      );

    p0 =
      projectorPixelFromNormalized(
        ...p0
      );

    p1 =
      projectorPixelFromNormalized(
        ...p1
      );

    ctx.beginPath();
    ctx.moveTo(
      p0[0],
      p0[1]
    );
    ctx.lineTo(
      p1[0],
      p1[1]
    );
    ctx.stroke();
  }
}



function render() {
  ctx.globalAlpha =
    1;

  /*
   * BLACK
   */
  if (
    pattern.type ===
    "black"
  ) {
    ctx.fillStyle =
      "#000";

    ctx.fillRect(
      0,
      0,
      window.innerWidth,
      window.innerHeight
    );

    return;
  }

  /*
   * NEW:
   * SOLID GRAYSCALE ILLUMINATION
   *
   * Used before calibration so OpenCV has enough light to
   * see the physical board and its outer boundary.
   */
  if (
    pattern.type ===
    "solid"
  ) {
    const level =
      Math.min(
        1,
        Math.max(
          0,
          Number(
            pattern.level
          ) || 0
        )
      );

    const channel =
      Math.round(
        level *
        255
      );

    ctx.fillStyle =
      `rgb(${channel}, ${channel}, ${channel})`;

    ctx.fillRect(
      0,
      0,
      window.innerWidth,
      window.innerHeight
    );

    return;
  }

  /*
   * All other calibration patterns start from a black frame.
   */
  ctx.fillStyle =
    "#000";

  ctx.fillRect(
    0,
    0,
    window.innerWidth,
    window.innerHeight
  );

  if (
    pattern.type ===
    "dot"
  ) {
    const x =
      pattern.x *
      window.innerWidth;

    const y =
      pattern.y *
      window.innerHeight;

    const radius =
      pattern.radius *
      Math.min(
        window.innerWidth,
        window.innerHeight
      );

    ctx.beginPath();

    ctx.arc(
      x,
      y,
      radius * 1.18,
      0,
      Math.PI * 2
    );

    ctx.fillStyle =
      "#000";

    ctx.fill();

    ctx.beginPath();

    ctx.arc(
      x,
      y,
      radius,
      0,
      Math.PI * 2
    );

    ctx.fillStyle =
      "#fff";

    ctx.fill();

    return;
  }

  if (
    pattern.type ===
    "stone-zone-preview"
  ) {
    drawStoneZonePreview(
      pattern.homography,
      pattern.gridInsetX,
      pattern.gridInsetY,
      pattern.outsideTolerance
    );
    return;
  }

  if (
    pattern.type ===
    "board-test"
  ) {
    drawBoardTest(
      pattern.homography,
      pattern.gridInsetX,
      pattern.gridInsetY
    );
    return;
  }

  if (
    pattern.type ===
    "orientation-preview"
  ) {
    drawOrientationPreview(
      pattern.homography,
      pattern.orientation,
      pattern.showSeatLabels,
      pattern.gridInsetX,
      pattern.gridInsetY
    );
    return;
  }

  if (
    pattern.type ===
    "game"
  ) {
    drawGame(
      pattern.homography,
      pattern.virtualBoard,
      pattern.captureMarkers,
      pattern.hintMarkers,
      pattern.orientation,
      pattern.showSeatLabels,
      pattern.gridInsetX,
      pattern.gridInsetY,
      pattern.projectedStoneScale
    );
  }
}

window.goAR
  .onProjectorPattern(
    nextPattern => {
      pattern =
        nextPattern;

      render();
    }
  );

resize();
