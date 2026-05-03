import { contextBridge, ipcRenderer } from 'electron'

import type { BackendProxyMethod, BackendProxyRequest, CaptureBridge, WindowControls } from '../src/ipc/contracts'
import type { DesktopLogKind, PrivacyPane, RecordingMode, WidgetPresentationSource } from '../src/types'

type IpcListener<T> = (_event: unknown, payload: T) => void

const PRIVACY_PANES: ReadonlySet<PrivacyPane> = new Set(['microphone', 'accessibility', 'automation'] as const)
const RECORDING_MODES: ReadonlySet<RecordingMode> = new Set(['dictation', 'smart_transform'] as const)
const WIDGET_SOURCES: ReadonlySet<WidgetPresentationSource> = new Set(['tray', 'hotkey', 'idle'] as const)
const DESKTOP_LOG_KINDS: ReadonlySet<DesktopLogKind> = new Set(['backend', 'electron'] as const)
const BACKEND_PROXY_METHODS: ReadonlySet<BackendProxyMethod> = new Set(['GET', 'POST', 'PUT', 'DELETE'] as const)

function assertBoolean(name: string, value: unknown): asserts value is boolean {
  if (typeof value !== 'boolean') {
    throw new TypeError(`${name} must be a boolean.`)
  }
}

function assertString(name: string, value: unknown): asserts value is string {
  if (typeof value !== 'string') {
    throw new TypeError(`${name} must be a string.`)
  }
}

function assertOptionalString(name: string, value: unknown): asserts value is string | null | undefined {
  if (value != null && typeof value !== 'string') {
    throw new TypeError(`${name} must be a string when provided.`)
  }
}

function assertFunction(name: string, value: unknown): asserts value is (...args: unknown[]) => unknown {
  if (typeof value !== 'function') {
    throw new TypeError(`${name} must be a function.`)
  }
}

function assertDesktopLogKind(value: unknown): asserts value is DesktopLogKind {
  assertString('kind', value)
  if (!DESKTOP_LOG_KINDS.has(value as DesktopLogKind)) {
    throw new TypeError(`Unsupported log kind: ${value}.`)
  }
}

function assertPrivacyPane(value: unknown): asserts value is PrivacyPane {
  assertString('pane', value)
  if (!PRIVACY_PANES.has(value as PrivacyPane)) {
    throw new TypeError(`Unsupported privacy pane: ${value}.`)
  }
}

function assertRecordingMode(value: unknown): asserts value is RecordingMode {
  assertString('mode', value)
  if (!RECORDING_MODES.has(value as RecordingMode)) {
    throw new TypeError(`Unsupported recording mode: ${value}.`)
  }
}

function assertWidgetSource(value: unknown): asserts value is WidgetPresentationSource {
  assertString('source', value)
  if (!WIDGET_SOURCES.has(value as WidgetPresentationSource)) {
    throw new TypeError(`Unsupported widget source: ${value}.`)
  }
}

function assertBackendProxyRequest(value: unknown): asserts value is BackendProxyRequest {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('backendRequest payload must be an object.')
  }

  const request = value as Partial<BackendProxyRequest>
  assertString('payload.method', request.method)
  if (!BACKEND_PROXY_METHODS.has(request.method as BackendProxyMethod)) {
    throw new TypeError(`Unsupported backend request method: ${request.method}.`)
  }
  assertString('payload.path', request.path)
  if (!request.path.startsWith('/') || request.path.startsWith('//')) {
    throw new TypeError('backendRequest path must be a local absolute path.')
  }
  if (request.headers !== undefined && (typeof request.headers !== 'object' || request.headers === null || Array.isArray(request.headers))) {
    throw new TypeError('backendRequest headers must be an object when provided.')
  }
  if (request.headers) {
    Object.entries(request.headers).forEach(([name, value]) => {
      assertString(`payload.headers.${name}`, value)
    })
  }
  if (request.timeout !== undefined && typeof request.timeout !== 'number') {
    throw new TypeError('backendRequest timeout must be a number when provided.')
  }
}

function onChannel<T>(channel: string, callback: (payload: T) => void) {
  assertFunction(`callback for ${channel}`, callback)
  const listener: IpcListener<T> = (_event, payload) => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.off(channel, listener)
}

function buildWindowControls(): WindowControls {
  const windowLifecycle: Pick<
    WindowControls,
    'minimize' | 'close' | 'quitApp' | 'showMainWindow' | 'showSettings' | 'getPlatform' | 'getLaunchContext'
  > = {
    minimize: () => ipcRenderer.send('window-minimize'),
    close: () => ipcRenderer.send('window-close'),
    quitApp: () => ipcRenderer.invoke('quit-app'),
    showMainWindow: (route?: string) => {
      assertOptionalString('route', route)
      return ipcRenderer.invoke('show-main-window', route)
    },
    showSettings: () => ipcRenderer.send('show-settings'),
    getPlatform: () => ipcRenderer.invoke('get-platform'),
    getLaunchContext: () => ipcRenderer.invoke('get-launch-context'),
  }

  const widgetPresentation: Pick<
    WindowControls,
    | 'hideTransientWindows'
    | 'setWidgetModeMenuOpen'
    | 'setWidgetPreviewExpanded'
    | 'setWidgetActionReviewExpanded'
    | 'setWidgetLiveTranscriptExpanded'
    | 'completeWidgetHide'
    | 'onWidgetPresentationCommand'
  > = {
    hideTransientWindows: (source?: WidgetPresentationSource) => {
      if (source !== undefined) {
        assertWidgetSource(source)
      }
      return ipcRenderer.invoke('hide-transient-windows', source)
    },
    setWidgetModeMenuOpen: (open: boolean) => {
      assertBoolean('open', open)
      return ipcRenderer.invoke('set-widget-mode-menu-open', open)
    },
    setWidgetPreviewExpanded: (open: boolean) => {
      assertBoolean('open', open)
      return ipcRenderer.invoke('set-widget-preview-expanded', open)
    },
    setWidgetActionReviewExpanded: (open: boolean) => {
      assertBoolean('open', open)
      return ipcRenderer.invoke('set-widget-action-review-expanded', open)
    },
    setWidgetLiveTranscriptExpanded: (open: boolean) => {
      assertBoolean('open', open)
      return ipcRenderer.invoke('set-widget-live-transcript-expanded', open)
    },
    completeWidgetHide: (source: WidgetPresentationSource) => {
      assertWidgetSource(source)
      ipcRenderer.send('widget-hide-complete', source)
    },
    onWidgetPresentationCommand: (callback) =>
      onChannel('widget-presentation', callback),
  }

  const permissionsAndRuntime: Pick<
    WindowControls,
    | 'getBackendBaseUrl'
    | 'getBackendRequestContext'
    | 'backendRequest'
    | 'startBackendRuntimeEvents'
    | 'stopBackendRuntimeEvents'
    | 'onBackendRuntimeEvent'
    | 'setBackgroundOnly'
    | 'checkAccessibility'
    | 'promptAccessibility'
    | 'openPrivacySettings'
    | 'getCapturePermissionStatus'
    | 'requestCapturePermission'
    | 'getCaptureDevices'
    | 'getCaptureState'
    | 'getLocalLiveTranscriptionState'
    | 'checkSmartContextAccess'
    | 'promptSmartContextAccess'
    | 'restartBackend'
    | 'dismissPackagedOnboarding'
    | 'completePackagedOnboarding'
    | 'getBackendBootState'
    | 'getMlxInstallState'
    | 'checkMlxWhisperInstallation'
    | 'installMlxWhisper'
    | 'getSemanticMemoryInstallState'
    | 'checkSemanticMemoryInstallation'
    | 'installSemanticMemoryRuntime'
    | 'repairSemanticMemoryRuntime'
    | 'revealSemanticMemoryRuntime'
    | 'openLogsDirectory'
    | 'readLogTail'
    | 'reportRendererError'
    | 'onPasteError'
    | 'onBackendBootState'
    | 'onMlxInstallState'
    | 'onSemanticMemoryInstallState'
    | 'onCaptureState'
    | 'onLocalLiveTranscription'
  > = {
    getBackendBaseUrl: () => ipcRenderer.invoke('get-backend-base-url'),
    getBackendRequestContext: () => ipcRenderer.invoke('get-backend-request-context'),
    backendRequest: (request) => {
      assertBackendProxyRequest(request)
      return ipcRenderer.invoke('backend-request', request)
    },
    startBackendRuntimeEvents: () => ipcRenderer.invoke('backend-runtime-events-start'),
    stopBackendRuntimeEvents: () => ipcRenderer.invoke('backend-runtime-events-stop'),
    setBackgroundOnly: (enabled: boolean) => {
      assertBoolean('enabled', enabled)
      return ipcRenderer.invoke('set-background-only', enabled)
    },
    checkAccessibility: () => ipcRenderer.invoke('check-accessibility'),
    promptAccessibility: () => ipcRenderer.send('prompt-accessibility'),
    openPrivacySettings: (pane: PrivacyPane) => {
      assertPrivacyPane(pane)
      ipcRenderer.send('open-privacy-settings', pane)
    },
    getCapturePermissionStatus: () => ipcRenderer.invoke('get-capture-permission-status'),
    requestCapturePermission: () => ipcRenderer.invoke('request-capture-permission'),
    getCaptureDevices: (refresh?: boolean) => {
      if (refresh !== undefined) {
        assertBoolean('refresh', refresh)
      }
      return ipcRenderer.invoke('get-capture-devices', refresh)
    },
    getCaptureState: () => ipcRenderer.invoke('get-capture-state'),
    getLocalLiveTranscriptionState: () => ipcRenderer.invoke('get-local-live-transcription-state'),
    checkSmartContextAccess: () => ipcRenderer.invoke('check-smart-context-access'),
    promptSmartContextAccess: () => ipcRenderer.invoke('prompt-smart-context-access'),
    restartBackend: () => ipcRenderer.invoke('restart-backend'),
    dismissPackagedOnboarding: () => ipcRenderer.invoke('dismiss-packaged-onboarding'),
    completePackagedOnboarding: () => ipcRenderer.invoke('complete-packaged-onboarding'),
    getBackendBootState: () => ipcRenderer.invoke('get-backend-boot-state'),
    getMlxInstallState: () => ipcRenderer.invoke('get-mlx-install-state'),
    checkMlxWhisperInstallation: () => ipcRenderer.invoke('check-mlx-whisper-installation'),
    installMlxWhisper: () => ipcRenderer.invoke('install-mlx-whisper'),
    getSemanticMemoryInstallState: () => ipcRenderer.invoke('get-semantic-memory-install-state'),
    checkSemanticMemoryInstallation: () => ipcRenderer.invoke('check-semantic-memory-installation'),
    installSemanticMemoryRuntime: () => ipcRenderer.invoke('install-semantic-memory-runtime'),
    repairSemanticMemoryRuntime: () => ipcRenderer.invoke('repair-semantic-memory-runtime'),
    revealSemanticMemoryRuntime: () => ipcRenderer.invoke('reveal-semantic-memory-runtime'),
    openLogsDirectory: () => ipcRenderer.invoke('open-logs-directory'),
    readLogTail: (kind: DesktopLogKind) => {
      assertDesktopLogKind(kind)
      return ipcRenderer.invoke('read-log-tail', kind)
    },
    reportRendererError: (payload) => {
      if (typeof payload !== 'object' || payload === null) {
        throw new TypeError('reportRendererError payload must be an object.')
      }
      assertString('payload.message', payload.message)
      assertOptionalString('payload.stack', payload.stack)
      assertOptionalString('payload.component_stack', payload.component_stack)
      assertOptionalString('payload.route', payload.route)
      return ipcRenderer.invoke('report-renderer-error', payload)
    },
    onPasteError: (callback) => {
      assertFunction('callback for paste-error-tcc', callback)
      const listener = () => callback()
      ipcRenderer.on('paste-error-tcc', listener)
      return () => ipcRenderer.off('paste-error-tcc', listener)
    },
    onBackendBootState: (callback) => onChannel('backend-boot-state', callback),
    onMlxInstallState: (callback) => onChannel('mlx-install-state', callback),
    onSemanticMemoryInstallState: (callback: Parameters<WindowControls['onSemanticMemoryInstallState']>[0]) =>
      onChannel('semantic-memory-install-state', callback),
    onCaptureState: (callback) => onChannel('capture-state', callback),
    onLocalLiveTranscription: (callback) => onChannel('local-live-transcription', callback),
    onBackendRuntimeEvent: (callback) => onChannel('backend-runtime-event', callback),
  }

  const recording: Pick<
    WindowControls,
    'toggleRecording' | 'startMicTest' | 'stopMicTest'
  > = {
    toggleRecording: (mode: RecordingMode) => {
      assertRecordingMode(mode)
      return ipcRenderer.invoke('toggle-recording', mode)
    },
    startMicTest: (deviceId?: string | null, deviceLabel?: string | null) => {
      assertOptionalString('deviceId', deviceId)
      assertOptionalString('deviceLabel', deviceLabel)
      return ipcRenderer.invoke('start-mic-test', { deviceId, deviceLabel })
    },
    stopMicTest: () => ipcRenderer.invoke('stop-mic-test'),
  }

  const notificationsAndInbox: Pick<
    WindowControls,
    | 'showNativeNotification'
    | 'getInboxWindowState'
    | 'toggleInboxWindow'
    | 'closeInboxWindow'
    | 'notifyInboxChanged'
    | 'onInboxWindowState'
    | 'onInboxChanged'
  > = {
    showNativeNotification: (title: string, body?: string | null) => {
      assertString('title', title)
      assertOptionalString('body', body)
      return ipcRenderer.invoke('show-native-notification', {
        title,
        body: body ?? null,
      })
    },
    getInboxWindowState: () => ipcRenderer.invoke('get-inbox-window-state'),
    toggleInboxWindow: () => ipcRenderer.invoke('toggle-inbox-window'),
    closeInboxWindow: () => ipcRenderer.invoke('close-inbox-window'),
    notifyInboxChanged: () => ipcRenderer.invoke('notify-inbox-changed'),
    onInboxWindowState: (callback) => onChannel('inbox-window-state', callback),
    onInboxChanged: (callback) => onChannel('inbox-changed', callback),
  }

  const clipboardAndFiles: Pick<
    WindowControls,
    | 'pasteText'
    | 'writeClipboardText'
    | 'pickDomainPackFile'
    | 'saveDomainPackFile'
    | 'revealAppInFinder'
    | 'openApplicationsFolder'
  > = {
    pasteText: (payload) => {
      if (typeof payload !== 'object' || payload === null) {
        throw new TypeError('pasteText payload must be an object.')
      }
      assertString('payload.id', payload.id)
      assertString('payload.text', payload.text)
      if (payload.options && payload.options.restoreClipboard !== undefined) {
        assertBoolean('payload.options.restoreClipboard', payload.options.restoreClipboard)
      }
      return ipcRenderer.invoke('paste-text', payload)
    },
    writeClipboardText: (text: string) => {
      assertString('text', text)
      return ipcRenderer.invoke('write-clipboard-text', text)
    },
    pickDomainPackFile: () => ipcRenderer.invoke('pick-domain-pack-file'),
    saveDomainPackFile: (suggestedName: string, text: string) => {
      assertString('suggestedName', suggestedName)
      assertString('text', text)
      return ipcRenderer.invoke('save-domain-pack-file', { suggestedName, text })
    },
    revealAppInFinder: () => ipcRenderer.send('reveal-app-in-finder'),
    openApplicationsFolder: () => ipcRenderer.send('open-applications-folder'),
  }

  return {
    ...windowLifecycle,
    ...widgetPresentation,
    ...permissionsAndRuntime,
    ...recording,
    ...notificationsAndInbox,
    ...clipboardAndFiles,
  }
}

function buildCaptureBridge(): CaptureBridge {
  return {
    onCommand: (callback) => onChannel('capture-command', callback),
    sendResponse: (requestId: string, payload: unknown) => {
      assertString('requestId', requestId)
      ipcRenderer.send('capture-response', { requestId, payload })
    },
    sendState: (state: unknown) => {
      ipcRenderer.send('capture-state', state)
    },
    sendChunk: (payload: unknown) => {
      ipcRenderer.send('capture-chunk', payload)
    },
    notifyReady: () => {
      ipcRenderer.send('capture-ready')
    },
  }
}

export function exposePreloadBridge() {
  contextBridge.exposeInMainWorld('windowControls', buildWindowControls())
  contextBridge.exposeInMainWorld('captureBridge', buildCaptureBridge())
}
