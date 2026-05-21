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
  emitTtsEnd(): void
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
  let ttsEndCb: (() => void) | null = null

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
    onEnd: (cb) => {
      ttsEndCb = cb
      return () => {
        ttsEndCb = null
      }
    },
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
    emitTtsEnd: () => ttsEndCb?.(),
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
    expect(opts.messages.length).toBeGreaterThan(0)
    expect(opts.messages.at(-1)?.content).toBe('what time is it')
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
    // User barges in while self is speaking — sustain past the min guard
    useConversationStore.getState().setSelfSpeaking(true)
    h.emitRms(0.5)
    h.nowAdvance(300)
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

describe('orchestrator handoff state machine', () => {
  it('start_fast_reply commits the user turn to history + clears transcript', async () => {
    const h = makeHarness()
    const orch = createTickOrchestrator(h.deps, { random: () => 0 })
    orch.start()
    h.emitFinal('hello world')
    h.nowAdvance(1000)
    await h.tick()
    const s = useConversationStore.getState()
    expect(s.messages).toHaveLength(1)
    expect(s.messages[0]).toMatchObject({ role: 'user', text: 'hello world' })
    expect(s.userTranscriptFinal).toBe('')
  })

  it('hands off to slow reply when TTS ends after slow is ready', async () => {
    const h = makeHarness()
    const orch = createTickOrchestrator(h.deps, { random: () => 0 })
    orch.start()
    h.emitFinal('what time is it')
    h.nowAdvance(1000)
    await h.tick()
    // Fast stall TTS started — speak count == 1
    expect(h.ttsSpeak).toHaveBeenCalledTimes(1)
    // Stream a complete slow reply BEFORE the stall ends
    h.emitToken('It is two in the afternoon.')
    expect(useConversationStore.getState().slowReplyReady).toBe(true)
    // Fast stall TTS finishes
    h.emitTtsEnd()
    // Slow reply should be queued as a new TTS speak
    expect(h.ttsSpeak).toHaveBeenCalledTimes(2)
    expect(h.ttsSpeak.mock.calls[1]![0]).toBe('It is two in the afternoon.')
    // Self speaking should still be true (handoff keeps the turn alive)
    expect(useConversationStore.getState().selfSpeaking).toBe(true)
    expect(useConversationStore.getState().replyInFlight).toBe(true)
  })

  it('streams in slow reply mid-stall then hands off as soon as fast TTS ends', async () => {
    const h = makeHarness()
    const orch = createTickOrchestrator(h.deps, { random: () => 0 })
    orch.start()
    h.emitFinal('hi')
    h.nowAdvance(1000)
    await h.tick()
    h.emitToken('Hello')
    h.emitToken(' there') // no boundary yet
    expect(h.ttsSpeak).toHaveBeenCalledTimes(1) // only fast stall so far
    h.emitToken('.')
    // Even with boundary, TTS still speaking → no extra speak yet
    expect(h.ttsSpeak).toHaveBeenCalledTimes(1)
    h.emitTtsEnd() // fast stall ends → handoff
    expect(h.ttsSpeak).toHaveBeenCalledTimes(2)
    expect(h.ttsSpeak.mock.calls[1]![0]).toBe('Hello there.')
  })

  it('hands off immediately if slow boundary lands after stall already ended', async () => {
    const h = makeHarness()
    const orch = createTickOrchestrator(h.deps, { random: () => 0 })
    orch.start()
    h.emitFinal('hi')
    h.nowAdvance(1000)
    await h.tick()
    // Fast stall finishes before any tokens arrive
    h.emitTtsEnd()
    // Self speaking turned off, but reply still in flight (no handoff yet)
    expect(useConversationStore.getState().selfSpeaking).toBe(false)
    // Tokens trickle in after stall ended — first boundary triggers handoff
    h.emitToken('Two pm.')
    expect(h.ttsSpeak).toHaveBeenCalledTimes(2)
    expect(h.ttsSpeak.mock.calls[1]![0]).toBe('Two pm.')
  })

  it('after slow TTS ends, commits assistant message and closes the turn', async () => {
    const h = makeHarness()
    const orch = createTickOrchestrator(h.deps, { random: () => 0 })
    orch.start()
    h.emitFinal('hi')
    h.nowAdvance(1000)
    await h.tick()
    h.emitToken('Two pm.')
    h.emitTtsEnd() // fast → handoff (slow sentence dispatched)
    h.emitDone() // generator done, no more tokens
    h.emitTtsEnd() // slow sentence finished speaking
    const s = useConversationStore.getState()
    expect(s.selfSpeaking).toBe(false)
    expect(s.replyInFlight).toBe(false)
    const assistant = s.messages.find((m) => m.role === 'assistant')
    expect(assistant).toMatchObject({ text: 'Two pm.', source: 'slow' })
  })

  it('does not hand off twice for the same reply turn', async () => {
    const h = makeHarness()
    const orch = createTickOrchestrator(h.deps, { random: () => 0 })
    orch.start()
    h.emitFinal('hi')
    h.nowAdvance(1000)
    await h.tick()
    h.emitToken('First.')
    h.emitTtsEnd() // handoff → speak count 2
    h.emitToken(' Second.') // arriving after handoff — should not trigger another speak
    expect(h.ttsSpeak).toHaveBeenCalledTimes(2)
  })

  it('speaks subsequent sentences after first handoff (no truncation)', async () => {
    const h = makeHarness()
    const orch = createTickOrchestrator(h.deps, { random: () => 0 })
    orch.start()
    h.emitFinal('hi')
    h.nowAdvance(1000)
    await h.tick()
    h.emitToken('First.')
    h.emitToken(' Second.')
    h.emitToken(' Third.')
    h.emitTtsEnd() // fast stall ends → "First." dispatched
    expect(h.ttsSpeak).toHaveBeenCalledTimes(2)
    expect(h.ttsSpeak.mock.calls[1]![0]).toBe('First.')
    h.emitTtsEnd() // "First." finished → "Second." dispatched
    expect(h.ttsSpeak).toHaveBeenCalledTimes(3)
    expect(h.ttsSpeak.mock.calls[2]![0]).toBe('Second.')
    h.emitTtsEnd() // "Second." finished → "Third." dispatched
    expect(h.ttsSpeak).toHaveBeenCalledTimes(4)
    expect(h.ttsSpeak.mock.calls[3]![0]).toBe('Third.')
    h.emitDone()
    h.emitTtsEnd() // "Third." finished, generator done → close turn
    const s = useConversationStore.getState()
    expect(s.replyInFlight).toBe(false)
    const assistant = s.messages.find((m) => m.role === 'assistant')
    expect(assistant?.text).toBe('First. Second. Third.')
  })

  it('flushes unspoken tail without a sentence boundary on onDone', async () => {
    const h = makeHarness()
    const orch = createTickOrchestrator(h.deps, { random: () => 0 })
    orch.start()
    h.emitFinal('hi')
    h.nowAdvance(1000)
    await h.tick()
    h.emitToken('no punctuation here') // no boundary
    h.emitTtsEnd() // fast stall ends; nothing dispatched yet (no boundary, gen still active)
    expect(h.ttsSpeak).toHaveBeenCalledTimes(1)
    h.emitDone() // gen done → flush tail as final chunk
    expect(h.ttsSpeak).toHaveBeenCalledTimes(2)
    expect(h.ttsSpeak.mock.calls[1]![0]).toBe('no punctuation here')
  })

  it('turn-based mode skips the fast stall TTS and waits for slow boundary', async () => {
    const h = makeHarness()
    const orch = createTickOrchestrator(h.deps, {
      random: () => 0,
      config: {
        bargeInEnabled: false,
        backchannelEnabled: false,
        fastStallEnabled: false,
      },
    })
    orch.start()
    h.emitFinal('hi')
    h.nowAdvance(1000)
    await h.tick()
    // No fast stall TTS — speak count must stay at zero until slow ready.
    expect(h.ttsSpeak).toHaveBeenCalledTimes(0)
    expect(h.slowGenerate).toHaveBeenCalledTimes(1)
    // Slow finishes a sentence → handoff fires immediately because we're
    // not selfSpeaking (no stall was queued).
    h.emitToken('Hello there.')
    expect(h.ttsSpeak).toHaveBeenCalledTimes(1)
    expect(h.ttsSpeak.mock.calls[0]![0]).toBe('Hello there.')
  })
})
