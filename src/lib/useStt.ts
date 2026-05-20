import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  UnsupportedSttError,
  createStt,
  type Stt,
  type SttOptions,
} from './stt'

export type SttStatus = 'idle' | 'live' | 'unsupported' | 'error'

export interface UseSttReturn {
  partial: string
  final: string
  status: SttStatus
  error: string | null
  start(): void
  stop(): void
}

export interface UseSttArgs {
  factory?: () => Stt
  options?: SttOptions
}

export function useStt({ factory, options }: UseSttArgs = {}): UseSttReturn {
  const sttRef = useRef<Stt | null>(null)
  const [partial, setPartial] = useState('')
  const [final, setFinal] = useState('')
  const [status, setStatus] = useState<SttStatus>('idle')
  const [error, setError] = useState<string | null>(null)

  const build = useMemo(
    () => factory ?? (() => createStt(undefined, options)),
    [factory, options],
  )

  useEffect(
    () => () => {
      sttRef.current?.stop()
    },
    [],
  )

  const start = useCallback(() => {
    if (sttRef.current) return
    try {
      const stt = build()
      stt.onPartial((t) => setPartial(t))
      stt.onFinal((t) => {
        setFinal((prev) => (prev ? `${prev} ${t}` : t))
        setPartial('')
      })
      stt.onError((m) => setError(m))
      stt.start()
      sttRef.current = stt
      setStatus('live')
      setError(null)
    } catch (err) {
      if (err instanceof UnsupportedSttError) {
        setStatus('unsupported')
        setError(err.message)
        return
      }
      setStatus('error')
      setError(err instanceof Error ? err.message : 'STT failed to start')
    }
  }, [build])

  const stop = useCallback(() => {
    sttRef.current?.stop()
    sttRef.current = null
    setStatus('idle')
  }, [])

  return { partial, final, status, error, start, stop }
}
