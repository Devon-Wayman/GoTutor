from __future__ import annotations

import math
import threading
from typing import Optional

import cv2
import numpy as np
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

app = FastAPI(title="Go AR Tutor Vision")

lock = threading.Lock()

latest_frame: Optional[np.ndarray] = None
baseline_frame: Optional[np.ndarray] = None
board_corners: Optional[np.ndarray] = None
board_score: float = 0.0
projection_samples: list[dict] = []


class ProjectorPoint(BaseModel):
    x: float
    y: float


class CalibrationSampleRequest(BaseModel):
    projector: ProjectorPoint


def order_quad(points: np.ndarray) -> np.ndarray:
    pts = np.asarray(points, dtype=np.float32).reshape(4, 2)

    rect = np.zeros((4, 2), dtype=np.float32)

    s = pts.sum(axis=1)
    d = np.diff(pts, axis=1).reshape(-1)

    rect[0] = pts[np.argmin(s)]
    rect[2] = pts[np.argmax(s)]
    rect[1] = pts[np.argmin(d)]
    rect[3] = pts[np.argmax(d)]

    return rect


def polygon_area(points: np.ndarray) -> float:
    return abs(cv2.contourArea(points.astype(np.float32)))


def right_angle_score(quad: np.ndarray) -> float:
    q = order_quad(quad)
    scores = []

    for i in range(4):
        a = q[(i - 1) % 4] - q[i]
        b = q[(i + 1) % 4] - q[i]

        na = np.linalg.norm(a)
        nb = np.linalg.norm(b)

        if na < 1e-6 or nb < 1e-6:
            scores.append(0.0)
            continue

        cosine = abs(float(np.dot(a, b) / (na * nb)))
        scores.append(max(0.0, 1.0 - cosine))

    return float(np.mean(scores))


def detect_board_quad(frame: np.ndarray) -> tuple[Optional[np.ndarray], float]:
    """
    First-pass automatic physical-board detector.

    It searches for a large, near-quadrilateral planar region and scores
    candidates using area, rectangularity, and roughly square proportions.

    This is deliberately a general board detector rather than a color-specific
    detector so it can work with light or dark wooden Go boards.

    Later we can replace/augment this with explicit 19x19 Hough-line scoring.
    """
    h, w = frame.shape[:2]
    frame_area = float(h * w)

    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (7, 7), 0)

    edges = cv2.Canny(gray, 45, 130)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    edges = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, kernel, iterations=2)

    contours, _ = cv2.findContours(
        edges,
        cv2.RETR_LIST,
        cv2.CHAIN_APPROX_SIMPLE
    )

    best_quad = None
    best_score = 0.0

    for contour in contours:
        area = cv2.contourArea(contour)

        if area < frame_area * 0.08:
            continue

        perimeter = cv2.arcLength(contour, True)
        approx = cv2.approxPolyDP(contour, 0.02 * perimeter, True)

        if len(approx) != 4 or not cv2.isContourConvex(approx):
            continue

        quad = order_quad(approx.reshape(4, 2))
        q_area = polygon_area(quad)

        if q_area <= 0:
            continue

        rect = cv2.minAreaRect(quad)
        rw, rh = rect[1]

        if rw <= 1 or rh <= 1:
            continue

        aspect = min(rw, rh) / max(rw, rh)
        rectangularity = min(1.0, area / max(1.0, rw * rh))
        angle = right_angle_score(quad)
        area_score = min(1.0, q_area / (frame_area * 0.45))

        # A Go board is commonly square-ish, but perspective can make it
        # noticeably trapezoidal in camera coordinates.
        score = (
            0.38 * area_score +
            0.25 * rectangularity +
            0.20 * aspect +
            0.17 * angle
        )

        if score > best_score:
            best_score = score
            best_quad = quad

    return best_quad, float(best_score)


def detect_projected_dot(
    baseline: np.ndarray,
    current: np.ndarray
) -> tuple[Optional[tuple[float, float]], float]:
    if baseline.shape != current.shape:
        baseline = cv2.resize(baseline, (current.shape[1], current.shape[0]))

    b_gray = cv2.cvtColor(baseline, cv2.COLOR_BGR2GRAY)
    c_gray = cv2.cvtColor(current, cv2.COLOR_BGR2GRAY)

    # Only positive brightness changes matter. This rejects moving dark objects
    # substantially better than a symmetric absolute difference.
    diff = cv2.subtract(c_gray, b_gray)
    diff = cv2.GaussianBlur(diff, (9, 9), 0)

    # Otsu adapts to different projector brightness / room illumination.
    _, mask = cv2.threshold(
        diff,
        0,
        255,
        cv2.THRESH_BINARY + cv2.THRESH_OTSU
    )

    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)

    contours, _ = cv2.findContours(
        mask,
        cv2.RETR_EXTERNAL,
        cv2.CHAIN_APPROX_SIMPLE
    )

    if not contours:
        return None, 0.0

    h, w = current.shape[:2]
    frame_area = h * w

    best = None
    best_score = 0.0

    for contour in contours:
        area = cv2.contourArea(contour)

        if area < frame_area * 0.00002:
            continue

        if area > frame_area * 0.04:
            continue

        perimeter = cv2.arcLength(contour, True)

        if perimeter <= 0:
            continue

        circularity = float(4 * math.pi * area / (perimeter * perimeter))
        x, y, bw, bh = cv2.boundingRect(contour)
        aspect = min(bw, bh) / max(bw, bh) if max(bw, bh) else 0
        score = max(0.0, circularity) * 0.65 + aspect * 0.35

        M = cv2.moments(contour)
        if M["m00"] == 0:
            continue

        cx = float(M["m10"] / M["m00"])
        cy = float(M["m01"] / M["m00"])

        if score > best_score:
            best_score = score
            best = (cx, cy)

    return best, float(best_score)


def matrix_to_list(matrix: np.ndarray):
    return [[float(v) for v in row] for row in matrix]


@app.get("/health")
def health():
    with lock:
        has_frame = latest_frame is not None

    return {
        "ok": True,
        "hasFrame": has_frame
    }


@app.post("/frame")
async def receive_frame(request: Request):
    global latest_frame, board_corners, board_score

    raw = await request.body()
    data = np.frombuffer(raw, dtype=np.uint8)
    frame = cv2.imdecode(data, cv2.IMREAD_COLOR)

    if frame is None:
        raise HTTPException(400, "Invalid JPEG frame.")

    # Opportunistically keep a board estimate fresh.
    detected, score = detect_board_quad(frame)

    with lock:
        latest_frame = frame

        # Avoid replacing a solid board estimate with a transient weak contour.
        if detected is not None and score >= max(0.50, board_score - 0.05):
            board_corners = detected
            board_score = score

        corners = (
            board_corners.astype(float).tolist()
            if board_corners is not None
            else None
        )

    return {
        "ok": True,
        "boardCorners": corners,
        "boardScore": board_score
    }


@app.post("/board/detect")
def detect_board():
    global board_corners, board_score

    with lock:
        if latest_frame is None:
            raise HTTPException(409, "No camera frame has been received yet.")
        frame = latest_frame.copy()

    quad, score = detect_board_quad(frame)

    if quad is None or score < 0.50:
        raise HTTPException(
            422,
            "Could not confidently detect the Go board. "
            "Move the camera so the complete board is visible with a little margin."
        )

    with lock:
        board_corners = quad
        board_score = score

    return {
        "ok": True,
        "corners": quad.astype(float).tolist(),
        "score": score
    }


@app.post("/calibration/reset")
def reset_calibration():
    global baseline_frame, projection_samples
    with lock:
        baseline_frame = None
        projection_samples = []
    return {"ok": True}


@app.post("/calibration/baseline")
def capture_baseline():
    global baseline_frame

    with lock:
        if latest_frame is None:
            raise HTTPException(409, "No camera frame is available.")
        baseline_frame = latest_frame.copy()

    return {"ok": True}


@app.post("/calibration/sample")
def sample_calibration(req: CalibrationSampleRequest):
    global projection_samples

    with lock:
        if latest_frame is None or baseline_frame is None:
            raise HTTPException(409, "Calibration baseline is not ready.")

        current = latest_frame.copy()
        baseline = baseline_frame.copy()

    point, score = detect_projected_dot(baseline, current)

    if point is None or score < 0.35:
        return {
            "found": False,
            "score": score
        }

    sample = {
        "projector": [float(req.projector.x), float(req.projector.y)],
        "camera": [float(point[0]), float(point[1])],
        "score": float(score)
    }

    with lock:
        projection_samples.append(sample)

    return {
        "found": True,
        **sample
    }


@app.post("/calibration/solve")
def solve_calibration():
    with lock:
        samples = list(projection_samples)
        corners = None if board_corners is None else board_corners.copy()
        score = board_score

    if corners is None:
        raise HTTPException(409, "Physical board corners are unavailable.")

    if len(samples) < 4:
        raise HTTPException(422, "At least four projection samples are required.")

    projector_pts = np.asarray(
        [sample["projector"] for sample in samples],
        dtype=np.float32
    )

    camera_pts = np.asarray(
        [sample["camera"] for sample in samples],
        dtype=np.float32
    )

    # Hpc: projector-normalized -> camera-pixel
    Hpc, mask = cv2.findHomography(
        projector_pts,
        camera_pts,
        cv2.RANSAC,
        ransacReprojThreshold=5.0
    )

    if Hpc is None:
        raise HTTPException(422, "Could not solve projector-to-camera homography.")

    Hcp = np.linalg.inv(Hpc)

    # Transform the physical board's camera-space corners back into normalized
    # projector coordinates.
    camera_quad = corners.reshape(1, 4, 2).astype(np.float32)
    projector_quad = cv2.perspectiveTransform(
        camera_quad,
        Hcp.astype(np.float64)
    )[0]

    board_norm = np.asarray([
        [0.0, 0.0],
        [1.0, 0.0],
        [1.0, 1.0],
        [0.0, 1.0]
    ], dtype=np.float32)

    # Hbp maps logical board-normalized coordinates directly into
    # projector-normalized coordinates.
    Hbp = cv2.getPerspectiveTransform(
        board_norm,
        projector_quad.astype(np.float32)
    )

    inliers = int(mask.sum()) if mask is not None else len(samples)

    return {
        "ok": True,
        "sampleCount": len(samples),
        "inliers": inliers,
        "boardDetectionScore": float(score),
        "projectorToCameraHomography": matrix_to_list(Hpc),
        "cameraToProjectorHomography": matrix_to_list(Hcp),
        "boardToProjectorHomography": matrix_to_list(Hbp),
        "boardQuadProjector": projector_quad.astype(float).tolist(),
        "boardCornersCamera": corners.astype(float).tolist()
    }


if __name__ == "__main__":
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=8765,
        log_level="info"
    )
