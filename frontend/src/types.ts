export type RecordingMode = 'dictation' | 'smart_transform'
export type HistoryMode = RecordingMode | 'local_task'
export type WidgetPresentationSource = 'tray' | 'hotkey' | 'idle'
export type PrivacyPane = 'microphone' | 'accessibility' | 'automation'
export type MicrophonePermissionStatus = 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown'
export type DomainMode = 'off' | 'auto' | 'shipping' | 'medical'
export type ActiveDomainSource = 'app_override' | 'global_pin' | 'system_rule'
export type SensitiveTargetMode = 'minimize_context' | 'block_external_text'
export type LiveTranscriptionMode = 'off' | 'auto' | 'local_only' | 'provider_only'

export interface WidgetPresentationCommand {
  visible: boolean
  source: WidgetPresentationSource
}

export type BackendPhase =
  | 'booting_backend'
  | 'ready'
  | 'recording'
  | 'transcribing'
  | 'transforming'
  | 'preparing_paste'
  | 'error'

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
  code_file_name?: string | null
  code_file_extension?: string | null
  surface_kind?: string | null
}

export interface PendingNotification {
  title: string
  body: string | null
}

export interface PendingPaste {
  id: string
  text: string
  restore_clipboard_after_paste: boolean
}

export interface PendingActionReview {
  run_id: string
  action_type: 'open_app' | 'open_url' | 'mail_draft' | 'youtube_open_first_result' | 'youtube_ensure_playing'
  title: string
  summary: string
  script: string
  language: 'applescript'
  status: 'pending' | 'approved' | 'rejected' | 'error'
  error: string | null
}

export interface PendingReviewItem {
  id: string
  run_id: string
  scope: 'local_task' | 'desktop_action'
  kind: 'shell_command' | 'desktop_action' | 'file_edit' | 'task_plan' | 'task_retry'
  title: string
  summary: string
  detail: string | null
  command: string | null
  cwd: string | null
  risk_level: 'low' | 'medium' | 'high'
  status: 'pending' | 'approved' | 'rejected' | 'error'
  error: string | null
  language: 'shell' | 'applescript' | null
  script: string | null
  step_id?: string | null
}

export interface LocalTaskOutputBlock {
  id: string
  stream: 'stdout' | 'stderr' | 'summary'
  text: string
  truncated: boolean
  updated_at: string
}

export interface LocalTaskStep {
  id: string
  kind: 'command' | 'shell_command' | 'desktop_action' | 'review' | 'result'
  title: string
  summary: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'blocked'
  command: string | null
  cwd: string | null
  language?: 'shell' | 'applescript' | null
  script?: string | null
  review_required?: boolean
  execution_mode?: 'auto' | 'reviewed' | null
  action_type?: string | null
  app_name?: string | null
  bundle_id?: string | null
  value_percent?: number | null
  target_label?: string | null
  target_role?: string | null
  ui_index?: number | null
  started_at: string | null
  completed_at: string | null
  exit_code: number | null
  error: string | null
}

export interface LocalTaskResultSummary {
  run_id: string
  title: string
  summary: string
  status: 'pending_review' | 'running' | 'completed' | 'failed' | 'cancelled' | 'blocked'
  command: string | null
  cwd: string | null
  plan_summary?: string | null
  exit_code: number | null
  output_excerpt: string | null
  step_count?: number
  completed_steps?: number
  failed_step_id?: string | null
  failed_step_title?: string | null
  created_at: string
  completed_at: string
  saved_to_history?: boolean
  saved_to_inbox?: boolean
}

export interface LocalTaskRun {
  run_id: string
  request_text: string
  source_intent?: 'local_task' | 'computer_use'
  run_kind?: 'single_step' | 'multi_step'
  title: string
  plan_summary?: string | null
  status: 'pending_review' | 'running' | 'completed' | 'failed' | 'cancelled' | 'blocked'
  command: string | null
  cwd: string
  created_at: string
  updated_at: string
  current_step_id: string | null
  review_required: boolean
  steps: LocalTaskStep[]
  output_blocks: LocalTaskOutputBlock[]
  result_summary: LocalTaskResultSummary | null
  error: string | null
}

export type SmartPreviewState = 'started' | 'streaming' | 'done' | 'error'

export interface SmartPreview {
  run_id: string
  mode: RecordingMode
  state: SmartPreviewState
  text: string
  final_text: string | null
  error: string | null
  smart_profile?: 'default' | 'local_compact' | null
  smart_profile_label?: string | null
  updated_at: string
}

export type LiveTranscriptionState = 'starting' | 'streaming' | 'done' | 'error'
export type LiveTranscriptionSource = 'local' | 'native_local' | 'provider' | 'fallback'

export interface LiveTranscription {
  session_id: string
  mode: RecordingMode
  state: LiveTranscriptionState
  text: string
  source: LiveTranscriptionSource
  is_final: boolean
  updated_at: string
  error: string | null
}

export type CapturedContextQuality = 'full' | 'app_only' | 'transcript_only' | 'empty'

export type KeyStatusMap = Record<string, boolean>

export interface SmartContextAccessStatus {
  status: 'full' | 'app-only' | 'unavailable'
  message: string
  context: SmartContext | null
}

export interface BackendBootState {
  phase: BackendPhase
  label: string
  detail: string
  progress: number | null
}

export type MlxInstallPhase =
  | 'idle'
  | 'checking'
  | 'installing'
  | 'verifying'
  | 'restarting_backend'
  | 'ready'
  | 'error'

export interface MlxInstallState {
  supported: boolean
  installed: boolean
  ffmpeg_available: boolean
  phase: MlxInstallPhase
  label: string
  detail: string
  progress: number | null
  logs: string[]
  can_install: boolean
  venv_available: boolean
}

export type SemanticMemoryInstallPhase =
  | 'idle'
  | 'checking'
  | 'provisioning_runtime'
  | 'installing'
  | 'preparing_model'
  | 'ready'
  | 'fallback'
  | 'repair_needed'
  | 'error'

export interface SemanticMemoryInstallState {
  supported: boolean
  installed: boolean
  python_available: boolean
  python_compatible: boolean
  runtime_source: 'system' | 'managed' | 'development' | 'none'
  python_version: string | null
  python_path: string | null
  sqlite_module: 'pysqlite3' | 'sqlite3' | 'unknown'
  sqlite_version: string | null
  vec_version: string | null
  error_code: string | null
  log_path: string | null
  runtime_path: string | null
  phase: SemanticMemoryInstallPhase
  label: string
  detail: string
  progress: number | null
  logs: string[]
  can_install: boolean
}

export interface AppLaunchContext {
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

export interface ProviderOption {
  id: string
  name: string
  desc: string
  requiresKey?: boolean
}

export interface ProviderModel {
  id: string
  name: string
  loaded?: boolean
  vision?: boolean
  tool_use?: boolean
  reasoning?: boolean
  smart_capable?: boolean
  recommended_for_smart?: boolean
  max_context_length?: number | null
}

export interface ProviderModels {
  llm: Record<string, ProviderModel[]>
  stt: Record<string, ProviderModel[]>
  vision: Record<string, ProviderModel[]>
}

export interface AudioDevice {
  id: string
  label: string
  is_default: boolean
  group_id: string | null
}

export interface MicrophoneAccessInfo {
  status: MicrophonePermissionStatus
  source: 'electron'
}

export interface CaptureState {
  is_recording: boolean
  is_testing: boolean
  mode: RecordingMode | 'mic_test' | null
  phase?: 'idle' | 'starting' | 'recording' | 'stopping'
  amplitude: number
  error: string | null
  active_device_id: string | null
  active_device_label: string | null
  fallback_to_default: boolean
  fallback_notice: string | null
}

export interface CaptureStopResult {
  status: 'success' | 'error'
  audio_base64?: string
  error?: string
  capture_stats?: {
    duration_ms: number
    peak: number
    rms: number
    used_device_id: string | null
    used_device_label: string | null
    fallback_to_default: boolean
    fallback_notice: string | null
  }
}

export type SkillOutputMode = 'plain_text' | 'bullets' | 'command' | 'code'

export interface Skill {
  id: string
  name: string
  prompt: string
  description?: string
  triggers: string[]
  target_types: string[]
  max_chars: number | null
  style: string | null
  fallback_behavior: string
  output_mode: SkillOutputMode
}

export interface SkillReference {
  id: string
  name: string
}

export interface AppSkillDefault {
  id: string
  app_label: string
  bundle_id: string | null
  url_host: string | null
  app_name: string
  skill_id: string
  enabled: boolean
}

export interface AppDomainDefault {
  id: string
  app_label: string
  bundle_id: string | null
  url_host: string | null
  app_name: string
  domain_id: 'shipping' | 'medical'
  enabled: boolean
}

export interface SensitiveTargetRule {
  id: string
  app_label: string
  bundle_id: string | null
  url_host: string | null
  app_name: string
  mode: SensitiveTargetMode
  enabled: boolean
}

export interface DomainControls {
  default_format: 'auto' | 'bullets' | 'paragraph' | 'table'
  default_surface_behavior: 'auto' | 'email' | 'note' | 'summary'
  suppress_external_text: boolean
  minimize_context_capture: boolean
  tone: string
  audience: string
}

export interface GlossaryEntry {
  term: string
  aliases: string[]
  kind: string | null
  priority: number
}

export interface TemplateEntry {
  id: string
  label: string
  intent: string
  body: string
  priority: number
}

export interface ExampleEntry {
  id: string
  label: string
  intent: string
  output: string
  priority: number
}

export interface DomainPackSummary {
  id: 'shipping' | 'medical'
  label: string
  description: string
  documentation_only: boolean
  bundled: boolean
  overlay_present: boolean
  last_imported_at: string | null
  glossary_count: number
  template_count: number
  example_count: number
  controls: DomainControls
}

export interface DomainPackContent {
  glossary: GlossaryEntry[]
  templates: TemplateEntry[]
  examples: ExampleEntry[]
  styles: Record<string, string>
  controls: DomainControls
}

export interface ActiveDomainStatus {
  id: 'shipping' | 'medical'
  label: string
  source: ActiveDomainSource
  rule_id: string | null
  rule_label: string | null
}

export interface DomainControlOverrides {
  default_format?: DomainControls['default_format']
  default_surface_behavior?: DomainControls['default_surface_behavior']
  suppress_external_text?: boolean
  minimize_context_capture?: boolean
  tone?: string
  audience?: string
}

export interface DomainOverlayContent {
  glossary: GlossaryEntry[]
  templates: TemplateEntry[]
  examples: ExampleEntry[]
  styles: Record<string, string>
  controls: DomainControlOverrides
}

export interface DomainPackDetail {
  id: 'shipping' | 'medical'
  label: string
  description: string
  documentation_only: boolean
  default_intent: string
  bundled: boolean
  overlay_present: boolean
  last_imported_at: string | null
  effective: DomainPackContent
  overlay: DomainOverlayContent
}

export interface DictionaryEntry {
  id: number
  canonical_text: string
  aliases: string[]
  enabled: boolean
  updated_at: string
}

export interface ReplacementEntry {
  id: number
  source_text: string
  replacement_text: string
  match_type: 'exact' | 'inline'
  enabled: boolean
  updated_at: string
}

export interface SnippetEntry {
  id: number
  trigger: string
  expansion: string
  match_type: 'exact' | 'inline'
  enabled: boolean
  updated_at: string
}

export interface WritingToolsSnapshot {
  dictionary: DictionaryEntry[]
  replacements: ReplacementEntry[]
  snippets: SnippetEntry[]
}

export interface HistoryItem {
  id: number
  mode: HistoryMode
  transcript: string
  final_output: string
  created_at: string
  telemetry: Partial<SmartRunTelemetry>
  context: Partial<SmartContext>
  stt_provider: string | null
  stt_model: string | null
  llm_provider: string | null
  llm_model: string | null
}

export type MemoryKind =
  | 'writing_preference'
  | 'user_fact'
  | 'person_or_project'
  | 'term_preference'

export interface LearnedMemory {
  id: number
  kind: MemoryKind
  summary: string
  confidence: number
  enabled: boolean
  created_at: string
  updated_at: string
  last_seen_at: string
  evidence_count: number
  source_history_ids: number[]
  app_name: string | null
  url_host: string | null
  domain_id: string | null
}

export interface SmartRunTelemetry {
  intent: string
  lane: 'passthrough' | 'deterministic' | 'llm' | 'refused'
  confidence: number
  ambiguity: number
  reason: string
  requested_skill: SkillReference
  skill_used: SkillReference
  requested_skill_source: 'global_default' | 'app_override' | 'system_rule' | 'domain_forced' | 'history_override'
  requested_app_override_id: string | null
  requested_app_override_label: string | null
  domain_skill_id: string | null
  note_routing_suppressed: boolean
  suppressed_requested_skill_source: 'global_default' | 'app_override' | 'system_rule' | null
  suppressed_requested_app_override_id: string | null
  suppressed_requested_app_override_label: string | null
  fallback_applied: boolean
  fallback_reason: string | null
  output_mode: SkillOutputMode
  deterministic_operations: string[]
  command_operations_applied: string[]
  format_contract: string | null
  surface_contract_applied: boolean
  smart_profile: 'default' | 'local_compact'
  profile_limit_reason: string | null
  provider: string | null
  model: string | null
  domain_id: 'shipping' | 'medical' | null
  domain_source: 'none' | 'app_override' | 'global_pin' | 'system_rule'
  domain_rule_id: string | null
  domain_rule_label: string | null
  domain_intent: string | null
  domain_template_id: string | null
  domain_example_id: string | null
  domain_glossary_hits: string[]
  surface_kind: string | null
  transcript_chars: number
  output_chars: number
  context_quality: CapturedContextQuality
  target_type: string | null
  context_fields_sent: string[]
  browser_enrichment_used: boolean
  external_request_made: boolean
  payload_estimated_bytes: number
  llm_timeout_budget_ms: number | null
  llm_timeout_triggered: boolean
  llm_fallback_applied: boolean
  llm_fallback_reason: string | null
  structured_output_mode: 'none' | 'json_schema'
  structured_output_schema: string | null
  structured_output_failure_kind: 'none' | 'grammar_truncation_error' | 'schema_validation_error' | 'transport_error'
  skill_router_resolver: 'none' | 'local' | 'model'
  skill_router_model_attempted: boolean
  skill_router_model_error: string | null
  skill_router_provider: string | null
  skill_router_model: string | null
  auto_selected_skill_id: string | null
  auto_selected_skill_name: string | null
  auto_selected_skill_reason: string | null
  planner_resolver: 'local' | 'model'
  planner_model_attempted: boolean
  planner_model_error: string | null
  planner_provider: string | null
  planner_model: string | null
  action_route: 'pass_through' | 'save_note' | 'transform_then_paste' | 'transform_then_save_note'
  action_resolver: 'none' | 'local' | 'groq'
  computer_use_trigger?: 'explicit_mode' | 'action_phrase' | null
  computer_use_plan_kind?: 'desktop_action' | 'local_task' | 'multi_step' | 'refusal' | null
  action_review_required?: boolean
  action_execution_mode?: 'none' | 'reviewed' | 'auto'
  external_context_source: 'selection' | 'clipboard' | 'none'
  selection_available: boolean
  selection_used: boolean
  selection_chars: number
  selection_truncated: boolean
  clipboard_available: boolean
  clipboard_used: boolean
  clipboard_chars: number
  clipboard_truncated: boolean
  planner_latency_ms: number
  stt_latency_ms: number | null
  llm_latency_ms: number | null
  total_latency_ms: number | null
  alternatives_available: number
}

export interface InboxNote {
  id: string
  text: string
  created_at: string
  app_name: string
  bundle_id: string | null
  window_title: string | null
  source_mode: HistoryMode
  source_kind: 'spoken_text' | 'selection_text' | 'clipboard_text' | 'transformed_output' | 'task_result'
  output_mode: SkillOutputMode | null
}

export interface HomeReadinessState {
  microphoneReady: boolean
  accessibilityReady: boolean
  dictationProviderReady: boolean
  rewriteProviderReady: boolean
  dictationReady: boolean
  rewriteReady: boolean
}

export interface OnboardingChecklistState {
  microphoneReady: boolean
  accessibilityReady: boolean
  dictationProviderReady: boolean
  dictationTested: boolean
  rewriteProviderReady: boolean
  completed: boolean
}

export interface OnboardingState extends OnboardingChecklistState {
  dictationReady: boolean
  rewriteReady: boolean
}

export type LibraryFilter = 'all' | 'notes' | 'recent_runs'

export type LibraryItem =
  | {
    kind: 'note'
    id: string
    created_at: string
    app_name: string
    window_title: string | null
    output_mode: SkillOutputMode | null
    source_mode: HistoryMode
    source_kind: InboxNote['source_kind']
    preview: string
    search_text: string
    note: InboxNote
  }
  | {
    kind: 'history'
    id: string
    created_at: string
    app_name: string
    window_title: string | null
    output_mode: SkillOutputMode | null
    source_mode: HistoryMode
    preview: string
    search_text: string
    history: HistoryItem
  }

export interface TemplateFormDraft {
  name: string
  what_it_does: string
  best_used_in: 'generic' | 'chat' | 'browser_doc' | 'ide' | 'social_post'
  tone: 'automatic' | 'concise' | 'professional' | 'friendly'
  output_mode: SkillOutputMode
  raw_id: string
  triggers: string
  target_types: string
  max_chars: string
  fallback_behavior: string
  prompt_details: string
}

export interface TemplatePackageManifest {
  id: string
  name: string
  description?: string
  version: number
  triggers: string[]
  target_types: string[]
  max_chars: number | null
  style: string | null
  fallback_behavior: string
  output_mode: SkillOutputMode
}

export interface TemplatePackageDiagnostic {
  id: string | null
  package_path: string
  severity: 'warning' | 'error'
  message: string
}

export interface UsageStats {
  tracking_started_at: string
  dictation_runs: number
  smart_runs: number
  fastest_dictation_stt_ms: number | null
  fastest_smart_stt_ms: number | null
  time_saved_seconds_total: number
}

export interface AppConfig {
  stt: {
    provider: string
    model: string
    language: string
    language_mode: 'fixed' | 'auto'
    preferred_languages: string[]
  }
  llm: {
    provider: string
    model: string
    temperature: number
    routing: {
      enabled: boolean
      provider: string
      model: string
      temperature: number
    }
  }
  vision: {
    enabled: boolean
    model: string | null
    timeout_ms: number
  }
  actions: {
    enabled: boolean
    auto_approve_reviewed: boolean
    experimental_media_controls: boolean
    local_task_shell?: {
      enabled: boolean
      safety_mode: 'strict'
      allowed_directories: string[]
    }
  }
  hotkeys: {
    default_skill_id: string
    app_skill_defaults: AppSkillDefault[]
  }
  domains: {
    mode: DomainMode
    app_domain_defaults: AppDomainDefault[]
  }
  audio: {
    input_device: string | null
    input_device_id: string | null
    input_device_label: string | null
    enable_recording_cues: boolean
    live_transcription_mode?: LiveTranscriptionMode
  }
  privacy: {
    restore_clipboard_after_paste: boolean
    minimize_sensitive_context: boolean
    sensitive_targets: SensitiveTargetRule[]
  }
  debug: {
    log_sensitive_transcripts: boolean
    persist_recordings: boolean
  }
  memory: {
    enabled: boolean
    auto_learn_from_history: boolean
    semantic_retrieval_enabled: boolean
  }
}

export interface BackendStatus {
  backend_ready: boolean
  is_recording: boolean
  is_processing: boolean
  active_mode: RecordingMode | null
  active_skill: string
  audio_amplitude: number
  last_error: string | null
  pending_paste_text: string | null
  pending_paste: PendingPaste | null
  pending_notification: PendingNotification | null
  missing_api_keys: boolean
  recording_cues_enabled: boolean
  restore_clipboard_after_paste: boolean
  phase: BackendPhase
  phase_label: string
  captured_context: SmartContext
  captured_context_at: string | null
  captured_context_quality: CapturedContextQuality
  active_domain?: ActiveDomainStatus | null
  target_type: string | null
  context_warning: string | null
  last_smart_run: SmartRunTelemetry | null
  smart_preview?: SmartPreview | null
  pending_action_review?: PendingActionReview | null
  pending_review?: PendingReviewItem | null
  active_task_run?: LocalTaskRun | null
  task_result_summary?: LocalTaskResultSummary | null
  live_transcription?: LiveTranscription | null
  local_stt?: LocalSttRuntimeStatus | null
  pipeline_timings: RuntimePipelineTimings
}

export interface LocalSttRuntimeStatus {
  runtime_mode: 'bundled' | 'development'
  runtime_ready: boolean
  ffmpeg_available: boolean
  ffmpeg_source: 'bundled' | 'system' | 'missing'
  selected_model: string
  selected_model_ready: boolean
  detail: string
}

export interface RuntimePipelineTimings {
  button_down?: string | null
  capture_started?: string | null
  first_partial?: string | null
  stop_pressed?: string | null
  record_start: string | null
  stt_done: string | null
  route_done: string | null
  transform_done: string | null
  paste_ack_done: string | null
}

export type LocalEnvironmentStatus = 'idle' | 'checking' | 'verifying' | 'ready' | 'stale' | 'error'
export type LocalEnvironmentVerificationTarget = 'microphone' | 'accessibility' | 'context' | 'all' | null

export interface LocalEnvironmentState {
  status: LocalEnvironmentStatus
  error: string | null
  updatedAt: number | null
  microphoneAccess: MicrophonePermissionStatus
  accessibilityTrusted: boolean
  contextAccess: SmartContextAccessStatus
  verifyingTarget: LocalEnvironmentVerificationTarget
}

export type RuntimeInvalidateScope =
  | 'config'
  | 'providers'
  | 'history'
  | 'tasks'
  | 'inbox'
  | 'skills'
  | 'domains'
  | 'writing_tools'
  | 'usage'

export type TransportConnectionState = 'connecting' | 'connected' | 'stale' | 'error'

export type RuntimeEventType =
  | 'snapshot'
  | 'status'
  | 'usage'
  | 'pending_paste'
  | 'notification'
  | 'smart_preview'
  | 'pending_action_review'
  | 'pending_review'
  | 'active_task_run'
  | 'task_result_summary'
  | 'live_transcription'
  | 'history_invalidated'
  | 'task_runs_invalidated'
  | 'inbox_invalidated'
  | 'skills_invalidated'
  | 'domains_invalidated'
  | 'writing_tools_invalidated'
  | 'config_changed'
  | 'providers_changed'
  | 'heartbeat'

export type RuntimeRevisionMap = Record<RuntimeInvalidateScope, number>

export interface RuntimeSnapshot {
  status: BackendStatus | null
  config: AppConfig | null
  keysSet: KeyStatusMap
  providerModels: ProviderModels | null
  usageStats: UsageStats | null
  revisions: RuntimeRevisionMap
}

export interface RuntimeStoreState {
  connectionState: TransportConnectionState
  connectionError: string | null
  hasSnapshot: boolean
  lastEventAt: number | null
  connectedAt: number | null
  lastAppliedSeq: number
  invalidationTokens: Record<RuntimeInvalidateScope, number>
  snapshot: RuntimeSnapshot
  localEnvironment: LocalEnvironmentState
}

export interface RuntimeAttentionIssue {
  label: string
  detail: string
  tone: 'good' | 'warn' | 'danger' | 'neutral'
  step: 'voice' | 'rewrite' | 'privacy'
}

export interface ActiveWorkState {
  kind: 'booting' | 'disconnected' | 'processing' | 'idle' | 'attention'
  label: string
  detail: string
  busy: boolean
}

export interface RuntimeEventEnvelope<T = unknown> {
  seq: number
  type: RuntimeEventType
  data: T
  emitted_at: number
}

export interface SectionLoadState {
  status: 'idle' | 'loading' | 'ready' | 'stale' | 'error'
  error: string | null
  stale: boolean
  updatedAt: number | null
}

export interface PasteResult {
  status: 'pasted' | 'copied' | 'failed'
  detail: string | null
}
