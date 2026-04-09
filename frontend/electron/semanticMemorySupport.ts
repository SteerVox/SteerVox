import { DISPLAY_NAME } from '../shared/branding'

export const SEMANTIC_MEMORY_MIN_PYTHON = Object.freeze({
  major: 3,
  minor: 10,
})

export const SEMANTIC_MEMORY_PREFERRED_PYTHON_MINORS = Object.freeze([13, 12, 11])

export type SemanticMemoryPythonVersion = {
  major: number
  minor: number
  patch: number
  raw: string
}

export type SemanticMemoryRuntimeSource = 'system' | 'managed' | 'development' | 'none'
export type SemanticMemorySqliteModule = 'pysqlite3' | 'sqlite3' | 'unknown'
export type SemanticMemoryInstallErrorCode =
  | 'missing_python'
  | 'python_too_old'
  | 'python_probe_failed'
  | 'venv_creation_failed'
  | 'pip_unavailable'
  | 'package_install_failed'
  | 'sqlite_extensions_unsupported'
  | 'sqlite_vec_load_failed'
  | 'model_prepare_failed'
  | 'runtime_corrupt'
  | 'managed_runtime_download_failed'
  | 'managed_runtime_checksum_failed'
  | 'managed_runtime_extract_failed'
  | 'unknown'

export type SemanticMemoryDoctorPayload = {
  ok: boolean
  runtime_root: string
  python_version: string | null
  sqlite_module: SemanticMemorySqliteModule
  sqlite_version: string | null
  vec_version: string | null
  model: string | null
  model_cached: boolean
  error_code?: SemanticMemoryInstallErrorCode | null
  detail?: string | null
}

export function parsePythonVersion(raw: string): SemanticMemoryPythonVersion | null {
  const normalized = raw.trim()
  const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!match) return null

  return {
    major: Number.parseInt(match[1] || '', 10),
    minor: Number.parseInt(match[2] || '', 10),
    patch: Number.parseInt(match[3] || '', 10),
    raw: `${match[1]}.${match[2]}.${match[3]}`,
  }
}

export function isSemanticMemoryPythonCompatible(version: SemanticMemoryPythonVersion | null): boolean {
  if (!version) return false
  if (version.major > SEMANTIC_MEMORY_MIN_PYTHON.major) return true
  if (version.major < SEMANTIC_MEMORY_MIN_PYTHON.major) return false
  return version.minor >= SEMANTIC_MEMORY_MIN_PYTHON.minor
}

export function isPreferredSemanticMemoryPython(version: SemanticMemoryPythonVersion | null): boolean {
  return Boolean(
    version
    && version.major === SEMANTIC_MEMORY_MIN_PYTHON.major
    && SEMANTIC_MEMORY_PREFERRED_PYTHON_MINORS.includes(version.minor),
  )
}

export function buildSemanticMemoryPythonRequirementMessage(version: string | null = null): string {
  const minimum = `${SEMANTIC_MEMORY_MIN_PYTHON.major}.${SEMANTIC_MEMORY_MIN_PYTHON.minor}+`
  if (version) {
    return `Semantic retrieval needs Python ${minimum}. ${version} is too old for the current semantic runtime. ${DISPLAY_NAME} works best with Python 3.11, 3.12, or 3.13.`
  }
  return `Semantic retrieval needs Python ${minimum}. ${DISPLAY_NAME} works best with Python 3.11, 3.12, or 3.13.`
}

export function buildSemanticMemoryNoPythonMessage(): string {
  return `Semantic retrieval needs a compatible Python runtime. ${DISPLAY_NAME} can use Python 3.11, 3.12, or 3.13 from your system, or provision a managed runtime automatically if needed.`
}

export function isSemanticMemoryPythonCompatibilityFailure(detail: string): boolean {
  const normalized = detail.trim().toLowerCase()
  return normalized.includes('requires-python')
    || normalized.includes('no matching distribution found for sentence-transformers')
    || normalized.includes('could not find a version that satisfies the requirement sentence-transformers')
}

export function normalizeSemanticMemoryInstallError(detail: string, version: string | null = null): string {
  const normalized = detail.trim()
  if (!normalized) {
    return buildSemanticMemoryPythonRequirementMessage(version)
  }

  if (isSemanticMemoryPythonCompatibilityFailure(normalized)) {
    return buildSemanticMemoryPythonRequirementMessage(version)
  }

  const lower = normalized.toLowerCase()
  if (lower.includes('sqlite_extensions_unsupported') || lower.includes('enable_load_extension')) {
    return `The selected Python runtime cannot activate sqlite-vec. Repair semantic retrieval and ${DISPLAY_NAME} will rebuild it with a compatible SQLite runtime.`
  }
  if (lower.includes('sqlite_vec_load_failed') || lower.includes('vec_version')) {
    return `${DISPLAY_NAME} could not activate sqlite-vec inside the semantic runtime. Repair semantic retrieval to rebuild the runtime.`
  }
  if (lower.includes('model_prepare_failed')) {
    return 'The semantic embedding model could not be prepared. Retry the install or repair the semantic runtime.'
  }
  if (lower.includes('modulenotfounderror') || lower.includes("no module named")) {
    return 'The semantic runtime is incomplete or damaged. Repair semantic retrieval to rebuild it.'
  }
  if (lower.includes('checksum')) {
    return `${DISPLAY_NAME} downloaded a managed Python runtime, but its checksum did not match. Retry the install to fetch a clean runtime.`
  }
  if (lower.includes('extract') && lower.includes('managed')) {
    return `${DISPLAY_NAME} downloaded the managed Python runtime, but could not extract it cleanly. Retry the install to repair it.`
  }

  return normalized
}
