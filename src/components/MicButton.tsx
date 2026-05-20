import { useEffect, useMemo, useRef, useState } from 'react'
import {
  UnsupportedAudioError,
  createAudioMeter,
  type AudioMeter,
} from '../lib/audio'

type MicState = 'idle' | 'requesting' | 'live' | 'error'

interface MicButtonProps {
  meterFactory?: () => AudioMeter
}

export function MicButton({ meterFactory }: MicButtonProps) {
  const meterRef = useRef<AudioMeter | null>(null)
  const barRef = useRef<HTMLDivElement | null>(null)
  const [state, setState] = useState<MicState>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const factory = useMemo(
    () => meterFactory ?? (() => createAudioMeter()),
    [meterFactory],
  )

  useEffect(() => {
    return () => {
      meterRef.current?.stop()
    }
  }, [])

  const start = async (): Promise<void> => {
    setErrorMessage(null)
    setState('requesting')
    try {
      const meter = factory()
      meterRef.current = meter
      meter.onLevel((rms) => {
        const bar = barRef.current
        if (!bar) return
        const pct = Math.min(100, rms * 400)
        bar.style.width = `${pct.toFixed(1)}%`
      })
      await meter.start()
      setState('live')
    } catch (err) {
      meterRef.current = null
      const msg =
        err instanceof UnsupportedAudioError
          ? `${err.message}. Use Chrome or Edge.`
          : err instanceof Error
            ? err.message
            : 'Mic permission denied.'
      setErrorMessage(msg)
      setState('error')
    }
  }

  const stop = (): void => {
    meterRef.current?.stop()
    meterRef.current = null
    if (barRef.current) barRef.current.style.width = '0%'
    setState('idle')
  }

  const live = state === 'live'

  return (
    <div className="flex w-full max-w-sm flex-col items-center gap-3">
      <button
        type="button"
        onClick={live ? stop : start}
        disabled={state === 'requesting'}
        className="rounded-full border border-zinc-700 bg-zinc-900 px-5 py-2 text-sm font-medium text-zinc-100 transition hover:bg-zinc-800 disabled:opacity-50"
        aria-pressed={live}
      >
        {live
          ? 'Stop mic'
          : state === 'requesting'
            ? 'Requesting…'
            : 'Start mic'}
      </button>

      <div
        className="h-2 w-full overflow-hidden rounded-full bg-zinc-800"
        role="meter"
        aria-label="Microphone input level"
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          ref={barRef}
          className="h-full bg-emerald-400 transition-[width] duration-75"
          style={{ width: '0%' }}
        />
      </div>

      {errorMessage && (
        <p role="alert" className="text-xs text-red-400">
          {errorMessage}
        </p>
      )}
    </div>
  )
}
