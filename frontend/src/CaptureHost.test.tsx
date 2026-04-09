import { act, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CaptureHost } from './CaptureHost'

const { apiGetMock, playStartChimeMock, playStopChimeMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  playStartChimeMock: vi.fn(),
  playStopChimeMock: vi.fn(),
}))

vi.mock('./lib/api', () => ({
  apiGet: apiGetMock,
}))

vi.mock('./lib/sounds', () => ({
  playStartChime: playStartChimeMock,
  playStopChime: playStopChimeMock,
}))

type CaptureCommand = {
  requestId: string
  command: 'start-recording' | 'stop-recording' | 'start-mic-test' | 'stop-mic-test'
  payload?: Record<string, unknown>
}

class FakeAudioContext {
  state: AudioContextState = 'suspended'
  sampleRate = 48000
  destination = {}

  async resume() {
    this.state = 'running'
  }

  async suspend() {
    this.state = 'suspended'
  }

  async close() {
    this.state = 'closed'
  }

  createMediaStreamSource() {
    return {
      connect: vi.fn(),
      disconnect: vi.fn(),
    }
  }

  createGain() {
    return {
      gain: { value: 0 },
      connect: vi.fn(),
      disconnect: vi.fn(),
    }
  }

  createScriptProcessor() {
    return {
      connect: vi.fn(),
      disconnect: vi.fn(),
      onaudioprocess: null,
    }
  }
}

describe('CaptureHost recording cues', () => {
  let onCommand: ((command: unknown) => void) | null = null
  let sendResponseMock: ReturnType<typeof vi.fn>
  let sendStateMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    onCommand = null
    sendResponseMock = vi.fn()
    sendStateMock = vi.fn()
    apiGetMock.mockReset()
    playStartChimeMock.mockReset()
    playStopChimeMock.mockReset()
    apiGetMock.mockResolvedValue({ data: { recording_cues_enabled: true } })

    const track = {
      stop: vi.fn(),
      getSettings: () => ({ deviceId: 'default' }),
    }
    const stream = {
      getTracks: () => [track],
      getAudioTracks: () => [track],
    }

    vi.stubGlobal('AudioContext', FakeAudioContext)
    Object.defineProperty(window, 'AudioContext', {
      configurable: true,
      writable: true,
      value: FakeAudioContext,
    })
    Object.defineProperty(globalThis.navigator, 'mediaDevices', {
      configurable: true,
      value: {
        enumerateDevices: vi.fn().mockResolvedValue([
          {
            kind: 'audioinput',
            deviceId: 'default',
            label: 'System default microphone',
            groupId: 'group-1',
          },
        ]),
        getUserMedia: vi.fn().mockResolvedValue(stream),
      },
    })

    window.captureBridge = {
      onCommand: vi.fn((callback) => {
        onCommand = callback as (command: unknown) => void
        return () => {
          onCommand = null
        }
      }),
      sendResponse: sendResponseMock as unknown as (requestId: string, payload: unknown) => void,
      sendState: sendStateMock as unknown as (state: import('./types').CaptureState) => void,
      sendChunk: vi.fn(),
      notifyReady: vi.fn(),
    }
  })

  async function dispatch(command: CaptureCommand) {
    await act(async () => {
      onCommand?.(command)
      await Promise.resolve()
    })
  }

  it('plays start and stop cues for a real recording session', async () => {
    render(<CaptureHost />)

    await dispatch({
      requestId: 'start-1',
      command: 'start-recording',
      payload: { mode: 'dictation' },
    })

    await waitFor(() => {
      expect(sendResponseMock).toHaveBeenCalledWith('start-1', { status: 'started', message: 'Recording started' })
    })
    expect(playStartChimeMock).toHaveBeenCalledTimes(1)

    await dispatch({
      requestId: 'stop-1',
      command: 'stop-recording',
    })

    await waitFor(() => {
      expect(sendResponseMock).toHaveBeenCalledWith('stop-1', expect.objectContaining({ status: 'error' }))
    })
    expect(playStopChimeMock).toHaveBeenCalledTimes(1)
  })

  it('does not play cues for mic tests', async () => {
    render(<CaptureHost />)

    await dispatch({
      requestId: 'mic-start',
      command: 'start-mic-test',
      payload: {},
    })

    await waitFor(() => {
      expect(sendResponseMock).toHaveBeenCalledWith('mic-start', { status: 'started', message: 'Microphone check started' })
    })

    await dispatch({
      requestId: 'mic-stop',
      command: 'stop-mic-test',
    })

    await waitFor(() => {
      expect(sendResponseMock).toHaveBeenCalledWith('mic-stop', expect.objectContaining({ status: 'error' }))
    })
    expect(playStartChimeMock).not.toHaveBeenCalled()
    expect(playStopChimeMock).not.toHaveBeenCalled()
  })

  it('does not play cues when recording cues are disabled in settings', async () => {
    apiGetMock.mockReset()
    apiGetMock.mockResolvedValue({ data: { recording_cues_enabled: false } })

    render(<CaptureHost />)

    // Wait for the initial settings probe to complete so the gate is in
    // its disabled state before any commands fire.
    await waitFor(() => {
      expect(apiGetMock).toHaveBeenCalled()
    })

    await dispatch({
      requestId: 'start-quiet',
      command: 'start-recording',
      payload: { mode: 'dictation' },
    })

    await waitFor(() => {
      expect(sendResponseMock).toHaveBeenCalledWith('start-quiet', { status: 'started', message: 'Recording started' })
    })

    await dispatch({
      requestId: 'stop-quiet',
      command: 'stop-recording',
    })

    await waitFor(() => {
      expect(sendResponseMock).toHaveBeenCalledWith('stop-quiet', expect.objectContaining({ status: 'error' }))
    })

    expect(playStartChimeMock).not.toHaveBeenCalled()
    expect(playStopChimeMock).not.toHaveBeenCalled()
  })
})
