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
import {
  exhaustiveCheck,
  type TickAction,
  type TickDecision,
} from '../types/protocol'

export const TICK_INTERVAL_MS = 200
export const DEFAULT_SPEAKING_RMS = 0.01

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
  let slowHandedOff = false
  let lastSpokenSlow = ''
  // Barge-in latency arming. Set on the user-speaking rising edge while we
  // were already speaking; cleared after the interrupt is executed.
  let bargeInArmedAt: number | null = null
  const unsubs: Array<() => void> = []

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
    activeGen = deps.slowBrain.generate({
      messages,
      onToken: (text) => {
        deps.store.getState().appendSlowReply(text)
        const after = deps.store.getState()
        if (
          !after.slowReplyReady &&
          isSentenceBoundary(after.slowReplyText ?? '')
        ) {
          after.markSlowReplyReady()
        }
        // If we're past the fast stall (TTS already idle) and the slow
        // reply has a sentence in hand, hand off right now.
        maybeHandoff()
      },
      onDone: () => {
        activeGen = null
        const s = deps.store.getState()
        if (!s.slowReplyReady && s.slowReplyText) s.markSlowReplyReady()
        maybeHandoff()
      },
      onAborted: () => {
        activeGen = null
      },
      onError: () => {
        activeGen = null
      },
    })
  }

  /**
   * Hand the buffered slow reply to TTS if it's ready and we're not
   * already speaking. Returns true if a handoff was queued so the caller
   * (TTS onEnd) knows to keep the reply turn alive instead of closing it.
   */
  const maybeHandoff = (): boolean => {
    if (slowHandedOff) return false
    const s = deps.store.getState()
    if (!s.replyInFlight) return false
    if (s.selfSpeaking) return false
    const text = s.slowReplyText
    if (!text || !s.slowReplyReady) return false
    s.clearSlowReply()
    s.setSelfSpeaking(true)
    slowHandedOff = true
    lastSpokenSlow = text
    void deps.tts.speak(text)
    return true
  }

  const finishReplyTurn = (): void => {
    const store = deps.store.getState()
    store.setSelfSpeaking(false)
    if (store.replyInFlight) store.markReplyEnded()
    if (lastSpokenSlow) {
      store.appendMessage({
        role: 'assistant',
        text: lastSpokenSlow,
        ts: deps.now(),
        source: 'slow',
      })
    }
    lastSpokenSlow = ''
    slowHandedOff = false
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
      slowHandedOff = false
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
      // maybeHandoff() in the TTS onEnd / token-stream pipeline.
      maybeHandoff()
    },
    interrupt_self: () => {
      // Measurement: capture the arm timestamp before any side effects, then
      // do the strictly-synchronous stopAll() and snapshot now() right after.
      // Anything that involves an await goes after the measurement window.
      const armed = bargeInArmedAt
      deps.tts.stopAll()
      const stoppedAt = deps.now()
      stopActiveGen()
      const store = deps.store.getState()
      store.setSelfSpeaking(false)
      store.markReplyEnded()
      store.clearSlowReply()
      slowHandedOff = false
      lastSpokenSlow = ''
      if (armed !== null) {
        options.onBargeInLatency?.(stoppedAt - armed)
        bargeInArmedAt = null
      }
    },
  }

  const dispatch = (decision: TickDecision): void => {
    switch (decision.action) {
      case 'silent':
        handlers.silent(decision)
        return
      case 'backchannel':
        handlers.backchannel(decision)
        return
      case 'start_fast_reply':
        handlers.start_fast_reply(decision)
        return
      case 'request_slow_reply':
        handlers.request_slow_reply(decision)
        return
      case 'handoff_to_slow':
        handlers.handoff_to_slow(decision)
        return
      case 'interrupt_self':
        handlers.interrupt_self(decision)
        return
      default:
        exhaustiveCheck(decision)
    }
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

      unsubs.push(
        deps.audio.onLevel((rms) => {
          const speaking = rms >= speakingThreshold
          const cur = deps.store.getState()
          if (cur.userSpeaking !== speaking) {
            cur.setUserSpeaking(speaking, deps.now())
            // Arm the barge-in stopwatch the instant the user starts speaking
            // while we're mid-utterance. Disarm on the falling edge.
            if (speaking && cur.selfSpeaking) {
              bargeInArmedAt = deps.now()
            } else if (!speaking) {
              bargeInArmedAt = null
            }
          } else if (speaking) {
            cur.setUserSpeaking(true, deps.now())
          }
        }),
        deps.stt.onPartial((text) => {
          deps.store.getState().updateUserPartial(text)
        }),
        deps.stt.onFinal((text) => {
          deps.store.getState().commitUserFinal(text, deps.now())
        }),
        deps.tts.onEnd(() => {
          const store = deps.store.getState()
          store.setSelfSpeaking(false)
          // Try to hand off to the slow reply before closing the turn.
          if (maybeHandoff()) return
          if (slowHandedOff) {
            // Slow reply already spoken. Anything still streaming is
            // leftover for this turn — abort it and close.
            stopActiveGen()
            if (store.replyInFlight) finishReplyTurn()
            return
          }
          // Slow brain still generating? Keep the turn open until tokens
          // arrive (maybeHandoff fires from onToken too).
          if (activeGen) return
          // Nothing more coming — close the turn cleanly.
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
