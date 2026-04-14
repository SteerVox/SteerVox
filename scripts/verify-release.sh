#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BACKEND_DIR="$PROJECT_ROOT/backend"
FRONTEND_DIR="$PROJECT_ROOT/frontend"
BACKEND_PYTHON="$BACKEND_DIR/.venv/bin/python3"
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

function require_command() {
  local command_name="$1"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "✗ Required command is missing: $command_name"
    exit 1
  fi
}

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  $BRANDING_DISPLAY_NAME — Release Verification ($RELEASE_CHANNEL)"
echo "═══════════════════════════════════════════════════════"
echo ""

if [ "$(uname -m)" != "arm64" ]; then
  echo "✗ Release verification is supported only on Apple Silicon Macs."
  exit 1
fi

if [ ! -x "$BACKEND_PYTHON" ]; then
  echo "✗ Backend virtualenv is missing. Run ./scripts/setup-dev.sh first."
  exit 1
fi

require_command node
require_command npm
require_command xcode-select
require_command open
require_command pgrep
require_command pkill

if ! xcode-select -p >/dev/null 2>&1; then
  echo "✗ Xcode Command Line Tools are required. Run: xcode-select --install"
  exit 1
fi

echo "→ Running full backend suite..."
cd "$PROJECT_ROOT"
"$BACKEND_PYTHON" -m pytest backend/tests -q

echo ""
echo "→ Running frontend lint, TypeScript, and Vitest..."
cd "$FRONTEND_DIR"
npm ci
npm run lint
./node_modules/.bin/tsc -b
./node_modules/.bin/vitest run

echo ""
echo "→ Building and smoke-testing packaged artifacts..."
cd "$PROJECT_ROOT"
bash ./scripts/build-mac.sh "$RELEASE_CHANNEL"

APP_PATH="$(find "$FRONTEND_DIR/dist/mac-arm64" -maxdepth 1 -name "$BRANDING_APP_BUNDLE_NAME" | head -1)"
if [ -z "$APP_PATH" ]; then
  echo "✗ Could not find the packaged .app after build."
  exit 1
fi

APP_PROCESS_NAME="${BRANDING_APP_BUNDLE_NAME%.app}"

echo ""
echo "→ Smoke-testing packaged app launch..."
open -n "$APP_PATH"

LAUNCH_OK=0
for _ in {1..20}; do
  if pgrep -f "$APP_PATH/Contents/MacOS/" >/dev/null 2>&1; then
    LAUNCH_OK=1
    break
  fi
  sleep 1
done

if [ "$LAUNCH_OK" -ne 1 ]; then
  echo "✗ Packaged app launch smoke test failed."
  exit 1
fi

osascript -e "tell application \"$APP_PROCESS_NAME\" to quit" >/dev/null 2>&1 || true
sleep 2
pkill -f "$APP_PATH/Contents/MacOS/" >/dev/null 2>&1 || true

echo "  ✓ Packaged app launch smoke test passed."
echo ""
echo "═══════════════════════════════════════════════════════"
echo "✓ Release verification complete"
echo "═══════════════════════════════════════════════════════"
