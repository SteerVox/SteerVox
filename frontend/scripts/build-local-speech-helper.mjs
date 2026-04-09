import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { readBrandingManifest } from '../../scripts/branding-lib.mjs'

const execFileAsync = promisify(execFile)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const frontendRoot = path.resolve(__dirname, '..')
const outputDir = path.join(frontendRoot, 'native', 'bin')

async function fileIsUpToDate(source, output) {
  try {
    const [sourceStats, outputStats] = await Promise.all([
      fs.stat(source),
      fs.stat(output),
    ])
    return outputStats.mtimeMs >= sourceStats.mtimeMs
  } catch {
    return false
  }
}

async function removeStaleHelperBinaries(suffix, keepFileName) {
  let entries = []
  try {
    entries = await fs.readdir(outputDir)
  } catch {
    return
  }

  await Promise.all(entries
    .filter((entry) => entry.endsWith(suffix) && entry !== keepFileName)
    .map((entry) => fs.rm(path.join(outputDir, entry), { force: true })))
}

async function main() {
  const manifest = await readBrandingManifest()
  const helperSourceFileName = `${manifest.displayName.replace(/\s+/g, '')}SpeechHelper.swift`
  const helperBinaryName = `${manifest.runtime.slug}-local-speech-helper`
  const moduleCachePrefix = `${manifest.runtime.protocolScheme}-speech-helper-cache-`
  const sourcePath = path.join(frontendRoot, 'native', helperSourceFileName)
  const outputPath = path.join(outputDir, helperBinaryName)
  await fs.mkdir(outputDir, { recursive: true })
  await removeStaleHelperBinaries('-local-speech-helper', helperBinaryName)
  if (await fileIsUpToDate(sourcePath, outputPath)) {
    console.log(`[build-local-speech-helper] Reusing ${outputPath}`)
    return
  }

  const moduleCachePath = await fs.mkdtemp(path.join(os.tmpdir(), moduleCachePrefix))
  console.log(`[build-local-speech-helper] Compiling ${sourcePath}`)
  try {
    await execFileAsync('xcrun', [
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
    ], {
      cwd: frontendRoot,
    })
    await fs.chmod(outputPath, 0o755)
    console.log(`[build-local-speech-helper] Built ${outputPath}`)
  } finally {
    await fs.rm(moduleCachePath, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(`[build-local-speech-helper] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
