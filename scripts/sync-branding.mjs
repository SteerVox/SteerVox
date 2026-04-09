import fs from 'node:fs/promises'
import path from 'node:path'

import {
  BACKEND_BRANDING_MODULE_PATH,
  BRANDING_ENV_PATH,
  FRONTEND_BRANDING_MODULE_PATH,
  readBrandingManifest,
  renderBackendBrandingModule,
  renderBrandingEnv,
  renderFrontendBrandingModule,
  syncFrontendIndexHtml,
  syncFrontendPackageJson,
} from './branding-lib.mjs'

async function ensureParentDir(targetPath) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true })
}

async function main() {
  const manifest = await readBrandingManifest()

  await ensureParentDir(FRONTEND_BRANDING_MODULE_PATH)
  await ensureParentDir(BACKEND_BRANDING_MODULE_PATH)
  await ensureParentDir(BRANDING_ENV_PATH)

  await fs.writeFile(FRONTEND_BRANDING_MODULE_PATH, renderFrontendBrandingModule(manifest))
  await fs.writeFile(BACKEND_BRANDING_MODULE_PATH, renderBackendBrandingModule(manifest))
  await fs.writeFile(BRANDING_ENV_PATH, renderBrandingEnv(manifest))

  await syncFrontendPackageJson(manifest)
  await syncFrontendIndexHtml(manifest)

  console.log('Branding files synced from branding/identity.json')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
