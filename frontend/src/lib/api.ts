import type { BackendProxyRequest, BackendProxyResponse } from '../ipc/contracts'

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

let backendBaseUrlPromise: Promise<string> | null = null

async function resolveBackendBaseUrl() {
  if (!backendBaseUrlPromise) {
    if (!window.windowControls?.getBackendBaseUrl) {
      backendBaseUrlPromise = Promise.reject(new Error('The local backend bridge is unavailable.'))
    } else {
      backendBaseUrlPromise = window.windowControls.getBackendBaseUrl().then((value) => {
        if (!value) {
          throw new Error('The local backend URL is not ready yet.')
        }
        return value
      })
    }

    backendBaseUrlPromise = backendBaseUrlPromise.catch((error) => {
      backendBaseUrlPromise = null
      throw error
    })
  }

  return backendBaseUrlPromise
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

function headersToRecord(headers: Headers) {
  const result: Record<string, string> = {}
  headers.forEach((value, name) => {
    result[name] = value
  })
  return result
}

function waitForAbort<T>(promise: Promise<T>, signal?: AbortSignal) {
  if (!signal) return promise
  if (signal.aborted) {
    return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'))
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('The operation was aborted.', 'AbortError'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort)
    })
  })
}

async function sendBackendRequest<T>(request: BackendProxyRequest, signal?: AbortSignal): Promise<BackendProxyResponse<T>> {
  if (!window.windowControls?.backendRequest) {
    throw new Error('The local backend bridge is unavailable.')
  }
  return waitForAbort(window.windowControls.backendRequest<T>(request), signal)
}

async function request<T>(method: 'get' | 'post' | 'put' | 'delete', path: string, config?: ApiRequestConfig, data?: unknown): Promise<ApiResponse<T>> {
  const send = async () => {
    const headers = new Headers(config?.headers)
    if (method === 'post' || method === 'put') {
      headers.set('Content-Type', 'application/json')
    }

    const { signal, cleanup } = createRequestSignal(config?.signal, config?.timeout)
    try {
      const response = await sendBackendRequest<T>({
        method: method.toUpperCase() as BackendProxyRequest['method'],
        path,
        headers: headersToRecord(headers),
        body: method === 'post' || method === 'put' ? data : undefined,
        timeout: config?.timeout,
      }, signal)

      if (!response.ok) {
        throw new ApiHttpError(
          response.status,
          response.data,
          readMessageFromPayload(response.data, `Request failed (${response.status}).`),
        )
      }

      return {
        data: response.data as T,
        status: response.status,
        ok: response.ok,
        headers: new Headers(response.headers),
      }
    } finally {
      cleanup()
    }
  }

  try {
    return await send()
  } catch (error) {
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
  return resolveBackendBaseUrl()
}

export async function getBackendRequestContext() {
  return {
    baseUrl: await resolveBackendBaseUrl(),
    headers: {},
  }
}

export function resetBackendBaseUrlCache() {
  backendBaseUrlPromise = null
}
