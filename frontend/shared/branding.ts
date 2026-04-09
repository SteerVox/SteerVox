// Generated from branding/identity.json by scripts/sync-branding.mjs. Do not edit manually.
export const BRANDING = {
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
} as const

export const DISPLAY_NAME = BRANDING.displayName
export const LEGAL_NAME = BRANDING.legalName
export const AUTHOR_NAME = BRANDING.author
export const COPYRIGHT_HOLDER = BRANDING.copyrightHolder
export const TAGLINE = BRANDING.tagline
export const DESCRIPTION = BRANDING.description
export const BACKEND_TITLE = BRANDING.backendTitle
export const HEALTH_MESSAGE = BRANDING.healthMessage
export const MAIN_WINDOW_TITLE = BRANDING.windowTitles.main
export const ABOUT_WINDOW_TITLE = BRANDING.windowTitles.about
export const APP_ID = BRANDING.packaging.appId
export const DMG_TITLE = BRANDING.packaging.dmgTitle
export const MICROPHONE_USAGE_DESCRIPTION = BRANDING.packaging.microphoneUsageDescription
export const SPEECH_RECOGNITION_USAGE_DESCRIPTION = BRANDING.packaging.speechRecognitionUsageDescription
export const AUTOMATION_USAGE_DESCRIPTION = BRANDING.packaging.automationUsageDescription
export const APP_SLUG = BRANDING.runtime.slug
export const APP_PROTOCOL_SCHEME = BRANDING.runtime.protocolScheme
export const BACKEND_EXECUTABLE_NAME = BRANDING.runtime.backendExecutableName
export const BACKEND_RESOURCE_DIR_NAME = BRANDING.runtime.backendResourceDirName
export const CAPTURE_PROCESSOR_NAME = BRANDING.runtime.captureProcessorName
export const LOGGER_NAME = BRANDING.runtime.loggerName
export const APP_HOME_DIR_NAME = BRANDING.storage.homeDirName
export const APP_HOME_ENV_VAR = BRANDING.storage.homeEnvVar
export const BACKEND_PORT_ENV_VAR = BRANDING.storage.backendPortEnvVar
export const BACKEND_URL_ENV_VAR = BRANDING.storage.backendUrlEnvVar
export const SMOKE_PORT_ENV_VAR = BRANDING.storage.smokePortEnvVar
export const BACKEND_LOG_FILE_NAME = BRANDING.storage.backendLogFileName
export const ELECTRON_LOG_FILE_NAME = BRANDING.storage.electronLogFileName
export const FALLBACK_LOG_FILE_NAME = BRANDING.storage.fallbackLogFileName
export const APP_HOME_DISPLAY_PATH = BRANDING.derived.appHomeDisplayPath
export const BACKEND_LOG_DISPLAY_PATH = BRANDING.derived.backendLogDisplayPath
export const ELECTRON_LOG_DISPLAY_PATH = BRANDING.derived.electronLogDisplayPath
export const APP_BUNDLE_NAME = BRANDING.derived.appBundleName
export const APP_ICON_PNG = BRANDING.assets.appIconPng
export const BRAND_MARK_PNG = BRANDING.assets.brandMarkPng
export const LOGO_MARK_PNG = BRANDING.assets.logoMarkPng
export const TRAY_MARK_PNG = BRANDING.assets.trayMarkPng
export const TRAY_TEMPLATE_PNG = BRANDING.assets.trayTemplatePng
export const BUILD_ICON_PNG = BRANDING.assets.buildIconPng
export const BUILD_ICON_ICNS = BRANDING.assets.buildIconIcns
export const ASSET_LOGO_PNG = BRANDING.assets.assetLogoPng
export const BRAND_MARK_PUBLIC_PATH = BRANDING.derived.brandMarkPublicPath
export const LOGO_MARK_PUBLIC_PATH = BRANDING.derived.logoMarkPublicPath
export const TRAY_MARK_PUBLIC_PATH = BRANDING.derived.trayMarkPublicPath
export const TRAY_TEMPLATE_PUBLIC_PATH = BRANDING.derived.trayTemplatePublicPath
export const LOCAL_BACKEND_AUTH_HEADER = BRANDING.derived.localBackendAuthHeader
export const LOCAL_BACKEND_TOKEN_ENV_VAR = BRANDING.derived.localBackendTokenEnvVar
export const EXPERIMENTAL_MEDIA_DEFAULT_ENV_VAR = BRANDING.derived.experimentalMediaDefaultEnvVar
export const LOCAL_SPEECH_HELPER_BINARY_NAME = BRANDING.derived.localSpeechHelperBinaryName
export const SYSTEM_CONTROL_HELPER_BINARY_NAME = BRANDING.derived.systemControlHelperBinaryName
export const SYSTEM_CONTROL_HELPER_ENV_VAR = BRANDING.derived.systemControlHelperEnvVar
export const CLIPBOARD_SELECTION_MARKER_PREFIX = BRANDING.derived.clipboardSelectionMarkerPrefix

export type Branding = typeof BRANDING
