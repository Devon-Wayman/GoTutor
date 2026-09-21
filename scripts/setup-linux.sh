#!/usr/bin/env bash
set -Eeuo pipefail

# GoTutor Linux setup
#
# Supported package managers:
#   apt   (Ubuntu / Debian / Mint / Pop!_OS)
#   dnf   (Fedora / newer RHEL derivatives)
#   pacman (Arch / Manjaro)
#
# What this script does:
#   - installs Linux runtime/build prerequisites
#   - installs Node through nvm if a suitable Node is not present
#   - creates .venv and installs vision requirements
#   - runs npm install
#   - downloads a recent KataGo Linux binary
#   - downloads the current KataGo GTP config
#   - downloads the latest KataGo training network
#   - writes config/katago.paths.json
#
# Usage:
#   chmod +x scripts/setup-linux.sh
#   ./scripts/setup-linux.sh
#
# Optional:
#   KATAGO_BACKEND=opencl ./scripts/setup-linux.sh
#   KATAGO_BACKEND=eigen  ./scripts/setup-linux.sh
#   KATAGO_BACKEND=cuda   ./scripts/setup-linux.sh
#
# Backend selection:
#   auto   -> CUDA if nvidia-smi exists, otherwise OpenCL
#   cuda   -> NVIDIA CUDA/CUDNN binary
#   opencl -> broad GPU compatibility
#   eigen  -> CPU-only fallback
#
# Notes:
# - CUDA/CUDNN system drivers are NOT installed automatically because the
#   correct packages depend heavily on distro and GPU/driver generation.
# - OpenCL ICD/runtime packages are installed where the distro provides
#   reasonable generic choices.
# - x86_64 is the primary tested path for official prebuilt KataGo binaries.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

log() {
  printf '\033[1;36m[GoTutor]\033[0m %s\n' "$*"
}

warn() {
  printf '\033[1;33m[GoTutor WARNING]\033[0m %s\n' "$*" >&2
}

die() {
  printf '\033[1;31m[GoTutor ERROR]\033[0m %s\n' "$*" >&2
  exit 1
}

have() {
  command -v "$1" >/dev/null 2>&1
}

sudo_cmd() {
  if [[ "${EUID}" -eq 0 ]]; then
    "$@"
  elif have sudo; then
    sudo "$@"
  else
    die "This step needs root privileges and sudo is not installed."
  fi
}

detect_pkg_manager() {
  if have apt-get; then
    echo apt
  elif have dnf; then
    echo dnf
  elif have pacman; then
    echo pacman
  else
    echo unknown
  fi
}

install_system_packages() {
  local pm
  pm="$(detect_pkg_manager)"

  log "Detected package manager: $pm"

  case "$pm" in
    apt)
      sudo_cmd apt-get update
      sudo_cmd apt-get install -y \
        git curl ca-certificates unzip xz-utils \
        python3 python3-venv python3-pip \
        build-essential pkg-config \
        libnss3 libatk-bridge2.0-0 libgtk-3-0 \
        libgbm1 libasound2t64 libxss1 libx11-xcb1 \
        libxcomposite1 libxdamage1 libxrandr2 \
        libdrm2 libxkbcommon0 libxcb1 \
        ocl-icd-libopencl1 clinfo
      ;;

    dnf)
      sudo_cmd dnf install -y \
        git curl ca-certificates unzip xz \
        python3 python3-pip \
        gcc gcc-c++ make pkgconf-pkg-config \
        nss atk at-spi2-atk gtk3 mesa-libgbm \
        alsa-lib libXScrnSaver libXcomposite \
        libXdamage libXrandr libxkbcommon libxcb \
        ocl-icd clinfo
      ;;

    pacman)
      sudo_cmd pacman -Sy --needed --noconfirm \
        git curl ca-certificates unzip xz \
        python python-pip \
        base-devel pkgconf \
        nss atk at-spi2-core gtk3 mesa \
        alsa-lib libxss libxcomposite libxdamage \
        libxrandr libxkbcommon libxcb \
        ocl-icd clinfo
      ;;

    *)
      warn "Unsupported package manager."
      warn "Install manually: git curl unzip Python 3 + venv/pip, Node/npm,"
      warn "GTK3/NSS/GBM/ALSA/X11 runtime libraries, and an OpenCL runtime if needed."
      ;;
  esac
}

version_ge() {
  # version_ge 20.0.0 18.0.0
  printf '%s\n%s\n' "$2" "$1" | sort -V -C
}

ensure_node() {
  local minimum_node="20.0.0"
  local current=""

  if have node; then
    current="$(node -v | sed 's/^v//')"
  fi

  if [[ -n "$current" ]] && version_ge "$current" "$minimum_node"; then
    log "Node.js $current is already installed."
    return
  fi

  log "Installing Node.js through nvm..."

  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

  if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
    curl -fsSL \
      https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh \
      | bash
  fi

  # shellcheck disable=SC1090
  source "$NVM_DIR/nvm.sh"

  # Use the current LTS line rather than pinning the app to a distro's
  # potentially old Node package.
  nvm install --lts
  nvm use --lts
  nvm alias default 'lts/*'

  log "Using Node $(node -v), npm $(npm -v)"
}

find_python() {
  local candidates=(
    python3.13
    python3.12
    python3.11
    python3
  )

  local candidate
  for candidate in "${candidates[@]}"; do
    if have "$candidate"; then
      if "$candidate" - <<'PY' >/dev/null 2>&1
import sys
raise SystemExit(0 if (3, 11) <= sys.version_info[:2] <= (3, 13) else 1)
PY
      then
        command -v "$candidate"
        return 0
      fi
    fi
  done

  return 1
}

setup_python() {
  local py
  py="$(find_python || true)"

  [[ -n "$py" ]] || die \
    "Python 3.11-3.13 was not found. Install Python 3.11, 3.12, or 3.13 and rerun."

  log "Using Python: $("$py" --version 2>&1)"

  if [[ -d .venv ]]; then
    log "Existing .venv found; keeping it."
  else
    log "Creating Python virtual environment..."
    "$py" -m venv .venv
  fi

  log "Installing Python dependencies..."
  ./.venv/bin/python -m pip install --upgrade pip setuptools wheel
  ./.venv/bin/python -m pip install -r vision/requirements.txt
}

setup_node_dependencies() {
  log "Installing Electron/Node dependencies..."
  npm install
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64)
      echo x64
      ;;
    aarch64|arm64)
      echo arm64
      ;;
    *)
      echo unknown
      ;;
  esac
}

choose_backend() {
  local requested="${KATAGO_BACKEND:-auto}"

  case "$requested" in
    auto)
      if have nvidia-smi && nvidia-smi >/dev/null 2>&1; then
        echo cuda
      else
        echo opencl
      fi
      ;;
    cuda|opencl|eigen)
      echo "$requested"
      ;;
    *)
      die "Invalid KATAGO_BACKEND='$requested'. Use auto, cuda, opencl, or eigen."
      ;;
  esac
}

download_katago() {
  local arch backend
  arch="$(detect_arch)"
  backend="$(choose_backend)"

  log "KataGo target: architecture=$arch backend=$backend"

  if [[ "$arch" != x64 ]]; then
    warn "Official KataGo Linux prebuilt binaries are primarily x86_64."
    warn "This script will try to find a matching asset, but ARM Linux may require a source build."
  fi

  mkdir -p \
    local/katago/runtime \
    local/katago/models \
    local/katago/configs \
    .setup-cache

  local metadata_file=".setup-cache/katago-releases.json"

  log "Querying KataGo GitHub releases..."

  curl -fsSL \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/lightvector/KataGo/releases?per_page=20" \
    -o "$metadata_file"

  local selection
  selection="$(
    ./.venv/bin/python - \
      "$metadata_file" \
      "$backend" \
      "$arch" <<'PY'
import json
import re
import sys

path, backend, arch = sys.argv[1:4]

with open(path, "r", encoding="utf-8") as f:
    releases = json.load(f)

def score(name: str):
    n = name.lower()

    if "linux" not in n or not n.endswith(".zip"):
        return None

    if "+bs50" in n:
        return None

    if arch == "x64":
        if "x64" not in n and "x86_64" not in n:
            return None
    else:
        if arch not in n:
            return None

    if backend == "cuda":
        if "cuda" not in n:
            return None

        # Prefer modern CUDNN 9.x packages when offered.
        bonus = 0
        if "cudnn9" in n:
            bonus += 100
        if "cuda12.5" in n or "cuda12.6" in n or "cuda12.8" in n:
            bonus += 20
        return bonus

    if backend == "opencl":
        if "opencl" not in n:
            return None
        return 100

    if backend == "eigen":
        if "eigen" not in n:
            return None
        if "avx2" in n:
            return 120
        return 100

    return None

best = None

for release_index, release in enumerate(releases):
    for asset in release.get("assets", []):
        name = asset.get("name", "")
        s = score(name)
        if s is None:
            continue

        # Earlier releases in the API are newer, so heavily prefer them.
        total = s - release_index * 5

        candidate = (
            total,
            release.get("tag_name", ""),
            name,
            asset.get("browser_download_url", ""),
        )

        if best is None or candidate[0] > best[0]:
            best = candidate

if best is None:
    raise SystemExit(2)

_, tag, name, url = best
print(tag)
print(name)
print(url)
PY
  )" || {
    if [[ "$backend" == cuda ]]; then
      warn "No compatible CUDA release asset was found automatically."
      warn "Falling back to OpenCL."
      KATAGO_BACKEND=opencl download_katago
      return
    fi
    die "Could not find a compatible KataGo Linux $backend release asset."
  }

  local tag asset url
  tag="$(printf '%s\n' "$selection" | sed -n '1p')"
  asset="$(printf '%s\n' "$selection" | sed -n '2p')"
  url="$(printf '%s\n' "$selection" | sed -n '3p')"

  log "Selected KataGo $tag: $asset"

  local zip_path=".setup-cache/$asset"

  if [[ ! -f "$zip_path" ]]; then
    curl -fL --retry 3 --retry-delay 2 "$url" -o "$zip_path"
  fi

  rm -rf local/katago/runtime/*
  unzip -q -o "$zip_path" -d local/katago/runtime

  local katago_bin
  katago_bin="$(
    find local/katago/runtime \
      -type f \
      \( -name katago -o -name 'katago.*' \) \
      ! -name '*.dll' \
      ! -name '*.so' \
      | head -n 1
  )"

  [[ -n "$katago_bin" ]] || die "KataGo executable was not found after extraction."

  chmod +x "$katago_bin"

  # Normalize to a stable project-local path.
  cp -f "$katago_bin" local/katago/katago
  chmod +x local/katago/katago

  log "Installed KataGo to local/katago/katago"

  if [[ "$backend" == cuda ]]; then
    if ! ./local/katago/katago version >/dev/null 2>&1; then
      warn "CUDA KataGo did not start successfully."
      warn "This commonly means the required NVIDIA/CUDA/CUDNN runtime is missing."
      warn "Rerun with: KATAGO_BACKEND=opencl ./scripts/setup-linux.sh"
    fi
  fi
}

download_gtp_config() {
  local cfg="local/katago/configs/gtp_example.cfg"

  log "Installing KataGo GTP config..."

  # Prefer a config included in the downloaded release.
  local included=""
  included="$(
    find local/katago/runtime \
      -type f \
      -name 'gtp_example.cfg' \
      | head -n 1
  )"

  if [[ -n "$included" ]]; then
    cp -f "$included" "$cfg"
  else
    curl -fsSL \
      "https://raw.githubusercontent.com/lightvector/KataGo/master/cpp/configs/gtp_example.cfg" \
      -o "$cfg"
  fi

  [[ -s "$cfg" ]] || die "Could not install gtp_example.cfg."
}

download_model() {
  local model_dir="local/katago/models"

  local existing
  existing="$(
    find "$model_dir" \
      -maxdepth 1 \
      -type f \
      \( -name '*.bin.gz' -o -name '*.txt.gz' \) \
      | head -n 1
  )"

  if [[ -n "$existing" && "${FORCE_KATAGO_MODEL_DOWNLOAD:-0}" != "1" ]]; then
    log "Existing KataGo model found: $existing"
    return
  fi

  log "Finding the latest KataGo training network..."

  local model_url
  model_url="$(
    ./.venv/bin/python - <<'PY'
import html
import re
import urllib.request

page_url = "https://katagotraining.org/networks/"

req = urllib.request.Request(
    page_url,
    headers={"User-Agent": "GoTutor-Linux-Setup/1.0"},
)

with urllib.request.urlopen(req, timeout=30) as response:
    body = response.read().decode("utf-8", errors="replace")

# Prefer the first direct .bin.gz media URL on the page. The page lists
# newest networks first and explicitly identifies these as Network Files.
patterns = [
    r'href=["\'](https://media\.katagotraining\.org/[^"\']+\.bin\.gz)["\']',
    r'href=["\'](//media\.katagotraining\.org/[^"\']+\.bin\.gz)["\']',
]

for pattern in patterns:
    match = re.search(pattern, body)
    if match:
        url = html.unescape(match.group(1))
        if url.startswith("//"):
            url = "https:" + url
        print(url)
        raise SystemExit(0)

raise SystemExit(2)
PY
  )" || die \
    "Could not determine the latest KataGo model URL from katagotraining.org."

  local model_name
  model_name="$(basename "${model_url%%\?*}")"

  [[ "$model_name" == *.bin.gz ]] || model_name="katago-latest.bin.gz"

  log "Downloading network: $model_name"

  curl -fL \
    --retry 3 \
    --retry-delay 2 \
    "$model_url" \
    -o "$model_dir/$model_name"
}

write_katago_paths() {
  local model
  model="$(
    find local/katago/models \
      -maxdepth 1 \
      -type f \
      \( -name '*.bin.gz' -o -name '*.txt.gz' \) \
      | sort \
      | head -n 1
  )"

  [[ -n "$model" ]] || die "No KataGo model is installed."

  mkdir -p config

  cat > config/katago.paths.json <<JSON
{
  "version": 1,
  "executablePath": "./local/katago/katago",
  "modelPath": "./$model",
  "configPath": "./local/katago/configs/gtp_example.cfg"
}
JSON

  log "Wrote config/katago.paths.json"
}

verify_install() {
  log "Verifying Python imports..."

  ./.venv/bin/python - <<'PY'
import cv2
import fastapi
import numpy
import uvicorn

print("OpenCV:", cv2.__version__)
print("NumPy:", numpy.__version__)
print("FastAPI:", fastapi.__version__)
PY

  log "Checking KataGo executable..."

  if ./local/katago/katago version; then
    :
  else
    warn "KataGo binary exists but could not fully initialize."
    warn "If using CUDA, install the matching NVIDIA/CUDA/CUDNN runtime."
    warn "Otherwise rerun with KATAGO_BACKEND=opencl or KATAGO_BACKEND=eigen."
  fi

  if have clinfo; then
    if clinfo >/dev/null 2>&1; then
      log "OpenCL runtime detected."
    elif [[ "$(choose_backend)" == opencl ]]; then
      warn "OpenCL backend selected, but clinfo could not find an OpenCL platform."
      warn "Install your GPU vendor's OpenCL driver/runtime."
    fi
  fi
}

write_launcher() {
  cat > scripts/run-linux.sh <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ ! -d .venv ]]; then
  echo "Missing .venv. Run ./scripts/setup-linux.sh first." >&2
  exit 1
fi

exec npm start
EOF

  chmod +x scripts/run-linux.sh

  cat > scripts/run-linux-debug.sh <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ ! -d .venv ]]; then
  echo "Missing .venv. Run ./scripts/setup-linux.sh first." >&2
  exit 1
fi

exec npm run start:debug
EOF

  chmod +x scripts/run-linux-debug.sh
}

main() {
  log "Starting GoTutor Linux setup in:"
  log "$ROOT"

  install_system_packages
  ensure_node
  setup_python
  setup_node_dependencies
  download_katago
  download_gtp_config
  download_model
  write_katago_paths
  write_launcher
  verify_install

  echo
  log "Linux setup complete."
  echo
  echo "Run normally:"
  echo "  ./scripts/run-linux.sh"
  echo
  echo "Run with full GoTutor debug logging:"
  echo "  ./scripts/run-linux-debug.sh"
  echo
  echo "KataGo paths:"
  cat config/katago.paths.json
  echo
}

main "$@"
