import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { BackendRuntimeEventPayload } from '../ipc/contracts'
import { createFetchRuntimeEventStream } from './runtimeEventStream'

async function flushMicrotasks() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('runtime event stream', () => {
  let listener: ((payload: BackendRuntimeEventPayload) => void) | null
  let dispose: ReturnType<typeof vi.fn>
  let startBackendRuntimeEvents: ReturnType<typeof vi.fn>
  let stopBackendRuntimeEvents: ReturnType<typeof vi.fn>

  beforeEach(() => {
    listener = null
    dispose = vi.fn()
    startBackendRuntimeEvents = vi.fn().mockResolvedValue({ status: 'started' })
    stopBackendRuntimeEvents = vi.fn().mockResolvedValue({ status: 'stopped' })
    window.windowControls = {
      startBackendRuntimeEvents,
      stopBackendRuntimeEvents,
      onBackendRuntimeEvent: vi.fn((callback) => {
        listener = callback
        return dispose
      }),
    } as unknown as typeof window.windowControls
  })

  it('opens a proxied runtime event stream and dispatches named events', async () => {
    const stream = await createFetchRuntimeEventStream()
    const onOpen = vi.fn()
    const onError = vi.fn()
    const onSnapshot = vi.fn()

    stream.onopen = onOpen
    stream.onerror = onError
    stream.addEventListener('snapshot', onSnapshot as EventListener)

    await flushMicrotasks()
    listener?.({ type: 'open' })
    listener?.({ type: 'snapshot', data: '{"seq":1,"type":"snapshot"}' })

    expect(startBackendRuntimeEvents).toHaveBeenCalledTimes(1)
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onSnapshot).toHaveBeenCalledTimes(1)
    expect((onSnapshot.mock.calls[0][0] as MessageEvent<string>).data).toBe('{"seq":1,"type":"snapshot"}')

    stream.close()
    await flushMicrotasks()

    expect(dispose).toHaveBeenCalledTimes(1)
    expect(stopBackendRuntimeEvents).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
  })

  it('reports a connection error from the main-process stream', async () => {
    const stream = await createFetchRuntimeEventStream()
    const onError = vi.fn()
    stream.onerror = onError

    await flushMicrotasks()
    listener?.({ type: 'error', message: 'unauthorized' })

    expect(onError).toHaveBeenCalledTimes(1)
    stream.close()
  })
})
