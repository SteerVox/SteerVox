#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BACKEND_DIR="$PROJECT_ROOT/backend"
FRONTEND_DIR="$PROJECT_ROOT/frontend"
BACKEND_VENV_DIR="$BACKEND_DIR/.venv"
BACKEND_PYTHON="$BACKEND_VENV_DIR/bin/python3"
PYTHON_BIN="${PYTHON_BIN:-python3}"

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  SteerVox — Development Bootstrap"
echo "═══════════════════════════════════════════════════════"
echo ""

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "✗ Python not found: $PYTHON_BIN"
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "✗ npm is required to install frontend dependencies."
  exit 1
fi

echo "→ Preparing backend virtualenv..."
if [ ! -d "$BACKEND_VENV_DIR" ]; then
  "$PYTHON_BIN" -m venv "$BACKEND_VENV_DIR"
fi

"$BACKEND_PYTHON" -m pip install --upgrade pip==26.0.1
"$BACKEND_PYTHON" -m pip install -r "$BACKEND_DIR/requirements-dev.txt"

echo ""
echo "→ Installing frontend dependencies..."
cd "$FRONTEND_DIR"
npm ci

echo ""
echo "→ Validating backend interpreter..."
if [ ! -x "$BACKEND_PYTHON" ]; then
  echo "✗ Backend interpreter missing after setup: $BACKEND_PYTHON"
  exit 1
fi

echo ""
echo "═══════════════════════════════════════════════════════"
echo "✓ Development bootstrap complete"
echo ""
echo "Next steps:"
echo "  1. cd frontend && npm run dev"
echo "  2. cd .. && ./scripts/verify-dev.sh"
echo "═══════════════════════════════════════════════════════"
