/**
 * 200ms tick orchestrator — the only place that wires audio/STT/TTS to the
 * conversation store and executes a TickDecision per tick.
 *
 * Responsibilities (and only these):
 *   - Subscribe to audio level + STT events + TTS lifecycle to keep the
 *     conversation store in sync with the world.
 *   - Every TICK_INTERVAL_MS, derive a TickInput, ask `decideTick` for an
 *     action, and dispatch through an action-executor map (one handler
 *     per variant — no switch ladder, OCP for adding actions).
 *
 * Anything else (model loading, prompt building, sentence-boundary
 * detection) is somebody else's problem. Subsystem lifecycles are the
 * caller's — orchestrator only subscribes.
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
  readonly onTick?: (decision: TickDecision) => void
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
  const config = options.config ?? {}
  const decisionSource =
    deps.decisionSource ?? createInlineDecisionSource({ config, random })
  const ownsDecisionSource = !deps.decisionSource

  let running = false
  let timer: ReturnType<typeof setInterval> | null = null
  let inFlightTickId = -1
  let activeGen: SlowGenerateHandle | null = null
  const unsubs: Array<() => void> = []

  const stopActiveGen = (): void => {
    if (activeGen) {
      activeGen.abort()
      activeGen = null
    }
  }

  const startSlowGen = (): void => {
    if (!deps.slowBrain) return
    const store = deps.store.getState()
    const messages = buildChatMessages(
      store.messages,
      store.userTranscriptFinal,
    )
    // The slow worker applies the model's own chat template, so we send the
    // full chat-message array as the "prompt" payload.
    const promptPayload = JSON.stringify(messages)
    activeGen = deps.slowBrain.generate({
      prompt: promptPayload,
      onToken: (text) => {
        deps.store.getState().appendSlowReply(text)
        // Re-read after the mutation — Zustand returns a fresh snapshot.
        const after = deps.store.getState()
        if (
          !after.slowReplyReady &&
          isSentenceBoundary(after.slowReplyText ?? '')
        ) {
          after.markSlowReplyReady()
        }
      },
      onDone: () => {
        activeGen = null
        const s = deps.store.getState()
        // Ensure ready flips even if model never produced a sentence end.
        if (!s.slowReplyReady && s.slowReplyText) s.markSlowReplyReady()
      },
      onAborted: () => {
        activeGen = null
      },
      onError: () => {
        activeGen = null
      },
    })
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
      store.markReplyStarted()
      store.setSelfSpeaking(true)
      void deps.tts.speak(d.phrase)
      // Kick off the slow brain in parallel — it streams tokens into the
      // store while the fast stall is being spoken, ready to take over at
      // the first sentence boundary (rule 4).
      startSlowGen()
    },
    request_slow_reply: () => {
      startSlowGen()
    },
    handoff_to_slow: () => {
      const store = deps.store.getState()
      const reply = store.slowReplyText
      if (!reply) return
      store.clearSlowReply()
      void deps.tts.speak(reply)
    },
    interrupt_self: () => {
      deps.tts.stopAll()
      stopActiveGen()
      const store = deps.store.getState()
      store.setSelfSpeaking(false)
      store.markReplyEnded()
      store.clearSlowReply()
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
    // Drop a tick if the previous decision hasn't come back yet — better to
    // skip a slot than queue up overlapping ticks that race the store.
    if (inFlightTickId !== -1) return
    const store = deps.store.getState()
    store.incrementTick()
    const tickId = store.tickCount
    inFlightTickId = tickId
    const input = selectTickInput(deps.store.getState(), deps.now())
    decisionSource.decide(tickId, input).then(
      (decision) => {
        if (!running) return
        inFlightTickId = -1
        options.onTick?.(decision)
        dispatch(decision)
      },
      () => {
        // Treat failures as a silent tick so the loop keeps running.
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
          } else if (speaking) {
            // Keep updating "last spoke" while user is still talking so
            // the silence timer can measure the true gap on falling edge.
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
          if (store.replyInFlight) store.markReplyEnded()
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
