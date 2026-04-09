import { DISPLAY_NAME } from '../../shared/branding'
import { BrandMark, SparkIcon } from './BrandIcons'

interface BrandedProgressLoaderProps {
  title: string
  subtitle?: string
  progress?: number | null
  compact?: boolean
  className?: string
}

export function BrandedProgressLoader({
  title,
  subtitle,
  progress = null,
  compact = false,
  className = '',
}: BrandedProgressLoaderProps) {
  const resolvedProgress = typeof progress === 'number'
    ? Math.max(6, Math.min(progress, 100))
    : null

  if (compact) {
    return (
      <div className={`flex items-center gap-3 ${className}`}>
        <div className="relative flex h-10 w-10 items-center justify-center">
          <BrandMark size={24} />
          <div className="pointer-events-none absolute inset-[-6px] rounded-full bg-[radial-gradient(circle,_rgba(45,212,255,0.16),_transparent_72%)] blur-md" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold tracking-[-0.01em] text-text-primary">{title}</div>
          {subtitle ? (
            <p className="mt-0.5 text-[11px] leading-5 text-text-secondary">{subtitle}</p>
          ) : null}
          <div className="mt-2 h-[3px] overflow-hidden rounded-full bg-white/[0.08]">
            {resolvedProgress == null ? (
              <div className="h-full w-1/3 rounded-full bg-[linear-gradient(90deg,rgba(18,222,230,0.18),rgba(18,222,230,0.9),rgba(18,222,230,0.18))] animate-loader-sweep" />
            ) : (
              <div
                className="h-full rounded-full bg-[linear-gradient(90deg,rgba(18,222,230,0.7),rgba(129,243,246,1))] transition-[width] duration-500"
                style={{ width: `${resolvedProgress}%` }}
              />
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={`flex flex-col items-center justify-center gap-5 text-center ${className}`}>
      <div className="relative">
        <div className="absolute inset-[-16px] rounded-full bg-[radial-gradient(circle,_rgba(45,212,255,0.24),_transparent_72%)] blur-xl" />
        <div className="relative flex h-20 w-20 items-center justify-center">
          <BrandMark size={52} />
        </div>
      </div>
      <div className="max-w-sm">
        <div className="flex items-center justify-center gap-2 text-[11px] font-semibold uppercase tracking-[0.28em] text-text-secondary">
          <SparkIcon size={13} />
          {DISPLAY_NAME}
        </div>
        <h2 className="mt-3 text-xl font-semibold tracking-tight text-text-primary">{title}</h2>
        {subtitle ? <p className="mt-2 text-sm text-text-secondary">{subtitle}</p> : null}
      </div>
      <div className="w-full max-w-sm">
        <div className="h-2 overflow-hidden rounded-full border border-white/6 bg-white/6 shadow-inner shadow-black/20">
          {resolvedProgress == null ? (
            <div className="h-full w-2/5 rounded-full bg-[linear-gradient(90deg,rgba(18,222,230,0.1),rgba(18,222,230,0.95),rgba(129,243,246,0.2))] animate-loader-sweep" />
          ) : (
            <div
              className="h-full rounded-full bg-[linear-gradient(90deg,rgba(18,222,230,0.7),rgba(129,243,246,1))] shadow-[0_0_16px_rgba(18,222,230,0.4)] transition-[width] duration-500"
              style={{ width: `${resolvedProgress}%` }}
            />
          )}
        </div>
      </div>
    </div>
  )
}
