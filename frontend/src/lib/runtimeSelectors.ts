import { DISPLAY_NAME } from '../../shared/branding'
import { computeOnboardingState, computeReadiness, getPrimaryOnboardingIssue } from './onboarding'
import type {
  ActiveWorkState,
  RuntimeAttentionIssue,
  RuntimeStoreState,
} from '../types'

function hasPendingDelivery(state: RuntimeStoreState) {
  const status = state.snapshot.status
  if (!status) {
    return false
  }

  return Boolean(
    status.pending_paste
    || status.pending_notification
    || (status.phase === 'preparing_paste' && status.is_processing),
  )
}

export function selectReadinessState(state: RuntimeStoreState) {
  const config = state.snapshot.config
  if (!config) {
    return null
  }

  return computeReadiness(
    config,
    state.snapshot.keysSet,
    state.localEnvironment.microphoneAccess,
    state.localEnvironment.accessibilityTrusted,
    state.snapshot.providerModels,
    state.snapshot.status,
    state.localEnvironment.mlxInstallState,
  )
}

export function selectOnboardingState(state: RuntimeStoreState) {
  const config = state.snapshot.config
  if (!config) {
    return null
  }

  return computeOnboardingState(
    config,
    state.snapshot.keysSet,
    state.localEnvironment.microphoneAccess,
    state.localEnvironment.accessibilityTrusted,
    state.snapshot.usageStats,
    state.snapshot.providerModels,
    state.snapshot.status,
    state.localEnvironment.mlxInstallState,
  )
}

export function selectPrimaryAttentionIssue(state: RuntimeStoreState): RuntimeAttentionIssue | null {
  const environment = state.localEnvironment

  if (environment.status === 'checking') {
    return {
      label: 'Checking access',
      detail: 'Confirming microphone, Accessibility, and app context.',
      tone: 'neutral',
      step: 'voice',
    }
  }

  if (environment.status === 'verifying') {
    const label = environment.verifyingTarget === 'microphone'
      ? 'Verifying microphone'
      : environment.verifyingTarget === 'accessibility'
        ? 'Verifying Accessibility'
        : environment.verifyingTarget === 'context'
          ? 'Verifying app context'
          : 'Verifying access'
    const detail = environment.verifyingTarget === 'microphone'
      ? 'Waiting for macOS to confirm microphone access.'
      : environment.verifyingTarget === 'accessibility'
        ? 'Waiting for macOS to confirm Accessibility access.'
        : environment.verifyingTarget === 'context'
          ? 'Refreshing frontmost app and browser context access.'
          : 'Refreshing local permissions and app context.'

    return {
      label,
      detail,
      tone: 'neutral',
      step: environment.verifyingTarget === 'context' ? 'privacy' : 'voice',
    }
  }

  if (environment.status === 'error') {
    return {
      label: 'Permission check unavailable',
      detail: environment.error || `${DISPLAY_NAME} could not verify local access right now.`,
      tone: 'warn',
      step: 'voice',
    }
  }

  const onboardingState = selectOnboardingState(state)
  const issue = onboardingState ? getPrimaryOnboardingIssue(onboardingState) : null
  if (issue) {
    return {
      ...issue,
    }
  }

  const status = state.snapshot.status
  if (status?.context_warning) {
    return {
      label: 'Limited context',
      detail: status.context_warning,
      tone: 'warn',
      step: 'privacy',
    }
  }

  return null
}

export function selectActiveWorkState(state: RuntimeStoreState): ActiveWorkState {
  const status = state.snapshot.status

  if (!status) {
    return state.connectionState === 'connecting'
      ? {
        kind: 'booting',
        label: `Preparing ${DISPLAY_NAME}`,
        detail: 'Loading the local voice workspace.',
        busy: true,
      }
      : {
        kind: 'disconnected',
        label: 'Backend unavailable',
        detail: state.connectionError || `Reconnect ${DISPLAY_NAME} to continue.`,
        busy: false,
      }
  }

  if (status.phase === 'error') {
    return {
      kind: 'attention',
      label: status.phase_label || 'Last action failed',
      detail: status.last_error || 'The last voice action did not finish cleanly.',
      busy: false,
    }
  }

  if (
    status.phase === 'transcribing'
    || status.phase === 'transforming'
    || (status.phase === 'preparing_paste' && hasPendingDelivery(state))
  ) {
    return {
      kind: 'processing',
      label: status.phase_label || 'Working',
      detail: status.phase === 'preparing_paste'
        ? 'Delivering the latest result.'
        : 'Finishing the current voice action.',
      busy: true,
    }
  }

  if (state.connectionState === 'error' && !status.backend_ready) {
    return {
      kind: 'disconnected',
      label: 'Backend unavailable',
      detail: state.connectionError || `Reconnect ${DISPLAY_NAME} to continue.`,
      busy: false,
    }
  }

  return {
    kind: 'idle',
    label: 'Ready',
    detail: 'Waiting for the next voice action.',
    busy: false,
  }
}
