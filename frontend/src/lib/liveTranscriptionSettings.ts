import type { LiveTranscriptionMode } from '../types'

export type LiveTranscriptionControlValue = 'enabled' | 'off'

export type LiveTranscriptionUiState = {
  supportsLivePreview: boolean
  controlValue: LiveTranscriptionControlValue
  capabilityLabel: string
  capabilityTone: 'good' | 'warn' | 'neutral'
  detail: string
  help: string
}

const PROVIDER_STREAMING_PROVIDERS = new Set(['openai', 'deepgram'])

function normalizeProvider(provider: string) {
  return String(provider || '').trim().toLowerCase()
}

function formatProviderName(provider: string) {
  const normalized = normalizeProvider(provider)
  if (normalized === 'openai') return 'OpenAI'
  if (normalized === 'deepgram') return 'Deepgram'
  if (normalized === 'mlx-whisper') return 'MLX Whisper'
  if (!normalized) return 'This provider'
  return normalized.charAt(0).toUpperCase() + normalized.slice(1)
}

export function providerSupportsLivePreview(provider: string) {
  return PROVIDER_STREAMING_PROVIDERS.has(normalizeProvider(provider))
}

export function getLiveTranscriptionControlValue(rawMode: LiveTranscriptionMode | null | undefined): LiveTranscriptionControlValue {
  return rawMode === 'off' ? 'off' : 'enabled'
}

export function mapLiveTranscriptionControlValue(nextValue: LiveTranscriptionControlValue): LiveTranscriptionMode {
  return nextValue === 'off' ? 'off' : 'auto'
}

export function deriveLiveTranscriptionUiState({
  provider,
  rawMode,
}: {
  provider: string
  rawMode: LiveTranscriptionMode | null | undefined
}): LiveTranscriptionUiState {
  const providerName = formatProviderName(provider)
  const controlValue = getLiveTranscriptionControlValue(rawMode)
  const supportsLivePreview = providerSupportsLivePreview(provider)

  if (supportsLivePreview) {
    return {
      supportsLivePreview: true,
      controlValue,
      capabilityLabel: controlValue === 'enabled' ? 'Provider preview on' : 'Preview off',
      capabilityTone: controlValue === 'enabled' ? 'good' : 'neutral',
      detail: controlValue === 'enabled'
        ? `Shows a running transcript in VGet while ${providerName} finalizes speech in the background.`
        : 'Turns off the in-widget live transcript and waits for the final transcript after you stop.',
      help: 'Dictate shows exactly what will be pasted. Smart shows the live transcript first and rewrites it after you stop.',
    }
  }

  return {
    supportsLivePreview: false,
    controlValue,
    capabilityLabel: controlValue === 'off' ? 'Preview unavailable' : 'Final transcript only',
    capabilityTone: controlValue === 'off' ? 'neutral' : 'warn',
    detail: `${providerName} does not currently provide a working live in-widget transcript preview. Dictate and Smart stay on the final transcript path after you stop.`,
    help: 'Switch to OpenAI or Deepgram if you want a live transcript preview in VGet. Older preview mode selections are ignored for unsupported providers.',
  }
}
