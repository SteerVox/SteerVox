import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LOCAL_BACKEND_AUTH_HEADER } from '../../shared/localBackendAuth'
import { createFetchRuntimeEventStream } from './runtimeEventStream'

function encode(text: string) {
  return new TextEncoder().encode(text)
}

async function flushMicrotasks() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('runtime event stream', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('opens an authenticated runtime event stream and dispatches named events', async () => {
    const streamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encode('event: snapshot\ndata: {"seq":1,"type":"snapshot"}\n\n'))
      },
    })

    fetchMock.mockResolvedValue(new Response(streamBody, { status: 200 }))

    const stream = await createFetchRuntimeEventStream({
      baseUrl: 'http://127.0.0.1:8055',
      headers: { [LOCAL_BACKEND_AUTH_HEADER]: 'test-token' },
    })
    const onOpen = vi.fn()
    const onError = vi.fn()
    const onSnapshot = vi.fn()

    stream.onopen = onOpen
    stream.onerror = onError
    stream.addEventListener('snapshot', onSnapshot as EventListener)

    await flushMicrotasks()

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8055/events/runtime', expect.objectContaining({
      method: 'GET',
      headers: { [LOCAL_BACKEND_AUTH_HEADER]: 'test-token' },
    }))
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onSnapshot).toHaveBeenCalledTimes(1)
    expect((onSnapshot.mock.calls[0][0] as MessageEvent<string>).data).toBe('{"seq":1,"type":"snapshot"}')

    stream.close()
    await flushMicrotasks()

    expect(onError).not.toHaveBeenCalled()
  })

  it('reports a connection error when the authenticated runtime stream is rejected', async () => {
    fetchMock.mockResolvedValue(new Response('unauthorized', { status: 401 }))

    const stream = await createFetchRuntimeEventStream({
      baseUrl: 'http://127.0.0.1:8055',
      headers: { [LOCAL_BACKEND_AUTH_HEADER]: 'wrong-token' },
    })
    const onError = vi.fn()
    stream.onerror = onError

    await flushMicrotasks()

    expect(onError).toHaveBeenCalledTimes(1)
    stream.close()
  })
})
