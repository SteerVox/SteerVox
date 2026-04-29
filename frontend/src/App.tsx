import { Suspense, lazy, useEffect, useState } from 'react'
import { HashRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom'

import { DISPLAY_NAME, TAGLINE } from '../shared/branding'
import { FloatingWidget } from './FloatingWidget'
import { WindowErrorBoundary } from './components/WindowErrorBoundary'
import { HomeIcon, InboxIcon, SetupIcon, SkillsIcon, WindowCloseIcon, WindowMinimizeIcon, BrandMark } from './components/BrandIcons'
import { APP_ROUTES } from './lib/routes'

const CaptureHost = lazy(() => import('./CaptureHost'))
const InboxPopover = lazy(() => import('./InboxPopover'))
const AboutWindow = lazy(() => import('./AboutWindow'))
const HomeView = lazy(async () => ({ default: (await import('./HomeView')).HomeView }))
const LibraryView = lazy(async () => ({ default: (await import('./LibraryView')).LibraryView }))
const SettingsView = lazy(async () => ({ default: (await import('./SettingsView')).SettingsView }))
const SkillsManager = lazy(async () => ({ default: (await import('./SkillsManager')).SkillsManager }))

const MAIN_NAV_ITEMS = [
  { to: APP_ROUTES.home, label: 'Home', icon: <HomeIcon size={16} />, end: true },
  { to: APP_ROUTES.library, label: 'Library', icon: <InboxIcon size={16} />, end: false },
  { to: APP_ROUTES.templates, label: 'Templates', icon: <SkillsIcon size={16} />, end: false },
  { to: APP_ROUTES.settings, label: 'Settings', icon: <SetupIcon size={16} />, end: false },
] as const

function RouteFallback() {
  return (
    <div className="flex h-full items-center justify-center px-6 py-6">
      <div className="section-intro-panel rounded-[24px] border border-white/8 px-5 py-4 text-center text-sm leading-6 text-text-secondary">
        Loading view...
      </div>
    </div>
  )
}

function RendererErrorReporter() {
  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      void window.windowControls?.reportRendererError?.({
        message: event.message || 'Unhandled window error',
        stack: event.error instanceof Error ? event.error.stack || null : null,
        route: window.location.hash || window.location.pathname,
      })
    }

    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason
      void window.windowControls?.reportRendererError?.({
        message: reason instanceof Error ? reason.message : String(reason || 'Unhandled promise rejection'),
        stack: reason instanceof Error ? reason.stack || null : null,
        route: window.location.hash || window.location.pathname,
      })
    }

    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onUnhandledRejection)
    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onUnhandledRejection)
    }
  }, [])

  return null
}

function AppShell() {
  const [platform, setPlatform] = useState('darwin')
  const handleMinimize = () => window.windowControls?.minimize()
  const handleClose = () => window.windowControls?.close()
  const isMac = platform === 'darwin'

  useEffect(() => {
    let mounted = true

    window.windowControls?.getPlatform?.().then((nextPlatform) => {
      if (mounted && nextPlatform) {
        setPlatform(nextPlatform)
      }
    })

    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const backShortcut = (event.metaKey && event.key === '[') || (event.altKey && event.key === 'ArrowLeft')
      const forwardShortcut = (event.metaKey && event.key === ']') || (event.altKey && event.key === 'ArrowRight')

      if (backShortcut) {
        event.preventDefault()
        window.history.back()
      } else if (forwardShortcut) {
        event.preventDefault()
        window.history.forward()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  return (
    <div className="workspace-shell flex h-full w-full flex-col overflow-hidden">
      <div className="workspace-titlebar soft-divider border-b">
        <div className={`titlebar-drag flex h-[74px] items-center justify-between gap-4 pr-4 ${isMac ? 'pl-[88px]' : 'px-4'}`}>
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center">
              <BrandMark size={36} className="drop-shadow-[0_8px_18px_rgba(0,0,0,0.18)]" />
            </div>
            <div className="min-w-0">
              <div className="truncate text-[15px] font-semibold tracking-[-0.02em] text-text-primary">{DISPLAY_NAME}</div>
              <div className="truncate text-[11px] text-text-secondary">{TAGLINE}</div>
            </div>
          </div>

          <div className="titlebar-nodrag flex items-center gap-3">
            <div className="workspace-segmented flex items-center gap-1 rounded-full p-1">
              {MAIN_NAV_ITEMS.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    `inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-colors ${
                      isActive
                        ? 'workspace-tab-active text-text-primary'
                        : 'workspace-tab text-text-secondary hover:text-text-primary'
                    }`
                  }
                >
                  {item.icon}
                  {item.label}
                </NavLink>
              ))}
            </div>

            {!isMac ? (
              <div className="flex items-center gap-1.5">
                <button
                  onClick={handleMinimize}
                  className="flex h-8 w-8 items-center justify-center rounded-xl text-text-muted transition-colors hover:bg-white/8 hover:text-text-primary"
                  title="Minimize"
                >
                  <WindowMinimizeIcon size={14} />
                </button>
                <button
                  onClick={handleClose}
                  className="flex h-8 w-8 items-center justify-center rounded-xl text-text-muted transition-colors hover:bg-semantic-error/20 hover:text-white"
                  title="Close"
                >
                  <WindowCloseIcon size={14} />
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        <Suspense fallback={<RouteFallback />}>
          <Routes>
            <Route path={APP_ROUTES.home} element={<HomeView />} />
            <Route path="/home" element={<Navigate to="/" replace />} />
            <Route path={APP_ROUTES.library} element={<LibraryView />} />
            <Route path={APP_ROUTES.templates} element={<SkillsManager />} />
            <Route path="/skills" element={<Navigate to={APP_ROUTES.templates} replace />} />
            <Route path={APP_ROUTES.settings} element={<SettingsView />} />
            <Route path="*" element={<Navigate to={APP_ROUTES.home} replace />} />
          </Routes>
        </Suspense>
      </div>
    </div>
  )
}

function App() {
  return (
    <WindowErrorBoundary>
      <RendererErrorReporter />
      <HashRouter
        future={{
          v7_startTransition: true,
          v7_relativeSplatPath: true,
        }}
      >
        <Suspense fallback={<RouteFallback />}>
          <Routes>
            <Route path="/widget" element={<FloatingWidget />} />
            <Route path="/capture" element={<CaptureHost />} />
            <Route path="/inbox" element={<InboxPopover />} />
            <Route path="/about" element={<AboutWindow />} />
            <Route path="/*" element={<AppShell />} />
          </Routes>
        </Suspense>
      </HashRouter>
    </WindowErrorBoundary>
  )
}

export default App
