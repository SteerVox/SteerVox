import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  claimPasteDeliveryAnnouncement,
  deliverPendingPaste,
  hasCompletedPasteDelivery,
  resetPasteDeliveryRegistry,
} from './pasteDelivery'

describe('renderer paste delivery registry', () => {
  afterEach(() => {
    resetPasteDeliveryRegistry()
  })

  it('reuses a successful pasted result without re-calling the bridge', async () => {
    const pasteText = vi.fn().mockResolvedValue({ status: 'pasted', detail: null })

    const first = await deliverPendingPaste({
      id: 'paste-1',
      text: 'draft',
      restoreClipboardAfterPaste: true,
    }, pasteText)
    const replay = await deliverPendingPaste({
      id: 'paste-1',
      text: 'draft',
      restoreClipboardAfterPaste: true,
    }, pasteText)

    expect(first).toEqual({ status: 'pasted', detail: null })
    expect(replay).toEqual({ status: 'pasted', detail: null })
    expect(pasteText).toHaveBeenCalledTimes(1)
    expect(hasCompletedPasteDelivery('paste-1')).toBe(true)
    expect(claimPasteDeliveryAnnouncement('paste-1')).toBe(true)
    expect(claimPasteDeliveryAnnouncement('paste-1')).toBe(false)
  })

  it('keeps clipboard-copy fallback as a completed delivery', async () => {
    const pasteText = vi.fn().mockResolvedValue({ status: 'copied', detail: 'Copied the latest result.' })

    const result = await deliverPendingPaste({
      id: 'paste-2',
      text: 'draft',
      restoreClipboardAfterPaste: true,
    }, pasteText)

    expect(result).toEqual({ status: 'copied', detail: 'Copied the latest result.' })
    expect(hasCompletedPasteDelivery('paste-2')).toBe(true)
  })

  it('retries after a thrown bridge error', async () => {
    const pasteText = vi.fn()
      .mockRejectedValueOnce(new Error('bridge down'))
      .mockResolvedValueOnce({ status: 'pasted', detail: null })

    await expect(deliverPendingPaste({
      id: 'paste-3',
      text: 'draft',
      restoreClipboardAfterPaste: true,
    }, pasteText)).rejects.toThrow('bridge down')

    expect(hasCompletedPasteDelivery('paste-3')).toBe(false)

    const retried = await deliverPendingPaste({
      id: 'paste-3',
      text: 'draft',
      restoreClipboardAfterPaste: true,
    }, pasteText)

    expect(retried).toEqual({ status: 'pasted', detail: null })
    expect(pasteText).toHaveBeenCalledTimes(2)
  })

  it('dedupes duplicate in-flight pending-paste events by id', async () => {
    let resolvePaste: (value: { status: 'pasted'; detail: null }) => void = () => {
      throw new Error('Expected the paste bridge resolver to be assigned before use.')
    }
    const pasteText = vi.fn(() => new Promise<{ status: 'pasted'; detail: null }>((resolve) => {
      resolvePaste = resolve
    }))

    const first = deliverPendingPaste({
      id: 'paste-4',
      text: 'draft',
      restoreClipboardAfterPaste: true,
    }, pasteText)
    const second = deliverPendingPaste({
      id: 'paste-4',
      text: 'draft',
      restoreClipboardAfterPaste: true,
    }, pasteText)

    await Promise.resolve()
    expect(pasteText).toHaveBeenCalledTimes(1)

    resolvePaste({ status: 'pasted', detail: null })

    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: 'pasted', detail: null },
      { status: 'pasted', detail: null },
    ])
  })

  it('survives remount-style replay without duplicating announcement or delivery', async () => {
    const pasteText = vi.fn().mockResolvedValue({ status: 'pasted', detail: null })

    await deliverPendingPaste({
      id: 'paste-5',
      text: 'draft',
      restoreClipboardAfterPaste: true,
    }, pasteText)

    expect(claimPasteDeliveryAnnouncement('paste-5')).toBe(true)

    const replay = await deliverPendingPaste({
      id: 'paste-5',
      text: 'draft',
      restoreClipboardAfterPaste: true,
    }, pasteText)

    expect(replay).toEqual({ status: 'pasted', detail: null })
    expect(pasteText).toHaveBeenCalledTimes(1)
    expect(claimPasteDeliveryAnnouncement('paste-5')).toBe(false)
  })

  it('does not cache a failed delivery result', async () => {
    const pasteText = vi.fn()
      .mockResolvedValueOnce({ status: 'failed', detail: 'No text was available to paste.' })
      .mockResolvedValueOnce({ status: 'pasted', detail: null })

    const failed = await deliverPendingPaste({
      id: 'paste-6',
      text: 'draft',
      restoreClipboardAfterPaste: true,
    }, pasteText)
    const retried = await deliverPendingPaste({
      id: 'paste-6',
      text: 'draft',
      restoreClipboardAfterPaste: true,
    }, pasteText)

    expect(failed).toEqual({ status: 'failed', detail: 'No text was available to paste.' })
    expect(retried).toEqual({ status: 'pasted', detail: null })
    expect(pasteText).toHaveBeenCalledTimes(2)
  })
})
