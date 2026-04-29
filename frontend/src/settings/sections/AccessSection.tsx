import { useState } from 'react'

import { DISPLAY_NAME } from '../../../shared/branding'
import { InfoIcon, KeyIcon } from '../../components/BrandIcons'
import { formatProviderDisplayName } from '../../lib/providerLabels'
import {
  FooterButton,
  SectionCard,
  StatusBadge,
} from '../primitives'
import type { AppConfig, KeyStatusMap } from '../../types'

type ProviderMeta = {
  name: string
  desc?: string
}

type AccessSectionProps = {
  apiKey: string
  apiProvider: string
  apiProviders: readonly string[]
  dirty: boolean
  draftConfig: AppConfig
  keyStatus: 'idle' | 'saving' | 'success' | 'error'
  keysSet: KeyStatusMap
  providerMetaById: Map<string, ProviderMeta>
  readinessState: {
    dictationProviderReady: boolean
    rewriteProviderReady: boolean
  }
  remoteConfig: AppConfig
  savedProviderAccessCount: number
  onApiKeyChange: (value: string) => void
  onClearApiKey: () => void
  onNavigateToStep: (step: 'voice' | 'rewrite') => void
  onProviderSelect: (provider: string) => void
  onSaveApiKey: () => void
}

function formatProviderName(providerId: string, providerMetaById: Map<string, ProviderMeta>) {
  return providerMetaById.get(providerId)?.name || formatProviderDisplayName(providerId)
}

function ProviderLaneSummaryPanel({
  title,
  items,
  providerMetaById,
}: {
  title: string
  items: Array<{ laneLabel: string; providerId: string; modelLabel: string }>
  providerMetaById: Map<string, ProviderMeta>
}) {
  return (
    <div className="rounded-2xl border border-white/6 bg-white/[0.02] p-4">
      <div className="text-[11px] uppercase tracking-[0.28em] text-text-muted">{title}</div>
      <div className="mt-4 overflow-hidden rounded-2xl border border-white/6 bg-black/20">
        {items.map((item, index) => (
          <div
            key={item.laneLabel}
            className={`flex flex-wrap items-center justify-between gap-4 px-4 py-3 ${index > 0 ? 'border-t border-white/6' : ''}`}
          >
            <div>
              <div className="text-[11px] uppercase tracking-[0.24em] text-text-muted">{item.laneLabel}</div>
              <div className="mt-1.5 text-sm font-medium text-text-primary">{formatProviderName(item.providerId, providerMetaById)}</div>
            </div>
            <div className="max-w-full text-right text-xs leading-5 text-text-secondary">{item.modelLabel}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

function ApiKeyWorkbench({
  apiKey,
  apiProvider,
  apiProviders,
  draftConfig,
  keyStatus,
  keysSet,
  providerMetaById,
  readinessState,
  onApiKeyChange,
  onClearApiKey,
  onProviderSelect,
  onSaveApiKey,
}: Omit<AccessSectionProps, 'dirty' | 'remoteConfig' | 'savedProviderAccessCount' | 'onNavigateToStep'>) {
  const [showKey, setShowKey] = useState(false)
  const providerLabel = formatProviderName(apiProvider, providerMetaById)
  const providerMeta = providerMetaById.get(apiProvider)
  const providerStored = Boolean(keysSet[apiProvider])
  const statusLabel = keyStatus === 'saving'
    ? 'Saving key'
    : keyStatus === 'success'
      ? 'Saved'
      : keyStatus === 'error'
        ? 'Save failed'
        : providerStored
          ? 'Stored securely'
          : 'No key saved'
  const statusTone = keyStatus === 'error'
    ? 'danger'
    : keyStatus === 'success' || providerStored
      ? 'good'
      : 'neutral'

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(340px,380px)]">
      <div className="rounded-2xl border border-white/6 bg-white/[0.02] p-4">
        <div className="text-[11px] uppercase tracking-[0.28em] text-text-muted">Choose provider</div>
        <p className="mt-2 text-sm leading-6 text-text-secondary">
          Store or replace cloud provider access here. This does not switch the active Dictation or Smart path by itself.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {apiProviders.map((provider) => {
            const active = apiProvider === provider
            const providerOption = providerMetaById.get(provider)
            const activeLanes = [
              draftConfig.stt.provider === provider ? 'Dictate' : null,
              draftConfig.llm.provider === provider ? 'Smart' : null,
            ].filter((lane): lane is string => Boolean(lane))
            const activeReady = (
              (draftConfig.stt.provider === provider && readinessState.dictationProviderReady)
              || (draftConfig.llm.provider === provider && readinessState.rewriteProviderReady)
            )
            const stored = Boolean(keysSet[provider])
            return (
              <button
                key={provider}
                type="button"
                aria-pressed={active}
                onClick={() => onProviderSelect(provider)}
                className={`h-full overflow-hidden rounded-2xl border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/45 focus-visible:ring-offset-2 focus-visible:ring-offset-[#091018] ${active
                  ? 'border-accent-primary/25 bg-accent-primary/12'
                  : 'border-white/6 bg-black/20 hover:border-white/12 hover:bg-white/[0.04]'
                }`}
              >
                <div className="flex h-full min-w-0 flex-col gap-4">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-text-primary">{formatProviderName(provider, providerMetaById)}</div>
                    <p className="mt-1 text-xs leading-5 text-text-secondary">{providerOption?.desc || 'Cloud provider'}</p>
                  </div>
                  <div className="mt-auto flex min-w-0 flex-wrap gap-2">
                    <StatusBadge label={stored ? 'Key saved' : 'No key'} tone={stored ? 'good' : 'neutral'} />
                    <StatusBadge
                      label={activeLanes.length ? `Active: ${activeLanes.join(' + ')}` : 'Not active'}
                      tone={activeLanes.length ? 'good' : 'neutral'}
                    />
                    <StatusBadge
                      label={activeLanes.length ? (activeReady ? 'Ready' : 'Needs setup') : stored ? 'Saved for later' : 'Add access'}
                      tone={activeLanes.length ? (activeReady ? 'good' : 'warn') : stored ? 'good' : 'neutral'}
                    />
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      </div>

      <div className="rounded-2xl border border-white/6 bg-white/[0.02] p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-[11px] uppercase tracking-[0.28em] text-text-muted">Save secret</div>
            <div className="mt-2 text-lg font-semibold tracking-[-0.02em] text-text-primary">{providerLabel} API key</div>
            <p className="mt-2 max-w-sm text-sm leading-6 text-text-secondary">
              {providerMeta?.desc
                ? `${providerMeta.desc}. Paste the secret you want ${DISPLAY_NAME} to use when ${providerLabel} is selected.`
                : `Paste the secret you want ${DISPLAY_NAME} to use when ${providerLabel} is selected.`}
            </p>
          </div>
          <StatusBadge label={statusLabel} tone={statusTone} />
        </div>

        <div className="mt-5 rounded-2xl border border-white/6 bg-black/20 p-4">
          <label className="block text-xs font-semibold uppercase tracking-[0.24em] text-text-muted">API key value</label>
          <input
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(event) => onApiKeyChange(event.target.value)}
            placeholder={providerStored ? 'Paste a new key to replace the stored one' : 'Paste your API key'}
            className="mt-3 w-full rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
          />
          <div className="mt-3 flex justify-end">
            <FooterButton tone="secondary" size="compact" onClick={() => setShowKey((current) => !current)}>
              {showKey ? 'Hide key' : 'Show key'}
            </FooterButton>
          </div>
          <p className="mt-3 text-xs leading-5 text-text-secondary">
            {providerStored
              ? 'Entering a new value replaces the existing stored key.'
              : 'The key is stored locally and only used when this provider is active.'}
          </p>
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
          {providerStored ? (
            <FooterButton tone="secondary" size="compact" onClick={onClearApiKey} disabled={keyStatus === 'saving'}>
              Clear key
            </FooterButton>
          ) : null}
          <FooterButton size="compact" onClick={onSaveApiKey} disabled={!apiKey || keyStatus === 'saving'}>
            {keyStatus === 'saving' ? 'Saving…' : keyStatus === 'success' ? 'Saved' : keyStatus === 'error' ? 'Try again' : 'Save key'}
          </FooterButton>
        </div>
      </div>
    </div>
  )
}

export function AccessSection(props: AccessSectionProps) {
  return (
    <>
      <SectionCard
        title="Current active paths"
        icon={<InfoIcon size={18} />}
        description="These are the currently applied providers and models. Change Dictate in Voice and change Smart in Smart."
        action={<StatusBadge label={props.savedProviderAccessCount ? `${props.savedProviderAccessCount} saved key${props.savedProviderAccessCount === 1 ? '' : 's'}` : 'No saved keys'} tone={props.savedProviderAccessCount ? 'good' : 'neutral'} />}
      >
        <ProviderLaneSummaryPanel
          title="Currently applied"
          providerMetaById={props.providerMetaById}
          items={[
            {
              laneLabel: 'Dictate',
              providerId: props.remoteConfig.stt.provider,
              modelLabel: props.remoteConfig.stt.model,
            },
            {
              laneLabel: 'Smart',
              providerId: props.remoteConfig.llm.provider,
              modelLabel: props.remoteConfig.llm.model,
            },
          ]}
        />
        <div className="mt-4 flex flex-wrap gap-3">
          <FooterButton tone="secondary" onClick={() => props.onNavigateToStep('voice')}>
            Open Voice
          </FooterButton>
          <FooterButton tone="secondary" onClick={() => props.onNavigateToStep('rewrite')}>
            Open Smart
          </FooterButton>
        </div>
        {props.dirty ? (
          <div className="mt-4 rounded-2xl border border-semantic-warning/20 bg-semantic-warning/8 px-4 py-3 text-sm leading-6 text-text-secondary">
            Pending edits are staged elsewhere in Settings, but the active runtime keeps using these applied paths until you press Apply.
          </div>
        ) : null}
      </SectionCard>

      <SectionCard
        title="Saved API keys"
        icon={<KeyIcon size={18} />}
        description={`Save cloud provider access once here. ${DISPLAY_NAME} only uses a key when that provider is selected in Voice or Smart.`}
      >
        <ApiKeyWorkbench {...props} />
      </SectionCard>
    </>
  )
}
