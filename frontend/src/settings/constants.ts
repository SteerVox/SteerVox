import type { DomainMode, ProviderOption } from '../types'
import type { SettingsStepRoute } from '../lib/routes'

export type StepId = SettingsStepRoute

export type OnboardingStepId =
  | 'install'
  | 'microphone'
  | 'accessibility'
  | 'providers'
  | 'dictation_test'
  | 'smart_provider'
  | 'smart_test'
  | 'complete'

export type SupportedLanguageOption = {
  code: string
  label: string
}

export const STEPS: Array<{ id: StepId; label: string; eyebrow: string }> = [
  { id: 'access', label: 'Access', eyebrow: 'Connect' },
  { id: 'voice', label: 'Voice', eyebrow: 'Capture' },
  { id: 'rewrite', label: 'Smart', eyebrow: 'Output' },
  { id: 'privacy', label: 'Privacy', eyebrow: 'Control' },
  { id: 'advanced', label: 'Advanced', eyebrow: 'Utility' },
]

export const STEP_DETAILS: Record<StepId, { title: string; description: string }> = {
  voice: {
    title: 'Voice',
    description: 'Permissions, dictation provider, mic, and cues.',
  },
  rewrite: {
    title: 'Smart',
    description: 'Models, templates, and routing.',
  },
  access: {
    title: 'Access',
    description: 'API keys and saved cloud provider access.',
  },
  privacy: {
    title: 'Privacy',
    description: 'Context access and sensitive-target rules.',
  },
  advanced: {
    title: 'Advanced',
    description: 'Diagnostics, domains, history, and recovery.',
  },
}

export const PROVIDERS: { llm: ProviderOption[]; stt: ProviderOption[] } = {
  llm: [
    { id: 'lmstudio', name: 'LM Studio', desc: 'Local Smart models over LM Studio (default)', requiresKey: false },
    { id: 'groq', name: 'Groq', desc: 'Fastest response', requiresKey: true },
    { id: 'openai', name: 'OpenAI', desc: 'GPT models', requiresKey: true },
    { id: 'anthropic', name: 'Anthropic', desc: 'Claude models', requiresKey: true },
    { id: 'gemini', name: 'Gemini', desc: 'Google Gemini models', requiresKey: true },
    { id: 'nvidia', name: 'NVIDIA', desc: 'Hosted NIM and partner models', requiresKey: true },
    { id: 'sarvam', name: 'Sarvam', desc: 'Indic-first multilingual chat models', requiresKey: true },
  ],
  stt: [
    { id: 'mlx-whisper', name: 'MLX Whisper', desc: 'Local speech recognition on Apple Silicon (default)', requiresKey: false },
    { id: 'groq', name: 'Groq', desc: 'Whisper on Groq', requiresKey: true },
    { id: 'openai', name: 'OpenAI', desc: 'OpenAI Whisper', requiresKey: true },
    { id: 'deepgram', name: 'Deepgram', desc: 'Nova models', requiresKey: true },
    { id: 'nvidia', name: 'NVIDIA', desc: 'Hosted Riva speech models', requiresKey: true },
    { id: 'sarvam', name: 'Sarvam', desc: 'Indic-first speech recognition', requiresKey: true },
  ],
}

export const API_KEY_PROVIDERS = ['groq', 'openai', 'anthropic', 'deepgram', 'gemini', 'nvidia', 'sarvam'] as const
export type ApiKeyProviderId = typeof API_KEY_PROVIDERS[number]

export const WHISPER_LANGUAGE_OPTIONS: SupportedLanguageOption[] = [
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'Hindi' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'it', label: 'Italian' },
  { code: 'nl', label: 'Dutch' },
  { code: 'bn', label: 'Bengali' },
  { code: 'ta', label: 'Tamil' },
  { code: 'te', label: 'Telugu' },
  { code: 'ur', label: 'Urdu' },
  { code: 'ar', label: 'Arabic' },
  { code: 'tr', label: 'Turkish' },
  { code: 'ru', label: 'Russian' },
  { code: 'zh', label: 'Chinese' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
]

export const WHISPER_LANGUAGE_LABELS = new Map(WHISPER_LANGUAGE_OPTIONS.map((option) => [option.code, option.label]))

export const DICTIONARY_EXAMPLES = [
  { spoken: 'sea quay well', saved: 'SQL' },
  { spoken: 'med gemma', saved: 'MedGemma' },
  { spoken: 'bill of lading', saved: 'B/L' },
] as const

export const PROVIDER_OPTIONS_BY_ID = new Map<string, ProviderOption>([
  ...PROVIDERS.llm,
  ...PROVIDERS.stt,
].map((option) => [option.id, option]))

export function isApiKeyProviderId(value: string): value is ApiKeyProviderId {
  return API_KEY_PROVIDERS.includes(value as ApiKeyProviderId)
}

export function buildDomainGuidance(domainId: 'shipping' | 'medical') {
  if (domainId === 'shipping') {
    return {
      vocabulary: 'Add carrier names, shipment terms, ports, and internal abbreviations. Aliases should be the spoken form or the common mishearing. The saved term is the final wording you want pasted.',
      template: 'Use templates for repeated outputs like delay notices, shift handoffs, and customer updates.',
      example: 'Use examples to show the tone and structure a strong shipping update should follow.',
      sampleTerms: ['Spoken as `blue anchor`, save as `Blue Anchor Lines`', 'Spoken as `B O L`, save as `B/L`'],
    }
  }

  return {
    vocabulary: 'Add drug names, departments, shorthand, and note phrases. Aliases should capture how you say the term or how speech recognition often misses it.',
    template: 'Use templates for recurring note shapes like follow-up summaries, care team updates, and discharge drafts.',
    example: 'Use examples to demonstrate the exact level of structure and documentation style you want.',
    sampleTerms: ['Spoken as `med gemma`, save as `MedGemma`', 'Spoken as `ROS`, save as `ROS` and list any expanded aliases you use aloud'],
  }
}

export function formatAliases(aliases: string[]) {
  return aliases.join(', ')
}

export function parseAliases(value: string) {
  return value
    .split(',')
    .map((segment) => segment.trim())
    .filter(Boolean)
}

export function buildLanguageOptions(selectedCodes: string[]) {
  const knownCodes = new Set(WHISPER_LANGUAGE_OPTIONS.map((option) => option.code))
  const extras = selectedCodes
    .map((value) => value.trim().toLowerCase())
    .filter((value, index, items) => Boolean(value) && items.indexOf(value) === index && !knownCodes.has(value))
    .map((code) => ({ code, label: WHISPER_LANGUAGE_LABELS.get(code) || `Saved language (${code.toUpperCase()})` }))

  return [...extras, ...WHISPER_LANGUAGE_OPTIONS]
}

export const DOMAIN_MODES = ['off', 'auto', 'shipping', 'medical'] as const satisfies readonly DomainMode[]
