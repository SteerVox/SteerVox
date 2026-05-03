import path from 'node:path'
import { notarize } from '@electron/notarize'

function hasNotaryCredentials() {
  return Boolean(
    process.env.APPLE_ID
    && process.env.APPLE_APP_SPECIFIC_PASSWORD
    && process.env.APPLE_TEAM_ID
  )
}

export default async function notarizeApp(context) {
  if (context.electronPlatformName !== 'darwin') return

  const releaseChannel = process.env.STEERVOX_RELEASE_CHANNEL || 'development'

  if (releaseChannel === 'public-beta') {
    console.log('[afterSign] Public beta channel detected. Skipping notarization by design for the website-distributed unsigned beta.')
    return
  }

  if (!hasNotaryCredentials()) {
    if (releaseChannel === 'signed') {
      throw new Error('Signed macOS release requested but notarization credentials are missing.')
    }
    console.log('[afterSign] Development packaging detected without notarization credentials. Skipping notarization.')
    return
  }

  const appName = context.packager.appInfo.productFilename
  const appPath = path.join(context.appOutDir, `${appName}.app`)

  console.log(`[afterSign] Notarizing ${appPath}`)
  await notarize({
    appBundleId: context.packager.appInfo.id,
    appPath,
    appleId: process.env.APPLE_ID,
    appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
    teamId: process.env.APPLE_TEAM_ID,
  })
}
