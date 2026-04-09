import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const frontendRoot = path.resolve(__dirname, '..')
const projectRoot = path.resolve(frontendRoot, '..')
const backendPythonPath = path.join(projectRoot, 'backend', '.venv', 'bin', 'python3')
const backendServerPath = path.join(projectRoot, 'backend', 'server.py')

function run(command, args, label, cwd = frontendRoot) {
  return new Promise((resolve, reject) => {
    console.log(`[prepare-dev] ${label}`)
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
    })

    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`${label} failed with exit code ${code ?? 'unknown'}.`))
    })
  })
}

async function fileExists(targetPath, mode = fsConstants.F_OK) {
  try {
    await fs.access(targetPath, mode)
    return true
  } catch {
    return false
  }
}

async function ensureBackendDevRuntime() {
  const pythonReady = await fileExists(backendPythonPath, fsConstants.X_OK)
  if (!pythonReady) {
    throw new Error(
      `Backend virtualenv is missing at ${backendPythonPath}. Create backend/.venv before running npm run dev.`,
    )
  }

  const serverReady = await fileExists(backendServerPath, fsConstants.R_OK)
  if (!serverReady) {
    throw new Error(`Backend entrypoint is missing at ${backendServerPath}.`)
  }
}

async function ensureMacAssets() {
  try {
    await run('bash', ['../scripts/validate-mac-assets.sh'], 'Validating macOS assets')
  } catch {
    await run('bash', ['../scripts/prepare-mac-assets.sh'], 'Refreshing macOS assets')
    await run('bash', ['../scripts/validate-mac-assets.sh'], 'Re-validating macOS assets')
  }
}

async function main() {
  await run('node', ['../scripts/sync-branding.mjs'], 'Syncing branding files')
  await ensureMacAssets()
  await run('node', ['scripts/build-local-speech-helper.mjs'], 'Building local speech helper')
  await run('node', ['scripts/build-system-control-helper.mjs'], 'Building system control helper')
  await ensureBackendDevRuntime()
  console.log('[prepare-dev] Development prerequisites are ready.')
}

main().catch((error) => {
  console.error(`[prepare-dev] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
