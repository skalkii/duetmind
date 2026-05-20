/**
 * T4.3 wiring tests — orchestrator <-> slow brain.
 *
 * Kept separate from the base orchestrator suite so the harness can include
 * a slowBrain fake without leaking that surface into tests that don't care.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTickOrchestrator,
  type TickOrchestratorDeps,
} from '../tickOrchestrator'
import { useConversationStore } from '../../state/conversationStore'
import type { AudioMeter } from '../audio'
import type { Stt } from '../stt'
import type { Tts } from '../tts'
import type { SlowBrain, SlowGenerateOptions } from '../slowBrainClient'

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve()
}

interface SlowHarness {
  deps: TickOrchestratorDeps
  emitRms(rms: number): void
  emitFinal(text: string): void
  tick(): Promise<void>
  ttsSpeak: ReturnType<typeof vi.fn>
  ttsStopAll: ReturnType<typeof vi.fn>
  slowGenerate: ReturnType<typeof vi.fn>
  emitToken(text: string): void
  emitDone(): void
  abortSpy: ReturnType<typeof vi.fn>
  nowAdvance(ms: number): void
}

function makeHarness(): SlowHarness {
  let now = 0
  let scheduled: (() => void) | null = null
  let levelCb: ((rms: number) => void) | null = null
  let finalCb: ((text: string) => void) | null = null

  const ttsSpeak = vi.fn(async () => undefined)
  const ttsStopAll = vi.fn()
  const abortSpy = vi.fn()
  let lastOptions: SlowGenerateOptions | null = null
  let runId = 0

  const slowGenerate = vi.fn((options: SlowGenerateOptions) => {
    lastOptions = options
    runId += 1
    return {
      runId: `run-${runId}`,
      abort: abortSpy,
    }
  })

  const audio: Pick<AudioMeter, 'onLevel'> = {
    onLevel: (cb) => {
      levelCb = cb
      return () => {
        levelCb = null
      }
    },
  }
  const stt: Pick<Stt, 'onPartial' | 'onFinal' | 'onError'> = {
    onPartial: () => () => undefined,
    onFinal: (cb) => {
      finalCb = cb
      return () => {
        finalCb = null
      }
    },
    onError: () => () => undefined,
  }
  const tts: Pick<Tts, 'speak' | 'stopAll' | 'onEnd' | 'onError'> = {
    speak: ttsSpeak,
    stopAll: ttsStopAll,
    onEnd: () => () => undefined,
    onError: () => () => undefined,
  }
  const slowBrain: Pick<SlowBrain, 'generate'> = {
    generate: slowGenerate as unknown as SlowBrain['generate'],
  }

  return {
    deps: {
      store: { getState: () => useConversationStore.getState() },
      audio,
      stt,
      tts,
      now: () => now,
      scheduler: {
        setInterval: (cb) => {
          scheduled = cb
          return 1 as unknown as ReturnType<typeof setInterval>
        },
        clearInterval: () => {
          scheduled = null
        },
      },
      slowBrain,
    },
    emitRms: (rms) => levelCb?.(rms),
    emitFinal: (t) => finalCb?.(t),
    tick: async () => {
      scheduled?.()
      await flush()
    },
    ttsSpeak,
    ttsStopAll,
    slowGenerate,
    emitToken: (text) => lastOptions?.onToken?.(text),
    emitDone: () => lastOptions?.onDone?.(),
    abortSpy,
    nowAdvance: (ms) => {
      now += ms
    },
  }
}

beforeEach(() => {
  useConversationStore.getState().reset()
})

describe('orchestrator <-> slow brain', () => {
  it('start_fast_reply also kicks off slow generation with chat messages', async () => {
    const h = makeHarness()
    const orch = createTickOrchestrator(h.deps, { random: () => 0 })
    orch.start()
    h.emitFinal('what time is it')
    h.nowAdvance(1000)
    await h.tick()
    expect(h.slowGenerate).toHaveBeenCalledTimes(1)
    const opts = h.slowGenerate.mock.calls[0]![0] as SlowGenerateOptions
    expect(opts.prompt.startsWith('[')).toBe(true)
    expect(opts.prompt).toContain('what time is it')
  })

  it('streamed tokens accumulate in the store as slowReplyText', async () => {
    const h = makeHarness()
    const orch = createTickOrchestrator(h.deps, { random: () => 0 })
    orch.start()
    h.emitFinal('hello')
    h.nowAdvance(1000)
    await h.tick()
    h.emitToken('Hello')
    h.emitToken(' there')
    expect(useConversationStore.getState().slowReplyText).toBe('Hello there')
    expect(useConversationStore.getState().slowReplyReady).toBe(false)
  })

  it('flips slowReplyReady the moment a token closes a sentence', async () => {
    const h = makeHarness()
    const orch = createTickOrchestrator(h.deps, { random: () => 0 })
    orch.start()
    h.emitFinal('hi')
    h.nowAdvance(1000)
    await h.tick()
    h.emitToken('Hello there')
    expect(useConversationStore.getState().slowReplyReady).toBe(false)
    h.emitToken('.')
    expect(useConversationStore.getState().slowReplyReady).toBe(true)
  })

  it('onDone forces slowReplyReady even without a punctuation boundary', async () => {
    const h = makeHarness()
    const orch = createTickOrchestrator(h.deps, { random: () => 0 })
    orch.start()
    h.emitFinal('hi')
    h.nowAdvance(1000)
    await h.tick()
    h.emitToken('just a fragment')
    h.emitDone()
    expect(useConversationStore.getState().slowReplyReady).toBe(true)
  })

  it('interrupt_self aborts the active slow generation + clears slowReply', async () => {
    const h = makeHarness()
    const orch = createTickOrchestrator(h.deps, { random: () => 0 })
    orch.start()
    h.emitFinal('hi')
    h.nowAdvance(1000)
    await h.tick()
    h.emitToken('partial')
    // User barges in while self is speaking
    useConversationStore.getState().setSelfSpeaking(true)
    h.emitRms(0.5)
    await h.tick()
    expect(h.ttsStopAll).toHaveBeenCalledTimes(1)
    expect(h.abortSpy).toHaveBeenCalledTimes(1)
    const s = useConversationStore.getState()
    expect(s.slowReplyText).toBeNull()
    expect(s.slowReplyReady).toBe(false)
  })

  it('stop() aborts an active slow generation', async () => {
    const h = makeHarness()
    const orch = createTickOrchestrator(h.deps, { random: () => 0 })
    orch.start()
    h.emitFinal('hi')
    h.nowAdvance(1000)
    await h.tick()
    orch.stop()
    expect(h.abortSpy).toHaveBeenCalledTimes(1)
  })
})
