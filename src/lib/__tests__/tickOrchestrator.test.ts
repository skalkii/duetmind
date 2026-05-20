import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTickOrchestrator,
  type TickOrchestratorDeps,
} from '../tickOrchestrator'
import { useConversationStore } from '../../state/conversationStore'
import type { AudioMeter } from '../audio'
import type { Stt } from '../stt'
import type { Tts } from '../tts'
import type { TickDecision } from '../../types/protocol'

interface Harness {
  deps: TickOrchestratorDeps
  emitRms(rms: number): void
  emitPartial(text: string): void
  emitFinal(text: string): void
  emitTtsEnd(): void
  tick(): Promise<void>
  ttsSpeak: ReturnType<typeof vi.fn>
  ttsStopAll: ReturnType<typeof vi.fn>
  nowAdvance(ms: number): void
}

/** Flush enough microtasks for the decision Promise + .then handler. */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve()
}

function makeHarness(): Harness {
  let now = 0
  const nowFn = (): number => now

  let scheduled: (() => void) | null = null
  let levelCb: ((rms: number) => void) | null = null
  let partialCb: ((text: string) => void) | null = null
  let finalCb: ((text: string) => void) | null = null
  let ttsEndCb: (() => void) | null = null

  const ttsSpeak = vi.fn(async () => undefined)
  const ttsStopAll = vi.fn()

  const audio: Pick<AudioMeter, 'onLevel'> = {
    onLevel: (cb) => {
      levelCb = cb
      return () => {
        levelCb = null
      }
    },
  }
  const stt: Pick<Stt, 'onPartial' | 'onFinal' | 'onError'> = {
    onPartial: (cb) => {
      partialCb = cb
      return () => {
        partialCb = null
      }
    },
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

  return {
    deps: {
      store: { getState: () => useConversationStore.getState() },
      audio,
      stt,
      tts,
      now: nowFn,
      scheduler: {
        setInterval: (cb) => {
          scheduled = cb
          return 1 as unknown as ReturnType<typeof setInterval>
        },
        clearInterval: () => {
          scheduled = null
        },
      },
    },
    emitRms: (rms) => levelCb?.(rms),
    emitPartial: (t) => partialCb?.(t),
    emitFinal: (t) => finalCb?.(t),
    emitTtsEnd: () => ttsEndCb?.(),
    tick: async () => {
      scheduled?.()
      await flush()
    },
    ttsSpeak,
    ttsStopAll,
    nowAdvance: (ms) => {
      now += ms
    },
  }
}

beforeEach(() => {
  useConversationStore.getState().reset()
})

describe('createTickOrchestrator', () => {
  it('flips userSpeaking on audio level crossings', () => {
    const h = makeHarness()
    const orch = createTickOrchestrator(h.deps)
    orch.start()
    h.emitRms(0.5)
    expect(useConversationStore.getState().userSpeaking).toBe(true)
    h.emitRms(0)
    expect(useConversationStore.getState().userSpeaking).toBe(false)
  })

  it('routes stt partials + finals into the store', () => {
    const h = makeHarness()
    const orch = createTickOrchestrator(h.deps)
    orch.start()
    h.emitPartial('hello wor')
    expect(useConversationStore.getState().userTranscriptPartial).toBe(
      'hello wor',
    )
    h.nowAdvance(100)
    h.emitFinal('hello world')
    const s = useConversationStore.getState()
    expect(s.userTranscriptFinal).toBe('hello world')
    expect(s.userTranscriptPartial).toBe('')
    expect(s.userLastSpokeAt).toBe(100)
  })

  it('emits a backchannel after 3s of sustained user speech', async () => {
    const h = makeHarness()
    const decisions: TickDecision[] = []
    const orch = createTickOrchestrator(h.deps, {
      random: () => 0,
      onTick: (d) => decisions.push(d),
    })
    orch.start()
    h.nowAdvance(1000)
    h.emitRms(0.5)
    h.nowAdvance(3500)
    h.emitRms(0.5)
    await h.tick()
    const last = decisions[decisions.length - 1]!
    expect(last.action).toBe('backchannel')
    expect(h.ttsSpeak).toHaveBeenCalled()
    expect(useConversationStore.getState().lastBackchannelAt).not.toBeNull()
  })

  it('barges in when user starts speaking while self speaks', async () => {
    const h = makeHarness()
    const orch = createTickOrchestrator(h.deps, { random: () => 0 })
    orch.start()
    useConversationStore.getState().setSelfSpeaking(true)
    h.emitRms(0.5)
    await h.tick()
    expect(h.ttsStopAll).toHaveBeenCalledTimes(1)
    expect(useConversationStore.getState().selfSpeaking).toBe(false)
  })

  it('kicks off a fast reply after 700ms silence + final transcript', async () => {
    const h = makeHarness()
    const orch = createTickOrchestrator(h.deps, { random: () => 0 })
    orch.start()
    h.emitRms(0.5)
    h.emitFinal('what time is it')
    h.emitRms(0)
    h.nowAdvance(800)
    await h.tick()
    const s = useConversationStore.getState()
    expect(s.replyInFlight).toBe(true)
    expect(s.selfSpeaking).toBe(true)
    expect(h.ttsSpeak).toHaveBeenCalledTimes(1)
  })

  it('does not start a second fast reply while one is in flight', async () => {
    const h = makeHarness()
    const orch = createTickOrchestrator(h.deps, { random: () => 0 })
    orch.start()
    h.emitFinal('hello')
    h.nowAdvance(1500)
    await h.tick()
    expect(h.ttsSpeak).toHaveBeenCalledTimes(1)
    await h.tick()
    expect(h.ttsSpeak).toHaveBeenCalledTimes(1)
  })

  it('clears selfSpeaking + replyInFlight when tts ends', async () => {
    const h = makeHarness()
    const orch = createTickOrchestrator(h.deps, { random: () => 0 })
    orch.start()
    h.emitFinal('hi')
    h.nowAdvance(1000)
    await h.tick()
    expect(useConversationStore.getState().replyInFlight).toBe(true)
    h.emitTtsEnd()
    const s = useConversationStore.getState()
    expect(s.selfSpeaking).toBe(false)
    expect(s.replyInFlight).toBe(false)
  })

  it('stop() detaches listeners and clears the interval', () => {
    const h = makeHarness()
    const orch = createTickOrchestrator(h.deps)
    orch.start()
    expect(orch.isRunning).toBe(true)
    orch.stop()
    expect(orch.isRunning).toBe(false)
    h.emitRms(0.5)
    expect(useConversationStore.getState().userSpeaking).toBe(false)
  })

  it('incrementTick monotonically advances per tick', async () => {
    const h = makeHarness()
    const orch = createTickOrchestrator(h.deps)
    orch.start()
    await h.tick()
    await h.tick()
    await h.tick()
    expect(useConversationStore.getState().tickCount).toBe(3)
  })

  it('drops a tick if the previous decision has not resolved yet', async () => {
    const h = makeHarness()
    // Stuck decision source — never resolves
    const stuck: TickOrchestratorDeps['decisionSource'] = {
      decide: () => new Promise<TickDecision>(() => undefined),
      dispose: () => undefined,
    }
    const orch = createTickOrchestrator({
      ...h.deps,
      decisionSource: stuck,
    })
    orch.start()
    await h.tick() // fires once, stays in-flight forever
    await h.tick() // dropped
    await h.tick() // dropped
    expect(useConversationStore.getState().tickCount).toBe(1)
  })

  it('reports barge-in latency from audio edge to stopAll', async () => {
    const h = makeHarness()
    const latencies: number[] = []
    const orch = createTickOrchestrator(h.deps, {
      random: () => 0,
      onBargeInLatency: (ms) => latencies.push(ms),
    })
    orch.start()
    useConversationStore.getState().setSelfSpeaking(true)
    h.nowAdvance(1_000)
    h.emitRms(0.5) // arm
    h.nowAdvance(73) // simulate worst-case 73ms before interrupt_self runs
    await h.tick()
    expect(latencies).toHaveLength(1)
    expect(latencies[0]).toBe(73)
  })

  it('does not report latency when user speaks while self is silent', async () => {
    const h = makeHarness()
    const latencies: number[] = []
    const orch = createTickOrchestrator(h.deps, {
      random: () => 0,
      onBargeInLatency: (ms) => latencies.push(ms),
    })
    orch.start()
    // selfSpeaking stays false — no arming
    h.emitRms(0.5)
    h.nowAdvance(50)
    await h.tick()
    expect(latencies).toHaveLength(0)
  })

  it('disarms the latency stopwatch on a falling-edge silence', async () => {
    const h = makeHarness()
    const latencies: number[] = []
    const orch = createTickOrchestrator(h.deps, {
      random: () => 0,
      onBargeInLatency: (ms) => latencies.push(ms),
    })
    orch.start()
    useConversationStore.getState().setSelfSpeaking(true)
    h.emitRms(0.5) // arm
    h.emitRms(0) // user stops — disarm
    // re-arm fresh, this time we run interrupt_self
    useConversationStore.getState().setSelfSpeaking(true)
    h.nowAdvance(500)
    h.emitRms(0.5)
    h.nowAdvance(20)
    await h.tick()
    expect(latencies).toEqual([20])
  })
})
