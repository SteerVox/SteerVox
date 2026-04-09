import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { WidgetDomainModeControl, WidgetDomainStatusChip } from './WidgetDomainControl'

describe('WidgetDomainControl', () => {
  it('renders an active domain status chip when a domain is resolved', () => {
    render(
      <WidgetDomainStatusChip
        activeDomain={{
          id: 'shipping',
          label: 'Shipping / Logistics',
          source: 'global_pin',
          rule_id: null,
          rule_label: null,
        }}
      />,
    )

    expect(screen.getByTestId('widget-domain-badge')).toHaveTextContent('Shipping')
    expect(screen.getByTestId('widget-domain-source')).toHaveTextContent('Pinned')
  })

  it('renders the empty domain state cleanly', () => {
    render(<WidgetDomainStatusChip activeDomain={null} />)

    expect(screen.getByTestId('widget-domain-badge-empty')).toHaveTextContent('No active domain')
    expect(screen.queryByTestId('widget-domain-source')).toBeNull()
  })

  it('updates the selected domain mode through the dedicated inline select callback', () => {
    const onChange = vi.fn()
    render(
      <WidgetDomainModeControl
        activeDomain={null}
        domainMode="auto"
        onChange={onChange}
      />,
    )

    fireEvent.change(screen.getByTestId('widget-domain-mode-select'), {
      target: { value: 'medical' },
    })

    expect(onChange).toHaveBeenCalledWith('medical')
    expect(screen.getByTestId('widget-domain-mode-control')).toHaveTextContent('Domain mode')
  })
})
