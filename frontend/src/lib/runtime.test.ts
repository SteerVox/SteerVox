import { describe, expect, it } from 'vitest'

import { createLatestRequestController, retryRead } from './runtime'

describe('runtime helpers', () => {
  it('retries read operations with bounded attempts', async () => {
    let attempts = 0

    const result = await retryRead(async () => {
      attempts += 1
      if (attempts < 3) {
        throw new Error('temporary failure')
      }
      return 'ready'
    }, {
      delays: [0, 0, 0],
      shouldRetry: () => true,
    })

    expect(result).toBe('ready')
    expect(attempts).toBe(3)
  })

  it('cancels older requests when a newer request begins', () => {
    const controller = createLatestRequestController()
    const first = controller.begin()
    const second = controller.begin()

    expect(first.signal.aborted).toBe(true)
    expect(second.signal.aborted).toBe(false)
    expect(controller.isLatest(first.token)).toBe(false)
    expect(controller.isLatest(second.token)).toBe(true)
  })
})
