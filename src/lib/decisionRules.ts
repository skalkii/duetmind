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
  /** Short silence gap that's enough when the classifier is confident. */
  readonly confidentTurnEndMs: number
  /** Classifier confidence required to short-circuit the silence wait. */
  readonly turnEndConfidenceThreshold: number
  /**
   * Mode gates. Flipping any of these false lets the rule engine model
   * "turn-based" behaviour for A/B comparison against the duplex default.
   */
  readonly bargeInEnabled: boolean
  readonly backchannelEnabled: boolean
  readonly fastStallEnabled: boolean
  /**
   * Minimum sustained user speech before barge-in fires. Filters out
   * speaker bleed, microphone pops, and short noise spikes that would
   * otherwise interrupt the assistant's reply mid-sentence.
   */
  readonly minBargeSpeechMs: number
}

export const DEFAULT_DECISION_CONFIG: DecisionConfig = {
  minUserSpeechForBackchannelMs: 1500,
  backchannelMinGapMs: 1500,
  backchannelRate: 0.5,
  silenceThresholdMs: 700,
  confidentTurnEndMs: 300,
  turnEndConfidenceThreshold: 0.7,
  bargeInEnabled: true,
  backchannelEnabled: true,
  fastStallEnabled: true,
  minBargeSpeechMs: 250,
}

// "mmhm" and "uh-huh" get spelled out letter-by-letter by Chrome's TTS
// ("em em aitch em"). Stick to dictionary words it knows how to say.
export const BACKCHANNEL_PHRASES = [
  'right',
  'yeah',
  'okay',
  'I see',
  'sure',
  'go on',
  'got it',
  'gotcha',
  'understood',
  'makes sense',
] as const

export const FAST_STALL_PHRASES = [
  'Let me think about that.',
  'Hmm, one moment.',
  'Give me a sec.',
  'Good question.',
  'Let me see.',
  'Thinking it through.',
  'One moment, please.',
  'Interesting question.',
  'Let me work that out.',
  'Hold on a second.',
  'Right, okay.',
  'Let me consider that.',
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
  // Gated by cfg.bargeInEnabled. Requires sustained speech so short
  // bleed/pops from our own speaker don't trigger false interrupts.
  if (
    cfg.bargeInEnabled &&
    input.userSpeaking &&
    input.selfSpeaking &&
    input.msSinceUserStartedSpeaking >= cfg.minBargeSpeechMs
  ) {
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

  // Rule 3 — start a fast reply once the user has paused with a committed
  // transcript and no reply already in flight. The pause threshold has two
  // tiers: the short `confidentTurnEndMs` is enough when the classifier
  // says we're confidently past a turn boundary; otherwise we wait the
  // conservative `silenceThresholdMs`.
  if (
    !input.userSpeaking &&
    !input.replyInFlight &&
    input.userTranscriptFinal !== '' &&
    (input.msSinceUserLastSpoke > cfg.silenceThresholdMs ||
      (input.msSinceUserLastSpoke > cfg.confidentTurnEndMs &&
        input.turnEndConfidence >= cfg.turnEndConfidenceThreshold))
  ) {
    return {
      action: 'start_fast_reply',
      phrase: pick(FAST_STALL_PHRASES, random),
    }
  }

  // Rule 5 — default.
  return { action: 'silent' }
}
