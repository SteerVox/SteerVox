import type { LibraryFilter } from '../types'

export type SettingsStepRoute = 'voice' | 'rewrite' | 'access' | 'privacy' | 'advanced'
const SETTINGS_STEP_ROUTES = new Set<SettingsStepRoute>(['voice', 'rewrite', 'access', 'privacy', 'advanced'])

export const APP_ROUTES = {
  home: '/',
  library: '/library',
  templates: '/templates',
  settings: '/settings',
} as const

export function buildSettingsRoute(step: SettingsStepRoute = 'access') {
  return step === 'access' ? APP_ROUTES.settings : `${APP_ROUTES.settings}?step=${step}`
}

export function parseSettingsStepRoute(step: string | null | undefined): SettingsStepRoute {
  if (step && SETTINGS_STEP_ROUTES.has(step as SettingsStepRoute)) {
    return step as SettingsStepRoute
  }
  return 'access'
}

export function buildLibraryRoute(filter: LibraryFilter = 'all') {
  return filter === 'all' ? APP_ROUTES.library : `${APP_ROUTES.library}?filter=${filter}`
}

export function buildTemplatesRoute(templateId?: string | null) {
  if (!templateId) return APP_ROUTES.templates
  return `${APP_ROUTES.templates}?id=${encodeURIComponent(templateId)}`
}
