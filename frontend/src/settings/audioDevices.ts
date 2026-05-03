import type { AudioDevice } from '../types'

export function resolveConfiguredDevice(
  audioConfig: {
    input_device_id?: string | null
    input_device_label?: string | null
    input_device?: string | null
  },
  devices: AudioDevice[],
) {
  const safeDevices = Array.isArray(devices) ? devices : []

  if (audioConfig.input_device_id) {
    const byId = safeDevices.find((device) => device.id === audioConfig.input_device_id)
    if (byId) return byId
  }

  const fallbackLabel = audioConfig.input_device_label || audioConfig.input_device
  if (!fallbackLabel) return null

  return safeDevices.find((device) => device.label === fallbackLabel) || null
}
