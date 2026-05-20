import { useEffect, useState } from 'react'
import { UnsupportedTtsError, createTts, type Tts } from '../lib/tts'

interface SpeakBoxProps {
  ttsFactory?: () => Tts
}

interface TtsInit {
  tts: Tts | null
  error: string | null
}

function initTts(factory: () => Tts): TtsInit {
  try {
    return { tts: factory(), error: null }
  } catch (err) {
    if (err instanceof UnsupportedTtsError) {
      return { tts: null, error: err.message }
    }
    return {
      tts: null,
      error: err instanceof Error ? err.message : 'TTS init failed',
    }
  }
}

export function SpeakBox({ ttsFactory }: SpeakBoxProps) {
  const [text, setText] = useState(
    'DuetMind is a browser-native interaction model. Two brains, one tick loop.',
  )
  const [speaking, setSpeaking] = useState(false)
  const [{ tts, error: initError }] = useState<TtsInit>(() =>
    initTts(ttsFactory ?? (() => createTts())),
  )
  const [runtimeError, setRuntimeError] = useState<string | null>(null)

  useEffect(() => {
    return () => {
      tts?.stopAll()
    }
  }, [tts])

  const handleSpeak = async (): Promise<void> => {
    if (!tts) return
    setRuntimeError(null)
    setSpeaking(true)
    try {
      await tts.speak(text)
    } catch (err) {
      setRuntimeError(err instanceof Error ? err.message : 'speak failed')
    } finally {
      setSpeaking(false)
    }
  }

  const handleStop = (): void => {
    tts?.stopAll()
    setSpeaking(false)
  }

  const ready = tts !== null
  const error = initError ?? runtimeError

  return (
    <section
      className="flex w-full max-w-lg flex-col gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-4"
      aria-label="Speech synthesis demo"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-zinc-200">Speak</h2>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide ${
            speaking
              ? 'bg-sky-400/10 text-sky-300'
              : 'bg-zinc-800 text-zinc-500'
          }`}
        >
          {speaking ? 'speaking' : 'idle'}
        </span>
      </div>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        className="w-full resize-y rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-500"
      />

      <div className="flex gap-2">
        <button
          type="button"
          onClick={handleSpeak}
          disabled={!ready || speaking || !text.trim()}
          className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1 text-xs font-medium text-zinc-100 hover:bg-zinc-700 disabled:opacity-50"
        >
          Speak
        </button>
        <button
          type="button"
          onClick={handleStop}
          disabled={!speaking}
          className="rounded-md border border-red-900/50 bg-red-900/30 px-3 py-1 text-xs font-medium text-red-200 hover:bg-red-900/50 disabled:opacity-50"
        >
          Stop
        </button>
      </div>

      {error && (
        <p role="alert" className="text-xs text-red-400">
          {error}
        </p>
      )}
    </section>
  )
}
