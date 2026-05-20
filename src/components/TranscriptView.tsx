import { useStt } from '../lib/useStt'
import type { Stt } from '../lib/stt'

interface TranscriptViewProps {
  sttFactory?: () => Stt
}

export function TranscriptView({ sttFactory }: TranscriptViewProps) {
  const { partial, final, status, error, start, stop } = useStt(
    sttFactory ? { factory: sttFactory } : {},
  )

  const live = status === 'live'
  const unsupported = status === 'unsupported'

  return (
    <section
      className="flex w-full max-w-lg flex-col gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-4"
      aria-label="Speech transcript"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-zinc-200">Transcript</h2>
        <button
          type="button"
          onClick={live ? stop : start}
          disabled={unsupported}
          className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1 text-xs font-medium text-zinc-100 hover:bg-zinc-700 disabled:opacity-50"
          aria-pressed={live}
        >
          {live ? 'Stop' : 'Listen'}
        </button>
      </div>

      <div className="space-y-2 text-left">
        <div
          data-testid="transcript-final"
          className="min-h-[1.25rem] whitespace-pre-wrap text-sm text-zinc-100"
        >
          {final || (
            <span className="italic text-zinc-500">
              Final transcript will appear here.
            </span>
          )}
        </div>
        <div
          data-testid="transcript-partial"
          className="min-h-[1.25rem] whitespace-pre-wrap text-sm italic text-zinc-400"
        >
          {partial}
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
