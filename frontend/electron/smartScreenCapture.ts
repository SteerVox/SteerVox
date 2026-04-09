export const SMART_SCREEN_CAPTURE_MAX_EDGE_PX = 640
export const SMART_SCREEN_CAPTURE_MIN_EDGE_PX = 320
export const SMART_SCREEN_CAPTURE_TARGET_BYTES = 80_000
export const SMART_SCREEN_CAPTURE_QUALITIES = [54, 46, 38, 30, 24, 18] as const
const SMART_SCREEN_CAPTURE_DOWNSCALE_RATIO = 0.82

export function scaleScreenCaptureSize(rawWidth: number, rawHeight: number) {
  const width = Math.max(1, Math.round(rawWidth))
  const height = Math.max(1, Math.round(rawHeight))
  const longestEdge = Math.max(width, height)

  if (longestEdge <= SMART_SCREEN_CAPTURE_MAX_EDGE_PX) {
    return { width, height }
  }

  const scale = SMART_SCREEN_CAPTURE_MAX_EDGE_PX / longestEdge
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

export function chooseOptimizedJpegBuffer(
  encodeJpeg: (quality: number) => Buffer,
  targetBytes = SMART_SCREEN_CAPTURE_TARGET_BYTES,
) {
  let smallest: { buffer: Buffer; quality: number } | null = null

  for (const quality of SMART_SCREEN_CAPTURE_QUALITIES) {
    const buffer = encodeJpeg(quality)
    if (!buffer.length) {
      continue
    }

    if (!smallest || buffer.length < smallest.buffer.length) {
      smallest = { buffer, quality }
    }

    if (buffer.length <= targetBytes) {
      return { buffer, quality }
    }
  }

  return smallest
}

export function nextScreenCaptureSize(currentWidth: number, currentHeight: number) {
  const width = Math.max(1, Math.round(currentWidth))
  const height = Math.max(1, Math.round(currentHeight))
  const longestEdge = Math.max(width, height)

  if (longestEdge <= SMART_SCREEN_CAPTURE_MIN_EDGE_PX) {
    return { width, height }
  }

  const nextLongestEdge = Math.max(
    SMART_SCREEN_CAPTURE_MIN_EDGE_PX,
    Math.floor(longestEdge * SMART_SCREEN_CAPTURE_DOWNSCALE_RATIO),
  )
  if (nextLongestEdge >= longestEdge) {
    return { width, height }
  }

  const scale = nextLongestEdge / longestEdge
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}
