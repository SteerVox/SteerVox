import type { AppConfig } from '../types'
import type { SettingsStepRoute } from '../lib/routes'

export type DirtySectionMap = Record<SettingsStepRoute, boolean>

export type ConfigReducerState = {
  appliedConfig: AppConfig | null
  draftConfig: AppConfig | null
  dirtySections: DirtySectionMap
}

export type ConfigReducerAction =
  | { type: 'hydrate'; config: AppConfig }
  | { type: 'setDraft'; config: AppConfig }
  | { type: 'updateDraft'; updater: (current: AppConfig) => AppConfig }

export function createDirtySections(): DirtySectionMap {
  return {
    voice: false,
    rewrite: false,
    access: false,
    privacy: false,
    advanced: false,
  }
}

export function stableStringify(value: unknown) {
  return JSON.stringify(value)
}

export function deriveDirtySections(appliedConfig: AppConfig | null, draftConfig: AppConfig | null): DirtySectionMap {
  if (!appliedConfig || !draftConfig) return createDirtySections()

  return {
    voice: stableStringify(appliedConfig.stt) !== stableStringify(draftConfig.stt)
      || stableStringify(appliedConfig.audio) !== stableStringify(draftConfig.audio),
    rewrite: stableStringify(appliedConfig.llm) !== stableStringify(draftConfig.llm)
      || stableStringify(appliedConfig.hotkeys) !== stableStringify(draftConfig.hotkeys)
      || stableStringify(appliedConfig.domains) !== stableStringify(draftConfig.domains),
    access: false,
    privacy: stableStringify(appliedConfig.privacy) !== stableStringify(draftConfig.privacy),
    advanced: stableStringify(appliedConfig.debug) !== stableStringify(draftConfig.debug)
      || stableStringify(appliedConfig.actions) !== stableStringify(draftConfig.actions)
      || stableStringify(appliedConfig.memory) !== stableStringify(draftConfig.memory),
  }
}

export function createConfigReducerState(appliedConfig: AppConfig | null, draftConfig: AppConfig | null): ConfigReducerState {
  return {
    appliedConfig,
    draftConfig,
    dirtySections: deriveDirtySections(appliedConfig, draftConfig),
  }
}

export function configReducer(state: ConfigReducerState, action: ConfigReducerAction): ConfigReducerState {
  if (action.type === 'hydrate') {
    return createConfigReducerState(action.config, action.config)
  }

  if (!state.draftConfig) {
    return state
  }

  if (action.type === 'setDraft') {
    return createConfigReducerState(state.appliedConfig, action.config)
  }

  return createConfigReducerState(state.appliedConfig, action.updater(state.draftConfig))
}
