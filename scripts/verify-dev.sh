#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BACKEND_DIR="$PROJECT_ROOT/backend"
FRONTEND_DIR="$PROJECT_ROOT/frontend"
BACKEND_PYTHON="$BACKEND_DIR/.venv/bin/python3"

if [ ! -x "$BACKEND_PYTHON" ]; then
  echo "✗ Backend virtualenv is missing. Run ./scripts/setup-dev.sh first."
  exit 1
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "✗ Node.js and npm must be available on PATH."
  exit 1
fi

if [ ! -d "$FRONTEND_DIR/node_modules" ]; then
  echo "✗ Frontend dependencies are missing. Run ./scripts/setup-dev.sh first."
  exit 1
fi

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  SteerVox — Development Verification"
echo "═══════════════════════════════════════════════════════"
echo ""

echo "→ Running full backend test suite..."
cd "$PROJECT_ROOT"
"$BACKEND_PYTHON" -m pytest backend/tests -q

echo ""
echo "→ Running frontend validation..."
cd "$FRONTEND_DIR"
npm run lint
./node_modules/.bin/tsc -b
./node_modules/.bin/vitest run

echo ""
echo "═══════════════════════════════════════════════════════"
echo "✓ Development verification complete"
echo "═══════════════════════════════════════════════════════"
