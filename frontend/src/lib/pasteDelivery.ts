import type { PasteResult } from '../types'

export type PasteDeliveryRequest = {
  id: string
  text: string
  restoreClipboardAfterPaste: boolean
}

type PasteBridgePayload = {
  id: string
  text: string
  options?: {
    restoreClipboard?: boolean
  }
}

type PasteBridge = (payload: PasteBridgePayload) => Promise<PasteResult>

type LocalPasteDeliveryState =
  | {
      status: 'in_flight'
      promise: Promise<PasteResult>
    }
  | {
      status: 'completed'
      result: PasteResult
      announced: boolean
      completedAt: number
    }

const COMPLETED_PASTE_TTL_MS = 5 * 60 * 1000
const MAX_TRACKED_PASTES = 100

const trackedPasteDeliveries = new Map<string, LocalPasteDeliveryState>()

function pruneTrackedPasteDeliveries(now = Date.now()) {
  for (const [pasteId, state] of trackedPasteDeliveries) {
    if (state.status === 'completed' && (now - state.completedAt) > COMPLETED_PASTE_TTL_MS) {
      trackedPasteDeliveries.delete(pasteId)
    }
  }

  while (trackedPasteDeliveries.size > MAX_TRACKED_PASTES) {
    const firstKey = trackedPasteDeliveries.keys().next().value
    if (!firstKey) break
    trackedPasteDeliveries.delete(firstKey)
  }
}

export function resetPasteDeliveryRegistry() {
  trackedPasteDeliveries.clear()
}

export function hasCompletedPasteDelivery(pasteId: string | null | undefined) {
  if (!pasteId) {
    return false
  }
  pruneTrackedPasteDeliveries()
  return trackedPasteDeliveries.get(pasteId)?.status === 'completed'
}

export function claimPasteDeliveryAnnouncement(pasteId: string | null | undefined) {
  if (!pasteId) {
    return false
  }

  pruneTrackedPasteDeliveries()
  const state = trackedPasteDeliveries.get(pasteId)
  if (!state || state.status !== 'completed' || state.announced) {
    return false
  }

  trackedPasteDeliveries.set(pasteId, {
    ...state,
    announced: true,
  })
  return true
}

export function clearPasteDeliveryAttempt(pasteId: string | null | undefined) {
  if (!pasteId) {
    return
  }
  const state = trackedPasteDeliveries.get(pasteId)
  if (state?.status === 'in_flight') {
    trackedPasteDeliveries.delete(pasteId)
  }
}

export async function deliverPendingPaste(
  request: PasteDeliveryRequest,
  pasteText: PasteBridge,
) {
  pruneTrackedPasteDeliveries()

  const existing = trackedPasteDeliveries.get(request.id)
  if (existing?.status === 'completed') {
    return existing.result
  }

  if (existing?.status === 'in_flight') {
    return existing.promise
  }

  const promise = Promise.resolve().then(() => pasteText({
    id: request.id,
    text: request.text,
    options: {
      restoreClipboard: request.restoreClipboardAfterPaste,
    },
  }))

  trackedPasteDeliveries.set(request.id, {
    status: 'in_flight',
    promise,
  })

  return promise
    .then((result) => {
      if (result.status === 'pasted' || result.status === 'copied') {
        trackedPasteDeliveries.set(request.id, {
          status: 'completed',
          result,
          announced: false,
          completedAt: Date.now(),
        })
      } else {
        trackedPasteDeliveries.delete(request.id)
      }
      return result
    })
    .catch((error) => {
      trackedPasteDeliveries.delete(request.id)
      throw error
    })
}
