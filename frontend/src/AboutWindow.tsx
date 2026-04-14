import { useEffect, useMemo, useState } from 'react'

import { COPYRIGHT_HOLDER, DISPLAY_NAME, LOGO_MARK_PUBLIC_PATH } from '../shared/branding'
import { useLaunchContextState } from './hooks/useDesktopBridgeState'

function readElectronVersion() {
  const match = navigator.userAgent.match(/Electron\/([^\s]+)/)
  return match?.[1] ?? null
}

export default function AboutWindow() {
  const [platform, setPlatform] = useState('darwin')
  const [launchContext] = useLaunchContextState()

  useEffect(() => {
    document.documentElement.dataset.surface = 'about'
    document.body.dataset.surface = 'about'

    window.windowControls?.getPlatform?.().then((nextPlatform) => {
      if (nextPlatform) {
        setPlatform(nextPlatform)
      }
    })

    return () => {
      delete document.documentElement.dataset.surface
      delete document.body.dataset.surface
    }
  }, [])

  const isMac = platform === 'darwin'
  const versionLabel = useMemo(() => {
    const appVersion = launchContext?.app_version ?? 'Unknown'
    const electronVersion = readElectronVersion()
    return electronVersion ? `Version ${appVersion} (${electronVersion})` : `Version ${appVersion}`
  }, [launchContext])
  const releaseLabel = launchContext?.release_channel === 'public_beta'
    ? 'Public beta'
    : 'Development build'
  const trustLabel = launchContext?.trust_posture === 'unsigned_beta'
    ? 'Unsigned website build'
    : 'Developer trust posture'

  return (
    <div className="workspace-shell flex h-full w-full flex-col overflow-hidden rounded-[18px]">
      <div className={`workspace-titlebar shrink-0 ${isMac ? 'h-[28px]' : 'h-[36px]'}`} />
      <div className="flex min-h-0 flex-1 items-center justify-center px-8 pb-9 pt-4">
        <div className="flex w-full max-w-[280px] flex-col items-center text-center">
          <img
            src={LOGO_MARK_PUBLIC_PATH}
            alt={`${DISPLAY_NAME} logo`}
            className="h-[122px] w-[122px] object-contain"
            draggable={false}
          />
          <div className="mt-4 text-[14px] font-semibold tracking-[-0.02em] text-text-primary">
            {DISPLAY_NAME}
          </div>
          <div className="mt-1 text-[12px] text-text-secondary">
            {versionLabel}
          </div>
          <div className="mt-3 rounded-full border border-white/8 bg-white/[0.04] px-3 py-1 text-[10px] uppercase tracking-[0.24em] text-text-muted">
            {releaseLabel}
          </div>
          <div className="mt-3 space-y-1 text-[12px] text-text-secondary">
            <div>{trustLabel}</div>
            <div>Apple Silicon only</div>
            <div>{launchContext?.manual_updates_only ? 'Manual updates only' : 'Update policy managed elsewhere'}</div>
          </div>
          <div className="mt-3 text-[12px] text-text-secondary">
            {`Copyright © ${COPYRIGHT_HOLDER}`}
          </div>
        </div>
      </div>
    </div>
  )
}
