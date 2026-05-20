import { describe, expect, it, vi } from 'vitest'
import { computeRms, createAudioMeter, type AudioMeterDeps } from '../audio'

describe('computeRms', () => {
  it('returns 0 for an empty buffer', () => {
    expect(computeRms(new Float32Array(0))).toBe(0)
  })

  it('returns 0 for pure silence', () => {
    expect(computeRms(new Float32Array(256))).toBe(0)
  })

  it('returns 1 for full-scale DC', () => {
    const buf = new Float32Array(256).fill(1)
    expect(computeRms(buf)).toBeCloseTo(1, 6)
  })

  it('returns ~sqrt(0.5) for full-scale sine', () => {
    const N = 1024
    const buf = new Float32Array(N)
    for (let i = 0; i < N; i++) buf[i] = Math.sin((2 * Math.PI * i) / N)
    expect(computeRms(buf)).toBeCloseTo(Math.SQRT1_2, 3)
  })

  it('mixed signed samples square correctly', () => {
    const buf = new Float32Array([1, -1, 0.5, -0.5])
    // mean(sq) = (1 + 1 + 0.25 + 0.25) / 4 = 0.625
    expect(computeRms(buf)).toBeCloseTo(Math.sqrt(0.625), 6)
  })
})

interface FakeAudio {
  context: {
    createAnalyser: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
  }
  tracks: Array<{ stop: ReturnType<typeof vi.fn> }>
  fakeBuffer: Float32Array
  scheduler: {
    runNextTick(): void
  }
  deps: AudioMeterDeps
}

function makeFakeAudio(): FakeAudio {
  const tracks = [{ stop: vi.fn() }]
  const stream = {
    getTracks: () => tracks,
  } as unknown as MediaStream

  // Buffer the meter will read from each tick.
  const fakeBuffer = new Float32Array(2048)
  const analyser = {
    fftSize: 2048,
    getFloatTimeDomainData: (out: Float32Array) => {
      out.set(fakeBuffer.subarray(0, out.length))
    },
  } as unknown as AnalyserNode

  const context = {
    createMediaStreamSource: () => ({ connect: vi.fn() }),
    createAnalyser: vi.fn(() => analyser),
    close: vi.fn(() => Promise.resolve()),
  }

  let scheduled: (() => void) | null = null
  const scheduler = {
    setInterval: (cb: () => void) => {
      scheduled = cb
      return 1 as unknown as ReturnType<typeof setInterval>
    },
    clearInterval: () => {
      scheduled = null
    },
  }

  return {
    context,
    tracks,
    fakeBuffer,
    scheduler: {
      runNextTick: () => {
        if (scheduled) scheduled()
      },
    },
    deps: {
      getUserMedia: vi.fn(async () => stream),
      createAudioContext: () => context as unknown as AudioContext,
      scheduler,
    },
  }
}

describe('createAudioMeter', () => {
  it('starts, samples buffer, and emits RMS to listeners', async () => {
    const fake = makeFakeAudio()
    // Encode a unit-amplitude constant — RMS = 1.
    fake.fakeBuffer.fill(1)
    const meter = createAudioMeter(fake.deps, { sampleIntervalMs: 50 })
    const seen: number[] = []
    meter.onLevel((rms) => seen.push(rms))

    await meter.start()
    expect(meter.isRunning).toBe(true)
    fake.scheduler.runNextTick()
    fake.scheduler.runNextTick()
    expect(seen.length).toBe(2)
    expect(seen.every((v) => Math.abs(v - 1) < 1e-6)).toBe(true)
    expect(meter.getRms()).toBeCloseTo(1, 6)
  })

  it('stop tears down stream + context + clears running flag', async () => {
    const fake = makeFakeAudio()
    const meter = createAudioMeter(fake.deps)
    await meter.start()
    meter.stop()
    expect(fake.tracks[0]!.stop).toHaveBeenCalledTimes(1)
    expect(fake.context.close).toHaveBeenCalledTimes(1)
    expect(meter.isRunning).toBe(false)
    expect(meter.getRms()).toBe(0)
  })

  it('start is idempotent — second call is a no-op', async () => {
    const fake = makeFakeAudio()
    const meter = createAudioMeter(fake.deps)
    await meter.start()
    await meter.start()
    expect(fake.deps.getUserMedia).toHaveBeenCalledTimes(1)
  })

  it('onLevel unsubscribe stops further calls', async () => {
    const fake = makeFakeAudio()
    fake.fakeBuffer.fill(0.5)
    const meter = createAudioMeter(fake.deps)
    const seen: number[] = []
    const off = meter.onLevel((rms) => seen.push(rms))
    await meter.start()
    fake.scheduler.runNextTick()
    off()
    fake.scheduler.runNextTick()
    expect(seen).toHaveLength(1)
  })
})
