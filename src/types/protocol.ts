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

export type FastWorkerInbound = {
  readonly kind: 'tick'
  readonly tickId: number
  readonly input: TickInput
}

export type FastWorkerOutbound = {
  readonly kind: 'decision'
  readonly tickId: number
  readonly decision: TickDecision
}

export type SlowWorkerInbound =
  | { readonly kind: 'load' }
  | {
      readonly kind: 'generate'
      readonly runId: string
      readonly prompt: string
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
  | { readonly kind: 'error'; readonly message: string }

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
