export type LiveTranscriptionMode = 'off' | 'auto' | 'local_only' | 'provider_only'
export type LiveTranscriptionStrategy = 'disabled' | 'backend_provider' | 'native_local'

export type LiveTranscriptionConfig = {
  provider: string
  liveTranscriptionMode?: LiveTranscriptionMode | null
}

export type StableLivePreviewState = {
  committedText: string
  provisionalText: string
}

const PROVIDER_STREAMING_PROVIDERS = new Set(['openai', 'deepgram'])

function normalizeText(value: string | null | undefined) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
}

function joinText(left: string, right: string) {
  const normalizedLeft = normalizeText(left)
  const normalizedRight = normalizeText(right)
  if (!normalizedLeft) return normalizedRight
  if (!normalizedRight) return normalizedLeft
  return `${normalizedLeft} ${normalizedRight}`.trim()
}

function removeLeadingPrefix(text: string, prefix: string) {
  const normalizedText = normalizeText(text)
  const normalizedPrefix = normalizeText(prefix)
  if (!normalizedPrefix) return normalizedText
  if (normalizedText === normalizedPrefix) return ''
  if (normalizedText.startsWith(`${normalizedPrefix} `)) {
    return normalizedText.slice(normalizedPrefix.length).trim()
  }
  if (normalizedText.startsWith(normalizedPrefix)) {
    return normalizedText.slice(normalizedPrefix.length).trim()
  }
  return normalizedText
}

function longestStableWordPrefix(previous: string, next: string) {
  const leftWords = normalizeText(previous).split(' ').filter(Boolean)
  const rightWords = normalizeText(next).split(' ').filter(Boolean)
  const stableWords: string[] = []

  for (let index = 0; index < Math.min(leftWords.length, rightWords.length); index += 1) {
    if (leftWords[index] !== rightWords[index]) {
      break
    }
    stableWords.push(leftWords[index])
  }

  return stableWords.join(' ')
}

export function resolveLiveTranscriptionStrategy(config: LiveTranscriptionConfig): LiveTranscriptionStrategy {
  const provider = normalizeText(config.provider).toLowerCase()
  const liveMode = normalizeText(config.liveTranscriptionMode || 'auto').toLowerCase() as LiveTranscriptionMode

  if (!provider || liveMode === 'off') {
    return 'disabled'
  }

  if (liveMode === 'provider_only') {
    return PROVIDER_STREAMING_PROVIDERS.has(provider) ? 'backend_provider' : 'disabled'
  }

  if (liveMode === 'local_only') {
    return 'disabled'
  }

  if (PROVIDER_STREAMING_PROVIDERS.has(provider)) {
    return 'backend_provider'
  }

  return 'disabled'
}

export function applyStablePreviewText(
  current: StableLivePreviewState,
  incomingText: string | null | undefined,
): StableLivePreviewState {
  const normalizedIncoming = normalizeText(incomingText)
  if (!normalizedIncoming) {
    return current
  }

  const committedText = normalizeText(current.committedText)
  const previousTail = normalizeText(current.provisionalText)
  const currentTail = removeLeadingPrefix(normalizedIncoming, committedText)

  if (!previousTail) {
    return {
      committedText,
      provisionalText: currentTail,
    }
  }

  if (currentTail === previousTail) {
    return {
      committedText,
      provisionalText: currentTail,
    }
  }

  const stablePrefix = longestStableWordPrefix(previousTail, currentTail)
  if (!stablePrefix) {
    return {
      committedText,
      provisionalText: currentTail,
    }
  }

  return {
    committedText: joinText(committedText, stablePrefix),
    provisionalText: removeLeadingPrefix(currentTail, stablePrefix),
  }
}

export function formatStablePreviewText(state: StableLivePreviewState) {
  return joinText(state.committedText, state.provisionalText)
}
