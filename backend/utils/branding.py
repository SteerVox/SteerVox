"""Generated from branding/identity.json by scripts/sync-branding.mjs. Do not edit manually."""

from __future__ import annotations

BRANDING = {
    "displayName": "SteerVox",
    "legalName": "SteerVox",
    "author": "SteerVox",
    "copyrightHolder": "SteerVox",
    "tagline": "Voice control for Dictate, Rewrite, and Notes",
    "description": "SteerVox desktop voice control application",
    "backendTitle": "SteerVox Backend",
    "healthMessage": "SteerVox is running",
    "windowTitles": {
        "main": "SteerVox",
        "about": "About SteerVox"
    },
    "packaging": {
        "appId": "com.steervox.app",
        "dmgTitle": "SteerVox",
        "microphoneUsageDescription": "SteerVox needs microphone access to transcribe your speech.",
        "speechRecognitionUsageDescription": "SteerVox needs speech recognition access to show a live transcript while you speak.",
        "automationUsageDescription": "SteerVox uses Automation to read the frontmost app and supported browser tab metadata for Smart Mode."
    },
    "runtime": {
        "slug": "steervox",
        "protocolScheme": "steervox",
        "backendExecutableName": "steervox-engine",
        "backendResourceDirName": "steervox-engine",
        "captureProcessorName": "steervox-capture-processor",
        "loggerName": "SteerVox"
    },
    "storage": {
        "homeDirName": ".steervox",
        "homeEnvVar": "STEERVOX_HOME",
        "backendPortEnvVar": "STEERVOX_BACKEND_PORT",
        "backendUrlEnvVar": "STEERVOX_BACKEND_URL",
        "smokePortEnvVar": "STEERVOX_SMOKE_PORT",
        "backendLogFileName": "app.log",
        "electronLogFileName": "electron.log",
        "fallbackLogFileName": "steervox-app.log"
    },
    "assets": {
        "appIconPng": "frontend/public/app-icon.png",
        "brandMarkPng": "frontend/public/brand-mark.png",
        "logoMarkPng": "frontend/public/logo-mark.png",
        "trayMarkPng": "frontend/public/tray-mark.png",
        "trayTemplatePng": "frontend/public/tray-iconTemplate.png",
        "buildIconPng": "frontend/build/icon.png",
        "buildIconIcns": "frontend/build/icon.icns",
        "assetLogoPng": "assets/logo.png"
    },
    "derived": {
        "appHomeDisplayPath": "~/.steervox",
        "backendLogDisplayPath": "~/.steervox/logs/app.log",
        "electronLogDisplayPath": "~/.steervox/logs/electron.log",
        "appBundleName": "SteerVox.app",
        "backendLogFilePath": ".steervox/logs/app.log",
        "electronLogFilePath": ".steervox/logs/electron.log",
        "brandMarkPublicPath": "./brand-mark.png",
        "logoMarkPublicPath": "./logo-mark.png",
        "trayMarkPublicPath": "./tray-mark.png",
        "trayTemplatePublicPath": "./tray-iconTemplate.png",
        "localBackendAuthHeader": "X-SteerVox-Token",
        "localBackendTokenEnvVar": "STEERVOX_LOCAL_API_TOKEN",
        "experimentalMediaDefaultEnvVar": "STEERVOX_DEFAULT_EXPERIMENTAL_MEDIA_CONTROLS",
        "localSpeechHelperBinaryName": "steervox-local-speech-helper",
        "systemControlHelperBinaryName": "steervox-system-control-helper",
        "systemControlHelperEnvVar": "STEERVOX_SYSTEM_CONTROL_HELPER_PATH",
        "clipboardSelectionMarkerPrefix": "__STEERVOX_SELECTION__"
    }
}

DISPLAY_NAME = BRANDING["displayName"]
LEGAL_NAME = BRANDING["legalName"]
AUTHOR_NAME = BRANDING["author"]
COPYRIGHT_HOLDER = BRANDING["copyrightHolder"]
TAGLINE = BRANDING["tagline"]
DESCRIPTION = BRANDING["description"]
BACKEND_TITLE = BRANDING["backendTitle"]
HEALTH_MESSAGE = BRANDING["healthMessage"]
MAIN_WINDOW_TITLE = BRANDING["windowTitles"]["main"]
ABOUT_WINDOW_TITLE = BRANDING["windowTitles"]["about"]
APP_ID = BRANDING["packaging"]["appId"]
DMG_TITLE = BRANDING["packaging"]["dmgTitle"]
MICROPHONE_USAGE_DESCRIPTION = BRANDING["packaging"]["microphoneUsageDescription"]
SPEECH_RECOGNITION_USAGE_DESCRIPTION = BRANDING["packaging"]["speechRecognitionUsageDescription"]
AUTOMATION_USAGE_DESCRIPTION = BRANDING["packaging"]["automationUsageDescription"]
APP_SLUG = BRANDING["runtime"]["slug"]
APP_PROTOCOL_SCHEME = BRANDING["runtime"]["protocolScheme"]
BACKEND_EXECUTABLE_NAME = BRANDING["runtime"]["backendExecutableName"]
BACKEND_RESOURCE_DIR_NAME = BRANDING["runtime"]["backendResourceDirName"]
CAPTURE_PROCESSOR_NAME = BRANDING["runtime"]["captureProcessorName"]
LOGGER_NAME = BRANDING["runtime"]["loggerName"]
APP_HOME_DIR_NAME = BRANDING["storage"]["homeDirName"]
APP_HOME_ENV_VAR = BRANDING["storage"]["homeEnvVar"]
BACKEND_PORT_ENV_VAR = BRANDING["storage"]["backendPortEnvVar"]
BACKEND_URL_ENV_VAR = BRANDING["storage"]["backendUrlEnvVar"]
SMOKE_PORT_ENV_VAR = BRANDING["storage"]["smokePortEnvVar"]
BACKEND_LOG_FILE_NAME = BRANDING["storage"]["backendLogFileName"]
ELECTRON_LOG_FILE_NAME = BRANDING["storage"]["electronLogFileName"]
FALLBACK_LOG_FILE_NAME = BRANDING["storage"]["fallbackLogFileName"]
APP_HOME_DISPLAY_PATH = BRANDING["derived"]["appHomeDisplayPath"]
BACKEND_LOG_DISPLAY_PATH = BRANDING["derived"]["backendLogDisplayPath"]
ELECTRON_LOG_DISPLAY_PATH = BRANDING["derived"]["electronLogDisplayPath"]
APP_BUNDLE_NAME = BRANDING["derived"]["appBundleName"]
APP_ICON_PNG = BRANDING["assets"]["appIconPng"]
BRAND_MARK_PNG = BRANDING["assets"]["brandMarkPng"]
LOGO_MARK_PNG = BRANDING["assets"]["logoMarkPng"]
TRAY_MARK_PNG = BRANDING["assets"]["trayMarkPng"]
TRAY_TEMPLATE_PNG = BRANDING["assets"]["trayTemplatePng"]
BUILD_ICON_PNG = BRANDING["assets"]["buildIconPng"]
BUILD_ICON_ICNS = BRANDING["assets"]["buildIconIcns"]
ASSET_LOGO_PNG = BRANDING["assets"]["assetLogoPng"]
BRAND_MARK_PUBLIC_PATH = BRANDING["derived"]["brandMarkPublicPath"]
LOGO_MARK_PUBLIC_PATH = BRANDING["derived"]["logoMarkPublicPath"]
TRAY_MARK_PUBLIC_PATH = BRANDING["derived"]["trayMarkPublicPath"]
TRAY_TEMPLATE_PUBLIC_PATH = BRANDING["derived"]["trayTemplatePublicPath"]
LOCAL_BACKEND_AUTH_HEADER = BRANDING["derived"]["localBackendAuthHeader"]
LOCAL_BACKEND_TOKEN_ENV_VAR = BRANDING["derived"]["localBackendTokenEnvVar"]
EXPERIMENTAL_MEDIA_DEFAULT_ENV_VAR = BRANDING["derived"]["experimentalMediaDefaultEnvVar"]
LOCAL_SPEECH_HELPER_BINARY_NAME = BRANDING["derived"]["localSpeechHelperBinaryName"]
SYSTEM_CONTROL_HELPER_BINARY_NAME = BRANDING["derived"]["systemControlHelperBinaryName"]
SYSTEM_CONTROL_HELPER_ENV_VAR = BRANDING["derived"]["systemControlHelperEnvVar"]
CLIPBOARD_SELECTION_MARKER_PREFIX = BRANDING["derived"]["clipboardSelectionMarkerPrefix"]
