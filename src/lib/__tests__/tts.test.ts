import { describe, expect, it, vi } from 'vitest'
import {
  createTts,
  type SpeechSynthesisLike,
  type TtsDeps,
  type TtsUtteranceLike,
} from '../tts'

function makeFakeSynth(): {
  synth: SpeechSynthesisLike
  utterances: TtsUtteranceLike[]
  setSpeaking: (v: boolean) => void
} {
  let speaking = false
  let paused = false
  const utterances: TtsUtteranceLike[] = []
  const synth: SpeechSynthesisLike = {
    speak: vi.fn((u: TtsUtteranceLike) => {
      utterances.push(u)
      speaking = true
    }),
    cancel: vi.fn(() => {
      speaking = false
      paused = false
    }),
    pause: vi.fn(() => {
      paused = true
    }),
    resume: vi.fn(() => {
      paused = false
    }),
    get speaking() {
      return speaking
    },
    get paused() {
      return paused
    },
  }
  return {
    synth,
    utterances,
    setSpeaking: (v) => {
      speaking = v
    },
  }
}

function makeDeps(): {
  deps: TtsDeps
  state: ReturnType<typeof makeFakeSynth>
  runHeartbeat: () => void
} {
  const state = makeFakeSynth()
  let heartbeatCb: (() => void) | null = null
  return {
    deps: {
      synthesis: state.synth,
      createUtterance: (text) => ({
        text,
        onend: null,
        onerror: null,
        onboundary: null,
      }),
      scheduler: {
        setInterval: (cb) => {
          heartbeatCb = cb
          return 42 as unknown as ReturnType<typeof setInterval>
        },
        clearInterval: () => {
          heartbeatCb = null
        },
      },
    },
    state,
    runHeartbeat: () => {
      heartbeatCb?.()
    },
  }
}

describe('createTts', () => {
  it('speak passes an utterance to the synthesis layer', async () => {
    const { deps, state } = makeDeps()
    const tts = createTts(deps)
    const p = tts.speak('hello world')
    expect(state.utterances).toHaveLength(1)
    expect(state.utterances[0]!.text).toBe('hello world')
    state.utterances[0]!.onend?.()
    await p
  })

  it('resolves the speak promise when the utterance ends', async () => {
    const { deps, state } = makeDeps()
    const tts = createTts(deps)
    const ended = vi.fn()
    tts.onEnd(ended)
    const p = tts.speak('x')
    state.setSpeaking(false)
    state.utterances[0]!.onend?.()
    await p
    expect(ended).toHaveBeenCalledTimes(1)
  })

  it('stopAll calls cancel synchronously and clears speaking flag', () => {
    const { deps, state } = makeDeps()
    const tts = createTts(deps)
    void tts.speak('long text')
    expect(tts.isSpeaking).toBe(true)
    tts.stopAll()
    expect(state.synth.cancel).toHaveBeenCalledTimes(1)
    expect(tts.isSpeaking).toBe(false)
  })

  it('heartbeat pauses+resumes only while actively speaking', () => {
    const { deps, state, runHeartbeat } = makeDeps()
    const tts = createTts(deps)
    void tts.speak('keep going')
    // Engine is speaking and not paused → heartbeat should toggle.
    runHeartbeat()
    expect(state.synth.pause).toHaveBeenCalledTimes(1)
    expect(state.synth.resume).toHaveBeenCalledTimes(1)
    // Stop, then run heartbeat again — should NOT toggle.
    tts.stopAll()
    runHeartbeat()
    expect(state.synth.pause).toHaveBeenCalledTimes(1)
  })

  it('boundary events fan out to onBoundary listeners', async () => {
    const { deps, state } = makeDeps()
    const tts = createTts(deps)
    const seen: number[] = []
    tts.onBoundary((i) => seen.push(i))
    const p = tts.speak('sentence one.')
    state.utterances[0]!.onboundary?.(12)
    state.utterances[0]!.onend?.()
    await p
    expect(seen).toEqual([12])
  })

  it('errors fan out and do not block end resolution', async () => {
    const { deps, state } = makeDeps()
    const tts = createTts(deps)
    const errors: string[] = []
    tts.onError((m) => errors.push(m))
    const p = tts.speak('boom')
    state.utterances[0]!.onerror?.('synthesis-failed')
    state.utterances[0]!.onend?.()
    await p
    expect(errors).toEqual(['synthesis-failed'])
  })
})
