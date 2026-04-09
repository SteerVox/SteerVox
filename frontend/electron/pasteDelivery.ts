export type PasteResult = {
  status: 'pasted' | 'copied' | 'failed'
  detail: string | null
}

export type PasteDeliveryPayload = {
  id: string | null
  text: string
  restoreClipboard: boolean
}

export type PasteAckOutcome = 'acknowledged' | 'stale'

type PasteDeliveryDeps = {
  performPaste: (payload: PasteDeliveryPayload) => Promise<PasteResult>
  acknowledgePaste: (pasteId: string, result: 'pasted' | 'copied') => Promise<PasteAckOutcome>
  log?: (message: string) => void
  sleep?: (ms: number) => Promise<void>
  dedupeTtlMs?: number
  ackRetryDelaysMs?: number[]
}

const DEFAULT_ACK_RETRY_DELAYS_MS = [250, 500, 1000, 2000, 2000] as const
const DEFAULT_DEDUPE_TTL_MS = 30_000

function defaultSleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

export function createPasteDeliveryCoordinator({
  performPaste,
  acknowledgePaste,
  log,
  sleep = defaultSleep,
  dedupeTtlMs = DEFAULT_DEDUPE_TTL_MS,
  ackRetryDelaysMs = [...DEFAULT_ACK_RETRY_DELAYS_MS],
}: PasteDeliveryDeps) {
  const cachedDeliveries = new Map<string, Promise<PasteResult>>()
  const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const ackInFlight = new Set<string>()

  const clearCachedDelivery = (pasteId: string) => {
    cachedDeliveries.delete(pasteId)
    const timer = cleanupTimers.get(pasteId)
    if (timer) {
      clearTimeout(timer)
      cleanupTimers.delete(pasteId)
    }
  }

  const scheduleCachedDeliveryCleanup = (pasteId: string) => {
    const existing = cleanupTimers.get(pasteId)
    if (existing) {
      clearTimeout(existing)
    }
    const timer = setTimeout(() => {
      cleanupTimers.delete(pasteId)
      cachedDeliveries.delete(pasteId)
    }, dedupeTtlMs)
    cleanupTimers.set(pasteId, timer)
  }

  const acknowledgeInBackground = async (pasteId: string, result: 'pasted' | 'copied') => {
    if (ackInFlight.has(pasteId)) {
      return
    }

    ackInFlight.add(pasteId)
    let attempt = 0
    try {
      while (true) {
        attempt += 1
        try {
          log?.(`[PasteDelivery] Ack attempt=${attempt} paste_id=${pasteId} result=${result}`)
          const outcome = await acknowledgePaste(pasteId, result)
          if (outcome === 'acknowledged') {
            log?.(`[PasteDelivery] Ack succeeded paste_id=${pasteId} result=${result}`)
          } else {
            log?.(`[PasteDelivery] Ack skipped as stale paste_id=${pasteId} result=${result}`)
          }
          return
        } catch (error) {
          const delay = ackRetryDelaysMs[Math.min(attempt - 1, ackRetryDelaysMs.length - 1)] ?? 2000
          const message = error instanceof Error ? error.message : String(error)
          log?.(`[PasteDelivery] Ack failed paste_id=${pasteId} attempt=${attempt} retry_in_ms=${delay} error=${message}`)
          await sleep(delay)
        }
      }
    } finally {
      ackInFlight.delete(pasteId)
    }
  }

  const executeDelivery = async (payload: PasteDeliveryPayload) => {
    log?.(`[PasteDelivery] Delivery start paste_id=${payload.id ?? 'none'} chars=${payload.text.length}`)
    const result = await Promise.resolve().then(() => performPaste(payload))
    log?.(`[PasteDelivery] Delivery result paste_id=${payload.id ?? 'none'} status=${result.status}`)

    if (payload.id && (result.status === 'pasted' || result.status === 'copied')) {
      void acknowledgeInBackground(payload.id, result.status)
    }

    return result
  }

  return {
    deliver(payload: PasteDeliveryPayload) {
      if (!payload.id) {
        return executeDelivery(payload)
      }

      const existing = cachedDeliveries.get(payload.id)
      if (existing) {
        log?.(`[PasteDelivery] Reusing cached delivery paste_id=${payload.id}`)
        return existing
      }

      const deliveryPromise = executeDelivery(payload)
      cachedDeliveries.set(payload.id, deliveryPromise)

      void deliveryPromise
        .then((result) => {
          if (result.status === 'failed') {
            clearCachedDelivery(payload.id as string)
            return
          }
          scheduleCachedDeliveryCleanup(payload.id as string)
        })
        .catch(() => {
          clearCachedDelivery(payload.id as string)
        })

      return deliveryPromise
    },
    dispose() {
      ackInFlight.clear()
      cachedDeliveries.clear()
      for (const timer of cleanupTimers.values()) {
        clearTimeout(timer)
      }
      cleanupTimers.clear()
    },
  }
}
