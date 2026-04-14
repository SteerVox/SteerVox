import { useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import type { Variants } from 'framer-motion'

import { DISPLAY_NAME } from '../shared/branding'
import { CheckIcon, ErrorIcon, InfoIcon, MicIcon, SetupIcon, SparkIcon, WarningIcon } from './components/BrandIcons'
import { WidgetDomainModeControl, WidgetDomainStatusChip } from './components/WidgetDomainControl'
import { WidgetModeControl } from './components/WidgetModeControl'
import { useFloatingWidgetController, type WidgetState } from './hooks/useFloatingWidgetController'
import type {
  BackendBootState,
  BackendStatus,
  LocalTaskStep,
} from './types'

const SHELL_VARIANTS = {
  hidden: { y: -18, opacity: 0, scale: 0.985, filter: 'blur(4px)' },
  visible: {
    y: 0,
    opacity: 1,
    scale: 1,
    filter: 'blur(0px)',
    transition: {
      type: 'spring' as const,
      stiffness: 360,
      damping: 32,
      mass: 0.76,
    },
  },
  exit: {
    y: -10,
    opacity: 0,
    scale: 0.992,
    filter: 'blur(3px)',
    transition: {
      duration: 0.2,
      ease: [0.32, 0.72, 0, 1] as const,
    },
  },
} satisfies Variants

const CONTENT_VARIANTS = {
  hidden: { opacity: 0, y: 6 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.18,
      ease: [0.22, 1, 0.36, 1] as const,
    },
  },
  exit: {
    opacity: 0,
    y: -4,
    transition: {
      duration: 0.14,
      ease: [0.4, 0, 1, 1] as const,
    },
  },
} satisfies Variants

function compactHost(host?: string | null) {
  return host ? host.replace(/^www\./, '') : null
}

function describeTaskStep(step: LocalTaskStep) {
  return step.script || step.command || step.summary
}

function formatTaskStepStatus(step: LocalTaskStep) {
  if (step.status === 'running') return 'Running'
  if (step.status === 'completed') return 'Done'
  if (step.status === 'failed') return 'Failed'
  if (step.status === 'blocked') return 'Blocked'
  if (step.status === 'cancelled') return 'Cancelled'
  return 'Pending'
}

function getProcessingTitle(status: BackendStatus | null, bootState: BackendBootState, widgetState: WidgetState) {
  if (widgetState === 'booting') {
    if (bootState.phase === 'error') return 'Unavailable'
    if (bootState.detail.toLowerCase().includes('providers')) return 'Loading providers'
    if (bootState.detail.toLowerCase().includes('connect')) return 'Starting'
    return 'Getting ready'
  }

  switch (status?.phase) {
    case 'transcribing':
      return 'Transcribing'
    case 'transforming':
      return 'Smart'
    case 'preparing_paste':
      return 'Preparing paste'
    default:
      return status?.phase_label || 'Processing'
  }
}

function getProcessingSubtitle(status: BackendStatus | null, bootState: BackendBootState, widgetState: WidgetState) {
  if (widgetState === 'booting') {
    if (bootState.detail.toLowerCase().includes('providers')) return 'Local models and providers'
    if (bootState.detail.toLowerCase().includes('connect')) return 'Getting ready'
    return 'Starting up'
  }

  const host = compactHost(status?.captured_context?.url_host)
  const app = status?.captured_context?.app_name && status.captured_context.app_name !== 'Unknown'
    ? status.captured_context.app_name
    : null

  switch (status?.phase) {
    case 'transcribing':
      return host || app || 'Speech to text'
    case 'transforming':
      return host || app || 'Running Smart'
    case 'preparing_paste':
      return host || app || 'Sending text back'
    default:
      return host || app || bootState.detail
  }
}

export const FloatingWidget = () => {
  const {
    backendStatus,
    runtimeConfig,
    localEnvironment,
    onboardingState,
    primaryAttentionIssue,
    widgetState,
    captureState,
    bootState,
    amplitude,
    lastError,
    presentationState,
    isHovered,
    successMessage,
    sheenCycle,
    templateOptions,
    switchingTemplate,
    switchingDomainMode,
    actionReviewBusy,
    hideSourceRef,
    autoRetractTimerRef,
    preparingPasteBusy,
    pendingReview,
    activeTaskRun,
    smartPreview,
    liveTranscription,
    showActionReview,
    showSmartPreview,
    showLiveTranscript,
    clearAutoRetractTimer,
    beginHide,
    showSettings,
    showSettingsStep,
    chooseTemplate,
    chooseDomainMode,
    submitActionReviewDecision,
    handleWidgetAction,
    triggerRecording,
    setPresentationState,
    setIsHovered,
    engageWidget,
  } = useFloatingWidgetController()

  const effectiveWidgetState: WidgetState = widgetState === 'processing'
    && backendStatus?.phase === 'preparing_paste'
    && !preparingPasteBusy
    ? 'idle'
    : widgetState
  const smartPreviewText = (smartPreview?.text || '').trim() || 'Generating preview…'
  const smartProfileLabel = smartPreview?.smart_profile === 'local_compact'
    ? (smartPreview.smart_profile_label || 'Local Smart profile')
    : backendStatus?.last_smart_run?.smart_profile === 'local_compact'
      ? 'Local Smart profile'
      : null
  const liveTranscriptText = (liveTranscription?.text || '').trim()
  const liveTranscriptPrimary = liveTranscriptText
    || (captureState.phase === 'starting'
      ? 'Preparing microphone and live transcript…'
      : captureState.phase === 'stopping'
        ? 'Finalizing the last spoken words…'
        : 'Listening for speech…')

  const compactProcessingTitle = getProcessingTitle(backendStatus, bootState, effectiveWidgetState)
  const compactProcessingSubtitle = getProcessingSubtitle(backendStatus, bootState, effectiveWidgetState)
  const targetLabel = compactHost(backendStatus?.captured_context?.url_host)
    || (backendStatus?.captured_context?.app_name && backendStatus.captured_context.app_name !== 'Unknown'
      ? backendStatus.captured_context.app_name
      : null)
  const isCapturing = effectiveWidgetState === 'recording' || effectiveWidgetState === 'starting' || captureState.phase === 'stopping'
  const activeMode = isCapturing
    ? captureState.mode === 'smart_transform' ? 'smart_transform' : 'dictation'
    : backendStatus?.active_mode
  const liveTranscriptHint = activeMode === 'smart_transform'
    ? 'Will rewrite after you stop.'
    : 'Will paste exactly what you say.'
  const liveTranscriptSourceLabel = liveTranscription?.source === 'local' || liveTranscription?.source === 'native_local'
    ? 'Local'
    : liveTranscription?.source === 'provider'
      ? 'Provider'
      : liveTranscription?.source === 'fallback'
        ? 'Fallback'
        : 'Live'
  const showTaskProgress = Boolean(
    !showActionReview
      && activeTaskRun
      && ['pending_review', 'running'].includes(activeTaskRun.status),
  )
  const activeTaskPrimary = activeTaskRun?.result_summary?.summary
    || activeTaskRun?.output_blocks?.slice(-1)[0]?.text
    || activeTaskRun?.plan_summary
    || activeTaskRun?.command
    || 'Running local task…'
  const activeTemplateLabel = templateOptions.find((template) => template.id === (runtimeConfig?.hotkeys.default_skill_id || ''))?.name
    || templateOptions[0]?.name
    || 'Standard'
  const dictationReady = Boolean(onboardingState?.dictationReady)
  const onboardingCompleted = Boolean(onboardingState?.completed)
  const environmentPending = localEnvironment.status === 'checking' || localEnvironment.status === 'verifying'
  const shellToneClass = isCapturing
    ? activeMode === 'smart_transform'
      ? 'shadow-[0_20px_42px_rgba(89,223,244,0.18)]'
      : 'shadow-[0_20px_42px_rgba(54,169,108,0.16)]'
    : effectiveWidgetState === 'processing'
      ? 'shadow-[0_20px_42px_rgba(58,201,230,0.14)]'
      : ''
  const showSecondarySelectors = !isCapturing && !showSmartPreview && !showActionReview && !showLiveTranscript && !showTaskProgress
  const secondaryControlCount = 1 + (runtimeConfig ? 1 : 0) + (templateOptions.length > 0 ? 1 : 0)
  const secondaryControlsGridClass = secondaryControlCount >= 3
    ? 'grid-cols-3'
    : secondaryControlCount === 2
      ? 'grid-cols-2'
      : 'grid-cols-1'
  const shellLayoutClass = showLiveTranscript
    ? 'min-h-[148px] items-start py-3.5'
    : showSmartPreview
      ? 'min-h-[112px] items-start py-3.5'
      : showTaskProgress
        ? 'min-h-[112px] items-start py-3.5'
      : showSecondarySelectors
        ? 'min-h-[92px] items-start py-3.5'
        : 'min-h-[84px] items-center py-3.5'
  const compactStatusDetailStyle = showSmartPreview || showTaskProgress
    ? {
        display: '-webkit-box',
        WebkitBoxOrient: 'vertical' as const,
        WebkitLineClamp: 3,
        overflow: 'hidden',
        lineHeight: '1.05rem',
      }
    : undefined
  const stateTone = effectiveWidgetState === 'error_nokey'
    ? 'text-semantic-warning'
    : effectiveWidgetState === 'disconnected'
      ? 'text-semantic-error'
      : 'text-text-primary'
  const compactStatusTitle = successMessage
    ? successMessage.title
    : showActionReview
      ? pendingReview?.kind === 'task_retry'
        ? 'Retry local task'
        : pendingReview?.kind === 'task_plan'
          ? 'Review task plan'
          : pendingReview?.title || 'Review action'
    : showTaskProgress
      ? activeTaskRun?.title || 'Local task'
    : effectiveWidgetState === 'booting'
      ? compactProcessingTitle
      : effectiveWidgetState === 'processing'
        ? showSmartPreview
          ? 'Smart preview'
          : compactProcessingTitle
        : effectiveWidgetState === 'starting'
          ? 'Starting…'
        : effectiveWidgetState === 'error_nokey'
          ? 'Voice setup needed'
          : effectiveWidgetState === 'disconnected'
            ? 'Backend unavailable'
            : isCapturing
              ? activeMode === 'smart_transform'
                ? 'Smart live'
                : 'Dictate live'
              : targetLabel
                ? `Target: ${targetLabel}`
                : 'Ready'
  const compactStatusDetail = successMessage
    ? successMessage.detail
    : showActionReview
      ? pendingReview?.summary || 'Review the proposed local task before it runs.'
    : showTaskProgress
      ? activeTaskPrimary
    : effectiveWidgetState === 'booting'
      ? compactProcessingSubtitle
      : effectiveWidgetState === 'processing'
        ? showSmartPreview
          ? smartPreviewText
          : compactProcessingSubtitle
        : effectiveWidgetState === 'starting'
          ? activeMode === 'smart_transform'
            ? 'Arming Smart capture'
            : 'Arming Dictate capture'
        : effectiveWidgetState === 'error_nokey'
          ? 'Open Settings to finish provider setup.'
          : effectiveWidgetState === 'disconnected'
            ? `Reconnect ${DISPLAY_NAME} to keep dictating.`
            : isCapturing
              ? targetLabel || 'Listening for speech'
              : 'Dictate or Smart'
  const recordingBlockedByReview = Boolean(showActionReview && pendingReview?.status !== 'error')

  const barMultipliers = [0.55, 0.85, 1, 0.82, 0.62]
  const minHeight = 3
  const maxHeight = 14
  const shouldRenderShell = presentationState !== 'hidden'
  const hasActiveContextWarning = Boolean(
    backendStatus?.context_warning && backendStatus?.active_mode === 'smart_transform'
  )
  const activeBanner = lastError
    ? {
      icon: <ErrorIcon size={16} className="mt-0.5 text-semantic-error" />,
      title: 'Error',
      desc: lastError,
      action: undefined,
      isError: true,
    }
      : primaryAttentionIssue && primaryAttentionIssue.tone === 'neutral'
        ? {
          icon: <InfoIcon size={16} className="mt-0.5 text-text-muted" />,
          title: primaryAttentionIssue.label,
          desc: primaryAttentionIssue.detail,
          action: primaryAttentionIssue.step === 'privacy' ? () => showSettingsStep('privacy') : () => showSettingsStep('voice'),
          isError: false,
        }
      : !localEnvironment.accessibilityTrusted
      ? {
        icon: <WarningIcon size={16} className="mt-0.5 text-semantic-warning" />,
        title: 'Accessibility needed',
        desc: 'Open Settings to finish Accessibility access.',
        action: () => showSettingsStep('voice'),
        isError: false,
      }
      : hasActiveContextWarning && effectiveWidgetState !== 'recording'
        ? {
          icon: <WarningIcon size={16} className="mt-0.5 text-semantic-warning" />,
          title: 'Limited context',
          desc: backendStatus?.context_warning || 'Smart has limited app context right now.',
          action: () => showSettingsStep('privacy'),
          isError: false,
        }
        : !dictationReady && !environmentPending
          ? {
            icon: <WarningIcon size={16} className="mt-0.5 text-semantic-warning" />,
            title: 'Voice setup needed',
            desc: primaryAttentionIssue?.detail || 'Finish voice setup before relying on Dictate or Smart.',
            action: () => showSettingsStep('voice'),
            isError: false,
          }
        : null
  const canAutoRetract = presentationState === 'visible'
    && effectiveWidgetState === 'idle'
    && !isHovered
    && !activeBanner
    && !successMessage
    && onboardingCompleted
  const contentKey = successMessage
    ? `success-${successMessage.title}`
    : showActionReview
      ? `action-review-${pendingReview?.run_id || 'active'}`
    : showTaskProgress
      ? `task-progress-${activeTaskRun?.run_id || 'active'}-${activeTaskRun?.updated_at || activeTaskPrimary}`
    : showLiveTranscript
      ? `live-transcript-${captureState.phase || 'idle'}-${liveTranscription?.updated_at || liveTranscriptPrimary}`
    : showSmartPreview
      ? `preview-${smartPreview?.run_id || 'active'}`
    : effectiveWidgetState === 'recording' || effectiveWidgetState === 'starting'
      ? `recording-${activeMode || 'dictation'}`
      : effectiveWidgetState === 'processing'
      ? `processing-${backendStatus?.phase || 'processing'}`
      : effectiveWidgetState
  const statusIcon = successMessage
    ? <CheckIcon size={16} />
    : effectiveWidgetState === 'error_nokey'
      ? <WarningIcon size={16} />
      : effectiveWidgetState === 'disconnected'
        ? <ErrorIcon size={16} />
        : effectiveWidgetState === 'processing'
          ? <SparkIcon size={16} />
          : effectiveWidgetState === 'booting'
            ? <SetupIcon size={16} />
            : <CheckIcon size={16} />

  useEffect(() => {
    clearAutoRetractTimer()

    if (!canAutoRetract) return

    autoRetractTimerRef.current = setTimeout(() => {
      beginHide('idle')
    }, 5000)

    return clearAutoRetractTimer
  }, [autoRetractTimerRef, beginHide, canAutoRetract, clearAutoRetractTimer])

  return (
    <div className="relative h-full w-full px-2 pt-2">
      <div className="relative">
      {activeBanner ? (
        <div className="absolute bottom-full z-20 mb-2 w-full">
          <button
            type="button"
            onClick={() => activeBanner.action?.()}
            disabled={!activeBanner.action}
            className={`titlebar-nodrag mx-auto flex w-[95%] items-start gap-3 rounded-2xl border px-3 py-3 text-left shadow-[0_12px_26px_rgba(0,0,0,0.25)] disabled:cursor-default ${activeBanner.isError
              ? 'border-semantic-error/20 bg-[rgba(55,14,22,0.94)]'
              : 'border-semantic-warning/20 bg-[rgba(63,42,8,0.92)]'
              }`}
          >
            {activeBanner.icon}
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.26em] text-text-primary">{activeBanner.title}</div>
              <div className="mt-1 text-[11px] leading-5 text-text-secondary">{activeBanner.desc}</div>
            </div>
          </button>
        </div>
      ) : null}

      <AnimatePresence initial={false}>
        {shouldRenderShell ? (
          <motion.div
            className={`titlebar-drag widget-shell relative z-20 flex justify-between overflow-hidden rounded-[30px] px-3 ${shellLayoutClass} ${shellToneClass}`}
            initial="hidden"
            animate={presentationState === 'exiting' ? 'exit' : 'visible'}
            variants={SHELL_VARIANTS}
            style={{ transformOrigin: 'top center' }}
            onAnimationComplete={(definition) => {
              if (definition === 'visible' && presentationState === 'entering') {
                setPresentationState('visible')
              }

              if (definition === 'exit' && presentationState === 'exiting') {
                setPresentationState('hidden')
                window.windowControls?.completeWidgetHide?.(hideSourceRef.current)
              }
            }}
            onMouseEnter={() => {
              setIsHovered(true)
              engageWidget()
            }}
            onMouseLeave={() => setIsHovered(false)}
            onPointerDown={engageWidget}
          >
            <motion.div
              key={`sheen-${sheenCycle}`}
              className="pointer-events-none absolute inset-y-1 left-0 w-24 rounded-full bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.14),transparent)] blur-sm"
              initial={{ x: '-140%', opacity: 0 }}
              animate={{ x: '480%', opacity: [0, 0.55, 0] }}
              transition={{ duration: 0.78, ease: 'easeOut', delay: 0.05 }}
            />
            <div className="pointer-events-none absolute inset-x-10 top-0 h-[30%] rounded-full bg-[linear-gradient(180deg,rgba(255,255,255,0.12),rgba(255,255,255,0.01),transparent)] opacity-55" />
            <div className="pointer-events-none absolute bottom-1 left-16 h-6 w-20 rounded-full bg-[radial-gradient(circle,rgba(180,190,210,0.08),transparent_72%)] blur-xl" />
            <div className="titlebar-nodrag min-w-0 flex-1">
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={contentKey}
                  variants={CONTENT_VARIANTS}
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                  className="min-w-0"
                >
                  {showSecondarySelectors ? (
                    <div className="min-w-0" data-testid="widget-idle-layout">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex flex-1 items-start gap-3">
                          <div className={`widget-control flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${successMessage ? 'text-semantic-success' : stateTone}`}>
                            {statusIcon}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[14px] font-semibold tracking-[-0.015em] text-text-primary">
                              {compactStatusTitle}
                            </div>
                            <div className="mt-1 truncate text-[12px] font-medium tracking-[-0.01em] text-text-secondary">
                              {compactStatusDetail}
                            </div>
                          </div>
                        </div>

                        <div className="ml-3 flex shrink-0 items-center gap-2">
                          <button
                            onPointerDown={handleWidgetAction(() => {
                              void triggerRecording('dictation')
                            }, effectiveWidgetState === 'disconnected' || effectiveWidgetState === 'processing' || recordingBlockedByReview || (isCapturing && activeMode !== 'dictation'))}
                            disabled={effectiveWidgetState === 'disconnected' || effectiveWidgetState === 'processing' || recordingBlockedByReview || (isCapturing && activeMode !== 'dictation')}
                            className={`widget-pill inline-flex h-11 min-w-[96px] cursor-pointer items-center justify-center gap-1.5 rounded-[18px] border px-4 py-2 text-[12px] font-semibold tracking-[-0.01em] transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
                              isCapturing && activeMode === 'dictation'
                                ? 'border-semantic-success/24 bg-[linear-gradient(180deg,rgba(27,145,87,0.34),rgba(14,72,43,0.2))] text-semantic-success shadow-[0_12px_26px_rgba(27,145,87,0.18)]'
                                : 'border-white/12 text-text-primary hover:bg-white/[0.10]'
                            }`}
                            title="Dictate — Ctrl+D"
                          >
                            <MicIcon size={13} />
                            {isCapturing && activeMode === 'dictation' ? 'Listening' : 'Dictate'}
                          </button>

                          <button
                            onPointerDown={handleWidgetAction(() => {
                              void triggerRecording('smart_transform')
                            }, effectiveWidgetState === 'disconnected' || effectiveWidgetState === 'processing' || recordingBlockedByReview || (isCapturing && activeMode !== 'smart_transform'))}
                            disabled={effectiveWidgetState === 'disconnected' || effectiveWidgetState === 'processing' || recordingBlockedByReview || (isCapturing && activeMode !== 'smart_transform')}
                            className={`widget-pill inline-flex h-11 min-w-[102px] cursor-pointer items-center justify-center gap-1.5 rounded-[18px] border px-4 py-2 text-[12px] font-semibold tracking-[-0.01em] transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
                              isCapturing && activeMode === 'smart_transform'
                                ? 'border-[#8ceef8]/26 bg-[linear-gradient(180deg,rgba(89,223,244,0.28),rgba(20,87,108,0.18))] text-[#8ceef8] shadow-[0_12px_26px_rgba(89,223,244,0.18)]'
                                : 'border-white/12 text-text-primary hover:bg-white/[0.10]'
                            }`}
                            title="Smart — Ctrl+T"
                          >
                            <SparkIcon size={13} />
                            {isCapturing && activeMode === 'smart_transform' ? 'Listening' : 'Smart'}
                          </button>

                          <button
                            onPointerDown={handleWidgetAction(showSettings)}
                            className="widget-icon-button flex h-11 w-11 cursor-pointer items-center justify-center rounded-full border border-white/10 text-text-muted hover:bg-white/[0.09] hover:text-text-primary"
                            title="Open Settings"
                          >
                            <SetupIcon size={14} />
                          </button>
                        </div>
                      </div>

                      <div
                        className={`mt-3 grid min-w-0 items-stretch gap-2 ${secondaryControlsGridClass}`}
                        data-testid="widget-secondary-controls"
                      >
                        <WidgetDomainStatusChip activeDomain={backendStatus?.active_domain} />
                        {runtimeConfig ? (
                          <WidgetDomainModeControl
                            activeDomain={backendStatus?.active_domain}
                            disabled={effectiveWidgetState === 'disconnected' || effectiveWidgetState === 'processing'}
                            domainMode={runtimeConfig.domains.mode}
                            onChange={chooseDomainMode}
                            updating={switchingDomainMode}
                          />
                        ) : null}
                        {templateOptions.length > 0 ? (
                          <WidgetModeControl
                            activeModeLabel={activeTemplateLabel}
                            disabled={switchingTemplate}
                            onChange={(skillId) => {
                              void chooseTemplate(skillId)
                            }}
                            options={templateOptions.map((template) => ({
                              id: template.id,
                              name: template.name,
                            }))}
                            selectedSkillId={runtimeConfig?.hotkeys.default_skill_id || templateOptions[0]?.id || ''}
                          />
                        ) : null}
                      </div>
                    </div>
                  ) : (
                    <div className={`flex gap-3 ${showSmartPreview || showLiveTranscript ? 'items-start' : 'items-center'}`}>
                      {isCapturing ? (
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center gap-[3px] rounded-full border border-white/10 bg-[rgba(18,24,30,0.34)]">
                          {barMultipliers.map((multiplier, index) => {
                            const barHeight = minHeight + (maxHeight - minHeight) * Math.min(amplitude * 3, 1) * multiplier
                            return (
                              <div
                                key={index}
                                className={`w-[3px] rounded-full transition-[height] duration-150 ${
                                  activeMode === 'smart_transform' ? 'bg-accent-primary shadow-[0_0_8px_rgba(89,223,244,0.26)]' : 'bg-semantic-success'
                                }`}
                                style={{
                                  height: `${barHeight}px`,
                                  opacity: amplitude > 0.005 ? 1 : 0.35,
                                }}
                              />
                            )
                          })}
                        </div>
                      ) : (
                        <div className={`widget-control flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${successMessage ? 'text-semantic-success' : stateTone}`}>
                          {statusIcon}
                        </div>
                      )}

                      {showLiveTranscript ? (
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <div className={`text-[11px] font-semibold uppercase tracking-[0.22em] ${
                              activeMode === 'smart_transform' ? 'text-[#8ceef8]' : 'text-semantic-success'
                            }`}>
                              {captureState.phase === 'starting'
                                ? 'Starting…'
                                : activeMode === 'smart_transform'
                                  ? 'Smart live transcript'
                                  : 'Dictate live transcript'}
                            </div>
                            <div className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.18em] text-text-muted">
                              {liveTranscriptSourceLabel}
                            </div>
                          </div>
                          <div
                            className="mt-2 min-h-[64px] whitespace-pre-wrap text-[15px] leading-7 text-text-primary"
                            data-testid="widget-live-transcript"
                          >
                            {liveTranscriptPrimary}
                          </div>
                          <div className="mt-2 text-[12px] font-medium tracking-[-0.01em] text-text-secondary">
                            {liveTranscriptHint}
                          </div>
                        </div>
                      ) : (
                        <div className="min-w-0">
                          {showSmartPreview && smartProfileLabel ? (
                            <div
                              className="mb-1 inline-flex rounded-full border border-[#8ceef8]/18 bg-[#8ceef8]/10 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.18em] text-[#8ceef8]"
                              data-testid="widget-smart-profile-badge"
                            >
                              {smartProfileLabel}
                            </div>
                          ) : null}
                          <div className={`truncate text-[14px] font-semibold tracking-[-0.015em] ${
                            isCapturing
                              ? activeMode === 'smart_transform'
                                ? 'text-[#8ceef8]'
                                : 'text-semantic-success'
                              : effectiveWidgetState === 'processing'
                                ? 'text-[#8ceef8]'
                                : 'text-text-primary'
                          }`}
                          >
                            {compactStatusTitle}
                          </div>
                          <div
                            className={showSmartPreview
                              ? 'mt-1 text-[12px] font-medium tracking-[-0.01em] text-text-secondary'
                              : 'truncate text-[12px] font-medium tracking-[-0.01em] text-text-secondary'}
                            data-testid={showSmartPreview ? 'widget-smart-preview' : undefined}
                            style={compactStatusDetailStyle}
                          >
                            {compactStatusDetail}
                          </div>
                          {showTaskProgress && activeTaskRun?.run_kind === 'multi_step' ? (
                            <div className="mt-3 space-y-2" data-testid="widget-task-progress-steps">
                              {activeTaskRun.steps.map((step, index) => {
                                const isCurrent = step.id === activeTaskRun.current_step_id && activeTaskRun.status === 'running'
                                return (
                                  <div
                                    key={step.id}
                                    className={`rounded-2xl border px-3 py-2 text-[11px] leading-5 ${
                                      isCurrent
                                        ? 'border-[#8ceef8]/24 bg-[rgba(24,79,90,0.24)] text-text-primary'
                                        : step.status === 'completed'
                                          ? 'border-semantic-success/20 bg-[rgba(17,64,43,0.22)] text-text-secondary'
                                          : step.status === 'failed' || step.status === 'blocked'
                                            ? 'border-semantic-error/24 bg-[rgba(57,16,24,0.34)] text-text-secondary'
                                            : 'border-white/8 bg-white/[0.04] text-text-secondary'
                                    }`}
                                  >
                                    <div className="flex items-center justify-between gap-3">
                                      <div className="font-medium text-text-primary">{index + 1}. {step.title}</div>
                                      <div className="text-[10px] uppercase tracking-[0.16em] text-text-muted">
                                        {formatTaskStepStatus(step)}
                                      </div>
                                    </div>
                                    <div className="mt-1 whitespace-pre-wrap break-words">
                                      {step.summary}
                                    </div>
                                  </div>
                                )
                              })}
                            </div>
                          ) : null}
                        </div>
                      )}
                    </div>
                  )}
                </motion.div>
              </AnimatePresence>
            </div>

            {!showSecondarySelectors ? (
              <div className="titlebar-nodrag relative z-10 ml-3 flex items-center gap-2">
                <button
                  onPointerDown={handleWidgetAction(() => {
                    void triggerRecording('dictation')
                  }, effectiveWidgetState === 'disconnected' || effectiveWidgetState === 'processing' || recordingBlockedByReview || (isCapturing && activeMode !== 'dictation'))}
                  disabled={effectiveWidgetState === 'disconnected' || effectiveWidgetState === 'processing' || recordingBlockedByReview || (isCapturing && activeMode !== 'dictation')}
                  className={`widget-pill inline-flex h-11 min-w-[96px] cursor-pointer items-center justify-center gap-1.5 rounded-[18px] border px-4 py-2 text-[12px] font-semibold tracking-[-0.01em] transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
                    isCapturing && activeMode === 'dictation'
                      ? 'border-semantic-success/24 bg-[linear-gradient(180deg,rgba(27,145,87,0.34),rgba(14,72,43,0.2))] text-semantic-success shadow-[0_12px_26px_rgba(27,145,87,0.18)]'
                      : 'border-white/12 text-text-primary hover:bg-white/[0.10]'
                  }`}
                  title="Dictate — Ctrl+D"
                >
                  <MicIcon size={13} />
                  {isCapturing && activeMode === 'dictation' ? 'Listening' : 'Dictate'}
                </button>

                <button
                  onPointerDown={handleWidgetAction(() => {
                    void triggerRecording('smart_transform')
                  }, effectiveWidgetState === 'disconnected' || effectiveWidgetState === 'processing' || recordingBlockedByReview || (isCapturing && activeMode !== 'smart_transform'))}
                  disabled={effectiveWidgetState === 'disconnected' || effectiveWidgetState === 'processing' || recordingBlockedByReview || (isCapturing && activeMode !== 'smart_transform')}
                  className={`widget-pill inline-flex h-11 min-w-[102px] cursor-pointer items-center justify-center gap-1.5 rounded-[18px] border px-4 py-2 text-[12px] font-semibold tracking-[-0.01em] transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
                    isCapturing && activeMode === 'smart_transform'
                      ? 'border-[#8ceef8]/26 bg-[linear-gradient(180deg,rgba(89,223,244,0.28),rgba(20,87,108,0.18))] text-[#8ceef8] shadow-[0_12px_26px_rgba(89,223,244,0.18)]'
                      : 'border-white/12 text-text-primary hover:bg-white/[0.10]'
                  }`}
                  title="Smart — Ctrl+T"
                >
                  <SparkIcon size={13} />
                  {isCapturing && activeMode === 'smart_transform' ? 'Listening' : 'Smart'}
                </button>

                <button
                  onPointerDown={handleWidgetAction(showSettings)}
                  className="widget-icon-button flex h-11 w-11 cursor-pointer items-center justify-center rounded-full border border-white/10 text-text-muted hover:bg-white/[0.09] hover:text-text-primary"
                  title="Open Settings"
                >
                  <SetupIcon size={14} />
                </button>
              </div>
            ) : null}
          </motion.div>
        ) : null}
      </AnimatePresence>

      {showActionReview && pendingReview ? (
        <div className="titlebar-nodrag relative z-10 mt-2 px-2" data-testid="widget-action-review">
          <div className="widget-shell rounded-[24px] border border-white/12 bg-[linear-gradient(180deg,rgba(9,14,20,0.97),rgba(4,7,12,0.985))] p-4 shadow-[0_24px_64px_rgba(0,0,0,0.48)]">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-text-muted">
                  {pendingReview.status === 'error'
                    ? pendingReview.scope === 'desktop_action' ? 'Action review error' : 'Task review error'
                    : pendingReview.scope === 'desktop_action'
                      ? 'Review desktop action'
                      : pendingReview.kind === 'task_plan'
                        ? 'Review task plan'
                        : pendingReview.kind === 'task_retry'
                          ? 'Retry local task'
                          : 'Review local task'}
                </div>
                <div className="mt-2 text-sm font-medium text-text-primary">{pendingReview.summary}</div>
              </div>
              <div className={`rounded-full border px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] ${
                pendingReview.status === 'error'
                  ? 'border-semantic-error/30 bg-[rgba(87,20,30,0.78)] text-semantic-error'
                  : 'border-[#8ceef8]/26 bg-[rgba(24,79,90,0.72)] text-[#8ceef8]'
              }`}>
                {pendingReview.status === 'error'
                  ? 'Needs review'
                  : pendingReview.kind.replace('_', ' ')}
              </div>
            </div>

            {pendingReview.error ? (
              <div className="mt-3 rounded-2xl border border-semantic-error/28 bg-[rgba(57,16,24,0.84)] px-3 py-2 text-sm leading-6 text-text-secondary shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
                {pendingReview.error}
              </div>
            ) : null}

            <div className="mt-3 rounded-2xl border border-white/10 bg-[rgba(3,6,10,0.9)] p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
              <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-text-muted">
                {pendingReview.kind === 'task_plan'
                  ? 'Plan preview'
                  : pendingReview.language === 'applescript'
                    ? 'AppleScript preview'
                    : 'Command preview'}
              </div>
              <pre className="mt-3 max-h-[120px] overflow-auto whitespace-pre-wrap break-words text-[12px] leading-6 text-text-secondary">
                {pendingReview.script || pendingReview.command || pendingReview.detail}
              </pre>
            </div>

            {pendingReview.scope === 'local_task' && activeTaskRun?.run_kind === 'multi_step' ? (
              <div className="mt-3 space-y-2" data-testid="widget-task-step-list">
                {activeTaskRun.steps.map((step, index) => (
                  <div
                    key={step.id}
                    className="rounded-2xl border border-white/8 bg-white/[0.04] px-3 py-2 text-[12px] leading-6 text-text-secondary"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="font-medium text-text-primary">{index + 1}. {step.title}</div>
                      <div className="text-[10px] uppercase tracking-[0.16em] text-text-muted">
                        {formatTaskStepStatus(step)}
                      </div>
                    </div>
                    <div className="mt-1 whitespace-pre-wrap break-words">{describeTaskStep(step)}</div>
                  </div>
                ))}
              </div>
            ) : null}

            {pendingReview.cwd ? (
              <div className="mt-3 text-xs leading-6 text-text-muted">
                Working directory: {pendingReview.cwd}
              </div>
            ) : null}

            <div className="mt-4 flex flex-wrap gap-2">
              {pendingReview.kind === 'task_retry' ? (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      void submitActionReviewDecision('approve', pendingReview, 'retry_failed_step')
                    }}
                    disabled={actionReviewBusy !== null || pendingReview.status !== 'pending'}
                    className="inline-flex items-center justify-center rounded-full border border-[#8ceef8]/22 bg-[linear-gradient(180deg,rgba(89,223,244,0.18),rgba(20,87,108,0.12))] px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#8ceef8] transition-colors disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    {actionReviewBusy === 'approve' ? 'Retrying…' : 'Retry step'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void submitActionReviewDecision('approve', pendingReview, 'rerun_all')
                    }}
                    disabled={actionReviewBusy !== null || pendingReview.status !== 'pending'}
                    className="inline-flex items-center justify-center rounded-full border border-white/10 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-text-primary transition-colors hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    Run from start
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    void submitActionReviewDecision('approve', pendingReview)
                  }}
                  disabled={actionReviewBusy !== null || pendingReview.status !== 'pending'}
                  className="inline-flex items-center justify-center rounded-full border border-[#8ceef8]/22 bg-[linear-gradient(180deg,rgba(89,223,244,0.18),rgba(20,87,108,0.12))] px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#8ceef8] transition-colors disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {actionReviewBusy === 'approve' ? 'Approving…' : 'Approve'}
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  void submitActionReviewDecision('reject', pendingReview)
                }}
                disabled={actionReviewBusy !== null}
                className="inline-flex items-center justify-center rounded-full border border-white/10 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-text-muted transition-colors hover:bg-white/[0.08] hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-45"
              >
                {actionReviewBusy === 'reject'
                  ? 'Dismissing…'
                  : pendingReview.kind === 'task_retry' || pendingReview.status === 'error'
                    ? 'Dismiss'
                    : 'Reject'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      </div>
    </div>
  )
}
