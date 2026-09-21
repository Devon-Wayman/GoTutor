# GoTutor Linux Setup

GoTutor should run on Linux without a fundamental architecture change.
Electron supports Linux desktop applications, and KataGo provides Linux
executables. The Python vision stack is also cross-platform.

## Fresh machine

Clone or download/extract the GoTutor repository, then run:

```bash
chmod +x scripts/setup-linux.sh
./scripts/setup-linux.sh
```

The script attempts to handle Ubuntu/Debian-family, Fedora-family, and
Arch-family distributions.

It installs or configures:

```text
system GUI/runtime libraries for Electron/Chromium
git / curl / unzip
Python 3.11–3.13
Python virtual environment
OpenCV / FastAPI / Uvicorn / NumPy
Node.js LTS through nvm if necessary
npm dependencies / Electron
KataGo
KataGo GTP configuration
latest KataGo training network
config/katago.paths.json
Linux launch scripts
```

After setup:

```bash
./scripts/run-linux.sh
```

or:

```bash
./scripts/run-linux-debug.sh
```

## KataGo backend

The default is:

```bash
KATAGO_BACKEND=auto
```

`auto` chooses CUDA if `nvidia-smi` is available, otherwise OpenCL.

You can override it:

```bash
KATAGO_BACKEND=opencl ./scripts/setup-linux.sh
KATAGO_BACKEND=eigen ./scripts/setup-linux.sh
KATAGO_BACKEND=cuda ./scripts/setup-linux.sh
```

### NVIDIA / CUDA

The setup script downloads a compatible KataGo CUDA binary when possible,
but deliberately does **not** install NVIDIA drivers, CUDA, or CUDNN.
Those packages are hardware- and distribution-specific.

If the CUDA binary cannot initialize, either install the correct NVIDIA
runtime or rerun setup with:

```bash
KATAGO_BACKEND=opencl ./scripts/setup-linux.sh
```

### OpenCL

OpenCL is the broad compatibility path. The script installs a generic ICD
loader, but the GPU vendor's actual OpenCL driver must also be present.

### CPU-only

For a machine without useful GPU compute:

```bash
KATAGO_BACKEND=eigen ./scripts/setup-linux.sh
```

This is slower but avoids GPU-runtime dependencies.

## Optional one-step clone/bootstrap

If you keep `bootstrap-linux.sh` somewhere outside the repo:

```bash
./bootstrap-linux.sh https://github.com/YOURUSER/GoTutor.git ~/GoTutor
```

It clones the repository and immediately runs the Linux setup.

## Project-local KataGo layout

After installation:

```text
GoTutor/
├── .venv/
├── local/
│   └── katago/
│       ├── katago
│       ├── runtime/
│       ├── configs/
│       │   └── gtp_example.cfg
│       └── models/
│           └── <network>.bin.gz
├── config/
│   └── katago.paths.json
└── scripts/
    ├── setup-linux.sh
    ├── run-linux.sh
    └── run-linux-debug.sh
```

`config/katago.paths.json` is written automatically, so GoTutor should
not require manually browsing to the KataGo executable/config/model after
a successful setup.

## Webcam/projector notes

The application uses Chromium's media-device APIs, so ordinary UVC USB
webcams should generally work on Linux. Projector output is handled as a
normal secondary display.

Permissions and compositor behavior can differ between X11 and Wayland.
If a particular Linux desktop environment behaves oddly with fullscreen
projector placement or camera access, that is likely the first area to
check rather than the OpenCV/KataGo portions of the application.
