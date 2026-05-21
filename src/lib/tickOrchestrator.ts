/**
 * 200ms tick orchestrator — the only place that wires audio/STT/TTS to the
 * conversation store and executes a TickDecision per tick.
 *
 * Responsibilities (and only these):
 *   - Subscribe to audio level + STT events + TTS lifecycle to keep the
 *     conversation store in sync with the world.
 *   - Every TICK_INTERVAL_MS, derive a TickInput, ask `decideTick` for an
 *     action, and dispatch through an action-executor map.
 *   - Run the fast→slow handoff state machine: when the slow reply is
 *     ready and the fast stall has finished, speak the slow reply as the
 *     same logical reply turn (no flicker, no double "reply done" edges).
 *
 * Anything else (model loading, prompt building) is somebody else's problem.
 */

import {
  createInlineDecisionSource,
  type DecisionSource,
} from './decisionSource'
import type { DecisionConfig } from './decisionRules'
import type { AudioMeter } from './audio'
import type { Stt } from './stt'
import type { Tts } from './tts'
import type { SlowBrain, SlowGenerateHandle } from './slowBrainClient'
import { buildChatMessages, isSentenceBoundary } from './prompt'
import {
  selectTickInput,
  type ConversationStore,
} from '../state/conversationStore'
import type { TickAction, TickDecision } from '../types/protocol'

export const TICK_INTERVAL_MS = 200
export const DEFAULT_SPEAKING_RMS = 0.01
/**
 * How long the audio meter can read sub-threshold before we treat the user
 * as no longer speaking. Normal speech has ~50-200ms inter-word silences;
 * without hangover, userSpeaking would flap every word and the sustained
 * 3s gate for backchannels could never fire.
 */
export const DEFAULT_SPEAKING_HANGOVER_MS = 350

export interface TickOrchestrator {
  start(): void
  stop(): void
  readonly isRunning: boolean
}

export interface TickOrchestratorDeps {
  store: { getState: () => ConversationStore }
  audio: Pick<AudioMeter, 'onLevel'>
  stt: Pick<Stt, 'onPartial' | 'onFinal' | 'onError'>
  tts: Pick<Tts, 'speak' | 'stopAll' | 'onEnd' | 'onError'>
  now: () => number
  scheduler: {
    setInterval: (cb: () => void, ms: number) => ReturnType<typeof setInterval>
    clearInterval: (h: ReturnType<typeof setInterval>) => void
  }
  /** Source of TickDecisions — defaults to inline `decideTick`. */
  decisionSource?: DecisionSource
  /** Optional slow brain — when present, fast replies kick off generation. */
  slowBrain?: Pick<SlowBrain, 'generate'>
}

export interface TickOrchestratorOptions {
  readonly tickIntervalMs?: number
  readonly speakingThreshold?: number
  readonly speakingHangoverMs?: number
  readonly random?: () => number
  readonly config?: Partial<DecisionConfig>
  /**
   * Per-tick config getter — resolved at every tick so debug-panel sliders
   * can move thresholds without restarting. Overrides `config` when set.
   */
  readonly getConfig?: () => Partial<DecisionConfig>
  readonly onTick?: (decision: TickDecision) => void
  /**
   * Fires once per barge-in: ms from the audio meter detecting the user's
   * rising edge (while we were speaking) to `tts.stopAll()` returning.
   * Spec target: < 200ms perceptual.
   */
  readonly onBargeInLatency?: (ms: number) => void
}

type ActionHandler<T extends TickAction> = (
  decision: Extract<TickDecision, { action: T }>,
) => void
type ActionHandlerMap = {
  [K in TickAction]: ActionHandler<K>
}

export function createTickOrchestrator(
  deps: TickOrchestratorDeps,
  options: TickOrchestratorOptions = {},
): TickOrchestrator {
  const tickIntervalMs = options.tickIntervalMs ?? TICK_INTERVAL_MS
  const speakingThreshold = options.speakingThreshold ?? DEFAULT_SPEAKING_RMS
  const speakingHangoverMs =
    options.speakingHangoverMs ?? DEFAULT_SPEAKING_HANGOVER_MS
  const random = options.random ?? Math.random
  const staticConfig = options.config ?? {}
  const resolveConfig = (): Partial<DecisionConfig> =>
    options.getConfig ? options.getConfig() : staticConfig
  const decisionSource =
    deps.decisionSource ?? createInlineDecisionSource({ random })
  const ownsDecisionSource = !deps.decisionSource

  let running = false
  let timer: ReturnType<typeof setInterval> | null = null
  let inFlightTickId = -1
  let activeGen: SlowGenerateHandle | null = null
  // Reply-turn flags. Reset on start_fast_reply and on interrupt_self.
  let slowGenActive = false
  let lastSpokenSlow = ''
  // Byte offset into store.slowReplyText that has already been handed to TTS.
  // Sentences are dispatched one at a time; this advances as we slice them
  // off. Reset to 0 on new turns / interrupts.
  let slowSpokenLen = 0
  // Barge-in latency arming. Set on the user-speaking rising edge while we
  // were already speaking; cleared after the interrupt is executed.
  let bargeInArmedAt: number | null = null
  // Hysteresis state — see audio.onLevel handler below.
  let lastVoiceFrameAt: number | null = null
  const unsubs: Array<() => void> = []

  const findSentenceEnd = (text: string): number => {
    const m = /[.!?](?=\s|$)/.exec(text)
    return m ? m.index : -1
  }

  const stopActiveGen = (): void => {
    if (activeGen) {
      activeGen.abort()
      activeGen = null
    }
  }

  const startSlowGen = (userText: string): void => {
    if (!deps.slowBrain) return
    const store = deps.store.getState()
    const messages = buildChatMessages(store.messages, userText)
    slowGenActive = true
    activeGen = deps.slowBrain.generate({
      messages,
      onToken: (text) => {
        deps.store.getState().appendSlowReply(text)
        const after = deps.store.getState()
        // Flip slowReplyReady once we have a full sentence so the fast→slow
        // handoff rule in decisionRules can fire. Sentence dispatch itself
        // is driven by dispatchNextSentence(), not this flag.
        if (
          !after.slowReplyReady &&
          isSentenceBoundary(after.slowReplyText ?? '')
        ) {
          after.markSlowReplyReady()
        }
        dispatchNextSentence()
      },
      onDone: () => {
        activeGen = null
        slowGenActive = false
        const s = deps.store.getState()
        if (!s.slowReplyReady && s.slowReplyText) s.markSlowReplyReady()
        // Flush any unspoken tail.
        if (!dispatchNextSentence() && !s.selfSpeaking) {
          if (
            s.replyInFlight &&
            (s.slowReplyText ?? '').length <= slowSpokenLen
          ) {
            finishReplyTurn()
          }
        }
      },
      onAborted: () => {
        activeGen = null
        slowGenActive = false
      },
      onError: () => {
        activeGen = null
        slowGenActive = false
      },
    })
  }

  /**
   * Pull the next sentence (or the remaining tail once the generator is
   * done) out of `store.slowReplyText` and hand it to TTS. Returns true
   * when a chunk was actually dispatched. No-ops if we're already
   * speaking, the reply turn is closed, or no boundary has arrived yet.
   */
  const dispatchNextSentence = (): boolean => {
    const s = deps.store.getState()
    if (!s.replyInFlight) return false
    if (s.selfSpeaking) return false
    const full = s.slowReplyText ?? ''
    if (full.length <= slowSpokenLen) return false
    const remaining = full.slice(slowSpokenLen)
    const endIdx = findSentenceEnd(remaining)
    let consume: number
    let chunk: string
    if (endIdx >= 0) {
      consume = endIdx + 1
      chunk = remaining.slice(0, consume).trim()
    } else if (!slowGenActive) {
      consume = remaining.length
      chunk = remaining.trim()
    } else {
      return false
    }
    slowSpokenLen += consume
    if (!chunk) return false
    lastSpokenSlow = lastSpokenSlow ? `${lastSpokenSlow} ${chunk}` : chunk
    s.setSelfSpeaking(true)
    void deps.tts.speak(chunk)
    return true
  }

  const finishReplyTurn = (): void => {
    const store = deps.store.getState()
    store.setSelfSpeaking(false)
    if (lastSpokenSlow) {
      store.appendMessage({
        role: 'assistant',
        text: lastSpokenSlow,
        ts: deps.now(),
        source: 'slow',
      })
    }
    store.clearSlowReply()
    if (store.replyInFlight) store.markReplyEnded()
    lastSpokenSlow = ''
    slowSpokenLen = 0
  }

  const handlers: ActionHandlerMap = {
    silent: () => undefined,
    backchannel: (d) => {
      const now = deps.now()
      deps.store.getState().markBackchannel(now)
      void deps.tts.speak(d.phrase)
    },
    start_fast_reply: (d) => {
      const store = deps.store.getState()
      const userText = store.userTranscriptFinal
      if (userText) {
        store.appendMessage({
          role: 'user',
          text: userText,
          ts: deps.now(),
        })
      }
      store.clearUserTranscript()
      store.markReplyStarted()
      slowSpokenLen = 0
      lastSpokenSlow = ''
      const cfg = resolveConfig()
      // Speak the fast stall only when the mode allows it. Turn-based mode
      // skips the stall and waits for the slow brain to produce a sentence
      // boundary before speaking — first token through maybeHandoff().
      if (cfg.fastStallEnabled !== false) {
        store.setSelfSpeaking(true)
        void deps.tts.speak(d.phrase)
      }
      startSlowGen(userText)
    },
    request_slow_reply: () => {
      const store = deps.store.getState()
      startSlowGen(store.userTranscriptFinal)
    },
    handoff_to_slow: () => {
      // Kept for protocol completeness — actual handoff is driven by
      // dispatchNextSentence() in the TTS onEnd / token-stream pipeline.
      dispatchNextSentence()
    },
    interrupt_self: () => {
      // Measurement: capture the arm timestamp before any side effects, then
      // do the strictly-synchronous stopAll() and snapshot now() right after.
      // Anything that involves an await goes after the measurement window.
      const armed = bargeInArmedAt
      deps.tts.stopAll()
      const stoppedAt = deps.now()
      stopActiveGen()
      slowGenActive = false
      const store = deps.store.getState()
      store.setSelfSpeaking(false)
      store.markReplyEnded()
      store.clearSlowReply()
      lastSpokenSlow = ''
      slowSpokenLen = 0
      if (armed !== null) {
        options.onBargeInLatency?.(stoppedAt - armed)
        bargeInArmedAt = null
      }
    },
  }

  const dispatch = (decision: TickDecision): void => {
    // The handlers map is exhaustive over TickAction (enforced at compile
    // time by `ActionHandlerMap`), so a direct table lookup beats a switch
    // ladder and stays correct if new actions are added.
    const handler = handlers[decision.action] as ActionHandler<
      typeof decision.action
    >
    handler(decision)
  }

  const tick = (): void => {
    if (inFlightTickId !== -1) return
    const store = deps.store.getState()
    store.incrementTick()
    const tickId = store.tickCount
    inFlightTickId = tickId
    const input = selectTickInput(deps.store.getState(), deps.now())
    decisionSource.decide(tickId, input, resolveConfig()).then(
      (decision) => {
        if (!running) return
        inFlightTickId = -1
        options.onTick?.(decision)
        dispatch(decision)
      },
      (err: unknown) => {
        // Surface decision-source failures rather than silently spinning the
        // loop forever. Loop keeps running so a transient worker hiccup
        // doesn't kill the whole session, but every failure lands in the
        // devtools console with a tickId for forensics.
        console.error('[orchestrator] decision rejected on tick', tickId, err)
        inFlightTickId = -1
      },
    )
  }

  return {
    start(): void {
      if (running) return
      running = true

      // Hysteresis: rising edge fires immediately; falling edge waits until
      // speakingHangoverMs of sub-threshold frames so inter-word gaps don't
      // tear the utterance into pieces (which would block the 3s sustained
      // gate for backchannels). Checked on every audio frame (~50ms cadence).
      unsubs.push(
        deps.audio.onLevel((rms) => {
          const now = deps.now()
          const cur = deps.store.getState()
          // While the assistant is speaking, raise the bar significantly so
          // residual echo (post echo-cancellation) doesn't trip false
          // barge-ins. Real barge-in still needs sustained loud speech.
          const effectiveThreshold = cur.selfSpeaking
            ? speakingThreshold * 3
            : speakingThreshold
          const above = rms >= effectiveThreshold
          if (above) {
            lastVoiceFrameAt = now
            if (!cur.userSpeaking) {
              cur.setUserSpeaking(true, now)
              if (cur.selfSpeaking) bargeInArmedAt = now
            }
            return
          }
          if (
            cur.userSpeaking &&
            lastVoiceFrameAt !== null &&
            now - lastVoiceFrameAt >= speakingHangoverMs
          ) {
            cur.setUserSpeaking(false, now)
            bargeInArmedAt = null
            lastVoiceFrameAt = null
          }
        }),
        deps.stt.onPartial((text) => {
          // Drop partials that arrive while the assistant is speaking —
          // they're almost always echo of our own TTS being recognised.
          if (deps.store.getState().selfSpeaking) return
          deps.store.getState().updateUserPartial(text)
        }),
        deps.stt.onFinal((text) => {
          if (deps.store.getState().selfSpeaking) return
          deps.store.getState().commitUserFinal(text, deps.now())
        }),
        deps.tts.onEnd(() => {
          const store = deps.store.getState()
          store.setSelfSpeaking(false)
          // Try to feed the next slow sentence first.
          if (dispatchNextSentence()) return
          // Still generating? Wait for more tokens — dispatchNextSentence
          // will fire again from onToken when a boundary arrives.
          if (slowGenActive) return
          // Generator done. Nothing left to speak. If we never handed off
          // (no slow brain wired, or it errored before producing text),
          // close the fast-only turn here.
          if (store.replyInFlight) finishReplyTurn()
        }),
      )

      timer = deps.scheduler.setInterval(tick, tickIntervalMs)
    },
    stop(): void {
      if (!running) return
      running = false
      if (timer !== null) deps.scheduler.clearInterval(timer)
      timer = null
      lastVoiceFrameAt = null
      for (const off of unsubs) off()
      unsubs.length = 0
      stopActiveGen()
      if (ownsDecisionSource) decisionSource.dispose()
    },
    get isRunning(): boolean {
      return running
    },
  }
}
