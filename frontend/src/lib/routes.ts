import type { LibraryFilter } from '../types'

export type SettingsStepRoute = 'voice' | 'rewrite' | 'privacy' | 'advanced'

export const APP_ROUTES = {
  home: '/',
  library: '/library',
  templates: '/templates',
  settings: '/settings',
} as const

export function buildSettingsRoute(step: SettingsStepRoute = 'voice') {
  return step === 'voice' ? APP_ROUTES.settings : `${APP_ROUTES.settings}?step=${step}`
}

export function buildLibraryRoute(filter: LibraryFilter = 'all') {
  return filter === 'all' ? APP_ROUTES.library : `${APP_ROUTES.library}?filter=${filter}`
}

export function buildTemplatesRoute(templateId?: string | null) {
  if (!templateId) return APP_ROUTES.templates
  return `${APP_ROUTES.templates}?id=${encodeURIComponent(templateId)}`
}
