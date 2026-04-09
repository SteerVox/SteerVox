import type { HistoryItem, SmartRunTelemetry } from '../types'

type ActionExecutionMode = 'none' | 'reviewed' | 'auto'

function readActionExecutionMode(telemetry: Partial<SmartRunTelemetry> | null | undefined): ActionExecutionMode | null {
  const mode = telemetry?.action_execution_mode
  if (mode === 'none' || mode === 'reviewed' || mode === 'auto') {
    return mode
  }
  if (telemetry?.action_review_required === true) {
    return 'reviewed'
  }
  return null
}

export function isHistoryItemRerunnable(item: Pick<HistoryItem, 'telemetry'>) {
  const mode = readActionExecutionMode(item.telemetry)
  return mode === null || mode === 'none'
}

export function getHistoryItemRerunNotice(item: Pick<HistoryItem, 'telemetry'>) {
  const mode = readActionExecutionMode(item.telemetry)
  if (mode === 'reviewed') {
    return 'Reviewed desktop actions are view-only in history. Copy the output or run the command again live.'
  }
  if (mode === 'auto') {
    return 'Executed desktop actions are view-only in history. Copy the output or run the command again live.'
  }
  return null
}
