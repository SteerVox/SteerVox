import { SetupIcon, ShieldIcon, WarningIcon } from '../../components/BrandIcons'
import type { AppConfig, SensitiveTargetRule, SmartContext } from '../../types'
import {
  ContextField,
  FooterButton,
  InlineSwitch,
  OptionalContextField,
  SectionCard,
  StatusBadge,
  ToggleCard,
  type StatusTone,
} from '../primitives'

type PrivacySectionProps = {
  canUseCurrentFrontmostApp: boolean
  contextAccessMessage: string
  contextAccessStatus: 'full' | 'app-only' | 'transcript-only' | 'unavailable'
  contextStatusLabel: string
  contextTone: StatusTone
  contextWarning: string | null | undefined
  draftConfig: AppConfig
  hasLastCapture: boolean
  hasUsefulLiveContext: boolean
  lastCaptureMeta: {
    capturedAtLabel: string
    qualityLabel: string
    qualityTone: StatusTone
    targetTypeLabel: string
  }
  lastCapturePreview: SmartContext
  liveContextPreview: SmartContext
  privacyEnvironmentPending: boolean
  onRequestSmartContext: () => void
  onSetMinimizeSensitiveContext: (checked: boolean) => void
  onSetRestoreClipboardAfterPaste: (checked: boolean) => void
  onRemoveSensitiveTargetRule: (ruleId: string) => void
  onUpdateSensitiveTargetRule: (ruleId: string, updates: Partial<SensitiveTargetRule>) => void
  onUpsertCurrentSensitiveTargetRule: () => void
}

export function PrivacySection({
  canUseCurrentFrontmostApp,
  contextAccessMessage,
  contextAccessStatus,
  contextStatusLabel,
  contextTone,
  contextWarning,
  draftConfig,
  hasLastCapture,
  hasUsefulLiveContext,
  lastCaptureMeta,
  lastCapturePreview,
  liveContextPreview,
  privacyEnvironmentPending,
  onRequestSmartContext,
  onSetMinimizeSensitiveContext,
  onSetRestoreClipboardAfterPaste,
  onRemoveSensitiveTargetRule,
  onUpdateSensitiveTargetRule,
  onUpsertCurrentSensitiveTargetRule,
}: PrivacySectionProps) {
  return (
    <>
      <SectionCard
        title="Privacy controls"
        icon={<ShieldIcon size={18} />}
        description="Keep Smart local-first and reduce context for sensitive apps or sites."
        action={<StatusBadge label={draftConfig.privacy.restore_clipboard_after_paste ? 'Clipboard restore on' : 'Clipboard restore off'} tone={draftConfig.privacy.restore_clipboard_after_paste ? 'good' : 'warn'} />}
        collapsible
        defaultOpen={false}
      >
        <div className="grid gap-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <ToggleCard
              title="Restore clipboard after paste"
              description="Put your previous clipboard contents back right after SteerVox pastes the result."
              checked={draftConfig.privacy.restore_clipboard_after_paste}
              onChange={onSetRestoreClipboardAfterPaste}
            />
            <ToggleCard
              title="Minimize sensitive context"
              description="Trim browser titles, path, and field metadata when a sensitive-target rule asks for stricter privacy."
              checked={draftConfig.privacy.minimize_sensitive_context}
              onChange={onSetMinimizeSensitiveContext}
            />
          </div>

          <div className="rounded-2xl border border-white/6 bg-white/[0.02] px-4 py-3 text-sm leading-6 text-text-secondary">
            Password-like fields and clearly medical contexts already tighten privacy automatically. Use rules below only for extra app or site-specific control.
          </div>

          <div className="rounded-[22px] border border-white/6 bg-white/[0.02] p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-text-primary">Sensitive targets</div>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-text-secondary">
                  Use these rules to reduce context or suppress selected text and clipboard text for specific apps or hosts.
                </p>
              </div>
              <FooterButton tone="secondary" onClick={onUpsertCurrentSensitiveTargetRule} disabled={!canUseCurrentFrontmostApp}>
                Use current frontmost target
              </FooterButton>
            </div>

            <div className="mt-4 grid gap-4">
              {(draftConfig.privacy.sensitive_targets || []).length ? draftConfig.privacy.sensitive_targets.map((rule) => (
                <div key={rule.id} className="rounded-2xl border border-white/6 bg-black/20 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium text-text-primary">{rule.app_label}</div>
                      <p className="mt-2 text-sm leading-6 text-text-secondary">
                        Matches <span className="font-medium text-text-primary">{rule.app_name}</span>
                        {rule.url_host ? ` on ${rule.url_host}` : ''}
                        {rule.bundle_id ? ` with bundle id ${rule.bundle_id}` : ''}
                        .
                      </p>
                    </div>
                    <InlineSwitch
                      checked={rule.enabled}
                      onChange={(checked) => onUpdateSensitiveTargetRule(rule.id, { enabled: checked })}
                    />
                  </div>
                  <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto]">
                    <div>
                      <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.24em] text-text-muted">Rule mode</label>
                      <select
                        className="w-full rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                        value={rule.mode}
                        onChange={(event) => onUpdateSensitiveTargetRule(rule.id, { mode: event.target.value as SensitiveTargetRule['mode'] })}
                      >
                        <option value="minimize_context">Minimize context</option>
                        <option value="block_external_text">Block selected and clipboard text</option>
                      </select>
                    </div>
                    <div className="flex items-end">
                      <FooterButton tone="secondary" onClick={() => onRemoveSensitiveTargetRule(rule.id)}>
                        Remove
                      </FooterButton>
                    </div>
                  </div>
                </div>
              )) : (
                <div className="rounded-2xl border border-dashed border-white/10 bg-black/20 px-4 py-3 text-sm leading-6 text-text-secondary">
                  No sensitive-target rules yet. Add the current app or host when you need stricter privacy.
                </div>
              )}
            </div>
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title="Context"
        icon={<SetupIcon size={18} />}
        description="See what Smart can use right now and what it last captured."
        action={<StatusBadge label={privacyEnvironmentPending ? contextStatusLabel : contextAccessStatus === 'full' ? 'Ready' : contextAccessStatus === 'app-only' ? 'Partial' : 'Transcript only'} tone={contextTone} />}
        collapsible
        defaultOpen={false}
      >
        <div className="grid gap-4 xl:grid-cols-2">
          <div className="rounded-2xl border border-white/6 bg-white/[0.02] p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-text-primary">Live context</div>
                <p className="mt-2 text-sm leading-6 text-text-secondary">
                  The current frontmost destination.
                </p>
              </div>
              <StatusBadge label={contextStatusLabel} tone={contextTone} />
            </div>

            <div className="mt-4 grid gap-4">
              <ContextField label="App name" value={liveContextPreview.app_name} />
              <ContextField label="Window title" value={liveContextPreview.window_title} />
              <ContextField label="Page title" value={liveContextPreview.page_title} />
              <ContextField label="Site host" value={liveContextPreview.url_host} />
              <ContextField label="Page path" value={liveContextPreview.url_path} />
              <OptionalContextField label="Code file" value={liveContextPreview.code_file_name} emptyLabel="Unavailable" />
              <ContextField label="Surface kind" value={liveContextPreview.surface_kind} />
              <OptionalContextField label="Focused field label" value={liveContextPreview.focused_field_label} emptyLabel="Unavailable" />
              <OptionalContextField label="Focused field placeholder" value={liveContextPreview.focused_field_placeholder} emptyLabel="Unavailable" />
            </div>

            <div className="mt-4 rounded-2xl border border-white/6 bg-black/20 px-4 py-3 text-sm leading-6 text-text-secondary">
              {contextAccessMessage}
            </div>
          </div>

          <div className="rounded-2xl border border-white/6 bg-white/[0.02] p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-text-primary">Last capture</div>
                <p className="mt-2 text-sm leading-6 text-text-secondary">
                  The last destination Smart captured at record start.
                </p>
              </div>
              <StatusBadge label={lastCaptureMeta.qualityLabel} tone={lastCaptureMeta.qualityTone} />
            </div>

            <div className="mt-4 grid gap-4">
              <OptionalContextField label="App name" value={lastCapturePreview.app_name} emptyLabel={hasLastCapture ? 'Unknown' : 'Not available'} />
              <OptionalContextField label="Window title" value={lastCapturePreview.window_title} emptyLabel={hasLastCapture ? 'Unknown' : 'Not available'} />
              <OptionalContextField label="Page title" value={lastCapturePreview.page_title} emptyLabel={hasLastCapture ? 'Unknown' : 'Not available'} />
              <OptionalContextField label="Site host" value={lastCapturePreview.url_host} emptyLabel={hasLastCapture ? 'Unknown' : 'Not available'} />
              <OptionalContextField label="Page path" value={lastCapturePreview.url_path} emptyLabel={hasLastCapture ? 'Unknown' : 'Not available'} />
              <OptionalContextField label="Code file" value={lastCapturePreview.code_file_name} emptyLabel={hasLastCapture ? 'Unavailable' : 'Not available'} />
              <OptionalContextField label="Surface kind" value={lastCapturePreview.surface_kind} emptyLabel={hasLastCapture ? 'Unknown' : 'Not available'} />
              <OptionalContextField label="Focused field label" value={lastCapturePreview.focused_field_label} emptyLabel={hasLastCapture ? 'Unavailable' : 'Not available'} />
              <OptionalContextField label="Focused field placeholder" value={lastCapturePreview.focused_field_placeholder} emptyLabel={hasLastCapture ? 'Unavailable' : 'Not available'} />
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <StatusBadge label={`Captured: ${lastCaptureMeta.capturedAtLabel}`} tone="neutral" />
              <StatusBadge label={`Target type: ${lastCaptureMeta.targetTypeLabel}`} tone="neutral" />
            </div>

            {!hasLastCapture ? (
              <div className="mt-4 rounded-2xl border border-dashed border-white/10 bg-black/20 px-4 py-3 text-sm leading-6 text-text-secondary">
                No Smart capture yet. Run Smart once to populate this card.
              </div>
            ) : null}

            {!hasLastCapture && hasUsefulLiveContext ? (
              <div className="mt-4 rounded-2xl border border-accent-primary/14 bg-accent-primary/8 px-4 py-3 text-sm leading-6 text-text-secondary">
                Live context is available. This card fills in after your first Smart run.
              </div>
            ) : null}
          </div>
        </div>

        {contextWarning ? (
          <div className="mt-5 rounded-2xl border border-semantic-warning/20 bg-semantic-warning/8 p-4">
            <div className="flex items-start gap-3">
              <WarningIcon size={18} className="mt-0.5 text-semantic-warning" />
              <div>
                <div className="text-sm font-medium text-text-primary">Limited context</div>
                <p className="mt-2 text-sm leading-6 text-text-secondary">{contextWarning}</p>
                <div className="mt-4">
                  <FooterButton onClick={onRequestSmartContext}>Retry context access</FooterButton>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          <div className="rounded-2xl border border-white/6 bg-white/[0.02] p-4 text-sm leading-7 text-text-secondary">
            Smart captures the frontmost app and window when recording starts, then adds browser hostname, a sanitized page path, and focused field metadata like the field label or placeholder when available. Referential commands can also use selected text or clipboard text.
          </div>
          <div className="rounded-2xl border border-white/6 bg-white/[0.02] p-4 text-sm leading-7 text-text-secondary">
            Browser details are best-effort and fall back cleanly when unavailable. SteerVox does not read the existing contents of the focused field. Query strings, fragments, and full page content stay out of the Smart payload unless you explicitly work from selected or clipboard text.
          </div>
        </div>
      </SectionCard>
    </>
  )
}
