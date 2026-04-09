import type { BackendRequestContext } from '../../shared/localBackendAuth'

export type ApiRequestConfig = {
  headers?: HeadersInit
  signal?: AbortSignal
  timeout?: number
}

export type ApiResponse<T> = {
  data: T
  status: number
  ok: boolean
  headers: Headers
}

export class ApiHttpError extends Error {
  status: number
  data: unknown

  constructor(status: number, data: unknown, message: string) {
    super(message)
    this.name = 'ApiHttpError'
    this.status = status
    this.data = data
  }
}

export function isApiHttpError(error: unknown): error is ApiHttpError {
  return error instanceof ApiHttpError
}

let requestContextPromise: Promise<BackendRequestContext> | null = null

async function resolveRequestContext() {
  if (!requestContextPromise) {
    if (!window.windowControls?.getBackendRequestContext) {
      requestContextPromise = Promise.reject(new Error('The local backend bridge is unavailable.'))
    } else {
      requestContextPromise = window.windowControls.getBackendRequestContext().then((value) => {
        if (!value?.baseUrl) {
          throw new Error('The local backend URL is not ready yet.')
        }
        return value
      })
    }

    requestContextPromise = requestContextPromise.catch((error) => {
      requestContextPromise = null
      throw error
    })
  }

  return requestContextPromise
}

function readMessageFromPayload(payload: unknown, fallback: string) {
  if (typeof payload === 'string' && payload.trim()) {
    return payload
  }
  if (payload && typeof payload === 'object') {
    const detail = 'detail' in payload ? payload.detail : null
    if (typeof detail === 'string' && detail.trim()) {
      return detail
    }
    const message = 'message' in payload ? payload.message : null
    if (typeof message === 'string' && message.trim()) {
      return message
    }
  }
  return fallback
}

function createRequestSignal(parentSignal?: AbortSignal, timeoutMs?: number) {
  if (!parentSignal && (!timeoutMs || timeoutMs <= 0)) {
    return { signal: undefined, cleanup: () => undefined }
  }

  const timeoutController = new AbortController()
  const relayController = new AbortController()
  let timer: ReturnType<typeof setTimeout> | null = null

  const onParentAbort = () => relayController.abort()
  parentSignal?.addEventListener('abort', onParentAbort)

  if (parentSignal?.aborted) {
    relayController.abort()
  }

  if (timeoutMs && timeoutMs > 0) {
    timer = setTimeout(() => timeoutController.abort(), timeoutMs)
    timeoutController.signal.addEventListener('abort', () => relayController.abort())
  }

  return {
    signal: relayController.signal,
    cleanup: () => {
      if (timer) clearTimeout(timer)
      parentSignal?.removeEventListener('abort', onParentAbort)
    },
  }
}

async function parseResponsePayload(response: Response) {
  const contentType = response.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    try {
      return await response.json()
    } catch {
      return null
    }
  }

  const text = await response.text()
  return text.length ? text : null
}

async function request<T>(method: 'get' | 'post' | 'put' | 'delete', path: string, config?: ApiRequestConfig, data?: unknown): Promise<ApiResponse<T>> {
  const send = async () => {
    const requestContext = await resolveRequestContext()
    const url = `${requestContext.baseUrl}${path}`
    const headers = new Headers(config?.headers)
    Object.entries(requestContext.headers).forEach(([name, value]) => {
      headers.set(name, value)
    })

    let body: string | undefined
    if (method === 'post' || method === 'put') {
      headers.set('Content-Type', 'application/json')
      body = JSON.stringify(data)
    }

    const { signal, cleanup } = createRequestSignal(config?.signal, config?.timeout)
    try {
      const response = await fetch(url, {
        method: method.toUpperCase(),
        headers,
        body,
        signal,
      })

      const payload = await parseResponsePayload(response)
      if (!response.ok) {
        throw new ApiHttpError(
          response.status,
          payload,
          readMessageFromPayload(payload, `Request failed (${response.status}).`),
        )
      }

      return {
        data: payload as T,
        status: response.status,
        ok: response.ok,
        headers: response.headers,
      }
    } finally {
      cleanup()
    }
  }

  try {
    return await send()
  } catch (error) {
    // The backend rotates its local API token on restart, so clear stale cached
    // request context and retry once when auth fails.
    if (isApiHttpError(error) && error.status === 401) {
      resetBackendBaseUrlCache()
      return send()
    }
    throw error
  }
}

export function apiGet<T>(path: string, config?: ApiRequestConfig): Promise<ApiResponse<T>> {
  return request<T>('get', path, config)
}

export function apiPost<T>(path: string, data?: unknown, config?: ApiRequestConfig): Promise<ApiResponse<T>> {
  return request<T>('post', path, config, data)
}

export function apiDelete<T>(path: string, config?: ApiRequestConfig): Promise<ApiResponse<T>> {
  return request<T>('delete', path, config)
}

export function apiPut<T>(path: string, data?: unknown, config?: ApiRequestConfig): Promise<ApiResponse<T>> {
  return request<T>('put', path, config, data)
}

export async function getBackendBaseUrl() {
  const requestContext = await resolveRequestContext()
  return requestContext.baseUrl
}

export async function getBackendRequestContext() {
  return resolveRequestContext()
}

export function resetBackendBaseUrlCache() {
  requestContextPromise = null
}
