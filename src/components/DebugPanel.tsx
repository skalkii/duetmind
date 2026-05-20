import { useEffect, useRef, useState } from 'react'
import { useConversationStore } from '../state/conversationStore'
import { useDebugConfigStore } from '../state/debugConfigStore'
import { DEFAULT_DECISION_CONFIG } from '../lib/decisionRules'
import type { TickDecision } from '../types/protocol'

function downloadTranscript(): void {
  const state = useConversationStore.getState()
  const cfg = useDebugConfigStore.getState()
  const payload = {
    exportedAt: new Date().toISOString(),
    mode: cfg.mode,
    config: {
      silenceThresholdMs: cfg.silenceThresholdMs,
      backchannelRate: cfg.backchannelRate,
      bargeInEnabled: cfg.bargeInEnabled,
      backchannelEnabled: cfg.backchannelEnabled,
      fastStallEnabled: cfg.fastStallEnabled,
    },
    tickCount: state.tickCount,
    messages: state.messages,
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `duetmind-transcript-${Date.now()}.json`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export interface DebugPanelProps {
  /** Most recent decision the orchestrator dispatched. */
  lastDecision: TickDecision | null
  /** Most recent barge-in latency in ms. */
  lastBargeMs: number | null
}

export function DebugPanel({ lastDecision, lastBargeMs }: DebugPanelProps) {
  const [open, setOpen] = useState(false)
  const tickCount = useConversationStore((s) => s.tickCount)
  const slowReplyText = useConversationStore((s) => s.slowReplyText)
  const silenceThresholdMs = useDebugConfigStore((s) => s.silenceThresholdMs)
  const backchannelRate = useDebugConfigStore((s) => s.backchannelRate)
  const setSilenceThresholdMs = useDebugConfigStore(
    (s) => s.setSilenceThresholdMs,
  )
  const setBackchannelRate = useDebugConfigStore((s) => s.setBackchannelRate)
  const resetDebugConfig = useDebugConfigStore((s) => s.reset)

  const lastDecisionLabel = lastDecision
    ? formatDecision(lastDecision)
    : '— none yet'

  return (
    <section
      className="w-full max-w-lg overflow-hidden rounded-2xl border border-edge/60 bg-surface/40"
      aria-label="Debug panel"
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-4 py-2.5 text-left"
        aria-expanded={open}
        aria-controls="debug-panel-body"
      >
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-cream-muted">
          debug
        </span>
        <span className="font-mono text-[10px] text-cream-muted">
          {open ? '−' : '+'}
        </span>
      </button>

      {open && (
        <div
          id="debug-panel-body"
          className="space-y-4 border-t border-edge/60 px-4 py-4"
        >
          <dl className="grid grid-cols-1 gap-x-4 gap-y-2 font-mono text-[11px] sm:grid-cols-2">
            <Metric label="tick" value={tickCount.toString()} />
            <Metric label="last decision" value={lastDecisionLabel} />
            <Metric
              label="barge ms"
              value={lastBargeMs !== null ? `${Math.round(lastBargeMs)}` : '—'}
            />
            <Metric
              label="slow buffer"
              value={
                slowReplyText !== null
                  ? `${slowReplyText.length} chars`
                  : 'empty'
              }
            />
          </dl>

          <ConfigSlider
            id="debug-silence-threshold"
            label="silence threshold"
            unit="ms"
            min={100}
            max={2000}
            step={50}
            value={silenceThresholdMs}
            defaultValue={DEFAULT_DECISION_CONFIG.silenceThresholdMs}
            onChange={setSilenceThresholdMs}
          />
          <ConfigSlider
            id="debug-backchannel-rate"
            label="backchannel rate"
            unit=""
            min={0}
            max={1}
            step={0.05}
            value={backchannelRate}
            defaultValue={DEFAULT_DECISION_CONFIG.backchannelRate}
            onChange={setBackchannelRate}
            display={(v) => v.toFixed(2)}
          />

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <button
              type="button"
              onClick={resetDebugConfig}
              className="rounded-md border border-edge/70 bg-ink-deep/40 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-cream-muted hover:bg-ink-deep/60"
            >
              reset to defaults
            </button>
            <button
              type="button"
              onClick={downloadTranscript}
              className="rounded-md border border-fast/30 bg-fast/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-fast hover:bg-fast/20"
            >
              export transcript
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-[9px] uppercase tracking-[0.18em] text-cream-muted">
        {label}
      </dt>
      <dd className="break-words text-cream">{value}</dd>
    </div>
  )
}

function ConfigSlider({
  id,
  label,
  unit,
  min,
  max,
  step,
  value,
  defaultValue,
  onChange,
  display,
}: {
  id: string
  label: string
  unit: string
  min: number
  max: number
  step: number
  value: number
  defaultValue: number
  onChange: (n: number) => void
  display?: (n: number) => string
}) {
  const sliderRef = useRef<HTMLInputElement | null>(null)
  const formatted = display ? display(value) : value.toString()
  const isDefault = Math.abs(value - defaultValue) < step / 2
  const announced = `${formatted}${unit ? ` ${unit}` : ''}`

  // Browsers don't always re-sync the slider thumb when value prop changes
  // via store mutation from elsewhere; nudge the input value imperatively.
  useEffect(() => {
    if (sliderRef.current && sliderRef.current.valueAsNumber !== value) {
      sliderRef.current.valueAsNumber = value
    }
  }, [value])

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between font-mono text-[11px]">
        <label htmlFor={id} className="text-cream-muted">
          {label}
          {!isDefault && <span className="ml-1 text-fast">·</span>}
        </label>
        <span className="text-cream" aria-hidden="true">
          {formatted}
          {unit && <span className="ml-0.5 text-cream-muted">{unit}</span>}
        </span>
      </div>
      <input
        id={id}
        ref={sliderRef}
        type="range"
        min={min}
        max={max}
        step={step}
        defaultValue={value}
        onChange={(e) => onChange(e.target.valueAsNumber)}
        aria-valuetext={announced}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-edge accent-fast"
      />
    </div>
  )
}

function formatDecision(d: TickDecision): string {
  switch (d.action) {
    case 'silent':
      return 'silent'
    case 'backchannel':
      return `backchannel "${d.phrase}"`
    case 'start_fast_reply':
      return `fast reply "${d.phrase}"`
    case 'request_slow_reply':
      return 'request slow'
    case 'handoff_to_slow':
      return 'handoff'
    case 'interrupt_self':
      return 'interrupt'
  }
}
