#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BACKEND_DIR="$PROJECT_ROOT/backend"
FRONTEND_DIR="$PROJECT_ROOT/frontend"
source "$PROJECT_ROOT/scripts/branding-env.sh"

eval "SMOKE_PORT=\"\${${BRANDING_SMOKE_PORT_ENV_VAR}:-18055}\""
BACKEND_EXECUTABLE_NAME="$BRANDING_BACKEND_EXECUTABLE_NAME"
BACKEND_RESOURCE_DIR_NAME="$BRANDING_BACKEND_RESOURCE_DIR_NAME"
APP_BUNDLE_NAME="$BRANDING_APP_BUNDLE_NAME"
BACKEND_SMOKE_LOG="/tmp/${BACKEND_EXECUTABLE_NAME}-backend.log"

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  $BRANDING_DISPLAY_NAME — macOS Release Build"
echo "═══════════════════════════════════════════════════════"
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

echo "→ Building signed/notarized Electron DMG..."
cd "$FRONTEND_DIR"
npm run package:desktop:mac

APP_PATH="$(find dist/mac-arm64 -maxdepth 1 -name "$APP_BUNDLE_NAME" | head -1)"
DMG_PATH="$(find dist -maxdepth 1 -name '*.dmg' | head -1)"

if [ -z "$APP_PATH" ] || [ -z "$DMG_PATH" ]; then
    echo "✗ Build completed without a .app or .dmg output."
    exit 1
fi

if [ -n "${APPLE_SIGNING_IDENTITY:-${CSC_NAME:-}}" ]; then
    echo ""
    echo "→ Verifying code signing..."
    codesign --verify --deep --strict "$APP_PATH"
    spctl --assess --type execute --verbose "$APP_PATH"
fi

if [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
    echo ""
    echo "→ Validating stapled notarization ticket..."
    xcrun stapler validate "$APP_PATH"
    xcrun stapler validate "$DMG_PATH"
fi

echo ""
echo "═══════════════════════════════════════════════════════"
echo "✓ Release build complete"
echo "  App: $APP_PATH"
echo "  DMG: $DMG_PATH"
echo "═══════════════════════════════════════════════════════"
