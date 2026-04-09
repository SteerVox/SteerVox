import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const frontendRoot = path.resolve(__dirname, '..')
const runtimeRoot = path.join(frontendRoot, 'build', 'ffmpeg-runtime')
const runtimeBinDir = path.join(runtimeRoot, 'bin')
const runtimeLicensesDir = path.join(runtimeRoot, 'licenses')

function resolvePackageRoot(packageName) {
  const packageJsonPath = require.resolve(`${packageName}/package.json`)
  return path.dirname(packageJsonPath)
}

async function ensureExecutable(targetPath) {
  await fs.chmod(targetPath, 0o755)
  await fs.access(targetPath, fsConstants.X_OK)
}

async function copyFile(sourcePath, targetPath) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true })
  await fs.copyFile(sourcePath, targetPath)
}

async function main() {
  const ffmpegBinaryPath = require('ffmpeg-static')
  const ffprobeBinaryPath = require('ffprobe-static').path
  if (!ffmpegBinaryPath || !ffprobeBinaryPath) {
    throw new Error('ffmpeg-static or ffprobe-static did not expose a usable binary path.')
  }

  const ffmpegRoot = resolvePackageRoot('ffmpeg-static')
  const ffprobeRoot = resolvePackageRoot('ffprobe-static')

  await fs.rm(runtimeRoot, { recursive: true, force: true })
  await fs.mkdir(runtimeBinDir, { recursive: true })
  await fs.mkdir(runtimeLicensesDir, { recursive: true })

  await copyFile(ffmpegBinaryPath, path.join(runtimeBinDir, 'ffmpeg'))
  await copyFile(ffprobeBinaryPath, path.join(runtimeBinDir, 'ffprobe'))

  await ensureExecutable(path.join(runtimeBinDir, 'ffmpeg'))
  await ensureExecutable(path.join(runtimeBinDir, 'ffprobe'))

  await copyFile(path.join(ffmpegRoot, 'ffmpeg.LICENSE'), path.join(runtimeLicensesDir, 'ffmpeg.LICENSE.txt'))
  await copyFile(path.join(ffmpegRoot, 'ffmpeg.README'), path.join(runtimeLicensesDir, 'ffmpeg.README.txt'))
  await copyFile(path.join(ffprobeRoot, 'LICENSE'), path.join(runtimeLicensesDir, 'ffprobe.LICENSE.txt'))
  await copyFile(path.join(ffprobeRoot, 'README.md'), path.join(runtimeLicensesDir, 'ffprobe.README.md'))

  console.log(`[prepare-ffmpeg-runtime] Prepared runtime in ${runtimeRoot}`)
}

main().catch((error) => {
  console.error(`[prepare-ffmpeg-runtime] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
