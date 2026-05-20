/**
 * Pure prompt builder for the slow brain.
 *
 * Takes the conversation history + the current user turn and produces the
 * string we hand to Transformers.js. Kept separate from the orchestrator
 * so the prompt shape can be tweaked + snapshot-tested without spinning up
 * a real model.
 */

import type { Message } from '../state/conversationStore'
import type { ChatMessage } from '../types/protocol'

export type { ChatMessage }

export interface BuildPromptOptions {
  /** Max prior turns to include (most recent first). */
  readonly maxHistoryTurns?: number
  /** Optional system prompt prepended once. */
  readonly system?: string
}

const DEFAULT_MAX_HISTORY = 6
const DEFAULT_SYSTEM =
  'You are DuetMind, a concise, friendly conversational partner. ' +
  'Reply in 1–2 short sentences. Plain prose, no markdown, no lists.'

/**
 * Format the chat-message array that gets fed to the worker. The worker
 * applies the model's own chat template, so we don't bake one in here.
 */
export function buildChatMessages(
  history: readonly Message[],
  currentUser: string,
  options: BuildPromptOptions = {},
): ChatMessage[] {
  const maxHistory = options.maxHistoryTurns ?? DEFAULT_MAX_HISTORY
  const system = options.system ?? DEFAULT_SYSTEM
  const tail = history.slice(Math.max(0, history.length - maxHistory))
  const out: ChatMessage[] = [{ role: 'system', content: system }]
  for (const m of tail) {
    out.push({ role: m.role, content: m.text })
  }
  out.push({ role: 'user', content: currentUser })
  return out
}

const SENTENCE_END = /[.!?]\s*$/

/**
 * Heuristic: a streamed reply hits a sentence boundary when the accumulated
 * text ends with `.`, `!`, or `?`. Used by the orchestrator to decide when
 * the fast→slow handoff should fire.
 */
export function isSentenceBoundary(text: string): boolean {
  return SENTENCE_END.test(text.trimEnd())
}
