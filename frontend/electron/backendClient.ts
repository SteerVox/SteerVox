import http from 'node:http'

import {
  buildLocalBackendHeaders,
  type BackendRequestContext,
} from '../shared/localBackendAuth'

type BackendClientOptions = {
  getBaseUrl: () => string
  getAuthToken: () => string
}

type RequestOptions = {
  authenticate?: boolean
  timeoutMs?: number
}

function createTimeoutSignal(timeoutMs: number | undefined) {
  if (!timeoutMs || timeoutMs <= 0) {
    return { signal: undefined, cleanup: () => undefined }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer),
  }
}

export function createBackendClient(options: BackendClientOptions) {
  function getRequestContext(): BackendRequestContext {
    const baseUrl = options.getBaseUrl()
    if (!baseUrl) {
      throw new Error('The local backend URL is not ready yet.')
    }

    return {
      baseUrl,
      headers: buildLocalBackendHeaders(options.getAuthToken()),
    }
  }

  function getUrl(pathname = '') {
    return `${getRequestContext().baseUrl}${pathname}`
  }

  async function request(
    pathname: string,
    init: RequestInit = {},
    requestOptions: RequestOptions = {},
  ) {
    const { authenticate = true, timeoutMs } = requestOptions
    const { signal, cleanup } = createTimeoutSignal(timeoutMs)
    const requestContext = getRequestContext()
    const headers = new Headers(init.headers)

    if (authenticate) {
      Object.entries(requestContext.headers).forEach(([name, value]) => {
        headers.set(name, value)
      })
    }

    try {
      return await fetch(`${requestContext.baseUrl}${pathname}`, {
        ...init,
        headers,
        signal: init.signal ?? signal,
      })
    } finally {
      cleanup()
    }
  }

  async function getJson<T>(
    pathname: string,
    requestOptions: RequestOptions = {},
  ): Promise<T> {
    const response = await request(pathname, { method: 'GET' }, requestOptions)
    if (!response.ok) {
      throw new Error(`Request failed (${response.status}).`)
    }
    return response.json() as Promise<T>
  }

  async function postJson<T>(
    pathname: string,
    payload: unknown,
    requestOptions: RequestOptions = {},
  ): Promise<T> {
    const response = await request(
      pathname,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      },
      requestOptions,
    )
    if (!response.ok) {
      throw new Error(`Request failed (${response.status}).`)
    }
    return response.json() as Promise<T>
  }

  async function readText(
    pathname: string,
    init: RequestInit = {},
    requestOptions: RequestOptions = {},
  ) {
    const response = await request(pathname, init, requestOptions)
    if (!response.ok) {
      throw new Error(`Request failed (${response.status}).`)
    }
    return response.text()
  }

  async function canReadAuthenticatedStatus() {
    try {
      const response = await request('/status', { method: 'GET' }, { authenticate: true, timeoutMs: 1000 })
      return response.ok
    } catch {
      return false
    }
  }

  function checkHealth(timeoutMs = 1000): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(`${options.getBaseUrl()}/health`, (res) => {
        resolve(res.statusCode === 200)
      })
      req.on('error', () => resolve(false))
      req.setTimeout(timeoutMs, () => {
        req.destroy()
        resolve(false)
      })
    })
  }

  return {
    getRequestContext,
    getUrl,
    request,
    getJson,
    postJson,
    readText,
    canReadAuthenticatedStatus,
    checkHealth,
  }
}
