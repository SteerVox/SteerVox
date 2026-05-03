import type { AppConfig, ProviderModel, ProviderModels } from '../types'

export type ProviderSection = 'llm' | 'stt'

const DEFAULT_LMSTUDIO_MODEL_ID = 'google/gemma-4-e4b'
const DEFAULT_NVIDIA_LLM_MODEL_ID = 'minimaxai/minimax-m2.7'

const PREFERRED_PROVIDER_MODELS: Record<ProviderSection, Record<string, string>> = {
  llm: {
    lmstudio: DEFAULT_LMSTUDIO_MODEL_ID,
    nvidia: DEFAULT_NVIDIA_LLM_MODEL_ID,
    sarvam: 'sarvam-30b',
  },
  stt: {
    groq: 'whisper-large-v3-turbo',
    openai: 'whisper-1',
    deepgram: 'nova-2',
    nvidia: 'openai/whisper-large-v3',
    sarvam: 'saaras:v3',
    'mlx-whisper': 'mlx-community/whisper-large-v3-turbo',
  },
}

export function resolvePreferredProviderModel(section: ProviderSection, provider: string, models: ProviderModel[]) {
  if (section === 'llm' && provider === 'lmstudio') {
    const defaultModel = models.find((model) => model.id === DEFAULT_LMSTUDIO_MODEL_ID)
    if (defaultModel) return defaultModel.id
    return DEFAULT_LMSTUDIO_MODEL_ID
  }

  const preferredModelId = PREFERRED_PROVIDER_MODELS[section][provider]
  if (preferredModelId) {
    const preferredModel = models.find((model) => model.id === preferredModelId)
    if (preferredModel) return preferredModel.id
  }
  return models[0]?.id || ''
}

export function applyProviderSelection(
  draftConfig: AppConfig,
  providerModels: ProviderModels,
  section: ProviderSection,
  newProvider: string,
): AppConfig {
  const models = section === 'llm'
    ? providerModels.llm?.[newProvider] || []
    : providerModels.stt?.[newProvider] || []
  const nextModel = resolvePreferredProviderModel(section, newProvider, models)

  return {
    ...draftConfig,
    [section]: {
      ...draftConfig[section],
      provider: newProvider,
      model: nextModel,
    },
    ...(section === 'llm'
      ? {
          llm: {
            ...draftConfig.llm,
            provider: newProvider,
            model: nextModel,
            routing: {
              ...draftConfig.llm.routing,
              provider: newProvider,
              model: nextModel,
            },
          },
        }
      : {}),
  }
}

export function applyModelSelection(
  draftConfig: AppConfig,
  section: ProviderSection,
  newModel: string,
): AppConfig {
  if (section === 'llm') {
    return {
      ...draftConfig,
      llm: {
        ...draftConfig.llm,
        model: newModel,
        routing: {
          ...draftConfig.llm.routing,
          provider: draftConfig.llm.provider,
          model: newModel,
        },
      },
    }
  }

  return {
    ...draftConfig,
    stt: {
      ...draftConfig.stt,
      model: newModel,
    },
  }
}

export function applyApiKeyProviderSelection(draftConfig: AppConfig, nextApiProvider: string) {
  return {
    nextApiProvider,
    nextDraftConfig: draftConfig,
  }
}
