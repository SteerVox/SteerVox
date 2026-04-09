import { useEffect } from 'react'

import { CAPTURE_PROCESSOR_NAME, DISPLAY_NAME } from '../shared/branding'
import { apiGet } from './lib/api'
import { playStartChime, playStopChime } from './lib/sounds'
import type { CaptureState } from './types'

type CaptureCommand =
  | { requestId: string; command: 'get-devices'; payload?: { refresh?: boolean } }
  | { requestId: string; command: 'warmup' }
  | { requestId: string; command: 'start-recording'; payload?: { mode?: 'dictation' | 'smart_transform'; deviceId?: string | null; deviceLabel?: string | null; liveSessionId?: string | null } }
  | { requestId: string; command: 'stop-recording' }
  | { requestId: string; command: 'start-mic-test'; payload?: { deviceId?: string | null; deviceLabel?: string | null } }
  | { requestId: string; command: 'stop-mic-test' }

type ActiveSession = {
  kind: 'recording' | 'mic_test'
  stream: MediaStream
  audioContext: AudioContext
  source: MediaStreamAudioSourceNode
  sinkNode: AudioNode
  teardownNode: AudioNode
  sampleRate: number
  chunks: Float32Array[]
  totalFrames: number
  peak: number
  sumSquares: number
  fallbackToDefault: boolean
  fallbackNotice: string | null
  requestedDeviceId: string | null
  requestedDeviceLabel: string | null
  usedDeviceId: string | null
  usedDeviceLabel: string | null
  fallbackTimer: number | null
  amplitudeResetTimer: number | null
  liveFlushTimer: number | null
  restartingToDefault: boolean
  liveSessionId: string | null
  liveChunks: Uint8Array[]
  liveChunkBytes: number
}

const CAPTURE_SAMPLE_RATE = 16_000
const SILENCE_THRESHOLD = 0.003
const FALLBACK_PROBE_MS = 1_250

function createInitialState(): CaptureState {
  return {
    is_recording: false,
    is_testing: false,
    mode: null,
    phase: 'idle',
    amplitude: 0,
    error: null,
    active_device_id: null,
    active_device_label: null,
    fallback_to_default: false,
    fallback_notice: null,
  }
}

function toBase64(bytes: Uint8Array) {
  let binary = ''
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

function mergeChunks(chunks: Float32Array[], totalFrames: number) {
  const merged = new Float32Array(totalFrames)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  return merged
}

function downsample(buffer: Float32Array, sourceRate: number, targetRate: number) {
  if (sourceRate === targetRate) return buffer

  const ratio = sourceRate / targetRate
  const nextLength = Math.round(buffer.length / ratio)
  const result = new Float32Array(nextLength)

  let offsetBuffer = 0
  for (let offsetResult = 0; offsetResult < nextLength; offsetResult += 1) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio)
    let sum = 0
    let count = 0

    for (let index = offsetBuffer; index < nextOffsetBuffer && index < buffer.length; index += 1) {
      sum += buffer[index]
      count += 1
    }

    result[offsetResult] = count > 0 ? sum / count : 0
    offsetBuffer = nextOffsetBuffer
  }

  return result
}

function encodeWav(samples: Float32Array, sampleRate: number) {
  const bytesPerSample = 2
  const blockAlign = bytesPerSample
  const byteRate = sampleRate * blockAlign
  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample)
  const view = new DataView(buffer)

  const writeString = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index))
    }
  }

  writeString(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * bytesPerSample, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 16, true)
  writeString(36, 'data')
  view.setUint32(40, samples.length * bytesPerSample, true)

  let offset = 44
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]))
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
    offset += 2
  }

  return new Uint8Array(buffer)
}

function encodePcm16(samples: Float32Array) {
  const buffer = new ArrayBuffer(samples.length * 2)
  const view = new DataView(buffer)
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]))
    view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
  }
  return new Uint8Array(buffer)
}

async function listInputDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices
    .filter((device) => device.kind === 'audioinput')
    .map((device) => ({
      id: device.deviceId,
      label: device.label || (device.deviceId === 'default' ? 'System default microphone' : 'Microphone'),
      is_default: device.deviceId === 'default',
      group_id: device.groupId || null,
    }))
}

export function CaptureHost() {
  useEffect(() => {
    let captureState = createInitialState()
    let activeSession: ActiveSession | null = null
    let commandGeneration = 0
    let isTransitioning = false
    let sharedAudioContext: AudioContext | null = null
    let audioWorkletReady: Promise<void> | null = null
    let recordingCuesEnabled = false

    const processorSource = `
      class CaptureProcessor extends AudioWorkletProcessor {
        process(inputs) {
          const input = inputs[0]
          if (input && input[0] && input[0].length) {
            const channel = input[0]
            const copy = new Float32Array(channel)
            let peak = 0
            let sumSquares = 0
            for (let index = 0; index < copy.length; index += 1) {
              const sample = copy[index]
              const abs = Math.abs(sample)
              if (abs > peak) peak = abs
              sumSquares += sample * sample
            }
            this.port.postMessage({ samples: copy, peak, sumSquares }, [copy.buffer])
          }
          return true
        }
      }
      registerProcessor(${JSON.stringify(CAPTURE_PROCESSOR_NAME)}, CaptureProcessor)
    `

    const pushState = (patch: Partial<CaptureState>) => {
      captureState = {
        ...captureState,
        ...patch,
      }
      window.captureBridge?.sendState(captureState)
    }

    const resolveRequestedDevice = async (deviceId?: string | null, deviceLabel?: string | null) => {
      const devices = await listInputDevices()
      const exactById = deviceId ? devices.find((device) => device.id === deviceId) : null
      if (exactById) return exactById

      const exactByLabel = deviceLabel ? devices.find((device) => device.label === deviceLabel) : null
      if (exactByLabel) return exactByLabel

      return devices.find((device) => device.is_default) || null
    }

    const getSharedAudioContext = async ({ resume = true }: { resume?: boolean } = {}) => {
      if (!sharedAudioContext || sharedAudioContext.state === 'closed') {
        sharedAudioContext = new AudioContext()
        audioWorkletReady = null
      }
      if (resume && sharedAudioContext.state === 'suspended') {
        await sharedAudioContext.resume()
      }
      return sharedAudioContext
    }

    const refreshRecordingCuesEnabled = async () => {
      try {
        const response = await apiGet<{ recording_cues_enabled?: boolean }>('/status', { timeout: 2500 })
        recordingCuesEnabled = Boolean(response.data?.recording_cues_enabled)
      } catch {
        recordingCuesEnabled = false
      }
      return recordingCuesEnabled
    }

    const maybePlayRecordingCue = async (kind: 'start' | 'stop') => {
      const enabled = await refreshRecordingCuesEnabled()
      if (!enabled) return

      const audioContext = await getSharedAudioContext({ resume: true }).catch(() => null)
      if (!audioContext) return

      if (kind === 'start') {
        playStartChime(audioContext)
      } else {
        playStopChime(audioContext)
      }
    }

    const ensureAudioWorkletLoaded = async (audioContext: AudioContext) => {
      if (typeof AudioWorkletNode === 'undefined' || !('audioWorklet' in audioContext)) {
        return false
      }
      if (!audioWorkletReady) {
        audioWorkletReady = (async () => {
          const blobUrl = URL.createObjectURL(new Blob([processorSource], { type: 'text/javascript' }))
          try {
            await audioContext.audioWorklet.addModule(blobUrl)
          } finally {
            URL.revokeObjectURL(blobUrl)
          }
        })()
      }
      await audioWorkletReady
      return true
    }

    const clearSessionTimers = (session: ActiveSession | null) => {
      if (!session) return
      if (session.fallbackTimer) window.clearTimeout(session.fallbackTimer)
      if (session.amplitudeResetTimer) window.clearTimeout(session.amplitudeResetTimer)
      if (session.liveFlushTimer) window.clearTimeout(session.liveFlushTimer)
      session.fallbackTimer = null
      session.amplitudeResetTimer = null
      session.liveFlushTimer = null
    }

    const teardownSession = async (session: ActiveSession | null) => {
      if (!session) return
      clearSessionTimers(session)
      try {
        session.source.disconnect()
      } catch {
        // no-op
      }
      try {
        session.teardownNode.disconnect()
      } catch {
        // no-op
      }
      try {
        session.sinkNode.disconnect()
      } catch {
        // no-op
      }
      session.stream.getTracks().forEach((track) => track.stop())
      if (session.audioContext.state === 'running') {
        await session.audioContext.suspend().catch(() => undefined)
      }
    }

    const flushLiveChunks = (session: ActiveSession | null) => {
      if (!session || !session.liveSessionId || !session.liveChunkBytes) return
      const merged = new Uint8Array(session.liveChunkBytes)
      let offset = 0
      for (const chunk of session.liveChunks) {
        merged.set(chunk, offset)
        offset += chunk.length
      }
      session.liveChunks = []
      session.liveChunkBytes = 0
      window.captureBridge?.sendChunk?.({
        sessionId: session.liveSessionId,
        sampleRate: CAPTURE_SAMPLE_RATE,
        pcmS16leBase64: toBase64(merged),
      })
    }

    const queueLiveChunk = (session: ActiveSession, chunk: Float32Array) => {
      if (!session.liveSessionId || session.kind !== 'recording') {
        return
      }
      const downsampled = downsample(chunk, session.sampleRate, CAPTURE_SAMPLE_RATE)
      if (!downsampled.length) return
      const pcmBytes = encodePcm16(downsampled)
      session.liveChunks.push(pcmBytes)
      session.liveChunkBytes += pcmBytes.length
      if (!session.liveFlushTimer) {
        session.liveFlushTimer = window.setTimeout(() => {
          session.liveFlushTimer = null
          flushLiveChunks(session)
        }, 180)
      }
    }

    const warmupCaptureHost = async () => {
      await listInputDevices().catch(() => [])
      const audioContext = await getSharedAudioContext({ resume: false })
      await ensureAudioWorkletLoaded(audioContext).catch(() => undefined)
      if (audioContext.state === 'running') {
        await audioContext.suspend().catch(() => undefined)
      }
    }

    const buildCaptureNodes = async (
      audioContext: AudioContext,
      source: MediaStreamAudioSourceNode,
      session: ActiveSession,
      stateMode: CaptureState['mode'],
      generation: number,
    ) => {
      const gain = audioContext.createGain()
      gain.gain.value = 0

      const sendAmplitude = (peak: number) => {
        if (generation !== commandGeneration) return
        pushState({
          is_recording: stateMode === 'dictation' || stateMode === 'smart_transform',
          is_testing: stateMode === 'mic_test',
          mode: stateMode,
          phase: stateMode === 'mic_test' ? 'recording' : 'recording',
          amplitude: peak,
          active_device_id: session.usedDeviceId,
          active_device_label: session.usedDeviceLabel,
          fallback_to_default: session.fallbackToDefault,
          fallback_notice: session.fallbackNotice,
          error: null,
        })
        if (session.amplitudeResetTimer) window.clearTimeout(session.amplitudeResetTimer)
        session.amplitudeResetTimer = window.setTimeout(() => {
          if (generation !== commandGeneration) return
          pushState({ amplitude: 0 })
        }, 120)
      }

      const appendChunk = (chunk: Float32Array) => {
        session.chunks.push(chunk)
        session.totalFrames += chunk.length
        queueLiveChunk(session, chunk)
      }

      if (await ensureAudioWorkletLoaded(audioContext)) {
        const node = new AudioWorkletNode(audioContext, CAPTURE_PROCESSOR_NAME)
        node.port.onmessage = (event) => {
          const { samples, peak, sumSquares } = event.data as {
            samples: Float32Array
            peak: number
            sumSquares: number
          }
          if (generation !== commandGeneration) return
          appendChunk(samples)
          session.peak = Math.max(session.peak, peak)
          session.sumSquares += sumSquares
          sendAmplitude(peak)
        }
        source.connect(node)
        node.connect(gain)
        gain.connect(audioContext.destination)
        return { teardownNode: node, sinkNode: gain }
      }

      const node = audioContext.createScriptProcessor(4096, 1, 1)
      node.onaudioprocess = (event) => {
        if (generation !== commandGeneration) return
        const input = event.inputBuffer.getChannelData(0)
        const chunk = new Float32Array(input.length)
        chunk.set(input)
        let peak = 0
        let sumSquares = 0
        for (let index = 0; index < chunk.length; index += 1) {
          const sample = chunk[index]
          const abs = Math.abs(sample)
          if (abs > peak) peak = abs
          sumSquares += sample * sample
        }
        appendChunk(chunk)
        session.peak = Math.max(session.peak, peak)
        session.sumSquares += sumSquares
        sendAmplitude(peak)
      }
      source.connect(node)
      node.connect(gain)
      gain.connect(audioContext.destination)
      return { teardownNode: node, sinkNode: gain }
    }

    const startCaptureSession = async (
      kind: 'recording' | 'mic_test',
      stateMode: CaptureState['mode'],
      requestedDeviceId?: string | null,
      requestedDeviceLabel?: string | null,
      liveSessionId?: string | null,
      fromFallback = false,
    ) => {
      commandGeneration += 1
      const generation = commandGeneration

      await teardownSession(activeSession)
      activeSession = null

      const resolvedDevice = await resolveRequestedDevice(requestedDeviceId, requestedDeviceLabel)
      const constraints = resolvedDevice && !resolvedDevice.is_default
        ? {
            audio: {
              deviceId: { exact: resolvedDevice.id },
              channelCount: 1,
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,
            },
          }
        : {
            audio: {
              channelCount: 1,
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,
            },
          }

      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints)
      } catch (error) {
        if (resolvedDevice && !resolvedDevice.is_default) {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              channelCount: 1,
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,
            },
          })
        } else {
          throw error
        }
      }

      const audioContext = await getSharedAudioContext({ resume: true })
      const source = audioContext.createMediaStreamSource(stream)
      const trackSettings = stream.getAudioTracks()[0]?.getSettings()
      const usedDeviceId = typeof trackSettings?.deviceId === 'string' ? trackSettings.deviceId : resolvedDevice?.id || null
      const devices = await listInputDevices()
      const matchedDevice = devices.find((device) => device.id === usedDeviceId) || resolvedDevice
      const usedDeviceLabel = matchedDevice?.label || requestedDeviceLabel || 'System default microphone'

      const session: ActiveSession = {
        kind,
        stream,
        audioContext,
        source,
        sinkNode: source,
        teardownNode: source,
        sampleRate: audioContext.sampleRate,
        chunks: [],
        totalFrames: 0,
        peak: 0,
        sumSquares: 0,
        fallbackToDefault: fromFallback,
        fallbackNotice: fromFallback ? `The selected microphone stayed silent, so ${DISPLAY_NAME} switched to the system default microphone.` : null,
        requestedDeviceId: requestedDeviceId ?? null,
        requestedDeviceLabel: requestedDeviceLabel ?? null,
        usedDeviceId: usedDeviceId ?? null,
        usedDeviceLabel,
        fallbackTimer: null,
        amplitudeResetTimer: null,
        liveFlushTimer: null,
        restartingToDefault: false,
        liveSessionId: kind === 'recording' ? (liveSessionId ?? null) : null,
        liveChunks: [],
        liveChunkBytes: 0,
      }

      const nodes = await buildCaptureNodes(
        audioContext,
        source,
        session,
        stateMode,
        generation,
      )
      session.teardownNode = nodes.teardownNode
      session.sinkNode = nodes.sinkNode
      activeSession = session

      pushState({
        is_recording: kind === 'recording',
        is_testing: kind === 'mic_test',
        mode: stateMode,
        phase: kind === 'recording' ? 'recording' : 'idle',
        amplitude: 0,
        active_device_id: session.usedDeviceId,
        active_device_label: session.usedDeviceLabel,
        fallback_to_default: session.fallbackToDefault,
        fallback_notice: session.fallbackNotice,
        error: null,
      })

      if (kind === 'recording') {
        await maybePlayRecordingCue('start')
      }

      const selectedNonDefault = Boolean(requestedDeviceId && requestedDeviceId !== 'default')
      if (selectedNonDefault && !fromFallback) {
        session.fallbackTimer = window.setTimeout(() => {
            if (!activeSession || activeSession !== session || session.restartingToDefault) return
            if (session.peak >= SILENCE_THRESHOLD) return
            session.restartingToDefault = true
          void startCaptureSession(kind, stateMode, null, 'System default microphone', session.liveSessionId, true)
        }, FALLBACK_PROBE_MS)
      }
    }

    const stopCaptureSession = async (): Promise<{
      status: 'success' | 'error'
      audio_base64?: string
      error?: string
      capture_stats?: {
        duration_ms: number
        peak: number
        rms: number
        used_device_id: string | null
        used_device_label: string | null
        fallback_to_default: boolean
        fallback_notice: string | null
      }
    }> => {
      if (!activeSession) {
        pushState(createInitialState())
        return { status: 'error', error: 'There is no active capture session.' }
      }

      const session = activeSession
      activeSession = null
      flushLiveChunks(session)
      await teardownSession(session)

      const durationMs = Math.round((session.totalFrames / session.sampleRate) * 1000)
      const rms = session.totalFrames > 0 ? Math.sqrt(session.sumSquares / session.totalFrames) : 0

      pushState({
        is_recording: false,
        is_testing: false,
        mode: null,
        phase: 'idle',
        amplitude: 0,
        active_device_id: null,
        active_device_label: null,
      })

      if (session.kind === 'recording') {
        await maybePlayRecordingCue('stop')
      }

      if (!session.totalFrames || session.peak < SILENCE_THRESHOLD) {
        const error = 'No usable audio was detected. Check the selected microphone or switch to System default.'
        pushState({
          error,
          fallback_to_default: session.fallbackToDefault,
          fallback_notice: session.fallbackNotice,
        })
        return {
          status: 'error',
          error,
          capture_stats: {
            duration_ms: durationMs,
            peak: session.peak,
            rms,
            used_device_id: session.usedDeviceId,
            used_device_label: session.usedDeviceLabel,
            fallback_to_default: session.fallbackToDefault,
            fallback_notice: session.fallbackNotice,
          },
        }
      }

      const merged = mergeChunks(session.chunks, session.totalFrames)
      const resampled = downsample(merged, session.sampleRate, CAPTURE_SAMPLE_RATE)
      const wavBytes = encodeWav(resampled, CAPTURE_SAMPLE_RATE)

      pushState({
        error: null,
        fallback_to_default: session.fallbackToDefault,
        fallback_notice: session.fallbackNotice,
      })

      return {
        status: 'success',
        audio_base64: toBase64(wavBytes),
        capture_stats: {
          duration_ms: durationMs,
          peak: session.peak,
          rms,
          used_device_id: session.usedDeviceId,
          used_device_label: session.usedDeviceLabel,
          fallback_to_default: session.fallbackToDefault,
          fallback_notice: session.fallbackNotice,
        },
      }
    }

    const handleCommand = async (command: CaptureCommand) => {
      if (isTransitioning) {
        window.captureBridge?.sendResponse(command.requestId, {
          status: 'error',
          error: 'Capture host is busy.',
        })
        return
      }

      isTransitioning = true
      try {
        switch (command.command) {
          case 'get-devices': {
            const devices = await listInputDevices()
            window.captureBridge?.sendResponse(command.requestId, devices)
            return
          }
          case 'warmup': {
            await warmupCaptureHost()
            window.captureBridge?.sendResponse(command.requestId, {
              status: 'ready',
            })
            return
          }
          case 'start-recording': {
            await startCaptureSession(
              'recording',
              command.payload?.mode ?? 'dictation',
              command.payload?.deviceId ?? null,
              command.payload?.deviceLabel ?? null,
              command.payload?.liveSessionId ?? null,
            )
            window.captureBridge?.sendResponse(command.requestId, {
              status: 'started',
              message: 'Recording started',
            })
            return
          }
          case 'stop-recording': {
            const result = await stopCaptureSession()
            window.captureBridge?.sendResponse(command.requestId, result)
            return
          }
          case 'start-mic-test': {
            await startCaptureSession('mic_test', 'mic_test', command.payload?.deviceId ?? null, command.payload?.deviceLabel ?? null)
            window.captureBridge?.sendResponse(command.requestId, {
              status: 'started',
              message: 'Microphone check started',
            })
            return
          }
          case 'stop-mic-test': {
            const result = await stopCaptureSession()
            window.captureBridge?.sendResponse(command.requestId, result)
            return
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        pushState({
          is_recording: false,
          is_testing: false,
          mode: null,
          phase: 'idle',
          amplitude: 0,
          error: message,
        })
        window.captureBridge?.sendResponse(command.requestId, {
          status: 'error',
          error: message,
        })
      } finally {
        isTransitioning = false
      }
    }

    const dispose = window.captureBridge?.onCommand((rawCommand) => {
      void handleCommand(rawCommand as CaptureCommand)
    })

    void refreshRecordingCuesEnabled()
    window.captureBridge?.notifyReady()
    window.captureBridge?.sendState(captureState)

    return () => {
      dispose?.()
      void teardownSession(activeSession)
      activeSession = null
      if (sharedAudioContext && sharedAudioContext.state !== 'closed') {
        void sharedAudioContext.close().catch(() => undefined)
      }
      sharedAudioContext = null
      audioWorkletReady = null
    }
  }, [])

  return null
}

export default CaptureHost
