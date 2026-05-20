/**
 * Conversation store — dumb data + pure setters.
 *
 * The orchestrator does not live here. This file holds the *facts* about
 * the conversation: who spoke when, what the partial vs final transcript
 * is, whether the slow brain has produced something to read. Time-deltas
 * (`msSinceUserLastSpoke`, etc.) are derived on demand by `selectTickInput`
 * so we never have to choose between staleness and a wake-up timer.
 */

import { create } from 'zustand'
import type { TickInput } from '../types/protocol'

export interface Message {
  readonly role: 'user' | 'assistant'
  readonly text: string
  readonly ts: number
  readonly source?: 'fast' | 'slow'
}

export interface ConversationState {
  readonly userSpeaking: boolean
  readonly selfSpeaking: boolean
  readonly userTranscriptPartial: string
  readonly userTranscriptFinal: string
  readonly userStartedSpeakingAt: number | null
  readonly userLastSpokeAt: number | null
  readonly lastBackchannelAt: number | null
  readonly slowReplyText: string | null
  readonly slowReplyReady: boolean
  readonly tickCount: number
  readonly messages: readonly Message[]
}

export interface ConversationActions {
  setUserSpeaking(speaking: boolean, now: number): void
  updateUserPartial(text: string): void
  commitUserFinal(text: string, now: number): void
  clearUserTranscript(): void
  setSelfSpeaking(speaking: boolean): void
  appendSlowReply(chunk: string): void
  markSlowReplyReady(): void
  clearSlowReply(): void
  markBackchannel(now: number): void
  incrementTick(): void
  appendMessage(msg: Message): void
  reset(): void
}

export type ConversationStore = ConversationState & ConversationActions

const INITIAL_STATE: ConversationState = {
  userSpeaking: false,
  selfSpeaking: false,
  userTranscriptPartial: '',
  userTranscriptFinal: '',
  userStartedSpeakingAt: null,
  userLastSpokeAt: null,
  lastBackchannelAt: null,
  slowReplyText: null,
  slowReplyReady: false,
  tickCount: 0,
  messages: [],
}

export const useConversationStore = create<ConversationStore>((set) => ({
  ...INITIAL_STATE,

  setUserSpeaking(speaking, now) {
    set((s) => {
      if (speaking) {
        return {
          userSpeaking: true,
          userStartedSpeakingAt: s.userStartedSpeakingAt ?? now,
          userLastSpokeAt: now,
        }
      }
      // Falling edge — freeze the "last spoke" timestamp at `now` so the
      // silence gap can be measured. Clear the start-of-utterance edge.
      return {
        userSpeaking: false,
        userStartedSpeakingAt: null,
        userLastSpokeAt: now,
      }
    })
  },

  updateUserPartial(text) {
    set({ userTranscriptPartial: text })
  },

  commitUserFinal(text, now) {
    const trimmed = text.trim()
    if (!trimmed) return
    set((s) => ({
      userTranscriptFinal: s.userTranscriptFinal
        ? `${s.userTranscriptFinal} ${trimmed}`
        : trimmed,
      userTranscriptPartial: '',
      userLastSpokeAt: now,
    }))
  },

  clearUserTranscript() {
    set({ userTranscriptPartial: '', userTranscriptFinal: '' })
  },

  setSelfSpeaking(speaking) {
    set({ selfSpeaking: speaking })
  },

  appendSlowReply(chunk) {
    set((s) => ({
      slowReplyText: (s.slowReplyText ?? '') + chunk,
    }))
  },

  markSlowReplyReady() {
    set({ slowReplyReady: true })
  },

  clearSlowReply() {
    set({ slowReplyText: null, slowReplyReady: false })
  },

  markBackchannel(now) {
    set({ lastBackchannelAt: now })
  },

  incrementTick() {
    set((s) => ({ tickCount: s.tickCount + 1 }))
  },

  appendMessage(msg) {
    set((s) => ({ messages: [...s.messages, msg] }))
  },

  reset() {
    set(INITIAL_STATE)
  },
}))

/**
 * Pure derivation of the TickInput shape from a snapshot of the store.
 * Kept here (not inside the store) so unit tests can pass plain objects
 * without instantiating Zustand. Time-deltas are computed against `now`.
 */
export function selectTickInput(
  state: ConversationState,
  now: number,
): TickInput {
  const msSinceUserLastSpoke =
    state.userLastSpokeAt === null
      ? Number.POSITIVE_INFINITY
      : now - state.userLastSpokeAt
  const msSinceUserStartedSpeaking =
    state.userStartedSpeakingAt === null ? 0 : now - state.userStartedSpeakingAt
  const msSinceLastBackchannel =
    state.lastBackchannelAt === null
      ? Number.POSITIVE_INFINITY
      : now - state.lastBackchannelAt

  return {
    userSpeaking: state.userSpeaking,
    userTranscriptPartial: state.userTranscriptPartial,
    userTranscriptFinal: state.userTranscriptFinal,
    msSinceUserLastSpoke,
    msSinceUserStartedSpeaking,
    selfSpeaking: state.selfSpeaking,
    slowReplyReady: state.slowReplyReady,
    slowReplyText: state.slowReplyText,
    tickCount: state.tickCount,
    msSinceLastBackchannel,
  }
}
