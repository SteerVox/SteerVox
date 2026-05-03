import { ChevronDownIcon } from './BrandIcons'

type WidgetModeOption = {
  id: string
  name: string
  group?: string
}

type WidgetModeControlProps = {
  activeModeLabel: string
  options: WidgetModeOption[]
  selectedSkillId: string
  disabled?: boolean
  onChange: (skillId: string) => void
}

export function WidgetModeControl({
  activeModeLabel,
  options,
  selectedSkillId,
  disabled = false,
  onChange,
}: WidgetModeControlProps) {
  return (
    <div
      className="widget-pill relative grid min-h-[44px] w-full min-w-0 content-center gap-1 rounded-[18px] border border-white/14 px-3.5 py-2 text-left text-text-primary"
      data-testid="widget-mode-control"
      title={`Active mode: ${activeModeLabel}`}
    >
      <span className="truncate text-[10px] font-semibold uppercase tracking-[0.16em] text-white/62">
        Mode
      </span>
      <div className="relative min-w-0">
        <select
          aria-label="Active mode"
          className="widget-inline-select titlebar-nodrag h-5 w-full bg-transparent pr-8 text-[13px] font-semibold tracking-[-0.01em] text-text-primary outline-none disabled:cursor-not-allowed disabled:opacity-60"
          data-testid="widget-mode-select"
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          title={activeModeLabel}
          value={selectedSkillId}
        >
          {Object.entries(options.reduce<Record<string, WidgetModeOption[]>>((groups, option) => {
            const key = option.group || 'Modes'
            groups[key] = groups[key] || []
            groups[key].push(option)
            return groups
          }, {})).map(([groupLabel, groupOptions]) => (
            <optgroup key={groupLabel} label={groupLabel}>
              {groupOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </optgroup>
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
