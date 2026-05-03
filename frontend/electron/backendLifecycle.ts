import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

import {
  BACKEND_EXECUTABLE_NAME,
  BACKEND_PORT_ENV_VAR,
  BACKEND_RESOURCE_DIR_NAME,
  EXPERIMENTAL_MEDIA_DEFAULT_ENV_VAR,
} from '../shared/branding'
import { LOCAL_BACKEND_TOKEN_ENV_VAR } from '../shared/localBackendAuth'
import {
  SYSTEM_CONTROL_HELPER_BINARY_NAME,
  SYSTEM_CONTROL_HELPER_ENV_VAR,
} from '../shared/systemControlHelper'
import { createBackendClient } from './backendClient'

const FFMPEG_BIN_DIR_ENV_VAR = 'STEERVOX_FFMPEG_BIN_DIR'

export type BackendBootState = {
  phase: 'booting_backend' | 'ready' | 'error'
  label: string
  detail: string
  progress: number | null
}

export type BackendConfig = {
  stt: {
    provider: string
  }
  audio: {
    input_device: string | null
    input_device_id: string | null
    input_device_label: string | null
    enable_recording_cues?: boolean
    live_transcription_mode?: 'off' | 'auto' | 'local_only' | 'provider_only'
  }
  vision?: {
    enabled?: boolean
  }
}

type BackendStatusSummary = {
  is_processing: boolean
}

type BackendLifecycleOptions = {
  appRoot: string
  isPackaged: boolean
  resourcesPath: string
  setBootState: (state: BackendBootState) => void
  getBootState: () => BackendBootState
  onReady: () => void
  onUnexpectedExit: (detail: string) => void
  log: (message: string) => void
  preparingDisplayName: string
  startingDisplayName: string
  readyDetail: string
  couldNotStartDetail: string
  couldNotFinishStartingDetail: string
  stoppedUnexpectedlyDetail: string
}

function issueBackendAuthToken() {
  return randomBytes(32).toString('base64url')
}

function waitForChildExit(child: ChildProcess, timeoutMs: number) {
  return new Promise<boolean>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true)
      return
    }

    let settled = false
    const finish = (exited: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.removeListener('exit', onExit)
      resolve(exited)
    }
    const onExit = () => finish(true)
    const timer = setTimeout(() => finish(false), timeoutMs)

    child.once('exit', onExit)
  })
}

function allocateFreeLoopbackPort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate a loopback port.')))
        return
      }

      const port = address.port
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve(port)
      })
    })
  })
}

export function createBackendLifecycleService(options: BackendLifecycleOptions) {
  let pythonProcess: ChildProcess | null = null
  let backendProbeTimer: NodeJS.Timeout | null = null
  let backendPort: number | null = null
  let backendBaseUrl = ''
  let backendAuthToken = issueBackendAuthToken()
  let backendShutdownExpected = false
  let cachedBackendConfig: { value: BackendConfig; cachedAt: number } | null = null

  const client = createBackendClient({
    getBaseUrl: () => backendBaseUrl,
    getAuthToken: () => backendAuthToken,
  })

  function getSystemControlHelperPath() {
    if (options.isPackaged) {
      return path.join(options.resourcesPath, SYSTEM_CONTROL_HELPER_BINARY_NAME, SYSTEM_CONTROL_HELPER_BINARY_NAME)
    }
    return path.join(options.appRoot, 'native', 'bin', SYSTEM_CONTROL_HELPER_BINARY_NAME)
  }

  function getBundledFfmpegBinDir() {
    if (options.isPackaged) {
      return path.join(options.resourcesPath, 'ffmpeg', 'bin')
    }
    return path.join(options.appRoot, 'build', 'ffmpeg-runtime', 'bin')
  }

  function buildBackendEnvironment(port: number) {
    const bundledFfmpegBinDir = getBundledFfmpegBinDir()
    const currentPath = process.env.PATH || ''
    const nextPath = bundledFfmpegBinDir
      ? `${bundledFfmpegBinDir}${currentPath ? `${path.delimiter}${currentPath}` : ''}`
      : currentPath

    return {
      ...process.env,
      PATH: nextPath,
      [BACKEND_PORT_ENV_VAR]: String(port),
      [LOCAL_BACKEND_TOKEN_ENV_VAR]: backendAuthToken,
      [SYSTEM_CONTROL_HELPER_ENV_VAR]: getSystemControlHelperPath(),
      [EXPERIMENTAL_MEDIA_DEFAULT_ENV_VAR]: options.isPackaged ? '0' : '1',
      ...(bundledFfmpegBinDir ? { [FFMPEG_BIN_DIR_ENV_VAR]: bundledFfmpegBinDir } : {}),
    }
  }

  function clearProbeTimer() {
    if (backendProbeTimer) {
      clearTimeout(backendProbeTimer)
      backendProbeTimer = null
    }
  }

  async function ensureBackendPort() {
    if (backendPort !== null) return backendPort

    const requestedPort = Number.parseInt(process.env[BACKEND_PORT_ENV_VAR] || '', 10)
    backendPort = Number.isFinite(requestedPort) && requestedPort > 0
      ? requestedPort
      : await allocateFreeLoopbackPort()
    backendBaseUrl = `http://127.0.0.1:${backendPort}`
    return backendPort
  }

  function hasPinnedBackendPort() {
    const requestedPort = Number.parseInt(process.env[BACKEND_PORT_ENV_VAR] || '', 10)
    return Number.isFinite(requestedPort) && requestedPort > 0
  }

  async function rotateBackendPort() {
    backendPort = await allocateFreeLoopbackPort()
    backendBaseUrl = `http://127.0.0.1:${backendPort}`
    return backendPort
  }

  async function canReuseRunningBackend() {
    const healthy = await client.checkHealth()
    if (!healthy) {
      return false
    }

    return client.canReadAuthenticatedStatus()
  }

  function scheduleReadyProbe(attempt = 0) {
    clearProbeTimer()
    backendProbeTimer = setTimeout(async () => {
      const ready = await canReuseRunningBackend()
      if (ready) {
        options.setBootState({
          phase: 'ready',
          label: 'Ready',
          detail: options.readyDetail,
          progress: 100,
        })
        backendProbeTimer = null
        options.onReady()
        return
      }

      if (attempt >= 20) {
        options.setBootState({
          phase: 'error',
          label: 'Unavailable',
          detail: options.couldNotFinishStartingDetail,
          progress: null,
        })
        backendProbeTimer = null
        return
      }

      options.setBootState({
        phase: 'booting_backend',
        label: options.startingDisplayName,
        detail: 'Getting things ready.',
        progress: Math.min(92, 62 + (attempt * 2)),
      })
      scheduleReadyProbe(attempt + 1)
    }, attempt === 0 ? 250 : 700)
  }

  async function start() {
    cachedBackendConfig = null
    backendAuthToken = issueBackendAuthToken()
    let port = await ensureBackendPort()

    options.setBootState({
      phase: 'booting_backend',
      label: options.preparingDisplayName,
      detail: 'Getting things ready.',
      progress: 18,
    })

    const alreadyRunning = await client.checkHealth()
    if (alreadyRunning) {
      if (await client.canReadAuthenticatedStatus()) {
        options.setBootState({
          phase: 'ready',
          label: 'Ready',
          detail: options.readyDetail,
          progress: 100,
        })
        options.onReady()
        return
      }

      if (hasPinnedBackendPort()) {
        options.log(`Refusing to reuse an unauthenticated backend on pinned port ${port}.`)
        options.setBootState({
          phase: 'error',
          label: 'Unavailable',
          detail: 'Another local process is using the configured backend port.',
          progress: null,
        })
        return
      }

      options.log(`Loopback port ${port} is already in use by a different backend instance. Rotating to a fresh port.`)
      port = await rotateBackendPort()
    }

    options.log('Starting/Checking Python backend...')
    options.setBootState({
      phase: 'booting_backend',
      label: options.startingDisplayName,
      detail: 'Loading providers and settings.',
      progress: 42,
    })

    if (options.isPackaged) {
      const backendDir = path.join(options.resourcesPath, BACKEND_RESOURCE_DIR_NAME)
      const executablePath = path.join(backendDir, BACKEND_EXECUTABLE_NAME)
      options.log(`Packaged Mode: Spawning engine from ${executablePath} on ${backendBaseUrl}`)
      pythonProcess = spawn(executablePath, ['--port', String(port)], {
        cwd: backendDir,
        env: buildBackendEnvironment(port),
        stdio: 'pipe',
      })
    } else {
      const pythonPath = path.join(options.appRoot, '..', 'backend', '.venv', 'bin', 'python3')
      const scriptPath = path.join(options.appRoot, '..', 'backend', 'server.py')
      options.log(`Dev Mode: Spawning backend from ${scriptPath} on ${backendBaseUrl}`)
      pythonProcess = spawn(pythonPath, [scriptPath, '--port', String(port)], {
        cwd: path.join(options.appRoot, '..', 'backend'),
        env: buildBackendEnvironment(port),
        stdio: 'pipe',
      })
    }

    backendShutdownExpected = false

    const child = pythonProcess
    child.stdout?.on('data', (chunk) => options.log(`[Backend stdout] ${chunk.toString()}`))
    child.stderr?.on('data', (chunk) => options.log(`[Backend stderr] ${chunk.toString()}`))

    child.on('error', (error) => {
      options.log(`Failed to start python backend: ${error.message}`)
      options.setBootState({
        phase: 'error',
        label: 'Unavailable',
        detail: options.couldNotStartDetail,
        progress: null,
      })
    })

    child.on('exit', (code) => {
      options.log(`Python backend exited with code ${code}`)
      if (child !== pythonProcess) {
        return
      }

      if (!backendShutdownExpected) {
        options.onUnexpectedExit(options.stoppedUnexpectedlyDetail)
      }
      pythonProcess = null
    })

    options.setBootState({
      phase: 'booting_backend',
      label: options.startingDisplayName,
      detail: 'Getting things ready.',
      progress: 64,
    })
    scheduleReadyProbe()
  }

  async function stop() {
    const child = pythonProcess
    if (!child) {
      return
    }

    backendShutdownExpected = true

    try {
      child.kill('SIGTERM')
    } catch {
      options.log('Failed to send SIGTERM to the backend process.')
    }

    let exited = await waitForChildExit(child, 2000)
    if (!exited) {
      try {
        child.kill('SIGKILL')
      } catch {
        options.log('SIGKILL fallback failed while stopping the backend.')
      }
      exited = await waitForChildExit(child, 1200)
      if (!exited) {
        options.log('Backend process did not exit cleanly after SIGTERM/SIGKILL.')
      }
    }

    if (pythonProcess === child) {
      pythonProcess = null
    }
  }

  async function restart() {
    await stop()
    await start()
  }

  async function getConfig() {
    return client.getJson<BackendConfig>('/config')
  }

  async function getCachedConfig() {
    if (cachedBackendConfig && (Date.now() - cachedBackendConfig.cachedAt) < 15000) {
      return cachedBackendConfig.value
    }

    const config = await getConfig()
    cachedBackendConfig = {
      value: config,
      cachedAt: Date.now(),
    }
    return config
  }

  async function getStatus() {
    return client.getJson<BackendStatusSummary>('/status')
  }

  async function ensureReadyForInteraction() {
    if (options.getBootState().phase !== 'ready') {
      throw new Error('Backend unavailable. Restart the backend and try again.')
    }

    const healthy = await client.checkHealth()
    const authenticated = healthy ? await client.canReadAuthenticatedStatus() : false
    if (!healthy || !authenticated) {
      options.onUnexpectedExit(options.stoppedUnexpectedlyDetail)
      throw new Error('Backend unavailable. Restart the backend and try again.')
    }
  }

  function dispose() {
    clearProbeTimer()
  }

  return {
    client,
    getBaseUrl: () => backendBaseUrl,
    getRequestContext: () => client.getRequestContext(),
    getBootState: options.getBootState,
    getConfig,
    getCachedConfig,
    getStatus,
    ensureReadyForInteraction,
    start,
    stop,
    restart,
    dispose,
  }
}
