import type { BackendStatus, PendingNotification } from '../types'
import { hasCompletedPasteDelivery } from './pasteDelivery'

export function getPendingNotificationKey(notification: PendingNotification | null | undefined) {
  if (!notification) {
    return null
  }

  return `${notification.title}|${notification.body || ''}`
}

export function isPreparingPasteBusy(
  status: BackendStatus | null,
  options: {
    successVisible: boolean
    completedPasteId: string | null
    handledNotificationKey: string | null
  },
) {
  if (!status || status.phase !== 'preparing_paste') {
    return false
  }

  const pendingPasteId = status.pending_paste?.id ?? null
  const pendingNotificationKey = getPendingNotificationKey(status.pending_notification)
  const hasPendingDelivery = Boolean(pendingPasteId || pendingNotificationKey)

  if (!hasPendingDelivery || options.successVisible) {
    return false
  }

  if (pendingPasteId && (options.completedPasteId === pendingPasteId || hasCompletedPasteDelivery(pendingPasteId))) {
    return false
  }

  if (pendingNotificationKey && options.handledNotificationKey === pendingNotificationKey) {
    return false
  }

  return true
}
