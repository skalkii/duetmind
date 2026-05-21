/**
 * Web Speech API wrapper.
 *
 * The browser's `SpeechRecognition` interface isn't in the standard lib.dom
 * types, so we declare a minimal `SpeechRecognitionLike` contract describing
 * only what we use. Chrome ends the session after a silence window — we
 * auto-restart while the caller still considers us live.
 */

export interface SpeechRecognitionResultLike {
  readonly transcript: string
  readonly isFinal: boolean
}

export interface SpeechRecognitionLike {
  continuous: boolean
  interimResults: boolean
  lang: string
  start(): void
  stop(): void
  abort(): void
  onresult: ((results: SpeechRecognitionResultLike[]) => void) | null
  onend: (() => void) | null
  onerror: ((message: string) => void) | null
  onstart: (() => void) | null
}

export interface Stt {
  start(): void
  stop(): void
  onPartial(cb: (text: string) => void): () => void
  onFinal(cb: (text: string) => void): () => void
  onError(cb: (message: string) => void): () => void
  readonly isRunning: boolean
}

export class UnsupportedSttError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedSttError'
  }
}

export interface SttDeps {
  createRecognition: () => SpeechRecognitionLike
}

export interface SttOptions {
  readonly lang?: string
  readonly autoRestart?: boolean
}

type WindowWithRecognition = Window & {
  webkitSpeechRecognition?: new () => unknown
  SpeechRecognition?: new () => unknown
}

interface BraveNavigator extends Navigator {
  brave?: { isBrave?: () => Promise<boolean> }
}

let braveDetected: boolean | null = null
async function isBrave(): Promise<boolean> {
  if (braveDetected !== null) return braveDetected
  if (typeof navigator === 'undefined') return false
  const n = navigator as BraveNavigator
  try {
    braveDetected = (await n.brave?.isBrave?.()) === true
  } catch {
    braveDetected = false
  }
  return braveDetected
}

export function formatSttError(code: string, brave: boolean): string {
  switch (code) {
    case 'network':
      return brave
        ? 'Speech recognition blocked. Brave disables Google Speech backend by default. Use Chrome/Edge, or enable brave://settings/privacy → "Use Google services for push messaging".'
        : 'Speech recognition backend unreachable. Check network/VPN, or use Chrome/Edge on a non-restricted network.'
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone permission denied. Allow mic access in the address bar.'
    case 'no-speech':
      return 'No speech detected. Try speaking louder or closer to the mic.'
    case 'audio-capture':
      return 'Mic not found. Check input device.'
    case 'aborted':
      return 'Speech recognition aborted.'
    default:
      return `Speech recognition error: ${code}`
  }
}

interface BrowserRecognition {
  continuous: boolean
  interimResults: boolean
  lang: string
  start(): void
  stop(): void
  abort(): void
  onresult: ((event: SpeechRecognitionResultListEvent) => void) | null
  onend: (() => void) | null
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null
  onstart: (() => void) | null
}

interface SpeechRecognitionResultListEvent {
  resultIndex: number
  results: ArrayLike<
    ArrayLike<{ transcript: string }> & { isFinal: boolean; length: number }
  > & { length: number }
}

interface SpeechRecognitionErrorEvent {
  error?: string
  message?: string
}

export function defaultSttDeps(): SttDeps {
  if (typeof window === 'undefined') {
    throw new UnsupportedSttError('window is unavailable')
  }
  const w = window as WindowWithRecognition
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition
  if (!Ctor) {
    throw new UnsupportedSttError(
      'Web Speech API is unavailable in this browser. Use Chrome or Edge.',
    )
  }
  return {
    createRecognition: () => {
      const raw = new Ctor() as BrowserRecognition
      const adapter: SpeechRecognitionLike = {
        get continuous() {
          return raw.continuous
        },
        set continuous(v: boolean) {
          raw.continuous = v
        },
        get interimResults() {
          return raw.interimResults
        },
        set interimResults(v: boolean) {
          raw.interimResults = v
        },
        get lang() {
          return raw.lang
        },
        set lang(v: string) {
          raw.lang = v
        },
        start: () => raw.start(),
        stop: () => raw.stop(),
        abort: () => raw.abort(),
        onresult: null,
        onend: null,
        onerror: null,
        onstart: null,
      }
      raw.onresult = (event) => {
        const out: SpeechRecognitionResultLike[] = []
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const r = event.results[i]
          if (!r) continue
          const first = r[0]
          if (!first) continue
          out.push({ transcript: first.transcript, isFinal: r.isFinal })
        }
        adapter.onresult?.(out)
      }
      raw.onend = () => adapter.onend?.()
      raw.onerror = (e) => {
        const code = e.error ?? e.message ?? 'unknown'
        void isBrave().then((brave) => {
          adapter.onerror?.(formatSttError(code, brave))
        })
      }
      raw.onstart = () => adapter.onstart?.()
      return adapter
    },
  }
}

const DEFAULT_LANG = 'en-US'

export function createStt(
  deps: SttDeps = defaultSttDeps(),
  options: SttOptions = {},
): Stt {
  const lang = options.lang ?? DEFAULT_LANG
  const autoRestart = options.autoRestart ?? true

  let recognition: SpeechRecognitionLike | null = null
  let running = false
  const partialListeners = new Set<(t: string) => void>()
  const finalListeners = new Set<(t: string) => void>()
  const errorListeners = new Set<(m: string) => void>()

  const emit = <T>(set: Set<(v: T) => void>, value: T): void => {
    for (const cb of set) cb(value)
  }

  const wire = (rec: SpeechRecognitionLike): void => {
    rec.continuous = true
    rec.interimResults = true
    rec.lang = lang
    rec.onresult = (results) => {
      let partial = ''
      for (const r of results) {
        if (r.isFinal) emit(finalListeners, r.transcript.trim())
        else partial += r.transcript
      }
      if (partial) emit(partialListeners, partial.trim())
    }
    rec.onend = () => {
      if (!running || !autoRestart) return
      try {
        rec.start()
      } catch (err) {
        emit(
          errorListeners,
          err instanceof Error ? err.message : 'restart failed',
        )
      }
    }
    rec.onerror = (msg) => emit(errorListeners, msg)
  }

  return {
    start(): void {
      if (running) return
      running = true
      recognition = deps.createRecognition()
      wire(recognition)
      recognition.start()
    },
    stop(): void {
      running = false
      if (!recognition) return
      recognition.onend = null
      recognition.onresult = null
      recognition.onerror = null
      try {
        recognition.stop()
      } catch {
        recognition.abort()
      }
      recognition = null
    },
    onPartial(cb): () => void {
      partialListeners.add(cb)
      return () => {
        partialListeners.delete(cb)
      }
    },
    onFinal(cb): () => void {
      finalListeners.add(cb)
      return () => {
        finalListeners.delete(cb)
      }
    },
    onError(cb): () => void {
      errorListeners.add(cb)
      return () => {
        errorListeners.delete(cb)
      }
    },
    get isRunning(): boolean {
      return running
    },
  }
}
