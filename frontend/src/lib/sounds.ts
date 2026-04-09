let sharedAudioContext: AudioContext | null = null

function resolveAudioContext(providedContext?: AudioContext | null) {
  if (providedContext && providedContext.state !== 'closed') {
    return providedContext
  }

  const AudioContextCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextCtor) return null

  if (!sharedAudioContext || sharedAudioContext.state === 'closed') {
    sharedAudioContext = new AudioContextCtor()
  }

  return sharedAudioContext
}

function playClick(frequency: number, startDelayMs = 0, audioContext?: AudioContext | null) {
  const context = resolveAudioContext(audioContext)
  if (!context) return

  const startAt = context.currentTime + startDelayMs / 1000
  const durationSeconds = 0.05
  const oscillator = context.createOscillator()
  const gain = context.createGain()

  if (context.state === 'suspended') {
    void context.resume().catch(() => undefined)
  }

  oscillator.type = 'sine'
  oscillator.frequency.setValueAtTime(frequency, startAt)
  gain.gain.setValueAtTime(0.0001, startAt)
  gain.gain.exponentialRampToValueAtTime(0.04, startAt + 0.01)
  gain.gain.exponentialRampToValueAtTime(0.001, startAt + durationSeconds)

  oscillator.connect(gain)
  gain.connect(context.destination)
  oscillator.start(startAt)
  oscillator.stop(startAt + durationSeconds)

  oscillator.onended = () => {
    oscillator.disconnect()
    gain.disconnect()
  }
}

export function playStartChime(audioContext?: AudioContext | null) {
  playClick(400, 0, audioContext)
  playClick(600, 80, audioContext)
}

export function playStopChime(audioContext?: AudioContext | null) {
  playClick(600, 0, audioContext)
  playClick(400, 80, audioContext)
}
