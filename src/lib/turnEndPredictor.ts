/**
 * Turn-end predictor — a heuristic stand-in for what would otherwise be a
 * ~30M-param distilled-BERT classifier (the original T-stretch.1 design).
 *
 * Given the user's current transcript (final + partial concatenated), it
 * returns a confidence in [0, 1] that the user has *finished* their turn.
 * The orchestrator uses this to fire a reply earlier than the conservative
 * 700ms silence rule when the signal is strong — without false-starting on
 * mid-sentence pauses.
 *
 * Pure function. No DOM, no model load, no awaitable work — runs once per
 * tick on the main thread. Cheap enough to inline.
 *
 * Why a heuristic and not a real model:
 *   - There is no widely available off-the-shelf turn-completion classifier
 *     small enough to ship over the wire (~30M+ params would be another
 *     200MB+ download on top of the slow brain).
 *   - The signals that matter most — terminal punctuation, common end
 *     phrases, question structure — are deterministic + easy to reason
 *     about. A trained classifier would mostly relearn this with noise.
 *
 * If a real model becomes available, swap this fn's body — the call site
 * doesn't care.
 */

const TERMINAL = /[.!?]\s*$/
const END_PHRASE =
  /\b(thanks|thank you|please|okay|alright|got it|that's it|that's all)\s*[.!?]?\s*$/i
const QUESTION_OPENER =
  /^\s*(what|why|how|when|where|who|which|is|are|am|do|does|did|can|could|would|should|will|won't|isn't|aren't|don't|doesn't|didn't)\b/i

export interface TurnEndPrediction {
  readonly complete: boolean
  readonly confidence: number
}

export function predictTurnEnd(text: string): TurnEndPrediction {
  const trimmed = text.trim()
  if (!trimmed) return { complete: false, confidence: 0 }

  let conf = 0

  // Terminal punctuation is the strongest signal.
  if (TERMINAL.test(trimmed)) conf += 0.6

  // Common closing phrases push confidence further up.
  if (END_PHRASE.test(trimmed)) conf += 0.3

  // A question with a question mark — almost certainly done.
  if (QUESTION_OPENER.test(trimmed) && /\?\s*$/.test(trimmed)) {
    conf += 0.2
  }

  // Length nudge — short fragments often aren't complete utterances.
  const words = trimmed.split(/\s+/).length
  if (words >= 5) conf += 0.1
  if (words >= 12) conf += 0.05

  conf = Math.min(1, conf)
  return { complete: conf >= 0.6, confidence: conf }
}
