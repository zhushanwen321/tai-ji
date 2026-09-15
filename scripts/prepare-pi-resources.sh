#!/usr/bin/env bash
# prepare-pi-resources.sh — Download pi binary for local build / CI.
#
# pi binary comes from upstream badlogic/pi-mono releases (not a fork).
# Builtin extensions (goal/todo/subagents/workflow/structured-output) are
# declared in root package.json dependencies and resolved via npm — this
# script does NOT handle them (dev: scanNpmExtensions, packaged: extraResources).
# Skills are user/project-level (~/.agents/skills, <cwd>/.pi/agent/skills) —
# not bundled with the app.
#
# Usage: ./scripts/prepare-pi-resources.sh [PI_VERSION]
set -euo pipefail

PI_VERSION="${1:-0.84.4}"
PLATFORM="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

# Map uname -m to pi binary arch naming (matches Node.js process.arch)
case "$ARCH" in
  arm64|aarch64) PI_ARCH="arm64" ;;
  x86_64|amd64)  PI_ARCH="x64" ;;
  *) echo "Unsupported arch: $ARCH" >&2; exit 1 ;;
esac

RESOURCES_DIR="apps/electron/resources/pi"

echo "=== prepare-pi-resources ==="
echo "Platform: ${PLATFORM}  Arch: ${PI_ARCH}  Version: ${PI_VERSION}"

# --- Determine asset filename ---
if [ "$PLATFORM" = "darwin" ]; then
  ASSET="pi-darwin-${PI_ARCH}.tar.gz"
  BINARY_NAME="pi-darwin-${PI_ARCH}"
elif [ "$PLATFORM" = "linux" ]; then
  ASSET="pi-linux-${PI_ARCH}.tar.gz"
  BINARY_NAME="pi-linux-${PI_ARCH}"
elif [[ "$PLATFORM" == mingw* ]] || [[ "$PLATFORM" == msys* ]] || [[ "$PLATFORM" == cygwin* ]]; then
  ASSET="pi-windows-${PI_ARCH}.zip"
  BINARY_NAME="pi-windows-${PI_ARCH}.exe"
else
  echo "Unknown platform: $PLATFORM" >&2; exit 1
fi

# --- Download pi binary ---
mkdir -p "$RESOURCES_DIR"

# Check if binary already exists
BINARY_PATH="${RESOURCES_DIR}/${BINARY_NAME}"
if [ -f "$BINARY_PATH" ]; then
  echo "Binary already exists at ${BINARY_PATH}, skipping download."
else
  echo "Downloading pi v${PI_VERSION} (${ASSET})..."
  gh release download "v${PI_VERSION}" \
    -R badlogic/pi-mono \
    -p "$ASSET" \
    -D "$RESOURCES_DIR" \
    --clobber

  echo "Extracting..."
  pushd "$RESOURCES_DIR" > /dev/null
  if [[ "$ASSET" == *.tar.gz ]]; then
    # pi release tar.gz 包一层 pi/ 目录（for mise compatibility）
    tar xzf "$ASSET"
    # 展平 pi/ 前缀目录，重命名二进制为 process-manager 期望的文件名
    if [[ -d "pi" ]]; then
      # -L 强制 dereference symlink，确保打包产物不包含指向外部路径的 symlink
      cp -RL pi/assets pi/export-html pi/package.json pi/photon_rs_bg.wasm pi/theme . 2>/dev/null || true
      cp pi/pi "${BINARY_NAME}" 2>/dev/null || cp pi/pi.exe "${BINARY_NAME}" 2>/dev/null || true
      rm -rf pi
    fi
  else
    # Windows zip: 删除已存在的 symlink/目录，避免 unzip checkdir error
    rm -rf assets theme export-html 2>/dev/null || true
    unzip -o "$ASSET" 2>/dev/null || true
    if [[ -d "pi" ]]; then
      cp -R pi/assets pi/export-html pi/package.json pi/photon_rs_bg.wasm pi/theme . 2>/dev/null || true
      cp pi/pi "${BINARY_NAME}" 2>/dev/null || cp pi/pi.exe "${BINARY_NAME}" 2>/dev/null || true
      rm -rf pi
    elif [[ -f "pi.exe" ]]; then
      mv pi.exe "${BINARY_NAME}"
      chmod +x "${BINARY_NAME}" 2>/dev/null || true
    fi
  fi
  rm -f "$ASSET"
  chmod +x "${BINARY_NAME}" 2>/dev/null || true
  popd > /dev/null
fi

echo "=== Done ==="
echo "Resources ready at: ${RESOURCES_DIR}/"
ls -la "$RESOURCES_DIR/"
