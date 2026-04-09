import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import { readBrandingManifest } from '../../scripts/branding-lib.mjs'

const execFileAsync = promisify(execFile)

function getSigningIdentity() {
  return process.env.APPLE_SIGNING_IDENTITY || process.env.CSC_NAME || '-'
}

function isAdHocIdentity(identity) {
  return identity === '-'
}

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const files = await Promise.all(entries.map(async (entry) => {
    const resolved = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      return walk(resolved)
    }
    return [resolved]
  }))
  return files.flat()
}

async function isMachOBinary(targetPath) {
  try {
    const { stdout } = await execFileAsync('file', ['-b', targetPath])
    return stdout.includes('Mach-O')
  } catch {
    return false
  }
}

async function signTarget(targetPath, identity) {
  const args = ['--force']
  if (!isAdHocIdentity(identity)) {
    args.push('--timestamp', '--options', 'runtime')
  }
  args.push('--sign', identity, targetPath)
  await execFileAsync('codesign', args)
}

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  const manifest = await readBrandingManifest()
  const localSpeechHelperBinaryName = `${manifest.runtime.slug}-local-speech-helper`
  const systemControlHelperBinaryName = `${manifest.runtime.slug}-system-control-helper`
  const identity = getSigningIdentity()
  if (isAdHocIdentity(identity)) {
    console.log('[afterPack] No signing identity configured. Using ad-hoc signatures for bundled backend binaries.')
  }

  const appBundlePath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const resourceRoots = [
    path.join(appBundlePath, 'Contents', 'Resources', manifest.runtime.backendResourceDirName),
    path.join(appBundlePath, 'Contents', 'Resources', 'ffmpeg'),
    path.join(appBundlePath, 'Contents', 'Resources', localSpeechHelperBinaryName),
    path.join(appBundlePath, 'Contents', 'Resources', systemControlHelperBinaryName),
  ]

  const files = []
  for (const root of resourceRoots) {
    try {
      await fs.access(root)
    } catch {
      continue
    }
    files.push(...await walk(root))
  }

  if (files.length === 0) {
    console.log('[afterPack] No bundled helper or backend binaries found to sign.')
    return
  }
  const signableFiles = []
  for (const filePath of files) {
    if (await isMachOBinary(filePath)) {
      signableFiles.push(filePath)
    }
  }

  signableFiles.sort((left, right) => right.length - left.length)

  for (const filePath of signableFiles) {
    console.log(`[afterPack] Signing ${filePath}`)
    await signTarget(filePath, identity)
  }
}
