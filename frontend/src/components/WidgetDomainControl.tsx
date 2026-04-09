import { ChevronDownIcon } from './BrandIcons'
import type { ActiveDomainStatus, DomainMode } from '../types'

const DOMAIN_MODE_OPTIONS: Array<{ value: DomainMode; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'off', label: 'Off' },
  { value: 'shipping', label: 'Shipping' },
  { value: 'medical', label: 'Medical' },
]

const DOMAIN_SOURCE_LABEL: Record<ActiveDomainStatus['source'], string> = {
  app_override: 'App rule',
  global_pin: 'Pinned',
  system_rule: 'Auto',
}

function getBadgeLabel(activeDomain: ActiveDomainStatus) {
  return activeDomain.id === 'shipping' ? 'Shipping' : 'Medical'
}

function getBadgeTone(activeDomain: ActiveDomainStatus) {
  return activeDomain.id === 'shipping'
    ? 'border-[#8ceef8]/28 bg-[rgba(19,80,96,0.48)] text-[#8ceef8]'
    : 'border-semantic-success/28 bg-[rgba(22,88,56,0.48)] text-semantic-success'
}

function getStatusDetail(activeDomain?: ActiveDomainStatus | null) {
  return activeDomain
    ? DOMAIN_SOURCE_LABEL[activeDomain.source]
    : 'No domain is active right now'
}

type WidgetDomainStatusChipProps = {
  activeDomain?: ActiveDomainStatus | null
}

type WidgetDomainModeControlProps = {
  activeDomain?: ActiveDomainStatus | null
  domainMode: DomainMode
  disabled?: boolean
  updating?: boolean
  onChange: (mode: DomainMode) => void
}

export function WidgetDomainStatusChip({
  activeDomain,
}: WidgetDomainStatusChipProps) {
  const badgeTitle = activeDomain
    ? `${activeDomain.label} • ${DOMAIN_SOURCE_LABEL[activeDomain.source]}`
    : 'No active domain'

  return (
    <div
      className="titlebar-nodrag widget-pill grid min-h-[44px] w-full min-w-0 content-center gap-1 rounded-[18px] border border-white/14 px-3.5 py-2"
      data-testid="widget-domain-status"
      title={badgeTitle}
    >
      <span className="truncate text-[10px] font-semibold uppercase tracking-[0.16em] text-white/62">
        Domain
      </span>
      <div className="min-w-0 flex items-center gap-2">
        {activeDomain ? (
          <div
            className={`inline-flex max-w-full shrink items-center rounded-full border px-2 py-1 text-[11px] font-semibold tracking-[0.01em] ${getBadgeTone(activeDomain)}`}
            data-testid="widget-domain-badge"
          >
            <span className="truncate">{getBadgeLabel(activeDomain)}</span>
          </div>
        ) : (
          <div
            className="truncate text-[13px] font-semibold tracking-[-0.01em] text-text-primary"
            data-testid="widget-domain-badge-empty"
          >
            No active domain
          </div>
        )}
        {activeDomain ? (
          <div
            className="truncate text-[11px] font-medium tracking-[-0.01em] text-text-secondary"
            data-testid="widget-domain-source"
          >
            {getStatusDetail(activeDomain)}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function WidgetDomainModeControl({
  activeDomain,
  domainMode,
  disabled = false,
  updating = false,
  onChange,
}: WidgetDomainModeControlProps) {
  const menuDisabled = disabled || updating
  const activeOptionLabel = DOMAIN_MODE_OPTIONS.find((option) => option.value === domainMode)?.label || 'Auto'
  const title = activeDomain
    ? `${activeDomain.label} • ${DOMAIN_SOURCE_LABEL[activeDomain.source]}`
    : 'No active domain'

  return (
    <div
      className="titlebar-nodrag widget-pill grid min-h-[44px] w-full min-w-0 content-center gap-1 rounded-[18px] border border-white/14 px-3.5 py-2"
      data-testid="widget-domain-mode-control"
      title={`Domain mode: ${activeOptionLabel}${activeDomain ? ` • ${title}` : ''}`}
    >
      <span className="truncate text-[10px] font-semibold uppercase tracking-[0.16em] text-white/62">
        Domain mode
      </span>
      <div className="relative min-w-0">
        <select
          aria-label="Domain mode"
          className="widget-inline-select titlebar-nodrag h-5 w-full bg-transparent pr-8 text-[13px] font-semibold tracking-[-0.01em] text-text-primary outline-none disabled:cursor-not-allowed disabled:opacity-55"
          data-testid="widget-domain-mode-select"
          disabled={menuDisabled}
          onChange={(event) => onChange(event.target.value as DomainMode)}
          title={activeOptionLabel}
          value={domainMode}
        >
          {DOMAIN_MODE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDownIcon
          size={13}
          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-white/78"
        />
      </div>
    </div>
  )
}
