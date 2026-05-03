import type {
  AudioDevice,
  AppLaunchContext,
  BackendBootState,
  CaptureState,
  DesktopLogKind,
  DesktopLogSnapshot,
  LiveTranscription,
  MlxInstallState,
  PasteResult,
  PrivacyPane,
  RecordingMode,
  SemanticMemoryInstallState,
  SmartContextAccessStatus,
  WidgetPresentationCommand,
  WidgetPresentationSource,
} from '../types'
import type { BackendRequestContext } from '../../shared/localBackendAuth'

export type BackendProxyMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

export type BackendProxyRequest = {
  method: BackendProxyMethod
  path: string
  headers?: Record<string, string>
  body?: unknown
  timeout?: number
}

export type BackendProxyResponse<T = unknown> = {
  ok: boolean
  status: number
  headers: Record<string, string>
  data: T | null
}

export type BackendRuntimeEventPayload = {
  type: string
  data?: string
  message?: string
}

export interface WindowControls {
  minimize: () => void
  close: () => void
  quitApp: () => Promise<{ status: string }>
  showMainWindow: (route?: string) => Promise<{ status: string }>
  showSettings: () => void
  getPlatform: () => Promise<string>
  getBackendBaseUrl: () => Promise<string>
  getBackendRequestContext: () => Promise<BackendRequestContext>
  backendRequest: <T = unknown>(request: BackendProxyRequest) => Promise<BackendProxyResponse<T>>
  startBackendRuntimeEvents: () => Promise<{ status: string }>
  stopBackendRuntimeEvents: () => Promise<{ status: string }>
  onBackendRuntimeEvent: (callback: (payload: BackendRuntimeEventPayload) => void) => () => void
  getLaunchContext: () => Promise<AppLaunchContext>
  setBackgroundOnly: (enabled: boolean) => Promise<AppLaunchContext>
  hideTransientWindows: (source?: WidgetPresentationSource) => Promise<{ status: string }>
  setWidgetModeMenuOpen: (open: boolean) => Promise<{ status: string; open: boolean }>
  setWidgetPreviewExpanded: (open: boolean) => Promise<{ status: string; open: boolean }>
  setWidgetActionReviewExpanded: (open: boolean) => Promise<{ status: string; open: boolean }>
  setWidgetLiveTranscriptExpanded: (open: boolean) => Promise<{ status: string; open: boolean }>
  checkAccessibility: () => Promise<boolean>
  promptAccessibility: () => void
  openPrivacySettings: (pane: PrivacyPane) => void
  getCapturePermissionStatus: () => Promise<string>
  requestCapturePermission: () => Promise<string>
  getCaptureDevices: (refresh?: boolean) => Promise<AudioDevice[]>
  getCaptureState: () => Promise<CaptureState>
  getLocalLiveTranscriptionState: () => Promise<LiveTranscription | null>
  startMicTest: (deviceId?: string | null, deviceLabel?: string | null) => Promise<{ status: string; message: string }>
  stopMicTest: () => Promise<{ status: string; transcript?: string; processing_time?: number; audio_file?: string | null; message?: string; fallback_notice?: string | null }>
  checkSmartContextAccess: () => Promise<SmartContextAccessStatus>
  promptSmartContextAccess: () => Promise<SmartContextAccessStatus>
  restartBackend: () => Promise<{ status: string }>
  dismissPackagedOnboarding: () => Promise<AppLaunchContext>
  completePackagedOnboarding: () => Promise<AppLaunchContext>
  revealAppInFinder: () => void
  openApplicationsFolder: () => void
  toggleRecording: (mode: RecordingMode) => Promise<{ status: string; message: string }>
  getBackendBootState: () => Promise<BackendBootState>
  getMlxInstallState: () => Promise<MlxInstallState>
  checkMlxWhisperInstallation: () => Promise<MlxInstallState>
  installMlxWhisper: () => Promise<MlxInstallState>
  getSemanticMemoryInstallState: () => Promise<SemanticMemoryInstallState>
  checkSemanticMemoryInstallation: () => Promise<SemanticMemoryInstallState>
  installSemanticMemoryRuntime: () => Promise<SemanticMemoryInstallState>
  repairSemanticMemoryRuntime: () => Promise<SemanticMemoryInstallState>
  revealSemanticMemoryRuntime: () => Promise<{ status: string }>
  openLogsDirectory: () => Promise<{ status: string }>
  readLogTail: (kind: DesktopLogKind) => Promise<DesktopLogSnapshot>
  reportRendererError: (payload: { message: string; stack?: string | null; component_stack?: string | null; route?: string | null }) => Promise<{ status: string }>
  getInboxWindowState: () => Promise<{ open: boolean }>
  pasteText: (payload: { id: string; text: string; options?: { restoreClipboard?: boolean } }) => Promise<PasteResult>
  showNativeNotification: (title: string, body?: string | null) => Promise<{ status: string }>
  toggleInboxWindow: () => Promise<{ open: boolean }>
  closeInboxWindow: () => Promise<{ open: boolean }>
  notifyInboxChanged: () => Promise<{ status: string }>
  writeClipboardText: (text: string) => Promise<{ status: string }>
  pickDomainPackFile: () => Promise<{ status: 'success'; path: string; text: string } | { status: 'cancelled' } | { status: 'error'; message: string }>
  saveDomainPackFile: (suggestedName: string, text: string) => Promise<{ status: 'success'; path: string } | { status: 'cancelled' } | { status: 'error'; message: string }>
  completeWidgetHide: (source: WidgetPresentationSource) => void
  onPasteError: (callback: () => void) => () => void
  onBackendBootState: (callback: (state: BackendBootState) => void) => () => void
  onMlxInstallState: (callback: (state: MlxInstallState) => void) => () => void
  onSemanticMemoryInstallState: (callback: (state: SemanticMemoryInstallState) => void) => () => void
  onCaptureState: (callback: (state: CaptureState) => void) => () => void
  onLocalLiveTranscription: (callback: (state: LiveTranscription | null) => void) => () => void
  onWidgetPresentationCommand: (callback: (command: WidgetPresentationCommand) => void) => () => void
  onInboxWindowState: (callback: (state: { open: boolean }) => void) => () => void
  onInboxChanged: (callback: (state: { changedAt: number }) => void) => () => void
}

export interface CaptureBridge {
  onCommand: (callback: (command: unknown) => void) => () => void
  sendResponse: (requestId: string, payload: unknown) => void
  sendState: (state: CaptureState) => void
  sendChunk: (payload: unknown) => void
  notifyReady: () => void
}
