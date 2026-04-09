#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
FRONTEND_DIR="$PROJECT_ROOT/frontend"
source "$PROJECT_ROOT/scripts/branding-env.sh"

ICON_ICNS="$PROJECT_ROOT/$BRANDING_BUILD_ICON_ICNS"
ICON_PNG="$PROJECT_ROOT/$BRANDING_BUILD_ICON_PNG"
TRAY_TEMPLATE="$PROJECT_ROOT/$BRANDING_TRAY_TEMPLATE_PNG"
LOGO_PNG="$PROJECT_ROOT/$BRANDING_ASSET_LOGO_PNG"

for REQUIRED_FILE in "$ICON_ICNS" "$ICON_PNG" "$TRAY_TEMPLATE" "$LOGO_PNG"; do
  if [[ ! -f "$REQUIRED_FILE" ]]; then
    echo "Missing required macOS asset: $REQUIRED_FILE" >&2
    exit 1
  fi
done

if ! file "$ICON_ICNS" | grep -q "Mac OS X icon"; then
  echo "Invalid macOS icon bundle: $ICON_ICNS" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

iconutil -c iconset "$ICON_ICNS" -o "$TMP_DIR/icon.iconset" >/dev/null
sips -g pixelWidth -g pixelHeight "$TRAY_TEMPLATE" >/dev/null
sips -g pixelWidth -g pixelHeight "$ICON_PNG" >/dev/null
sips -g pixelWidth -g pixelHeight "$LOGO_PNG" >/dev/null

echo "macOS assets validated"
