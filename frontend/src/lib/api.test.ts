import { beforeEach, describe, expect, it, vi } from 'vitest'

import { apiGet, getBackendBaseUrl, getBackendRequestContext, resetBackendBaseUrlCache } from './api'

describe('api backend bridge resolution', () => {
  beforeEach(() => {
    resetBackendBaseUrlCache()
    window.windowControls = {
      getBackendBaseUrl: vi.fn(),
      backendRequest: vi.fn(),
    } as unknown as typeof window.windowControls
  })

  it('retries after a failed base url lookup instead of poisoning the cache', async () => {
    const getBackendBaseUrlMock = vi.fn()
      .mockRejectedValueOnce(new Error('backend unavailable'))
      .mockResolvedValueOnce('http://127.0.0.1:8055')

    window.windowControls = {
      getBackendBaseUrl: getBackendBaseUrlMock,
      backendRequest: vi.fn(),
    } as unknown as typeof window.windowControls

    await expect(getBackendBaseUrl()).rejects.toThrow('backend unavailable')
    await expect(getBackendBaseUrl()).resolves.toBe('http://127.0.0.1:8055')
    expect(getBackendBaseUrlMock).toHaveBeenCalledTimes(2)
  })

  it('reuses one in-flight successful lookup', async () => {
    const getBackendBaseUrlMock = vi.fn().mockResolvedValue('http://127.0.0.1:8055')
    window.windowControls = {
      getBackendBaseUrl: getBackendBaseUrlMock,
      backendRequest: vi.fn(),
    } as unknown as typeof window.windowControls

    const [first, second] = await Promise.all([getBackendBaseUrl(), getBackendBaseUrl()])

    expect(first).toBe('http://127.0.0.1:8055')
    expect(second).toBe('http://127.0.0.1:8055')
    expect(getBackendBaseUrlMock).toHaveBeenCalledTimes(1)
  })

  it('proxies renderer requests through the main process without exposing auth headers', async () => {
    const backendRequestMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { 'content-type': 'application/json' },
      data: { ok: true },
    })

    window.windowControls = {
      getBackendBaseUrl: vi.fn().mockResolvedValue('http://127.0.0.1:8055'),
      backendRequest: backendRequestMock,
    } as unknown as typeof window.windowControls

    await apiGet('/status', {
      headers: {
        'X-Caller': 'renderer',
      },
    })

    expect(backendRequestMock).toHaveBeenCalledTimes(1)
    expect(backendRequestMock).toHaveBeenCalledWith({
      method: 'GET',
      path: '/status',
      headers: { 'x-caller': 'renderer' },
      body: undefined,
      timeout: undefined,
    })
  })

  it('exposes only the backend base url for compatibility callers', async () => {
    window.windowControls = {
      getBackendBaseUrl: vi.fn().mockResolvedValue('http://127.0.0.1:8055'),
      backendRequest: vi.fn(),
    } as unknown as typeof window.windowControls

    await expect(getBackendRequestContext()).resolves.toEqual({
      baseUrl: 'http://127.0.0.1:8055',
      headers: {},
    })
  })
})
