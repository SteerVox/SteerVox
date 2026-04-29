import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import { ArrowRightIcon, InfoIcon } from '../components/BrandIcons'
import type { DesktopLogKind, DesktopLogSnapshot, KeyStatusMap, ProviderOption } from '../types'

export type StatusTone = 'good' | 'warn' | 'danger' | 'neutral'

function surfaceTone(tone: StatusTone) {
  if (tone === 'good') {
    return 'border-semantic-success/20 bg-semantic-success/8 text-semantic-success'
  }
  if (tone === 'warn') {
    return 'border-semantic-warning/20 bg-semantic-warning/8 text-semantic-warning'
  }
  if (tone === 'danger') {
    return 'border-semantic-error/20 bg-semantic-error/10 text-semantic-error'
  }
  return 'border-white/8 bg-white/[0.03] text-text-secondary'
}

export function StatusBadge({ label, tone }: { label: string; tone: StatusTone }) {
  return (
    <div
      title={label}
      className={`inline-flex min-w-0 max-w-full items-center gap-2 rounded-full border px-2.5 py-1 text-[10px] font-medium leading-none ${surfaceTone(tone)}`}
    >
      <div className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
      <span className="truncate">{label}</span>
    </div>
  )
}

export function SidebarSectionButton({
  active,
  collapsed,
  icon,
  label,
  summary,
  onClick,
}: {
  active: boolean
  collapsed: boolean
  icon: ReactNode
  label: string
  summary: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={collapsed ? label : undefined}
      aria-current={active ? 'page' : undefined}
      aria-pressed={active}
      aria-label={collapsed ? label : undefined}
      className={`settings-sidebar-item flex items-center gap-3 rounded-2xl px-3 py-3 text-left transition-colors ${active
        ? 'settings-sidebar-item-active'
        : 'text-text-secondary hover:text-text-primary'
      } ${collapsed ? 'justify-center' : ''} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25 focus-visible:ring-offset-2 focus-visible:ring-offset-[#161920]`}
    >
      <div
        className={`widget-control flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${active
          ? 'text-text-primary'
          : 'text-text-muted'
        }`}
      >
        {icon}
      </div>
      {!collapsed ? (
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-text-primary">{label}</div>
          {summary ? <div className="mt-1 truncate text-[11px] text-text-muted">{summary}</div> : null}
        </div>
      ) : null}
    </button>
  )
}

export function InfoDisclosure({
  label = 'More info',
  children,
  align = 'right',
}: {
  label?: string
  children: ReactNode
  align?: 'left' | 'right'
}) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const [position, setPosition] = useState<{ top: number; left: number; width: number; placement: 'top' | 'bottom' } | null>(null)

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current
    if (!trigger || typeof window === 'undefined') return

    const rect = trigger.getBoundingClientRect()
    const width = Math.min(288, Math.max(220, window.innerWidth - 24))
    let left = align === 'left' ? rect.left : rect.right - width
    left = Math.min(Math.max(12, left), window.innerWidth - width - 12)

    const panelHeight = panelRef.current?.offsetHeight ?? 140
    const spaceBelow = window.innerHeight - rect.bottom - 12
    const spaceAbove = rect.top - 12
    const placement = spaceBelow < panelHeight && spaceAbove > spaceBelow ? 'top' : 'bottom'
    const top = placement === 'top'
      ? Math.max(12, rect.top - 12)
      : Math.min(window.innerHeight - 12, rect.bottom + 12)

    setPosition({ top, left, width, placement })
  }, [align])

  useEffect(() => {
    if (!open) return undefined

    const frameId = window.requestAnimationFrame(() => {
      updatePosition()
    })

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) {
        return
      }
      setOpen(false)
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
      }
    }

    const handleLayoutChange = () => {
      updatePosition()
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    window.addEventListener('resize', handleLayoutChange)
    window.addEventListener('scroll', handleLayoutChange, true)

    return () => {
      window.cancelAnimationFrame(frameId)
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('resize', handleLayoutChange)
      window.removeEventListener('scroll', handleLayoutChange, true)
    }
  }, [open, updatePosition])

  return (
    <>
      <div className="shrink-0">
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen((current) => !current)}
          title={label}
          aria-label={label}
          aria-expanded={open}
          className={`inline-flex h-8 w-8 items-center justify-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25 focus-visible:ring-offset-2 focus-visible:ring-offset-[#161920] ${open
            ? 'border-white/14 bg-white/[0.08] text-text-primary'
            : 'border-white/8 bg-white/[0.03] text-text-muted hover:border-white/12 hover:bg-white/[0.05] hover:text-text-primary'
          }`}
        >
          <InfoIcon size={14} />
        </button>
      </div>

      {open && position && typeof document !== 'undefined'
        ? createPortal(
          <div
            ref={panelRef}
            style={{
              position: 'fixed',
              top: position.top,
              left: position.left,
              width: position.width,
              transform: position.placement === 'top' ? 'translateY(-100%)' : undefined,
            }}
            className="z-[120] rounded-2xl border border-white/10 bg-[linear-gradient(180deg,rgba(35,39,47,0.96),rgba(19,22,28,0.98))] p-3 text-xs leading-6 text-text-secondary shadow-[0_18px_36px_rgba(0,0,0,0.28)] backdrop-blur-xl"
          >
            {children}
          </div>,
          document.body,
        )
        : null}
    </>
  )
}

export function SwitchControl({
  checked,
  onChange,
  label,
  size = 'default',
  disabled = false,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  size?: 'default' | 'compact'
  disabled?: boolean
}) {
  const compact = size === 'compact'

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-disabled={disabled}
      aria-label={label}
      disabled={disabled}
      onClick={() => {
        if (disabled) return
        onChange(!checked)
      }}
      className={`relative inline-flex shrink-0 items-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25 focus-visible:ring-offset-2 focus-visible:ring-offset-[#161920] ${compact ? 'h-6 w-10' : 'h-7 w-12'} ${checked
        ? 'border-accent-primary/30 bg-accent-primary/30'
        : 'border-white/10 bg-white/[0.05] hover:border-white/16 hover:bg-white/[0.08]'
      } ${disabled ? 'cursor-not-allowed opacity-45 hover:border-white/10 hover:bg-white/[0.05]' : ''}`}
    >
      <span
        className={`absolute rounded-full bg-white shadow-[0_6px_16px_rgba(0,0,0,0.28)] transition-transform ${compact ? 'h-[18px] w-[18px]' : 'h-5 w-5'} ${checked
          ? compact ? 'translate-x-[18px]' : 'translate-x-[22px]'
          : 'translate-x-[3px]'
        }`}
      />
    </button>
  )
}

export function ToggleCard({
  title,
  description,
  checked,
  onChange,
  disabled = false,
}: {
  title: string
  description: string
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
}) {
  return (
    <div className={`flex items-start justify-between gap-4 rounded-2xl border border-white/6 bg-white/[0.02] p-4 ${disabled ? 'opacity-70' : ''}`}>
      <div>
        <div className="text-sm font-medium text-text-primary">{title}</div>
        <p className="mt-2 text-sm leading-6 text-text-secondary">{description}</p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <span className="text-[11px] uppercase tracking-[0.18em] text-text-muted">{checked ? 'On' : 'Off'}</span>
        <SwitchControl checked={checked} onChange={onChange} label={title} disabled={disabled} />
      </div>
    </div>
  )
}

export function InlineSwitch({
  checked,
  onChange,
  label = 'Enabled',
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label?: string
}) {
  return (
    <div className="inline-flex items-center gap-3 text-sm text-text-secondary">
      <span>{label}</span>
      <SwitchControl checked={checked} onChange={onChange} label={label} size="compact" />
    </div>
  )
}

export function SectionCard({
  title,
  icon,
  children,
  description,
  action,
  collapsible = false,
  defaultOpen = true,
}: {
  title: string
  icon: ReactNode
  children: ReactNode
  description?: string
  action?: ReactNode
  collapsible?: boolean
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <section className="glass-card p-5">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3 text-sm font-semibold text-text-primary">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl border border-white/8 bg-white/[0.035] text-text-primary/90 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
              {icon}
            </div>
            <span>{title}</span>
            {description ? (
              <InfoDisclosure label={`${title} help`}>
                <p>{description}</p>
              </InfoDisclosure>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {action}
          {collapsible ? (
            <button
              type="button"
              onClick={() => setOpen((current) => !current)}
              aria-expanded={open}
              className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/8 bg-white/[0.03] text-text-muted transition-colors hover:border-white/12 hover:bg-white/[0.05] hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25 focus-visible:ring-offset-2 focus-visible:ring-offset-[#161920]"
              title={open ? 'Collapse section' : 'Expand section'}
            >
              <ArrowRightIcon size={14} className={`transition-transform duration-200 ${open ? 'rotate-90' : 'rotate-0'}`} />
            </button>
          ) : null}
        </div>
      </div>
      {(!collapsible || open) ? children : null}
    </section>
  )
}

export function LogPathCard({
  label,
  path,
}: {
  label: string
  path: string
}) {
  const copyPath = () => {
    void window.windowControls?.writeClipboardText?.(path)
  }

  return (
    <div className="group relative rounded-2xl border border-white/6 bg-white/[0.02] p-4">
      <div className="text-[11px] uppercase tracking-[0.26em] text-text-muted">{label}</div>
      <code className="mt-3 block break-all rounded-xl bg-black/35 px-3 py-2 text-xs text-text-primary">{path}</code>
      <button
        type="button"
        onClick={copyPath}
        className="absolute right-4 top-4 rounded border border-white/10 bg-white/5 px-2 py-1 text-[10px] text-text-secondary opacity-0 transition-opacity hover:bg-white/10 hover:text-text-primary group-hover:opacity-100"
      >
        Copy
      </button>
    </div>
  )
}

export function LiveLogViewer({
  activeKind,
  logs,
  onSelect,
}: {
  activeKind: DesktopLogKind
  logs: Record<DesktopLogKind, DesktopLogSnapshot>
  onSelect: (kind: DesktopLogKind) => void
}) {
  const activeLog = logs[activeKind]
  const detail = activeLog.error
    ? `Could not read the ${activeKind} log: ${activeLog.error}`
    : activeLog.exists
      ? activeLog.content || 'No log lines recorded yet.'
      : 'This log file has not been created yet.'

  return (
    <div className="rounded-[24px] border border-white/6 bg-black/20 p-4">
      <div className="flex flex-wrap items-center gap-2">
        {(['backend', 'electron'] as DesktopLogKind[]).map((kind) => {
          const selected = kind === activeKind
          return (
            <button
              key={kind}
              type="button"
              onClick={() => onSelect(kind)}
              className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${selected
                ? 'border-white/18 bg-white/10 text-text-primary'
                : 'border-white/8 bg-white/[0.03] text-text-secondary hover:text-text-primary'
              }`}
            >
              {kind === 'backend' ? 'Backend' : 'Electron'}
            </button>
          )
        })}
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-[11px] uppercase tracking-[0.22em] text-text-muted">
        <span>{activeKind === 'backend' ? 'Backend log' : 'Electron log'}</span>
        <span>
          {activeLog.updated_at
            ? `Updated ${new Date(activeLog.updated_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
            : activeLog.exists
              ? 'Updated recently'
              : 'Waiting for first log line'}
        </span>
      </div>
      <code className="mt-2 block break-all rounded-xl bg-black/35 px-3 py-2 text-xs text-text-primary">{activeLog.path}</code>
      <div className="mt-4 h-[320px] overflow-y-auto rounded-2xl border border-white/6 bg-[#07090d] p-4">
        <pre className="whitespace-pre-wrap text-xs leading-6 text-text-secondary">{detail}</pre>
      </div>
      {activeLog.truncated ? (
        <p className="mt-3 text-xs leading-5 text-text-muted">Showing the latest portion of the file so the viewer stays responsive.</p>
      ) : null}
    </div>
  )
}

export function PermissionCard({
  title,
  subtitle,
  statusLabel,
  tone,
  action,
}: {
  title: string
  subtitle: string
  statusLabel: string
  tone: StatusTone
  action?: ReactNode
}) {
  return (
    <div className="section-intro-panel h-full rounded-2xl border border-white/6 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-text-primary">{title}</h3>
          <p className="mt-1.5 text-sm leading-6 text-text-secondary">{subtitle}</p>
        </div>
        <StatusBadge label={statusLabel} tone={tone} />
      </div>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  )
}

export function ProviderPicker({
  label,
  value,
  options,
  availableKeys,
  onChange,
}: {
  label: string
  value: string
  options: ProviderOption[]
  availableKeys: KeyStatusMap
  onChange: (provider: string) => void
}) {
  return (
    <div>
      <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.24em] text-text-muted">{label}</label>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
        {options.map((option) => {
          const active = option.id === value
          const requiresKey = option.requiresKey !== false
          const keyReady = Boolean(availableKeys[option.id])
          return (
            <button
              key={option.id}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(option.id)}
              title={`${option.name}: ${option.desc}`}
              className={`h-full overflow-hidden rounded-2xl border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25 focus-visible:ring-offset-2 focus-visible:ring-offset-[#161920] ${active
                ? 'border-white/14 bg-white/[0.08] shadow-[0_10px_24px_rgba(0,0,0,0.12)]'
                : 'border-white/6 bg-white/[0.02] hover:border-white/12 hover:bg-white/[0.04]'
              }`}
            >
              <div className="flex h-full min-w-0 flex-col gap-3">
                <div className="min-w-0 text-sm font-medium text-text-primary">{option.name}</div>
                <div className="mt-auto flex min-w-0 flex-wrap gap-2">
                  {requiresKey
                    ? (keyReady ? <StatusBadge label="Key ready" tone="good" /> : <StatusBadge label="No key" tone="neutral" />)
                    : <StatusBadge label="Local" tone="good" />}
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

export function ContextField({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="rounded-2xl border border-white/6 bg-white/[0.02] p-4">
      <div className="text-[11px] uppercase tracking-[0.28em] text-text-muted">{label}</div>
      <div className="mt-2 break-all font-mono text-sm text-text-primary">{value || 'Unknown'}</div>
    </div>
  )
}

export function OptionalContextField({
  label,
  value,
  emptyLabel,
}: {
  label: string
  value: string | null | undefined
  emptyLabel: string
}) {
  return (
    <div className="rounded-2xl border border-white/6 bg-white/[0.02] p-4">
      <div className="text-[11px] uppercase tracking-[0.28em] text-text-muted">{label}</div>
      <div className="mt-2 break-all font-mono text-sm text-text-primary">{value || emptyLabel}</div>
    </div>
  )
}

export function ReadOnlyShortcut({
  title,
  shortcut,
  description,
}: {
  title: string
  shortcut: string
  description: string
}) {
  return (
    <div className="rounded-2xl border border-white/6 bg-white/[0.02] p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-text-primary">{title}</h3>
        <kbd className="rounded-xl border border-white/10 bg-white/[0.05] px-2.5 py-1 font-mono text-xs text-text-primary">
          {shortcut}
        </kbd>
      </div>
      <p className="mt-3 text-sm leading-6 text-text-secondary">{description}</p>
    </div>
  )
}

export function InspectorField({
  label,
  value,
}: {
  label: string
  value: string
}) {
  return (
    <div className="rounded-2xl border border-white/6 bg-white/[0.02] p-4">
      <div className="text-[11px] uppercase tracking-[0.28em] text-text-muted">{label}</div>
      <div className="mt-2 break-all text-sm leading-6 text-text-primary">{value}</div>
    </div>
  )
}

export function UsageMetricCard({
  label,
  value,
  hint,
}: {
  label: string
  value: string
  hint?: string
}) {
  return (
    <div className="rounded-2xl border border-white/6 bg-white/[0.02] p-4">
      <div className="text-[11px] uppercase tracking-[0.28em] text-text-muted">{label}</div>
      <div className="mt-2 text-xl font-semibold tracking-[-0.03em] text-text-primary">{value}</div>
      {hint ? <div className="mt-2 text-xs leading-5 text-text-secondary">{hint}</div> : null}
    </div>
  )
}

export function FooterButton({
  children,
  tone = 'primary',
  size = 'default',
  disabled,
  onClick,
}: {
  children: ReactNode
  tone?: 'primary' | 'secondary'
  size?: 'default' | 'compact'
  disabled?: boolean
  onClick: () => void
}) {
  const classes = tone === 'primary'
    ? 'border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.16),rgba(255,255,255,0.08))] text-text-primary hover:bg-[linear-gradient(180deg,rgba(255,255,255,0.2),rgba(255,255,255,0.1))]'
    : 'border-white/8 bg-white/[0.03] text-text-primary hover:bg-white/[0.06]'
  const sizeClasses = size === 'compact'
    ? 'rounded-xl px-3 py-2 text-xs'
    : 'rounded-2xl px-4 py-2.5 text-sm font-medium'

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex shrink-0 items-center justify-center whitespace-nowrap border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25 focus-visible:ring-offset-2 focus-visible:ring-offset-[#161920] disabled:cursor-not-allowed disabled:opacity-45 ${sizeClasses} ${classes}`}
    >
      {children}
    </button>
  )
}
