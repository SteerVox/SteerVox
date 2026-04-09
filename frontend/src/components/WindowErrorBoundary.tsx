/* eslint-disable react-refresh/only-export-components */
import { Component, type ErrorInfo, type ReactNode } from 'react'

import { DISPLAY_NAME } from '../../shared/branding'

type WindowErrorBoundaryProps = {
  children: ReactNode
}

type WindowErrorBoundaryState = {
  error: Error | null
}

function RecoveryButton({
  onClick,
  children,
  tone = 'secondary',
}: {
  onClick: () => void | Promise<void>
  children: ReactNode
  tone?: 'secondary' | 'primary'
}) {
  return (
    <button
      type="button"
      onClick={() => { void onClick() }}
      className={tone === 'primary'
        ? 'rounded-2xl border border-accent-primary/20 bg-accent-primary px-4 py-2.5 text-sm font-medium text-[#021318] transition-colors hover:bg-[#46f0f4]'
        : 'rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-2.5 text-sm font-medium text-text-primary transition-colors hover:bg-white/[0.06]'
      }
    >
      {children}
    </button>
  )
}

export class WindowErrorBoundary extends Component<WindowErrorBoundaryProps, WindowErrorBoundaryState> {
  state: WindowErrorBoundaryState = {
    error: null,
  }

  static getDerivedStateFromError(error: Error): WindowErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    void window.windowControls?.reportRendererError?.({
      message: error.message,
      stack: error.stack || null,
      component_stack: info.componentStack || null,
      route: window.location.hash || window.location.pathname,
    })
  }

  private readonly reloadWindow = () => {
    window.location.reload()
  }

  private readonly restartBackend = async () => {
    await window.windowControls?.restartBackend?.()
    window.location.reload()
  }

  private readonly openLogs = async () => {
    await window.windowControls?.openLogsDirectory?.()
  }

  render() {
    if (!this.state.error) {
      return this.props.children
    }

    return (
      <div className="flex h-full items-center justify-center px-8">
        <div className="w-full max-w-xl rounded-[28px] border border-semantic-error/20 bg-[linear-gradient(180deg,rgba(42,11,18,0.75),rgba(11,8,12,0.9))] p-8 shadow-[0_18px_60px_rgba(0,0,0,0.35)]">
          <div className="text-[11px] uppercase tracking-[0.28em] text-text-muted">Recovery</div>
          <h1 className="mt-2 text-xl font-semibold text-text-primary">This window hit an unexpected error.</h1>
          <p className="mt-3 text-sm leading-7 text-text-secondary">
            {`${DISPLAY_NAME} kept the app alive, but this window needs recovery. You can reload the renderer, restart the local backend, or open the logs for inspection.`}
          </p>
          <div className="mt-4 rounded-2xl border border-white/8 bg-black/24 px-4 py-3 font-mono text-xs leading-6 text-text-secondary">
            {this.state.error.message || 'Unknown renderer error'}
          </div>
          <div className="mt-6 flex flex-wrap gap-3">
            <RecoveryButton onClick={this.reloadWindow}>Reload window</RecoveryButton>
            <RecoveryButton onClick={this.restartBackend}>Restart backend</RecoveryButton>
            <RecoveryButton onClick={this.openLogs} tone="primary">Open logs</RecoveryButton>
          </div>
        </div>
      </div>
    )
  }
}
