import { app, BrowserWindow, ipcMain, Tray, Menu, globalShortcut, clipboard, Notification, nativeImage, systemPreferences, screen, shell, dialog, desktopCapturer, type OpenDialogOptions, type SaveDialogOptions } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import * as https from 'node:https'
import os from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import {
    ABOUT_WINDOW_TITLE,
    APP_HOME_ENV_VAR,
    APP_HOME_DIR_NAME,
    APP_PROTOCOL_SCHEME,
    BACKEND_LOG_FILE_NAME,
    BRAND_MARK_PUBLIC_PATH,
    CLIPBOARD_SELECTION_MARKER_PREFIX,
    DISPLAY_NAME,
    ELECTRON_LOG_FILE_NAME,
    LOGO_MARK_PUBLIC_PATH,
    MAIN_WINDOW_TITLE,
    TRAY_TEMPLATE_PUBLIC_PATH,
} from '../shared/branding'
import { captureSelectedText, pasteFinalText } from './ClipboardManager'
import {
    applyStablePreviewText,
    formatStablePreviewText,
    resolveLiveTranscriptionStrategy,
    type LiveTranscriptionStrategy,
    type StableLivePreviewState,
} from './liveTranscriptionRouting'
import { NativeSpeechHelperManager, type NativeSpeechEvent } from './nativeSpeechHelper'
import { createPasteDeliveryCoordinator } from './pasteDelivery'
import { HOTKEY_TOGGLE_REARM_MS, resolveRecordingToggleDecision } from './recordingToggle'
import {
    buildSemanticMemoryNoPythonMessage,
    buildSemanticMemoryPythonRequirementMessage,
    isSemanticMemoryPythonCompatible,
    type SemanticMemoryDoctorPayload,
    type SemanticMemoryInstallErrorCode,
    type SemanticMemoryRuntimeSource,
    type SemanticMemorySqliteModule,
    normalizeSemanticMemoryInstallError,
    parsePythonVersion,
} from './semanticMemorySupport'
import { captureSmartContext, getSmartContextAccessStatus, type SmartContext } from './smartContext'
import {
    SMART_SCREEN_CAPTURE_TARGET_BYTES,
    chooseOptimizedJpegBuffer,
    nextScreenCaptureSize,
    scaleScreenCaptureSize,
} from './smartScreenCapture'
import { createBackendLifecycleService, type BackendBootState } from './backendLifecycle'
import { SEMANTIC_MEMORY_HELPER_TEMPLATE, SEMANTIC_MEMORY_REQUIREMENTS } from './semanticMemoryHelperTemplate'
function resolveAppHomePath(...parts: string[]) {
    const override = process.env[APP_HOME_ENV_VAR]?.trim()
    const basePath = override ? path.resolve(override) : path.join(os.homedir(), APP_HOME_DIR_NAME)
    return path.join(basePath, ...parts)
}

const logDir = resolveAppHomePath('logs')
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true })
const electronLogStr = fs.createWriteStream(path.join(logDir, ELECTRON_LOG_FILE_NAME), { flags: 'a' })

type RecordingMode = 'dictation' | 'smart_transform'

type MlxInstallState = {
    supported: boolean
    installed: boolean
    ffmpeg_available: boolean
    phase: 'idle' | 'checking' | 'installing' | 'verifying' | 'restarting_backend' | 'ready' | 'error'
    label: string
    detail: string
    progress: number | null
    logs: string[]
    can_install: boolean
    venv_available: boolean
}

type SemanticMemoryInstallState = {
    supported: boolean
    installed: boolean
    python_available: boolean
    python_compatible: boolean
    runtime_source: SemanticMemoryRuntimeSource
    python_version: string | null
    python_path: string | null
    sqlite_module: SemanticMemorySqliteModule
    sqlite_version: string | null
    vec_version: string | null
    error_code: SemanticMemoryInstallErrorCode | null
    log_path: string | null
    runtime_path: string | null
    phase: 'idle' | 'checking' | 'provisioning_runtime' | 'installing' | 'preparing_model' | 'ready' | 'fallback' | 'repair_needed' | 'error'
    label: string
    detail: string
    progress: number | null
    logs: string[]
    can_install: boolean
}

type SemanticMemoryBootstrapPython = {
    command: string
    compatible: boolean
    version: string | null
    pythonPath: string
    source: SemanticMemoryRuntimeSource
    reason: string | null
}

type SemanticMemoryRuntimeStateFile = {
    installed?: boolean
    ready?: boolean
    runtime_source?: SemanticMemoryRuntimeSource
    python_path?: string | null
    python_version?: string | null
    sqlite_module?: SemanticMemorySqliteModule
    sqlite_version?: string | null
    vec_version?: string | null
    selected_model?: string | null
    model_ready?: boolean
    error_code?: SemanticMemoryInstallErrorCode | null
    detail?: string | null
    log_path?: string | null
    install_log_path?: string | null
    runtime_path?: string | null
    last_checked_at?: string | null
}

type SemanticRuntimeInstallAttemptResult =
    | {
        ok: true
        payload: SemanticMemoryDoctorPayload
    }
    | {
        ok: false
        errorCode: SemanticMemoryInstallErrorCode
        detail: string
    }

type WidgetPresentationSource = 'tray' | 'hotkey' | 'idle'
type WidgetExpansionReason = 'modeMenu' | 'smartPreview' | 'actionReview' | 'liveTranscript'
type WidgetPresentationCommand = {
    visible: boolean
    source: WidgetPresentationSource
}
type PasteResult = {
    status: 'pasted' | 'copied' | 'failed'
    detail: string | null
}

type CaptureMode = RecordingMode | 'mic_test'
type CaptureState = {
    is_recording: boolean
    is_testing: boolean
    mode: CaptureMode | null
    phase: 'idle' | 'starting' | 'recording' | 'stopping'
    amplitude: number
    error: string | null
    active_device_id: string | null
    active_device_label: string | null
    fallback_to_default: boolean
    fallback_notice: string | null
}

type CaptureAudioConfig = {
    input_device: string | null
    input_device_id: string | null
    input_device_label: string | null
}

type CaptureDevice = {
    id: string
    label: string
    is_default: boolean
    group_id: string | null
}

type CaptureStats = {
    duration_ms: number
    peak: number
    rms: number
    used_device_id: string | null
    used_device_label: string | null
    fallback_to_default: boolean
    fallback_notice: string | null
}

type CaptureStopResult = {
    status: 'success' | 'error'
    audio_base64?: string
    error?: string
    capture_stats?: CaptureStats
}

type CaptureChunkPayload = {
    sessionId: string
    sampleRate: number
    pcmS16leBase64: string
}

type SmartTextSnapshot = {
    selectionText: string | null
    selectionTruncated: boolean
    clipboardText: string | null
    clipboardTruncated: boolean
}

type ScreenCapturePayload = {
    mime_type: 'image/jpeg'
    image_base64: string
    width: number
    height: number
}

type ActiveCaptureSession =
    | {
        kind: 'recording'
        mode: RecordingMode
        context: SmartContext | null
        contextWarning: string | null
        selectionText: string | null
        selectionTruncated: boolean
        clipboardText: string | null
        clipboardTruncated: boolean
        screenCapture: ScreenCapturePayload | null
        requestedDeviceId: string | null
        requestedDeviceLabel: string | null
        enrichmentPromise: Promise<void> | null
        liveSessionId: string
        liveStrategy: LiveTranscriptionStrategy
        liveChunkBuffer: Buffer[]
        liveChunkBytes: number
        liveFlushTimer: NodeJS.Timeout | null
        captureTimeline: {
            button_down: string
            capture_started: string | null
            first_partial: string | null
            stop_pressed: string | null
        }
    }
    | {
        kind: 'mic_test'
        requestedDeviceId: string | null
        requestedDeviceLabel: string | null
    }

type RecordingCaptureSession = Extract<ActiveCaptureSession, { kind: 'recording' }>

type LocalLiveTranscriptionState = {
    session_id: string
    mode: RecordingMode
    state: 'starting' | 'streaming' | 'done' | 'error'
    text: string
    source: 'native_local'
    is_final: boolean
    updated_at: string
    error: string | null
}

type LiveTranscriptionResult = {
    transcript: string | null
    source: 'provider' | 'native_local' | null
    first_partial_at: string | null
    error: string | null
}

type SuccessfulCaptureStopResult = CaptureStopResult & {
    status: 'success'
    audio_base64: string
    capture_stats: CaptureStats
}

type PendingRecordingSubmission = {
    session: RecordingCaptureSession
    stopResult: SuccessfulCaptureStopResult
    liveTranscriptionResult: LiveTranscriptionResult | null
}

type LocalAppState = {
    onboardingDismissed: boolean
    onboardingCompleted: boolean
    backgroundOnly: boolean
}

type UsageStatsSnapshot = {
    dictation_runs?: number
}

type LaunchContext = {
    is_packaged: boolean
    backend_base_url: string
    app_version: string
    release_channel: 'development' | 'public_beta'
    trust_posture: 'development' | 'unsigned_beta'
    manual_updates_only: boolean
    supported_architecture: 'apple_silicon'
    install_location: 'applications' | 'disk_image' | 'other' | 'development'
    should_prompt_move_to_applications: boolean
    onboarding_completed: boolean
    onboarding_dismissed: boolean
    dictation_tested: boolean
    onboarding_blocker: string | null
    background_only: boolean
    log_paths: {
        backend: string
        electron: string
    }
}

const WIDGET_TOP_OFFSET = 6
const WIDGET_HIDE_FALLBACK_MS = 260
const WIDGET_WIDTH = 720
const WIDGET_COLLAPSED_HEIGHT = 144
const WIDGET_EXPANDED_HEIGHT = 304
const WIDGET_ACTION_REVIEW_HEIGHT = 372
const WIDGET_STREAMING_HEIGHT = 132
const WIDGET_LIVE_TRANSCRIPT_HEIGHT = 184
const SMART_CLIPBOARD_CHAR_LIMIT = 3000
const LIVE_TRANSCRIPTION_FLUSH_MS = 220
const execFileAsync = promisify(execFile)
const BRAND_MARK_FILE_NAME = path.basename(BRAND_MARK_PUBLIC_PATH)
const LOGO_MARK_FILE_NAME = path.basename(LOGO_MARK_PUBLIC_PATH)
const TRAY_TEMPLATE_FILE_NAME = path.basename(TRAY_TEMPLATE_PUBLIC_PATH)
const PREPARING_DISPLAY_NAME = `Preparing ${DISPLAY_NAME}`
const STARTING_DISPLAY_NAME = `Starting ${DISPLAY_NAME}`
const RESTARTING_DISPLAY_NAME = `Restarting ${DISPLAY_NAME}`
const READY_DETAIL = `${DISPLAY_NAME} is ready.`
const COULD_NOT_FINISH_STARTING_DETAIL = `${DISPLAY_NAME} could not finish starting.`
const COULD_NOT_START_DETAIL = `${DISPLAY_NAME} could not start.`
const STOPPED_UNEXPECTEDLY_DETAIL = `${DISPLAY_NAME} stopped unexpectedly.`
const DIRECT_PASTE_FALLBACK_DETAIL = `Direct paste failed. ${DISPLAY_NAME} copied the output so you can paste it manually.`
const SEMANTIC_MEMORY_MANAGED_PYTHON = Object.freeze({
    version: '3.12.13',
    archiveName: 'cpython-3.12.13+20260408-aarch64-apple-darwin-install_only_stripped.tar.gz',
    url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20260408/cpython-3.12.13%2B20260408-aarch64-apple-darwin-install_only_stripped.tar.gz',
    sha256: 'ac167e74961316ceabdbe4839f19aa6000c592b08e5a1fab4646cb225ede13d5',
})
const PRIVACY_SETTINGS_URLS = {
    microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
    accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
} as const

function logToFile(msg: string) {
    const ts = new Date().toISOString()
    electronLogStr.write(`[${ts}] ${msg}\n`)
    console.log(`[${ts}] ${msg}`)
}

async function runAppleScript(lines: string[]) {
    const { stdout } = await execFileAsync('osascript', lines.flatMap((line) => ['-e', line]), {
        timeout: 2500,
    })
    return stdout.trim()
}

function getMacAppIconPath() {
    const iconCandidates = [
        path.join(process.env.APP_ROOT as string, 'build', 'icon.png'),
        path.join(process.env.VITE_PUBLIC as string, LOGO_MARK_FILE_NAME),
        path.join(process.env.VITE_PUBLIC as string, BRAND_MARK_FILE_NAME),
    ]
    return iconCandidates.find((candidate) => fs.existsSync(candidate)) ?? null
}

function getNotificationIconPath() {
    const iconCandidates = [
        path.join(process.env.VITE_PUBLIC as string, LOGO_MARK_FILE_NAME),
        path.join(process.env.APP_ROOT as string, 'build', 'icon.png'),
        path.join(process.env.VITE_PUBLIC as string, BRAND_MARK_FILE_NAME),
    ]
    return iconCandidates.find((candidate) => fs.existsSync(candidate)) ?? null
}

function buildNotificationOptions(title: string, body: string) {
    const options: Electron.NotificationConstructorOptions = {
        title,
        body,
        silent: true,
    }

    if (process.platform === 'darwin') {
        return options
    }

    const iconPath = getNotificationIconPath()
    if (iconPath) {
        const icon = nativeImage.createFromPath(iconPath)
        if (!icon.isEmpty()) {
            options.icon = icon
        }
    }

    return options
}

function isPackagedTrayOnlyMac() {
    return process.platform === 'darwin' && app.isPackaged
}

function applyActivationPolicy() {
    if (process.platform !== 'darwin') {
        return
    }

    if (isPackagedTrayOnlyMac() || appState.backgroundOnly || !app.isPackaged) {
        app.setActivationPolicy('accessory')
        app.dock?.hide()
        return
    }

    app.setActivationPolicy('regular')
    app.dock?.show()
}

function configureMacAppIdentity() {
    app.setName(DISPLAY_NAME)

    if (process.platform !== 'darwin') {
        return
    }

    applyActivationPolicy()

    const iconPath = getMacAppIconPath()
    if (iconPath && app.dock) {
        app.dock.setIcon(iconPath)
    }
}

function loadRendererRoute(win: BrowserWindow, route: string) {
    if (VITE_DEV_SERVER_URL) {
        void win.loadURL(`${VITE_DEV_SERVER_URL}#${route}`)
        return
    }

    void win.loadFile(path.join(RENDERER_DIST, 'index.html'), { hash: route })
}

function windowHasExpectedRoute(win: BrowserWindow, route: string) {
    const currentUrl = win.webContents.getURL()
    if (!currentUrl || currentUrl === 'about:blank') return false

    if (VITE_DEV_SERVER_URL) {
        return currentUrl.startsWith(VITE_DEV_SERVER_URL) && currentUrl.includes(`#${route}`)
    }

    return currentUrl.includes(`#${route}`)
}

function attachRendererDiagnostics(win: BrowserWindow, label: string) {
    const webContentsId = win.webContents.id

    win.webContents.on('did-finish-load', () => {
        unavailableRendererIds.delete(webContentsId)
        logToFile(`${label} finished loading: ${win.webContents.getURL() || 'unknown URL'}`)
    })

    win.webContents.on('did-fail-load', (_event, code, description, validatedURL) => {
        logToFile(`${label} failed to load (${code}): ${description} — ${validatedURL}`)
    })

    win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
        logToFile(`${label} console[${level}] ${sourceId}:${line} — ${message}`)
    })

    win.webContents.on('render-process-gone', (_event, details) => {
        unavailableRendererIds.add(webContentsId)
        logToFile(`${label} renderer exited unexpectedly: ${details.reason} (exitCode=${details.exitCode})`)
    })

    win.webContents.once('destroyed', () => {
        unavailableRendererIds.delete(webContentsId)
    })
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))

process.env.APP_ROOT = path.join(__dirname, '..')

export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist', 'renderer')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST

let widgetWin: BrowserWindow | null = null
let settingsWin: BrowserWindow | null = null
let captureWin: BrowserWindow | null = null
let inboxWin: BrowserWindow | null = null
let aboutWin: BrowserWindow | null = null
let tray: Tray | null = null
const unavailableRendererIds = new Set<number>()
let widgetHideFallbackTimer: NodeJS.Timeout | null = null
let isAppQuitting = false
let isTogglingRecording = false;
let hotkeyToggleRearmUntil = 0
const widgetExpansionReasons = new Set<WidgetExpansionReason>()
const pendingDeepLinks: string[] = []
let appState: LocalAppState = {
    onboardingDismissed: false,
    onboardingCompleted: false,
    backgroundOnly: false,
}
let backendBootState: BackendBootState = {
    phase: 'booting_backend',
    label: PREPARING_DISPLAY_NAME,
    detail: 'Getting things ready.',
    progress: 12,
}
const backendLifecycle = createBackendLifecycleService({
    appRoot: process.env.APP_ROOT as string,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    setBootState: (state) => setBackendBootState(state),
    getBootState: () => backendBootState,
    onReady: () => {
        if (pendingRecordingSubmission) {
            void submitPendingRecordingSubmission().catch((error) => {
                logToFile(`Pending recording retry failed: ${error instanceof Error ? error.message : String(error)}`)
            })
        }
    },
    onUnexpectedExit: (detail) => {
        markBackendUnavailable(detail)
    },
    log: logToFile,
    preparingDisplayName: PREPARING_DISPLAY_NAME,
    startingDisplayName: STARTING_DISPLAY_NAME,
    readyDetail: READY_DETAIL,
    couldNotStartDetail: COULD_NOT_START_DETAIL,
    couldNotFinishStartingDetail: COULD_NOT_FINISH_STARTING_DETAIL,
    stoppedUnexpectedlyDetail: STOPPED_UNEXPECTEDLY_DETAIL,
})
let mlxInstallState: MlxInstallState = {
    supported: process.platform === 'darwin' && process.arch === 'arm64',
    installed: false,
    ffmpeg_available: false,
    phase: 'idle',
    label: 'Local STT not installed',
    detail: 'Install MLX Whisper in the backend virtualenv to enable local speech recognition.',
    progress: null,
    logs: [],
    can_install: false,
    venv_available: false,
}
let semanticMemoryInstallState: SemanticMemoryInstallState = {
    supported: true,
    installed: false,
    python_available: false,
    python_compatible: false,
    runtime_source: 'none',
    python_version: null,
    python_path: null,
    sqlite_module: 'unknown',
    sqlite_version: null,
    vec_version: null,
    error_code: null,
    log_path: path.join(resolveAppHomePath('semantic-memory'), 'runtime.log'),
    runtime_path: resolveAppHomePath('semantic-memory'),
    phase: 'fallback',
    label: 'Fallback active',
    detail: `${DISPLAY_NAME} is using lexical local memory. Install the optional semantic runtime to improve paraphrase recall.`,
    progress: null,
    logs: [],
    can_install: false,
}
let captureHostReady = false
let captureReadyResolvers: Array<() => void> = []
const pendingCaptureRequests = new Map<string, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    timer: NodeJS.Timeout
}>()
let activeCaptureSession: ActiveCaptureSession | null = null
let mlxInstallerProcess: ChildProcess | null = null
let semanticMemoryInstallerProcess: ChildProcess | null = null
let cachedCaptureAudioConfig: { value: CaptureAudioConfig; cachedAt: number } | null = null
let localLiveTranscriptionState: LocalLiveTranscriptionState | null = null
let localLivePreviewState: StableLivePreviewState | null = null
const backendClient = backendLifecycle.client
let pendingRecordingSubmission: PendingRecordingSubmission | null = null
let captureState: CaptureState = {
    is_recording: false,
    is_testing: false,
    mode: null,
    phase: 'idle',
    amplitude: 0,
    error: null,
    active_device_id: null,
    active_device_label: null,
    fallback_to_default: false,
    fallback_notice: null,
}
const nativeSpeechHelper = new NativeSpeechHelperManager({
    appRoot: process.env.APP_ROOT as string,
    appHomePath: resolveAppHomePath(),
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    log: logToFile,
    onEvent: handleNativeSpeechHelperEvent,
})
const pasteDeliveryCoordinator = createPasteDeliveryCoordinator({
    performPaste: performPasteTextDelivery,
    acknowledgePaste: acknowledgePendingPasteDelivery,
    log: logToFile,
})

function resetRecordingCaptureState(error: string | null = null) {
    clearLocalLiveTranscriptionState()
    setCaptureState({
        is_recording: false,
        is_testing: false,
        mode: null,
        phase: 'idle',
        amplitude: 0,
        error,
        active_device_id: null,
        active_device_label: null,
        fallback_to_default: false,
        fallback_notice: null,
    })
}

function isWindowAlive(win: BrowserWindow | null): win is BrowserWindow {
    return Boolean(win && !win.isDestroyed())
}

function canSendToWindow(win: BrowserWindow | null): win is BrowserWindow {
    return Boolean(
        win
        && !win.isDestroyed()
        && !win.webContents.isDestroyed()
        && !unavailableRendererIds.has(win.webContents.id),
    )
}

function sendWindowMessage(win: BrowserWindow | null, channel: string, ...args: unknown[]) {
    if (!canSendToWindow(win)) {
        return false
    }

    try {
        win.webContents.send(channel, ...args)
        return true
    } catch (error) {
        unavailableRendererIds.add(win.webContents.id)
        const message = error instanceof Error ? error.message : String(error)
        logToFile(`Skipped ${channel} update because the renderer is no longer available: ${message}`)
        return false
    }
}

function broadcastWindowMessage(channel: string, ...args: unknown[]) {
    for (const win of BrowserWindow.getAllWindows()) {
        sendWindowMessage(win, channel, ...args)
    }
}

function isCaptureDeviceList(value: unknown): value is CaptureDevice[] {
    return Array.isArray(value)
        && value.every((device) => (
            device
            && typeof device === 'object'
            && typeof (device as Record<string, unknown>).id === 'string'
            && typeof (device as Record<string, unknown>).label === 'string'
        ))
}

function quitApplication() {
    if (isAppQuitting) return

    isAppQuitting = true
    clearWidgetHideFallback()
    backendLifecycle.dispose()

    tray?.destroy()
    tray = null

    for (const win of [aboutWin, inboxWin, widgetWin, settingsWin, captureWin]) {
        if (isWindowAlive(win)) {
            win.destroy()
        }
    }

    void stopBackend()
    app.quit()
}

function setBackendBootState(nextState: BackendBootState) {
    backendBootState = nextState
    broadcastWindowMessage('backend-boot-state', backendBootState)
}

function markBackendUnavailable(detail: string = STOPPED_UNEXPECTEDLY_DETAIL) {
    setBackendBootState({
        phase: 'error',
        label: 'Unavailable',
        detail,
        progress: null,
    })

    const activeRecordingSession = activeCaptureSession?.kind === 'recording' ? activeCaptureSession : null
    if (activeRecordingSession) {
        void nativeSpeechHelper.cancelSession(activeRecordingSession.liveSessionId).catch(() => undefined)
        void requestCaptureHost('stop-recording').catch(() => undefined)
        activeCaptureSession = null
    }

    resetRecordingCaptureState('Backend unavailable. Restart the backend and try again.')
}

function setMlxInstallState(nextState: MlxInstallState) {
    mlxInstallState = nextState
    broadcastWindowMessage('mlx-install-state', mlxInstallState)
}

function setSemanticMemoryInstallState(nextState: SemanticMemoryInstallState) {
    semanticMemoryInstallState = nextState
    broadcastWindowMessage('semantic-memory-install-state', semanticMemoryInstallState)
}

function appendMlxInstallLog(message: string) {
    setMlxInstallState({
        ...mlxInstallState,
        logs: [...mlxInstallState.logs, message].slice(-250),
    })
}

function appendSemanticMemoryInstallLog(message: string) {
    const normalized = message.trim()
    if (!normalized) return
    try {
        fs.mkdirSync(path.dirname(getSemanticMemoryInstallLogPath()), { recursive: true })
        fs.appendFileSync(getSemanticMemoryInstallLogPath(), normalized + '\n', 'utf8')
    } catch {
        // Best-effort diagnostics only.
    }
    setSemanticMemoryInstallState({
        ...semanticMemoryInstallState,
        logs: [...semanticMemoryInstallState.logs, normalized].slice(-250),
    })
}

function tailLines(raw: string, limit: number = 250) {
    return raw
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter(Boolean)
        .slice(-limit)
}

function readJsonFile<T>(filePath: string): T | null {
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
        return parsed
    } catch {
        return null
    }
}

function writeSemanticMemoryState(patch: Partial<SemanticMemoryRuntimeStateFile>) {
    const statePath = getSemanticMemoryStatePath()
    const existing = readJsonFile<SemanticMemoryRuntimeStateFile>(statePath) ?? {}
    const nextState: SemanticMemoryRuntimeStateFile = {
        ...existing,
        runtime_path: getSemanticMemoryRuntimeRoot(),
        log_path: path.join(getSemanticMemoryRuntimeRoot(), 'runtime.log'),
        install_log_path: getSemanticMemoryInstallLogPath(),
        last_checked_at: new Date().toISOString(),
        ...patch,
    }
    fs.mkdirSync(path.dirname(statePath), { recursive: true })
    fs.writeFileSync(statePath, JSON.stringify(nextState, null, 2), 'utf8')
}

function readSemanticMemoryStateFile() {
    return readJsonFile<SemanticMemoryRuntimeStateFile>(getSemanticMemoryStatePath()) ?? {}
}

function readSemanticMemoryLogTail() {
    const lines: string[] = []
    for (const filePath of [getSemanticMemoryInstallLogPath(), path.join(getSemanticMemoryRuntimeRoot(), 'runtime.log')]) {
        if (!fs.existsSync(filePath)) continue
        try {
            lines.push(...tailLines(fs.readFileSync(filePath, 'utf8')))
        } catch {
            continue
        }
    }
    return lines.slice(-250)
}

function broadcastCaptureState() {
    broadcastWindowMessage('capture-state', captureState)
}

function broadcastLocalLiveTranscriptionState() {
    broadcastWindowMessage('local-live-transcription', localLiveTranscriptionState)
}

function setCaptureState(patch: Partial<CaptureState>) {
    captureState = {
        ...captureState,
        ...patch,
    }
    broadcastCaptureState()
}

function setLocalLiveTranscriptionState(nextState: LocalLiveTranscriptionState | null) {
    localLiveTranscriptionState = nextState
    broadcastLocalLiveTranscriptionState()
}

function clearLocalLiveTranscriptionState(sessionId?: string | null) {
    if (sessionId && localLiveTranscriptionState?.session_id !== sessionId) {
        return
    }
    localLivePreviewState = null
    setLocalLiveTranscriptionState(null)
}

function getAppStateFile() {
    return path.join(app.getPath('userData'), 'app-state.json')
}

function loadAppState(): LocalAppState {
    try {
        const raw = fs.readFileSync(getAppStateFile(), 'utf-8')
        const parsed = JSON.parse(raw) as Partial<LocalAppState>
        return {
            onboardingDismissed: Boolean(parsed.onboardingDismissed),
            onboardingCompleted: Boolean(parsed.onboardingCompleted),
            backgroundOnly: Boolean(parsed.backgroundOnly),
        }
    } catch {
        return {
            onboardingDismissed: false,
            onboardingCompleted: false,
            backgroundOnly: false,
        }
    }
}

function saveAppState(nextState: LocalAppState) {
    appState = nextState
    fs.mkdirSync(app.getPath('userData'), { recursive: true })
    fs.writeFileSync(getAppStateFile(), JSON.stringify(appState, null, 2))
    applyActivationPolicy()
}

function updateAppState(patch: Partial<LocalAppState>) {
    saveAppState({
        ...appState,
        ...patch,
    })
}

function getInstallLocation(): LaunchContext['install_location'] {
    if (!app.isPackaged) return 'development'

    const execPath = app.getPath('exe')
    if (execPath.startsWith('/Applications/')) return 'applications'
    if (execPath.startsWith('/Volumes/')) return 'disk_image'
    return 'other'
}

async function readPackagedOnboardingStatus(installLocation: LaunchContext['install_location']) {
    let dictationTested = false

    try {
        const usage = await backendClient.getJson<UsageStatsSnapshot>('/usage', { timeoutMs: 1200 })
        dictationTested = Number(usage?.dictation_runs || 0) > 0
    } catch (error) {
        logToFile(`Launch context could not read usage stats: ${error instanceof Error ? error.message : String(error)}`)
    }

    if (!app.isPackaged) {
        return {
            dictation_tested: dictationTested,
            onboarding_blocker: null,
        }
    }

    if (installLocation !== 'applications') {
        return {
            dictation_tested: dictationTested,
            onboarding_blocker: installLocation === 'disk_image'
                ? `Move ${DISPLAY_NAME} from the downloaded DMG into /Applications, then reopen it from there before finishing setup.`
                : `Move ${DISPLAY_NAME} into /Applications before finishing setup so permissions and helper paths stay stable.`,
        }
    }

    if (!dictationTested) {
        return {
            dictation_tested: false,
            onboarding_blocker: 'Run one successful Dictate pass before finishing setup.',
        }
    }

    return {
        dictation_tested: true,
        onboarding_blocker: null,
    }
}

async function getLaunchContext(): Promise<LaunchContext> {
    const installLocation = getInstallLocation()
    const packagedOnboarding = await readPackagedOnboardingStatus(installLocation)
    const packagedRequirementsMet = !app.isPackaged || (
        installLocation === 'applications'
        && packagedOnboarding.dictation_tested
    )

    return {
        is_packaged: app.isPackaged,
        backend_base_url: backendLifecycle.getBaseUrl(),
        app_version: app.getVersion(),
        release_channel: app.isPackaged ? 'public_beta' : 'development',
        trust_posture: app.isPackaged ? 'unsigned_beta' : 'development',
        manual_updates_only: app.isPackaged,
        supported_architecture: 'apple_silicon',
        install_location: installLocation,
        should_prompt_move_to_applications: app.isPackaged && installLocation !== 'applications',
        onboarding_completed: appState.onboardingCompleted && packagedRequirementsMet,
        onboarding_dismissed: appState.onboardingDismissed,
        dictation_tested: packagedOnboarding.dictation_tested,
        onboarding_blocker: packagedOnboarding.onboarding_blocker,
        background_only: appState.backgroundOnly,
        log_paths: {
            backend: resolveAppHomePath('logs', BACKEND_LOG_FILE_NAME),
            electron: resolveAppHomePath('logs', ELECTRON_LOG_FILE_NAME),
        },
    }
}

function registerDeepLinkClient() {
    try {
        if (process.defaultApp && process.argv[1]) {
            app.setAsDefaultProtocolClient(APP_PROTOCOL_SCHEME, process.execPath, [path.resolve(process.argv[1])])
            return
        }
        app.setAsDefaultProtocolClient(APP_PROTOCOL_SCHEME)
    } catch (error) {
        logToFile(`Failed to register ${APP_PROTOCOL_SCHEME} protocol: ${error instanceof Error ? error.message : String(error)}`)
    }
}

function findDeepLinkArg(argv: string[]) {
    return argv.find((value) => value.startsWith(`${APP_PROTOCOL_SCHEME}://`)) || null
}

function enqueueDeepLink(url: string) {
    pendingDeepLinks.push(url)
}

function resolveDeepLinkRecordMode(value: string | null): RecordingMode | null {
    if (!value) return 'dictation'
    if (value === 'dictate' || value === 'dictation') return 'dictation'
    if (value === 'rewrite' || value === 'smart_transform') return 'smart_transform'
    return null
}

async function handleDeepLink(url: string) {
    try {
        const parsed = new URL(url)
        const action = parsed.hostname.toLowerCase()

        if (action === 'record') {
            const mode = resolveDeepLinkRecordMode(parsed.searchParams.get('mode'))
            if (!mode) {
                throw new Error(`Unsupported record mode in deep link: ${parsed.searchParams.get('mode')}`)
            }
            const shouldRevealWidget = !captureState.is_recording && (!activeCaptureSession || activeCaptureSession.kind !== 'recording')
            if (shouldRevealWidget) {
                requestWidgetOpen('hotkey')
            }
            await toggleRecording(mode)
            if (!isWindowAlive(widgetWin) || !widgetWin.isVisible()) {
                requestWidgetOpen('hotkey')
            }
            return
        }

        if (action === 'open') {
            const route = parsed.searchParams.get('route') || '/'
            const id = parsed.searchParams.get('id')
            const resolvedRoute = route === '/templates' && id
                ? `${route}?id=${encodeURIComponent(id)}`
                : route
            showMainWindow(resolvedRoute)
            return
        }

        if (action === 'settings') {
            const step = parsed.searchParams.get('step')
            showMainWindow(step ? `/settings?step=${step}` : '/settings')
            return
        }

        showHomeWindow()
    } catch (error) {
        logToFile(`Failed to handle deep link ${url}: ${error instanceof Error ? error.message : String(error)}`)
    }
}

async function flushPendingDeepLinks() {
    while (pendingDeepLinks.length) {
        const nextUrl = pendingDeepLinks.shift()
        if (!nextUrl) continue
        await handleDeepLink(nextUrl)
    }
}

function getBackendVenvPythonPath() {
    return path.join(process.env.APP_ROOT as string, '..', 'backend', '.venv', 'bin', 'python3')
}

function getMlxRequirementsPath() {
    return path.join(process.env.APP_ROOT as string, '..', 'backend', 'requirements-mlx.txt')
}

function getSemanticMemoryRuntimeRoot() {
    return resolveAppHomePath('semantic-memory')
}

function getSemanticMemoryRuntimeVenvPath() {
    return path.join(getSemanticMemoryRuntimeRoot(), 'venv')
}

function getSemanticMemoryRuntimePythonPath() {
    return path.join(getSemanticMemoryRuntimeVenvPath(), 'bin', 'python3')
}

function getSemanticMemoryHelperPath() {
    return path.join(getSemanticMemoryRuntimeRoot(), 'semantic_memory_helper.py')
}

function getSemanticMemoryRequirementsPath() {
    return path.join(getSemanticMemoryRuntimeRoot(), 'requirements.txt')
}

function getSemanticMemoryStatePath() {
    return path.join(getSemanticMemoryRuntimeRoot(), 'state.json')
}

function getSemanticMemoryInstallLogPath() {
    return path.join(getSemanticMemoryRuntimeRoot(), 'install.log')
}

function getSemanticMemoryManagedPythonRoot() {
    return path.join(getSemanticMemoryRuntimeRoot(), 'python')
}

function getSemanticMemoryManagedPythonPath() {
    return path.join(getSemanticMemoryManagedPythonRoot(), 'bin', 'python3')
}

function getSemanticMemoryManagedPythonArchivePath() {
    return path.join(getSemanticMemoryRuntimeRoot(), SEMANTIC_MEMORY_MANAGED_PYTHON.archiveName)
}

async function inspectSemanticMemoryBootstrapPython(
    command: string,
    source: SemanticMemoryRuntimeSource,
    options: { preflight: boolean },
): Promise<SemanticMemoryBootstrapPython | null> {
    const { preflight } = options
    const result = await runCommandCheck(command, ['-c', 'import sys; print(".".join(str(part) for part in sys.version_info[:3]))'])
    if (result.code !== 0) {
        return null
    }

    const rawVersion = result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) ?? ''
    const version = parsePythonVersion(rawVersion)
    const compatible = isSemanticMemoryPythonCompatible(version)
    let reason: string | null = null
    if (preflight && compatible) {
        const preflightResult = await runSemanticMemoryBootstrapPreflight(command)
        if (!preflightResult.ok) {
            return {
                command,
                compatible: false,
                version: version?.raw ?? (rawVersion || null),
                pythonPath: command,
                source,
                reason: preflightResult.reason,
            }
        }
    } else if (!compatible) {
        reason = buildSemanticMemoryPythonRequirementMessage(version?.raw ?? (rawVersion || null))
    }

    return {
        command,
        compatible,
        version: version?.raw ?? (rawVersion || null),
        pythonPath: command,
        source,
        reason,
    }
}

async function runSemanticMemoryBootstrapPreflight(command: string): Promise<{ ok: boolean; reason: string | null }> {
    const probeRoot = await fsp.mkdtemp(path.join(os.tmpdir(), `${APP_PROTOCOL_SCHEME}-semantic-bootstrap-`))
    const probeVenv = path.join(probeRoot, 'probe-env')
    try {
        const venvResult = await runCommandCheck(command, ['-m', 'venv', probeVenv])
        if (venvResult.code !== 0) {
            return {
                ok: false,
                reason: `${DISPLAY_NAME} could not create a semantic runtime virtualenv with ${command}. ${venvResult.stderr.trim() || venvResult.stdout.trim() || 'Virtualenv creation failed.'}`,
            }
        }
        const probePython = path.join(probeVenv, 'bin', 'python3')
        const pipResult = await runPythonCommand(probePython, ['-m', 'pip', '--version'])
        if (pipResult.code !== 0) {
            return {
                ok: false,
                reason: `${DISPLAY_NAME} created a semantic virtualenv with ${command}, but pip is unavailable inside it.`,
            }
        }
        return { ok: true, reason: null }
    } catch (error) {
        return {
            ok: false,
            reason: error instanceof Error ? error.message : String(error),
        }
    } finally {
        await fsp.rm(probeRoot, { recursive: true, force: true }).catch(() => undefined)
    }
}

async function resolveSemanticMemoryBootstrapPythonInfo(preflight: boolean = false): Promise<SemanticMemoryBootstrapPython | null> {
    const candidates: Array<{ command: string; source: SemanticMemoryRuntimeSource }> = []
    const managedPython = getSemanticMemoryManagedPythonPath()
    if (fs.existsSync(managedPython)) {
        candidates.push({ command: managedPython, source: 'managed' })
    }
    if (!app.isPackaged && backendVenvAvailable()) {
        candidates.push({ command: getBackendVenvPythonPath(), source: 'development' })
    }
    candidates.push(
        { command: 'python3', source: 'system' },
        { command: 'python', source: 'system' },
    )

    let fallback: SemanticMemoryBootstrapPython | null = null
    for (const candidate of candidates) {
        const resolved = await inspectSemanticMemoryBootstrapPython(candidate.command, candidate.source, { preflight })
        if (!resolved) continue
        if (resolved.compatible) {
            return resolved
        }
        if (!fallback) {
            fallback = resolved
        }
    }
    return fallback
}

async function downloadHttpsBuffer(url: string, redirects: number = 5): Promise<Buffer> {
    return await new Promise<Buffer>((resolve, reject) => {
        const request = https.get(url, {
            headers: {
                'user-agent': `${DISPLAY_NAME}/semantic-memory`,
            },
        }, (response) => {
            const statusCode = response.statusCode ?? 0
            const location = response.headers.location
            if (statusCode >= 300 && statusCode < 400 && location && redirects > 0) {
                response.resume()
                void downloadHttpsBuffer(new URL(location, url).toString(), redirects - 1).then(resolve).catch(reject)
                return
            }
            if (statusCode !== 200) {
                response.resume()
                reject(new Error(`Managed runtime download failed with status ${statusCode}.`))
                return
            }
            const chunks: Buffer[] = []
            response.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
            response.on('end', () => resolve(Buffer.concat(chunks)))
            response.on('error', reject)
        })
        request.on('error', reject)
    })
}

async function provisionManagedSemanticPythonRuntime(forceRefresh: boolean = false): Promise<SemanticMemoryBootstrapPython> {
    const runtimeRoot = getSemanticMemoryRuntimeRoot()
    const managedRoot = getSemanticMemoryManagedPythonRoot()
    const managedPython = getSemanticMemoryManagedPythonPath()
    const archivePath = getSemanticMemoryManagedPythonArchivePath()

    await fsp.mkdir(runtimeRoot, { recursive: true })
    if (!forceRefresh && fs.existsSync(managedPython)) {
        const existing = await inspectSemanticMemoryBootstrapPython(managedPython, 'managed', { preflight: true })
        if (existing?.compatible) {
            return existing
        }
    }

    appendSemanticMemoryInstallLog(`Downloading managed Python runtime ${SEMANTIC_MEMORY_MANAGED_PYTHON.version} for semantic retrieval.`)
    const archiveBuffer = await downloadHttpsBuffer(SEMANTIC_MEMORY_MANAGED_PYTHON.url)
    const archiveHash = createHash('sha256').update(archiveBuffer).digest('hex')
    if (archiveHash !== SEMANTIC_MEMORY_MANAGED_PYTHON.sha256) {
        throw new Error('Managed runtime checksum verification failed.')
    }
    await fsp.writeFile(archivePath, archiveBuffer)
    await fsp.rm(managedRoot, { recursive: true, force: true }).catch(() => undefined)

    await execFileAsync('tar', ['-xzf', archivePath, '-C', runtimeRoot])
    if (!fs.existsSync(managedPython)) {
        throw new Error('Managed runtime extraction failed. Python executable was not created.')
    }

    const resolved = await inspectSemanticMemoryBootstrapPython(managedPython, 'managed', { preflight: true })
    if (!resolved?.compatible) {
        throw new Error(resolved?.reason || 'Managed Python runtime did not pass the semantic bootstrap checks.')
    }
    return resolved
}

async function ensureSemanticMemoryRuntimeFiles() {
    const runtimeRoot = getSemanticMemoryRuntimeRoot()
    await fsp.mkdir(runtimeRoot, { recursive: true })
    await fsp.writeFile(getSemanticMemoryHelperPath(), SEMANTIC_MEMORY_HELPER_TEMPLATE, 'utf8')
    await fsp.writeFile(getSemanticMemoryRequirementsPath(), SEMANTIC_MEMORY_REQUIREMENTS, 'utf8')
    await fsp.chmod(getSemanticMemoryHelperPath(), 0o755).catch(() => undefined)
}

function parseSemanticMemoryDoctorPayload(raw: string): SemanticMemoryDoctorPayload | null {
    try {
        const parsed = JSON.parse(raw) as SemanticMemoryDoctorPayload
        if (!parsed || typeof parsed !== 'object') return null
        return parsed
    } catch {
        return null
    }
}

function backendVenvAvailable() {
    return fs.existsSync(getBackendVenvPythonPath())
}

function runPythonCheck(args: string[]) {
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const pythonPath = getBackendVenvPythonPath()
        if (!fs.existsSync(pythonPath)) {
            reject(new Error('Backend virtualenv python not found.'))
            return
        }

        const child = spawn(pythonPath, args, {
            cwd: path.join(process.env.APP_ROOT as string, '..', 'backend'),
            env: process.env,
            stdio: 'pipe',
        })

        let stdout = ''
        let stderr = ''

        child.stdout?.on('data', (chunk) => {
            stdout += chunk.toString()
        })
        child.stderr?.on('data', (chunk) => {
            stderr += chunk.toString()
        })
        child.on('error', reject)
        child.on('exit', (code) => resolve({ code, stdout, stderr }))
    })
}

function runPythonCommand(pythonPath: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }) {
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(pythonPath, args, {
            cwd: options?.cwd,
            env: options?.env ?? process.env,
            stdio: 'pipe',
        })

        let stdout = ''
        let stderr = ''

        child.stdout?.on('data', (chunk) => {
            stdout += chunk.toString()
        })
        child.stderr?.on('data', (chunk) => {
            stderr += chunk.toString()
        })
        child.on('error', reject)
        child.on('exit', (code) => resolve({ code, stdout, stderr }))
    })
}

function runCommandCheck(command: string, args: string[] = []) {
    return new Promise<{ code: number | null; stdout: string; stderr: string; spawnError: string | null }>((resolve) => {
        let stdout = ''
        let stderr = ''
        let spawnError: string | null = null
        let settled = false

        const finish = (code: number | null) => {
            if (settled) return
            settled = true
            resolve({ code, stdout, stderr, spawnError })
        }

        const child = spawn(command, args, {
            env: process.env,
            stdio: 'pipe',
        })

        child.stdout?.on('data', (chunk) => {
            stdout += chunk.toString()
        })
        child.stderr?.on('data', (chunk) => {
            stderr += chunk.toString()
        })
        child.on('error', (error) => {
            spawnError = error.message
            finish(null)
        })
        child.on('exit', (code) => finish(code))
    })
}

async function checkMlxWhisperInstallation() {
    const supported = process.platform === 'darwin' && process.arch === 'arm64'
    const venvAvailable = backendVenvAvailable()

    setMlxInstallState({
        ...mlxInstallState,
        supported,
        venv_available: venvAvailable,
        ffmpeg_available: false,
        phase: 'checking',
        label: 'Checking local STT',
        detail: 'Inspecting the backend virtualenv for MLX Whisper.',
        progress: 10,
        can_install: false,
    })

    if (app.isPackaged) {
        setMlxInstallState({
            ...mlxInstallState,
            supported,
            installed: true,
            ffmpeg_available: true,
            venv_available: false,
            phase: 'idle',
            label: 'Bundled runtime',
            detail: `${DISPLAY_NAME} manages the packaged local speech runtime automatically. Use the Voice settings screen to refresh runtime status if local speech is unavailable.`,
            progress: null,
            can_install: false,
        })
        return mlxInstallState
    }

    if (!supported) {
        setMlxInstallState({
            ...mlxInstallState,
            supported: false,
            installed: false,
            ffmpeg_available: false,
            venv_available: venvAvailable,
            phase: 'idle',
            label: 'Apple Silicon required',
            detail: 'MLX Whisper is available only on Apple Silicon Macs.',
            progress: null,
            can_install: false,
        })
        return mlxInstallState
    }

    if (!venvAvailable) {
        setMlxInstallState({
            ...mlxInstallState,
            supported,
            installed: false,
            ffmpeg_available: false,
            venv_available: false,
            phase: 'idle',
            label: 'Backend virtualenv missing',
            detail: 'The backend .venv is missing, so MLX Whisper cannot be installed from Settings.',
            progress: null,
            can_install: false,
        })
        return mlxInstallState
    }

    try {
        const result = await runPythonCheck(['-c', 'import mlx_whisper'])
        const installed = result.code === 0
        const ffmpegCheck = await runCommandCheck('ffmpeg', ['-version'])
        const ffmpegAvailable = ffmpegCheck.code === 0
        setMlxInstallState({
            ...mlxInstallState,
            supported,
            installed,
            ffmpeg_available: ffmpegAvailable,
            venv_available: true,
            phase: installed && ffmpegAvailable ? 'ready' : 'idle',
            label: installed
                ? (ffmpegAvailable ? 'Installed locally' : 'ffmpeg required')
                : 'Local STT not installed',
            detail: installed
                ? (ffmpegAvailable
                    ? 'MLX Whisper is available in the backend virtualenv.'
                    : `MLX Whisper is installed, but ffmpeg is missing from PATH. Install ffmpeg and restart ${DISPLAY_NAME}.`)
                : 'Install MLX Whisper in the backend virtualenv to enable local speech recognition.',
            progress: installed && ffmpegAvailable ? 100 : null,
            can_install: !installed && mlxInstallerProcess === null,
        })
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        setMlxInstallState({
            ...mlxInstallState,
            supported,
            installed: false,
            ffmpeg_available: false,
            venv_available: venvAvailable,
            phase: 'error',
            label: 'Check failed',
            detail,
            progress: null,
            can_install: supported && venvAvailable && mlxInstallerProcess === null,
        })
    }

    return mlxInstallState
}

async function installMlxWhisper() {
    if (mlxInstallerProcess) {
        return mlxInstallState
    }

    const supported = process.platform === 'darwin' && process.arch === 'arm64'
    const venvAvailable = backendVenvAvailable()

    if (app.isPackaged || !supported || !venvAvailable) {
        await checkMlxWhisperInstallation()
        return mlxInstallState
    }

    const pythonPath = getBackendVenvPythonPath()
    const requirementsPath = getMlxRequirementsPath()

    setMlxInstallState({
        ...mlxInstallState,
        supported,
        installed: false,
        ffmpeg_available: mlxInstallState.ffmpeg_available,
        venv_available: true,
        phase: 'installing',
        label: 'Installing MLX Whisper',
        detail: 'Installing the optional local STT runtime into backend/.venv.',
        progress: 25,
        logs: ['$ python3 -m pip install -r backend/requirements-mlx.txt'],
        can_install: false,
    })

    mlxInstallerProcess = spawn(pythonPath, ['-m', 'pip', 'install', '-r', requirementsPath], {
        cwd: path.join(process.env.APP_ROOT as string, '..', 'backend'),
        env: process.env,
        stdio: 'pipe',
    })

    mlxInstallerProcess.stdout?.on('data', (chunk) => {
        appendMlxInstallLog(chunk.toString().trimEnd())
        setMlxInstallState({
            ...mlxInstallState,
            progress: 60,
        })
    })

    mlxInstallerProcess.stderr?.on('data', (chunk) => {
        appendMlxInstallLog(chunk.toString().trimEnd())
        setMlxInstallState({
            ...mlxInstallState,
            progress: 68,
        })
    })

    return new Promise<MlxInstallState>((resolve) => {
        mlxInstallerProcess?.on('error', (error) => {
            mlxInstallerProcess = null
            setMlxInstallState({
                ...mlxInstallState,
                phase: 'error',
                label: 'Install failed',
                detail: error.message,
                progress: null,
                can_install: true,
            })
            resolve(mlxInstallState)
        })

        mlxInstallerProcess?.on('exit', async (code) => {
            mlxInstallerProcess = null
            if (code !== 0) {
                setMlxInstallState({
                    ...mlxInstallState,
                    phase: 'error',
                    label: 'Install failed',
                    detail: `pip exited with code ${code}. Review the logs below.`,
                    progress: null,
                    can_install: true,
                })
                resolve(mlxInstallState)
                return
            }

            setMlxInstallState({
                ...mlxInstallState,
                phase: 'verifying',
                label: 'Verifying local runtime',
                detail: 'Checking that MLX Whisper is importable from the backend virtualenv.',
                progress: 82,
            })

            try {
                const verifyResult = await runPythonCheck(['-c', 'import mlx_whisper'])
                if (verifyResult.code !== 0) {
                    setMlxInstallState({
                        ...mlxInstallState,
                        phase: 'error',
                        label: 'Verification failed',
                        detail: verifyResult.stderr.trim() || 'MLX Whisper did not import cleanly after installation.',
                        progress: null,
                        can_install: true,
                    })
                    resolve(mlxInstallState)
                    return
                }

                const ffmpegCheck = await runCommandCheck('ffmpeg', ['-version'])
                if (ffmpegCheck.code !== 0) {
                    appendMlxInstallLog('ffmpeg was not found on PATH.')
                    setMlxInstallState({
                        ...mlxInstallState,
                        supported: true,
                        installed: true,
                        ffmpeg_available: false,
                        venv_available: true,
                        phase: 'idle',
                        label: 'ffmpeg required',
                        detail: `MLX Whisper is installed, but ffmpeg is missing from PATH. Install ffmpeg with Homebrew and restart ${DISPLAY_NAME}.`,
                        progress: null,
                        can_install: false,
                    })
                    resolve(mlxInstallState)
                    return
                }

                setMlxInstallState({
                    ...mlxInstallState,
                    ffmpeg_available: true,
                    phase: 'restarting_backend',
                    label: RESTARTING_DISPLAY_NAME,
                    detail: 'Reloading the local backend so MLX Whisper is available right away.',
                    progress: 92,
                })

                await stopBackend()
                await startBackend()

                setMlxInstallState({
                    ...mlxInstallState,
                    supported: true,
                    installed: true,
                    ffmpeg_available: true,
                    phase: 'ready',
                    label: 'Installed locally',
                    detail: 'MLX Whisper is installed in backend/.venv and ready to use.',
                    progress: 100,
                    can_install: false,
                    venv_available: true,
                })
                resolve(mlxInstallState)
            } catch (error) {
                setMlxInstallState({
                    ...mlxInstallState,
                    phase: 'error',
                    label: 'Verification failed',
                    detail: error instanceof Error ? error.message : String(error),
                    progress: null,
                    can_install: true,
                })
                resolve(mlxInstallState)
            }
        })
    })
}

function buildSemanticMemoryFallbackDetail(bootstrapPython: SemanticMemoryBootstrapPython | null) {
    if (!bootstrapPython) {
        return `${DISPLAY_NAME} is using lexical local memory. ${buildSemanticMemoryNoPythonMessage()}`
    }
    if (!bootstrapPython.compatible) {
        return `${DISPLAY_NAME} is using lexical local memory. ${bootstrapPython.reason || buildSemanticMemoryPythonRequirementMessage(bootstrapPython.version)}`
    }
    return `${DISPLAY_NAME} is using lexical local memory. Install the optional semantic runtime to improve paraphrase recall.`
}

async function runSemanticMemoryDoctor(runtimePython: string) {
    const result = await runPythonCommand(runtimePython, [
        getSemanticMemoryHelperPath(),
        '--doctor',
        '--runtime-root',
        getSemanticMemoryRuntimeRoot(),
    ])
    const payload = parseSemanticMemoryDoctorPayload(result.stdout.trim())
    return { result, payload }
}

async function installSemanticRuntimeWithBootstrap(bootstrapPython: SemanticMemoryBootstrapPython): Promise<SemanticRuntimeInstallAttemptResult> {
    const runtimeRoot = getSemanticMemoryRuntimeRoot()
    const runtimeVenv = getSemanticMemoryRuntimeVenvPath()
    const runtimePython = getSemanticMemoryRuntimePythonPath()
    const helperPath = getSemanticMemoryHelperPath()
    const requirementsPath = getSemanticMemoryRequirementsPath()

    await fsp.rm(runtimeVenv, { recursive: true, force: true }).catch(() => undefined)

    setSemanticMemoryInstallState({
        ...semanticMemoryInstallState,
        supported: true,
        installed: false,
        python_available: true,
        python_compatible: true,
        runtime_source: bootstrapPython.source,
        python_version: bootstrapPython.version,
        python_path: bootstrapPython.pythonPath,
        phase: 'installing',
        label: 'Installing semantic runtime',
        detail: `Creating an app-managed semantic runtime with ${bootstrapPython.command}${bootstrapPython.version ? ` (${bootstrapPython.version})` : ''}.`,
        progress: 12,
        logs: readSemanticMemoryLogTail(),
        can_install: false,
    })

    appendSemanticMemoryInstallLog(`Using ${bootstrapPython.command}${bootstrapPython.version ? ` (${bootstrapPython.version})` : ''}`)
    appendSemanticMemoryInstallLog(`$ ${bootstrapPython.command} -m venv ${runtimeVenv}`)

    await new Promise<void>((resolve, reject) => {
        semanticMemoryInstallerProcess = spawn(bootstrapPython.command, ['-m', 'venv', runtimeVenv], {
            env: process.env,
            stdio: 'pipe',
        })

        semanticMemoryInstallerProcess.stdout?.on('data', (chunk) => appendSemanticMemoryInstallLog(chunk.toString()))
        semanticMemoryInstallerProcess.stderr?.on('data', (chunk) => appendSemanticMemoryInstallLog(chunk.toString()))
        semanticMemoryInstallerProcess.on('error', reject)
        semanticMemoryInstallerProcess.on('exit', (code) => {
            semanticMemoryInstallerProcess = null
            if (code !== 0) {
                reject(new Error(`Virtualenv creation exited with code ${code}.`))
                return
            }
            resolve()
        })
    })

    setSemanticMemoryInstallState({
        ...semanticMemoryInstallState,
        phase: 'installing',
        label: 'Installing packages',
        detail: 'Installing the semantic runtime packages into app-managed storage.',
        progress: 45,
        can_install: false,
    })

    const pipUpgrade = await runPythonCommand(runtimePython, ['-m', 'pip', 'install', '--upgrade', 'pip'])
    appendSemanticMemoryInstallLog(pipUpgrade.stdout)
    appendSemanticMemoryInstallLog(pipUpgrade.stderr)

    appendSemanticMemoryInstallLog(`$ ${runtimePython} -m pip install -r ${requirementsPath}`)
    const installResult = await runPythonCommand(runtimePython, ['-m', 'pip', 'install', '-r', requirementsPath])
    appendSemanticMemoryInstallLog(installResult.stdout)
    appendSemanticMemoryInstallLog(installResult.stderr)
    if (installResult.code !== 0) {
        return {
            ok: false,
            errorCode: 'package_install_failed' as SemanticMemoryInstallErrorCode,
            detail: normalizeSemanticMemoryInstallError(
                installResult.stderr.trim() || installResult.stdout.trim() || 'pip did not finish cleanly.',
                bootstrapPython.version,
            ),
        }
    }

    appendSemanticMemoryInstallLog(`$ ${runtimePython} ${helperPath} --doctor --runtime-root ${runtimeRoot}`)
    const doctorResult = await runSemanticMemoryDoctor(runtimePython)
    appendSemanticMemoryInstallLog(doctorResult.result.stdout)
    appendSemanticMemoryInstallLog(doctorResult.result.stderr)
    if (doctorResult.result.code !== 0 || !doctorResult.payload?.ok) {
        return {
            ok: false,
            errorCode: doctorResult.payload?.error_code || 'runtime_corrupt',
            detail: normalizeSemanticMemoryInstallError(
                doctorResult.payload?.detail
                    || doctorResult.result.stderr.trim()
                    || doctorResult.result.stdout.trim()
                    || 'The semantic runtime health check failed.',
                bootstrapPython.version,
            ),
        }
    }

    setSemanticMemoryInstallState({
        ...semanticMemoryInstallState,
        phase: 'preparing_model',
        label: 'Preparing model',
        detail: 'Downloading and warming the local semantic embedding model into app-managed storage.',
        progress: 78,
        sqlite_module: doctorResult.payload.sqlite_module,
        sqlite_version: doctorResult.payload.sqlite_version,
        vec_version: doctorResult.payload.vec_version,
        can_install: false,
    })

    appendSemanticMemoryInstallLog(`$ ${runtimePython} ${helperPath} --prepare --runtime-root ${runtimeRoot}`)
    const prepareResult = await runPythonCommand(runtimePython, [helperPath, '--prepare', '--runtime-root', runtimeRoot])
    appendSemanticMemoryInstallLog(prepareResult.stdout)
    appendSemanticMemoryInstallLog(prepareResult.stderr)
    const preparePayload = parseSemanticMemoryDoctorPayload(prepareResult.stdout.trim())
    if (prepareResult.code !== 0 || !preparePayload?.ok) {
        return {
            ok: false,
            errorCode: preparePayload?.error_code || 'model_prepare_failed',
            detail: normalizeSemanticMemoryInstallError(
                preparePayload?.detail
                    || prepareResult.stderr.trim()
                    || prepareResult.stdout.trim()
                    || 'The semantic model could not be prepared.',
                bootstrapPython.version,
            ),
        }
    }

    return {
        ok: true,
        payload: preparePayload,
    }
}

async function checkSemanticMemoryInstallation() {
    await ensureSemanticMemoryRuntimeFiles()
    setSemanticMemoryInstallState({
        ...semanticMemoryInstallState,
        supported: true,
        phase: 'checking',
        label: 'Checking semantic memory',
        detail: 'Inspecting the optional local semantic memory runtime.',
        progress: 12,
        can_install: false,
        logs: readSemanticMemoryLogTail(),
    })

    const persistedState = readSemanticMemoryStateFile()
    const bootstrapPython = await resolveSemanticMemoryBootstrapPythonInfo(false)
    const pythonAvailable = Boolean(bootstrapPython)
    const pythonCompatible = Boolean(bootstrapPython?.compatible)
    const pythonVersion = bootstrapPython?.version ?? persistedState.python_version ?? null
    const runtimePython = getSemanticMemoryRuntimePythonPath()
    const helperPath = getSemanticMemoryHelperPath()
    const runtimeReady = fs.existsSync(runtimePython) && fs.existsSync(helperPath)

    if (!runtimeReady) {
        const nextState: SemanticMemoryInstallState = {
            ...semanticMemoryInstallState,
            supported: true,
            installed: false,
            python_available: pythonAvailable,
            python_compatible: pythonCompatible,
            runtime_source: bootstrapPython?.source ?? persistedState.runtime_source ?? 'none',
            python_version: pythonVersion,
            python_path: bootstrapPython?.pythonPath ?? persistedState.python_path ?? null,
            sqlite_module: persistedState.sqlite_module ?? 'unknown',
            sqlite_version: persistedState.sqlite_version ?? null,
            vec_version: persistedState.vec_version ?? null,
            error_code: persistedState.error_code ?? null,
            log_path: persistedState.log_path ?? path.join(getSemanticMemoryRuntimeRoot(), 'runtime.log'),
            runtime_path: persistedState.runtime_path ?? getSemanticMemoryRuntimeRoot(),
            phase: 'fallback',
            label: 'Fallback active',
            detail: buildSemanticMemoryFallbackDetail(bootstrapPython),
            progress: null,
            logs: readSemanticMemoryLogTail(),
            can_install: semanticMemoryInstallerProcess === null,
        }
        setSemanticMemoryInstallState(nextState)
        writeSemanticMemoryState({
            installed: false,
            ready: false,
            runtime_source: nextState.runtime_source,
            python_path: nextState.python_path,
            python_version: nextState.python_version,
            sqlite_module: nextState.sqlite_module,
            sqlite_version: nextState.sqlite_version,
            vec_version: nextState.vec_version,
            error_code: nextState.error_code,
            detail: nextState.detail,
        })
        return nextState
    }

    const doctorResult = await runSemanticMemoryDoctor(runtimePython)
    const doctorPayload = doctorResult.payload
    const doctorFailed = doctorResult.result.code !== 0 || !doctorPayload?.ok
    if (doctorFailed) {
        const detail = normalizeSemanticMemoryInstallError(
            doctorPayload?.detail
                || doctorResult.result.stderr.trim()
                || doctorResult.result.stdout.trim()
                || 'The semantic runtime did not report a healthy status.',
            pythonVersion,
        )
        const nextState: SemanticMemoryInstallState = {
            ...semanticMemoryInstallState,
            supported: true,
            installed: true,
            python_available: pythonAvailable,
            python_compatible: pythonCompatible,
            runtime_source: persistedState.runtime_source ?? 'system',
            python_version: doctorPayload?.python_version ?? pythonVersion,
            python_path: persistedState.python_path ?? runtimePython,
            sqlite_module: doctorPayload?.sqlite_module ?? persistedState.sqlite_module ?? 'unknown',
            sqlite_version: doctorPayload?.sqlite_version ?? persistedState.sqlite_version ?? null,
            vec_version: doctorPayload?.vec_version ?? persistedState.vec_version ?? null,
            error_code: doctorPayload?.error_code || 'runtime_corrupt',
            log_path: path.join(getSemanticMemoryRuntimeRoot(), 'runtime.log'),
            runtime_path: getSemanticMemoryRuntimeRoot(),
            phase: 'repair_needed',
            label: 'Repair needed',
            detail,
            progress: null,
            logs: readSemanticMemoryLogTail(),
            can_install: semanticMemoryInstallerProcess === null,
        }
        setSemanticMemoryInstallState(nextState)
        writeSemanticMemoryState({
            installed: true,
            ready: false,
            runtime_source: nextState.runtime_source,
            python_path: nextState.python_path,
            python_version: nextState.python_version,
            sqlite_module: nextState.sqlite_module,
            sqlite_version: nextState.sqlite_version,
            vec_version: nextState.vec_version,
            error_code: nextState.error_code,
            detail: nextState.detail,
        })
        return nextState
    }

    const modelCached = Boolean(doctorPayload.model_cached)
    const nextState: SemanticMemoryInstallState = {
        ...semanticMemoryInstallState,
        supported: true,
        installed: true,
        python_available: pythonAvailable || Boolean(persistedState.python_path),
        python_compatible: pythonCompatible || Boolean(doctorPayload.python_version),
        runtime_source: persistedState.runtime_source ?? 'system',
        python_version: doctorPayload.python_version,
        python_path: persistedState.python_path ?? runtimePython,
        sqlite_module: doctorPayload.sqlite_module,
        sqlite_version: doctorPayload.sqlite_version,
        vec_version: doctorPayload.vec_version,
        error_code: null,
        log_path: path.join(getSemanticMemoryRuntimeRoot(), 'runtime.log'),
        runtime_path: getSemanticMemoryRuntimeRoot(),
        phase: modelCached ? 'ready' : 'repair_needed',
        label: modelCached ? 'Ready' : 'Repair needed',
        detail: modelCached
            ? 'Semantic retrieval is installed and ready for local memory ranking.'
            : 'The semantic runtime is healthy, but the embedding model is not prepared yet. Repair semantic retrieval to finish setup.',
        progress: modelCached ? 100 : null,
        logs: readSemanticMemoryLogTail(),
        can_install: semanticMemoryInstallerProcess === null,
    }
    setSemanticMemoryInstallState(nextState)
    writeSemanticMemoryState({
        installed: true,
        ready: modelCached,
        runtime_source: nextState.runtime_source,
        python_path: nextState.python_path,
        python_version: nextState.python_version,
        sqlite_module: nextState.sqlite_module,
        sqlite_version: nextState.sqlite_version,
        vec_version: nextState.vec_version,
        error_code: null,
        detail: nextState.detail,
    })
    return nextState
}

async function installSemanticMemoryRuntime(forceRepair: boolean = false) {
    if (
        semanticMemoryInstallerProcess
        || semanticMemoryInstallState.phase === 'installing'
        || semanticMemoryInstallState.phase === 'preparing_model'
        || semanticMemoryInstallState.phase === 'provisioning_runtime'
    ) {
        return semanticMemoryInstallState
    }

    await ensureSemanticMemoryRuntimeFiles()
    await fsp.mkdir(getSemanticMemoryRuntimeRoot(), { recursive: true })
    if (forceRepair) {
        await fsp.rm(getSemanticMemoryRuntimeVenvPath(), { recursive: true, force: true }).catch(() => undefined)
    }

    appendSemanticMemoryInstallLog(`=== Semantic install attempt ${new Date().toISOString()} ===`)

    let bootstrapPython = await resolveSemanticMemoryBootstrapPythonInfo(true)
    if (!bootstrapPython?.compatible) {
        setSemanticMemoryInstallState({
            ...semanticMemoryInstallState,
            supported: true,
            installed: false,
            python_available: Boolean(bootstrapPython),
            python_compatible: false,
            runtime_source: 'managed',
            python_version: bootstrapPython?.version ?? null,
            python_path: bootstrapPython?.pythonPath ?? null,
            error_code: !bootstrapPython ? 'missing_python' : 'python_probe_failed',
            phase: 'provisioning_runtime',
            label: 'Provisioning runtime',
            detail: bootstrapPython?.reason || buildSemanticMemoryNoPythonMessage(),
            progress: 12,
            logs: readSemanticMemoryLogTail(),
            can_install: false,
            sqlite_module: semanticMemoryInstallState.sqlite_module,
            sqlite_version: semanticMemoryInstallState.sqlite_version,
            vec_version: semanticMemoryInstallState.vec_version,
            log_path: path.join(getSemanticMemoryRuntimeRoot(), 'runtime.log'),
            runtime_path: getSemanticMemoryRuntimeRoot(),
        })
        try {
            bootstrapPython = await provisionManagedSemanticPythonRuntime(forceRepair)
        } catch (error) {
            const rawDetail = error instanceof Error ? error.message : String(error)
            const normalizedLower = rawDetail.toLowerCase()
            const detail = normalizeSemanticMemoryInstallError(
                rawDetail,
                bootstrapPython?.version ?? null,
            )
            const nextState: SemanticMemoryInstallState = {
                ...semanticMemoryInstallState,
                supported: true,
                installed: false,
                python_available: false,
                python_compatible: false,
                runtime_source: 'managed',
                python_version: null,
                python_path: null,
                sqlite_module: 'unknown',
                sqlite_version: null,
                vec_version: null,
                error_code: normalizedLower.includes('checksum')
                    ? 'managed_runtime_checksum_failed'
                    : normalizedLower.includes('extract')
                        ? 'managed_runtime_extract_failed'
                        : 'managed_runtime_download_failed',
                log_path: path.join(getSemanticMemoryRuntimeRoot(), 'runtime.log'),
                runtime_path: getSemanticMemoryRuntimeRoot(),
                phase: 'error',
                label: 'Provisioning failed',
                detail,
                progress: null,
                logs: readSemanticMemoryLogTail(),
                can_install: true,
            }
            setSemanticMemoryInstallState(nextState)
            writeSemanticMemoryState({
                installed: false,
                ready: false,
                runtime_source: 'managed',
                error_code: nextState.error_code,
                detail: nextState.detail,
            })
            return nextState
        }
    }

    try {
        let installResult = await installSemanticRuntimeWithBootstrap(bootstrapPython)
        if (!installResult.ok && bootstrapPython.source !== 'managed') {
            appendSemanticMemoryInstallLog('System Python semantic install failed. Falling back to a managed Python runtime.')
            setSemanticMemoryInstallState({
                ...semanticMemoryInstallState,
                phase: 'provisioning_runtime',
                label: 'Provisioning runtime',
                detail: `The system Python runtime could not complete semantic setup. ${DISPLAY_NAME} is provisioning a managed Python runtime and will retry automatically.`,
                progress: 30,
                can_install: false,
            })
            bootstrapPython = await provisionManagedSemanticPythonRuntime(true)
            installResult = await installSemanticRuntimeWithBootstrap(bootstrapPython)
        }

        if (!installResult.ok) {
            const nextState: SemanticMemoryInstallState = {
                ...semanticMemoryInstallState,
                supported: true,
                installed: false,
                python_available: true,
                python_compatible: false,
                runtime_source: bootstrapPython.source,
                python_version: bootstrapPython.version,
                python_path: bootstrapPython.pythonPath,
                sqlite_module: semanticMemoryInstallState.sqlite_module,
                sqlite_version: semanticMemoryInstallState.sqlite_version,
                vec_version: semanticMemoryInstallState.vec_version,
                error_code: installResult.errorCode ?? 'runtime_corrupt',
                log_path: path.join(getSemanticMemoryRuntimeRoot(), 'runtime.log'),
                runtime_path: getSemanticMemoryRuntimeRoot(),
                phase: 'error',
                label: 'Install failed',
                detail: installResult.detail,
                progress: null,
                logs: readSemanticMemoryLogTail(),
                can_install: true,
            }
            setSemanticMemoryInstallState(nextState)
            writeSemanticMemoryState({
                installed: false,
                ready: false,
                runtime_source: bootstrapPython.source,
                python_path: bootstrapPython.pythonPath,
                python_version: bootstrapPython.version,
                error_code: nextState.error_code,
                detail: nextState.detail,
            })
            return nextState
        }

        const nextState: SemanticMemoryInstallState = {
            ...semanticMemoryInstallState,
            supported: true,
            installed: true,
            python_available: true,
            python_compatible: true,
            runtime_source: bootstrapPython.source,
            python_version: installResult.payload.python_version,
            python_path: bootstrapPython.pythonPath,
            sqlite_module: installResult.payload.sqlite_module,
            sqlite_version: installResult.payload.sqlite_version,
            vec_version: installResult.payload.vec_version,
            error_code: null,
            log_path: path.join(getSemanticMemoryRuntimeRoot(), 'runtime.log'),
            runtime_path: getSemanticMemoryRuntimeRoot(),
            phase: 'ready',
            label: 'Ready',
            detail: 'Semantic retrieval is installed and ready for local memory ranking.',
            progress: 100,
            logs: readSemanticMemoryLogTail(),
            can_install: false,
        }
        setSemanticMemoryInstallState(nextState)
        writeSemanticMemoryState({
            installed: true,
            ready: true,
            runtime_source: bootstrapPython.source,
            python_path: bootstrapPython.pythonPath,
            python_version: installResult.payload.python_version,
            sqlite_module: installResult.payload.sqlite_module,
            sqlite_version: installResult.payload.sqlite_version,
            vec_version: installResult.payload.vec_version,
            selected_model: installResult.payload.model,
            model_ready: Boolean(installResult.payload.model_cached),
            error_code: null,
            detail: nextState.detail,
        })
        return nextState
    } catch (error) {
        if (bootstrapPython?.source && bootstrapPython.source !== 'managed') {
            try {
                appendSemanticMemoryInstallLog('System Python semantic install aborted unexpectedly. Falling back to a managed Python runtime.')
                bootstrapPython = await provisionManagedSemanticPythonRuntime(true)
                const retryResult = await installSemanticRuntimeWithBootstrap(bootstrapPython)
                if (retryResult.ok && retryResult.payload) {
                    const nextState: SemanticMemoryInstallState = {
                        ...semanticMemoryInstallState,
                        supported: true,
                        installed: true,
                        python_available: true,
                        python_compatible: true,
                        runtime_source: bootstrapPython.source,
                        python_version: retryResult.payload.python_version,
                        python_path: bootstrapPython.pythonPath,
                        sqlite_module: retryResult.payload.sqlite_module,
                        sqlite_version: retryResult.payload.sqlite_version,
                        vec_version: retryResult.payload.vec_version,
                        error_code: null,
                        log_path: path.join(getSemanticMemoryRuntimeRoot(), 'runtime.log'),
                        runtime_path: getSemanticMemoryRuntimeRoot(),
                        phase: 'ready',
                        label: 'Ready',
                        detail: 'Semantic retrieval is installed and ready for local memory ranking.',
                        progress: 100,
                        logs: readSemanticMemoryLogTail(),
                        can_install: false,
                    }
                    setSemanticMemoryInstallState(nextState)
                    writeSemanticMemoryState({
                        installed: true,
                        ready: true,
                        runtime_source: bootstrapPython.source,
                        python_path: bootstrapPython.pythonPath,
                        python_version: retryResult.payload.python_version,
                        sqlite_module: retryResult.payload.sqlite_module,
                        sqlite_version: retryResult.payload.sqlite_version,
                        vec_version: retryResult.payload.vec_version,
                        selected_model: retryResult.payload.model,
                        model_ready: Boolean(retryResult.payload.model_cached),
                        error_code: null,
                        detail: nextState.detail,
                    })
                    return nextState
                }
            } catch {
                // Fall through to the generic error state below.
            }
        }

        const detail = normalizeSemanticMemoryInstallError(error instanceof Error ? error.message : String(error), bootstrapPython?.version ?? null)
        const nextState: SemanticMemoryInstallState = {
            ...semanticMemoryInstallState,
            supported: true,
            installed: false,
            python_available: Boolean(bootstrapPython),
            python_compatible: Boolean(bootstrapPython?.compatible),
            runtime_source: bootstrapPython?.source ?? 'none',
            python_version: bootstrapPython?.version ?? null,
            python_path: bootstrapPython?.pythonPath ?? null,
            sqlite_module: semanticMemoryInstallState.sqlite_module,
            sqlite_version: semanticMemoryInstallState.sqlite_version,
            vec_version: semanticMemoryInstallState.vec_version,
            error_code: 'runtime_corrupt',
            log_path: path.join(getSemanticMemoryRuntimeRoot(), 'runtime.log'),
            runtime_path: getSemanticMemoryRuntimeRoot(),
            phase: 'error',
            label: 'Install failed',
            detail,
            progress: null,
            logs: readSemanticMemoryLogTail(),
            can_install: true,
        }
        setSemanticMemoryInstallState(nextState)
        writeSemanticMemoryState({
            installed: false,
            ready: false,
            runtime_source: nextState.runtime_source,
            python_path: nextState.python_path,
            python_version: nextState.python_version,
            error_code: nextState.error_code,
            detail: nextState.detail,
        })
        return nextState
    }
}

function openPrivacySettingsPane(pane: keyof typeof PRIVACY_SETTINGS_URLS) {
    if (process.platform !== 'darwin') return

    void shell.openExternal(PRIVACY_SETTINGS_URLS[pane]).catch(() => {
        void shell.openPath('/System/Applications/System Settings.app')
    })
}

function shouldAutoOpenPreferencesOnLaunch() {
    return app.isPackaged && !appState.onboardingCompleted && !appState.onboardingDismissed
}

function buildSettingsWindow() {
    const nextWin = new BrowserWindow({
        ...(process.platform === 'darwin'
            ? {}
            : { icon: path.join(process.env.VITE_PUBLIC as string, BRAND_MARK_FILE_NAME) }),
        width: 1080,
        height: 760,
        minWidth: 940,
        minHeight: 680,
        title: MAIN_WINDOW_TITLE,
        acceptFirstMouse: true,
        transparent: process.platform === 'darwin' ? false : true,
        frame: process.platform === 'darwin',
        titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
        vibrancy: process.platform === 'darwin' ? 'sidebar' : undefined,
        visualEffectState: process.platform === 'darwin' ? 'active' : undefined,
        skipTaskbar: isPackagedTrayOnlyMac(),
        backgroundColor: '#0b1117',
        show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.mjs'),
            nodeIntegration: false,
            contextIsolation: true,
            backgroundThrottling: false,
        },
    })

    attachRendererDiagnostics(nextWin, `${DISPLAY_NAME} window`)
    loadRendererRoute(nextWin, '/')

    nextWin.webContents.on('before-input-event', (event, input) => {
        if (input.type === 'keyDown' && input.meta && input.key === ',') {
            event.preventDefault()
            showPreferencesWindow('/settings')
        }
    })

    nextWin.on('close', (event) => {
        if (isAppQuitting) return
        event.preventDefault()
        nextWin.hide()
    })

    nextWin.on('closed', () => {
        if (settingsWin === nextWin) {
            settingsWin = null
        }
    })

    return nextWin
}

function buildCaptureWindow() {
    const nextWin = new BrowserWindow({
        show: false,
        width: 320,
        height: 240,
        transparent: true,
        frame: false,
        backgroundColor: '#00000000',
        webPreferences: {
            preload: path.join(__dirname, 'preload.mjs'),
            nodeIntegration: false,
            contextIsolation: true,
            backgroundThrottling: false,
        },
    })

    attachRendererDiagnostics(nextWin, 'Capture window')
    loadRendererRoute(nextWin, '/capture')

    nextWin.webContents.on('did-finish-load', () => {
        resolveCaptureHostReady()
    })

    nextWin.on('closed', () => {
        if (captureWin === nextWin) {
            captureWin = null
            captureHostReady = false
        }
    })

    return nextWin
}

function buildInboxWindow() {
    const nextWin = new BrowserWindow({
        ...(process.platform === 'darwin'
            ? {}
            : { icon: path.join(process.env.VITE_PUBLIC as string, BRAND_MARK_FILE_NAME) }),
        width: 980,
        height: 680,
        minWidth: 860,
        minHeight: 560,
        show: false,
        frame: process.platform === 'darwin',
        resizable: true,
        minimizable: true,
        maximizable: false,
        fullscreenable: false,
        movable: true,
        alwaysOnTop: false,
        skipTaskbar: true,
        acceptFirstMouse: true,
        transparent: process.platform === 'darwin' ? false : true,
        title: 'Notes',
        titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
        vibrancy: process.platform === 'darwin' ? 'sidebar' : undefined,
        visualEffectState: process.platform === 'darwin' ? 'active' : undefined,
        backgroundColor: '#15181d',
        webPreferences: {
            preload: path.join(__dirname, 'preload.mjs'),
            nodeIntegration: false,
            contextIsolation: true,
            backgroundThrottling: false,
        },
    })

    attachRendererDiagnostics(nextWin, 'Notes window')
    loadRendererRoute(nextWin, '/inbox')

    nextWin.on('close', (event) => {
        if (isAppQuitting) return
        event.preventDefault()
        nextWin.hide()
        broadcastInboxWindowState()
    })

    nextWin.webContents.on('before-input-event', (event, input) => {
        if (input.type === 'keyDown' && input.key === 'Escape') {
            event.preventDefault()
            requestInboxClose()
        }
    })

    nextWin.on('closed', () => {
        if (inboxWin === nextWin) {
            inboxWin = null
            broadcastInboxWindowState()
        }
    })

    return nextWin
}

function buildAboutWindow() {
    const nextWin = new BrowserWindow({
        ...(process.platform === 'darwin'
            ? {}
            : { icon: path.join(process.env.VITE_PUBLIC as string, BRAND_MARK_FILE_NAME) }),
        width: 360,
        height: 328,
        minWidth: 360,
        minHeight: 328,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        show: false,
        title: ABOUT_WINDOW_TITLE,
        acceptFirstMouse: true,
        transparent: process.platform === 'darwin' ? false : true,
        frame: process.platform === 'darwin',
        titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
        vibrancy: process.platform === 'darwin' ? 'sidebar' : undefined,
        visualEffectState: process.platform === 'darwin' ? 'active' : undefined,
        skipTaskbar: isPackagedTrayOnlyMac(),
        backgroundColor: '#0d1015',
        webPreferences: {
            preload: path.join(__dirname, 'preload.mjs'),
            nodeIntegration: false,
            contextIsolation: true,
        },
    })

    attachRendererDiagnostics(nextWin, 'About window')
    loadRendererRoute(nextWin, '/about')

    nextWin.on('close', (event) => {
        if (isAppQuitting) return
        event.preventDefault()
        nextWin.hide()
    })

    nextWin.on('closed', () => {
        if (aboutWin === nextWin) {
            aboutWin = null
        }
    })

    return nextWin
}

function positionSettingsWindow() {
    if (!isWindowAlive(settingsWin)) return

    const settingsBounds = settingsWin.getBounds()
    const widgetWindow = isWindowAlive(widgetWin) && widgetWin.isVisible() ? widgetWin : null
    const targetDisplay = widgetWindow
        ? screen.getDisplayMatching(widgetWindow.getBounds())
        : tray
            ? screen.getDisplayMatching(tray.getBounds())
            : screen.getPrimaryDisplay()
    const workArea = targetDisplay.workArea

    let x = workArea.x + Math.round((workArea.width - settingsBounds.width) / 2)
    let y = workArea.y + Math.round((workArea.height - settingsBounds.height) / 2)

    const widgetBounds = widgetWindow
        ? widgetWindow.getBounds()
        : {
            x: Math.round(targetDisplay.bounds.x + ((targetDisplay.bounds.width - WIDGET_WIDTH) / 2)),
            y: Math.round(workArea.y + WIDGET_TOP_OFFSET),
            width: WIDGET_WIDTH,
            height: WIDGET_COLLAPSED_HEIGHT,
        }
    const desiredX = widgetBounds.x + Math.round((widgetBounds.width - settingsBounds.width) / 2)
    const desiredY = widgetBounds.y + widgetBounds.height + 16
    const maxY = workArea.y + workArea.height - settingsBounds.height - 16

    x = desiredX
    if (desiredY <= maxY) {
        y = desiredY
    } else {
        if (widgetWindow) {
            requestWidgetClose('idle', true)
        }
        y = Math.max(workArea.y + 16, maxY)
    }

    x = Math.max(workArea.x + 16, Math.min(x, workArea.x + workArea.width - settingsBounds.width - 16))
    y = Math.max(workArea.y + 16, Math.min(y, workArea.y + workArea.height - settingsBounds.height - 16))

    settingsWin.setPosition(Math.round(x), Math.round(y), false)
}

function showPreferencesWindow(route = '/settings') {
    if (!settingsWin || settingsWin.isDestroyed()) {
        settingsWin = buildSettingsWindow()
    }

    if (!windowHasExpectedRoute(settingsWin, route)) {
        loadRendererRoute(settingsWin, route)
    }
    positionSettingsWindow()
    settingsWin.show()
    settingsWin.focus()
}

function showHomeWindow() {
    showPreferencesWindow('/')
}

function showMainWindow(route = '/') {
    showPreferencesWindow(route)
}

function showRouteNotification(title: string, body: string, route?: string) {
    if (!Notification.isSupported()) {
        return
    }

    const notification = new Notification(buildNotificationOptions(title, body))

    if (route) {
        notification.on('click', () => {
            showMainWindow(route)
        })
    }

    notification.show()
}

function showAboutWindow() {
    if (!aboutWin || aboutWin.isDestroyed()) {
        aboutWin = buildAboutWindow()
    }
    aboutWin.center()
    aboutWin.show()
    aboutWin.focus()
}

async function getBackendConfig() {
    return backendLifecycle.getConfig()
}

async function getBackendStatus() {
    return backendLifecycle.getStatus()
}

async function getCachedBackendConfig() {
    return backendLifecycle.getCachedConfig()
}

async function ensureBackendReadyForInteraction() {
    return backendLifecycle.ensureReadyForInteraction()
}

function nowIso() {
    return new Date().toISOString()
}

function buildLocalLiveTranscriptionState(
    session: RecordingCaptureSession,
    state: LocalLiveTranscriptionState['state'],
    text: string,
    isFinal: boolean,
    error: string | null = null,
): LocalLiveTranscriptionState {
    return {
        session_id: session.liveSessionId,
        mode: session.mode,
        state,
        text,
        source: 'native_local',
        is_final: isFinal,
        updated_at: nowIso(),
        error,
    }
}

async function abortLocalPreviewSession(sessionId: string, reason: string) {
    const currentSession = activeCaptureSession?.kind === 'recording' && activeCaptureSession.liveSessionId === sessionId
        ? activeCaptureSession
        : null

    try {
        await nativeSpeechHelper.cancelSession(sessionId)
    } catch (error) {
        logToFile(`Local live preview cancel failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
    }

    clearLocalLiveTranscriptionState(sessionId)

    if (!currentSession) {
        resetRecordingCaptureState(reason)
        return
    }

    activeCaptureSession = null
    try {
        await requestCaptureHost('stop-recording')
    } catch (error) {
        logToFile(`Capture host stop after local live preview failure failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
    }

    setCaptureState({
        is_recording: false,
        is_testing: false,
        mode: null,
        phase: 'idle',
        amplitude: 0,
        error: reason,
        active_device_id: null,
        active_device_label: null,
        fallback_notice: null,
        fallback_to_default: false,
    })
}

function handleNativeSpeechHelperEvent(event: NativeSpeechEvent) {
    if (event.event === 'permission' && event.status !== 'authorized') {
        const detail = event.detail || 'Speech recognition permission is required for the live transcript preview.'
        const currentSession = activeCaptureSession?.kind === 'recording' ? activeCaptureSession : null
        if (currentSession) {
            setLocalLiveTranscriptionState(buildLocalLiveTranscriptionState(
                currentSession,
                'error',
                '',
                false,
                detail,
            ))
        }
        return
    }

    if (event.event === 'error') {
        const message = event.error || 'The live transcript preview failed.'
        const currentSession = activeCaptureSession?.kind === 'recording'
            && activeCaptureSession.liveSessionId === event.sessionId
            ? activeCaptureSession
            : null
        if (currentSession) {
            setLocalLiveTranscriptionState(buildLocalLiveTranscriptionState(
                currentSession,
                'error',
                formatStablePreviewText(localLivePreviewState || { committedText: '', provisionalText: '' }),
                false,
                message,
            ))
        }
        void abortLocalPreviewSession(event.sessionId || '', message)
        return
    }

    if (!event.sessionId) {
        return
    }

    const currentSession = activeCaptureSession?.kind === 'recording'
        && activeCaptureSession.liveSessionId === event.sessionId
        ? activeCaptureSession
        : null

    if (event.event === 'started') {
        if (currentSession) {
            setLocalLiveTranscriptionState(buildLocalLiveTranscriptionState(currentSession, 'starting', '', false))
        }
        return
    }

    if (event.event === 'stopped') {
        const state = localLiveTranscriptionState
        if (state?.session_id === event.sessionId) {
            setLocalLiveTranscriptionState({
                ...state,
                state: state.error ? 'error' : 'done',
                updated_at: nowIso(),
            })
        }
        return
    }

    if (event.event !== 'partial' && event.event !== 'final') {
        return
    }

    localLivePreviewState = applyStablePreviewText(
        localLivePreviewState || { committedText: '', provisionalText: '' },
        event.text,
    )
    const text = formatStablePreviewText(localLivePreviewState)
    const matchingSession = currentSession
    if (matchingSession && !matchingSession.captureTimeline.first_partial && text) {
        matchingSession.captureTimeline.first_partial = nowIso()
    }

    if (!matchingSession) {
        const currentState = localLiveTranscriptionState
        if (currentState?.session_id === event.sessionId) {
            setLocalLiveTranscriptionState({
                ...currentState,
                text,
                state: event.event === 'final' ? 'done' : 'streaming',
                is_final: event.event === 'final',
                updated_at: nowIso(),
                error: null,
            })
        }
        return
    }

    setLocalLiveTranscriptionState(buildLocalLiveTranscriptionState(
        matchingSession,
        event.event === 'final' ? 'done' : 'streaming',
        text,
        event.event === 'final',
        null,
    ))
}

async function startNativeLocalPreviewSession(session: RecordingCaptureSession) {
    localLivePreviewState = { committedText: '', provisionalText: '' }
    setLocalLiveTranscriptionState(buildLocalLiveTranscriptionState(session, 'starting', '', false))
    try {
        await nativeSpeechHelper.startSession(session.liveSessionId, session.mode)
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setLocalLiveTranscriptionState(buildLocalLiveTranscriptionState(session, 'error', '', false, message))
        await abortLocalPreviewSession(session.liveSessionId, message)
    }
}

async function startLiveTranscriptionSession(session: RecordingCaptureSession) {
    if (session.liveStrategy === 'native_local') {
        await startNativeLocalPreviewSession(session)
        return
    }
    if (session.liveStrategy !== 'backend_provider') {
        return
    }
    try {
        const response = await backendClient.request('/live_transcription/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                session_id: session.liveSessionId,
                mode: session.mode,
            }),
        })
        if (!response.ok) {
            throw new Error(`Live transcription start failed (${response.status}).`)
        }
    } catch (error) {
        logToFile(`Live transcription start failed for ${session.liveSessionId}: ${error instanceof Error ? error.message : String(error)}`)
    }
}

function clearLiveTranscriptionFlushTimer(session: RecordingCaptureSession) {
    if (session.liveFlushTimer) {
        clearTimeout(session.liveFlushTimer)
        session.liveFlushTimer = null
    }
}

async function flushLiveTranscriptionBuffer(session: RecordingCaptureSession) {
    clearLiveTranscriptionFlushTimer(session)
    if (session.liveStrategy !== 'backend_provider') {
        session.liveChunkBuffer = []
        session.liveChunkBytes = 0
        return
    }
    if (!session.liveChunkBytes) {
        return
    }

    const payloadBuffer = Buffer.concat(session.liveChunkBuffer, session.liveChunkBytes)
    session.liveChunkBuffer = []
    session.liveChunkBytes = 0

    try {
        const response = await backendClient.request('/live_transcription/chunk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                session_id: session.liveSessionId,
                sample_rate: 16000,
                pcm_s16le_base64: payloadBuffer.toString('base64'),
            }),
        })
        if (!response.ok) {
            throw new Error(`Live transcription chunk failed (${response.status}).`)
        }
    } catch (error) {
        logToFile(`Live transcription chunk failed for ${session.liveSessionId}: ${error instanceof Error ? error.message : String(error)}`)
    }
}

function scheduleLiveTranscriptionFlush(session: RecordingCaptureSession) {
    if (session.liveStrategy !== 'backend_provider') {
        return
    }
    if (session.liveFlushTimer) {
        return
    }
    session.liveFlushTimer = setTimeout(() => {
        session.liveFlushTimer = null
        void flushLiveTranscriptionBuffer(session)
    }, LIVE_TRANSCRIPTION_FLUSH_MS)
}

async function finishLiveTranscriptionSession(session: RecordingCaptureSession) {
    if (session.liveStrategy === 'native_local') {
        try {
            await nativeSpeechHelper.stopSession(session.liveSessionId)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            logToFile(`Local live preview stop failed for ${session.liveSessionId}: ${message}`)
            return {
                transcript: localLiveTranscriptionState?.session_id === session.liveSessionId
                    ? localLiveTranscriptionState.text || null
                    : null,
                source: 'native_local' as const,
                first_partial_at: session.captureTimeline.first_partial,
                error: message,
            }
        }
        const result = {
            transcript: localLiveTranscriptionState?.session_id === session.liveSessionId
                ? localLiveTranscriptionState.text || null
                : null,
            source: 'native_local' as const,
            first_partial_at: session.captureTimeline.first_partial,
            error: localLiveTranscriptionState?.session_id === session.liveSessionId
                ? localLiveTranscriptionState.error
                : null,
        }
        clearLocalLiveTranscriptionState(session.liveSessionId)
        return result
    }
    if (session.liveStrategy !== 'backend_provider') {
        return null
    }
    await flushLiveTranscriptionBuffer(session)
    try {
        const response = await backendClient.request('/live_transcription/finish', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                session_id: session.liveSessionId,
            }),
        })
        if (!response.ok) {
            throw new Error(`Live transcription finish failed (${response.status}).`)
        }
        const payload = await response.json() as {
            status: string
            transcript?: string | null
            source?: string | null
            first_partial_at?: string | null
            error?: string | null
        }
        const source: LiveTranscriptionResult['source'] = payload.source === 'provider' ? 'provider' : null
        return {
            transcript: payload.transcript ?? null,
            source,
            first_partial_at: payload.first_partial_at ?? null,
            error: payload.error ?? null,
        }
    } catch (error) {
        logToFile(`Live transcription finish failed for ${session.liveSessionId}: ${error instanceof Error ? error.message : String(error)}`)
        return null
    }
}

async function ensureCaptureHostReady() {
    if (!isWindowAlive(captureWin)) {
        captureHostReady = false
        captureWin = buildCaptureWindow()
    }
    if (captureHostReady) return
    if (!isWindowAlive(captureWin)) {
        throw new Error('The Electron capture host is unavailable.')
    }

    await new Promise<void>((resolve) => {
        captureReadyResolvers.push(resolve)
    })
}

function resolveCaptureHostReady() {
    captureHostReady = true
    const resolvers = captureReadyResolvers
    captureReadyResolvers = []
    resolvers.forEach((resolve) => resolve())
}

type PendingPasteStatusPayload = {
    pending_paste?: {
        id?: string | null
    } | null
}

async function resolveBackendPendingPasteState(pasteId: string) {
    const payload = await backendClient.getJson<PendingPasteStatusPayload>('/status')
    return payload.pending_paste?.id === pasteId ? 'same' : 'stale'
}

async function acknowledgePendingPasteDelivery(pasteId: string, result: 'pasted' | 'copied') {
    try {
        const response = await backendClient.request('/status/paste/ack', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: pasteId, result }),
        })

        if (response.ok) {
            return 'acknowledged' as const
        }

        if (response.status === 409) {
            logToFile(`[PasteDelivery] Ack mismatch paste_id=${pasteId} result=${result}`)
            return 'stale' as const
        }

        const detail = await response.text()
        throw new Error(detail || `Paste acknowledgement failed with ${response.status}.`)
    } catch (error) {
        const state = await resolveBackendPendingPasteState(pasteId).catch(() => 'unknown' as const)
        if (state === 'stale') {
            logToFile(`[PasteDelivery] Ack state already cleared paste_id=${pasteId} result=${result}`)
            return 'stale' as const
        }
        throw error
    }
}

async function performPasteTextDelivery(payload: { id: string | null; text: string; restoreClipboard: boolean }): Promise<PasteResult> {
    const text = payload.text || ''
    const restoreClipboard = payload.restoreClipboard !== false
    if (!text.trim()) {
        return {
            status: 'failed',
            detail: 'No text was available to paste.',
        }
    }

    logToFile(`[PasteDelivery] Native paste start paste_id=${payload.id ?? 'none'} chars=${text.length}`)

    hideTransientWindows('idle', true)
    await new Promise((resolve) => setTimeout(resolve, 80))
    return pasteFinalText(text, {
        readClipboardText: () => clipboard.readText() || '',
        writeClipboardText: (nextText) => clipboard.writeText(nextText),
        wait: sleep,
        log: (message) => logToFile(`[PasteDelivery] ${message}`),
        restoreClipboard,
        fallbackDetail: process.platform !== 'darwin'
            ? 'Copied output to the clipboard because direct paste is unavailable on this platform.'
            : DIRECT_PASTE_FALLBACK_DETAIL,
        supportsDirectPaste: process.platform === 'darwin',
        triggerSystemPasteShortcut: async () => {
            logToFile(`[PasteDelivery] OS paste injection paste_id=${payload.id ?? 'none'}`)
            await triggerSystemShortcut('v')
            logToFile(`[PasteDelivery] OS paste injection succeeded paste_id=${payload.id ?? 'none'}`)
        },
    })
}

async function requestCaptureHost<T>(command: string, payload?: unknown): Promise<T> {
    if (!isWindowAlive(captureWin)) {
        throw new Error('The Electron capture host is unavailable.')
    }

    await ensureCaptureHostReady()
    if (!isWindowAlive(captureWin)) {
        throw new Error('The Electron capture host became unavailable.')
    }
    const liveCaptureWin = captureWin

    return new Promise<T>((resolve, reject) => {
        const requestId = randomUUID()
        const timer = setTimeout(() => {
            pendingCaptureRequests.delete(requestId)
            reject(new Error(`Timed out waiting for capture host command "${command}".`))
        }, 20000)

        pendingCaptureRequests.set(requestId, {
            resolve: (value) => resolve(value as T),
            reject,
            timer,
        })
        const sent = sendWindowMessage(liveCaptureWin, 'capture-command', {
            requestId,
            command,
            payload,
        })
        if (!sent) {
            pendingCaptureRequests.delete(requestId)
            clearTimeout(timer)
            reject(new Error(`The capture host renderer is unavailable for command "${command}".`))
        }
    })
}

async function getSelectedCaptureAudioConfig() {
    if (cachedCaptureAudioConfig && (Date.now() - cachedCaptureAudioConfig.cachedAt) < 15000) {
        return cachedCaptureAudioConfig.value
    }
    const config = await getCachedBackendConfig()
    cachedCaptureAudioConfig = {
        value: config.audio,
        cachedAt: Date.now(),
    }
    return config.audio
}

async function ensureCapturePermission() {
    const currentStatus = readCapturePermissionStatus()

    if (currentStatus === 'granted') return 'granted'
    if (currentStatus === 'denied' || currentStatus === 'restricted') return currentStatus

    if (process.platform === 'darwin') {
        const granted = await systemPreferences.askForMediaAccess('microphone')
        return granted ? 'granted' : systemPreferences.getMediaAccessStatus('microphone')
    }

    return 'granted'
}

function readCapturePermissionStatus() {
    if (process.platform === 'darwin') {
        return systemPreferences.getMediaAccessStatus('microphone')
    }
    return 'granted'
}

function clearWidgetHideFallback() {
    if (widgetHideFallbackTimer) {
        clearTimeout(widgetHideFallbackTimer)
        widgetHideFallbackTimer = null
    }
}

function sendWidgetPresentation(command: WidgetPresentationCommand) {
    sendWindowMessage(widgetWin, 'widget-presentation', command)
}

function broadcastInboxWindowState() {
    const payload = { open: isWindowAlive(inboxWin) ? inboxWin.isVisible() : false }
    broadcastWindowMessage('inbox-window-state', payload)
}

function broadcastInboxChanged() {
    const payload = { changedAt: Date.now() }
    broadcastWindowMessage('inbox-changed', payload)
}

function registerGlobalShortcutOrWarn(accelerator: string, label: string, handler: () => void) {
    const registered = globalShortcut.register(accelerator, handler)
    if (!registered) {
        logToFile(`Global shortcut registration failed for ${accelerator} (${label}). Another app or macOS is likely already using it.`)
        return
    }
    logToFile(`Global shortcut registered: ${accelerator} (${label})`)
}

function positionWidgetAtTopCenter() {
    if (!isWindowAlive(widgetWin)) return

    const targetDisplay = tray
        ? screen.getDisplayMatching(tray.getBounds())
        : screen.getPrimaryDisplay()

    const winBounds = widgetWin.getBounds()
    const x = Math.round(targetDisplay.bounds.x + ((targetDisplay.bounds.width - winBounds.width) / 2))
    const safeAreaTop = targetDisplay.workArea.y
    const y = Math.round(safeAreaTop + WIDGET_TOP_OFFSET)

    widgetWin.setPosition(x, y, false)
}

function requestWidgetOpen(source: WidgetPresentationSource) {
    if (!isWindowAlive(widgetWin)) {
        widgetWin = buildWidgetWindow()
    }
    if (!isWindowAlive(widgetWin)) return

    setWidgetModeMenuOpen(false)
    setWidgetPreviewExpanded(false)
    setWidgetLiveTranscriptExpanded(false)
    clearWidgetHideFallback()
    positionWidgetAtTopCenter()

    if (!widgetWin.isVisible()) {
        widgetWin.showInactive()
    }

    sendWidgetPresentation({ visible: true, source })
    if (isWindowAlive(inboxWin) && inboxWin.isVisible()) {
        positionInboxWindow()
    }
}

function requestWidgetClose(source: WidgetPresentationSource, immediate = false) {
    if (!isWindowAlive(widgetWin) || !widgetWin.isVisible()) return

    setWidgetModeMenuOpen(false)
    setWidgetPreviewExpanded(false)
    setWidgetLiveTranscriptExpanded(false)
    requestInboxClose()
    clearWidgetHideFallback()
    sendWidgetPresentation({ visible: false, source })

    if (immediate) {
        widgetWin.hide()
        return
    }

    widgetHideFallbackTimer = setTimeout(() => {
        widgetHideFallbackTimer = null
        if (isWindowAlive(widgetWin)) {
            widgetWin.hide()
        }
    }, WIDGET_HIDE_FALLBACK_MS)
}

function hideTransientWindows(reason: WidgetPresentationSource = 'idle', immediate = false) {
    setWidgetModeMenuOpen(false)
    setWidgetPreviewExpanded(false)
    setWidgetLiveTranscriptExpanded(false)
    requestInboxClose()
    requestWidgetClose(reason, immediate)
}

function toggleWidget() {
    if (!isWindowAlive(widgetWin)) {
        widgetWin = buildWidgetWindow()
    }
    if (!isWindowAlive(widgetWin)) return
    if (widgetWin.isVisible()) {
        requestWidgetClose('tray')
    } else {
        requestWidgetOpen('tray')
    }
}

function positionInboxWindow() {
    if (!isWindowAlive(inboxWin)) return

    const targetDisplay = isWindowAlive(widgetWin)
        ? screen.getDisplayMatching(widgetWin.getBounds())
        : screen.getPrimaryDisplay()
    const inboxBounds = inboxWin.getBounds()
    const workArea = targetDisplay.workArea

    let x = workArea.x + Math.round((workArea.width - inboxBounds.width) / 2)
    let y = workArea.y + Math.round((workArea.height - inboxBounds.height) / 2)

    x = Math.max(workArea.x + 16, Math.min(x, workArea.x + workArea.width - inboxBounds.width - 16))
    y = Math.max(workArea.y + 16, Math.min(y, workArea.y + workArea.height - inboxBounds.height - 16))

    inboxWin.setPosition(Math.round(x), Math.round(y), false)
}

function requestInboxOpen() {
    if (!isWindowAlive(inboxWin)) {
        inboxWin = buildInboxWindow()
    }
    if (!isWindowAlive(inboxWin)) return
    positionInboxWindow()
    if (!inboxWin.isVisible()) {
        inboxWin.show()
    }
    inboxWin.focus()
    broadcastInboxWindowState()
}

function requestInboxClose() {
    if (isWindowAlive(inboxWin) && inboxWin.isVisible()) {
        inboxWin.hide()
    }
    broadcastInboxWindowState()
}

function toggleInboxWindow() {
    if (isWindowAlive(inboxWin) && inboxWin.isVisible()) {
        requestInboxClose()
    } else {
        requestInboxOpen()
    }
    return { open: isWindowAlive(inboxWin) ? inboxWin.isVisible() : false }
}

function buildWidgetWindow() {
    const nextWin = new BrowserWindow({
        width: WIDGET_WIDTH,
        height: WIDGET_COLLAPSED_HEIGHT,
        transparent: true,
        backgroundColor: '#00000000',
        frame: false,
        alwaysOnTop: true,
        hasShadow: false,
        resizable: false,
        acceptFirstMouse: true,
        focusable: false,
        type: 'panel',
        show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.mjs'),
            nodeIntegration: false,
            contextIsolation: true,
        },
    })

    attachRendererDiagnostics(nextWin, 'Widget window')
    loadRendererRoute(nextWin, '/widget')

    nextWin.on('closed', () => {
        if (widgetWin === nextWin) {
            widgetWin = null
        }
    })

    return nextWin
}

function applyWidgetExpansionState() {
    if (!isWindowAlive(widgetWin)) return

    const nextHeight = widgetExpansionReasons.has('actionReview')
        ? WIDGET_ACTION_REVIEW_HEIGHT
        : widgetExpansionReasons.has('modeMenu')
            ? WIDGET_EXPANDED_HEIGHT
            : widgetExpansionReasons.has('liveTranscript')
            ? WIDGET_LIVE_TRANSCRIPT_HEIGHT
            : widgetExpansionReasons.has('smartPreview')
            ? WIDGET_STREAMING_HEIGHT
            : WIDGET_COLLAPSED_HEIGHT

    const currentBounds = widgetWin.getBounds()
    if (currentBounds.width === WIDGET_WIDTH && currentBounds.height === nextHeight) {
        return
    }

    widgetWin.setBounds({
        x: currentBounds.x,
        y: currentBounds.y,
        width: WIDGET_WIDTH,
        height: nextHeight,
    }, false)
    positionWidgetAtTopCenter()
}

function setWidgetModeMenuOpen(open: boolean) {
    if (open) {
        widgetExpansionReasons.add('modeMenu')
    } else {
        widgetExpansionReasons.delete('modeMenu')
    }
    applyWidgetExpansionState()
}

function setWidgetPreviewExpanded(open: boolean) {
    if (open) {
        widgetExpansionReasons.add('smartPreview')
    } else {
        widgetExpansionReasons.delete('smartPreview')
    }
    applyWidgetExpansionState()
}

function setWidgetActionReviewExpanded(open: boolean) {
    if (open) {
        widgetExpansionReasons.add('actionReview')
    } else {
        widgetExpansionReasons.delete('actionReview')
    }
    applyWidgetExpansionState()
}

function setWidgetLiveTranscriptExpanded(open: boolean) {
    if (open) {
        widgetExpansionReasons.add('liveTranscript')
    } else {
        widgetExpansionReasons.delete('liveTranscript')
    }
    applyWidgetExpansionState()
}

function createTray() {
    const iconPath = path.join(process.env.VITE_PUBLIC as string, TRAY_TEMPLATE_FILE_NAME)
    tray = new Tray(iconPath)
    tray.setToolTip(DISPLAY_NAME)

    // On macOS, left click should toggle the widget, right click for quit menu
    tray.on('click', () => toggleWidget())

    // Create right-click context menu
    const contextMenu = Menu.buildFromTemplate([
        { label: `Open ${DISPLAY_NAME}`, click: () => { showHomeWindow() } },
        { label: 'Settings…', click: () => { showPreferencesWindow('/settings') } },
        { label: ABOUT_WINDOW_TITLE, click: () => { showAboutWindow() } },
        { type: 'separator' },
        { label: `Quit ${DISPLAY_NAME}`, click: () => { quitApplication() } }
    ])
    tray.on('right-click', () => {
        tray?.popUpContextMenu(contextMenu)
    })
}

function createApplicationMenu() {
    if (process.platform !== 'darwin') return

    const template = [
        {
            label: DISPLAY_NAME,
            submenu: [
                {
                    label: ABOUT_WINDOW_TITLE,
                    click: () => showAboutWindow(),
                },
                { type: 'separator' as const },
                {
                    label: 'Settings…',
                    accelerator: 'Command+,',
                    click: () => showPreferencesWindow('/settings'),
                },
                { type: 'separator' as const },
                { role: 'services' as const },
                { type: 'separator' as const },
                { role: 'hide' as const },
                { role: 'hideOthers' as const },
                { role: 'unhide' as const },
                { type: 'separator' as const },
                { role: 'quit' as const },
            ],
        },
        { role: 'editMenu' as const },
        { role: 'windowMenu' as const },
    ]

    Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindows() {
    captureHostReady = false
    widgetWin = buildWidgetWindow()
    captureWin = buildCaptureWindow()
    inboxWin = buildInboxWindow()
}

async function startBackend() {
    cachedCaptureAudioConfig = null
    await backendLifecycle.start()
}

async function stopBackend() {
    await backendLifecycle.stop()
}

function registerHotkeys() {
    const triggerBackendMode = async (mode: RecordingMode) => {
        try {
            const now = Date.now()
            const decision = resolveRecordingToggleDecision({
                source: 'hotkey',
                now,
                hotkeyRearmUntil: hotkeyToggleRearmUntil,
                isToggleInProgress: isTogglingRecording,
                captureIsRecording: captureState.is_recording,
                activeCaptureKind: activeCaptureSession?.kind ?? null,
            })

            if (decision.kind === 'ignore') {
                if (decision.reason === 'hotkey_rearm') {
                    logToFile(`Hotkey toggle ignored during rearm window for ${mode}.`)
                } else {
                    logToFile(`Hotkey toggle ignored while another capture transition is in progress for ${mode}.`)
                }
                return
            }

            if (decision.kind === 'reset_stale_capture_state') {
                logToFile(`Hotkey detected stale recording state for ${mode}. Resetting capture state without starting a new session.`)
                resetRecordingCaptureState(null)
                hotkeyToggleRearmUntil = now + HOTKEY_TOGGLE_REARM_MS
                return
            }

            const shouldRevealWidget = !captureState.is_recording && (!activeCaptureSession || activeCaptureSession.kind !== 'recording')
            if (shouldRevealWidget) {
                requestWidgetOpen('hotkey')
            }
            await toggleRecording(mode, 'hotkey')
            hotkeyToggleRearmUntil = Date.now() + HOTKEY_TOGGLE_REARM_MS
            if (isWindowAlive(widgetWin) && !widgetWin.isVisible()) {
                requestWidgetOpen('hotkey')
            }
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err)
            logToFile(`Hotkey fetch failed: ${message}`)
            hotkeyToggleRearmUntil = Date.now() + HOTKEY_TOGGLE_REARM_MS
        }
    }

    registerGlobalShortcutOrWarn('Control+D', 'Dictation', () => {
        logToFile('Hotkey registered: Ctrl+D pressed (Dictation)')
        void triggerBackendMode('dictation')
    })

    registerGlobalShortcutOrWarn('Control+T', 'Smart Transform', () => {
        logToFile('Hotkey registered: Ctrl+T pressed (Smart Transform)')
        void triggerBackendMode('smart_transform')
    })
}

async function startRecording(mode: RecordingMode) {
    const buttonDownAt = nowIso()
    setCaptureState({
        is_recording: false,
        is_testing: false,
        mode,
        phase: 'starting',
        amplitude: 0,
        error: null,
        fallback_notice: null,
        fallback_to_default: false,
    })

    await ensureBackendReadyForInteraction()

    const permissionStatus = await ensureCapturePermission()
    if (permissionStatus !== 'granted') {
        showRouteNotification(
            'Microphone access required',
            'Grant microphone access in Voice settings before recording can start.',
            '/settings',
        )
        throw new Error('Microphone access is required before recording can start.')
    }

    if (pendingRecordingSubmission) {
        throw new Error('The previous recording is still finalizing. Wait for it to finish before starting another one.')
    }

    const [processingStatus, backendConfig] = await Promise.all([
        getBackendStatus(),
        getCachedBackendConfig(),
    ])
    if (processingStatus.is_processing) {
        throw new Error('The local engine is still processing the previous recording.')
    }

    const audioConfig = backendConfig.audio
    const requestedDeviceId = audioConfig.input_device_id || null
    const requestedDeviceLabel = audioConfig.input_device_label || audioConfig.input_device || null
    const liveStrategy = resolveLiveTranscriptionStrategy({
        provider: backendConfig.stt.provider,
        liveTranscriptionMode: backendConfig.audio.live_transcription_mode || 'auto',
    })

    const session: RecordingCaptureSession = {
        kind: 'recording',
        mode,
        context: null,
        contextWarning: null,
        selectionText: null,
        selectionTruncated: false,
        clipboardText: null,
        clipboardTruncated: false,
        screenCapture: null,
        requestedDeviceId,
        requestedDeviceLabel,
        enrichmentPromise: null,
        liveSessionId: randomUUID(),
        liveStrategy,
        liveChunkBuffer: [],
        liveChunkBytes: 0,
        liveFlushTimer: null,
        captureTimeline: {
            button_down: buttonDownAt,
            capture_started: null,
            first_partial: null,
            stop_pressed: null,
        },
    }
    if (mode === 'smart_transform') {
        session.enrichmentPromise = enrichSmartRecordingSession(session)
    }
    activeCaptureSession = session

    let response: { status: string; message?: string }
    try {
        response = await requestCaptureHost<{ status: string; message?: string }>('start-recording', {
            mode,
            deviceId: requestedDeviceId,
            deviceLabel: requestedDeviceLabel,
            liveSessionId: session.liveSessionId,
        })
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        activeCaptureSession = null
        resetRecordingCaptureState(message)
        throw error
    }

    session.captureTimeline.capture_started = nowIso()
    setCaptureState({
        is_recording: true,
        is_testing: false,
        mode,
        phase: 'recording',
        amplitude: 0,
        active_device_id: requestedDeviceId,
        active_device_label: requestedDeviceLabel,
        error: null,
        fallback_notice: null,
        fallback_to_default: false,
    })
    void startLiveTranscriptionSession(session)

    return {
        status: response.status || 'started',
        message: response.message || `Started ${mode} recording`,
    }
}

function buildRecordingProcessPayload(submission: PendingRecordingSubmission) {
    const { session, stopResult, liveTranscriptionResult } = submission
    const streamingTranscript = liveTranscriptionResult?.source === 'provider'
        ? liveTranscriptionResult.transcript
        : null
    const streamingSource = liveTranscriptionResult?.source === 'provider'
        ? liveTranscriptionResult.source
        : null

    return {
        mode: session.mode,
        context: session.context,
        context_warning: session.contextWarning,
        capture_timeline: {
            ...session.captureTimeline,
            record_start: session.captureTimeline.capture_started,
        },
        selection_text: session.selectionText,
        selection_truncated: session.selectionTruncated,
        clipboard_text: session.clipboardText,
        clipboard_truncated: session.clipboardTruncated,
        screen_capture: session.screenCapture,
        audio_base64: stopResult.audio_base64,
        capture_stats: stopResult.capture_stats,
        streaming_transcript: streamingTranscript,
        streaming_source: streamingSource,
        live_transcription_session_id: session.liveSessionId,
    }
}

async function submitPendingRecordingSubmission() {
    if (!pendingRecordingSubmission) {
        return null
    }

    const submission = pendingRecordingSubmission
    let response: Response
    try {
        response = await backendClient.request('/recording/process', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(buildRecordingProcessPayload(submission)),
        })
    } catch (error) {
        markBackendUnavailable()
        throw error
    }

    if (!response.ok) {
        const detail = await response.text()
        throw new Error(detail || `Recording processing failed with ${response.status}`)
    }

    if (pendingRecordingSubmission === submission) {
        pendingRecordingSubmission = null
    }
    return response.json()
}

async function stopRecording() {
    if (!activeCaptureSession || activeCaptureSession.kind !== 'recording') {
        logToFile('Attempted to stop recording without a live session. Resetting stale capture state.');
        resetRecordingCaptureState(null)
        return;
    }

    const session = activeCaptureSession
    activeCaptureSession = null
    session.captureTimeline.stop_pressed = nowIso()
    clearLiveTranscriptionFlushTimer(session)
    setCaptureState({
        is_recording: false,
        is_testing: false,
        mode: session.mode,
        phase: 'stopping',
        amplitude: 0,
        active_device_id: session.requestedDeviceId,
        active_device_label: session.requestedDeviceLabel,
        error: null,
        fallback_notice: null,
        fallback_to_default: false,
    })

    const stopResult = await requestCaptureHost<CaptureStopResult>('stop-recording')
    if (stopResult.status !== 'success' || !stopResult.audio_base64 || !stopResult.capture_stats) {
        const errorMessage = stopResult.error || 'No usable audio was captured.'
        clearLocalLiveTranscriptionState(session.liveSessionId)
        setCaptureState({
            is_recording: false,
            is_testing: false,
            mode: null,
            phase: 'idle',
            amplitude: 0,
            error: errorMessage,
            active_device_id: null,
            active_device_label: null,
            fallback_notice: null,
            fallback_to_default: false,
        })
        throw new Error(errorMessage)
    }

    if (session.enrichmentPromise) {
        await session.enrichmentPromise.catch((error) => {
            const message = error instanceof Error ? error.message : String(error)
            logToFile(`Smart recording enrichment failed after stop: ${message}`)
        })
    }

    const liveTranscriptionResult = await finishLiveTranscriptionSession(session)
    if (liveTranscriptionResult?.first_partial_at) {
        session.captureTimeline.first_partial = liveTranscriptionResult.first_partial_at
    }

    pendingRecordingSubmission = {
        session,
        stopResult: stopResult as SuccessfulCaptureStopResult,
        liveTranscriptionResult,
    }

    setCaptureState({
        is_recording: false,
        is_testing: false,
        mode: null,
        phase: 'idle',
        amplitude: 0,
        active_device_id: null,
        active_device_label: null,
        error: null,
        fallback_notice: null,
        fallback_to_default: false,
    })

    try {
        return await submitPendingRecordingSubmission()
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setCaptureState({
            phase: 'idle',
            error: message,
        })
        throw error
    }
}

async function enrichSmartRecordingSession(session: RecordingCaptureSession) {
    const configResult = await Promise.allSettled([getBackendConfig()]).then((results) => results[0])
    const visionEnabled = configResult.status === 'fulfilled'
        ? configResult.value.vision?.enabled !== false
        : true
    const [contextResult, textSnapshotResult, screenCaptureResult] = await Promise.allSettled([
        captureSmartContext(),
        captureSmartTextSnapshot(),
        visionEnabled ? captureSmartScreenSnapshot() : Promise.resolve(null),
    ])

    if (contextResult.status === 'fulfilled') {
        session.context = contextResult.value.context
        session.contextWarning = contextResult.value.warning
    } else {
        const message = contextResult.reason instanceof Error ? contextResult.reason.message : String(contextResult.reason)
        logToFile(`Smart context capture failed during background enrichment: ${message}`)
    }

    if (textSnapshotResult.status === 'fulfilled') {
        session.selectionText = textSnapshotResult.value.selectionText
        session.selectionTruncated = textSnapshotResult.value.selectionTruncated
        session.clipboardText = textSnapshotResult.value.clipboardText
        session.clipboardTruncated = textSnapshotResult.value.clipboardTruncated
    } else {
        const message = textSnapshotResult.reason instanceof Error ? textSnapshotResult.reason.message : String(textSnapshotResult.reason)
        logToFile(`Smart selection capture failed during background enrichment: ${message}`)
    }

    if (screenCaptureResult.status === 'fulfilled' && visionEnabled) {
        session.screenCapture = screenCaptureResult.value
    } else if (screenCaptureResult.status === 'rejected' && visionEnabled) {
        const message = screenCaptureResult.reason instanceof Error ? screenCaptureResult.reason.message : String(screenCaptureResult.reason)
        logToFile(`Smart screen capture failed during background enrichment: ${message}`)
    }

    logToFile(
        `Smart enrichment ready (selection=${session.selectionText ? session.selectionText.length : 0} chars, clipboard=${session.clipboardText ? session.clipboardText.length : 0} chars, screen=${session.screenCapture ? `${session.screenCapture.width}x${session.screenCapture.height}` : 'none'}).`,
    )
}

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

function truncateSmartText(rawText: string) {
    if (!rawText.trim()) {
        return {
            text: null,
            truncated: false,
        }
    }

    const truncated = rawText.length > SMART_CLIPBOARD_CHAR_LIMIT
    return {
        text: truncated ? rawText.slice(0, SMART_CLIPBOARD_CHAR_LIMIT) : rawText,
        truncated,
    }
}

async function triggerSystemCopyShortcut() {
    await triggerSystemShortcut('c')
}

async function triggerSystemShortcut(key: 'c' | 'v') {
    if (process.platform !== 'darwin') {
        throw new Error(`Native ${key.toUpperCase()} shortcut injection is unavailable on ${process.platform}.`)
    }

    await runAppleScript([
        'tell application "System Events"',
        `keystroke "${key}" using command down`,
        'end tell',
    ])
}

async function captureSmartTextSnapshot(): Promise<SmartTextSnapshot> {
    const clipboardSnapshot = truncateSmartText(clipboard.readText() || '')
    const selectionSnapshot = await captureSelectedText({
        createMarker: () => `${CLIPBOARD_SELECTION_MARKER_PREFIX}_${randomUUID()}__`,
        log: logToFile,
        readClipboardText: () => clipboard.readText() || '',
        triggerSystemCopyShortcut,
        truncateText: truncateSmartText,
        wait: sleep,
        writeClipboardText: (text) => clipboard.writeText(text),
    })

    const snapshot = {
        selectionText: selectionSnapshot.text,
        selectionTruncated: selectionSnapshot.truncated,
        clipboardText: clipboardSnapshot.text,
        clipboardTruncated: clipboardSnapshot.truncated,
    }
    if (snapshot.clipboardText) {
        logToFile(`Clipboard snapshot captured (${snapshot.clipboardText.length} chars${snapshot.clipboardTruncated ? ', truncated' : ''}).`)
    }
    return snapshot
}

function getSmartScreenCaptureSize() {
    const primaryDisplay = screen.getPrimaryDisplay()
    const rawWidth = Math.max(1, Math.round(primaryDisplay.size.width * primaryDisplay.scaleFactor))
    const rawHeight = Math.max(1, Math.round(primaryDisplay.size.height * primaryDisplay.scaleFactor))
    return scaleScreenCaptureSize(rawWidth, rawHeight)
}

async function captureSmartScreenSnapshot(): Promise<ScreenCapturePayload | null> {
    const primaryDisplay = screen.getPrimaryDisplay()
    const targetSize = getSmartScreenCaptureSize()
    const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: targetSize,
        fetchWindowIcons: false,
    })
    const source = sources.find((item) => String(item.display_id || '') === String(primaryDisplay.id)) || sources[0]
    if (!source || source.thumbnail.isEmpty()) {
        return null
    }

    let image = source.thumbnail
    const imageSize = image.getSize()
    const resizedSize = scaleScreenCaptureSize(imageSize.width, imageSize.height)
    if (resizedSize.width !== imageSize.width || resizedSize.height !== imageSize.height) {
        image = image.resize(resizedSize)
    }

    let optimized = chooseOptimizedJpegBuffer((quality) => image.toJPEG(quality))
    let downscalePasses = 0
    while (optimized?.buffer.length && optimized.buffer.length > SMART_SCREEN_CAPTURE_TARGET_BYTES) {
        const currentSize = image.getSize()
        const nextSize = nextScreenCaptureSize(currentSize.width, currentSize.height)
        if (nextSize.width === currentSize.width && nextSize.height === currentSize.height) {
            break
        }
        image = image.resize(nextSize)
        optimized = chooseOptimizedJpegBuffer((quality) => image.toJPEG(quality))
        downscalePasses += 1
    }

    if (!optimized?.buffer.length || optimized.buffer.length > SMART_SCREEN_CAPTURE_TARGET_BYTES) {
        logToFile(
            `Smart screen capture skipped because the encoded image could not be reduced under ${SMART_SCREEN_CAPTURE_TARGET_BYTES} bytes.`,
        )
        return null
    }

    const finalSize = image.getSize()
    logToFile(
        `Smart screen capture prepared (${finalSize.width}x${finalSize.height}, jpeg_quality=${optimized.quality}, bytes=${optimized.buffer.length}, downscale_passes=${downscalePasses}).`,
    )
    return {
        mime_type: 'image/jpeg',
        image_base64: optimized.buffer.toString('base64'),
        width: finalSize.width,
        height: finalSize.height,
    }
}

async function toggleRecording(mode: RecordingMode, source: 'hotkey' | 'ui' = 'ui') {
    if (activeCaptureSession?.kind === 'mic_test') {
        throw new Error('Finish the microphone check before starting dictation.')
    }

    const decision = resolveRecordingToggleDecision({
        source,
        now: Date.now(),
        hotkeyRearmUntil: hotkeyToggleRearmUntil,
        isToggleInProgress: isTogglingRecording,
        captureIsRecording: captureState.is_recording,
        activeCaptureKind: activeCaptureSession?.kind ?? null,
    })

    if (decision.kind === 'ignore') {
        logToFile(`Capture toggle ignored (${decision.reason}).`)
        return
    }

    if (decision.kind === 'reset_stale_capture_state') {
        logToFile('Capture state reported an active recording without a live session. Resetting stale state before continuing.')
        resetRecordingCaptureState(null)
        return
    }

    isTogglingRecording = true

    try {
        if (decision.kind === 'stop') {
            return await stopRecording()
        }
        return await startRecording(mode)
    } finally {
        isTogglingRecording = false
    }
}

async function startMicTest(deviceId?: string | null, deviceLabel?: string | null) {
    if (captureState.is_recording || activeCaptureSession) {
        throw new Error('Finish the current recording before starting a microphone check.')
    }

    await ensureBackendReadyForInteraction()

    const processingStatus = await getBackendStatus()
    if (processingStatus.is_processing) {
        throw new Error('The local engine is still processing the previous recording.')
    }

    const permissionStatus = await ensureCapturePermission()
    if (permissionStatus !== 'granted') {
        showRouteNotification(
            'Microphone access required',
            'Grant microphone access in Voice settings before the microphone check can start.',
            '/settings',
        )
        throw new Error('Microphone access is required before the microphone check can start.')
    }

    const audioConfig = await getSelectedCaptureAudioConfig()
    const requestedDeviceId = deviceId ?? audioConfig.input_device_id ?? null
    const requestedDeviceLabel = deviceLabel ?? audioConfig.input_device_label ?? audioConfig.input_device ?? null

    setCaptureState({
        error: null,
        fallback_notice: null,
        fallback_to_default: false,
    })

    const response = await requestCaptureHost<{ status: string; message?: string }>('start-mic-test', {
        deviceId: requestedDeviceId,
        deviceLabel: requestedDeviceLabel,
    })

    activeCaptureSession = {
        kind: 'mic_test',
        requestedDeviceId,
        requestedDeviceLabel,
    }

    return {
        status: response.status || 'started',
        message: response.message || 'Microphone check started',
    }
}

async function stopMicTest() {
    if (!activeCaptureSession || activeCaptureSession.kind !== 'mic_test') {
        throw new Error('There is no active microphone check to stop.')
    }

    activeCaptureSession = null

    const stopResult = await requestCaptureHost<CaptureStopResult>('stop-mic-test')
    if (stopResult.status !== 'success' || !stopResult.audio_base64 || !stopResult.capture_stats) {
        const errorMessage = stopResult.error || 'No usable audio was captured.'
        setCaptureState({
            error: errorMessage,
        })
        return {
            status: 'error',
            message: errorMessage,
            fallback_notice: stopResult.capture_stats?.fallback_notice ?? null,
        }
    }

    const response = await backendClient.request('/audio/test/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            audio_base64: stopResult.audio_base64,
            capture_stats: stopResult.capture_stats,
        })
    })

    const data = await response.json() as Record<string, unknown>
    if (!response.ok) {
        throw new Error(
            typeof data?.detail === 'string'
                ? data.detail
                : typeof data?.message === 'string'
                    ? data.message
                    : `Microphone test failed with ${response.status}`,
        )
    }

    return {
        ...data,
        fallback_notice: stopResult.capture_stats.fallback_notice,
    }
}

app.on('before-quit', () => {
    isAppQuitting = true
    clearWidgetHideFallback()
    tray?.destroy()
    tray = null
    nativeSpeechHelper.dispose()
    pasteDeliveryCoordinator.dispose()
})

app.on('will-quit', () => {
    if (app.isReady()) {
        globalShortcut.unregisterAll()
    }
    for (const pending of pendingCaptureRequests.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error('The application is shutting down.'))
    }
    pendingCaptureRequests.clear()
    nativeSpeechHelper.dispose()
    void stopBackend()
})

app.on('window-all-closed', () => {
    // macOS Tray apps usually stay alive even if settings window is closed
    if (process.platform !== 'darwin') {
        quitApplication()
        widgetWin = null
        settingsWin = null
        captureWin = null
        inboxWin = null
    }
})

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindows()
    }
})

app.on('open-url', (event, url) => {
    event.preventDefault()
    enqueueDeepLink(url)
    if (app.isReady()) {
        void flushPendingDeepLinks()
    }
})

const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
    quitApplication()
} else {
    app.on('second-instance', (_event, argv) => {
        const deepLink = findDeepLinkArg(argv)
        if (deepLink) {
            enqueueDeepLink(deepLink)
            if (app.isReady()) {
                void flushPendingDeepLinks()
            }
            return
        }
        if (isWindowAlive(settingsWin) && settingsWin.isMinimized()) settingsWin.restore()
        showHomeWindow()
    })

    app.whenReady().then(async () => {
        appState = loadAppState()
        registerDeepLinkClient()
        configureMacAppIdentity()

        // Automatically prompt for Mic permissions on launch natively in Electron
        if (process.platform === 'darwin') {
            systemPreferences.askForMediaAccess('microphone')
            // True prompts the user immediately if accessibility is not granted
            systemPreferences.isTrustedAccessibilityClient(true)
        }

        await startBackend()
        createApplicationMenu()
        createTray()
        createWindows()
        registerHotkeys()

        const initialDeepLink = findDeepLinkArg(process.argv)
        const hasPendingDeepLink = Boolean(initialDeepLink || pendingDeepLinks.length)
        if (initialDeepLink) {
            enqueueDeepLink(initialDeepLink)
        }
        await flushPendingDeepLinks()

        if (shouldAutoOpenPreferencesOnLaunch() && !hasPendingDeepLink) {
            showHomeWindow()
        }
    })
}

// IPC Handlers
ipcMain.on('window-minimize', (event) => {
    const webContents = event.sender
    const win = BrowserWindow.fromWebContents(webContents)
    win?.minimize()
})

ipcMain.on('window-close', (event) => {
    const webContents = event.sender
    const win = BrowserWindow.fromWebContents(webContents)
    if (win === settingsWin) {
        win?.hide()
    } else if (win === widgetWin) {
        requestWidgetClose('tray')
    } else if (win === inboxWin) {
        requestInboxClose()
    } else {
        quitApplication()
    }
})

ipcMain.on('show-settings', () => {
    showPreferencesWindow('/settings')
})

ipcMain.handle('show-main-window', (_event, route?: string) => {
    showMainWindow(route || '/')
    return { status: 'shown' }
})

ipcMain.handle('quit-app', () => {
    quitApplication()
    return { status: 'quitting' }
})

ipcMain.handle('get-platform', () => {
    return process.platform
})

ipcMain.handle('get-backend-base-url', () => {
    return backendLifecycle.getBaseUrl()
})

ipcMain.handle('get-backend-request-context', () => {
    return backendClient.getRequestContext()
})

ipcMain.handle('open-logs-directory', () => {
    shell.showItemInFolder(path.join(logDir, 'electron.log'))
    return { status: 'opened' }
})

ipcMain.handle('report-renderer-error', (_event, payload: { message: string; stack?: string | null; component_stack?: string | null; route?: string | null }) => {
    logToFile(`Renderer error on ${payload.route || 'unknown route'}: ${payload.message}`)
    if (payload.stack) {
        logToFile(payload.stack)
    }
    if (payload.component_stack) {
        logToFile(payload.component_stack)
    }
    return { status: 'logged' }
})

ipcMain.handle('get-launch-context', async () => {
    return getLaunchContext()
})

ipcMain.handle('set-background-only', async (_event, enabled: boolean) => {
    if (isPackagedTrayOnlyMac()) {
        return getLaunchContext()
    }
    updateAppState({ backgroundOnly: Boolean(enabled) })
    if (enabled) {
        hideTransientWindows('idle', true)
    }
    return getLaunchContext()
})

ipcMain.handle('hide-transient-windows', (_event, source: WidgetPresentationSource = 'idle') => {
    hideTransientWindows(source, true)
    return { status: 'hidden' }
})

ipcMain.handle('set-widget-mode-menu-open', (_event, open: boolean) => {
    setWidgetModeMenuOpen(Boolean(open))
    return { status: 'updated', open: Boolean(open) }
})

ipcMain.handle('set-widget-preview-expanded', (_event, open: boolean) => {
    setWidgetPreviewExpanded(Boolean(open))
    return { status: 'updated', open: Boolean(open) }
})

ipcMain.handle('set-widget-action-review-expanded', (_event, open: boolean) => {
    setWidgetActionReviewExpanded(Boolean(open))
    return { status: 'updated', open: Boolean(open) }
})

ipcMain.handle('set-widget-live-transcript-expanded', (_event, open: boolean) => {
    setWidgetLiveTranscriptExpanded(Boolean(open))
    return { status: 'updated', open: Boolean(open) }
})

ipcMain.handle('check-accessibility', () => {
    if (process.platform === 'darwin') {
        return systemPreferences.isTrustedAccessibilityClient(false)
    }
    return true
})

ipcMain.handle('get-capture-permission-status', async () => {
    return readCapturePermissionStatus()
})

ipcMain.handle('request-capture-permission', async () => {
    return ensureCapturePermission()
})

ipcMain.handle('get-capture-devices', async (_event, refresh?: boolean) => {
    try {
        const result = await requestCaptureHost<unknown>('get-devices', { refresh })
        if (isCaptureDeviceList(result)) {
            return result
        }

        logToFile(`Unexpected capture device payload. Falling back to an empty list: ${JSON.stringify(result).slice(0, 300)}`)
        return []
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logToFile(`Failed to read capture devices. Falling back to an empty list: ${message}`)
        return []
    }
})

ipcMain.handle('get-capture-state', () => {
    return captureState
})

ipcMain.handle('get-local-live-transcription-state', () => {
    return localLiveTranscriptionState
})

ipcMain.on('prompt-accessibility', () => {
    if (process.platform === 'darwin') {
        systemPreferences.isTrustedAccessibilityClient(true) // true triggers the system dialog
    }
})

ipcMain.on('open-privacy-settings', (_event, pane: keyof typeof PRIVACY_SETTINGS_URLS) => {
    openPrivacySettingsPane(pane)
})

ipcMain.handle('check-smart-context-access', async () => {
    return getSmartContextAccessStatus()
})

ipcMain.handle('prompt-smart-context-access', async () => {
    return getSmartContextAccessStatus()
})

ipcMain.handle('restart-backend', async () => {
    await stopBackend()
    await startBackend()
    return { status: 'restarted' }
})

ipcMain.handle('dismiss-packaged-onboarding', async () => {
    updateAppState({ onboardingDismissed: true })
    return getLaunchContext()
})

ipcMain.handle('complete-packaged-onboarding', async () => {
    const launchContext = await getLaunchContext()
    if (launchContext.onboarding_blocker) {
        return launchContext
    }

    updateAppState({
        onboardingCompleted: true,
        onboardingDismissed: true,
    })
    return getLaunchContext()
})

ipcMain.on('reveal-app-in-finder', () => {
    shell.showItemInFolder(app.getPath('exe'))
})

ipcMain.on('open-applications-folder', () => {
    void shell.openPath('/Applications')
})

ipcMain.handle('toggle-recording', async (_event, mode: RecordingMode) => {
    try {
        return await toggleRecording(mode)
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        resetRecordingCaptureState(message)
        throw error
    }
})

ipcMain.handle('start-mic-test', async (_event, payload?: { deviceId?: string | null; deviceLabel?: string | null }) => {
    try {
        return await startMicTest(payload?.deviceId ?? null, payload?.deviceLabel ?? null)
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        resetRecordingCaptureState(message)
        throw error
    }
})

ipcMain.handle('stop-mic-test', async () => {
    try {
        return await stopMicTest()
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        resetRecordingCaptureState(message)
        throw error
    }
})

ipcMain.handle('get-backend-boot-state', () => {
    return backendBootState
})

ipcMain.handle('get-mlx-install-state', () => {
    return mlxInstallState
})

ipcMain.handle('check-mlx-whisper-installation', async () => {
    await checkMlxWhisperInstallation()
    return mlxInstallState
})

ipcMain.handle('install-mlx-whisper', async () => {
    return installMlxWhisper()
})

ipcMain.handle('get-semantic-memory-install-state', () => {
    const persistedState = readSemanticMemoryStateFile()
    semanticMemoryInstallState = {
        ...semanticMemoryInstallState,
        installed: persistedState.installed ?? semanticMemoryInstallState.installed,
        python_available: semanticMemoryInstallState.python_available || Boolean(persistedState.python_path),
        python_compatible: semanticMemoryInstallState.python_compatible || Boolean(persistedState.python_version),
        runtime_source: persistedState.runtime_source ?? semanticMemoryInstallState.runtime_source,
        python_version: persistedState.python_version ?? semanticMemoryInstallState.python_version,
        python_path: persistedState.python_path ?? semanticMemoryInstallState.python_path,
        sqlite_module: persistedState.sqlite_module ?? semanticMemoryInstallState.sqlite_module,
        sqlite_version: persistedState.sqlite_version ?? semanticMemoryInstallState.sqlite_version,
        vec_version: persistedState.vec_version ?? semanticMemoryInstallState.vec_version,
        error_code: persistedState.error_code ?? semanticMemoryInstallState.error_code,
        label: persistedState.ready
            ? 'Ready'
            : persistedState.error_code
                ? 'Repair needed'
                : semanticMemoryInstallState.label,
        phase: persistedState.ready
            ? 'ready'
            : persistedState.error_code
                ? 'repair_needed'
                : semanticMemoryInstallState.phase,
        detail: persistedState.detail ?? semanticMemoryInstallState.detail,
        log_path: persistedState.log_path ?? path.join(getSemanticMemoryRuntimeRoot(), 'runtime.log'),
        runtime_path: persistedState.runtime_path ?? getSemanticMemoryRuntimeRoot(),
        logs: readSemanticMemoryLogTail(),
    }
    return semanticMemoryInstallState
})

ipcMain.handle('check-semantic-memory-installation', async () => {
    await checkSemanticMemoryInstallation()
    return semanticMemoryInstallState
})

ipcMain.handle('install-semantic-memory-runtime', async () => {
    return installSemanticMemoryRuntime()
})

ipcMain.handle('repair-semantic-memory-runtime', async () => {
    return installSemanticMemoryRuntime(true)
})

ipcMain.handle('reveal-semantic-memory-runtime', async () => {
    shell.showItemInFolder(getSemanticMemoryRuntimeRoot())
    return { status: 'ok' }
})

ipcMain.handle('get-inbox-window-state', () => {
    return { open: isWindowAlive(inboxWin) ? inboxWin.isVisible() : false }
})

ipcMain.handle('toggle-inbox-window', () => {
    return toggleInboxWindow()
})

ipcMain.handle('close-inbox-window', () => {
    requestInboxClose()
    return { open: false }
})

ipcMain.handle('notify-inbox-changed', () => {
    broadcastInboxChanged()
    return { status: 'ok' }
})

ipcMain.handle('write-clipboard-text', (_event, text: string) => {
    clipboard.writeText(text || '')
    return { status: 'ok' }
})

ipcMain.handle('pick-domain-pack-file', async () => {
    const owner = isWindowAlive(settingsWin) ? settingsWin : undefined
    const dialogOptions: OpenDialogOptions = {
        title: 'Import Domain Pack Overlay',
        properties: ['openFile'],
        filters: [
            { name: 'JSON', extensions: ['json'] },
        ],
    }
    const result = owner
        ? await dialog.showOpenDialog(owner, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions)

    if (result.canceled || !result.filePaths[0]) {
        return { status: 'cancelled' as const }
    }

    try {
        const filePath = result.filePaths[0]
        const text = fs.readFileSync(filePath, 'utf-8')
        return {
            status: 'success' as const,
            path: filePath,
            text,
        }
    } catch (error) {
        return {
            status: 'error' as const,
            message: error instanceof Error ? error.message : String(error),
        }
    }
})

ipcMain.handle('save-domain-pack-file', async (_event, payload: { suggestedName: string; text: string }) => {
    const owner = isWindowAlive(settingsWin) ? settingsWin : undefined
    const dialogOptions: SaveDialogOptions = {
        title: 'Export Domain Pack Overlay',
        defaultPath: payload.suggestedName || 'domain-pack-overlay.json',
        filters: [
            { name: 'JSON', extensions: ['json'] },
        ],
    }
    const result = owner
        ? await dialog.showSaveDialog(owner, dialogOptions)
        : await dialog.showSaveDialog(dialogOptions)

    if (result.canceled || !result.filePath) {
        return { status: 'cancelled' as const }
    }

    try {
        fs.writeFileSync(result.filePath, payload.text, 'utf-8')
        return {
            status: 'success' as const,
            path: result.filePath,
        }
    } catch (error) {
        return {
            status: 'error' as const,
            message: error instanceof Error ? error.message : String(error),
        }
    }
})

ipcMain.handle('show-native-notification', (_event, payload: { title: string; body?: string | null }) => {
    if (Notification.isSupported()) {
        const notification = new Notification(buildNotificationOptions(payload.title, payload.body || ''))
        notification.show()
    } else {
        logToFile(`Notification unsupported: ${payload.title}`)
    }
    return { status: 'shown' }
})

ipcMain.on('capture-ready', () => {
    resolveCaptureHostReady()
})

ipcMain.on('capture-response', (_event, payload: { requestId: string; payload: unknown }) => {
    const pending = pendingCaptureRequests.get(payload.requestId)
    if (!pending) return

    clearTimeout(pending.timer)
    pendingCaptureRequests.delete(payload.requestId)
    pending.resolve(payload.payload)
})

ipcMain.on('capture-chunk', (_event, payload: CaptureChunkPayload) => {
    if (!activeCaptureSession || activeCaptureSession.kind !== 'recording') {
        return
    }
    if (activeCaptureSession.liveSessionId !== payload.sessionId) {
        return
    }

    if (activeCaptureSession.liveStrategy === 'native_local') {
        void nativeSpeechHelper.appendChunk(
            payload.sessionId,
            payload.sampleRate,
            payload.pcmS16leBase64,
        ).catch((error) => {
            const message = error instanceof Error ? error.message : String(error)
            logToFile(`Local live preview chunk failed for ${payload.sessionId}: ${message}`)
            void abortLocalPreviewSession(payload.sessionId, message)
        })
        return
    }

    if (activeCaptureSession.liveStrategy !== 'backend_provider') {
        return
    }

    const chunk = Buffer.from(payload.pcmS16leBase64, 'base64')
    if (!chunk.length) {
        return
    }

    activeCaptureSession.liveChunkBuffer.push(chunk)
    activeCaptureSession.liveChunkBytes += chunk.length
    scheduleLiveTranscriptionFlush(activeCaptureSession)
})

ipcMain.on('capture-state', (_event, nextState: CaptureState) => {
    captureState = nextState
    if (
        nextState.phase === 'recording'
        && activeCaptureSession
        && activeCaptureSession.kind === 'recording'
        && !activeCaptureSession.captureTimeline.capture_started
    ) {
        activeCaptureSession.captureTimeline.capture_started = nowIso()
    }
    broadcastCaptureState()
})

ipcMain.on('widget-hide-complete', () => {
    clearWidgetHideFallback()
    if (isWindowAlive(widgetWin)) {
        widgetWin.hide()
    }
})

ipcMain.handle('paste-text', async (_event, payload): Promise<PasteResult> => {
    const pasteId = typeof payload === 'object' && payload && typeof payload.id === 'string'
        ? payload.id
        : null
    const text = typeof payload === 'string' ? payload : String(payload?.text || '')
    const restoreClipboard = typeof payload === 'object' && payload?.options
        ? payload.options.restoreClipboard !== false
        : true
    return pasteDeliveryCoordinator.deliver({
        id: pasteId,
        text,
        restoreClipboard,
    })
})
