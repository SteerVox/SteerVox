#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BACKEND_DIR="$PROJECT_ROOT/backend"
FRONTEND_DIR="$PROJECT_ROOT/frontend"
source "$PROJECT_ROOT/scripts/branding-env.sh"

RELEASE_CHANNEL="${1:-public-beta}"
case "$RELEASE_CHANNEL" in
  public-beta|signed)
    ;;
  *)
    echo "Usage: $0 [public-beta|signed]"
    exit 1
    ;;
esac

export STEERVOX_RELEASE_CHANNEL="$RELEASE_CHANNEL"

eval "SMOKE_PORT=\"\${${BRANDING_SMOKE_PORT_ENV_VAR}:-18055}\""
BACKEND_EXECUTABLE_NAME="$BRANDING_BACKEND_EXECUTABLE_NAME"
BACKEND_RESOURCE_DIR_NAME="$BRANDING_BACKEND_RESOURCE_DIR_NAME"
APP_BUNDLE_NAME="$BRANDING_APP_BUNDLE_NAME"
BACKEND_SMOKE_LOG="/tmp/${BACKEND_EXECUTABLE_NAME}-backend.log"
APP_SLUG="$(echo "${APP_BUNDLE_NAME%.app}" | tr '[:upper:]' '[:lower:]' | tr ' ' '-')"

function require_command() {
  local command_name="$1"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "✗ Required command is missing: $command_name"
    exit 1
  fi
}

function require_signing_credentials() {
  if [ -z "${APPLE_SIGNING_IDENTITY:-${CSC_NAME:-}}" ]; then
    echo "✗ Signed builds require APPLE_SIGNING_IDENTITY or CSC_NAME."
    exit 1
  fi
  if [ -z "${APPLE_ID:-}" ] || [ -z "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] || [ -z "${APPLE_TEAM_ID:-}" ]; then
    echo "✗ Signed builds require APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID."
    exit 1
  fi
}

echo ""
echo "═══════════════════════════════════════════════════════"
if [ "$RELEASE_CHANNEL" = "public-beta" ]; then
  echo "  $BRANDING_DISPLAY_NAME — macOS Public Beta Build"
else
  echo "  $BRANDING_DISPLAY_NAME — macOS Signed Release Build"
fi
echo "═══════════════════════════════════════════════════════"
echo ""

if [ "$(uname -m)" != "arm64" ]; then
  echo "✗ Apple Silicon (arm64) is required for this macOS build flow."
  exit 1
fi

require_command python3
require_command node
require_command npm
require_command curl
require_command codesign
require_command shasum
require_command xcode-select

if ! xcode-select -p >/dev/null 2>&1; then
  echo "✗ Xcode Command Line Tools are required. Run: xcode-select --install"
  exit 1
fi

if [ "$RELEASE_CHANNEL" = "signed" ]; then
  require_signing_credentials
else
  echo "→ Building the explicit unsigned public beta channel."
  echo "  Notarization is intentionally skipped, and the resulting DMG is for website distribution only."
fi

echo ""
echo "→ Preparing frontend workspace..."
cd "$FRONTEND_DIR"
npm ci
npm run branding:sync
npm run branding:validate
npm run prepare:mac-assets
npm run validate:mac-assets
npm run build:local-speech-helper
npm run build:system-control-helper
npm run prepare:ffmpeg-runtime

echo ""
echo "→ Cleaning previous build outputs..."
rm -rf "$BACKEND_DIR/build" "$BACKEND_DIR/dist/$BACKEND_EXECUTABLE_NAME" "$FRONTEND_DIR/dist" "$FRONTEND_DIR/dist-electron"

echo ""
echo "→ Building Python backend bundle..."
cd "$BACKEND_DIR"
BACKEND_PYTHON="$BACKEND_DIR/.venv/bin/python3"

if [ ! -d ".venv" ]; then
  echo "✗ No backend virtualenv found."
  echo "  Run: python3 -m venv backend/.venv && backend/.venv/bin/python3 -m pip install --upgrade pip==26.0.1 && backend/.venv/bin/python3 -m pip install -r backend/requirements-build.txt"
  exit 1
fi

if [ ! -x "$BACKEND_PYTHON" ]; then
  echo "✗ Backend interpreter missing: $BACKEND_PYTHON"
  exit 1
fi

"$BACKEND_PYTHON" -m pip install --quiet --upgrade pip==26.0.1
"$BACKEND_PYTHON" -m pip install --quiet -r requirements-build.txt
"$BACKEND_PYTHON" -m PyInstaller server.spec --clean --noconfirm

BACKEND_EXEC="$BACKEND_DIR/dist/$BACKEND_EXECUTABLE_NAME/$BACKEND_EXECUTABLE_NAME"
if [ ! -f "$BACKEND_EXEC" ]; then
  echo "✗ PyInstaller build failed. Expected executable missing: $BACKEND_EXEC"
  exit 1
fi

echo "  ✓ Backend bundle ready at $BACKEND_EXEC"
echo ""

echo "→ Smoke-testing bundled backend on port $SMOKE_PORT..."
"$BACKEND_EXEC" --port "$SMOKE_PORT" >"$BACKEND_SMOKE_LOG" 2>&1 &
BACKEND_PID=$!
cleanup() {
  kill "$BACKEND_PID" 2>/dev/null || true
  wait "$BACKEND_PID" 2>/dev/null || true
}
trap cleanup EXIT

for _ in {1..60}; do
  if curl -s --max-time 2 "http://127.0.0.1:$SMOKE_PORT/health" | grep -q "ok"; then
    echo "  ✓ Backend health check passed."
    break
  fi
  sleep 1
done

if ! curl -s --max-time 3 "http://127.0.0.1:$SMOKE_PORT/health" | grep -q "ok"; then
  echo "✗ Backend smoke test failed."
  cat "$BACKEND_SMOKE_LOG"
  exit 1
fi

cleanup
trap - EXIT
echo ""

echo "→ Building Electron DMG for channel: $RELEASE_CHANNEL..."
cd "$FRONTEND_DIR"
if [ "$RELEASE_CHANNEL" = "signed" ]; then
  npm run package:desktop:mac:signed
else
  npm run package:desktop:mac:public-beta
fi

APP_PATH="$(find dist/mac-arm64 -maxdepth 1 -name "$APP_BUNDLE_NAME" | head -1)"
DMG_PATH="$(find dist -maxdepth 1 -name '*.dmg' | head -1)"

if [ -z "$APP_PATH" ] || [ -z "$DMG_PATH" ]; then
  echo "✗ Build completed without a .app or .dmg output."
  exit 1
fi

VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP_PATH/Contents/Info.plist")"
CHECKSUM_PATH="${DMG_PATH}.sha256"
MANIFEST_PATH="$FRONTEND_DIR/dist/${APP_SLUG}-${RELEASE_CHANNEL}-manifest.json"

shasum -a 256 "$DMG_PATH" > "$CHECKSUM_PATH"

export STEERVOX_MANIFEST_NAME="$BRANDING_DISPLAY_NAME"
export STEERVOX_MANIFEST_VERSION="$VERSION"
export STEERVOX_MANIFEST_CHANNEL="$RELEASE_CHANNEL"
export STEERVOX_MANIFEST_APP_PATH="$APP_PATH"
export STEERVOX_MANIFEST_DMG_PATH="$DMG_PATH"
export STEERVOX_MANIFEST_CHECKSUM_PATH="$CHECKSUM_PATH"
export STEERVOX_MANIFEST_PATH="$MANIFEST_PATH"

"$BACKEND_PYTHON" - <<PY
import json
import os
from pathlib import Path

manifest = {
    "name": os.environ["STEERVOX_MANIFEST_NAME"],
    "version": os.environ["STEERVOX_MANIFEST_VERSION"],
    "channel": os.environ["STEERVOX_MANIFEST_CHANNEL"],
    "distribution": "website",
    "target_architecture": "apple_silicon",
    "trust_posture": "unsigned_beta" if os.environ["STEERVOX_MANIFEST_CHANNEL"] == "public-beta" else "signed",
    "manual_updates_only": True,
    "artifacts": {
        "app_bundle": os.environ["STEERVOX_MANIFEST_APP_PATH"],
        "dmg": os.environ["STEERVOX_MANIFEST_DMG_PATH"],
        "checksum": os.environ["STEERVOX_MANIFEST_CHECKSUM_PATH"],
    },
}
Path(os.environ["STEERVOX_MANIFEST_PATH"]).write_text(json.dumps(manifest, indent=2) + "\\n", encoding="utf-8")
PY

if [ "$RELEASE_CHANNEL" = "signed" ]; then
  echo ""
  echo "→ Verifying code signing and notarization..."
  codesign --verify --deep --strict "$APP_PATH"
  spctl --assess --type execute --verbose "$APP_PATH"
  xcrun stapler validate "$APP_PATH"
  xcrun stapler validate "$DMG_PATH"
else
  echo ""
  echo "→ Public beta trust posture"
  echo "  This output is unsigned/not notarized by design."
  echo "  Use the generated DMG, checksum, and manifest for website publishing."
fi

echo ""
echo "═══════════════════════════════════════════════════════"
if [ "$RELEASE_CHANNEL" = "public-beta" ]; then
  echo "✓ Public beta build complete"
else
  echo "✓ Signed release build complete"
fi
echo "  App: $APP_PATH"
echo "  DMG: $DMG_PATH"
echo "  Checksum: $CHECKSUM_PATH"
echo "  Manifest: $MANIFEST_PATH"
echo "═══════════════════════════════════════════════════════"
