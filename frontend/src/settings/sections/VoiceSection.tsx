import { DISPLAY_NAME } from '../../../shared/branding'
import {
  CheckIcon,
  MicIcon,
  RefreshIcon,
  SetupIcon,
  ShieldIcon,
  WaveIcon,
} from '../../components/BrandIcons'
import { applyModelSelection } from '../../lib/providerSettings'
import { mapLiveTranscriptionControlValue } from '../../lib/liveTranscriptionSettings'
import type {
  AppConfig,
  AppLaunchContext,
  AudioDevice,
  KeyStatusMap,
  LocalSttRuntimeStatus,
  MlxInstallState,
  OnboardingState,
  PrivacyPane,
  ProviderModel,
} from '../../types'
import type { OnboardingStepId } from '../constants'
import {
  buildLanguageOptions,
  isApiKeyProviderId,
  PROVIDERS,
} from '../constants'
import { formatLanguageLabel, formatProviderModelLabel, formatProviderName } from '../display'
import {
  ContextField,
  FooterButton,
  PermissionCard,
  ProviderPicker,
  SectionCard,
  StatusBadge,
  ToggleCard,
  type StatusTone,
} from '../primitives'
import { VoiceShortcutsSection } from './AdvancedUtilitySections'

type LiveTranscriptionUi = {
  supportsLivePreview: boolean
  capabilityLabel: string
  capabilityTone: StatusTone
  controlValue: 'enabled' | 'off'
  detail: string
  help: string
}

type VoiceSectionProps = {
  draftConfig: AppConfig
  keysSet: KeyStatusMap
  sttModels: ProviderModel[]
  displayedLlmModels: ProviderModel[]
  audioDevices: AudioDevice[]
  configuredDevice: AudioDevice | null
  refreshingDevices: boolean
  testRecording: boolean
  testResult: { transcript?: string; time?: number; error?: string; fallback_notice?: string | null } | null
  launchContext: AppLaunchContext | null
  mlxInstallState: MlxInstallState
  showMlxLogs: boolean
  liveTranscriptionUi: LiveTranscriptionUi
  microphoneAccess: string
  accessibilityTrusted: boolean
  microphoneTone: StatusTone
  accessibilityTone: StatusTone
  microphoneBadgeLabel: string
  accessibilityBadgeLabel: string
  microphonePermissionLabel: string
  accessibilityPermissionLabel: string
  microphoneActionLabel: string
  microphoneDetail: string
  microphoneDeviceHint: string | null
  voiceConfigDirty: boolean
  rewriteConfigDirty: boolean
  smartConfigDirty: boolean
  currentSttProviderReady: boolean
  currentLlmProviderReady: boolean
  saving: boolean
  refreshingLmStudioModels: boolean
  draftDictationProviderNeedsAccess: boolean
  draftSmartProviderNeedsAccess: boolean
  showPackagedOnboarding: boolean
  onboardingReady: boolean
  onboardingStep: OnboardingStepId
  onboardingStepOrder: OnboardingStepId[]
  onboardingStepIndex: number
  onboardingDisplayStep: number
  onboardingActionableStepCount: number
  onboardingStepTitles: Record<OnboardingStepId, string>
  onboardingStepDescriptions: Record<OnboardingStepId, string>
  appliedOnboardingState: OnboardingState & {
    dictationProviderDetail: string
    rewriteProviderDetail: string
  }
  primaryAutoLanguage: string
  autoSecondaryLanguages: string[]
  usingMlxWhisper: boolean
  selectedSttModel: ProviderModel | null
  usingTinyMlxModel: boolean
  usingHeavyMlxModel: boolean
  packagedLocalSttStatus: LocalSttRuntimeStatus | null
  packagedLocalSttBadgeLabel: string
  packagedLocalSttBadgeTone: StatusTone
  developerMode: boolean
  onSetDraftConfig: (config: AppConfig) => void
  onUpdateProvider: (section: 'llm' | 'stt', provider: string) => void
  onOpenAccessStep: (provider?: string | null) => void
  onNavigateToStep: (step: 'rewrite') => void
  onSaveConfig: () => void
  onStartTestRecording: () => void
  onStopTestRecording: () => void
  onRefreshDevices: () => void
  onRequestMicrophone: () => void
  onRequestAccessibility: () => void
  onOpenPrivacySettings: (pane: PrivacyPane) => void
  onRefreshLmStudioModels: () => void
  onDismissPackagedOnboarding: () => void
  onCompletePackagedOnboarding: () => void
  onRefreshRuntimeStatus: () => void
  onInstallMlxWhisper: () => void
  onCheckMlxWhisperInstallation: () => void
  onToggleShowMlxLogs: () => void
}

export function VoiceSection({
  draftConfig,
  keysSet,
  sttModels,
  displayedLlmModels,
  audioDevices,
  configuredDevice,
  refreshingDevices,
  testRecording,
  testResult,
  launchContext,
  mlxInstallState,
  showMlxLogs,
  liveTranscriptionUi,
  microphoneAccess,
  accessibilityTrusted,
  microphoneTone,
  accessibilityTone,
  microphoneBadgeLabel,
  accessibilityBadgeLabel,
  microphonePermissionLabel,
  accessibilityPermissionLabel,
  microphoneActionLabel,
  microphoneDetail,
  microphoneDeviceHint,
  voiceConfigDirty,
  rewriteConfigDirty,
  smartConfigDirty,
  currentSttProviderReady,
  currentLlmProviderReady,
  saving,
  refreshingLmStudioModels,
  draftDictationProviderNeedsAccess,
  draftSmartProviderNeedsAccess,
  showPackagedOnboarding,
  onboardingReady,
  onboardingStep,
  onboardingStepOrder,
  onboardingStepIndex,
  onboardingDisplayStep,
  onboardingActionableStepCount,
  onboardingStepTitles,
  onboardingStepDescriptions,
  appliedOnboardingState,
  primaryAutoLanguage,
  autoSecondaryLanguages,
  usingMlxWhisper,
  selectedSttModel,
  usingTinyMlxModel,
  usingHeavyMlxModel,
  packagedLocalSttStatus,
  packagedLocalSttBadgeLabel,
  packagedLocalSttBadgeTone,
  developerMode,
  onSetDraftConfig,
  onUpdateProvider,
  onOpenAccessStep,
  onNavigateToStep,
  onSaveConfig,
  onStartTestRecording,
  onStopTestRecording,
  onRefreshDevices,
  onRequestMicrophone,
  onRequestAccessibility,
  onOpenPrivacySettings,
  onRefreshLmStudioModels,
  onDismissPackagedOnboarding,
  onCompletePackagedOnboarding,
  onRefreshRuntimeStatus,
  onInstallMlxWhisper,
  onCheckMlxWhisperInstallation,
  onToggleShowMlxLogs,
}: VoiceSectionProps) {
  const sttLanguageOptions = buildLanguageOptions([draftConfig.stt.language, ...draftConfig.stt.preferred_languages])

  const updateFixedLanguage = (language: string) => {
    const nextPreferred = draftConfig.stt.preferred_languages.includes(language)
      ? draftConfig.stt.preferred_languages
      : [language, ...draftConfig.stt.preferred_languages]

    onSetDraftConfig({
      ...draftConfig,
      stt: {
        ...draftConfig.stt,
        language,
        preferred_languages: nextPreferred,
      },
    })
  }

  const updatePrimaryAutoLanguage = (language: string) => {
    const remaining = draftConfig.stt.preferred_languages.filter((code) => code !== language)
    onSetDraftConfig({
      ...draftConfig,
      stt: {
        ...draftConfig.stt,
        preferred_languages: [language, ...remaining],
      },
    })
  }

  const toggleAutoSecondaryLanguage = (language: string) => {
    if (language === primaryAutoLanguage) return

    const remaining = draftConfig.stt.preferred_languages.filter((code) => code !== primaryAutoLanguage && code !== language)
    const nextSecondary = autoSecondaryLanguages.includes(language)
      ? remaining
      : [...remaining, language]

    onSetDraftConfig({
      ...draftConfig,
      stt: {
        ...draftConfig.stt,
        preferred_languages: [primaryAutoLanguage, ...nextSecondary],
      },
    })
  }

  const setSttLanguageMode = (mode: 'fixed' | 'auto') => {
    onSetDraftConfig({
      ...draftConfig,
      stt: {
        ...draftConfig.stt,
        language_mode: mode,
        preferred_languages: mode === 'auto'
          ? (draftConfig.stt.preferred_languages.length
            ? draftConfig.stt.preferred_languages
            : [draftConfig.stt.language || 'en'])
          : draftConfig.stt.preferred_languages,
      },
    })
  }

  return (
    <>
      {showPackagedOnboarding ? (
        <SectionCard
          title="Getting started"
          icon={<SetupIcon size={18} />}
          description="Get to the first successful dictation before you worry about advanced setup."
          action={<StatusBadge label={onboardingReady ? 'Voice ready' : `Step ${onboardingDisplayStep} of ${onboardingActionableStepCount}`} tone={onboardingReady ? 'good' : 'warn'} />}
        >
          <div className="grid gap-4 xl:grid-cols-[0.92fr_1.28fr]">
            <div className="grid gap-3">
              {(['install', 'microphone', 'accessibility', 'providers', 'dictation_test'] as OnboardingStepId[]).map((stepId, index) => {
                const completed = onboardingStepOrder.indexOf(stepId) < onboardingStepIndex
                const active = onboardingStep === stepId
                const tone = completed ? 'good' : active ? 'warn' : 'neutral'
                return (
                  <div
                    key={stepId}
                    className={`rounded-2xl border px-4 py-3 ${active ? 'border-accent-primary/20 bg-accent-primary/10' : 'border-white/6 bg-white/[0.02]'}`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-[11px] uppercase tracking-[0.24em] text-text-muted">Step {index + 1}</div>
                        <div className="mt-1.5 text-sm font-medium text-text-primary">{onboardingStepTitles[stepId]}</div>
                      </div>
                      <StatusBadge label={completed ? 'Done' : active ? 'In progress' : 'Up next'} tone={tone} />
                    </div>
                  </div>
                )
              })}

              <div className="rounded-2xl border border-white/6 bg-white/[0.02] p-4">
                <div className="text-[11px] uppercase tracking-[0.24em] text-text-muted">Recommended path</div>
                <p className="mt-2 text-sm leading-6 text-text-secondary">
                  Start with the active local path when it is already ready on this Mac. If it is not, save access for a cloud provider and switch the active path explicitly in the setup card.
                </p>
              </div>
            </div>

            <div className="rounded-[24px] border border-white/7 bg-black/18 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-[11px] uppercase tracking-[0.26em] text-text-muted">
                    {onboardingStep === 'complete' ? 'Ready to go' : `Current step • ${onboardingDisplayStep} of ${onboardingActionableStepCount}`}
                  </div>
                  <h3 className="mt-2 text-lg font-semibold text-text-primary">{onboardingStepTitles[onboardingStep]}</h3>
                  <p className="mt-2 max-w-2xl text-sm leading-6 text-text-secondary">{onboardingStepDescriptions[onboardingStep]}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <StatusBadge label="Public beta" tone="neutral" />
                  <StatusBadge label={microphoneBadgeLabel} tone={microphoneTone} />
                  <StatusBadge label={accessibilityBadgeLabel} tone={accessibilityTone} />
                  <StatusBadge label={currentSttProviderReady ? 'Dictation path ready' : 'Dictation setup needed'} tone={currentSttProviderReady ? 'good' : 'warn'} />
                  <StatusBadge label={currentLlmProviderReady ? 'Smart path ready' : 'Smart setup needed'} tone={currentLlmProviderReady ? 'good' : 'warn'} />
                </div>
              </div>

              {launchContext?.should_prompt_move_to_applications ? (
                <div className="mt-4 rounded-2xl border border-semantic-warning/20 bg-semantic-warning/8 p-4">
                  <div className="text-sm font-medium text-text-primary">Move the app to Applications before finishing setup</div>
                  <p className="mt-2 text-sm leading-6 text-text-secondary">
                    {DISPLAY_NAME} is running from {launchContext.install_location === 'disk_image' ? 'the mounted DMG' : 'outside /Applications'}. Drag it into <span className="font-medium text-text-primary">Applications</span>, then reopen it from there so permissions and helper paths stay stable for the unsigned beta.
                  </p>
                  <p className="mt-2 text-sm leading-6 text-text-secondary">
                    First launch on macOS may require the usual unsigned-beta workaround: open the app once from Finder, confirm the system prompt, then continue setup from the copy in Applications.
                  </p>
                  <div className="mt-4 flex flex-wrap gap-3">
                    <FooterButton tone="secondary" onClick={() => window.windowControls?.revealAppInFinder?.()}>Reveal current app</FooterButton>
                    <FooterButton tone="secondary" onClick={() => window.windowControls?.openApplicationsFolder?.()}>Open Applications</FooterButton>
                  </div>
                </div>
              ) : null}

              {onboardingStep === 'install' ? (
                <div className="mt-5 space-y-4">
                  <div className="rounded-2xl border border-white/6 bg-white/[0.02] p-4">
                    <div className="text-sm font-medium text-text-primary">Install location</div>
                    <p className="mt-2 text-sm leading-6 text-text-secondary">
                      Current location: <span className="font-medium text-text-primary">{launchContext?.install_location === 'disk_image' ? 'Mounted DMG' : launchContext?.install_location === 'other' ? 'Outside /Applications' : launchContext?.install_location === 'applications' ? '/Applications' : 'Development'}</span>.
                    </p>
                    <p className="mt-2 text-sm leading-6 text-text-secondary">
                      Finish the beta funnel only after reopening the app from <span className="font-medium text-text-primary">/Applications</span>.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-3">
                    <FooterButton tone="secondary" onClick={() => window.windowControls?.revealAppInFinder?.()}>Reveal current app</FooterButton>
                    <FooterButton tone="secondary" onClick={() => window.windowControls?.openApplicationsFolder?.()}>Open Applications</FooterButton>
                  </div>
                </div>
              ) : null}

              {onboardingStep === 'microphone' ? (
                <div className="mt-5 space-y-4">
                  <div className="rounded-2xl border border-white/6 bg-white/[0.02] p-4">
                    <div className="text-sm font-medium text-text-primary">Microphone status</div>
                    <p className="mt-2 text-sm leading-6 text-text-secondary">
                      macOS status: <span className="font-medium text-text-primary">{microphoneAccess}</span>.
                    </p>
                    <p className="mt-2 text-sm leading-6 text-text-secondary">{microphoneDetail}</p>
                    {microphoneDeviceHint ? <p className="mt-2 text-sm leading-6 text-semantic-warning">{microphoneDeviceHint}</p> : null}
                  </div>
                  <div className="flex flex-wrap gap-3">
                    <FooterButton onClick={onRequestMicrophone}>{microphoneActionLabel}</FooterButton>
                    <FooterButton tone="secondary" onClick={() => onOpenPrivacySettings('microphone')}>Open Microphone Settings</FooterButton>
                  </div>
                </div>
              ) : null}

              {onboardingStep === 'accessibility' ? (
                <div className="mt-5 space-y-4">
                  <div className="rounded-2xl border border-white/6 bg-white/[0.02] p-4">
                    <div className="text-sm font-medium text-text-primary">Accessibility status</div>
                    <p className="mt-2 text-sm leading-6 text-text-secondary">
                      Accessibility is currently <span className="font-medium text-text-primary">{accessibilityTrusted ? 'enabled' : 'not enabled'}</span>. {DISPLAY_NAME} uses it for global shortcuts and reliable paste handoff.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-3">
                    <FooterButton onClick={onRequestAccessibility}>Enable Accessibility</FooterButton>
                    <FooterButton tone="secondary" onClick={() => onOpenPrivacySettings('accessibility')}>Open Accessibility Settings</FooterButton>
                  </div>
                </div>
              ) : null}

              {onboardingStep === 'providers' ? (
                <div className="mt-5 space-y-4">
                  <div className="rounded-2xl border border-white/6 bg-white/[0.02] p-4">
                    <div className="text-sm font-medium text-text-primary">Choose the active Dictation path</div>
                    <p className="mt-2 text-sm leading-6 text-text-secondary">
                      {`Pick the provider ${DISPLAY_NAME} should use for Dictate right now, then confirm the model below. API keys live in Access so this step stays focused on the active voice path.`}
                    </p>
                    <div className="mt-4">
                      <ProviderPicker
                        label="Dictation provider"
                        value={draftConfig.stt.provider}
                        options={PROVIDERS.stt}
                        availableKeys={keysSet}
                        onChange={(provider) => onUpdateProvider('stt', provider)}
                      />
                    </div>
                    <div className="mt-4">
                      <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.24em] text-text-muted">Dictation model</label>
                      <select
                        className="w-full rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                        value={draftConfig.stt.model}
                        onChange={(event) => onSetDraftConfig({ ...draftConfig, stt: { ...draftConfig.stt, model: event.target.value } })}
                      >
                        {sttModels.map((model) => (
                          <option key={model.id} value={model.id}>{model.name}</option>
                        ))}
                      </select>
                    </div>
                    <div className="mt-4 rounded-2xl border border-white/6 bg-black/20 px-4 py-3 text-sm leading-6 text-text-secondary">
                      {appliedOnboardingState.dictationProviderDetail}
                    </div>
                    {voiceConfigDirty ? (
                      <div className="mt-4 rounded-2xl border border-semantic-warning/20 bg-semantic-warning/8 px-4 py-3 text-sm leading-6 text-text-secondary">
                        {`The active Dictation path only changes after you press Apply. Until then, ${DISPLAY_NAME} still uses the last saved voice provider, model, and audio settings.`}
                      </div>
                    ) : null}
                  </div>
                  <div className="rounded-2xl border border-white/6 bg-black/20 px-4 py-3 text-sm leading-6 text-text-secondary">
                    API keys now live in <span className="font-medium text-text-primary">Access</span> so Dictation setup stays focused on the active voice path.
                  </div>
                  {draftDictationProviderNeedsAccess ? (
                    <div className="flex justify-end">
                      <FooterButton tone="secondary" onClick={() => onOpenAccessStep(draftConfig.stt.provider)}>
                        {draftDictationProviderNeedsAccess ? 'Manage access' : 'Open Access'}
                      </FooterButton>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {onboardingStep === 'dictation_test' ? (
                <div className="mt-5 space-y-4">
                  <div className="rounded-2xl border border-white/6 bg-white/[0.02] p-4">
                    <div className="text-sm font-medium text-text-primary">Quick test</div>
                    <p className="mt-2 text-sm leading-6 text-text-secondary">
                      {voiceConfigDirty
                        ? 'Apply your pending voice changes first. Dictate and the live runtime still use the last saved voice path until you press Apply.'
                        : `Use Voice Preview below or start a live Dictate pass from the Home screen. Once one real Dictate run succeeds, ${DISPLAY_NAME} will unlock the Smart setup step.`}
                    </p>
                    {appliedOnboardingState.dictationTested ? (
                      <div className="mt-3 rounded-2xl border border-semantic-success/20 bg-semantic-success/8 px-4 py-3 text-sm leading-6 text-text-secondary">
                        Dictation test captured successfully.
                      </div>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap gap-3">
                    {voiceConfigDirty ? (
                      <FooterButton onClick={onSaveConfig} disabled={saving}>
                        {saving ? 'Applying…' : 'Apply voice changes'}
                      </FooterButton>
                    ) : null}
                    <FooterButton onClick={testRecording ? onStopTestRecording : onStartTestRecording}>
                      {testRecording ? 'Stop voice preview' : 'Start voice preview'}
                    </FooterButton>
                    <FooterButton
                      tone="secondary"
                      onClick={() => void window.windowControls?.toggleRecording?.('dictation')}
                      disabled={voiceConfigDirty}
                    >
                      Start Dictate
                    </FooterButton>
                  </div>
                  {testResult ? (
                    <div className="rounded-2xl border border-white/6 bg-black/30 p-4">
                      {testResult.error ? (
                        <div className="text-sm text-semantic-error">{testResult.error}</div>
                      ) : (
                        <pre className="whitespace-pre-wrap text-sm leading-7 text-text-primary">{testResult.transcript || 'No speech detected.'}</pre>
                      )}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {onboardingStep === 'smart_provider' ? (
                <div className="mt-5 space-y-4">
                  <div className="rounded-2xl border border-white/6 bg-white/[0.02] p-4">
                    <div className="text-sm font-medium text-text-primary">Choose the active Smart path</div>
                    <p className="mt-2 text-sm leading-6 text-text-secondary">
                      {`Pick the provider and model ${DISPLAY_NAME} should use for Smart right now. Local LM Studio works when a supported model is loaded; cloud providers need saved access.`}
                    </p>
                    <div className="mt-4">
                      <ProviderPicker
                        label="Smart provider"
                        value={draftConfig.llm.provider}
                        options={PROVIDERS.llm}
                        availableKeys={keysSet}
                        onChange={(provider) => onUpdateProvider('llm', provider)}
                      />
                    </div>
                    <div className="mt-4">
                      <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.24em] text-text-muted">Smart model</label>
                      <select
                        className="w-full rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                        value={draftConfig.llm.model}
                        onChange={(event) => onSetDraftConfig(applyModelSelection(draftConfig, 'llm', event.target.value))}
                      >
                        {displayedLlmModels.map((model) => (
                          <option key={model.id} value={model.id}>{formatProviderModelLabel(model, draftConfig.llm.provider)}</option>
                        ))}
                      </select>
                    </div>
                    <div className="mt-4 rounded-2xl border border-white/6 bg-black/20 px-4 py-3 text-sm leading-6 text-text-secondary">
                      {appliedOnboardingState.rewriteProviderDetail}
                    </div>
                    {rewriteConfigDirty ? (
                      <div className="mt-4 rounded-2xl border border-semantic-warning/20 bg-semantic-warning/8 px-4 py-3 text-sm leading-6 text-text-secondary">
                        The active Smart path only changes after you press Apply. Until then, Smart keeps using the last saved provider and model.
                      </div>
                    ) : null}
                    {draftConfig.llm.provider === 'lmstudio' ? (
                      <div className="mt-4 flex flex-wrap gap-3">
                        <FooterButton tone="secondary" onClick={onRefreshLmStudioModels} disabled={refreshingLmStudioModels}>
                          {refreshingLmStudioModels ? 'Refreshing…' : 'Refresh LM Studio models'}
                        </FooterButton>
                      </div>
                    ) : null}
                  </div>
                  <div className="rounded-2xl border border-white/6 bg-black/20 px-4 py-3 text-sm leading-6 text-text-secondary">
                    API keys now live in <span className="font-medium text-text-primary">Access</span> so Smart setup stays focused on the active provider and model.
                  </div>
                  {draftSmartProviderNeedsAccess ? (
                    <div className="flex justify-end">
                      <FooterButton tone="secondary" onClick={() => onOpenAccessStep(draftConfig.llm.provider)}>
                        {draftSmartProviderNeedsAccess ? 'Manage access' : 'Open Access'}
                      </FooterButton>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {onboardingStep === 'smart_test' ? (
                <div className="mt-5 space-y-4">
                  <div className="rounded-2xl border border-white/6 bg-white/[0.02] p-4">
                    <div className="text-sm font-medium text-text-primary">Quick Smart test</div>
                    <p className="mt-2 text-sm leading-6 text-text-secondary">
                      {smartConfigDirty
                        ? 'Apply your pending voice or Smart changes first. Smart keeps using the last saved runtime path until you press Apply.'
                        : `Run one real Smart pass from Home or the widget. Once one Smart run succeeds, ${DISPLAY_NAME} will mark setup complete for this Mac.`}
                    </p>
                    {appliedOnboardingState.smartTested ? (
                      <div className="mt-3 rounded-2xl border border-semantic-success/20 bg-semantic-success/8 px-4 py-3 text-sm leading-6 text-text-secondary">
                        Smart test captured successfully.
                      </div>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap gap-3">
                    {smartConfigDirty ? (
                      <FooterButton onClick={onSaveConfig} disabled={saving}>
                        {saving ? 'Applying…' : 'Apply Smart changes'}
                      </FooterButton>
                    ) : null}
                    <FooterButton
                      onClick={() => void window.windowControls?.toggleRecording?.('smart_transform')}
                      disabled={smartConfigDirty}
                    >
                      Start Smart
                    </FooterButton>
                    <FooterButton tone="secondary" onClick={() => onNavigateToStep('rewrite')}>
                      Open Smart settings
                    </FooterButton>
                  </div>
                </div>
              ) : null}

              {onboardingStep === 'complete' ? (
                <div className="mt-5 space-y-4">
                  <div className="rounded-2xl border border-semantic-success/20 bg-semantic-success/8 p-4">
                    <div className="text-sm font-medium text-text-primary">Dictation and Smart are ready</div>
                    <p className="mt-2 text-sm leading-6 text-text-secondary">
                      You can start Dictate, Smart, Computer Use, and local-task flows without reopening setup.
                    </p>
                  </div>
                </div>
              ) : null}

              {launchContext?.onboarding_blocker ? (
                <div className="mt-5 rounded-2xl border border-semantic-warning/20 bg-semantic-warning/8 px-4 py-3 text-sm leading-6 text-text-secondary">
                  {launchContext.onboarding_blocker}
                </div>
              ) : null}

              <div className="mt-5 flex flex-wrap gap-3">
                <FooterButton tone="secondary" onClick={onDismissPackagedOnboarding}>Continue later</FooterButton>
                <FooterButton onClick={onCompletePackagedOnboarding} disabled={!onboardingReady}>
                  {onboardingReady ? 'Finish setup' : 'Finish after install, Dictation, and Smart'}
                </FooterButton>
              </div>
            </div>
          </div>
        </SectionCard>
      ) : (
        <SectionCard
          title="Readiness"
          icon={<ShieldIcon size={18} />}
          description="Quick access status for dictation."
        >
          <div className="grid gap-4 lg:grid-cols-3">
            <PermissionCard
              title="Microphone"
              subtitle="Needed to record."
              statusLabel={microphonePermissionLabel}
              tone={microphoneTone}
              action={microphoneAccess !== 'granted' ? <FooterButton onClick={onRequestMicrophone}>{microphoneActionLabel}</FooterButton> : undefined}
            />
            <PermissionCard
              title="Accessibility"
              subtitle="Needed for shortcuts and paste."
              statusLabel={accessibilityPermissionLabel}
              tone={accessibilityTone}
              action={!accessibilityTrusted ? <FooterButton onClick={onRequestAccessibility}>Enable accessibility</FooterButton> : undefined}
            />
            <PermissionCard
              title="Dictation provider"
              subtitle="Needed for live speech recognition."
              statusLabel={currentSttProviderReady ? `${formatProviderName(draftConfig.stt.provider)} ready` : `${formatProviderName(draftConfig.stt.provider)} needs setup`}
              tone={currentSttProviderReady ? 'good' : 'warn'}
              action={!currentSttProviderReady && isApiKeyProviderId(draftConfig.stt.provider)
                ? <FooterButton size="compact" onClick={() => onOpenAccessStep(draftConfig.stt.provider)}>Manage access</FooterButton>
                : undefined}
            />
          </div>
          <div className="mt-4 rounded-2xl border border-white/6 bg-black/20 px-4 py-3 text-sm leading-6 text-text-secondary">
            {appliedOnboardingState.dictationProviderDetail}
          </div>
          {microphoneDeviceHint ? (
            <div className="mt-4 rounded-2xl border border-semantic-warning/20 bg-semantic-warning/8 px-4 py-3 text-sm leading-6 text-text-secondary">
              {microphoneDeviceHint}
            </div>
          ) : null}
        </SectionCard>
      )}

      <SectionCard
        title="Speech recognition"
        icon={<WaveIcon size={18} />}
        description="Choose the provider and model that power Dictate."
      >
        <div className="grid gap-5">
          <ProviderPicker
            label="STT provider"
            value={draftConfig.stt.provider}
            options={PROVIDERS.stt}
            availableKeys={keysSet}
            onChange={(provider) => onUpdateProvider('stt', provider)}
          />

          <div>
            <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.24em] text-text-muted">STT model</label>
            <select
              className="w-full rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
              value={draftConfig.stt.model}
              onChange={(event) => onSetDraftConfig({ ...draftConfig, stt: { ...draftConfig.stt, model: event.target.value } })}
            >
              {sttModels.map((model) => (
                <option key={model.id} value={model.id}>{model.name}</option>
              ))}
            </select>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-[22px] border border-white/6 bg-white/[0.02] px-4 py-3">
            <div className="text-sm leading-6 text-text-secondary">
              API keys are managed in <span className="font-medium text-text-primary">Access</span>. Voice only controls which provider and model Dictate should use.
            </div>
            <FooterButton tone="secondary" onClick={() => onOpenAccessStep(draftConfig.stt.provider)}>
              {draftDictationProviderNeedsAccess ? 'Manage access' : 'Open Access'}
            </FooterButton>
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <div>
              <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.24em] text-text-muted">Recognition mode</label>
              <select
                className="w-full rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                value={draftConfig.stt.language_mode}
                onChange={(event) => setSttLanguageMode(event.target.value as 'fixed' | 'auto')}
              >
                <option value="fixed">One language</option>
                <option value="auto">Auto detect</option>
              </select>
            </div>
            <div>
              <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.24em] text-text-muted">
                {draftConfig.stt.language_mode === 'auto' ? 'Main fallback language' : 'Main language'}
              </label>
              <select
                className="w-full rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                value={draftConfig.stt.language_mode === 'auto' ? primaryAutoLanguage : draftConfig.stt.language}
                onChange={(event) => {
                  if (draftConfig.stt.language_mode === 'auto') {
                    updatePrimaryAutoLanguage(event.target.value)
                    return
                  }
                  updateFixedLanguage(event.target.value)
                }}
              >
                {sttLanguageOptions.map((option) => (
                  <option key={option.code} value={option.code}>{option.label}</option>
                ))}
              </select>
            </div>
          </div>

          {draftConfig.stt.language_mode === 'auto' ? (
            <div className="rounded-[22px] border border-white/6 bg-white/[0.02] p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium text-text-primary">Also expect</div>
                  <p className="mt-1.5 text-sm leading-6 text-text-secondary">
                    Pick a few other languages you switch between often.
                  </p>
                </div>
                <StatusBadge label={formatLanguageLabel(primaryAutoLanguage)} tone="neutral" />
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                {sttLanguageOptions.filter((option) => option.code !== primaryAutoLanguage).map((option) => {
                  const selected = autoSecondaryLanguages.includes(option.code)
                  return (
                    <button
                      key={option.code}
                      type="button"
                      onClick={() => toggleAutoSecondaryLanguage(option.code)}
                      className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${selected
                        ? 'border-white/14 bg-white/[0.08] text-text-primary'
                        : 'border-white/8 bg-white/[0.03] text-text-secondary hover:border-white/12 hover:bg-white/[0.05] hover:text-text-primary'
                      }`}
                    >
                      {option.label}
                    </button>
                  )
                })}
              </div>
            </div>
          ) : null}

          <div className="rounded-2xl border border-white/6 bg-white/[0.02] p-4 text-sm leading-6 text-text-secondary">
            {draftConfig.stt.language_mode === 'auto'
              ? `Auto detect uses the speech provider when it supports language detection. If not, ${DISPLAY_NAME} falls back to your main language first.`
              : 'One language keeps recognition locked to the language you choose above.'}
          </div>

          {usingMlxWhisper ? (
            <div className="space-y-3">
              <div className="rounded-2xl border border-white/6 bg-white/[0.02] p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-text-primary">Local speech summary</div>
                    <p className="mt-2 text-sm leading-6 text-text-secondary">
                      {launchContext?.is_packaged
                        ? `${DISPLAY_NAME} ships local speech with the app bundle, then downloads the selected model into app-managed storage on first use if it is not already present.`
                        : developerMode
                          ? `MLX Whisper runs fully on your Mac and is installed only into ${DISPLAY_NAME}'s backend virtualenv.`
                          : 'MLX Whisper runs fully on your Mac. Install or refresh the local runtime here when you want on-device Dictation.'}
                    </p>
                  </div>
                  <StatusBadge
                    label={launchContext?.is_packaged
                      ? packagedLocalSttBadgeLabel
                      : (
                        mlxInstallState.installed
                          ? (mlxInstallState.ffmpeg_available ? 'Installed locally' : 'Needs ffmpeg')
                          : mlxInstallState.supported ? 'Optional add-on' : 'Unsupported'
                      )}
                    tone={launchContext?.is_packaged
                      ? packagedLocalSttBadgeTone
                      : (
                        mlxInstallState.installed
                          ? (mlxInstallState.ffmpeg_available ? 'good' : 'warn')
                          : mlxInstallState.supported ? 'warn' : 'danger'
                      )}
                  />
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <ContextField label="Apple Silicon" value={launchContext?.is_packaged ? 'Ready' : (mlxInstallState.supported ? 'Ready' : 'Not supported')} />
                  {launchContext?.is_packaged ? (
                    <>
                      <ContextField label="Bundled runtime" value={packagedLocalSttStatus?.runtime_ready ? 'Ready' : 'Missing'} />
                      <ContextField
                        label="ffmpeg"
                        value={
                          !packagedLocalSttStatus
                            ? 'Checking'
                            : packagedLocalSttStatus.ffmpeg_source === 'bundled'
                              ? 'Bundled'
                              : packagedLocalSttStatus.ffmpeg_source === 'system'
                                ? 'System fallback'
                                : 'Missing'
                        }
                      />
                      <ContextField label="Selected model" value={packagedLocalSttStatus?.selected_model_ready ? 'Ready' : 'Downloads on first use'} />
                    </>
                  ) : (
                    <>
                      {developerMode ? <ContextField label="Backend .venv" value={mlxInstallState.venv_available ? 'Available' : 'Missing'} /> : null}
                      <ContextField label="Local runtime" value={mlxInstallState.installed ? 'Installed' : 'Not installed'} />
                      <ContextField label="ffmpeg" value={mlxInstallState.ffmpeg_available ? 'Available' : 'Required'} />
                    </>
                  )}
                  <ContextField label="First use" value="Model downloads on first transcription into app-managed storage" />
                </div>
                <div className="mt-4 text-sm leading-6 text-text-secondary">
                  {launchContext?.is_packaged
                    ? packagedLocalSttStatus?.detail || 'Checking bundled local speech runtime.'
                    : mlxInstallState.detail}
                </div>
                {launchContext?.is_packaged ? (
                  <div className="mt-4 flex flex-wrap gap-3">
                    <FooterButton tone="secondary" onClick={onRefreshRuntimeStatus}>
                      Refresh local speech status
                    </FooterButton>
                  </div>
                ) : mlxInstallState.can_install ? (
                  <div className="mt-4 flex flex-wrap gap-3">
                    <FooterButton onClick={onInstallMlxWhisper}>
                      Install MLX Whisper
                    </FooterButton>
                    <FooterButton tone="secondary" onClick={onCheckMlxWhisperInstallation}>
                      Refresh local status
                    </FooterButton>
                  </div>
                ) : null}
                {!launchContext?.is_packaged && mlxInstallState.installed && !mlxInstallState.ffmpeg_available ? (
                  <div className="mt-4 flex flex-wrap gap-3">
                    <FooterButton tone="secondary" size="compact" onClick={() => void window.windowControls?.writeClipboardText?.('brew install ffmpeg')}>
                      Copy ffmpeg install command
                    </FooterButton>
                  </div>
                ) : null}
                {!launchContext?.is_packaged && mlxInstallState.phase !== 'idle' && mlxInstallState.phase !== 'ready' ? (
                  <div className="mt-5 rounded-2xl border border-white/6 bg-black/20 p-4">
                    <div className="text-sm font-medium text-text-primary">{mlxInstallState.label}</div>
                    <p className="mt-2 text-sm leading-6 text-text-secondary">{mlxInstallState.detail}</p>
                  </div>
                ) : null}
                {!launchContext?.is_packaged && developerMode && (mlxInstallState.logs.length > 0 || mlxInstallState.phase === 'error') ? (
                  <div className="mt-4">
                    <FooterButton tone="secondary" size="compact" onClick={onToggleShowMlxLogs}>
                      {showMlxLogs ? 'Hide install logs' : 'Show install logs'}
                    </FooterButton>
                    {showMlxLogs ? (
                      <div className="mt-3 rounded-2xl border border-white/6 bg-black/35 p-4">
                        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-6 text-text-secondary">
                          {mlxInstallState.logs.join('\n') || 'No install logs yet.'}
                        </pre>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <div className="rounded-2xl border border-white/6 bg-white/[0.02] p-4 text-sm leading-6 text-text-secondary">
                {selectedSttModel
                  ? `${selectedSttModel.name} is selected. ${launchContext?.is_packaged
                    ? 'The packaged app ships the local runtime, and the model downloads into app-managed storage on first use if needed.'
                    : developerMode
                      ? `If MLX Whisper is not installed in the backend virtualenv, Voice Preview and Dictate will show a controlled local-runtime error instead of crashing. Downloaded local speech models are stored under ${DISPLAY_NAME}'s app data.`
                      : 'If the local runtime is missing, Voice Preview and Dictate will show a controlled setup error instead of crashing.'}`
                  : 'Select a local MLX Whisper model to use optional on-device speech recognition.'}
              </div>
              {usingTinyMlxModel ? (
                <div className="rounded-2xl border border-semantic-warning/20 bg-semantic-warning/8 p-4 text-sm leading-6 text-text-secondary">
                  Whisper Tiny is the fastest local option, but it is less accurate for short commands and Smart requests. Whisper Base is the recommended local default.
                </div>
              ) : null}
              {usingHeavyMlxModel ? (
                <div className="rounded-2xl border border-semantic-warning/20 bg-semantic-warning/8 p-4 text-sm leading-6 text-text-secondary">
                  Whisper Turbo is the heaviest local option. Expect a larger first download, slower initial setup, and higher memory use than Tiny or Base.
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </SectionCard>

      <SectionCard
        title="Microphone source"
        icon={<MicIcon size={18} />}
        description="Pick the default input device for Dictate and Smart. Refresh after plugging in a new microphone."
        action={
          <div className="flex items-center gap-2">
            <StatusBadge label={audioDevices.length ? `${audioDevices.length} devices found` : 'System default only'} tone={audioDevices.length ? 'good' : 'warn'} />
            <button
              type="button"
              onClick={onRefreshDevices}
              className="inline-flex items-center gap-2 rounded-2xl border border-white/8 bg-white/[0.03] px-3 py-2 text-sm text-text-secondary transition-colors hover:bg-white/[0.06] hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/45 focus-visible:ring-offset-2 focus-visible:ring-offset-[#091018]"
            >
              <RefreshIcon size={14} className={refreshingDevices ? 'animate-spin' : ''} />
              Refresh
            </button>
          </div>
        }
      >
        <select
          className="w-full rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
          value={configuredDevice?.id || ''}
          onChange={(event) => onSetDraftConfig({
            ...draftConfig,
            audio: {
              ...draftConfig.audio,
              input_device_id: event.target.value || null,
              input_device_label: audioDevices.find((device) => device.id === event.target.value)?.label || null,
              input_device: audioDevices.find((device) => device.id === event.target.value)?.label || null,
            },
          })}
        >
          <option value="">System default microphone</option>
          {audioDevices.map((device) => (
            <option key={device.id} value={device.id}>
              {device.label}{device.is_default ? ' (Default)' : ''}
            </option>
          ))}
        </select>
        {audioDevices.length === 0 ? (
          <div className="mt-4 rounded-2xl border border-semantic-warning/20 bg-semantic-warning/8 px-4 py-3 text-sm leading-6 text-text-secondary">
            {`Only the fallback system microphone is available right now. ${DISPLAY_NAME} now refreshes the device list automatically after microphone access is granted, but you can also use Refresh if you just plugged in a device.`}
          </div>
        ) : null}
      </SectionCard>

      <SectionCard
        title="Voice preview"
        icon={<CheckIcon size={18} />}
        description="Preview transcription without pasting anything."
      >
        <div className="flex flex-wrap items-center gap-3">
          <FooterButton onClick={testRecording ? onStopTestRecording : onStartTestRecording}>
            {testRecording ? 'Stop and preview' : 'Start voice preview'}
          </FooterButton>
          <StatusBadge label={testRecording ? 'Listening' : 'Idle'} tone={testRecording ? 'warn' : 'neutral'} />
        </div>

        {testResult ? (
          <div className="mt-5 rounded-2xl border border-white/6 bg-black/30 p-4">
            {testResult.error ? (
              <div className="space-y-3">
                <div className="text-sm text-semantic-error">{testResult.error}</div>
                {testResult.fallback_notice ? (
                  <div className="text-sm text-semantic-warning">{testResult.fallback_notice}</div>
                ) : null}
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between gap-3 border-b border-white/6 pb-3 text-sm text-text-secondary">
                  <span>Latest preview</span>
                  <span>{testResult.time}s</span>
                </div>
                {testResult.fallback_notice ? (
                  <div className="mt-4 rounded-2xl border border-semantic-warning/20 bg-semantic-warning/8 px-3 py-2 text-sm text-text-secondary">
                    {testResult.fallback_notice}
                  </div>
                ) : null}
                <pre className="mt-4 whitespace-pre-wrap text-sm leading-7 text-text-primary">{testResult.transcript || 'No speech detected.'}</pre>
              </>
            )}
          </div>
        ) : null}
      </SectionCard>

      <SectionCard
        title="Live transcript"
        icon={<WaveIcon size={18} />}
        description={`Show a running transcript in ${DISPLAY_NAME} while Dictate or Smart is capturing audio.`}
        action={<StatusBadge label={liveTranscriptionUi.capabilityLabel} tone={liveTranscriptionUi.capabilityTone} />}
      >
        <div className="grid gap-4 lg:grid-cols-[minmax(0,260px)_1fr]">
          {liveTranscriptionUi.supportsLivePreview ? (
            <div>
              <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-text-muted">
                Preview
              </label>
              <select
                className="w-full rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                value={liveTranscriptionUi.controlValue}
                onChange={(event) => onSetDraftConfig({
                  ...draftConfig,
                  audio: {
                    ...draftConfig.audio,
                    live_transcription_mode: mapLiveTranscriptionControlValue(event.target.value as 'enabled' | 'off'),
                  },
                })}
              >
                <option value="enabled">Provider preview</option>
                <option value="off">Off</option>
              </select>
            </div>
          ) : (
            <div className="rounded-2xl border border-white/6 bg-black/20 px-4 py-3 text-sm leading-6 text-text-secondary">
              <div className="text-sm font-medium text-text-primary">Current provider uses final transcript only</div>
              <p className="mt-2">{liveTranscriptionUi.detail}</p>
            </div>
          )}

          <div className="rounded-2xl border border-white/6 bg-white/[0.02] p-4 text-sm leading-6 text-text-secondary">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-text-primary">{DISPLAY_NAME} capability</span>
              <StatusBadge label={formatProviderName(draftConfig.stt.provider)} tone="neutral" />
            </div>
            <p className="mt-3">{liveTranscriptionUi.detail}</p>
            <p className="mt-3">{liveTranscriptionUi.help}</p>
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title="Recording cues"
        icon={<MicIcon size={18} />}
        description="Optional short sounds when recording starts and stops."
      >
        <ToggleCard
          title="Enable start and stop cues"
          description="Keep this off for the default quiet experience, or turn it on if you rely on keyboard-driven dictation."
          checked={draftConfig.audio.enable_recording_cues}
          onChange={(checked) => onSetDraftConfig({
            ...draftConfig,
            audio: {
              ...draftConfig.audio,
              enable_recording_cues: checked,
            },
          })}
        />
      </SectionCard>

      <VoiceShortcutsSection />
    </>
  )
}
