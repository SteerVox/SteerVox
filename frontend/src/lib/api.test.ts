import { beforeEach, describe, expect, it, vi } from 'vitest'

import { LOCAL_BACKEND_AUTH_HEADER } from '../../shared/localBackendAuth'
import { apiGet, getBackendBaseUrl, getBackendRequestContext, resetBackendBaseUrlCache } from './api'

describe('api backend base url resolution', () => {
  beforeEach(() => {
    resetBackendBaseUrlCache()
    window.windowControls = {
      getBackendRequestContext: vi.fn(),
    } as unknown as typeof window.windowControls
    vi.stubGlobal('fetch', vi.fn())
  })

  it('retries after a failed base url lookup instead of poisoning the cache', async () => {
    const getBackendRequestContextMock = vi.fn()
      .mockRejectedValueOnce(new Error('backend unavailable'))
      .mockResolvedValueOnce({
        baseUrl: 'http://127.0.0.1:8055',
        headers: { [LOCAL_BACKEND_AUTH_HEADER]: 'test-token' },
      })

    window.windowControls = {
      getBackendRequestContext: getBackendRequestContextMock,
    } as unknown as typeof window.windowControls

    await expect(getBackendBaseUrl()).rejects.toThrow('backend unavailable')
    await expect(getBackendBaseUrl()).resolves.toBe('http://127.0.0.1:8055')
    expect(getBackendRequestContextMock).toHaveBeenCalledTimes(2)
  })

  it('reuses one in-flight successful lookup', async () => {
    const getBackendRequestContextMock = vi.fn().mockResolvedValue({
      baseUrl: 'http://127.0.0.1:8055',
      headers: { [LOCAL_BACKEND_AUTH_HEADER]: 'test-token' },
    })
    window.windowControls = {
      getBackendRequestContext: getBackendRequestContextMock,
    } as unknown as typeof window.windowControls

    const [first, second] = await Promise.all([getBackendBaseUrl(), getBackendBaseUrl()])

    expect(first).toBe('http://127.0.0.1:8055')
    expect(second).toBe('http://127.0.0.1:8055')
    expect(getBackendRequestContextMock).toHaveBeenCalledTimes(1)
  })

  it('injects authenticated backend headers into renderer requests', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))

    window.windowControls = {
      getBackendRequestContext: vi.fn().mockResolvedValue({
        baseUrl: 'http://127.0.0.1:8055',
        headers: { [LOCAL_BACKEND_AUTH_HEADER]: 'test-token' },
      }),
    } as unknown as typeof window.windowControls

    await apiGet('/status', {
      headers: {
        'X-Caller': 'renderer',
      },
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://127.0.0.1:8055/status')
    expect((init as RequestInit).method).toBe('GET')
    const headers = new Headers((init as RequestInit).headers)
    expect(headers.get('X-Caller')).toBe('renderer')
    expect(headers.get(LOCAL_BACKEND_AUTH_HEADER)).toBe('test-token')
  })

  it('exposes the full backend request context', async () => {
    window.windowControls = {
      getBackendRequestContext: vi.fn().mockResolvedValue({
        baseUrl: 'http://127.0.0.1:8055',
        headers: { [LOCAL_BACKEND_AUTH_HEADER]: 'test-token' },
      }),
    } as unknown as typeof window.windowControls

    await expect(getBackendRequestContext()).resolves.toEqual({
      baseUrl: 'http://127.0.0.1:8055',
      headers: { [LOCAL_BACKEND_AUTH_HEADER]: 'test-token' },
    })
  })
})
