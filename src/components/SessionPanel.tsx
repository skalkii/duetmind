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
import type {
  FastWorkerInbound,
  FastWorkerOutbound,
  SlowWorkerInbound,
  SlowWorkerOutbound,
} from '../types/protocol'
import { useConversationStore } from '../state/conversationStore'
import {
  MODEL_OPTIONS,
  toDecisionConfig,
  useDebugConfigStore,
  type InteractionMode,
} from '../state/debugConfigStore'
import {
  createSlowBrain,
  type SlowBrain,
  type SlowBrainStatus,
} from '../lib/slowBrainClient'
import type { TickDecision } from '../types/protocol'

/**
 * Construct a typed worker from a module-URL or log and return null if the
 * environment doesn't support workers (older browsers, locked-down iframes).
 */
function tryWorker<TIn, TOut>(url: URL, label: string) {
  try {
    return createTypedWorker<TIn, TOut>(new Worker(url, { type: 'module' }))
  } catch (err) {
    console.warn(`${label} worker unavailable.`, err)
    return null
  }
}

function createDefaultDecisionSource(): DecisionSource {
  const w = tryWorker<FastWorkerInbound, FastWorkerOutbound>(
    new URL('../workers/fastBrain.worker.ts', import.meta.url),
    'Fast brain',
  )
  return w ? createWorkerDecisionSource(w) : createInlineDecisionSource()
}

function createDefaultSlowBrain(): SlowBrain | null {
  const w = tryWorker<SlowWorkerInbound, SlowWorkerOutbound>(
    new URL('../workers/slowBrain.worker.ts', import.meta.url),
    'Slow brain',
  )
  return w ? createSlowBrain(w) : null
}

type SessionStatus = 'idle' | 'starting' | 'live' | 'error'

interface SessionPanelProps {
  audioFactory?: () => AudioMeter
  sttFactory?: () => Stt
  ttsFactory?: () => Tts
  slowBrainFactory?: () => SlowBrain | null
  onDecision?: (decision: TickDecision) => void
  onBargeInLatency?: (ms: number) => void
}

interface Wired {
  audio: AudioMeter
  stt: Stt
  tts: Tts
  orchestrator: TickOrchestrator
  slowBrain: SlowBrain | null
}

export function SessionPanel({
  audioFactory,
  sttFactory,
  ttsFactory,
  slowBrainFactory,
  onDecision,
  onBargeInLatency,
}: SessionPanelProps) {
  const [status, setStatus] = useState<SessionStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [slowStatus, setSlowStatus] = useState<SlowBrainStatus>('idle')
  const [slowProgress, setSlowProgress] = useState(0)
  const [bargeMs, setBargeMs] = useState<number | null>(null)
  const wiredRef = useRef<Wired | null>(null)

  const userPartial = useConversationStore((s) => s.userTranscriptPartial)
  const userFinal = useConversationStore((s) => s.userTranscriptFinal)
  const userSpeaking = useConversationStore((s) => s.userSpeaking)
  const selfSpeaking = useConversationStore((s) => s.selfSpeaking)
  const tickCount = useConversationStore((s) => s.tickCount)
  const mode = useDebugConfigStore((s) => s.mode)
  const setMode = useDebugConfigStore((s) => s.setMode)
  const modelId = useDebugConfigStore((s) => s.modelId)
  const setModelId = useDebugConfigStore((s) => s.setModelId)

  useEffect(() => {
    return () => {
      wiredRef.current?.orchestrator.stop()
      wiredRef.current?.stt.stop()
      wiredRef.current?.audio.stop()
      wiredRef.current?.tts.stopAll()
      wiredRef.current?.slowBrain?.terminate()
      wiredRef.current = null
    }
  }, [])

  const start = async (): Promise<void> => {
    if (wiredRef.current) return
    setStatus('starting')
    setError(null)
    setSlowStatus('idle')
    setSlowProgress(0)
    try {
      const audio = (audioFactory ?? (() => createAudioMeter()))()
      const stt = (sttFactory ?? (() => createStt()))()
      const tts = (ttsFactory ?? (() => createTts()))()
      const decisionSource = createDefaultDecisionSource()
      const slowBrain = (slowBrainFactory ?? createDefaultSlowBrain)()
      slowBrain?.onStatus((s) => setSlowStatus(s))
      slowBrain?.onProgress((p) => setSlowProgress(p))
      const orchestrator = createTickOrchestrator(
        {
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
          ...(slowBrain ? { slowBrain } : {}),
        },
        {
          getConfig: () => toDecisionConfig(useDebugConfigStore.getState()),
          onBargeInLatency: (ms) => {
            setBargeMs(ms)
            onBargeInLatency?.(ms)
          },
          onTick: (decision) => onDecision?.(decision),
        },
      )
      await audio.start()
      stt.start()
      orchestrator.start()
      wiredRef.current = { audio, stt, tts, orchestrator, slowBrain }
      const selectedModelId = useDebugConfigStore.getState().modelId
      void slowBrain?.load(selectedModelId).catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : 'slow brain failed to load'
        setError(msg)
      })
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
    w.slowBrain?.terminate()
    wiredRef.current = null
    useConversationStore.getState().reset()
    setStatus('idle')
    setSlowStatus('idle')
    setSlowProgress(0)
    setBargeMs(null)
  }

  const live = status === 'live'

  return (
    <section
      className="w-full max-w-lg overflow-hidden rounded-3xl border border-edge/70 bg-surface/70 shadow-[0_30px_60px_-20px_rgba(0,0,0,0.6)] backdrop-blur"
      aria-label="DuetMind session"
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-edge/60 bg-surface-2/40 px-4 py-3 sm:px-5">
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="relative inline-flex h-2.5 w-4">
            <span
              className={`absolute left-0 h-2.5 w-2.5 rounded-full transition ${userSpeaking ? 'bg-fast' : 'bg-fast/30'}`}
            />
            <span
              className={`absolute left-1.5 h-2.5 w-2.5 rounded-full transition ${selfSpeaking ? 'bg-slow' : 'bg-slow/30'}`}
            />
          </span>
          <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-cream-muted">
            session
          </h2>
        </div>
        <button
          type="button"
          onClick={live ? stop : start}
          disabled={status === 'starting'}
          className={`whitespace-nowrap rounded-full px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.12em] transition disabled:opacity-50 sm:px-4 sm:tracking-[0.16em] ${
            live
              ? 'border border-coral/40 bg-coral/15 text-coral hover:bg-coral/25'
              : 'border border-fast/40 bg-fast/15 text-fast hover:bg-fast/25'
          }`}
          {...(error ? { 'aria-describedby': 'session-error' } : {})}
        >
          {live
            ? 'end session'
            : status === 'starting'
              ? 'starting…'
              : 'start session'}
        </button>
      </header>

      <div className="flex flex-col gap-4 px-4 py-5 sm:px-5">
        <ModeToggle mode={mode} onChange={setMode} />

        <ModelPicker
          value={modelId}
          onChange={setModelId}
          disabled={live || status === 'starting'}
        />

        <div className="flex flex-wrap gap-1.5 font-mono text-[9px] uppercase tracking-[0.12em] sm:gap-2 sm:text-[10px] sm:tracking-[0.16em]">
          <Badge active={userSpeaking} label="user" hue="fast" />
          <Badge active={selfSpeaking} label="self" hue="slow" />
          <SlowBrainBadge status={slowStatus} />
          {bargeMs !== null && <BargeBadge ms={bargeMs} />}
          <span className="whitespace-nowrap rounded-full border border-edge/70 bg-ink-deep/40 px-2 py-1 text-cream-muted sm:px-2.5">
            tick {tickCount}
          </span>
        </div>

        {slowStatus === 'loading' && (
          <div
            className="h-1 w-full overflow-hidden rounded-full bg-edge/60"
            role="progressbar"
            aria-label="Slow brain model loading"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(slowProgress * 100)}
          >
            <div
              className="h-full bg-slow transition-[width] duration-150"
              style={{ width: `${(slowProgress * 100).toFixed(1)}%` }}
            />
          </div>
        )}

        <div className="space-y-2 text-left">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-cream-muted">
            transcript
          </p>
          <div
            data-testid="transcript-final"
            className="min-h-[1.5rem] whitespace-pre-wrap font-display text-xl italic leading-snug text-cream"
          >
            {userFinal || (
              <span className="text-cream-muted">say something to begin…</span>
            )}
          </div>
          <div
            data-testid="transcript-partial"
            className="min-h-[1.25rem] whitespace-pre-wrap text-sm italic text-cream-muted"
          >
            {userPartial}
          </div>
        </div>

        {error && (
          <p
            id="session-error"
            role="alert"
            className="rounded-md border border-coral/30 bg-coral/10 px-3 py-2 font-mono text-[11px] text-coral"
          >
            {error}
          </p>
        )}
      </div>
    </section>
  )
}

function ModelPicker({
  value,
  onChange,
  disabled,
}: {
  value: string
  onChange: (id: string) => void
  disabled: boolean
}) {
  const selected = MODEL_OPTIONS.find((m) => m.id === value) ?? MODEL_OPTIONS[1]
  return (
    <div className="flex flex-col gap-1">
      <label
        htmlFor="model-picker"
        className="font-mono text-[10px] uppercase tracking-[0.18em] text-cream-muted"
      >
        slow brain model
      </label>
      <select
        id="model-picker"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="cursor-pointer rounded-md border border-edge/70 bg-ink-deep/40 px-3 py-1.5 text-sm text-cream focus:border-fast/60 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
      >
        {MODEL_OPTIONS.map((m) => (
          <option key={m.id} value={m.id} className="bg-ink text-cream">
            {m.label} (~{m.approxDownloadMb}MB)
          </option>
        ))}
      </select>
      {disabled && (
        <p className="font-mono text-[9px] text-cream-muted">
          end session to change model
        </p>
      )}
      {!disabled && selected && (
        <p className="font-mono text-[9px] text-cream-muted">
          ~{selected.approxDownloadMb}MB on first load, cached after
        </p>
      )}
    </div>
  )
}

function ModeToggle({
  mode,
  onChange,
}: {
  mode: InteractionMode
  onChange: (m: InteractionMode) => void
}) {
  const opts: Array<{ value: InteractionMode; label: string; hint: string }> = [
    {
      value: 'duplex',
      label: 'duplex',
      hint: 'listen, nod, interrupt — the default',
    },
    {
      value: 'turn_based',
      label: 'turn-based',
      hint: 'classic wait-then-reply, no backchannels, no barge-in',
    },
  ]
  return (
    <div
      role="radiogroup"
      aria-label="Interaction mode"
      className="flex w-full overflow-hidden rounded-full border border-edge/70 bg-ink-deep/40 p-0.5 font-mono text-[10px] uppercase tracking-[0.16em]"
    >
      {opts.map((o) => {
        const active = o.value === mode
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            title={o.hint}
            className={`flex-1 rounded-full px-3 py-1.5 transition ${
              active
                ? 'bg-fast/20 text-fast'
                : 'text-cream-muted hover:text-cream'
            }`}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

function Badge({
  active,
  label,
  hue,
}: {
  active: boolean
  label: string
  hue: 'fast' | 'slow'
}) {
  const live =
    hue === 'fast'
      ? 'border-fast/40 bg-fast/15 text-fast'
      : 'border-slow/40 bg-slow/15 text-slow'
  const idle = 'border-edge/70 bg-ink-deep/40 text-cream-muted'
  return (
    <span
      className={`whitespace-nowrap rounded-full border px-2 py-1 sm:px-2.5 ${active ? live : idle}`}
    >
      {label}
      {active ? ' · on' : ''}
    </span>
  )
}

function BargeBadge({ ms }: { ms: number }) {
  const ok = ms < 200
  const palette = ok
    ? 'border-fast/40 bg-fast/15 text-fast'
    : 'border-coral/40 bg-coral/15 text-coral'
  return (
    <span
      className={`whitespace-nowrap rounded-full border px-2 py-1 sm:px-2.5 ${palette}`}
      title={`Barge-in latency (target < 200ms)`}
    >
      barge · {Math.round(ms)}ms
    </span>
  )
}

function SlowBrainBadge({ status }: { status: SlowBrainStatus }) {
  const labels: Record<SlowBrainStatus, string> = {
    idle: 'slow · idle',
    loading: 'slow · loading',
    ready: 'slow · ready',
    error: 'slow · error',
  }
  const palettes: Record<SlowBrainStatus, string> = {
    idle: 'border-edge/70 bg-ink-deep/40 text-cream-muted',
    loading: 'border-slow/40 bg-slow/15 text-slow',
    ready: 'border-slow/50 bg-slow/20 text-slow',
    error: 'border-coral/40 bg-coral/15 text-coral',
  }
  return (
    <span
      className={`whitespace-nowrap rounded-full border px-2 py-1 sm:px-2.5 ${palettes[status]}`}
    >
      {labels[status]}
    </span>
  )
}
