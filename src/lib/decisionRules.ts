/**
 * Pure decision rules for the 200ms tick.
 *
 * One function, no side effects, no DOM, no React, no timers. Takes a
 * snapshot of the conversation (`TickInput`), a config (defaults exported
 * for debug panel mutation later), and a random source for sampling. Returns
 * the single action the orchestrator should take this tick.
 *
 * Rule ordering matters — earlier rules dominate. They are evaluated in the
 * order written.
 */

import type { TickDecision, TickInput } from '../types/protocol'

export interface DecisionConfig {
  /** Min user-utterance length before we'll consider a backchannel. */
  readonly minUserSpeechForBackchannelMs: number
  /** Cooldown between consecutive backchannels. */
  readonly backchannelMinGapMs: number
  /** Per-tick probability a backchannel actually fires once gated. */
  readonly backchannelRate: number
  /** Silence gap after a final transcript before we kick off a reply. */
  readonly silenceThresholdMs: number
  /**
   * Mode gates. Flipping any of these false lets the rule engine model
   * "turn-based" behaviour for A/B comparison against the duplex default.
   */
  readonly bargeInEnabled: boolean
  readonly backchannelEnabled: boolean
  readonly fastStallEnabled: boolean
}

export const DEFAULT_DECISION_CONFIG: DecisionConfig = {
  minUserSpeechForBackchannelMs: 3000,
  backchannelMinGapMs: 2000,
  backchannelRate: 0.3,
  silenceThresholdMs: 700,
  bargeInEnabled: true,
  backchannelEnabled: true,
  fastStallEnabled: true,
}

export const BACKCHANNEL_PHRASES = ['mmhm', 'right', 'uh-huh', 'yeah'] as const

export const FAST_STALL_PHRASES = [
  'Let me think about that.',
  'Hmm, one moment.',
  'Give me a sec.',
] as const

function pick<T>(pool: readonly T[], random: () => number): T {
  // Pool literals above are non-empty constants; tsc just can't prove it.
  const i = Math.floor(random() * pool.length) % pool.length
  return pool[i] as T
}

export interface DecideTickOptions {
  readonly config?: Partial<DecisionConfig>
  readonly random?: () => number
}

export function decideTick(
  input: TickInput,
  options: DecideTickOptions = {},
): TickDecision {
  const cfg: DecisionConfig = { ...DEFAULT_DECISION_CONFIG, ...options.config }
  const random = options.random ?? Math.random

  // Rule 1 — barge-in. User talks while we speak → cut ourselves off.
  // Gated by cfg.bargeInEnabled so turn-based mode can suppress it.
  if (cfg.bargeInEnabled && input.userSpeaking && input.selfSpeaking) {
    return { action: 'interrupt_self' }
  }

  // Rule 2 — backchannel while user is mid-utterance.
  if (
    cfg.backchannelEnabled &&
    input.userSpeaking &&
    input.msSinceUserStartedSpeaking > cfg.minUserSpeechForBackchannelMs &&
    input.msSinceLastBackchannel > cfg.backchannelMinGapMs &&
    random() < cfg.backchannelRate
  ) {
    return {
      action: 'backchannel',
      phrase: pick(BACKCHANNEL_PHRASES, random),
    }
  }

  // Rule 4 — slow reply is ready while we're still speaking the fast stall.
  // Handoff at the next sentence boundary. The orchestrator owns the
  // boundary detection; this rule only fires when both states line up.
  if (input.selfSpeaking && input.slowReplyReady && input.replyInFlight) {
    return { action: 'handoff_to_slow' }
  }

  // Rule 3 — silence gap after user committed a final transcript, no reply
  // queued yet. Kick off a fast stall; the orchestrator's start_fast_reply
  // handler is responsible for also pinging the slow brain in parallel.
  if (
    !input.userSpeaking &&
    !input.replyInFlight &&
    input.msSinceUserLastSpoke > cfg.silenceThresholdMs &&
    input.userTranscriptFinal !== ''
  ) {
    return {
      action: 'start_fast_reply',
      phrase: pick(FAST_STALL_PHRASES, random),
    }
  }

  // Rule 5 — default.
  return { action: 'silent' }
}
