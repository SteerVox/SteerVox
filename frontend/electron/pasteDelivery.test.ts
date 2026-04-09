import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createPasteDeliveryCoordinator, type PasteResult } from './pasteDelivery'

function flushMicrotasks() {
  return Promise.resolve().then(() => Promise.resolve())
}

describe('paste delivery coordinator', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('dedupes one in-flight delivery per paste id', async () => {
    let resolveDelivery: (value: PasteResult) => void = () => {
      throw new Error('Expected the delivery resolver to be assigned before use.')
    }
    const performPaste = vi.fn(() => new Promise<PasteResult>((resolve) => {
      resolveDelivery = resolve
    }))
    const acknowledgePaste = vi.fn().mockResolvedValue('acknowledged')
    const coordinator = createPasteDeliveryCoordinator({ performPaste, acknowledgePaste })

    const first = coordinator.deliver({ id: 'paste-1', text: 'draft', restoreClipboard: true })
    const second = coordinator.deliver({ id: 'paste-1', text: 'draft', restoreClipboard: true })

    await flushMicrotasks()
    expect(performPaste).toHaveBeenCalledTimes(1)

    resolveDelivery({ status: 'pasted', detail: null })
    await flushMicrotasks()

    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: 'pasted', detail: null },
      { status: 'pasted', detail: null },
    ])
    await flushMicrotasks()

    expect(acknowledgePaste).toHaveBeenCalledTimes(1)
    coordinator.dispose()
  })

  it('retries acknowledgements after a transient failure', async () => {
    const performPaste = vi.fn().mockResolvedValue({ status: 'pasted', detail: null })
    const acknowledgePaste = vi.fn()
      .mockRejectedValueOnce(new Error('backend restarting'))
      .mockResolvedValueOnce('acknowledged')
    const coordinator = createPasteDeliveryCoordinator({ performPaste, acknowledgePaste })

    await coordinator.deliver({ id: 'paste-2', text: 'draft', restoreClipboard: true })
    await flushMicrotasks()

    expect(acknowledgePaste).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(250)
    await flushMicrotasks()

    expect(acknowledgePaste).toHaveBeenCalledTimes(2)
    coordinator.dispose()
  })

  it('acknowledges a pasted outcome exactly once', async () => {
    const performPaste = vi.fn().mockResolvedValue({ status: 'pasted', detail: null })
    const acknowledgePaste = vi.fn().mockResolvedValue('acknowledged')
    const coordinator = createPasteDeliveryCoordinator({ performPaste, acknowledgePaste })

    await coordinator.deliver({ id: 'paste-3', text: 'draft', restoreClipboard: true })
    await flushMicrotasks()

    expect(acknowledgePaste).toHaveBeenCalledTimes(1)
    expect(acknowledgePaste).toHaveBeenCalledWith('paste-3', 'pasted')
    coordinator.dispose()
  })

  it('acknowledges a copied fallback exactly once', async () => {
    const performPaste = vi.fn().mockResolvedValue({ status: 'copied', detail: 'Copied the latest result.' })
    const acknowledgePaste = vi.fn().mockResolvedValue('acknowledged')
    const coordinator = createPasteDeliveryCoordinator({ performPaste, acknowledgePaste })

    await coordinator.deliver({ id: 'paste-4', text: 'draft', restoreClipboard: true })
    await flushMicrotasks()

    expect(acknowledgePaste).toHaveBeenCalledTimes(1)
    expect(acknowledgePaste).toHaveBeenCalledWith('paste-4', 'copied')
    coordinator.dispose()
  })
})
