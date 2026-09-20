# Go AR Tutor — Electron + Automatic Projector Calibration

Revision 0.2 converts the original browser-oriented prototype into an
Electron desktop application.

## What this revision adds

- Electron desktop control window
- named webcam selection through Chromium `MediaDevices`
- iPhone Continuity Camera compatibility on supported Macs
- named display/projector selection
- external-display detection
- dedicated fullscreen projector window
- automatic calibration when a projector is present
- OpenCV physical-board detection
- sequential projected-dot calibration
- RANSAC projector/camera homography
- automatic board-size / projector-size compensation
- projected 19×19 test grid after calibration

## Architecture

```text
                         ELECTRON APP
                    ┌─────────────────────┐
                    │                     │
Camera / iPhone --->│ Chromium camera API │
                    │         │           │
                    │         │ JPEG       │
                    │         ▼           │
                    │   OpenCV service    │
                    │         │           │
                    │         │ homography│
                    │         ▼           │
                    │ Projector renderer  │----> HDMI projector
                    │                     │
                    └─────────────────────┘
```

Electron owns the camera instead of `cv2.VideoCapture(0)`. This is important
because the UI can therefore select devices by their real system names, and
the video you preview is exactly the stream OpenCV receives.

## Setup — macOS

From Terminal:

```bash
chmod +x scripts/setup-macos.sh
./scripts/setup-macos.sh
npm start
```

For an iPhone test camera, make the iPhone available to macOS as a Continuity
Camera, then select it from the app's **Video source** dropdown.

## Setup — Windows

In PowerShell:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\setup-windows.ps1
npm start
```

## First run

1. Allow camera permission when macOS/Windows asks.
2. Choose the desired camera.
3. Choose the external HDMI/projector display.
4. Start the camera.
5. Place the complete Go board inside the camera view.
6. Press **Detect board + auto-calibrate projection**.

If **Automatically calibrate when the projector is connected** is enabled,
the app also attempts calibration automatically after the selected camera is
running and an external display appears.

## Automatic calibration algorithm

### A. Physical board detection

With the projector black, OpenCV:

1. converts the camera frame to grayscale;
2. applies Gaussian smoothing;
3. runs Canny edge detection;
4. closes broken contours;
5. searches for large convex quadrilaterals;
6. scores candidates by area, rectangularity, aspect, and corner angles.

The best candidate becomes the physical board quadrilateral.

This is a first-pass detector. A later revision should explicitly score the
19x19 Go-line structure with Hough transforms, which will make board
identification much harder to confuse with a square tabletop or mat.

### B. Projector-to-camera calibration

The projector goes black and OpenCV stores a baseline camera image.

Electron then projects one white dot at a time on a 5x5 normalized grid:

```text
.   .   .   .   .
.   .   .   .   .
.   .   .   .   .
.   .   .   .   .
.   .   .   .   .
```

Each projected point has a known coordinate in projector space.

OpenCV compares the current frame against the black-projector baseline and
finds the bright changed region. That gives:

```text
projector coordinate <-> camera coordinate
```

Points outside the camera field of view can be skipped.

With four or more matches, OpenCV uses `findHomography(..., RANSAC, ...)` to
solve the projector-to-camera transform.

### C. Fit projection to the real board

The transform is inverted:

```text
camera pixels -> projector normalized coordinates
```

The physical board's four detected camera-space corners are passed through
that transform.

This tells us exactly where the board lies in the projector's framebuffer,
regardless of:

- board physical size;
- camera height;
- camera angle;
- projector resolution;
- projector position;
- keystone distortion;
- how much of the projector image lands outside the board.

Finally OpenCV solves:

```text
logical board coordinates -> projector coordinates
```

That is the matrix later used for stones, territory shading, arrows,
liberties, tutorial highlights, and AI moves.

## Important limitation of this revision

Automatic board detection is intentionally conservative but is still a
first-pass contour detector. A square table edge or mat can potentially be
selected instead of the Go board.

The next vision revision should add:

- explicit 19-line horizontal/vertical grid verification;
- Hough-line clustering;
- confidence display;
- manual four-corner fallback in the Electron camera preview;
- exposure-lock guidance;
- projected-point motion rejection;
- calibration quality / reprojection-error display.

## Why sequential projected dots?

A single checkerboard projected onto a wooden Go board can become difficult
to parse because its lines overlap the real board's grid.

Sequential dots are easier:

- the black frame gives a clean baseline;
- only one region should become dramatically brighter;
- the dot identity is already known from the sequence;
- partial projector visibility is okay;
- RANSAC rejects bad matches.

## Next milestone

Once this calibration layer is reliable, the next major code module should be:

```text
physical move detection
        ↓
Go rules / captures / ko
        ↓
KataGo
        ↓
virtual AI stone
        ↓
boardToProjectorHomography
        ↓
physical-board projection
```

After that, Ollama can explain KataGo's analysis and drive tutorial language.


## Git repository setup

This archive includes a project-specific `.gitignore`.

The following are intentionally **not** committed:

- `node_modules/`
- `.venv/`
- Electron build/package output
- `config/settings.json`
- generated camera/projector calibration data
- camera/debug captures
- local logs and caches
- KataGo/Ollama model weights and binaries
- large test video files
- macOS `.DS_Store` metadata

A tracked `config/settings.example.json` documents the local settings schema.

After extracting the project on the Mac:

```bash
git init
git add .
git status
git commit -m "Initial Go AR Tutor scaffold"
```

Before committing, `git status` should **not** show:

```text
node_modules/
.venv/
config/settings.json
.DS_Store
```

After cloning the repository onto another machine, the application can create
its own local `config/settings.json` as settings are saved.
