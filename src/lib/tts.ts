/**
 * Speech synthesis wrapper.
 *
 * Owns two non-obvious concerns the rest of the app shouldn't see:
 *   1. Barge-in: stopAll() must be synchronous — no awaits, no microtask
 *      hop between user intent and audio actually stopping.
 *   2. Chrome bug: speechSynthesis stops emitting after ~15s of continuous
 *      use. Workaround: pause+resume every 10s while speaking.
 *
 * Public surface is intentionally small: speak, stopAll, listeners. The
 * orchestrator decides *when* to call these; this file owns only *how*.
 */

const CHROME_HEARTBEAT_MS = 10_000

export interface TtsUtteranceLike {
  text: string
  onend: (() => void) | null
  onerror: ((message: string) => void) | null
  onboundary: ((charIndex: number) => void) | null
  rate?: number
  pitch?: number
  voice?: SpeechSynthesisVoice | null
}

export interface SpeechSynthesisLike {
  speak(utterance: TtsUtteranceLike): void
  cancel(): void
  pause(): void
  resume(): void
  readonly speaking: boolean
  readonly paused: boolean
}

export interface Tts {
  speak(text: string): Promise<void>
  stopAll(): void
  onBoundary(cb: (charIndex: number) => void): () => void
  onEnd(cb: () => void): () => void
  onError(cb: (message: string) => void): () => void
  readonly isSpeaking: boolean
}

export class UnsupportedTtsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedTtsError'
  }
}

export interface TtsDeps {
  synthesis: SpeechSynthesisLike
  createUtterance: (text: string) => TtsUtteranceLike
  scheduler: {
    setInterval: (cb: () => void, ms: number) => ReturnType<typeof setInterval>
    clearInterval: (h: ReturnType<typeof setInterval>) => void
  }
}

export interface TtsOptions {
  readonly heartbeatMs?: number
  readonly rate?: number
}

interface BrowserUtteranceEvent {
  charIndex?: number
  error?: string
}

type WindowWithSpeech = Window & {
  speechSynthesis?: SpeechSynthesis
  SpeechSynthesisUtterance?: new (text: string) => SpeechSynthesisUtterance
}

export function defaultTtsDeps(): TtsDeps {
  if (typeof window === 'undefined') {
    throw new UnsupportedTtsError('window is unavailable')
  }
  const w = window as WindowWithSpeech
  const synth = w.speechSynthesis
  const Ctor = w.SpeechSynthesisUtterance
  if (!synth || !Ctor) {
    throw new UnsupportedTtsError(
      'speechSynthesis is unavailable in this browser.',
    )
  }
  return {
    synthesis: {
      speak: (u) => synth.speak(u as unknown as SpeechSynthesisUtterance),
      cancel: () => synth.cancel(),
      pause: () => synth.pause(),
      resume: () => synth.resume(),
      get speaking() {
        return synth.speaking
      },
      get paused() {
        return synth.paused
      },
    },
    createUtterance: (text) => {
      const raw = new Ctor(text)
      const adapter: TtsUtteranceLike = {
        text,
        onend: null,
        onerror: null,
        onboundary: null,
      }
      raw.onend = () => adapter.onend?.()
      raw.onerror = (e: BrowserUtteranceEvent) =>
        adapter.onerror?.(e.error ?? 'speech error')
      raw.onboundary = (e: BrowserUtteranceEvent) =>
        adapter.onboundary?.(e.charIndex ?? 0)
      Object.defineProperty(adapter, 'rate', {
        get: () => raw.rate,
        set: (v: number) => {
          raw.rate = v
        },
      })
      Object.defineProperty(adapter, 'pitch', {
        get: () => raw.pitch,
        set: (v: number) => {
          raw.pitch = v
        },
      })
      Object.defineProperty(adapter, 'voice', {
        get: () => raw.voice,
        set: (v: SpeechSynthesisVoice | null) => {
          raw.voice = v
        },
      })
      return adapter
    },
    scheduler: {
      setInterval: (cb, ms) => setInterval(cb, ms),
      clearInterval: (h) => clearInterval(h),
    },
  }
}

export function createTts(
  deps: TtsDeps = defaultTtsDeps(),
  options: TtsOptions = {},
): Tts {
  const heartbeatMs = options.heartbeatMs ?? CHROME_HEARTBEAT_MS
  const rate = options.rate ?? 1
  const boundaryListeners = new Set<(i: number) => void>()
  const endListeners = new Set<() => void>()
  const errorListeners = new Set<(m: string) => void>()
  let speaking = false
  let heartbeat: ReturnType<typeof setInterval> | null = null

  const startHeartbeat = (): void => {
    if (heartbeat !== null) return
    heartbeat = deps.scheduler.setInterval(() => {
      // Chrome silently stops the synth after ~15s. Toggling pause/resume
      // resets the internal watchdog. Cheap and safe — no-op if not speaking.
      if (deps.synthesis.speaking && !deps.synthesis.paused) {
        deps.synthesis.pause()
        deps.synthesis.resume()
      }
    }, heartbeatMs)
  }

  const stopHeartbeat = (): void => {
    if (heartbeat !== null) deps.scheduler.clearInterval(heartbeat)
    heartbeat = null
  }

  return {
    speak(text: string): Promise<void> {
      return new Promise<void>((resolve) => {
        const utt = deps.createUtterance(text)
        utt.rate = rate
        utt.onboundary = (i) => {
          for (const cb of boundaryListeners) cb(i)
        }
        utt.onerror = (msg) => {
          for (const cb of errorListeners) cb(msg)
        }
        utt.onend = () => {
          speaking = deps.synthesis.speaking
          if (!speaking) stopHeartbeat()
          for (const cb of endListeners) cb()
          resolve()
        }
        speaking = true
        startHeartbeat()
        deps.synthesis.speak(utt)
      })
    },
    stopAll(): void {
      // Synchronous on purpose. Any async work here would push barge-in
      // latency past the 200ms perceptual budget.
      deps.synthesis.cancel()
      stopHeartbeat()
      speaking = false
    },
    onBoundary(cb): () => void {
      boundaryListeners.add(cb)
      return () => {
        boundaryListeners.delete(cb)
      }
    },
    onEnd(cb): () => void {
      endListeners.add(cb)
      return () => {
        endListeners.delete(cb)
      }
    },
    onError(cb): () => void {
      errorListeners.add(cb)
      return () => {
        errorListeners.delete(cb)
      }
    },
    get isSpeaking(): boolean {
      return speaking
    },
  }
}
