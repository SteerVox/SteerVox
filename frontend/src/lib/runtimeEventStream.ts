import type { BackendRequestContext } from '../../shared/localBackendAuth'

export interface RuntimeEventStream {
  onopen: ((event: Event) => void) | null
  onerror: ((event: Event) => void) | null
  addEventListener(type: string, listener: EventListener): void
  removeEventListener(type: string, listener: EventListener): void
  close(): void
}

export type RuntimeEventStreamFactory = (requestContext: BackendRequestContext) => Promise<RuntimeEventStream>

function createEvent(type: string) {
  return new Event(type)
}

class FetchRuntimeEventStream implements RuntimeEventStream {
  onopen: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null

  private readonly listeners = new Map<string, Set<(event: MessageEvent<string>) => void>>()
  private readonly controller = new AbortController()
  private readonly requestContext: BackendRequestContext
  private readonly pathname: string
  private closed = false

  constructor(requestContext: BackendRequestContext, pathname: string) {
    this.requestContext = requestContext
    this.pathname = pathname
    queueMicrotask(() => {
      void this.connect()
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
    this.controller.abort()
    this.listeners.clear()
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

  private flushBuffer(buffer: string, flushAll = false) {
    const normalized = buffer.replace(/\r/g, '')
    const blocks = normalized.split('\n\n')
    const remainder = flushAll ? '' : (blocks.pop() ?? '')

    blocks.forEach((block) => {
      this.consumeBlock(block)
    })

    if (flushAll && remainder) {
      this.consumeBlock(remainder)
    }

    return remainder
  }

  private consumeBlock(block: string) {
    if (!block.trim()) {
      return
    }

    let eventType = 'message'
    const dataLines: string[] = []

    block.split('\n').forEach((line) => {
      if (!line || line.startsWith(':')) {
        return
      }

      const separatorIndex = line.indexOf(':')
      const field = separatorIndex === -1 ? line : line.slice(0, separatorIndex)
      const rawValue = separatorIndex === -1 ? '' : line.slice(separatorIndex + 1)
      const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue

      if (field === 'event') {
        eventType = value || 'message'
        return
      }

      if (field === 'data') {
        dataLines.push(value)
      }
    })

    if (!dataLines.length) {
      return
    }

    this.emit(eventType, dataLines.join('\n'))
  }

  private async connect() {
    try {
      const response = await fetch(`${this.requestContext.baseUrl}${this.pathname}`, {
        method: 'GET',
        headers: this.requestContext.headers,
        signal: this.controller.signal,
      })

      if (!response.ok) {
        throw new Error(`Realtime connection failed (${response.status}).`)
      }

      if (!response.body) {
        throw new Error('Realtime connection returned no event stream body.')
      }

      if (this.closed) {
        return
      }

      this.onopen?.(createEvent('open'))

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (!this.closed) {
        const { done, value } = await reader.read()
        if (done) {
          break
        }

        buffer += decoder.decode(value, { stream: true })
        buffer = this.flushBuffer(buffer)
      }

      buffer += decoder.decode()
      this.flushBuffer(buffer, true)

      if (!this.closed) {
        this.emitError()
      }
    } catch {
      if (this.closed || this.controller.signal.aborted) {
        return
      }
      this.emitError()
    }
  }
}

export const createFetchRuntimeEventStream: RuntimeEventStreamFactory = async (requestContext) => {
  return new FetchRuntimeEventStream(requestContext, '/events/runtime')
}
