import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  backupAndRestoreClipboard,
  captureSelectedText,
  pasteFinalText,
} from './ClipboardManager'

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('ClipboardManager', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('captures selected text after the copy buffer settles and restores the clipboard', async () => {
    let clipboardText = 'before'
    const readClipboardText = vi.fn(() => clipboardText)
    const writeClipboardText = vi.fn((text: string) => {
      clipboardText = text
    })
    const triggerSystemCopyShortcut = vi.fn(async () => {
      setTimeout(() => {
        clipboardText = 'selected text'
      }, 150)
    })

    const promise = captureSelectedText({
      createMarker: () => '__marker__',
      readClipboardText,
      writeClipboardText,
      triggerSystemCopyShortcut,
      truncateText: (rawText) => ({ text: rawText || null, truncated: false }),
      wait,
    })

    await vi.advanceTimersByTimeAsync(18)
    expect(triggerSystemCopyShortcut).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(109)
    expect(readClipboardText).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(41)
    await expect(promise).resolves.toEqual({ text: 'selected text', truncated: false })
    expect(writeClipboardText).toHaveBeenLastCalledWith('before')
  })

  it('restores the clipboard when the copy shortcut fails', async () => {
    let clipboardText = 'before'
    const writeClipboardText = vi.fn((text: string) => {
      clipboardText = text
    })

    const promise = captureSelectedText({
      createMarker: () => '__marker__',
      readClipboardText: () => clipboardText,
      writeClipboardText,
      triggerSystemCopyShortcut: vi.fn(async () => {
        throw new Error('permission denied')
      }),
      truncateText: (rawText) => ({ text: rawText || null, truncated: false }),
      wait,
    })

    await vi.runAllTimersAsync()
    await expect(promise).resolves.toEqual({ text: null, truncated: false })
    expect(writeClipboardText).toHaveBeenLastCalledWith('before')
  })

  it('backs up and restores the clipboard around a temporary write', async () => {
    let clipboardText = 'keep me'
    const resultPromise = backupAndRestoreClipboard(
      'temporary',
      {
        readClipboardText: () => clipboardText,
        writeClipboardText: (text: string) => {
          clipboardText = text
        },
        wait,
      },
      async () => {
        expect(clipboardText).toBe('temporary')
        return 'done'
      },
    )

    await expect(resultPromise).resolves.toBe('done')
    expect(clipboardText).toBe('keep me')
  })

  it('pastes directly and restores the previous clipboard when direct paste is available', async () => {
    let clipboardText = 'original'
    const triggerSystemPasteShortcut = vi.fn(async () => undefined)

    const promise = pasteFinalText('new content', {
      readClipboardText: () => clipboardText,
      writeClipboardText: (text: string) => {
        clipboardText = text
      },
      wait,
      supportsDirectPaste: true,
      triggerSystemPasteShortcut,
      fallbackDetail: 'Copied instead.',
    })

    await vi.advanceTimersByTimeAsync(150)
    await expect(promise).resolves.toEqual({ status: 'pasted', detail: null })
    expect(triggerSystemPasteShortcut).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(500)
    expect(clipboardText).toBe('original')
  })

  it('falls back to clipboard copy when direct paste is unavailable', async () => {
    let clipboardText = 'original'

    const promise = pasteFinalText('new content', {
      readClipboardText: () => clipboardText,
      writeClipboardText: (text: string) => {
        clipboardText = text
      },
      wait,
      supportsDirectPaste: false,
      fallbackDetail: 'Copied instead.',
    })

    await expect(promise).resolves.toEqual({ status: 'copied', detail: 'Copied instead.' })
    expect(clipboardText).toBe('new content')

    await vi.advanceTimersByTimeAsync(500)
    expect(clipboardText).toBe('original')
  })
})
