import type { ApiRequestConfig, ApiResponse } from './api'
import { getErrorMessage, isAbortError, isRetriableReadError } from './errors'

export const READ_RETRY_DELAYS_MS = [300, 700, 1500, 3000] as const

export async function delay(ms: number, signal?: AbortSignal) {
  if (ms <= 0) return

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)

    const onAbort = () => {
      cleanup()
      reject(new DOMException('Aborted', 'AbortError'))
    }

    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }

    if (signal?.aborted) {
      cleanup()
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }

    signal?.addEventListener('abort', onAbort)
  })
}

function jitterDelay(baseDelay: number) {
  const jitter = Math.round(baseDelay * 0.12)
  const delta = Math.floor(Math.random() * ((jitter * 2) + 1)) - jitter
  return Math.max(0, baseDelay + delta)
}

export async function retryRead<T>(
  task: (signal: AbortSignal) => Promise<T>,
  options?: {
    signal?: AbortSignal
    delays?: readonly number[]
    shouldRetry?: (error: unknown) => boolean
    onRetry?: (error: unknown, attempt: number, delayMs: number) => void
  },
) {
  const parentSignal = options?.signal
  const delays = options?.delays ?? READ_RETRY_DELAYS_MS
  const shouldRetry = options?.shouldRetry ?? isRetriableReadError

  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    const attemptController = new AbortController()
    const onAbort = () => {
      attemptController.abort()
    }

    if (parentSignal?.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }

    parentSignal?.addEventListener('abort', onAbort)

    try {
      return await task(attemptController.signal)
    } catch (error) {
      if (isAbortError(error)) throw error
      if (attempt >= delays.length || !shouldRetry(error)) throw error

      const delayMs = jitterDelay(delays[attempt])
      options?.onRetry?.(error, attempt + 1, delayMs)
      await delay(delayMs, parentSignal)
    } finally {
      parentSignal?.removeEventListener('abort', onAbort)
    }
  }

  throw new Error('Unexpected retry exhaustion.')
}

export type LatestRequestSnapshot = {
  token: number
  signal: AbortSignal
}

export function createLatestRequestController() {
  let latestToken = 0
  let activeController: AbortController | null = null

  return {
    begin(): LatestRequestSnapshot {
      latestToken += 1
      activeController?.abort()
      activeController = new AbortController()
      return { token: latestToken, signal: activeController.signal }
    },
    isLatest(token: number) {
      return token === latestToken
    },
    cancel() {
      latestToken += 1
      activeController?.abort()
      activeController = null
    },
  }
}

export type RequestOptions = ApiRequestConfig & {
  signal?: AbortSignal
}

export function withSignal(config: RequestOptions | undefined, signal: AbortSignal): RequestOptions {
  return {
    ...(config || {}),
    signal,
  }
}

export async function settleRecord<T extends Record<string, Promise<unknown>>>(record: T) {
  const entries = Object.entries(record) as Array<[keyof T, T[keyof T]]>
  const settled = await Promise.all(entries.map(async ([key, promise]) => {
    const result = await Promise.resolve(promise).then(
      (value) => ({ status: 'fulfilled', value } as const),
      (reason) => ({ status: 'rejected', reason } as const),
    )
    return [key, result] as const
  }))

  return Object.fromEntries(settled) as {
    [K in keyof T]:
    | { status: 'fulfilled'; value: Awaited<T[K]> }
    | { status: 'rejected'; reason: unknown }
  }
}

export function responseData<T>(response: ApiResponse<T>) {
  return response.data
}

export async function runSafeAction<T>(
  task: () => Promise<T>,
  options: {
    fallbackError: string
    onSuccess?: (value: T) => void
    onError: (message: string) => void
  },
) {
  try {
    const value = await task()
    options.onSuccess?.(value)
    return value
  } catch (error) {
    options.onError(getErrorMessage(error, options.fallbackError))
    return null
  }
}
