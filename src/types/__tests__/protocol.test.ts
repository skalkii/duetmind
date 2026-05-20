import { describe, expect, it } from 'vitest'
import {
  exhaustiveCheck,
  type FastWorkerInbound,
  type FastWorkerOutbound,
  type SlowWorkerInbound,
  type SlowWorkerOutbound,
  type TickDecision,
  type TickInput,
} from '../protocol'

/**
 * Describe-by-handle: a function returning a string per variant. If a new
 * TickDecision variant is added without a case here, tsc fails at the
 * `exhaustiveCheck(d)` call site. This is the actual exhaustiveness test —
 * the runtime asserts below just exercise the happy path.
 */
function describeDecision(d: TickDecision): string {
  switch (d.action) {
    case 'silent':
      return 'silent'
    case 'backchannel':
      return `backchannel:${d.phrase}`
    case 'start_fast_reply':
      return `fast:${d.phrase}`
    case 'request_slow_reply':
      return 'request_slow'
    case 'handoff_to_slow':
      return 'handoff'
    case 'interrupt_self':
      return 'interrupt'
    default:
      return exhaustiveCheck(d)
  }
}

describe('TickDecision exhaustiveness', () => {
  it('covers every action with a stable label', () => {
    expect(describeDecision({ action: 'silent' })).toBe('silent')
    expect(describeDecision({ action: 'backchannel', phrase: 'mmhm' })).toBe(
      'backchannel:mmhm',
    )
    expect(
      describeDecision({ action: 'start_fast_reply', phrase: 'one sec' }),
    ).toBe('fast:one sec')
    expect(describeDecision({ action: 'request_slow_reply' })).toBe(
      'request_slow',
    )
    expect(describeDecision({ action: 'handoff_to_slow' })).toBe('handoff')
    expect(describeDecision({ action: 'interrupt_self' })).toBe('interrupt')
  })

  it('exhaustiveCheck throws when forced past the type guard', () => {
    expect(() => exhaustiveCheck('rogue' as never)).toThrow(/Unhandled/)
  })
})

describe('TickInput contract', () => {
  it('compiles a fully-populated value', () => {
    const input: TickInput = {
      userSpeaking: false,
      userTranscriptPartial: '',
      userTranscriptFinal: '',
      msSinceUserLastSpoke: 0,
      msSinceUserStartedSpeaking: 0,
      selfSpeaking: false,
      slowReplyReady: false,
      slowReplyText: null,
      tickCount: 0,
      msSinceLastBackchannel: 0,
      replyInFlight: false,
    }
    expect(input.tickCount).toBe(0)
  })
})

describe('Worker message contracts', () => {
  it('fast worker round-trip is well-typed', () => {
    const inbound: FastWorkerInbound = {
      kind: 'tick',
      tickId: 1,
      input: {
        userSpeaking: false,
        userTranscriptPartial: '',
        userTranscriptFinal: '',
        msSinceUserLastSpoke: 0,
        msSinceUserStartedSpeaking: 0,
        selfSpeaking: false,
        slowReplyReady: false,
        slowReplyText: null,
        tickCount: 1,
        msSinceLastBackchannel: 0,
        replyInFlight: false,
      },
    }
    const outbound: FastWorkerOutbound = {
      kind: 'decision',
      tickId: inbound.tickId,
      decision: { action: 'silent' },
    }
    expect(outbound.tickId).toBe(inbound.tickId)
  })

  it('slow worker variants compile', () => {
    const messages: SlowWorkerInbound[] = [
      { kind: 'load' },
      {
        kind: 'generate',
        runId: 'r1',
        messages: [{ role: 'user', content: 'hi' }],
      },
      { kind: 'abort', runId: 'r1' },
    ]
    const replies: SlowWorkerOutbound[] = [
      { kind: 'load_progress', pct: 0.5 },
      { kind: 'ready' },
      { kind: 'token', runId: 'r1', text: 'hello' },
      { kind: 'done', runId: 'r1' },
      { kind: 'aborted', runId: 'r1' },
      { kind: 'error', message: 'boom' },
    ]
    expect(messages).toHaveLength(3)
    expect(replies).toHaveLength(6)
  })
})
