import fs from 'node:fs/promises'

import {
  BACKEND_BRANDING_MODULE_PATH,
  BRANDING_ENV_PATH,
  FRONTEND_BRANDING_MODULE_PATH,
  readBrandingManifest,
  renderBackendBrandingModule,
  renderBrandingEnv,
  renderFrontendBrandingModule,
  validateBrandingState,
} from './branding-lib.mjs'

async function validateGeneratedFile(targetPath, expectedContent) {
  const current = await fs.readFile(targetPath, 'utf8')
  if (current !== expectedContent) {
    throw new Error(`${targetPath} is out of sync with branding/identity.json. Run node scripts/sync-branding.mjs.`)
  }
}

async function main() {
  const manifest = await readBrandingManifest()

  await validateGeneratedFile(FRONTEND_BRANDING_MODULE_PATH, renderFrontendBrandingModule(manifest))
  await validateGeneratedFile(BACKEND_BRANDING_MODULE_PATH, renderBackendBrandingModule(manifest))
  await validateGeneratedFile(BRANDING_ENV_PATH, renderBrandingEnv(manifest))
  await validateBrandingState(manifest)

  console.log('Branding validation passed')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
