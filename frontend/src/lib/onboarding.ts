import { DISPLAY_NAME } from '../../shared/branding'
import type {
  AppConfig,
  BackendStatus,
  KeyStatusMap,
  MlxInstallState,
  ProviderModels,
  UsageStats,
} from '../types'
import { formatProviderDisplayName, providerRequiresKey } from './providerLabels'

function hasCloudProviderAccess(provider: string, keysSet: KeyStatusMap) {
  return !providerRequiresKey(provider) || Boolean(keysSet[provider])
}

function isLmStudioModelReady(config: AppConfig, providerModels: ProviderModels | null | undefined) {
  const models = providerModels?.llm?.lmstudio || []
  if (!models.length) return false
  const selectedModel = models.find((model) => model.id === config.llm.model)
  if (!selectedModel) return false
  if (selectedModel.discovered === false) return false
  return true
}

function isMlxWhisperReady(status: BackendStatus | null | undefined, mlxInstallState: MlxInstallState | null | undefined) {
  const packagedLocalStt = status?.local_stt
  if (packagedLocalStt) {
    return packagedLocalStt.runtime_ready && packagedLocalStt.ffmpeg_available
  }

  if (!mlxInstallState) {
    return false
  }

  return Boolean(mlxInstallState.installed && mlxInstallState.ffmpeg_available)
}

function resolveDictationProviderReady(
  config: AppConfig,
  keysSet: KeyStatusMap,
  status: BackendStatus | null | undefined,
  mlxInstallState: MlxInstallState | null | undefined,
) {
  if (config.stt.provider === 'mlx-whisper') {
    return isMlxWhisperReady(status, mlxInstallState)
  }

  return hasCloudProviderAccess(config.stt.provider, keysSet)
}

function resolveRewriteProviderReady(
  config: AppConfig,
  keysSet: KeyStatusMap,
  providerModels: ProviderModels | null | undefined,
) {
  if (config.llm.provider === 'lmstudio') {
    return isLmStudioModelReady(config, providerModels)
  }

  return hasCloudProviderAccess(config.llm.provider, keysSet)
}

function describeDictationProvider(
  config: AppConfig,
  ready: boolean,
  status: BackendStatus | null | undefined,
  mlxInstallState: MlxInstallState | null | undefined,
) {
  const providerLabel = formatProviderDisplayName(config.stt.provider)
  if (providerRequiresKey(config.stt.provider)) {
    return ready
      ? `${providerLabel} is configured and ready for Dictate.`
      : `${providerLabel} needs an API key before Dictate can run.`
  }

  if (config.stt.provider === 'mlx-whisper') {
    const packagedLocalStt = status?.local_stt
    if (packagedLocalStt?.runtime_ready && packagedLocalStt.ffmpeg_available && packagedLocalStt.selected_model_ready === false) {
      return `${providerLabel} is ready locally. The selected model downloads on first use.`
    }

    if (ready) {
      return `${providerLabel} is ready locally on this Mac.`
    }

    if (packagedLocalStt?.detail) {
      return packagedLocalStt.detail
    }

    if (mlxInstallState?.detail) {
      return mlxInstallState.detail
    }

    return `${providerLabel} still needs its local runtime setup.`
  }

  return ready
    ? `${providerLabel} is ready locally on this Mac.`
    : `${providerLabel} still needs local setup.`
}

function describeRewriteProvider(
  config: AppConfig,
  ready: boolean,
  providerModels: ProviderModels | null | undefined,
) {
  const providerLabel = formatProviderDisplayName(config.llm.provider)
  if (providerRequiresKey(config.llm.provider)) {
    return ready
      ? `${providerLabel} is configured and ready for Smart.`
      : `${providerLabel} needs an API key before Smart can run.`
  }

  if (config.llm.provider === 'lmstudio') {
    const models = providerModels?.llm?.lmstudio || []
    const selectedModel = models.find((model) => model.id === config.llm.model)
    if (ready) {
      if (selectedModel?.loaded === false) {
        return `${providerLabel} is ready with ${selectedModel.name}. ${DISPLAY_NAME} will ask LM Studio to load it automatically when Smart runs.`
      }
      return `${providerLabel} is ready with ${selectedModel?.name || 'the selected local model'}.`
    }
    if (!selectedModel) {
      return `${providerLabel} does not currently expose the selected Smart model. Refresh the local catalog or choose another model.`
    }
    if (selectedModel.discovered === false) {
      return `${providerLabel} is not currently reachable. Start LM Studio and refresh the local catalog.`
    }
    if (selectedModel.loaded === false) {
      return `${providerLabel} found the selected model, but Smart could not confirm it is usable yet. ${DISPLAY_NAME} will try to auto-load it on demand.`
    }
    return `${providerLabel} still needs the selected local model to be available.`
  }

  return ready
    ? `${providerLabel} is ready locally on this Mac.`
    : `${providerLabel} still needs local setup.`
}

export function computeReadiness(
  config: AppConfig,
  keysSet: KeyStatusMap,
  microphoneAccess: string,
  accessibilityTrusted: boolean,
  providerModels: ProviderModels | null = null,
  status: BackendStatus | null = null,
  mlxInstallState: MlxInstallState | null = null,
) {
  const dictationProviderReady = resolveDictationProviderReady(config, keysSet, status, mlxInstallState)
  const rewriteProviderReady = resolveRewriteProviderReady(config, keysSet, providerModels)
  const microphoneReady = microphoneAccess === 'granted'
  const dictationProviderLabel = formatProviderDisplayName(config.stt.provider)
  const rewriteProviderLabel = formatProviderDisplayName(config.llm.provider)
  const accessibilityReady = accessibilityTrusted

  return {
    microphoneReady,
    accessibilityReady,
    dictationProviderReady,
    rewriteProviderReady,
    dictationReady: microphoneReady && accessibilityReady && dictationProviderReady,
    rewriteReady: microphoneReady && accessibilityReady && dictationProviderReady && rewriteProviderReady,
    dictationProviderLabel,
    dictationProviderDetail: describeDictationProvider(config, dictationProviderReady, status, mlxInstallState),
    rewriteProviderLabel,
    rewriteProviderDetail: describeRewriteProvider(config, rewriteProviderReady, providerModels),
  }
}

export function computeOnboardingState(
  config: AppConfig,
  keysSet: KeyStatusMap,
  microphoneAccess: string,
  accessibilityTrusted: boolean,
  usageStats: UsageStats | null,
  providerModels: ProviderModels | null = null,
  status: BackendStatus | null = null,
  mlxInstallState: MlxInstallState | null = null,
) {
  const readiness = computeReadiness(
    config,
    keysSet,
    microphoneAccess,
    accessibilityTrusted,
    providerModels,
    status,
    mlxInstallState,
  )
  const dictationRuns = usageStats?.dictation_runs ?? 0
  const smartRuns = usageStats?.smart_runs ?? 0
  const dictationTested = dictationRuns > 0
  const smartTested = smartRuns > 0

  return {
    ...readiness,
    dictationTested,
    smartTested,
    completed: readiness.dictationReady && dictationTested && readiness.rewriteReady && smartTested,
  }
}

export function getPrimaryOnboardingIssue(state: ReturnType<typeof computeOnboardingState>) {
  if (!state.microphoneReady) {
    return {
      label: 'Microphone needed',
      detail: 'Turn on microphone access before dictating.',
      tone: 'danger' as const,
      step: 'voice' as const,
    }
  }

  if (!state.accessibilityReady) {
    return {
      label: 'Accessibility needed',
      detail: 'Enable Accessibility for shortcuts and paste handoff.',
      tone: 'danger' as const,
      step: 'voice' as const,
    }
  }

  if (!state.dictationProviderReady) {
    return {
      label: 'Dictation path needed',
      detail: 'Finish the active Dictation provider setup before recording.',
      tone: 'warn' as const,
      step: 'voice' as const,
    }
  }

  if (!state.dictationTested) {
    return {
      label: 'Run first dictation',
      detail: `Record one Dictate pass so ${DISPLAY_NAME} can confirm the full voice path.`,
      tone: 'warn' as const,
      step: 'voice' as const,
    }
  }

  if (!state.rewriteProviderReady) {
    return {
      label: 'Smart path needed',
      detail: 'Finish the active Smart provider setup before using Smart.',
      tone: 'warn' as const,
      step: 'rewrite' as const,
    }
  }

  if (!state.smartTested) {
    return {
      label: 'Run Smart once',
      detail: `Run one Smart pass so ${DISPLAY_NAME} can confirm the Smart path end to end.`,
      tone: 'warn' as const,
      step: 'rewrite' as const,
    }
  }

  return null
}

export { providerRequiresKey }
