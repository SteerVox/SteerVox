import { describe, expect, it } from 'vitest'

import { APP_ROUTES, buildLibraryRoute, buildSettingsRoute, parseSettingsStepRoute } from './routes'

describe('routes', () => {
  it('defaults Settings to Access', () => {
    expect(buildSettingsRoute()).toBe(APP_ROUTES.settings)
    expect(buildSettingsRoute('voice')).toBe('/settings?step=voice')
  })

  it('parses Settings steps symmetrically', () => {
    expect(parseSettingsStepRoute(null)).toBe('access')
    expect(parseSettingsStepRoute('voice')).toBe('voice')
    expect(parseSettingsStepRoute('rewrite')).toBe('rewrite')
    expect(parseSettingsStepRoute('privacy')).toBe('privacy')
    expect(parseSettingsStepRoute('advanced')).toBe('advanced')
    expect(parseSettingsStepRoute('invalid-step')).toBe('access')
  })

  it('builds Library filters with compact defaults', () => {
    expect(buildLibraryRoute()).toBe(APP_ROUTES.library)
    expect(buildLibraryRoute('computer_use')).toBe('/library?filter=computer_use')
  })
})
