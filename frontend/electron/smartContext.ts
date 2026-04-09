import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const FIELD_SEPARATOR = String.fromCharCode(30)
const SUPPORTED_BROWSERS = new Set([
  'Safari',
  'Google Chrome',
  'Arc',
  'Brave Browser',
  'Microsoft Edge',
])

export interface SmartContext {
  app_name: string
  bundle_id: string | null
  window_title: string | null
  page_title: string | null
  url_host: string | null
  url_path: string | null
  focused_field_role: string | null
  focused_field_subrole: string | null
  focused_field_label: string | null
  focused_field_placeholder: string | null
}

export interface SmartContextAccessStatus {
  status: 'full' | 'app-only' | 'unavailable'
  message: string
  context: SmartContext | null
}

export interface SmartContextCaptureResult {
  context: SmartContext
  access: SmartContextAccessStatus
  warning: string | null
}

const EMPTY_CONTEXT: SmartContext = {
  app_name: 'Unknown',
  bundle_id: null,
  window_title: null,
  page_title: null,
  url_host: null,
  url_path: null,
  focused_field_role: null,
  focused_field_subrole: null,
  focused_field_label: null,
  focused_field_placeholder: null,
}

const DYNAMIC_PATH_SEGMENT_PATTERN = /^(?:\d{3,}|[0-9a-f]{8,}|[0-9a-f-]{16,}|[A-Za-z0-9_-]{24,})$/i

function normalizeValue(value: string | undefined) {
  return value && value.trim() ? value.trim() : null
}

function normalizeDecodedSegment(segment: string) {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

function sanitizeUrlPath(pathname: string) {
  if (!pathname || pathname === '/') return null

  const sanitizedSegments = pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => normalizeDecodedSegment(segment).trim())
    .filter(Boolean)
    .map((segment) => (DYNAMIC_PATH_SEGMENT_PATTERN.test(segment) ? ':id' : segment))

  if (!sanitizedSegments.length) return null

  const path = `/${sanitizedSegments.join('/')}`
  return path.length <= 120 ? path : `${path.slice(0, 117)}...`
}

async function runAppleScript(lines: string[]) {
  const { stdout } = await execFileAsync('osascript', lines.flatMap((line) => ['-e', line]), {
    timeout: 2500,
  })
  return stdout.trim()
}

async function captureFrontmostApp() {
  const raw = await runAppleScript([
    'tell application "System Events"',
    'set frontApp to first application process whose frontmost is true',
    'set appName to name of frontApp',
    'set bundleId to ""',
    'try',
    'set bundleId to bundle identifier of frontApp',
    'end try',
    'set windowTitle to ""',
    'try',
    'if (count of windows of frontApp) > 0 then',
    'set windowTitle to name of front window of frontApp',
    'end if',
    'end try',
    `return appName & (ASCII character 30) & bundleId & (ASCII character 30) & windowTitle`,
    'end tell',
  ])

  const [appName = 'Unknown', bundleId = '', windowTitle = ''] = raw.split(FIELD_SEPARATOR)
  return {
    app_name: appName || 'Unknown',
    bundle_id: normalizeValue(bundleId),
    window_title: normalizeValue(windowTitle),
  }
}

export async function captureActiveAppContext(): Promise<SmartContext> {
  const baseContext = await captureFrontmostApp()
  let focusedField = {}
  try {
    focusedField = await captureFocusedFieldDetails()
  } catch {
    focusedField = {}
  }
  return {
    ...EMPTY_CONTEXT,
    ...baseContext,
    ...focusedField,
  }
}

async function captureFocusedFieldDetails() {
  const raw = await runAppleScript([
    'tell application "System Events"',
    'set frontApp to first application process whose frontmost is true',
    'set roleValue to ""',
    'set subroleValue to ""',
    'set titleValue to ""',
    'set descriptionValue to ""',
    'set placeholderValue to ""',
    'try',
    'set focusedElement to value of attribute "AXFocusedUIElement" of frontApp',
    'try',
    'set roleValue to value of attribute "AXRole" of focusedElement',
    'end try',
    'try',
    'set subroleValue to value of attribute "AXSubrole" of focusedElement',
    'end try',
    'try',
    'set titleValue to value of attribute "AXTitle" of focusedElement',
    'end try',
    'try',
    'set descriptionValue to value of attribute "AXDescription" of focusedElement',
    'end try',
    'try',
    'set placeholderValue to value of attribute "AXPlaceholderValue" of focusedElement',
    'end try',
    'end try',
    `return roleValue & (ASCII character 30) & subroleValue & (ASCII character 30) & titleValue & (ASCII character 30) & descriptionValue & (ASCII character 30) & placeholderValue`,
    'end tell',
  ])

  const [roleValue = '', subroleValue = '', titleValue = '', descriptionValue = '', placeholderValue = ''] = raw.split(FIELD_SEPARATOR)
  return {
    focused_field_role: normalizeValue(roleValue),
    focused_field_subrole: normalizeValue(subroleValue),
    focused_field_label: normalizeValue(titleValue) || normalizeValue(descriptionValue),
    focused_field_placeholder: normalizeValue(placeholderValue),
  }
}

async function captureBrowserDetails(appName: string) {
  const lines = appName === 'Safari'
    ? [
      'tell application "Safari"',
      'set pageTitle to ""',
      'set pageUrl to ""',
      'try',
      'if (count of windows) > 0 then',
      'set pageTitle to name of current tab of front window',
      'set pageUrl to URL of current tab of front window',
      'end if',
      'end try',
      `return pageTitle & (ASCII character 30) & pageUrl`,
      'end tell',
    ]
    : [
      `tell application "${appName}"`,
      'set pageTitle to ""',
      'set pageUrl to ""',
      'try',
      'if (count of windows) > 0 then',
      'set pageTitle to title of active tab of front window',
      'set pageUrl to URL of active tab of front window',
      'end if',
      'end try',
      `return pageTitle & (ASCII character 30) & pageUrl`,
      'end tell',
    ]

  const raw = await runAppleScript(lines)
  const [pageTitle = '', pageUrl = ''] = raw.split(FIELD_SEPARATOR)

  let urlHost: string | null = null
  let urlPath: string | null = null
  try {
    if (pageUrl) {
      const parsedUrl = new URL(pageUrl)
      urlHost = parsedUrl.host
      urlPath = sanitizeUrlPath(parsedUrl.pathname)
    }
  } catch {
    urlHost = null
    urlPath = null
  }

  return {
    page_title: normalizeValue(pageTitle),
    url_host: normalizeValue(urlHost || ''),
    url_path: normalizeValue(urlPath || ''),
  }
}

function buildAccessStatus(
  context: SmartContext | null,
  warning: string | null,
  browserEnhanced: boolean,
): SmartContextAccessStatus {
  if (!context) {
    return {
      status: 'unavailable',
      message: warning || 'Smart Mode will use transcript-only fallback until context access is available.',
      context: null,
    }
  }

  if (warning) {
    return {
      status: 'app-only',
      message: warning,
      context,
    }
  }

  return {
    status: 'full',
    message: browserEnhanced
      ? 'Smart Mode can read the active app, window title, page title, site hostname, and a sanitized page path.'
      : 'Smart Mode can read the active app and window title. Supported browsers can also provide tab title, site hostname, and a sanitized page path when recording starts.',
    context,
  }
}

function describeFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  if (/not authorized|Not authorized|Automation|Apple events/i.test(message)) {
    return 'Browser context access is blocked. Smart Mode will fall back to app and window details until Automation is allowed.'
  }
  if (/System Events got an error|not permitted|access/i.test(message)) {
    return 'Frontmost app context is unavailable. Grant Accessibility and Automation access to enable Smart Mode context.'
  }
  return 'Smart Mode context is temporarily unavailable. Recording will continue with transcript-only fallback.'
}

export async function getSmartContextAccessStatus() {
  try {
    const baseContext = await captureFrontmostApp()
    let focusedField = {}
    try {
      focusedField = await captureFocusedFieldDetails()
    } catch {
      focusedField = {}
    }
    const isBrowser = SUPPORTED_BROWSERS.has(baseContext.app_name)
    if (!isBrowser) {
      return buildAccessStatus({
        ...EMPTY_CONTEXT,
        ...baseContext,
        ...focusedField,
      }, null, false)
    }

    try {
      const browserDetails = await captureBrowserDetails(baseContext.app_name)
      return buildAccessStatus({
        ...EMPTY_CONTEXT,
        ...baseContext,
        ...browserDetails,
        ...focusedField,
      }, null, true)
    } catch (error) {
      return buildAccessStatus({
        ...EMPTY_CONTEXT,
        ...baseContext,
        ...focusedField,
      }, describeFailure(error), false)
    }
  } catch (error) {
    return buildAccessStatus(null, describeFailure(error), false)
  }
}

export async function captureSmartContext(): Promise<SmartContextCaptureResult> {
  const access = await getSmartContextAccessStatus()
  return {
    context: access.context || { ...EMPTY_CONTEXT },
    access,
    warning: access.status === 'full' ? null : access.message,
  }
}
