import {
  LOCAL_BACKEND_AUTH_HEADER,
  LOCAL_BACKEND_TOKEN_ENV_VAR,
} from './branding'

export {
  LOCAL_BACKEND_AUTH_HEADER,
  LOCAL_BACKEND_TOKEN_ENV_VAR,
}

export interface BackendRequestContext {
  baseUrl: string
  headers: Record<string, string>
}

export function buildLocalBackendHeaders(token: string): Record<string, string> {
  return {
    [LOCAL_BACKEND_AUTH_HEADER]: token,
  }
}
