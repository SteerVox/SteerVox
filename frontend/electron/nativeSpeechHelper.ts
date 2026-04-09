import { execFile, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import { DISPLAY_NAME, LOCAL_SPEECH_HELPER_BINARY_NAME } from '../shared/branding'

const execFileAsync = promisify(execFile)
const HELPER_BINARY_NAME = LOCAL_SPEECH_HELPER_BINARY_NAME
const HELPER_SOURCE_FILE_NAME = `${DISPLAY_NAME.replace(/\s+/g, '')}SpeechHelper.swift`
const START_TIMEOUT_MS = 5000
const STOP_TIMEOUT_MS = 1800

export type NativeSpeechMode = 'dictation' | 'smart_transform'

export type NativeSpeechEvent =
  | {
      event: 'partial' | 'final'
      sessionId: string
      text: string
    }
  | {
      event: 'started' | 'stopped'
      sessionId: string
    }
  | {
      event: 'permission'
      sessionId?: string
      status: 'authorized' | 'denied' | 'restricted' | 'not_determined' | 'unavailable'
      detail?: string | null
    }
  | {
      event: 'error'
      sessionId?: string
      error: string
    }

type PendingRequest = {
  resolve: () => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

type NativeSpeechHelperOptions = {
  appRoot: string
  appHomePath: string
  isPackaged: boolean
  resourcesPath?: string
  log: (message: string) => void
  onEvent: (event: NativeSpeechEvent) => void
}

export class NativeSpeechHelperManager {
  private readonly options: NativeSpeechHelperOptions
  private process: ChildProcess | null = null
  private stdoutBuffer = ''
  private activeSessionId: string | null = null
  private pendingStarts = new Map<string, PendingRequest>()
  private pendingStops = new Map<string, PendingRequest>()

  constructor(options: NativeSpeechHelperOptions) {
    this.options = options
  }

  async prewarm() {
    await this.ensureBinaryPath()
  }

  async startSession(sessionId: string, mode: NativeSpeechMode) {
    await this.ensureProcess()
    await this.sendCommand({
      command: 'start',
      sessionId,
      mode,
    })

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingStarts.delete(sessionId)
        reject(new Error('Speech recognition did not start in time.'))
      }, START_TIMEOUT_MS)
      this.pendingStarts.set(sessionId, { resolve, reject, timer })
    })
    this.activeSessionId = sessionId
  }

  async appendChunk(sessionId: string, sampleRate: number, pcmS16leBase64: string) {
    if (!this.process || this.activeSessionId !== sessionId) {
      return
    }

    await this.sendCommand({
      command: 'appendChunk',
      sessionId,
      sampleRate,
      pcmS16leBase64,
    })
  }

  async stopSession(sessionId: string) {
    if (!this.process || this.activeSessionId !== sessionId) {
      return
    }

    await this.sendCommand({
      command: 'stop',
      sessionId,
    })

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingStops.delete(sessionId)
        resolve()
      }, STOP_TIMEOUT_MS)
      this.pendingStops.set(sessionId, { resolve, reject, timer })
    })

    if (this.activeSessionId === sessionId) {
      this.activeSessionId = null
    }
  }

  async cancelSession(sessionId: string) {
    if (!this.process || this.activeSessionId !== sessionId) {
      return
    }
    try {
      await this.sendCommand({
        command: 'cancel',
        sessionId,
      })
    } finally {
      if (this.activeSessionId === sessionId) {
        this.activeSessionId = null
      }
    }
  }

  dispose() {
    for (const pending of this.pendingStarts.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Speech helper stopped.'))
    }
    for (const pending of this.pendingStops.values()) {
      clearTimeout(pending.timer)
      pending.resolve()
    }
    this.pendingStarts.clear()
    this.pendingStops.clear()
    this.activeSessionId = null

    if (this.process) {
      this.process.removeAllListeners()
      this.process.stdout?.removeAllListeners()
      this.process.stderr?.removeAllListeners()
      this.process.kill('SIGTERM')
      this.process = null
    }
  }

  private async ensureProcess() {
    if (this.process && this.process.exitCode === null && this.process.signalCode === null) {
      return
    }

    const binaryPath = await this.ensureBinaryPath()
    this.stdoutBuffer = ''

    const child = spawn(binaryPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.process = child

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      this.handleStdout(chunk)
    })

    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      this.options.log(`[LocalSpeechHelper stderr] ${chunk.trimEnd()}`)
    })

    child.on('exit', (code, signal) => {
      const detail = `Local speech helper exited unexpectedly (code=${String(code)}, signal=${String(signal)}).`
      this.options.log(detail)
      this.handleProcessFailure(new Error(detail))
    })

    child.on('error', (error) => {
      const detail = `Local speech helper failed: ${error.message}`
      this.options.log(detail)
      this.handleProcessFailure(new Error(detail))
    })
  }

  private handleProcessFailure(error: Error) {
    const sessionId = this.activeSessionId
    this.process = null
    this.activeSessionId = null

    for (const pending of this.pendingStarts.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    for (const pending of this.pendingStops.values()) {
      clearTimeout(pending.timer)
      pending.resolve()
    }
    this.pendingStarts.clear()
    this.pendingStops.clear()

    this.options.onEvent({
      event: 'error',
      sessionId: sessionId || undefined,
      error: error.message,
    })
  }

  private handleStdout(chunk: string) {
    this.stdoutBuffer += chunk
    while (true) {
      const newlineIndex = this.stdoutBuffer.indexOf('\n')
      if (newlineIndex < 0) {
        return
      }

      const line = this.stdoutBuffer.slice(0, newlineIndex).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1)
      if (!line) {
        continue
      }

      let parsed: NativeSpeechEvent
      try {
        parsed = JSON.parse(line) as NativeSpeechEvent
      } catch (error) {
        this.options.log(`Local speech helper emitted invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }

      if (parsed.event === 'started' && parsed.sessionId) {
        const pending = this.pendingStarts.get(parsed.sessionId)
        if (pending) {
          clearTimeout(pending.timer)
          this.pendingStarts.delete(parsed.sessionId)
          pending.resolve()
        }
      }

      if (parsed.event === 'stopped' && parsed.sessionId) {
        const pending = this.pendingStops.get(parsed.sessionId)
        if (pending) {
          clearTimeout(pending.timer)
          this.pendingStops.delete(parsed.sessionId)
          pending.resolve()
        }
      }

      if (parsed.event === 'error') {
        const targetSessionId = parsed.sessionId || this.activeSessionId
        if (targetSessionId) {
          const pendingStart = this.pendingStarts.get(targetSessionId)
          if (pendingStart) {
            clearTimeout(pendingStart.timer)
            this.pendingStarts.delete(targetSessionId)
            pendingStart.reject(new Error(parsed.error))
          }
          const pendingStop = this.pendingStops.get(targetSessionId)
          if (pendingStop) {
            clearTimeout(pendingStop.timer)
            this.pendingStops.delete(targetSessionId)
            pendingStop.resolve()
          }
        }
      }

      this.options.onEvent(parsed)
    }
  }

  private async sendCommand(command: Record<string, unknown>) {
    if (!this.process?.stdin || this.process.stdin.destroyed) {
      throw new Error('Local speech helper is unavailable.')
    }

    await new Promise<void>((resolve, reject) => {
      this.process?.stdin?.write(`${JSON.stringify(command)}\n`, (error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })
  }

  private async ensureBinaryPath() {
    const bundledBinaryPath = this.getBundledBinaryPath()
    if (bundledBinaryPath) {
      return bundledBinaryPath
    }
    return this.compileDevelopmentBinary()
  }

  private getBundledBinaryPath() {
    if (!this.options.isPackaged || !this.options.resourcesPath) {
      return null
    }
    const candidate = path.join(this.options.resourcesPath, HELPER_BINARY_NAME, HELPER_BINARY_NAME)
    return fs.existsSync(candidate) ? candidate : null
  }

  private async compileDevelopmentBinary() {
    const sourcePath = path.join(this.options.appRoot, 'native', HELPER_SOURCE_FILE_NAME)
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Local speech helper source is missing at ${sourcePath}.`)
    }

    const outputDir = path.join(this.options.appHomePath, 'bin')
    const outputPath = path.join(outputDir, HELPER_BINARY_NAME)
    const moduleCachePath = path.join(outputDir, '.swift-module-cache')
    await fsp.mkdir(outputDir, { recursive: true })
    await fsp.mkdir(moduleCachePath, { recursive: true })

    const [sourceStats, outputStats] = await Promise.all([
      fsp.stat(sourcePath),
      fsp.stat(outputPath).catch(() => null),
    ])

    if (!outputStats || outputStats.mtimeMs < sourceStats.mtimeMs) {
      this.options.log(`Compiling local speech helper from ${sourcePath}`)
      const compileArgs = [
        'swiftc',
        sourcePath,
        '-parse-as-library',
        '-o',
        outputPath,
        '-module-cache-path',
        moduleCachePath,
        '-framework',
        'Speech',
        '-framework',
        'AVFoundation',
      ]
      try {
        await execFileAsync('xcrun', compileArgs, {
          cwd: path.dirname(sourcePath),
        })
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(`Failed to build the local speech helper: ${detail}`)
      }
      await fsp.chmod(outputPath, 0o755)
    }

    return outputPath
  }
}
