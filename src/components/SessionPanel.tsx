import { useEffect, useRef, useState } from 'react'
import {
  UnsupportedAudioError,
  createAudioMeter,
  type AudioMeter,
} from '../lib/audio'
import { UnsupportedSttError, createStt, type Stt } from '../lib/stt'
import { UnsupportedTtsError, createTts, type Tts } from '../lib/tts'
import {
  createTickOrchestrator,
  type TickOrchestrator,
} from '../lib/tickOrchestrator'
import {
  createInlineDecisionSource,
  createWorkerDecisionSource,
  type DecisionSource,
} from '../lib/decisionSource'
import { createTypedWorker } from '../lib/workerBridge'
import type { FastWorkerInbound, FastWorkerOutbound } from '../types/protocol'
import { useConversationStore } from '../state/conversationStore'

function createDefaultDecisionSource(): DecisionSource {
  try {
    const worker = new Worker(
      new URL('../workers/fastBrain.worker.ts', import.meta.url),
      { type: 'module' },
    )
    return createWorkerDecisionSource(
      createTypedWorker<FastWorkerInbound, FastWorkerOutbound>(worker),
    )
  } catch (err) {
    console.warn('Fast brain worker unavailable, falling back to inline.', err)
    return createInlineDecisionSource()
  }
}

type SessionStatus = 'idle' | 'starting' | 'live' | 'error'

interface SessionPanelProps {
  audioFactory?: () => AudioMeter
  sttFactory?: () => Stt
  ttsFactory?: () => Tts
}

interface Wired {
  audio: AudioMeter
  stt: Stt
  tts: Tts
  orchestrator: TickOrchestrator
}

export function SessionPanel({
  audioFactory,
  sttFactory,
  ttsFactory,
}: SessionPanelProps) {
  const [status, setStatus] = useState<SessionStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const wiredRef = useRef<Wired | null>(null)

  const userPartial = useConversationStore((s) => s.userTranscriptPartial)
  const userFinal = useConversationStore((s) => s.userTranscriptFinal)
  const userSpeaking = useConversationStore((s) => s.userSpeaking)
  const selfSpeaking = useConversationStore((s) => s.selfSpeaking)
  const tickCount = useConversationStore((s) => s.tickCount)

  useEffect(() => {
    return () => {
      wiredRef.current?.orchestrator.stop()
      wiredRef.current?.stt.stop()
      wiredRef.current?.audio.stop()
      wiredRef.current?.tts.stopAll()
      wiredRef.current = null
    }
  }, [])

  const start = async (): Promise<void> => {
    if (wiredRef.current) return
    setStatus('starting')
    setError(null)
    try {
      const audio = (audioFactory ?? (() => createAudioMeter()))()
      const stt = (sttFactory ?? (() => createStt()))()
      const tts = (ttsFactory ?? (() => createTts()))()
      const decisionSource = createDefaultDecisionSource()
      const orchestrator = createTickOrchestrator({
        store: { getState: () => useConversationStore.getState() },
        audio,
        stt,
        tts,
        now: () => performance.now(),
        scheduler: {
          setInterval: (cb, ms) => setInterval(cb, ms),
          clearInterval: (h) => clearInterval(h),
        },
        decisionSource,
      })
      await audio.start()
      stt.start()
      orchestrator.start()
      wiredRef.current = { audio, stt, tts, orchestrator }
      setStatus('live')
    } catch (err) {
      let msg: string
      if (
        err instanceof UnsupportedAudioError ||
        err instanceof UnsupportedSttError ||
        err instanceof UnsupportedTtsError
      ) {
        msg = `${err.message} Use Chrome or Edge.`
      } else {
        msg = err instanceof Error ? err.message : 'Session failed to start'
      }
      setError(msg)
      setStatus('error')
    }
  }

  const stop = (): void => {
    const w = wiredRef.current
    if (!w) return
    w.orchestrator.stop()
    w.stt.stop()
    w.audio.stop()
    w.tts.stopAll()
    wiredRef.current = null
    useConversationStore.getState().reset()
    setStatus('idle')
  }

  const live = status === 'live'

  return (
    <section
      className="flex w-full max-w-lg flex-col gap-4 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5"
      aria-label="DuetMind session"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-zinc-100">Session</h2>
        <button
          type="button"
          onClick={live ? stop : start}
          disabled={status === 'starting'}
          className={`rounded-full px-4 py-1.5 text-xs font-medium transition disabled:opacity-50 ${
            live
              ? 'border border-red-900/40 bg-red-900/30 text-red-200 hover:bg-red-900/50'
              : 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20'
          }`}
          aria-pressed={live}
        >
          {live
            ? 'End session'
            : status === 'starting'
              ? 'Starting…'
              : 'Start session'}
        </button>
      </div>

      <div className="flex gap-2 text-[10px] uppercase tracking-wide">
        <StatusBadge active={userSpeaking} label="user" tone="emerald" />
        <StatusBadge active={selfSpeaking} label="self" tone="sky" />
        <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-zinc-500">
          tick {tickCount}
        </span>
      </div>

      <div className="space-y-1 text-left">
        <div className="min-h-[1.25rem] whitespace-pre-wrap text-sm text-zinc-100">
          {userFinal || (
            <span className="italic text-zinc-500">
              Final transcript will appear here.
            </span>
          )}
        </div>
        <div className="min-h-[1.25rem] whitespace-pre-wrap text-sm italic text-zinc-400">
          {userPartial}
        </div>
      </div>

      {error && (
        <p role="alert" className="text-xs text-red-400">
          {error}
        </p>
      )}
    </section>
  )
}

function StatusBadge({
  active,
  label,
  tone,
}: {
  active: boolean
  label: string
  tone: 'emerald' | 'sky'
}) {
  const palette =
    tone === 'emerald'
      ? active
        ? 'bg-emerald-400/15 text-emerald-300'
        : 'bg-zinc-800 text-zinc-500'
      : active
        ? 'bg-sky-400/15 text-sky-300'
        : 'bg-zinc-800 text-zinc-500'
  return (
    <span className={`rounded-full px-2 py-0.5 ${palette}`}>
      {label}
      {active ? ' • on' : ''}
    </span>
  )
}
