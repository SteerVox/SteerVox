const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  anthropic: 'Anthropic',
  deepgram: 'Deepgram',
  gemini: 'Gemini',
  groq: 'Groq',
  lmstudio: 'LM Studio',
  local: 'Local',
  'mlx-whisper': 'MLX Whisper',
  nvidia: 'NVIDIA',
  openai: 'OpenAI',
  sarvam: 'Sarvam',
}

const KEYLESS_PROVIDER_IDS = new Set(['local', 'lmstudio', 'mlx-whisper'])

function normalizeProviderId(provider: string) {
  return String(provider || '').trim().toLowerCase()
}

export function formatProviderDisplayName(provider: string) {
  const normalized = normalizeProviderId(provider)
  if (!normalized) return 'Unknown'
  return PROVIDER_DISPLAY_NAMES[normalized]
    || `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`
}

export function providerRequiresKey(provider: string) {
  return !KEYLESS_PROVIDER_IDS.has(normalizeProviderId(provider))
}

export function isLocalProvider(provider: string) {
  return KEYLESS_PROVIDER_IDS.has(normalizeProviderId(provider))
}
