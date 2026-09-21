from __future__ import annotations

import math
import threading
import os
import json
from datetime import datetime, timezone
from pathlib import Path
from collections import deque
from typing import Optional

import cv2
import numpy as np
import uvicorn

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

# ============================================================
# NEW: PHYSICAL STONE TRACKING
# ============================================================
# This module performs the actual per-intersection black-stone
# recognition after the physical board has been calibrated.
from stone_detector import detect_black_stones


app = FastAPI(
    title="Go AR Tutor Vision"
)

lock = threading.Lock()

DEBUG_ENABLED = os.environ.get("GO_TUTOR_DEBUG","0") == "1"
DEBUG_DIR = Path(os.environ.get("GO_TUTOR_DEBUG_DIR",str(Path(__file__).resolve().parents[1]/"debug_logs")))
DEBUG_SESSION_ID = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
DEBUG_LOG_PATH = DEBUG_DIR / f"vision-{DEBUG_SESSION_ID}.jsonl"
DEBUG_FRAME_DIR = DEBUG_DIR / f"calibration-{DEBUG_SESSION_ID}"
if DEBUG_ENABLED:
    DEBUG_DIR.mkdir(parents=True,exist_ok=True)
    DEBUG_FRAME_DIR.mkdir(parents=True,exist_ok=True)

def debug_log(event: str, **data):
    if not DEBUG_ENABLED:
        return
    try:
        with DEBUG_LOG_PATH.open("a",encoding="utf-8") as handle:
            handle.write(json.dumps({"timestamp":datetime.now(timezone.utc).isoformat(),"event":event,"data":data},default=str)+"\
")
    except Exception:
        pass


# ============================================================
# CAMERA / BOARD STATE
# ============================================================

latest_frame: Optional[np.ndarray] = None

baseline_frame: Optional[np.ndarray] = None

board_corners: Optional[np.ndarray] = None

board_score: float = 0.0


# Recent board detections used to form a stable consensus BEFORE
# calibration turns the projector black.
board_detection_history = deque(maxlen=40)

# Frozen board geometry for the current projector-calibration run.
# Live board_corners may continue updating for the UI, but calibration
# must use one fixed physical quadrilateral from start to finish.
calibration_board_corners: Optional[np.ndarray] = None
calibration_board_score: float = 0.0

projection_samples: list[dict] = []

latest_frame_sequence: int = 0
calibration_reference_frame: Optional[np.ndarray] = None
calibration_reference_sequence: int = -1
calibration_reference_target: Optional[tuple[float,float]] = None
calibration_reference_phase: str = "unknown"
coarse_projector_to_camera: Optional[np.ndarray] = None
coarse_model_median_error: float = 0.0
coarse_model_inliers: int = 0


# ============================================================
# NEW: PHYSICAL STONE TRACKING STATE
# ============================================================

# Empty-board camera frame.
#
# This is intentionally separate from the projector-calibration
# baseline because the two baselines have different purposes.
stone_baseline_frame: Optional[np.ndarray] = None

# Most recently accepted physical-board state.
#
# 0 = empty
# 1 = physical black stone
last_detected_stone_board = [
    [0 for _ in range(19)]
    for _ in range(19)
]


# ============================================================
# PHYSICAL STONE TRACKING STABILITY
# ============================================================

# Board corners are frozen when the empty-board reference is
# captured. We do NOT want tiny automatic board-detection
# changes altering our stone coordinate system every frame.
stone_board_corners: Optional[np.ndarray] = None

# Positive values mean repeated evidence that an intersection
# contains a black stone.
#
# Negative values mean repeated evidence that it is empty.
stone_stability = [
    [0 for _ in range(19)]
    for _ in range(19)
]

# Number of consecutive-ish observations required before state
# changes.
STONE_CONFIRM_THRESHOLD = 4

# If a single camera sample suddenly claims many intersections
# changed simultaneously, it is probably:
# - a hand over the board
# - lighting/exposure shift
# - camera motion
# - projector transition
# rather than a legal human move.
MAX_RAW_CHANGES = 5


# Physical Go-grid location inside the detected wooden board.
# 0.035 means the outermost printed grid line is 3.5% inward
# from each corresponding board edge.
stone_grid_inset_x: float = 0.035
stone_grid_inset_y: float = 0.035


stone_outside_tolerance: float = 0.012
stone_hard_mask_inset: float = 0.0


# ============================================================
# API MODELS
# ============================================================

class ProjectorPoint(BaseModel):
    x: float
    y: float


class CalibrationSampleRequest(BaseModel):
    projector: ProjectorPoint
    phase: str = "unknown"

class CalibrationReferenceRequest(BaseModel):
    projector: ProjectorPoint
    phase: str = "unknown"


class GridInsetRequest(BaseModel):
    x: float = 0.035
    y: float = 0.035


class StoneDetectionBoundaryRequest(BaseModel):
    outsideTolerance: float = 0.012
    hardMaskInset: float = 0.0
    confirmFrames: int = 4


# ============================================================
# GEOMETRY HELPERS
# ============================================================

def order_quad(
    points: np.ndarray
) -> np.ndarray:
    """
    Order four points as:

        top-left
        top-right
        bottom-right
        bottom-left
    """

    pts = np.asarray(
        points,
        dtype=np.float32
    ).reshape(4, 2)

    rect = np.zeros(
        (4, 2),
        dtype=np.float32
    )

    sums = pts.sum(axis=1)

    diffs = np.diff(
        pts,
        axis=1
    ).reshape(-1)

    rect[0] = pts[
        np.argmin(sums)
    ]

    rect[2] = pts[
        np.argmax(sums)
    ]

    rect[1] = pts[
        np.argmin(diffs)
    ]

    rect[3] = pts[
        np.argmax(diffs)
    ]

    return rect


def polygon_area(
    points: np.ndarray
) -> float:
    return abs(
        cv2.contourArea(
            points.astype(
                np.float32
            )
        )
    )


def right_angle_score(
    quad: np.ndarray
) -> float:
    """
    Returns approximately 1.0 for a good rectangle and lower
    values as the corner geometry becomes less rectangular.
    """

    q = order_quad(
        quad
    )

    scores = []

    for i in range(4):
        a = (
            q[(i - 1) % 4] -
            q[i]
        )

        b = (
            q[(i + 1) % 4] -
            q[i]
        )

        na = np.linalg.norm(a)
        nb = np.linalg.norm(b)

        if (
            na < 1e-6 or
            nb < 1e-6
        ):
            scores.append(0.0)
            continue

        cosine = abs(
            float(
                np.dot(
                    a,
                    b
                ) /
                (na * nb)
            )
        )

        scores.append(
            max(
                0.0,
                1.0 - cosine
            )
        )

    return float(
        np.mean(scores)
    )


def matrix_to_list(
    matrix: np.ndarray
):
    return [
        [
            float(value)
            for value in row
        ]
        for row in matrix
    ]


# ============================================================
# PHYSICAL GO BOARD DETECTION
# ============================================================

def detect_board_quad(
    frame: np.ndarray
) -> tuple[
    Optional[np.ndarray],
    float
]:
    """
    Finds a large rectangular board candidate.

    This is still our first-generation physical-board detector.
    Later we can strengthen it by explicitly verifying the 19x19
    line grid using Hough transforms.
    """

    height, width = frame.shape[:2]

    frame_area = float(
        height * width
    )

    gray = cv2.cvtColor(
        frame,
        cv2.COLOR_BGR2GRAY
    )

    gray = cv2.GaussianBlur(
        gray,
        (7, 7),
        0
    )

    edges = cv2.Canny(
        gray,
        45,
        130
    )

    kernel = cv2.getStructuringElement(
        cv2.MORPH_RECT,
        (5, 5)
    )

    edges = cv2.morphologyEx(
        edges,
        cv2.MORPH_CLOSE,
        kernel,
        iterations=2
    )

    contours, _ = cv2.findContours(
        edges,
        cv2.RETR_LIST,
        cv2.CHAIN_APPROX_SIMPLE
    )

    best_quad = None
    best_score = 0.0

    for contour in contours:
        area = cv2.contourArea(
            contour
        )

        if (
            area <
            frame_area * 0.08
        ):
            continue

        perimeter = cv2.arcLength(
            contour,
            True
        )

        approx = cv2.approxPolyDP(
            contour,
            0.02 * perimeter,
            True
        )

        if (
            len(approx) != 4 or
            not cv2.isContourConvex(
                approx
            )
        ):
            continue

        quad = order_quad(
            approx.reshape(
                4,
                2
            )
        )

        quad_area = polygon_area(
            quad
        )

        if quad_area <= 0:
            continue

        rect = cv2.minAreaRect(
            quad
        )

        rect_width, rect_height = (
            rect[1]
        )

        if (
            rect_width <= 1 or
            rect_height <= 1
        ):
            continue

        aspect = (
            min(
                rect_width,
                rect_height
            ) /
            max(
                rect_width,
                rect_height
            )
        )

        rectangularity = min(
            1.0,
            area /
            max(
                1.0,
                rect_width *
                rect_height
            )
        )

        angle_score = right_angle_score(
            quad
        )

        area_score = min(
            1.0,
            quad_area /
            (
                frame_area *
                0.45
            )
        )

        score = (
            0.38 * area_score +
            0.25 * rectangularity +
            0.20 * aspect +
            0.17 * angle_score
        )

        if score > best_score:
            best_score = score
            best_quad = quad

    return (
        best_quad,
        float(best_score)
    )


# ============================================================
# PROJECTED CALIBRATION DOT DETECTION
# ============================================================

def detect_projected_dot(baseline: np.ndarray,current: np.ndarray,expected_point: Optional[tuple[float,float]]=None,expected_radius: Optional[float]=None):
    if baseline.shape != current.shape:
        baseline=cv2.resize(baseline,(current.shape[1],current.shape[0]))
    b=cv2.cvtColor(baseline,cv2.COLOR_BGR2GRAY).astype(np.int16)
    c=cv2.cvtColor(current,cv2.COLOR_BGR2GRAY).astype(np.int16)
    signed=c-b
    global_shift=float(np.median(signed))
    residual=np.clip(signed-global_shift,0,255).astype(np.uint8)
    diff=cv2.GaussianBlur(residual,(7,7),0)
    max_value=float(np.max(diff))
    diagnostics={"maxChange":max_value,"globalBrightnessShift":global_shift,"expectedPoint":list(expected_point) if expected_point else None,"expectedRadius":expected_radius,"candidateCount":0,"bestDistance":None,"threshold":None}
    if max_value < 20:
        diagnostics["reason"]="not_visible"
        return None,0.0,diagnostics,diff,np.zeros_like(diff)
    otsu,_=cv2.threshold(diff,0,255,cv2.THRESH_BINARY+cv2.THRESH_OTSU)
    threshold=max(18.0,float(otsu),max_value*0.42)
    diagnostics["threshold"]=threshold
    _,mask=cv2.threshold(diff,threshold,255,cv2.THRESH_BINARY)
    kernel=cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(5,5))
    mask=cv2.morphologyEx(mask,cv2.MORPH_OPEN,kernel)
    mask=cv2.morphologyEx(mask,cv2.MORPH_CLOSE,kernel,iterations=2)
    contours,_=cv2.findContours(mask,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
    h,w=current.shape[:2]; frame_area=float(h*w); candidates=[]
    for contour in contours:
        area=float(cv2.contourArea(contour))
        if area < frame_area*0.00001 or area > frame_area*0.018: continue
        perimeter=cv2.arcLength(contour,True)
        if perimeter <= 0: continue
        circularity=4*math.pi*area/(perimeter*perimeter)
        x,y,bw,bh=cv2.boundingRect(contour)
        if bw<=0 or bh<=0: continue
        aspect=min(bw,bh)/max(bw,bh)
        m=cv2.moments(contour)
        if m["m00"] == 0: continue
        cx=float(m["m10"]/m["m00"]); cy=float(m["m01"]/m["m00"])
        cmask=np.zeros_like(diff); cv2.drawContours(cmask,[contour],-1,255,-1)
        bright=cv2.mean(diff,mask=cmask)[0]
        score=0.38*min(1.0,max(0.0,circularity))+0.22*aspect+0.30*min(1.0,bright/100.0)+0.10*min(1.0,max(0.0,(area/frame_area)/0.00035))
        distance=math.hypot(cx-expected_point[0],cy-expected_point[1]) if expected_point else None
        candidates.append({"point":(cx,cy),"score":float(score),"distance":distance,"area":area,"brightness":bright,"circularity":circularity,"aspect":aspect})
    diagnostics["candidateCount"]=len(candidates)
    if not candidates:
        diagnostics["reason"]="not_visible"; return None,0.0,diagnostics,diff,mask
    if expected_point is not None and expected_radius is not None:
        in_window=[q for q in candidates if q["distance"] is not None and q["distance"]<=expected_radius]
        nearest=min(candidates,key=lambda q:q["distance"] if q["distance"] is not None else float("inf"))
        diagnostics["bestDistance"]=nearest["distance"]
        if not in_window:
            diagnostics["reason"]="wrong_location"; diagnostics["nearestCandidate"]={"point":list(nearest["point"]),"distance":nearest["distance"],"score":nearest["score"]}
            return None,float(nearest["score"]),diagnostics,diff,mask
        def rank(q):
            spatial=1.0-min(1.0,q["distance"]/max(expected_radius,1.0))
            return 0.70*q["score"]+0.30*spatial
        best=max(in_window,key=rank); diagnostics["bestDistance"]=best["distance"]
    else:
        best=max(candidates,key=lambda q:q["score"])
    diagnostics["bestCandidate"]={k:(list(v) if k=="point" else v) for k,v in best.items()}
    if best["score"] < 0.42:
        diagnostics["reason"]="low_confidence"; return None,float(best["score"]),diagnostics,diff,mask
    diagnostics["reason"]="accepted"
    return best["point"],float(best["score"]),diagnostics,diff,mask


# ============================================================
# PROJECTOR CALIBRATION QUALITY
# ============================================================

def projector_coverage(
    projector_points: np.ndarray
) -> float:
    """
    Returns the normalized area covered by the convex hull of
    projector calibration points.
    """

    if len(
        projector_points
    ) < 3:
        return 0.0

    hull = cv2.convexHull(
        projector_points.astype(
            np.float32
        )
    )

    return float(
        cv2.contourArea(
            hull
        )
    )


def reprojection_errors(
    homography: np.ndarray,
    source: np.ndarray,
    destination: np.ndarray
) -> np.ndarray:
    """
    Measure pixel error after applying a solved homography.
    """

    projected = cv2.perspectiveTransform(
        source.reshape(
            -1,
            1,
            2
        ).astype(
            np.float32
        ),
        homography
    ).reshape(
        -1,
        2
    )

    return np.linalg.norm(
        projected -
        destination,
        axis=1
    )


# ============================================================
# HEALTH
# ============================================================

@app.get(
    "/health"
)
def health():
    with lock:
        has_frame = (
            latest_frame
            is not None
        )

    return {
        "ok": True,
        "hasFrame": has_frame,
        "processId": os.getpid(),
        "debugEnabled": DEBUG_ENABLED,
        "sessionId": DEBUG_SESSION_ID
    }


# ============================================================
# RECEIVE CAMERA FRAMES FROM ELECTRON
# ============================================================

@app.post(
    "/frame"
)
async def receive_frame(
    request: Request
):
    global latest_frame
    global latest_frame_sequence
    global board_corners
    global board_score

    raw = await request.body()

    data = np.frombuffer(
        raw,
        dtype=np.uint8
    )

    frame = cv2.imdecode(
        data,
        cv2.IMREAD_COLOR
    )

    if frame is None:
        raise HTTPException(
            400,
            "Invalid JPEG frame."
        )

    detected, score = detect_board_quad(
        frame
    )

    with lock:
        latest_frame = frame
        latest_frame_sequence += 1

        if (
            detected is not None and
            score >= 0.50
        ):
            board_detection_history.append(
                {
                    "sequence":
                        int(
                            latest_frame_sequence
                        ),
                    "corners":
                        detected.copy(),
                    "score":
                        float(score)
                }
            )

        # Keep the strongest reasonably stable physical-board
        # detection rather than replacing it with every frame.
        if (
            detected is not None and
            score >= max(
                0.50,
                board_score - 0.05
            )
        ):
            board_corners = detected
            board_score = score

        corners = (
            board_corners
            .astype(float)
            .tolist()
            if
            board_corners is not None
            else None
        )

    return {
        "ok": True,
        "boardCorners": corners,
        "boardScore": board_score
    }


# ============================================================
# PHYSICAL BOARD DETECTION
# ============================================================

@app.post(
    "/board/detect"
)
def detect_board():
    global board_corners
    global board_score

    with lock:
        if latest_frame is None:
            raise HTTPException(
                409,
                "No camera frame has been received yet."
            )

        frame = latest_frame.copy()

    quad, score = detect_board_quad(
        frame
    )

    if (
        quad is None or
        score < 0.50
    ):
        raise HTTPException(
            422,
            (
                "Could not confidently detect the Go board. "
                "Make sure the complete board and outer edges "
                "are visible in the camera."
            )
        )

    with lock:
        board_corners = quad
        board_score = score

    return {
        "ok": True,
        "corners":
            quad
            .astype(float)
            .tolist(),
        "score": score
    }


# ============================================================
# PROJECTOR CALIBRATION
# ============================================================

@app.post(
    "/calibration/board-lock"
)
def lock_calibration_board():
    """
    Freeze the physical board geometry from a recent multi-frame
    consensus while board illumination is still active.

    This intentionally does NOT redetect the board after the
    projector is black, because dark-scene contour detection was
    selecting different nested rectangles between calibration runs.
    """

    global calibration_board_corners
    global calibration_board_score

    with lock:
        history = list(
            board_detection_history
        )

    if len(history) < 8:
        raise HTTPException(
            422,
            (
                "Not enough recent illuminated board detections "
                f"to lock geometry ({len(history)} available; "
                "need at least 8)."
            )
        )

    # Use only the most recent detections so the consensus reflects
    # the current camera/board pose.
    recent = history[-20:]

    corner_stack = np.stack(
        [
            item["corners"]
            for item
            in recent
        ],
        axis=0
    ).astype(
        np.float32
    )

    median_corners = np.median(
        corner_stack,
        axis=0
    )

    # Distance of every corresponding corner from its median.
    deviations = np.linalg.norm(
        corner_stack -
        median_corners[
            np.newaxis,
            :,
            :
        ],
        axis=2
    )

    max_deviation = float(
        np.max(
            deviations
        )
    )

    median_deviation = float(
        np.median(
            deviations
        )
    )

    scores = np.asarray(
        [
            item["score"]
            for item
            in recent
        ],
        dtype=np.float32
    )

    median_score = float(
        np.median(
            scores
        )
    )

    # More than ~12 camera pixels of disagreement indicates that the
    # contour detector is hopping between different rectangles.
    if max_deviation > 12.0:
        debug_log(
            "board-lock-rejected",
            sampleCount=
                len(recent),
            maxDeviation=
                max_deviation,
            medianDeviation=
                median_deviation,
            medianScore=
                median_score,
            medianCorners=
                median_corners.tolist()
        )

        raise HTTPException(
            422,
            (
                "Board geometry is unstable before calibration. "
                f"Recent detections disagree by up to "
                f"{max_deviation:.1f}px. Keep the camera/board still "
                "and ensure illumination clearly exposes the same "
                "outer board edge."
            )
        )

    with lock:
        calibration_board_corners = (
            median_corners.copy()
        )

        calibration_board_score = (
            median_score
        )

    debug_log(
        "board-lock-accepted",
        sampleCount=
            len(recent),
        maxDeviation=
            max_deviation,
        medianDeviation=
            median_deviation,
        medianScore=
            median_score,
        corners=
            median_corners.tolist()
    )

    return {
        "ok": True,
        "sampleCount":
            len(recent),
        "maxDeviation":
            max_deviation,
        "medianDeviation":
            median_deviation,
        "score":
            median_score,
        "corners":
            median_corners
            .astype(float)
            .tolist()
    }


@app.post(
    "/calibration/reset"
)
def reset_calibration():
    global baseline_frame, projection_samples, calibration_board_corners, calibration_board_score
    global calibration_reference_frame, calibration_reference_sequence, calibration_reference_target, calibration_reference_phase
    global coarse_projector_to_camera, coarse_model_median_error, coarse_model_inliers
    with lock:
        baseline_frame=None; projection_samples=[]; calibration_board_corners=None; calibration_board_score=0.0
        calibration_reference_frame=None; calibration_reference_sequence=-1; calibration_reference_target=None; calibration_reference_phase="unknown"
        coarse_projector_to_camera=None; coarse_model_median_error=0.0; coarse_model_inliers=0
    debug_log("calibration-reset")
    return {"ok":True}


@app.post(
    "/calibration/baseline"
)
def capture_baseline():
    global baseline_frame

    with lock:
        if latest_frame is None:
            raise HTTPException(
                409,
                "No camera frame is available."
            )

        if calibration_board_corners is None:
            raise HTTPException(
                409,
                (
                    "Calibration board geometry has not been locked. "
                    "Run /calibration/board-lock while the board is "
                    "illuminated before switching the projector black."
                )
            )

        baseline_frame = (
            latest_frame.copy()
        )

        score = float(
            calibration_board_score
        )

        locked_corners = (
            calibration_board_corners
            .astype(float)
            .tolist()
        )

    debug_log(
        "calibration-baseline",
        boardScore=
            score,
        lockedCorners=
            locked_corners
    )

    return {
        "ok": True,
        "boardCornersFrozen": True,
        "boardDetectionScore":
            score,
        "boardCorners":
            locked_corners
    }

@app.post("/calibration/reference")
def capture_calibration_reference(request: CalibrationReferenceRequest):
    global calibration_reference_frame, calibration_reference_sequence, calibration_reference_target, calibration_reference_phase
    with lock:
        if latest_frame is None: raise HTTPException(409,"No camera frame is available.")
        calibration_reference_frame=latest_frame.copy(); calibration_reference_sequence=int(latest_frame_sequence)
        calibration_reference_target=(float(request.projector.x),float(request.projector.y)); calibration_reference_phase=request.phase
        sequence=calibration_reference_sequence
    debug_log("calibration-reference",phase=request.phase,projector=[request.projector.x,request.projector.y],frameSequence=sequence)
    return {"ok":True,"phase":request.phase,"projector":[request.projector.x,request.projector.y],"frameSequence":sequence}

@app.post("/calibration/coarse-model")
def build_coarse_calibration_model():
    global coarse_projector_to_camera, coarse_model_median_error, coarse_model_inliers
    with lock:
        coarse=[s for s in projection_samples if s.get("phase")=="coarse"]
    if len(coarse)<6: raise HTTPException(422,"Need at least 6 accepted coarse samples before dense validation.")
    pp=np.array([s["projector"] for s in coarse],dtype=np.float32); cp=np.array([s["camera"] for s in coarse],dtype=np.float32)
    H,mask=cv2.findHomography(pp,cp,cv2.RANSAC,8.0)
    if H is None or mask is None: raise HTTPException(422,"Could not solve a reliable coarse projector-to-camera model.")
    inliers=mask.reshape(-1).astype(bool); count=int(np.sum(inliers))
    if count<5: raise HTTPException(422,f"Only {count} coarse samples agreed with the temporary homography.")
    errors=reprojection_errors(H,pp,cp); ie=errors[inliers]; median=float(np.median(ie)); maxerr=float(np.max(ie))
    if median>18.0: raise HTTPException(422,f"The coarse calibration model is too noisy ({median:.1f}px median error).")
    with lock:
        coarse_projector_to_camera=H.copy(); coarse_model_median_error=median; coarse_model_inliers=count
    debug_log("coarse-model",acceptedSamples=len(coarse),inliers=count,medianError=median,maxError=maxerr,homography=H.tolist())
    return {"ok":True,"acceptedSamples":len(coarse),"inliers":count,"medianError":median,"maxError":maxerr}

@app.post(
    "/calibration/sample"
)
def sample_calibration(request: CalibrationSampleRequest):
    global projection_samples, calibration_reference_frame, calibration_reference_sequence, calibration_reference_target, calibration_reference_phase
    with lock:
        if latest_frame is None or calibration_reference_frame is None: raise HTTPException(409,"Per-point calibration reference is not ready.")
        current=latest_frame.copy(); current_seq=int(latest_frame_sequence); reference=calibration_reference_frame.copy(); ref_seq=int(calibration_reference_sequence)
        ref_target=calibration_reference_target; ref_phase=calibration_reference_phase
        coarse=None if coarse_projector_to_camera is None else coarse_projector_to_camera.copy(); coarse_error=float(coarse_model_median_error)
        calibration_reference_frame=None; calibration_reference_sequence=-1; calibration_reference_target=None; calibration_reference_phase="unknown"
    requested=(float(request.projector.x),float(request.projector.y))
    if ref_target is None or math.hypot(requested[0]-ref_target[0],requested[1]-ref_target[1])>0.0005 or ref_phase!=request.phase:
        return {"found":False,"reason":"reference_mismatch","phase":request.phase}
    if current_seq<=ref_seq:
        result={"found":False,"reason":"stale_frame","phase":request.phase,"referenceFrameSequence":ref_seq,"currentFrameSequence":current_seq}
        debug_log("sample-rejected",projector=list(requested),**result); return result
    expected=None; radius=None
    if request.phase=="dense" and coarse is not None:
        source=np.array([[[requested[0],requested[1]]]],dtype=np.float32); pred=cv2.perspectiveTransform(source,coarse).reshape(2)
        expected=(float(pred[0]),float(pred[1])); radius=float(max(35.0,min(120.0,30.0+4.0*coarse_error)))
    point,score,diag,diff,mask=detect_projected_dot(reference,current,expected_point=expected,expected_radius=radius)
    if DEBUG_ENABLED:
        stem=f"{request.phase}-{requested[0]:.4f}-{requested[1]:.4f}-{ref_seq}-{current_seq}"
        try:
            cv2.imwrite(str(DEBUG_FRAME_DIR/f"{stem}-reference.jpg"),reference); cv2.imwrite(str(DEBUG_FRAME_DIR/f"{stem}-current.jpg"),current)
            cv2.imwrite(str(DEBUG_FRAME_DIR/f"{stem}-diff.png"),diff); cv2.imwrite(str(DEBUG_FRAME_DIR/f"{stem}-mask.png"),mask)
        except Exception: pass
    if point is None:
        result={"found":False,"score":float(score),"reason":diag.get("reason","not_visible"),"phase":request.phase,"diagnostics":diag,"referenceFrameSequence":ref_seq,"currentFrameSequence":current_seq}
        debug_log("sample-rejected",projector=list(requested),**result); return result
    sample={"projector":[requested[0],requested[1]],"camera":[float(point[0]),float(point[1])],"score":float(score),"phase":request.phase,"diagnostics":diag}
    with lock: projection_samples.append(sample)
    result={"found":True,"reason":"accepted",**sample}; debug_log("sample-accepted",**result); return result


@app.post(
    "/calibration/solve"
)
def solve_calibration():
    with lock:
        samples = list(
            projection_samples
        )

        corners = (
            None
            if
            calibration_board_corners is None
            else
            calibration_board_corners.copy()
        )

        score = calibration_board_score

    if corners is None:
        raise HTTPException(
            409,
            "Frozen calibration board corners are unavailable. Capture the calibration baseline first."
        )

    # Do not accept four-point calibrations anymore.
    if len(samples) < 12:
        raise HTTPException(
            422,
            (
                f"Only {len(samples)} usable projection samples "
                "were found. At least 12 are required."
            )
        )

    projector_points = np.asarray(
        [
            sample["projector"]
            for sample
            in samples
        ],
        dtype=np.float32
    )

    camera_points = np.asarray(
        [
            sample["camera"]
            for sample
            in samples
        ],
        dtype=np.float32
    )

    coverage = projector_coverage(
        projector_points
    )

    if coverage < 0.015:
        raise HTTPException(
            422,
            (
                "Calibration samples do not cover enough "
                "projector area."
            )
        )

    projector_to_camera, mask = (
        cv2.findHomography(
            projector_points,
            camera_points,
            cv2.RANSAC,
            ransacReprojThreshold=6.0
        )
    )

    if (
        projector_to_camera is None or
        mask is None
    ):
        raise HTTPException(
            422,
            (
                "Could not solve projector-to-camera "
                "homography."
            )
        )

    inlier_mask = (
        mask.reshape(-1)
        .astype(bool)
    )

    inliers = int(
        np.sum(
            inlier_mask
        )
    )

    if inliers < 12:
        raise HTTPException(
            422,
            (
                f"Only {inliers} calibration points survived "
                "RANSAC. At least 12 are required."
            )
        )

    errors = reprojection_errors(
        projector_to_camera,
        projector_points,
        camera_points
    )

    inlier_errors = errors[
        inlier_mask
    ]

    mean_error = float(
        np.mean(
            inlier_errors
        )
    )

    median_error = float(
        np.median(
            inlier_errors
        )
    )

    max_error = float(
        np.max(
            inlier_errors
        )
    )

    if mean_error > 8.0:
        raise HTTPException(
            422,
            (
                "Calibration rejected: "
                f"mean reprojection error is "
                f"{mean_error:.2f}px."
            )
        )

    if max_error > 25.0:
        raise HTTPException(
            422,
            (
                "Calibration rejected: "
                f"maximum reprojection error is "
                f"{max_error:.2f}px."
            )
        )

    try:
        camera_to_projector = np.linalg.inv(
            projector_to_camera
        )

    except np.linalg.LinAlgError:
        raise HTTPException(
            422,
            "Calibration matrix is singular."
        )

    camera_quad = corners.reshape(
        1,
        4,
        2
    ).astype(
        np.float32
    )

    projector_quad = (
        cv2.perspectiveTransform(
            camera_quad,
            camera_to_projector.astype(
                np.float64
            )
        )[0]
    )

    # Some overscan is acceptable, but huge values indicate a
    # bad solution.
    if (
        np.any(
            projector_quad <
            -0.20
        ) or
        np.any(
            projector_quad >
            1.20
        )
    ):
        raise HTTPException(
            422,
            (
                "Calibration produced board coordinates far "
                "outside the projector framebuffer."
            )
        )

    board_normalized = np.asarray(
        [
            [0.0, 0.0],
            [1.0, 0.0],
            [1.0, 1.0],
            [0.0, 1.0]
        ],
        dtype=np.float32
    )

    board_to_projector = (
        cv2.getPerspectiveTransform(
            board_normalized,
            projector_quad.astype(
                np.float32
            )
        )
    )

    quality = "GOOD"

    if (
        mean_error > 4.0 or
        inliers < 20
    ):
        quality = "ACCEPTABLE"

    coarse_count = sum(
        1
        for sample in samples
        if sample.get(
            "phase"
        ) == "coarse"
    )

    dense_count = sum(
        1
        for sample in samples
        if sample.get(
            "phase"
        ) == "dense"
    )

    return {
        "ok": True,

        "quality":
            quality,

        "sampleCount":
            len(samples),

        "coarseSamples":
            coarse_count,

        "denseSamples":
            dense_count,

        "inliers":
            inliers,

        "boardDetectionScore":
            float(score),

        "projectorCoverage":
            float(coverage),

        "meanReprojectionError":
            mean_error,

        "medianReprojectionError":
            median_error,

        "maxReprojectionError":
            max_error,

        "projectorToCameraHomography":
            matrix_to_list(
                projector_to_camera
            ),

        "cameraToProjectorHomography":
            matrix_to_list(
                camera_to_projector
            ),

        "boardToProjectorHomography":
            matrix_to_list(
                board_to_projector
            ),

        "boardQuadProjector":
            projector_quad
            .astype(float)
            .tolist(),

        "boardCornersCamera":
            corners
            .astype(float)
            .tolist()
    }


# ============================================================
# NEW: PHYSICAL BLACK-STONE TRACKING
# ============================================================
@app.post(
    "/stones/grid-inset"
)
def set_stone_grid_inset(
    request: GridInsetRequest
):
    global stone_grid_inset_x
    global stone_grid_inset_y

    x = float(
        np.clip(
            request.x,
            0.0,
            0.20
        )
    )

    y = float(
        np.clip(
            request.y,
            0.0,
            0.20
        )
    )

    with lock:
        stone_grid_inset_x = x
        stone_grid_inset_y = y

    return {
        "ok": True,
        "gridInsetX": x,
        "gridInsetY": y
    }


@app.post(
    "/stones/detection-boundary"
)
def set_stone_detection_boundary(
    request: StoneDetectionBoundaryRequest
):
    global stone_outside_tolerance
    global stone_hard_mask_inset
    global STONE_CONFIRM_THRESHOLD
    global stone_stability

    tolerance = float(
        np.clip(
            request.outsideTolerance,
            0.0,
            0.10
        )
    )

    hard_mask_inset = float(
        np.clip(
            request.hardMaskInset,
            0.0,
            0.15
        )
    )

    confirm_frames = int(
        np.clip(
            request.confirmFrames,
            2,
            8
        )
    )

    with lock:
        stone_outside_tolerance = (
            tolerance
        )

        stone_hard_mask_inset = (
            hard_mask_inset
        )

        if (
            STONE_CONFIRM_THRESHOLD !=
            confirm_frames
        ):
            STONE_CONFIRM_THRESHOLD = (
                confirm_frames
            )

            stone_stability = [
                [
                    0
                    for _ in range(19)
                ]
                for _ in range(19)
            ]

    debug_log(
        "stone-detection-boundary",
        outsideTolerance=
            tolerance,
        hardMaskInset=
            hard_mask_inset,
        confirmFrames=
            confirm_frames
    )

    return {
        "ok": True,
        "outsideTolerance":
            tolerance,
        "hardMaskInset":
            hard_mask_inset,
        "confirmFrames":
            confirm_frames
    }


@app.post(
    "/stones/baseline"
)
def capture_stone_baseline():
    """
    Capture the physical EMPTY board.

    At this moment we also freeze the exact board quadrilateral
    used for all subsequent physical-stone recognition.
    """

    global stone_baseline_frame
    global stone_board_corners
    global last_detected_stone_board
    global stone_stability


    with lock:
        if latest_frame is None:
            raise HTTPException(
                409,
                "No camera frame is available."
            )


        if board_corners is None:
            raise HTTPException(
                409,
                "The Go board has not been detected."
            )


        # Store the actual camera image of the empty board.
        stone_baseline_frame = (
            latest_frame.copy()
        )


        # ----------------------------------------------------
        # NEW:
        # FREEZE BOARD GEOMETRY
        # ----------------------------------------------------
        #
        # The general board detector can continue drawing a
        # green debug quadrilateral, but stone recognition will
        # use THESE exact corners until another empty-board
        # baseline is captured.
        #
        # This eliminates tiny perspective jitter between frames.
        stone_board_corners = (
            board_corners.copy()
        )


        last_detected_stone_board = [
            [0 for _ in range(19)]
            for _ in range(19)
        ]


        stone_stability = [
            [0 for _ in range(19)]
            for _ in range(19)
        ]


    return {
        "ok": True,
        "message":
            "Empty-board baseline and fixed board geometry captured."
    }


@app.get(
    "/stones/detect"
)
def detect_stones():
    """
    Detect physical BLACK stones using:

        empty-board reference
              +
        frozen board geometry
              +
        temporal hysteresis

    This endpoint deliberately distinguishes between:

        raw detection
        stable accepted game state
    """

    global last_detected_stone_board
    global stone_stability


    with lock:
        if latest_frame is None:
            raise HTTPException(
                409,
                "No camera frame is available."
            )


        if stone_baseline_frame is None:
            raise HTTPException(
                409,
                "Stone baseline has not been captured."
            )


        if stone_board_corners is None:
            raise HTTPException(
                409,
                "Frozen stone-tracking board geometry is unavailable."
            )


        frame = (
            latest_frame.copy()
        )


        baseline = (
            stone_baseline_frame.copy()
        )


        # ----------------------------------------------------
        # IMPORTANT:
        # Use frozen corners, NOT continuously updated
        # board_corners.
        # ----------------------------------------------------
        corners = (
            stone_board_corners.copy()
        )

        grid_inset_x = float(
            stone_grid_inset_x
        )

        grid_inset_y = float(
            stone_grid_inset_y
        )

        outside_tolerance = float(
            stone_outside_tolerance
        )

        hard_mask_inset = float(
            stone_hard_mask_inset
        )


    raw_result = detect_black_stones(
        frame,
        baseline,
        corners,
        grid_inset_x=
            grid_inset_x,
        grid_inset_y=
            grid_inset_y,
        outside_tolerance=
            outside_tolerance,
        hard_mask_inset=
            hard_mask_inset
    )


    raw_board = raw_result[
        "board"
    ]


    previous_stable = [
        row[:]
        for row in last_detected_stone_board
    ]


    # ========================================================
    # DETECT SUSPICIOUS WHOLE-BOARD CHANGES
    # ========================================================

    raw_changes = 0


    for y in range(19):
        for x in range(19):
            if (
                raw_board[y][x] !=
                previous_stable[y][x]
            ):
                raw_changes += 1


    # A human placing one stone should normally affect one
    # intersection.
    #
    # Five or more simultaneous changes are much more likely
    # to be a hand, lighting shift, camera movement, etc.
    if raw_changes > MAX_RAW_CHANGES:
        return {
            "ok": True,

            "unstable": True,

            "reason":
                "Too many intersections changed simultaneously.",

            "rawChangeCount":
                raw_changes,

            "board":
                previous_stable,

            "intersections":
                raw_result[
                    "intersections"
                ],

            "occupiedCount":
                sum(
                    sum(row)
                    for row
                    in previous_stable
                ),

            "added": [],

            "removed": []
        }


    # ========================================================
    # TEMPORAL HYSTERESIS
    # ========================================================

    stable_board = [
        row[:]
        for row in previous_stable
    ]


    for y in range(19):
        for x in range(19):

            raw_occupied = (
                raw_board[y][x] == 1
            )


            if raw_occupied:
                stone_stability[y][x] = min(
                    STONE_CONFIRM_THRESHOLD,
                    stone_stability[y][x] + 1
                )

            else:
                stone_stability[y][x] = max(
                    -STONE_CONFIRM_THRESHOLD,
                    stone_stability[y][x] - 1
                )


            # ------------------------------------------------
            # EMPTY -> BLACK
            # ------------------------------------------------

            if (
                stable_board[y][x] == 0
                and
                stone_stability[y][x] >=
                STONE_CONFIRM_THRESHOLD
            ):
                stable_board[y][x] = 1


            # ------------------------------------------------
            # BLACK -> EMPTY
            # ------------------------------------------------

            elif (
                stable_board[y][x] == 1
                and
                stone_stability[y][x] <=
                -STONE_CONFIRM_THRESHOLD
            ):
                stable_board[y][x] = 0


    # ========================================================
    # DETERMINE ACCEPTED STATE CHANGES
    # ========================================================

    added = []
    removed = []


    for y in range(19):
        for x in range(19):

            before = (
                previous_stable[y][x]
            )

            after = (
                stable_board[y][x]
            )


            if (
                before == 0 and
                after == 1
            ):
                added.append(
                    {
                        "x": x,
                        "y": y
                    }
                )


            elif (
                before == 1 and
                after == 0
            ):
                removed.append(
                    {
                        "x": x,
                        "y": y
                    }
                )


    last_detected_stone_board = [
        row[:]
        for row in stable_board
    ]


    occupied_count = sum(
        sum(row)
        for row
        in stable_board
    )


    return {
        "ok": True,

        "unstable": False,

        "rawChangeCount":
            raw_changes,

        # IMPORTANT:
        # UI receives STABLE state, not noisy raw detection.
        "board":
            stable_board,

        "intersections":
            raw_result[
                "intersections"
            ],

        "occupiedCount":
            occupied_count,

        "added":
            added,

        "removed":
            removed
    }


# ============================================================
# ENTRY POINT
# ============================================================

if __name__ == "__main__":
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=8765,
        log_level="info"
    )
