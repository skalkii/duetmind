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
  tick(): void
  ttsSpeak: ReturnType<typeof vi.fn>
  ttsStopAll: ReturnType<typeof vi.fn>
  nowAdvance(ms: number): void
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
    tick: () => scheduled?.(),
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

  it('emits a backchannel after 3s of sustained user speech', () => {
    const h = makeHarness()
    const decisions: TickDecision[] = []
    const orch = createTickOrchestrator(h.deps, {
      random: () => 0, // pass rate gate + pick first phrase
      onTick: (d) => decisions.push(d),
    })
    orch.start()
    h.nowAdvance(1000)
    h.emitRms(0.5)
    h.nowAdvance(3500)
    // keep user speaking — re-trigger rms above threshold
    h.emitRms(0.5)
    h.tick()
    const last = decisions[decisions.length - 1]!
    expect(last.action).toBe('backchannel')
    expect(h.ttsSpeak).toHaveBeenCalled()
    expect(useConversationStore.getState().lastBackchannelAt).not.toBeNull()
  })

  it('barges in when user starts speaking while self speaks', () => {
    const h = makeHarness()
    const orch = createTickOrchestrator(h.deps, { random: () => 0 })
    orch.start()
    // Force selfSpeaking = true via store
    useConversationStore.getState().setSelfSpeaking(true)
    h.emitRms(0.5)
    h.tick()
    expect(h.ttsStopAll).toHaveBeenCalledTimes(1)
    expect(useConversationStore.getState().selfSpeaking).toBe(false)
  })

  it('kicks off a fast reply after 700ms silence + final transcript', () => {
    const h = makeHarness()
    const orch = createTickOrchestrator(h.deps, { random: () => 0 })
    orch.start()
    // user speaks then stops
    h.emitRms(0.5)
    h.emitFinal('what time is it')
    h.emitRms(0)
    h.nowAdvance(800)
    h.tick()
    const s = useConversationStore.getState()
    expect(s.replyInFlight).toBe(true)
    expect(s.selfSpeaking).toBe(true)
    expect(h.ttsSpeak).toHaveBeenCalledTimes(1)
  })

  it('does not start a second fast reply while one is in flight', () => {
    const h = makeHarness()
    const orch = createTickOrchestrator(h.deps, { random: () => 0 })
    orch.start()
    h.emitFinal('hello')
    h.nowAdvance(1500)
    h.tick()
    expect(h.ttsSpeak).toHaveBeenCalledTimes(1)
    h.tick()
    expect(h.ttsSpeak).toHaveBeenCalledTimes(1) // suppressed by replyInFlight
  })

  it('clears selfSpeaking + replyInFlight when tts ends', () => {
    const h = makeHarness()
    const orch = createTickOrchestrator(h.deps, { random: () => 0 })
    orch.start()
    h.emitFinal('hi')
    h.nowAdvance(1000)
    h.tick()
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
    // After stop, audio events should not mutate state.
    h.emitRms(0.5)
    expect(useConversationStore.getState().userSpeaking).toBe(false)
  })

  it('incrementTick monotonically advances per tick', () => {
    const h = makeHarness()
    const orch = createTickOrchestrator(h.deps)
    orch.start()
    h.tick()
    h.tick()
    h.tick()
    expect(useConversationStore.getState().tickCount).toBe(3)
  })
})
