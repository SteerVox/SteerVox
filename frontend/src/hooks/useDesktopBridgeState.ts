import { useEffect, useState } from 'react'

import type {
  AppLaunchContext,
  BackendBootState,
  CaptureState,
  LiveTranscription,
  MlxInstallState,
  SemanticMemoryInstallState,
} from '../types'

export function useLaunchContextState() {
  const [launchContext, setLaunchContext] = useState<AppLaunchContext | null>(null)

  useEffect(() => {
    let mounted = true
    window.windowControls?.getLaunchContext?.().then((context) => {
      if (mounted && context) {
        setLaunchContext(context)
      }
    })
    return () => {
      mounted = false
    }
  }, [])

  return [launchContext, setLaunchContext] as const
}

export function useBackendBootStateSubscription(initialState: BackendBootState) {
  const [bootState, setBootState] = useState<BackendBootState>(initialState)

  useEffect(() => {
    let mounted = true
    window.windowControls?.getBackendBootState?.().then((state) => {
      if (mounted && state) {
        setBootState(state)
      }
    })
    const dispose = window.windowControls?.onBackendBootState?.((state) => {
      if (mounted) {
        setBootState(state)
      }
    })
    return () => {
      mounted = false
      dispose?.()
    }
  }, [])

  return [bootState, setBootState] as const
}

export function useMlxInstallStateSubscription(initialState: MlxInstallState) {
  const [mlxInstallState, setMlxInstallState] = useState<MlxInstallState>(initialState)

  useEffect(() => {
    let mounted = true
    window.windowControls?.getMlxInstallState?.().then((state) => {
      if (mounted && state) {
        setMlxInstallState(state)
      }
    })
    const dispose = window.windowControls?.onMlxInstallState?.((state) => {
      if (mounted) {
        setMlxInstallState(state)
      }
    })
    return () => {
      mounted = false
      dispose?.()
    }
  }, [])

  return [mlxInstallState, setMlxInstallState] as const
}

export function useSemanticMemoryInstallStateSubscription(initialState: SemanticMemoryInstallState) {
  const [semanticMemoryInstallState, setSemanticMemoryInstallState] = useState<SemanticMemoryInstallState>(initialState)

  useEffect(() => {
    let mounted = true
    window.windowControls?.getSemanticMemoryInstallState?.().then((state) => {
      if (mounted && state) {
        setSemanticMemoryInstallState(state)
      }
    })
    const dispose = window.windowControls?.onSemanticMemoryInstallState?.((state) => {
      if (mounted) {
        setSemanticMemoryInstallState(state)
      }
    })
    return () => {
      mounted = false
      dispose?.()
    }
  }, [])

  return [semanticMemoryInstallState, setSemanticMemoryInstallState] as const
}

export function useCaptureStateSubscription(initialState: CaptureState, loadInitial = false) {
  const [captureState, setCaptureState] = useState<CaptureState>(initialState)

  useEffect(() => {
    let mounted = true
    if (loadInitial) {
      window.windowControls?.getCaptureState?.().then((state) => {
        if (mounted && state) {
          setCaptureState(state)
        }
      })
    }
    const dispose = window.windowControls?.onCaptureState?.((state) => {
      if (mounted) {
        setCaptureState(state)
      }
    })
    return () => {
      mounted = false
      dispose?.()
    }
  }, [loadInitial])

  return [captureState, setCaptureState] as const
}

export function useLocalLiveTranscriptionSubscription() {
  const [liveTranscription, setLiveTranscription] = useState<LiveTranscription | null>(null)

  useEffect(() => {
    let cancelled = false

    const initialLocalLivePromise = window.windowControls?.getLocalLiveTranscriptionState?.()
    if (initialLocalLivePromise) {
      void initialLocalLivePromise
        .then((state) => {
          if (!cancelled) {
            setLiveTranscription(state || null)
          }
        })
        .catch(() => undefined)
    }

    const dispose = window.windowControls?.onLocalLiveTranscription?.((state) => {
      setLiveTranscription(state || null)
    })

    return () => {
      cancelled = true
      dispose?.()
    }
  }, [])

  return [liveTranscription, setLiveTranscription] as const
}
