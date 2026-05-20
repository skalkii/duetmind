/**
 * Wire protocol shared between main thread, fast brain worker, and slow brain
 * worker. Keep this file pure types + the `exhaustiveCheck` helper — no runtime
 * imports. Workers consume it as type-only.
 */

export interface TickInput {
  readonly userSpeaking: boolean
  readonly userTranscriptPartial: string
  readonly userTranscriptFinal: string
  readonly msSinceUserLastSpoke: number
  readonly msSinceUserStartedSpeaking: number
  readonly selfSpeaking: boolean
  readonly slowReplyReady: boolean
  readonly slowReplyText: string | null
  readonly tickCount: number
  readonly msSinceLastBackchannel: number
  readonly replyInFlight: boolean
}

export type TickAction =
  | 'silent'
  | 'backchannel'
  | 'start_fast_reply'
  | 'request_slow_reply'
  | 'handoff_to_slow'
  | 'interrupt_self'

export type TickDecision =
  | { readonly action: 'silent' }
  | { readonly action: 'backchannel'; readonly phrase: string }
  | { readonly action: 'start_fast_reply'; readonly phrase: string }
  | { readonly action: 'request_slow_reply' }
  | { readonly action: 'handoff_to_slow' }
  | { readonly action: 'interrupt_self' }

export interface FastTickInbound {
  readonly kind: 'tick'
  readonly tickId: number
  readonly input: TickInput
  /**
   * Optional per-tick config override. The worker is stateless across ticks,
   * so any live-tuned thresholds (debug panel knobs, mode toggles) ride
   * along. Values are `number | boolean` — the worker casts back to
   * `Partial<DecisionConfig>` at its end.
   */
  readonly configOverride?: Readonly<Record<string, number | boolean>>
}

export type FastWorkerInbound = FastTickInbound

export type FastWorkerOutbound = {
  readonly kind: 'decision'
  readonly tickId: number
  readonly decision: TickDecision
}

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant'
  readonly content: string
}

export type SlowWorkerInbound =
  | {
      readonly kind: 'load'
      /** Hugging Face model id. Worker falls back to its built-in default. */
      readonly modelId?: string
    }
  | {
      readonly kind: 'generate'
      readonly runId: string
      /** Chat-formatted messages. Worker applies the model's chat template. */
      readonly messages: readonly ChatMessage[]
    }
  | { readonly kind: 'abort'; readonly runId: string }

export type SlowWorkerOutbound =
  | { readonly kind: 'load_progress'; readonly pct: number }
  | { readonly kind: 'ready' }
  | {
      readonly kind: 'token'
      readonly runId: string
      readonly text: string
    }
  | { readonly kind: 'done'; readonly runId: string }
  | { readonly kind: 'aborted'; readonly runId: string }
  | {
      readonly kind: 'error'
      readonly message: string
      /** Optional runId — present when error is scoped to a generation. */
      readonly runId?: string
    }

/**
 * Compile-time exhaustiveness assertion. Place at the end of a `switch`/`if`
 * chain over a discriminated union — if a new variant is added without a
 * handler, the call will fail to typecheck.
 */
export function exhaustiveCheck(value: never): never {
  throw new Error(
    `Unhandled discriminated union member: ${JSON.stringify(value)}`,
  )
}
