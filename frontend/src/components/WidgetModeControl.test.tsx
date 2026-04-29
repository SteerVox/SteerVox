import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { WidgetModeControl } from './WidgetModeControl'

describe('WidgetModeControl', () => {
  it('renders the active mode label', () => {
    render(
      <WidgetModeControl
        activeModeLabel="Standard Dictation"
        onChange={() => undefined}
        options={[
          { id: 'system_dictation', name: 'Standard Dictation', group: 'Dictation' },
          { id: 'system_rewrite', name: 'Professional Rewrite', group: 'Smart writing' },
        ]}
        selectedSkillId="system_dictation"
      />,
    )

    expect(screen.getByTestId('widget-mode-control')).toHaveTextContent('Mode')
    expect(screen.getByTestId('widget-mode-select')).toHaveValue('system_dictation')
    expect(screen.getByTestId('widget-mode-select')).toHaveClass('widget-inline-select')
  })

  it('updates the selected smart mode through the inline select', () => {
    const onChange = vi.fn()
    render(
        <WidgetModeControl
          activeModeLabel="Standard Dictation"
          onChange={onChange}
          options={[
          { id: 'system_dictation', name: 'Standard Dictation', group: 'Dictation' },
          { id: 'system_rewrite', name: 'Professional Rewrite', group: 'Smart writing' },
          ]}
          selectedSkillId="system_dictation"
        />,
    )

    fireEvent.change(screen.getByTestId('widget-mode-select'), {
      target: { value: 'system_rewrite' },
    })

    expect(onChange).toHaveBeenCalledWith('system_rewrite')
  })
})
