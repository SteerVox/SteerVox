import { DISPLAY_NAME } from '../../shared/branding'
import type { AppConfig, KeyStatusMap, OnboardingState, UsageStats } from '../types'

const KEYLESS_PROVIDER_IDS = new Set(['local', 'lmstudio', 'mlx-whisper'])

export function providerRequiresKey(provider: string) {
  return !KEYLESS_PROVIDER_IDS.has(provider)
}

export function computeReadiness(
  config: AppConfig,
  keysSet: KeyStatusMap,
  microphoneAccess: string,
  accessibilityTrusted: boolean,
) {
  const dictationProviderReady = !providerRequiresKey(config.stt.provider) || Boolean(keysSet[config.stt.provider])
  const rewriteProviderReady = !providerRequiresKey(config.llm.provider) || Boolean(keysSet[config.llm.provider])
  const microphoneReady = microphoneAccess === 'granted'
  const accessibilityReady = accessibilityTrusted

  return {
    microphoneReady,
    accessibilityReady,
    dictationProviderReady,
    rewriteProviderReady,
    dictationReady: microphoneReady && accessibilityReady && dictationProviderReady,
    rewriteReady: microphoneReady && accessibilityReady && dictationProviderReady && rewriteProviderReady,
  }
}

export function computeOnboardingState(
  config: AppConfig,
  keysSet: KeyStatusMap,
  microphoneAccess: string,
  accessibilityTrusted: boolean,
  usageStats: UsageStats | null,
): OnboardingState {
  const readiness = computeReadiness(config, keysSet, microphoneAccess, accessibilityTrusted)
  const dictationRuns = usageStats?.dictation_runs ?? 0
  const dictationTested = dictationRuns > 0

  return {
    ...readiness,
    dictationTested,
    completed: readiness.dictationReady && dictationTested,
  }
}

export function getPrimaryOnboardingIssue(state: OnboardingState) {
  if (!state.microphoneReady) {
    return {
      label: 'Microphone needed',
      detail: 'Turn on microphone access before dictating.',
      tone: 'danger' as const,
    }
  }

  if (!state.accessibilityReady) {
    return {
      label: 'Accessibility needed',
      detail: 'Enable Accessibility for shortcuts and paste handoff.',
      tone: 'danger' as const,
    }
  }

  if (!state.dictationProviderReady) {
    return {
      label: 'Dictation provider needed',
      detail: 'Add the dictation provider key or switch to a local path.',
      tone: 'warn' as const,
    }
  }

  if (!state.dictationTested) {
    return {
      label: 'Run first dictation',
      detail: `Record one dictation so ${DISPLAY_NAME} can confirm the full voice path.`,
      tone: 'warn' as const,
    }
  }

  return null
}
