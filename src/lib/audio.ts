/**
 * Mic capture + RMS-based level meter.
 *
 * Pure RMS calc is exported separately so unit tests don't need WebAudio.
 * The factory accepts injectable deps — production wires browser APIs,
 * tests pass fakes.
 */

const DEFAULT_FFT_SIZE = 1024
const DEFAULT_SAMPLE_INTERVAL_MS = 50

export function computeRms(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sumSq = 0
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i] ?? 0
    sumSq += s * s
  }
  return Math.sqrt(sumSq / samples.length)
}

export interface AudioMeter {
  start(): Promise<void>
  stop(): void
  getRms(): number
  onLevel(cb: (rms: number) => void): () => void
  readonly isRunning: boolean
}

export class UnsupportedAudioError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedAudioError'
  }
}

export interface AudioMeterDeps {
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>
  createAudioContext: () => AudioContext
  scheduler: {
    setInterval: (cb: () => void, ms: number) => ReturnType<typeof setInterval>
    clearInterval: (handle: ReturnType<typeof setInterval>) => void
  }
}

export interface AudioMeterOptions {
  readonly fftSize?: number
  readonly sampleIntervalMs?: number
}

type WindowWithWebkitAudio = Window & {
  webkitAudioContext?: typeof AudioContext
}

export function defaultAudioDeps(): AudioMeterDeps {
  if (
    typeof navigator === 'undefined' ||
    !navigator.mediaDevices?.getUserMedia
  ) {
    throw new UnsupportedAudioError(
      'navigator.mediaDevices.getUserMedia is unavailable',
    )
  }
  const w = window as WindowWithWebkitAudio
  const AC = window.AudioContext ?? w.webkitAudioContext
  if (!AC) {
    throw new UnsupportedAudioError('AudioContext is unavailable')
  }
  return {
    // Always ask the browser to apply echo cancellation, noise suppression,
    // and auto gain. Without echo cancellation, the assistant's own TTS
    // bleeds back into the mic and trips false barge-ins / STT pollution.
    getUserMedia: (c) =>
      navigator.mediaDevices.getUserMedia({
        ...c,
        audio:
          c.audio === true || c.audio === undefined
            ? {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
              }
            : { echoCancellation: true, noiseSuppression: true, ...c.audio },
      }),
    createAudioContext: () => new AC(),
    scheduler: {
      setInterval: (cb, ms) => setInterval(cb, ms),
      clearInterval: (h) => clearInterval(h),
    },
  }
}

export function createAudioMeter(
  deps: AudioMeterDeps = defaultAudioDeps(),
  options: AudioMeterOptions = {},
): AudioMeter {
  const fftSize = options.fftSize ?? DEFAULT_FFT_SIZE
  const sampleIntervalMs =
    options.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS

  let stream: MediaStream | null = null
  let context: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  let buffer: Float32Array<ArrayBuffer> | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let lastRms = 0
  let running = false
  const listeners = new Set<(rms: number) => void>()

  const tick = (): void => {
    if (!analyser || !buffer) return
    analyser.getFloatTimeDomainData(buffer)
    lastRms = computeRms(buffer)
    for (const l of listeners) l(lastRms)
  }

  return {
    async start(): Promise<void> {
      if (running) return
      stream = await deps.getUserMedia({ audio: true })
      context = deps.createAudioContext()
      const source = context.createMediaStreamSource(stream)
      analyser = context.createAnalyser()
      analyser.fftSize = fftSize
      source.connect(analyser)
      buffer = new Float32Array(analyser.fftSize)
      timer = deps.scheduler.setInterval(tick, sampleIntervalMs)
      running = true
    },
    stop(): void {
      if (timer !== null) deps.scheduler.clearInterval(timer)
      timer = null
      if (stream) {
        for (const track of stream.getTracks()) track.stop()
      }
      stream = null
      if (context) void context.close().catch(() => undefined)
      context = null
      analyser = null
      buffer = null
      lastRms = 0
      running = false
    },
    getRms(): number {
      return lastRms
    },
    onLevel(cb): () => void {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    get isRunning(): boolean {
      return running
    },
  }
}
