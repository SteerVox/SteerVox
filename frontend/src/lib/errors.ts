import { isApiHttpError } from './api'

export function isAbortError(error: unknown) {
  if (error instanceof DOMException && error.name === 'AbortError') return true
  return false
}

export function getErrorMessage(error: unknown, fallback: string) {
  if (isApiHttpError(error)) {
    const detail = error.data
    if (typeof detail === 'string' && detail.trim()) return detail
    if (detail && typeof detail === 'object') {
      const message = 'detail' in detail
        ? detail.detail
        : 'message' in detail
          ? detail.message
          : null
      if (typeof message === 'string' && message.trim()) return message
    }

    if (typeof error.message === 'string' && error.message.trim()) {
      return error.message
    }
  }

  if (error instanceof Error && error.message.trim()) return error.message
  return fallback
}

export function isRetriableReadError(error: unknown) {
  if (isAbortError(error)) return false

  if (isApiHttpError(error)) {
    const status = error.status
    return status >= 500 || status === 408 || status === 425 || status === 429
  }

  // Fetch network failures surface as TypeError.
  if (error instanceof TypeError) return true

  return false
}
