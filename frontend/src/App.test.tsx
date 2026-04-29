import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./FloatingWidget', () => ({
  FloatingWidget: () => <div>Widget route alive</div>,
}))

vi.mock('./CaptureHost', () => ({
  default: () => <div>Capture route</div>,
}))

vi.mock('./InboxPopover', () => ({
  default: () => <div>Inbox route</div>,
}))

vi.mock('./AboutWindow', () => ({
  default: () => <div>About route</div>,
}))

vi.mock('./HomeView', () => ({
  HomeView: () => <div>Home route</div>,
}))

vi.mock('./LibraryView', () => ({
  LibraryView: () => <div>Library route</div>,
}))

vi.mock('./SkillsManager', () => ({
  SkillsManager: () => <div>Templates route</div>,
}))

vi.mock('./SettingsView', () => {
  throw new Error('Settings bundle should not load for the widget route.')
})

import App from './App'

describe('App route isolation', () => {
  beforeEach(() => {
    window.location.hash = '#/widget'
  })

  afterEach(() => {
    window.location.hash = ''
  })

  it('keeps the widget route alive without importing the Settings bundle', async () => {
    render(<App />)

    expect(await screen.findByText('Widget route alive')).toBeInTheDocument()
  })
})
