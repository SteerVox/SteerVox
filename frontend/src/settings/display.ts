import { DISPLAY_NAME } from '../../shared/branding'
import { formatProviderDisplayName } from '../lib/providerLabels'
import type {
  BackendStatus,
  DomainMode,
  ProviderModel,
  SemanticMemoryInstallState,
} from '../types'
import { WHISPER_LANGUAGE_LABELS } from './constants'

export function formatPlannerResolverLabel(lastSmartRun: { planner_resolver: 'local' | 'model'; planner_provider: string | null; planner_model: string | null }) {
  if (lastSmartRun.planner_resolver !== 'model') return 'Local rules'
  const provider = lastSmartRun.planner_provider?.trim()
  const model = lastSmartRun.planner_model?.trim()
  if (provider && model) return `${provider} • ${model}`
  if (model) return model
  return 'Model-assisted'
}

export function formatProviderName(providerId: string) {
  return formatProviderDisplayName(providerId)
}

export function formatProviderModelLabel(model: ProviderModel, provider: string) {
  if (provider !== 'lmstudio') return model.name

  const suffixes: string[] = []
  if (model.recommended_for_smart) {
    suffixes.push('recommended')
  }
  if (model.loaded === false) {
    suffixes.push('not loaded')
  }
  return suffixes.length ? `${model.name} (${suffixes.join(', ')})` : model.name
}

export function formatLanguageLabel(code: string | null | undefined) {
  const normalized = code?.trim().toLowerCase() || ''
  if (!normalized) return 'English'
  return WHISPER_LANGUAGE_LABELS.get(normalized) || `Saved language (${normalized.toUpperCase()})`
}

export function describeSemanticMemoryUi(
  enabled: boolean,
  state: SemanticMemoryInstallState,
): { label: string; tone: 'good' | 'warn' | 'danger' | 'neutral'; detail: string } {
  if (!enabled) {
    return {
      label: 'Disabled',
      tone: 'neutral',
      detail: 'Lexical local memory remains available, but semantic retrieval is turned off in Settings.',
    }
  }
  if (state.phase === 'ready' && state.installed) {
    return {
      label: 'Ready',
      tone: 'good',
      detail: 'Semantic retrieval is installed and will improve paraphrase matching for local memory.',
    }
  }
  if (state.phase === 'repair_needed') {
    return {
      label: 'Repair needed',
      tone: 'warn',
      detail: state.detail,
    }
  }
  if (state.phase === 'error') {
    return {
      label: 'Error',
      tone: 'danger',
      detail: state.detail,
    }
  }
  if (state.phase === 'installing' || state.phase === 'preparing_model' || state.phase === 'provisioning_runtime' || state.phase === 'checking') {
    return {
      label: state.phase === 'provisioning_runtime' ? 'Provisioning runtime' : 'Installing',
      tone: 'warn',
      detail: state.detail,
    }
  }
  return {
    label: 'Fallback',
    tone: 'warn',
    detail: state.detail,
  }
}

export function formatSemanticMemoryInstallerLabel(state: SemanticMemoryInstallState) {
  if (state.runtime_source === 'managed') {
    return state.python_version ? `Managed Python ${state.python_version}` : 'Managed runtime'
  }
  if (state.runtime_source === 'development') {
    return state.python_version ? `Dev Python ${state.python_version}` : 'Development runtime'
  }
  if (!state.python_available) return 'Managed fallback available'
  if (!state.python_compatible) return state.python_version ? `Python ${state.python_version} unsupported` : 'Python unsupported'
  if (state.python_version) return `System Python ${state.python_version}`
  return 'Python ready'
}

export function buildSemanticMemoryDiagnostics(state: SemanticMemoryInstallState) {
  return [
    `Semantic retrieval status: ${state.label}`,
    `Phase: ${state.phase}`,
    `Runtime source: ${state.runtime_source}`,
    `Python version: ${state.python_version ?? 'unknown'}`,
    `Python path: ${state.python_path ?? 'not set'}`,
    `SQLite module: ${state.sqlite_module}`,
    `SQLite version: ${state.sqlite_version ?? 'unknown'}`,
    `sqlite-vec version: ${state.vec_version ?? 'unknown'}`,
    `Error code: ${state.error_code ?? 'none'}`,
    `Detail: ${state.detail}`,
    `Runtime path: ${state.runtime_path ?? 'not set'}`,
    `Log path: ${state.log_path ?? 'not set'}`,
    '',
    'Recent semantic logs:',
    ...(state.logs.length ? state.logs : ['No semantic runtime logs recorded yet.']),
  ].join('\n')
}

export function formatQualityLabel(quality: BackendStatus['captured_context_quality']) {
  if (quality === 'full') return 'Ready'
  if (quality === 'app_only') return 'App only'
  if (quality === 'transcript_only') return 'Transcript only'
  return 'Not available'
}

export function formatQualityTone(quality: BackendStatus['captured_context_quality']) {
  if (quality === 'full') return 'good' as const
  if (quality === 'app_only') return 'warn' as const
  if (quality === 'transcript_only') return 'danger' as const
  return 'neutral' as const
}

export function formatTargetType(targetType: string | null | undefined) {
  if (!targetType) return 'Generic'
  return targetType.replace(/_/g, ' ')
}

export function formatCapturedAt(value: string | null | undefined) {
  if (!value) return 'Not available'
  try {
    return new Date(value).toLocaleString()
  } catch {
    return value
  }
}

export function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`
}

export function formatDuration(value: number | null | undefined) {
  if (value == null) return 'Not used'
  return `${value} ms`
}

export function formatDomainMode(value: DomainMode) {
  if (value === 'off') return 'Off'
  if (value === 'auto') return 'Auto'
  if (value === 'shipping') return 'Shipping'
  return 'Medical'
}

export function formatDomainSource(value: 'none' | 'app_override' | 'global_pin' | 'system_rule') {
  if (value === 'app_override') return 'Per-target override'
  if (value === 'global_pin') return 'Pinned domain'
  if (value === 'system_rule') return 'Starter rule'
  return 'No active domain'
}

export function formatDomainLabel(value: string | null | undefined) {
  if (value === 'shipping') return 'Shipping'
  if (value === 'medical') return 'Medical'
  return 'None'
}

export function formatDomainFormat(value: 'auto' | 'bullets' | 'paragraph' | 'table') {
  if (value === 'bullets') return 'Bullets'
  if (value === 'paragraph') return 'Paragraph'
  if (value === 'table') return 'Table'
  return 'Auto'
}

export function formatDomainSurfaceBehavior(value: 'auto' | 'email' | 'note' | 'summary') {
  if (value === 'email') return 'Email'
  if (value === 'note') return 'Note'
  if (value === 'summary') return 'Summary'
  return 'Auto'
}

export function describeDomainMode(value: DomainMode) {
  if (value === 'off') return 'No domain memory or templates are applied.'
  if (value === 'auto') return `${DISPLAY_NAME} infers Shipping or Medical from the active app, site, or window title.`
  if (value === 'shipping') return 'Shipping stays active until you switch back, regardless of the current app.'
  return 'Medical stays active until you switch back. This pack is documentation assistance only.'
}

export function formatTimeSaved(seconds: number) {
  if (seconds <= 0) return '0 min'
  if (seconds < 60) return '<1 min'

  const totalMinutes = Math.round(seconds / 60)
  if (totalMinutes < 60) return `${totalMinutes} min`

  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`
}

export function formatTrackingDate(value: string | null | undefined) {
  if (!value) return 'today'
  try {
    return new Date(value).toLocaleDateString()
  } catch {
    return value
  }
}

export function formatSkillSource(value: 'global_default' | 'app_override' | 'system_rule' | 'domain_forced' | 'history_override') {
  if (value === 'domain_forced') return 'Domain pack'
  if (value === 'history_override') return 'History rerun'
  if (value === 'app_override') return 'Per-target override'
  if (value === 'system_rule') return 'Starter routing rule'
  return 'Global default'
}

export function formatActionRoute(value: 'pass_through' | 'save_note' | 'transform_then_paste' | 'transform_then_save_note') {
  if (value === 'save_note') return 'Save note'
  if (value === 'transform_then_save_note') return 'Transform then save'
  if (value === 'transform_then_paste') return 'Transform then paste'
  return 'Pass through'
}

export function formatExternalContextSource(value: 'selection' | 'clipboard' | 'none') {
  if (value === 'selection') return 'Selection'
  if (value === 'clipboard') return 'Clipboard'
  return 'None'
}
