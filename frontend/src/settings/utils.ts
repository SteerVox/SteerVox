import type { AppDomainDefault, AppSkillDefault, SensitiveTargetRule, SmartContext } from '../types'

export function normalizeAppName(value: string | null | undefined) {
  if (!value) return ''
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}

export function normalizeHost(value: string | null | undefined) {
  if (!value) return ''
  return value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '').split('/')[0] || ''
}

export function hostMatches(ruleHost: string | null | undefined, contextHost: string | null | undefined) {
  const normalizedRuleHost = normalizeHost(ruleHost)
  const normalizedContextHost = normalizeHost(contextHost)
  if (!normalizedRuleHost || !normalizedContextHost) return false
  return normalizedContextHost === normalizedRuleHost || normalizedContextHost.endsWith(`.${normalizedRuleHost}`)
}

export function createAppSkillDefaultId(appName: string) {
  const slug = normalizeAppName(appName).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'app'
  const randomId = globalThis.crypto?.randomUUID?.()
  const suffix = randomId ? randomId.slice(0, 8) : Math.random().toString(36).slice(2, 10)
  return `${slug}_${suffix}`
}

export function createAppDomainDefaultId(appName: string) {
  const slug = normalizeAppName(appName).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'domain'
  const randomId = globalThis.crypto?.randomUUID?.()
  const suffix = randomId ? randomId.slice(0, 8) : Math.random().toString(36).slice(2, 10)
  return `${slug}_${suffix}`
}

export function buildAppDomainLabel(appName: string, urlHost?: string | null) {
  const normalizedAppName = appName.trim() || 'Manual target'
  const normalizedHost = normalizeHost(urlHost)
  return normalizedHost ? `${normalizedAppName} • ${normalizedHost}` : normalizedAppName
}

export function createManualAppDomainDefault(): AppDomainDefault {
  return {
    id: createAppDomainDefaultId('manual'),
    app_label: 'Manual target',
    bundle_id: null,
    url_host: null,
    app_name: '',
    domain_id: 'shipping',
    enabled: true,
  }
}

export function createSensitiveTargetRuleId(appName: string) {
  const slug = normalizeAppName(appName).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'privacy'
  const randomId = globalThis.crypto?.randomUUID?.()
  const suffix = randomId ? randomId.slice(0, 8) : Math.random().toString(36).slice(2, 10)
  return `${slug}_${suffix}`
}

export function findMatchingAppSkillDefaultIndex(appSkillDefaults: AppSkillDefault[], context: SmartContext) {
  const bundleId = context.bundle_id?.trim() || null
  if (bundleId) {
    const bundleMatchIndex = appSkillDefaults.findIndex((rule) => rule.bundle_id === bundleId)
    if (bundleMatchIndex >= 0) return bundleMatchIndex
  }

  const urlHost = context.url_host?.trim() || null
  if (urlHost) {
    const hostMatchIndex = appSkillDefaults.findIndex((rule) => hostMatches(rule.url_host, urlHost))
    if (hostMatchIndex >= 0) return hostMatchIndex
  }

  const normalizedAppName = normalizeAppName(context.app_name)
  if (!normalizedAppName) return -1

  return appSkillDefaults.findIndex((rule) => !rule.bundle_id && !rule.url_host && normalizeAppName(rule.app_name) === normalizedAppName)
}

export function findMatchingAppDomainDefaultIndex(appDomainDefaults: AppDomainDefault[], context: SmartContext) {
  const bundleId = context.bundle_id?.trim() || null
  if (bundleId) {
    const bundleMatchIndex = appDomainDefaults.findIndex((rule) => rule.bundle_id === bundleId)
    if (bundleMatchIndex >= 0) return bundleMatchIndex
  }

  const urlHost = context.url_host?.trim() || null
  if (urlHost) {
    const hostMatchIndex = appDomainDefaults.findIndex((rule) => hostMatches(rule.url_host, urlHost))
    if (hostMatchIndex >= 0) return hostMatchIndex
  }

  const normalizedAppName = normalizeAppName(context.app_name)
  if (!normalizedAppName) return -1

  return appDomainDefaults.findIndex((rule) => !rule.bundle_id && !rule.url_host && normalizeAppName(rule.app_name) === normalizedAppName)
}

export function findMatchingSensitiveTargetIndex(rules: SensitiveTargetRule[], context: SmartContext) {
  const bundleId = context.bundle_id?.trim() || null
  if (bundleId) {
    const bundleMatchIndex = rules.findIndex((rule) => rule.bundle_id === bundleId)
    if (bundleMatchIndex >= 0) return bundleMatchIndex
  }

  const urlHost = context.url_host?.trim() || null
  if (urlHost) {
    const hostMatchIndex = rules.findIndex((rule) => hostMatches(rule.url_host, urlHost))
    if (hostMatchIndex >= 0) return hostMatchIndex
  }

  const normalizedAppName = normalizeAppName(context.app_name)
  if (!normalizedAppName) return -1

  return rules.findIndex((rule) => !rule.bundle_id && !rule.url_host && normalizeAppName(rule.app_name) === normalizedAppName)
}
