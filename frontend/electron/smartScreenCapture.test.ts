import { describe, expect, it } from 'vitest'

import {
  SMART_SCREEN_CAPTURE_MAX_EDGE_PX,
  SMART_SCREEN_CAPTURE_MIN_EDGE_PX,
  chooseOptimizedJpegBuffer,
  nextScreenCaptureSize,
  scaleScreenCaptureSize,
} from './smartScreenCapture'

describe('smart screen capture helpers', () => {
  it('scales the long edge down to the local vision budget', () => {
    const resized = scaleScreenCaptureSize(3024, 1964)

    expect(Math.max(resized.width, resized.height)).toBeLessThanOrEqual(SMART_SCREEN_CAPTURE_MAX_EDGE_PX)
    expect(resized.width).toBe(640)
    expect(resized.height).toBe(416)
  })

  it('keeps smaller captures unchanged', () => {
    expect(scaleScreenCaptureSize(600, 375)).toEqual({ width: 600, height: 375 })
  })

  it('chooses the first jpeg that fits the byte budget', () => {
    const sizes = new Map([
      [54, 120_000],
      [46, 79_000],
      [38, 72_000],
    ])

    const result = chooseOptimizedJpegBuffer((quality) => Buffer.alloc(sizes.get(quality) || 500_000))

    expect(result?.quality).toBe(46)
    expect(result?.buffer.length).toBe(79_000)
  })

  it('falls back to the smallest jpeg when none hit the target budget', () => {
    const sizes = new Map([
      [54, 110_000],
      [46, 104_000],
      [38, 96_000],
      [30, 89_000],
      [24, 84_000],
      [18, 82_000],
    ])

    const result = chooseOptimizedJpegBuffer((quality) => Buffer.alloc(sizes.get(quality) || 500_000))

    expect(result?.quality).toBe(18)
    expect(result?.buffer.length).toBe(82_000)
  })

  it('progressively downscales captures until the minimum edge budget', () => {
    expect(nextScreenCaptureSize(640, 415)).toEqual({ width: 524, height: 340 })
    expect(nextScreenCaptureSize(SMART_SCREEN_CAPTURE_MIN_EDGE_PX, 200)).toEqual({
      width: SMART_SCREEN_CAPTURE_MIN_EDGE_PX,
      height: 200,
    })
  })
})
