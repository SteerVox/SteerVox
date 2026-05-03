import type { BackendRuntimeEventPayload } from '../ipc/contracts'

export interface RuntimeEventStream {
  onopen: ((event: Event) => void) | null
  onerror: ((event: Event) => void) | null
  addEventListener(type: string, listener: EventListener): void
  removeEventListener(type: string, listener: EventListener): void
  close(): void
}

export type RuntimeEventStreamFactory = () => Promise<RuntimeEventStream>

function createEvent(type: string) {
  return new Event(type)
}

class IpcRuntimeEventStream implements RuntimeEventStream {
  onopen: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null

  private readonly listeners = new Map<string, Set<(event: MessageEvent<string>) => void>>()
  private disposeRuntimeEvent: (() => void) | null = null
  private closed = false

  constructor() {
    if (!window.windowControls?.onBackendRuntimeEvent || !window.windowControls?.startBackendRuntimeEvents) {
      queueMicrotask(() => this.emitError())
      return
    }

    this.disposeRuntimeEvent = window.windowControls.onBackendRuntimeEvent((payload) => {
      this.consumePayload(payload)
    })

    queueMicrotask(() => {
      if (this.closed) return
      void window.windowControls.startBackendRuntimeEvents().catch(() => {
        this.emitError()
      })
    })
  }

  addEventListener(type: string, listener: EventListener) {
    const bucket = this.listeners.get(type) ?? new Set<(event: MessageEvent<string>) => void>()
    bucket.add(listener as (event: MessageEvent<string>) => void)
    this.listeners.set(type, bucket)
  }

  removeEventListener(type: string, listener: EventListener) {
    this.listeners.get(type)?.delete(listener as (event: MessageEvent<string>) => void)
  }

  close() {
    this.closed = true
    this.disposeRuntimeEvent?.()
    this.disposeRuntimeEvent = null
    this.listeners.clear()
    void window.windowControls?.stopBackendRuntimeEvents?.()
  }

  private emit(type: string, data: string) {
    const event = new MessageEvent<string>(type, { data })
    this.listeners.get(type)?.forEach((listener) => listener(event))
  }

  private emitError() {
    if (this.closed) {
      return
    }
    this.onerror?.(createEvent('error'))
  }

  private consumePayload(payload: BackendRuntimeEventPayload) {
    if (this.closed) return

    if (payload.type === 'open') {
      this.onopen?.(createEvent('open'))
      return
    }
    if (payload.type === 'error') {
      this.emitError()
      return
    }

    this.emit(payload.type, payload.data ?? '')
  }
}

export const createFetchRuntimeEventStream: RuntimeEventStreamFactory = async () => {
  return new IpcRuntimeEventStream()
}
