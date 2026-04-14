import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export const PROJECT_ROOT = path.resolve(__dirname, '..')
export const BRANDING_MANIFEST_PATH = path.join(PROJECT_ROOT, 'branding', 'identity.json')
export const FRONTEND_BRANDING_MODULE_PATH = path.join(PROJECT_ROOT, 'frontend', 'shared', 'branding.ts')
export const BACKEND_BRANDING_MODULE_PATH = path.join(PROJECT_ROOT, 'backend', 'utils', 'branding.py')
export const BRANDING_ENV_PATH = path.join(PROJECT_ROOT, 'scripts', 'branding-env.sh')
export const FRONTEND_PACKAGE_JSON_PATH = path.join(PROJECT_ROOT, 'frontend', 'package.json')
export const FRONTEND_INDEX_HTML_PATH = path.join(PROJECT_ROOT, 'frontend', 'index.html')

function assertString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Branding manifest is missing a valid string for ${label}.`)
  }
}

function quoteShell(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`
}

function toPosixPath(value) {
  return String(value).replace(/\\/g, '/')
}

function toPublicAssetPath(value) {
  // Use renderer-relative asset URLs so the same branding paths work in Vite dev
  // and in packaged file:// builds under dist/renderer.
  return `./${path.posix.basename(toPosixPath(value))}`
}

function toFrontendRelativePath(value) {
  return path.posix.relative('frontend', toPosixPath(value))
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function serializePython(value, indent = 0) {
  const spacer = ' '.repeat(indent)
  const nested = ' '.repeat(indent + 4)

  if (value === null) return 'None'
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') {
    return JSON.stringify(value)
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const items = value.map((item) => `${nested}${serializePython(item, indent + 4)}`)
    return `[\n${items.join(',\n')}\n${spacer}]`
  }

  const entries = Object.entries(value)
  if (entries.length === 0) return '{}'
  const items = entries.map(([key, entryValue]) => `${nested}${JSON.stringify(key)}: ${serializePython(entryValue, indent + 4)}`)
  return `{\n${items.join(',\n')}\n${spacer}}`
}

export function buildBrandingDerived(manifest) {
  const appHomeDisplayPath = `~/${manifest.storage.homeDirName}`
  const logsDisplayDir = `${appHomeDisplayPath}/logs`
  const upperSlug = String(manifest.runtime.slug).replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase()
  const compactDisplayName = String(manifest.displayName).replace(/[^a-zA-Z0-9]+/g, '')
  const localSpeechHelperBinaryName = `${manifest.runtime.slug}-local-speech-helper`
  const systemControlHelperBinaryName = `${manifest.runtime.slug}-system-control-helper`
  return {
    appHomeDisplayPath,
    backendLogDisplayPath: `${logsDisplayDir}/${manifest.storage.backendLogFileName}`,
    electronLogDisplayPath: `${logsDisplayDir}/${manifest.storage.electronLogFileName}`,
    appBundleName: `${manifest.displayName}.app`,
    backendLogFilePath: path.posix.join(manifest.storage.homeDirName, 'logs', manifest.storage.backendLogFileName),
    electronLogFilePath: path.posix.join(manifest.storage.homeDirName, 'logs', manifest.storage.electronLogFileName),
    brandMarkPublicPath: toPublicAssetPath(manifest.assets.brandMarkPng),
    logoMarkPublicPath: toPublicAssetPath(manifest.assets.logoMarkPng),
    trayMarkPublicPath: toPublicAssetPath(manifest.assets.trayMarkPng),
    trayTemplatePublicPath: toPublicAssetPath(manifest.assets.trayTemplatePng),
    localBackendAuthHeader: `X-${compactDisplayName}-Token`,
    localBackendTokenEnvVar: `${upperSlug}_LOCAL_API_TOKEN`,
    experimentalMediaDefaultEnvVar: `${upperSlug}_DEFAULT_EXPERIMENTAL_MEDIA_CONTROLS`,
    localSpeechHelperBinaryName,
    systemControlHelperBinaryName,
    systemControlHelperEnvVar: `${upperSlug}_SYSTEM_CONTROL_HELPER_PATH`,
    clipboardSelectionMarkerPrefix: `__${upperSlug}_SELECTION__`,
  }
}

export async function readBrandingManifest() {
  const raw = await fs.readFile(BRANDING_MANIFEST_PATH, 'utf8')
  const manifest = JSON.parse(raw)

  assertString(manifest.displayName, 'displayName')
  assertString(manifest.tagline, 'tagline')
  assertString(manifest.description, 'description')
  assertString(manifest.windowTitles?.main, 'windowTitles.main')
  assertString(manifest.windowTitles?.about, 'windowTitles.about')
  assertString(manifest.packaging?.appId, 'packaging.appId')
  assertString(manifest.packaging?.dmgTitle, 'packaging.dmgTitle')
  assertString(manifest.packaging?.speechRecognitionUsageDescription, 'packaging.speechRecognitionUsageDescription')
  assertString(manifest.runtime?.protocolScheme, 'runtime.protocolScheme')
  assertString(manifest.runtime?.backendExecutableName, 'runtime.backendExecutableName')
  assertString(manifest.runtime?.backendResourceDirName, 'runtime.backendResourceDirName')
  assertString(manifest.runtime?.captureProcessorName, 'runtime.captureProcessorName')
  assertString(manifest.storage?.homeDirName, 'storage.homeDirName')
  assertString(manifest.storage?.homeEnvVar, 'storage.homeEnvVar')
  assertString(manifest.storage?.backendPortEnvVar, 'storage.backendPortEnvVar')
  assertString(manifest.storage?.backendUrlEnvVar, 'storage.backendUrlEnvVar')
  assertString(manifest.storage?.smokePortEnvVar, 'storage.smokePortEnvVar')
  assertString(manifest.storage?.backendLogFileName, 'storage.backendLogFileName')
  assertString(manifest.storage?.electronLogFileName, 'storage.electronLogFileName')
  assertString(manifest.storage?.fallbackLogFileName, 'storage.fallbackLogFileName')
  assertString(manifest.assets?.appIconPng, 'assets.appIconPng')
  assertString(manifest.assets?.brandMarkPng, 'assets.brandMarkPng')
  assertString(manifest.assets?.logoMarkPng, 'assets.logoMarkPng')
  assertString(manifest.assets?.trayMarkPng, 'assets.trayMarkPng')
  assertString(manifest.assets?.trayTemplatePng, 'assets.trayTemplatePng')
  assertString(manifest.assets?.buildIconPng, 'assets.buildIconPng')
  assertString(manifest.assets?.buildIconIcns, 'assets.buildIconIcns')
  assertString(manifest.assets?.assetLogoPng, 'assets.assetLogoPng')
  return manifest
}

export function renderFrontendBrandingModule(manifest) {
  const derived = buildBrandingDerived(manifest)
  const branding = { ...manifest, derived }
  return `// Generated from branding/identity.json by scripts/sync-branding.mjs. Do not edit manually.
export const BRANDING = ${JSON.stringify(branding, null, 2)} as const

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
`
}

export function renderBackendBrandingModule(manifest) {
  const derived = buildBrandingDerived(manifest)
  const branding = { ...manifest, derived }
  return `"""Generated from branding/identity.json by scripts/sync-branding.mjs. Do not edit manually."""

from __future__ import annotations

BRANDING = ${serializePython(branding)}

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
`
}

export function renderBrandingEnv(manifest) {
  const derived = buildBrandingDerived(manifest)
  const entries = {
    BRANDING_DISPLAY_NAME: manifest.displayName,
    BRANDING_TAGLINE: manifest.tagline,
    BRANDING_APP_ID: manifest.packaging.appId,
    BRANDING_DMG_TITLE: manifest.packaging.dmgTitle,
    BRANDING_PROTOCOL_SCHEME: manifest.runtime.protocolScheme,
    BRANDING_BACKEND_EXECUTABLE_NAME: manifest.runtime.backendExecutableName,
    BRANDING_BACKEND_RESOURCE_DIR_NAME: manifest.runtime.backendResourceDirName,
    BRANDING_APP_HOME_DIR_NAME: manifest.storage.homeDirName,
    BRANDING_APP_HOME_ENV_VAR: manifest.storage.homeEnvVar,
    BRANDING_BACKEND_PORT_ENV_VAR: manifest.storage.backendPortEnvVar,
    BRANDING_BACKEND_URL_ENV_VAR: manifest.storage.backendUrlEnvVar,
    BRANDING_SMOKE_PORT_ENV_VAR: manifest.storage.smokePortEnvVar,
    BRANDING_BACKEND_LOG_FILE_NAME: manifest.storage.backendLogFileName,
    BRANDING_ELECTRON_LOG_FILE_NAME: manifest.storage.electronLogFileName,
    BRANDING_FALLBACK_LOG_FILE_NAME: manifest.storage.fallbackLogFileName,
    BRANDING_APP_BUNDLE_NAME: derived.appBundleName,
    BRANDING_APP_ICON_PNG: manifest.assets.appIconPng,
    BRANDING_BRAND_MARK_PNG: manifest.assets.brandMarkPng,
    BRANDING_LOGO_MARK_PNG: manifest.assets.logoMarkPng,
    BRANDING_TRAY_MARK_PNG: manifest.assets.trayMarkPng,
    BRANDING_TRAY_TEMPLATE_PNG: manifest.assets.trayTemplatePng,
    BRANDING_BUILD_ICON_PNG: manifest.assets.buildIconPng,
    BRANDING_BUILD_ICON_ICNS: manifest.assets.buildIconIcns,
    BRANDING_ASSET_LOGO_PNG: manifest.assets.assetLogoPng,
    BRANDING_LOCAL_BACKEND_AUTH_HEADER: derived.localBackendAuthHeader,
    BRANDING_LOCAL_BACKEND_TOKEN_ENV_VAR: derived.localBackendTokenEnvVar,
    BRANDING_EXPERIMENTAL_MEDIA_DEFAULT_ENV_VAR: derived.experimentalMediaDefaultEnvVar,
    BRANDING_LOCAL_SPEECH_HELPER_BINARY_NAME: derived.localSpeechHelperBinaryName,
    BRANDING_SYSTEM_CONTROL_HELPER_BINARY_NAME: derived.systemControlHelperBinaryName,
    BRANDING_SYSTEM_CONTROL_HELPER_ENV_VAR: derived.systemControlHelperEnvVar,
    BRANDING_CLIPBOARD_SELECTION_MARKER_PREFIX: derived.clipboardSelectionMarkerPrefix,
  }

  const lines = [
    '# Generated from branding/identity.json by scripts/sync-branding.mjs. Do not edit manually.',
    'set -euo pipefail',
    ...Object.entries(entries).map(([key, value]) => `export ${key}=${quoteShell(value)}`),
    '',
  ]

  return `${lines.join('\n')}\n`
}

export async function syncFrontendPackageJson(manifest) {
  const derived = buildBrandingDerived(manifest)
  const raw = await fs.readFile(FRONTEND_PACKAGE_JSON_PATH, 'utf8')
  const packageJson = JSON.parse(raw)
  const buildIconPath = toFrontendRelativePath(manifest.assets.buildIconIcns)
  const backendResource = {
    from: path.posix.relative('frontend', path.posix.join('backend', 'dist', manifest.runtime.backendExecutableName)),
    to: manifest.runtime.backendResourceDirName,
  }
  const nextExtraResources = Array.isArray(packageJson.build?.extraResources)
    ? [...packageJson.build.extraResources]
    : []
  const existingResourceIndex = nextExtraResources.findIndex((entry) => (
    entry
    && typeof entry === 'object'
    && !Array.isArray(entry)
    && (
      entry.to === manifest.runtime.backendResourceDirName
      || String(entry.from || '').includes('/backend/dist/')
      || String(entry.from || '').includes('../backend/dist/')
    )
  ))

  packageJson.description = manifest.description
  packageJson.author = manifest.author
  packageJson.build = packageJson.build || {}
  packageJson.build.appId = manifest.packaging.appId
  packageJson.build.productName = manifest.displayName
  packageJson.build.dmg = packageJson.build.dmg || {}
  packageJson.build.dmg.title = manifest.packaging.dmgTitle
  packageJson.build.mac = packageJson.build.mac || {}
  packageJson.build.mac.icon = buildIconPath
  packageJson.build.mac.extendInfo = packageJson.build.mac.extendInfo || {}
  packageJson.build.mac.extendInfo.NSMicrophoneUsageDescription = manifest.packaging.microphoneUsageDescription
  packageJson.build.mac.extendInfo.NSSpeechRecognitionUsageDescription = manifest.packaging.speechRecognitionUsageDescription
  packageJson.build.mac.extendInfo.NSAppleEventsUsageDescription = manifest.packaging.automationUsageDescription
  const localSpeechHelperResource = {
    from: `../frontend/native/bin/${derived.localSpeechHelperBinaryName}`,
    to: `${derived.localSpeechHelperBinaryName}/${derived.localSpeechHelperBinaryName}`,
  }
  const systemControlHelperResource = {
    from: `../frontend/native/bin/${derived.systemControlHelperBinaryName}`,
    to: `${derived.systemControlHelperBinaryName}/${derived.systemControlHelperBinaryName}`,
  }
  const existingLocalSpeechHelperIndex = nextExtraResources.findIndex((entry) => (
    entry
    && typeof entry === 'object'
    && !Array.isArray(entry)
    && String(entry.to || '').includes('-local-speech-helper')
  ))
  const existingSystemControlHelperIndex = nextExtraResources.findIndex((entry) => (
    entry
    && typeof entry === 'object'
    && !Array.isArray(entry)
    && String(entry.to || '').includes('-system-control-helper')
  ))
  if (existingResourceIndex >= 0) {
    nextExtraResources[existingResourceIndex] = backendResource
  } else {
    nextExtraResources.push(backendResource)
  }
  if (existingLocalSpeechHelperIndex >= 0) {
    nextExtraResources[existingLocalSpeechHelperIndex] = localSpeechHelperResource
  } else {
    nextExtraResources.push(localSpeechHelperResource)
  }
  if (existingSystemControlHelperIndex >= 0) {
    nextExtraResources[existingSystemControlHelperIndex] = systemControlHelperResource
  } else {
    nextExtraResources.push(systemControlHelperResource)
  }
  packageJson.build.extraResources = nextExtraResources
  packageJson.scripts = {
    ...packageJson.scripts,
    'branding:sync': 'node ../scripts/sync-branding.mjs',
    'branding:validate': 'node ../scripts/validate-branding.mjs',
    'build:local-speech-helper': 'node scripts/build-local-speech-helper.mjs',
    'build:system-control-helper': 'node scripts/build-system-control-helper.mjs',
    'prepare:ffmpeg-runtime': 'node scripts/prepare-ffmpeg-runtime.mjs',
    'verify:release': 'bash ../scripts/verify-release.sh public-beta',
    'package:desktop': 'npm run prepare:ffmpeg-runtime && tsc -b && vite build && electron-builder',
    'package:desktop:mac': 'npm run prepare:ffmpeg-runtime && tsc -b && vite build && electron-builder --mac dmg --arm64',
    'package:desktop:mac:public-beta': 'npm run prepare:ffmpeg-runtime && tsc -b && vite build && electron-builder --mac dmg --arm64',
    'package:desktop:mac:signed': 'npm run prepare:ffmpeg-runtime && tsc -b && vite build && electron-builder --mac dmg --arm64',
    build: 'npm run branding:validate && npm run validate:mac-assets && npm run build:local-speech-helper && npm run build:system-control-helper && npm run package:desktop',
    'build:mac': 'bash ../scripts/build-mac.sh public-beta',
    'build:mac:public-beta': 'bash ../scripts/build-mac.sh public-beta',
    'build:mac:signed': 'bash ../scripts/build-mac.sh signed',
  }
  packageJson.build.files = [
    'package.json',
    {
      from: 'dist/renderer',
      to: 'dist/renderer',
      filter: ['**/*', '!**/*.map'],
    },
    {
      from: 'dist-electron',
      to: 'dist-electron',
      filter: ['**/*', '!**/*.map'],
    },
  ]

  const nextRaw = `${JSON.stringify(packageJson, null, 2)}\n`
  await fs.writeFile(FRONTEND_PACKAGE_JSON_PATH, nextRaw)
  return packageJson
}

export async function syncFrontendIndexHtml(manifest) {
  const raw = await fs.readFile(FRONTEND_INDEX_HTML_PATH, 'utf8')
  const next = raw
    .replace(/<link rel="icon"[^>]*href="[^"]*"[^>]*>/, `    <link rel="icon" type="image/png" href="${toPublicAssetPath(manifest.assets.brandMarkPng)}" />`)
    .replace(/<title>[\s\S]*?<\/title>/, `    <title>${manifest.windowTitles.main}</title>`)
  await fs.writeFile(FRONTEND_INDEX_HTML_PATH, next)
}

async function collectFiles(targetPath) {
  const stats = await fs.stat(targetPath)
  if (!stats.isDirectory()) {
    return [targetPath]
  }

  const entries = await fs.readdir(targetPath, { withFileTypes: true })
  const children = await Promise.all(entries.map(async (entry) => {
    const resolved = path.join(targetPath, entry.name)
    if (entry.isDirectory()) {
      return collectFiles(resolved)
    }
    return [resolved]
  }))
  return children.flat()
}

function buildQuotedContainsPattern(value) {
  const escaped = escapeRegExp(value)
  return new RegExp(`(['"\`])(?:\\\\.|(?!\\1)[^\\\\\\r\\n])*${escaped}(?:\\\\.|(?!\\1)[^\\\\\\r\\n])*\\1`)
}

async function validateExecutableBrandingResidue(manifest) {
  const derived = buildBrandingDerived(manifest)
  const scanTargets = [
    path.join(PROJECT_ROOT, 'frontend', 'src'),
    path.join(PROJECT_ROOT, 'frontend', 'electron'),
    path.join(PROJECT_ROOT, 'frontend', 'scripts'),
    path.join(PROJECT_ROOT, 'backend', 'config'),
    path.join(PROJECT_ROOT, 'backend', 'providers'),
    path.join(PROJECT_ROOT, 'backend', 'server.py'),
    path.join(PROJECT_ROOT, 'backend', 'utils'),
    path.join(PROJECT_ROOT, 'scripts', 'build-mac.sh'),
    path.join(PROJECT_ROOT, 'scripts', 'prepare-mac-assets.sh'),
    path.join(PROJECT_ROOT, 'scripts', 'validate-mac-assets.sh'),
  ]
  const allowedFiles = new Set([
    FRONTEND_BRANDING_MODULE_PATH,
    BACKEND_BRANDING_MODULE_PATH,
    BRANDING_ENV_PATH,
    FRONTEND_PACKAGE_JSON_PATH,
    FRONTEND_INDEX_HTML_PATH,
    path.join(PROJECT_ROOT, 'scripts', 'branding-lib.mjs'),
    path.join(PROJECT_ROOT, 'scripts', 'sync-branding.mjs'),
    path.join(PROJECT_ROOT, 'scripts', 'validate-branding.mjs'),
  ])
  const patterns = Array.from(new Map([
    ['displayName', manifest.displayName],
    ['tagline', manifest.tagline],
    ['backendTitle', manifest.backendTitle],
    ['healthMessage', manifest.healthMessage],
    ['aboutWindowTitle', manifest.windowTitles.about],
    ['appId', manifest.packaging.appId],
    ['protocolScheme', manifest.runtime.protocolScheme],
    ['protocolUrl', `${manifest.runtime.protocolScheme}://`],
    ['backendExecutableName', manifest.runtime.backendExecutableName],
    ['backendResourceDirName', manifest.runtime.backendResourceDirName],
    ['captureProcessorName', manifest.runtime.captureProcessorName],
    ['homeDirName', manifest.storage.homeDirName],
    ['homeEnvVar', manifest.storage.homeEnvVar],
    ['backendPortEnvVar', manifest.storage.backendPortEnvVar],
    ['backendUrlEnvVar', manifest.storage.backendUrlEnvVar],
    ['smokePortEnvVar', manifest.storage.smokePortEnvVar],
    ['fallbackLogFileName', manifest.storage.fallbackLogFileName],
    ['appHomeDisplayPath', derived.appHomeDisplayPath],
    ['backendLogDisplayPath', derived.backendLogDisplayPath],
    ['electronLogDisplayPath', derived.electronLogDisplayPath],
    ['appBundleName', derived.appBundleName],
  ].map(([label, value]) => [label, buildQuotedContainsPattern(value)])))
  const files = (await Promise.all(scanTargets.map((target) => collectFiles(target)))).flat()
  const findings = []

  for (const filePath of files) {
    if (allowedFiles.has(filePath)) continue
    const content = await fs.readFile(filePath, 'utf8')
    for (const [label, pattern] of patterns) {
      if (pattern.test(content)) {
        findings.push(`${path.relative(PROJECT_ROOT, filePath)} contains hard-coded ${label}`)
      }
    }
  }

  if (findings.length > 0) {
    throw new Error(`Executable branding residue found outside approved sources:\n- ${findings.join('\n- ')}`)
  }
}

export async function validateBrandingState(manifest) {
  const derived = buildBrandingDerived(manifest)
  const buildIconPath = toFrontendRelativePath(manifest.assets.buildIconIcns)
  const backendResourceFrom = path.posix.relative('frontend', path.posix.join('backend', 'dist', manifest.runtime.backendExecutableName))
  const packageJson = JSON.parse(await fs.readFile(FRONTEND_PACKAGE_JSON_PATH, 'utf8'))
  const indexHtml = await fs.readFile(FRONTEND_INDEX_HTML_PATH, 'utf8')
  const validations = [
    ['frontend/package.json description', packageJson.description === manifest.description],
    ['frontend/package.json author', packageJson.author === manifest.author],
    ['frontend/package.json build.appId', packageJson.build?.appId === manifest.packaging.appId],
    ['frontend/package.json build.productName', packageJson.build?.productName === manifest.displayName],
    ['frontend/package.json build.dmg.title', packageJson.build?.dmg?.title === manifest.packaging.dmgTitle],
    ['frontend/package.json build.mac.icon', packageJson.build?.mac?.icon === buildIconPath],
    ['frontend/package.json microphone usage description', packageJson.build?.mac?.extendInfo?.NSMicrophoneUsageDescription === manifest.packaging.microphoneUsageDescription],
    ['frontend/package.json speech recognition usage description', packageJson.build?.mac?.extendInfo?.NSSpeechRecognitionUsageDescription === manifest.packaging.speechRecognitionUsageDescription],
    ['frontend/package.json automation usage description', packageJson.build?.mac?.extendInfo?.NSAppleEventsUsageDescription === manifest.packaging.automationUsageDescription],
    ['frontend/package.json backend extraResource', Array.isArray(packageJson.build?.extraResources) && packageJson.build.extraResources.some((entry) => entry?.from === backendResourceFrom && entry?.to === manifest.runtime.backendResourceDirName)],
    ['frontend/package.json local speech helper extraResource', Array.isArray(packageJson.build?.extraResources) && packageJson.build.extraResources.some((entry) => entry?.from === `../frontend/native/bin/${derived.localSpeechHelperBinaryName}` && entry?.to === `${derived.localSpeechHelperBinaryName}/${derived.localSpeechHelperBinaryName}`)],
    ['frontend/package.json system control helper extraResource', Array.isArray(packageJson.build?.extraResources) && packageJson.build.extraResources.some((entry) => entry?.from === `../frontend/native/bin/${derived.systemControlHelperBinaryName}` && entry?.to === `${derived.systemControlHelperBinaryName}/${derived.systemControlHelperBinaryName}`)],
    ['frontend/package.json includes package.json in build.files', Array.isArray(packageJson.build?.files) && packageJson.build.files.includes('package.json')],
    ['frontend/index.html icon', indexHtml.includes(`href="${toPublicAssetPath(manifest.assets.brandMarkPng)}"`)],
    ['frontend/index.html title', indexHtml.includes(`<title>${manifest.windowTitles.main}</title>`)],
  ]

  const failures = validations.filter(([, valid]) => !valid).map(([label]) => label)
  if (failures.length > 0) {
    throw new Error(`Branding validation failed for:\n- ${failures.join('\n- ')}`)
  }

  await validateExecutableBrandingResidue(manifest)
}
