import { beforeEach, describe, expect, it } from 'vitest'
import {
  selectTickInput,
  useConversationStore,
  type ConversationState,
} from '../conversationStore'

beforeEach(() => {
  useConversationStore.getState().reset()
})

describe('useConversationStore', () => {
  it('starts in the initial empty state', () => {
    const s = useConversationStore.getState()
    expect(s.userSpeaking).toBe(false)
    expect(s.userTranscriptFinal).toBe('')
    expect(s.tickCount).toBe(0)
    expect(s.messages).toEqual([])
    expect(s.slowReplyReady).toBe(false)
  })

  it('setUserSpeaking(true) sets the rising edge once and updates lastSpoke', () => {
    const { setUserSpeaking } = useConversationStore.getState()
    setUserSpeaking(true, 1000)
    setUserSpeaking(true, 1500)
    const s = useConversationStore.getState()
    expect(s.userSpeaking).toBe(true)
    expect(s.userStartedSpeakingAt).toBe(1000)
    expect(s.userLastSpokeAt).toBe(1500)
  })

  it('setUserSpeaking(false) clears the rising edge and freezes lastSpoke', () => {
    const { setUserSpeaking } = useConversationStore.getState()
    setUserSpeaking(true, 1000)
    setUserSpeaking(false, 2200)
    const s = useConversationStore.getState()
    expect(s.userSpeaking).toBe(false)
    expect(s.userStartedSpeakingAt).toBeNull()
    expect(s.userLastSpokeAt).toBe(2200)
  })

  it('commitUserFinal appends with a space and clears the partial', () => {
    const { commitUserFinal, updateUserPartial } =
      useConversationStore.getState()
    updateUserPartial('hello wor')
    commitUserFinal('hello world', 100)
    commitUserFinal('how are you', 200)
    const s = useConversationStore.getState()
    expect(s.userTranscriptPartial).toBe('')
    expect(s.userTranscriptFinal).toBe('hello world how are you')
    expect(s.userLastSpokeAt).toBe(200)
  })

  it('commitUserFinal ignores whitespace-only commits', () => {
    const { commitUserFinal } = useConversationStore.getState()
    commitUserFinal('   ', 100)
    expect(useConversationStore.getState().userTranscriptFinal).toBe('')
  })

  it('appendSlowReply accumulates streamed chunks', () => {
    const { appendSlowReply, markSlowReplyReady, clearSlowReply } =
      useConversationStore.getState()
    appendSlowReply('Hello')
    appendSlowReply(' world')
    markSlowReplyReady()
    expect(useConversationStore.getState().slowReplyText).toBe('Hello world')
    expect(useConversationStore.getState().slowReplyReady).toBe(true)
    clearSlowReply()
    expect(useConversationStore.getState().slowReplyText).toBeNull()
    expect(useConversationStore.getState().slowReplyReady).toBe(false)
  })

  it('incrementTick is monotonic', () => {
    const { incrementTick } = useConversationStore.getState()
    incrementTick()
    incrementTick()
    incrementTick()
    expect(useConversationStore.getState().tickCount).toBe(3)
  })

  it('markReplyStarted/markReplyEnded toggles replyInFlight', () => {
    const { markReplyStarted, markReplyEnded } = useConversationStore.getState()
    expect(useConversationStore.getState().replyInFlight).toBe(false)
    markReplyStarted()
    expect(useConversationStore.getState().replyInFlight).toBe(true)
    markReplyEnded()
    expect(useConversationStore.getState().replyInFlight).toBe(false)
  })

  it('appendMessage adds to history in order', () => {
    const { appendMessage } = useConversationStore.getState()
    appendMessage({ role: 'user', text: 'hi', ts: 1 })
    appendMessage({ role: 'assistant', text: 'hello', ts: 2, source: 'fast' })
    const msgs = useConversationStore.getState().messages
    expect(msgs).toHaveLength(2)
    expect(msgs[1]!.source).toBe('fast')
  })
})

describe('selectTickInput', () => {
  function baseState(over: Partial<ConversationState> = {}): ConversationState {
    return {
      userSpeaking: false,
      selfSpeaking: false,
      userTranscriptPartial: '',
      userTranscriptFinal: '',
      userStartedSpeakingAt: null,
      userLastSpokeAt: null,
      lastBackchannelAt: null,
      slowReplyText: null,
      slowReplyReady: false,
      replyInFlight: false,
      tickCount: 0,
      messages: [],
      ...over,
    }
  }

  it('uses +Infinity for missing user-speech edges', () => {
    const input = selectTickInput(baseState(), 5_000)
    expect(input.msSinceUserLastSpoke).toBe(Number.POSITIVE_INFINITY)
    expect(input.msSinceUserStartedSpeaking).toBe(0)
    expect(input.msSinceLastBackchannel).toBe(Number.POSITIVE_INFINITY)
  })

  it('computes deltas against now', () => {
    const input = selectTickInput(
      baseState({
        userSpeaking: true,
        userStartedSpeakingAt: 1_000,
        userLastSpokeAt: 1_800,
        lastBackchannelAt: 500,
        tickCount: 7,
      }),
      2_000,
    )
    expect(input.msSinceUserStartedSpeaking).toBe(1_000)
    expect(input.msSinceUserLastSpoke).toBe(200)
    expect(input.msSinceLastBackchannel).toBe(1_500)
    expect(input.tickCount).toBe(7)
    expect(input.userSpeaking).toBe(true)
  })

  it('passes through transcript + slow reply fields verbatim', () => {
    const input = selectTickInput(
      baseState({
        userTranscriptPartial: 'hel',
        userTranscriptFinal: 'hello',
        slowReplyText: 'thinking…',
        slowReplyReady: true,
      }),
      0,
    )
    expect(input.userTranscriptPartial).toBe('hel')
    expect(input.userTranscriptFinal).toBe('hello')
    expect(input.slowReplyText).toBe('thinking…')
    expect(input.slowReplyReady).toBe(true)
  })
})
