from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np


BOARD_SIZE = 19
RECTIFIED_SIZE = 900


@dataclass
class IntersectionResult:
    x: int
    y: int
    occupied: bool
    confidence: float
    darkness_change: float
    texture_change: float


def order_quad(points: np.ndarray) -> np.ndarray:
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


def rectify_board(
    frame: np.ndarray,
    corners: np.ndarray,
    output_size: int = RECTIFIED_SIZE
) -> np.ndarray:

    corners = order_quad(
        corners
    )

    destination = np.asarray(
        [
            [0, 0],
            [output_size - 1, 0],
            [
                output_size - 1,
                output_size - 1
            ],
            [0, output_size - 1]
        ],
        dtype=np.float32
    )

    matrix = (
        cv2.getPerspectiveTransform(
            corners,
            destination
        )
    )

    return cv2.warpPerspective(
        frame,
        matrix,
        (
            output_size,
            output_size
        )
    )


def intersection_pixel(
    x: int,
    y: int,
    size: int = RECTIFIED_SIZE,
    grid_inset_x: float = 0.035,
    grid_inset_y: float = 0.035
) -> tuple[int, int]:

    inset_x = float(
        np.clip(
            grid_inset_x,
            0.0,
            0.20
        )
    )

    inset_y = float(
        np.clip(
            grid_inset_y,
            0.0,
            0.20
        )
    )

    normalized_x = (
        inset_x +
        (
            x /
            (BOARD_SIZE - 1)
        ) *
        (
            1.0 -
            2.0 * inset_x
        )
    )

    normalized_y = (
        inset_y +
        (
            y /
            (BOARD_SIZE - 1)
        ) *
        (
            1.0 -
            2.0 * inset_y
        )
    )

    px = int(
        round(
            normalized_x *
            (size - 1)
        )
    )

    py = int(
        round(
            normalized_y *
            (size - 1)
        )
    )

    return px, py


def circular_patch(
    image: np.ndarray,
    cx: int,
    cy: int,
    radius: int
) -> tuple[np.ndarray, np.ndarray]:

    height, width = (
        image.shape[:2]
    )

    x0 = max(
        0,
        cx - radius
    )

    x1 = min(
        width,
        cx + radius + 1
    )

    y0 = max(
        0,
        cy - radius
    )

    y1 = min(
        height,
        cy + radius + 1
    )

    patch = image[
        y0:y1,
        x0:x1
    ]

    yy, xx = np.ogrid[
        y0:y1,
        x0:x1
    ]

    mask = (
        (xx - cx) ** 2 +
        (yy - cy) ** 2
        <=
        radius ** 2
    )

    return patch, mask


def allowed_detection_mask(
    shape: tuple[int, int],
    grid_inset_x: float,
    grid_inset_y: float,
    outside_tolerance: float,
    hard_mask_inset: float = 0.0
) -> np.ndarray:
    height, width = shape[:2]

    inset_x = float(
        np.clip(
            grid_inset_x,
            0.0,
            0.20
        )
    )

    inset_y = float(
        np.clip(
            grid_inset_y,
            0.0,
            0.20
        )
    )

    tolerance = float(
        np.clip(
            outside_tolerance,
            0.0,
            0.10
        )
    )

    hard_inset = float(
        np.clip(
            hard_mask_inset,
            0.0,
            0.15
        )
    )

    effective_left = (
        inset_x +
        hard_inset -
        tolerance
    )

    effective_right = (
        1.0 -
        inset_x -
        hard_inset +
        tolerance
    )

    effective_top = (
        inset_y +
        hard_inset -
        tolerance
    )

    effective_bottom = (
        1.0 -
        inset_y -
        hard_inset +
        tolerance
    )

    left = int(
        round(
            max(
                0.0,
                effective_left
            ) *
            (width - 1)
        )
    )

    right = int(
        round(
            min(
                1.0,
                effective_right
            ) *
            (width - 1)
        )
    )

    top = int(
        round(
            max(
                0.0,
                effective_top
            ) *
            (height - 1)
        )
    )

    bottom = int(
        round(
            min(
                1.0,
                effective_bottom
            ) *
            (height - 1)
        )
    )

    mask = np.zeros(
        (
            height,
            width
        ),
        dtype=np.uint8
    )

    cv2.rectangle(
        mask,
        (
            left,
            top
        ),
        (
            right,
            bottom
        ),
        255,
        thickness=-1
    )

    return mask


def analyze_intersection(
    current_gray: np.ndarray,
    baseline_gray: np.ndarray,
    x: int,
    y: int,
    sample_radius: int = 17,
    grid_inset_x: float = 0.035,
    grid_inset_y: float = 0.035,
    outside_tolerance: float = 0.012,
    hard_mask_inset: float = 0.0
) -> IntersectionResult:

    cx, cy = (
        intersection_pixel(
            x,
            y,
            current_gray.shape[0],
            grid_inset_x,
            grid_inset_y
        )
    )

    current_patch, mask = (
        circular_patch(
            current_gray,
            cx,
            cy,
            sample_radius
        )
    )

    baseline_patch, _ = (
        circular_patch(
            baseline_gray,
            cx,
            cy,
            sample_radius
        )
    )

    allowed_full = (
        allowed_detection_mask(
            current_gray.shape,
            grid_inset_x,
            grid_inset_y,
            outside_tolerance,
            hard_mask_inset
        )
    )

    height, width = (
        current_gray.shape[:2]
    )

    x0 = max(
        0,
        cx -
        sample_radius
    )

    x1 = min(
        width,
        cx +
        sample_radius +
        1
    )

    y0 = max(
        0,
        cy -
        sample_radius
    )

    y1 = min(
        height,
        cy +
        sample_radius +
        1
    )

    allowed_patch = (
        allowed_full[
            y0:y1,
            x0:x1
        ] >
        0
    )

    effective_mask = (
        mask &
        allowed_patch
    )

    valid_fraction = float(
        np.count_nonzero(
            effective_mask
        )
    ) / max(
        1,
        int(
            np.count_nonzero(
                mask
            )
        )
    )

    if valid_fraction < 0.35:
        return IntersectionResult(
            x=x,
            y=y,
            occupied=False,
            confidence=0.0,
            darkness_change=0.0,
            texture_change=0.0
        )

    current_pixels = (
        current_patch[
            effective_mask
        ]
        .astype(
            np.float32
        )
    )

    baseline_pixels = (
        baseline_patch[
            effective_mask
        ]
        .astype(
            np.float32
        )
    )

    if (
        current_pixels.size == 0 or
        baseline_pixels.size == 0
    ):
        return IntersectionResult(
            x=x,
            y=y,
            occupied=False,
            confidence=0.0,
            darkness_change=0.0,
            texture_change=0.0
        )

    current_median = float(
        np.median(
            current_pixels
        )
    )

    baseline_median = float(
        np.median(
            baseline_pixels
        )
    )

    darkness_change = (
        baseline_median -
        current_median
    )

    current_std = float(
        np.std(
            current_pixels
        )
    )

    baseline_std = float(
        np.std(
            baseline_pixels
        )
    )

    texture_change = abs(
        current_std -
        baseline_std
    )

    absolute_darkness = (
        255.0 -
        current_median
    )

    darkness_score = (
        np.clip(
            darkness_change /
            55.0,
            0.0,
            1.0
        )
    )

    absolute_score = (
        np.clip(
            (
                absolute_darkness -
                65.0
            ) /
            100.0,
            0.0,
            1.0
        )
    )

    texture_score = (
        np.clip(
            texture_change /
            30.0,
            0.0,
            1.0
        )
    )

    confidence = float(
        0.58 *
        darkness_score +

        0.30 *
        absolute_score +

        0.12 *
        texture_score
    )

    occupied = (
        confidence >= 0.50
        and
        darkness_change >= 18.0
    )

    return IntersectionResult(
        x=x,
        y=y,
        occupied=occupied,
        confidence=confidence,
        darkness_change=float(
            darkness_change
        ),
        texture_change=float(
            texture_change
        )
    )


def detect_black_stones(
    frame: np.ndarray,
    baseline_frame: np.ndarray,
    board_corners: np.ndarray,
    grid_inset_x: float = 0.035,
    grid_inset_y: float = 0.035,
    outside_tolerance: float = 0.012,
    hard_mask_inset: float = 0.0
) -> dict:

    current = rectify_board(
        frame,
        board_corners
    )

    baseline = rectify_board(
        baseline_frame,
        board_corners
    )

    current_gray = (
        cv2.cvtColor(
            current,
            cv2.COLOR_BGR2GRAY
        )
    )

    baseline_gray = (
        cv2.cvtColor(
            baseline,
            cv2.COLOR_BGR2GRAY
        )
    )

    current_gray = (
        cv2.GaussianBlur(
            current_gray,
            (5, 5),
            0
        )
    )

    baseline_gray = (
        cv2.GaussianBlur(
            baseline_gray,
            (5, 5),
            0
        )
    )

    board = [
        [0] * BOARD_SIZE
        for _ in range(
            BOARD_SIZE
        )
    ]

    intersections = []

    occupied_count = 0

    for y in range(
        BOARD_SIZE
    ):
        for x in range(
            BOARD_SIZE
        ):

            result = (
                analyze_intersection(
                    current_gray,
                    baseline_gray,
                    x,
                    y,
                    grid_inset_x=
                        grid_inset_x,
                    grid_inset_y=
                        grid_inset_y,
                    outside_tolerance=
                        outside_tolerance,
                    hard_mask_inset=
                        hard_mask_inset
                )
            )

            if result.occupied:
                board[y][x] = 1
                occupied_count += 1

            intersections.append(
                {
                    "x": result.x,
                    "y": result.y,
                    "occupied":
                        result.occupied,
                    "confidence":
                        result.confidence,
                    "darknessChange":
                        result.darkness_change,
                    "textureChange":
                        result.texture_change
                }
            )

    return {
        "board": board,
        "intersections":
            intersections,
        "occupiedCount":
            occupied_count
    }