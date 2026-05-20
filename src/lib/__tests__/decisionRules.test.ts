import { describe, expect, it } from 'vitest'
import {
  BACKCHANNEL_PHRASES,
  DEFAULT_DECISION_CONFIG,
  FAST_STALL_PHRASES,
  decideTick,
} from '../decisionRules'
import type { TickInput } from '../../types/protocol'

function input(over: Partial<TickInput> = {}): TickInput {
  return {
    userSpeaking: false,
    userTranscriptPartial: '',
    userTranscriptFinal: '',
    msSinceUserLastSpoke: Number.POSITIVE_INFINITY,
    msSinceUserStartedSpeaking: 0,
    selfSpeaking: false,
    slowReplyReady: false,
    slowReplyText: null,
    tickCount: 0,
    msSinceLastBackchannel: Number.POSITIVE_INFINITY,
    replyInFlight: false,
    turnEndConfidence: 0,
    ...over,
  }
}

const alwaysFire = () => 0 // random < any positive rate

describe('decideTick — Rule 1 (barge-in)', () => {
  it('interrupts self when user starts speaking while we speak', () => {
    expect(
      decideTick(input({ userSpeaking: true, selfSpeaking: true })),
    ).toEqual({ action: 'interrupt_self' })
  })

  it('does not fire when only one of the conditions holds', () => {
    expect(
      decideTick(input({ userSpeaking: true, selfSpeaking: false })).action,
    ).not.toBe('interrupt_self')
    expect(
      decideTick(input({ userSpeaking: false, selfSpeaking: true })).action,
    ).not.toBe('interrupt_self')
  })
})

describe('decideTick — Rule 2 (backchannel)', () => {
  it('fires a backchannel phrase after sustained user speech + cooldown', () => {
    const d = decideTick(
      input({
        userSpeaking: true,
        msSinceUserStartedSpeaking: 3001,
        msSinceLastBackchannel: 2001,
      }),
      { random: alwaysFire },
    )
    expect(d.action).toBe('backchannel')
    if (d.action === 'backchannel') {
      expect(BACKCHANNEL_PHRASES).toContain(d.phrase)
    }
  })

  it('does not backchannel under min user-speech duration', () => {
    const d = decideTick(
      input({
        userSpeaking: true,
        msSinceUserStartedSpeaking: 2999,
        msSinceLastBackchannel: Number.POSITIVE_INFINITY,
      }),
      { random: alwaysFire },
    )
    expect(d.action).toBe('silent')
  })

  it('respects the backchannel cooldown — 1999ms boundary blocks', () => {
    const d = decideTick(
      input({
        userSpeaking: true,
        msSinceUserStartedSpeaking: 10_000,
        msSinceLastBackchannel: 1_999,
      }),
      { random: alwaysFire },
    )
    expect(d.action).toBe('silent')
  })

  it('respects the backchannel rate gate', () => {
    // random returns 0.99 → 0.99 < 0.3 false → silent
    const d = decideTick(
      input({
        userSpeaking: true,
        msSinceUserStartedSpeaking: 10_000,
        msSinceLastBackchannel: 10_000,
      }),
      { random: () => 0.99 },
    )
    expect(d.action).toBe('silent')
  })

  it('barge-in dominates backchannel when both qualify', () => {
    const d = decideTick(
      input({
        userSpeaking: true,
        selfSpeaking: true,
        msSinceUserStartedSpeaking: 5_000,
        msSinceLastBackchannel: 5_000,
      }),
      { random: alwaysFire },
    )
    expect(d.action).toBe('interrupt_self')
  })
})

describe('decideTick — Rule 3 (start_fast_reply)', () => {
  it('starts a fast reply after silence with a final transcript', () => {
    const d = decideTick(
      input({
        userSpeaking: false,
        msSinceUserLastSpoke: 701,
        userTranscriptFinal: 'what time is it',
      }),
      { random: alwaysFire },
    )
    expect(d.action).toBe('start_fast_reply')
    if (d.action === 'start_fast_reply') {
      expect(FAST_STALL_PHRASES).toContain(d.phrase)
    }
  })

  it('does not fire at exact silence threshold boundary', () => {
    const d = decideTick(
      input({
        userSpeaking: false,
        msSinceUserLastSpoke: 700,
        userTranscriptFinal: 'hi',
      }),
    )
    expect(d.action).toBe('silent')
  })

  it('does not fire when transcript is empty', () => {
    const d = decideTick(
      input({
        userSpeaking: false,
        msSinceUserLastSpoke: 5_000,
        userTranscriptFinal: '',
      }),
    )
    expect(d.action).toBe('silent')
  })

  it('does not re-fire while a reply is already in flight', () => {
    const d = decideTick(
      input({
        userSpeaking: false,
        msSinceUserLastSpoke: 5_000,
        userTranscriptFinal: 'hi',
        replyInFlight: true,
      }),
    )
    expect(d.action).toBe('silent')
  })
})

describe('decideTick — Rule 4 (handoff_to_slow)', () => {
  it('hands off when fast reply is in flight and slow is ready', () => {
    const d = decideTick(
      input({
        selfSpeaking: true,
        slowReplyReady: true,
        replyInFlight: true,
      }),
    )
    expect(d.action).toBe('handoff_to_slow')
  })

  it('does not hand off without a reply in flight (defensive)', () => {
    const d = decideTick(
      input({
        selfSpeaking: true,
        slowReplyReady: true,
        replyInFlight: false,
        turnEndConfidence: 0,
      }),
    )
    expect(d.action).toBe('silent')
  })

  it('does not hand off if slow is not ready', () => {
    const d = decideTick(
      input({
        selfSpeaking: true,
        slowReplyReady: false,
        replyInFlight: true,
      }),
    )
    expect(d.action).toBe('silent')
  })
})

describe('decideTick — Rule 5 (default)', () => {
  it('returns silent for an idle state', () => {
    expect(decideTick(input()).action).toBe('silent')
  })
})

describe('DEFAULT_DECISION_CONFIG', () => {
  it('matches the spec constants', () => {
    expect(DEFAULT_DECISION_CONFIG).toEqual({
      minUserSpeechForBackchannelMs: 3000,
      backchannelMinGapMs: 2000,
      backchannelRate: 0.3,
      silenceThresholdMs: 700,
      confidentTurnEndMs: 300,
      turnEndConfidenceThreshold: 0.7,
      bargeInEnabled: true,
      backchannelEnabled: true,
      fastStallEnabled: true,
    })
  })

  it('allows config overrides for the debug panel', () => {
    const d = decideTick(
      input({
        userSpeaking: false,
        msSinceUserLastSpoke: 100,
        userTranscriptFinal: 'hi',
      }),
      { config: { silenceThresholdMs: 50 }, random: alwaysFire },
    )
    expect(d.action).toBe('start_fast_reply')
  })
})

describe('decideTick — confident turn-end (rule 3a)', () => {
  it('fires reply at 350ms when confidence >= 0.7', () => {
    const d = decideTick(
      input({
        userSpeaking: false,
        msSinceUserLastSpoke: 350,
        userTranscriptFinal: 'what time is it',
        turnEndConfidence: 0.8,
      }),
      { random: alwaysFire },
    )
    expect(d.action).toBe('start_fast_reply')
  })

  it('does not fire under threshold even with enough silence', () => {
    const d = decideTick(
      input({
        userSpeaking: false,
        msSinceUserLastSpoke: 350,
        userTranscriptFinal: 'i was thinking that',
        turnEndConfidence: 0.4,
      }),
    )
    expect(d.action).toBe('silent')
  })

  it('falls back to the 700ms rule when confidence is low but silence is long', () => {
    const d = decideTick(
      input({
        userSpeaking: false,
        msSinceUserLastSpoke: 800,
        userTranscriptFinal: 'i was thinking',
        turnEndConfidence: 0.1,
      }),
      { random: alwaysFire },
    )
    expect(d.action).toBe('start_fast_reply')
  })
})

describe('decideTick — mode gates', () => {
  it('bargeInEnabled=false suppresses interrupt_self even with both flags set', () => {
    const d = decideTick(input({ userSpeaking: true, selfSpeaking: true }), {
      config: { bargeInEnabled: false },
      random: alwaysFire,
    })
    expect(d.action).not.toBe('interrupt_self')
  })

  it('backchannelEnabled=false suppresses backchannel even when timing qualifies', () => {
    const d = decideTick(
      input({
        userSpeaking: true,
        msSinceUserStartedSpeaking: 10_000,
        msSinceLastBackchannel: 10_000,
      }),
      { config: { backchannelEnabled: false }, random: alwaysFire },
    )
    expect(d.action).toBe('silent')
  })
})
