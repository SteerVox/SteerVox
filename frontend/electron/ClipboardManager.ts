import { CLIPBOARD_SELECTION_MARKER_PREFIX } from '../shared/branding'

export const CLIPBOARD_MARKER_DELAY_MS = 18
export const CLIPBOARD_COPY_DELAY_MS = 110
export const CLIPBOARD_POLL_DELAY_MS = 40
export const CLIPBOARD_MAX_POLLS = 5
export const CLIPBOARD_RESTORE_DELAY_MS = 500

export type ClipboardSnapshot = {
  text: string | null
  truncated: boolean
}

export type PasteTextResult = {
  status: 'pasted' | 'copied' | 'failed'
  detail: string | null
}

type ClipboardDeps = {
  readClipboardText: () => string
  writeClipboardText: (text: string) => void
  wait: (ms: number) => Promise<unknown>
  log?: (message: string) => void
}

type CaptureSelectedTextDeps = ClipboardDeps & {
  createMarker?: () => string
  triggerSystemCopyShortcut: () => Promise<void>
  truncateText: (rawText: string) => ClipboardSnapshot
}

type PasteFinalTextDeps = ClipboardDeps & {
  restoreClipboard?: boolean
  fallbackDetail: string
  supportsDirectPaste: boolean
  triggerSystemPasteShortcut?: () => Promise<void>
}

export async function backupAndRestoreClipboard<ResultT>(
  tempText: string,
  deps: ClipboardDeps,
  operation: () => Promise<ResultT>,
): Promise<ResultT> {
  const previousClipboardText = deps.readClipboardText() || ''
  deps.writeClipboardText(tempText)
  try {
    return await operation()
  } finally {
    deps.writeClipboardText(previousClipboardText)
  }
}

export async function captureSelectedText(deps: CaptureSelectedTextDeps): Promise<ClipboardSnapshot> {
  const marker = deps.createMarker?.() ?? CLIPBOARD_SELECTION_MARKER_PREFIX
  return backupAndRestoreClipboard(marker, deps, async () => {
    await deps.wait(CLIPBOARD_MARKER_DELAY_MS)

    try {
      await deps.triggerSystemCopyShortcut()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      deps.log?.(`Selection capture shortcut failed: ${message}`)
      return { text: null, truncated: false }
    }

    await deps.wait(CLIPBOARD_COPY_DELAY_MS)

    let copiedText = marker
    for (let attempt = 0; attempt < CLIPBOARD_MAX_POLLS; attempt += 1) {
      await deps.wait(CLIPBOARD_POLL_DELAY_MS)
      copiedText = deps.readClipboardText() || ''
      if (copiedText !== marker) {
        break
      }
    }

    const snapshot = deps.truncateText(copiedText === marker ? '' : copiedText)
    if (snapshot.text) {
      deps.log?.(`Selection capture succeeded (${snapshot.text.length} chars${snapshot.truncated ? ', truncated' : ''}).`)
    } else {
      deps.log?.('Selection capture found no selected text. Falling back to clipboard-only context.')
    }
    return snapshot
  })
}

export async function pasteFinalText(text: string, deps: PasteFinalTextDeps): Promise<PasteTextResult> {
  const finalText = text || ''
  if (!finalText.trim()) {
    return {
      status: 'failed',
      detail: 'No text was available to paste.',
    }
  }

  const restoreClipboard = deps.restoreClipboard !== false
  const previousClipboardText = deps.readClipboardText() || ''
  deps.writeClipboardText(finalText)

  if (!deps.supportsDirectPaste || !deps.triggerSystemPasteShortcut) {
    if (restoreClipboard) {
      setTimeout(() => {
        deps.writeClipboardText(previousClipboardText)
      }, CLIPBOARD_RESTORE_DELAY_MS)
    }
    return {
      status: 'copied',
      detail: deps.fallbackDetail,
    }
  }

  let attempt = 0
  while (attempt < 3) {
    try {
      await deps.triggerSystemPasteShortcut()
      await deps.wait(150)
      if (restoreClipboard) {
        setTimeout(() => {
          deps.writeClipboardText(previousClipboardText)
        }, CLIPBOARD_RESTORE_DELAY_MS)
      }
      return {
        status: 'pasted',
        detail: null,
      }
    } catch (error) {
      attempt += 1
      const message = error instanceof Error ? error.message : String(error)
      deps.log?.(`Paste injection failed attempt=${attempt} error=${message}`)
      await deps.wait(100)
    }
  }

  if (restoreClipboard) {
    setTimeout(() => {
      deps.writeClipboardText(previousClipboardText)
    }, CLIPBOARD_RESTORE_DELAY_MS)
  }
  return {
    status: 'copied',
    detail: deps.fallbackDetail,
  }
}
