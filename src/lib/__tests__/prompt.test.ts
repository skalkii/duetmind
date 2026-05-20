import { describe, expect, it } from 'vitest'
import { buildChatMessages, isSentenceBoundary } from '../prompt'
import type { Message } from '../../state/conversationStore'

const msg = (role: 'user' | 'assistant', text: string, ts = 0): Message => ({
  role,
  text,
  ts,
})

describe('buildChatMessages', () => {
  it('always starts with a system message', () => {
    const out = buildChatMessages([], 'hello')
    expect(out[0]!.role).toBe('system')
    expect(out[out.length - 1]).toEqual({ role: 'user', content: 'hello' })
  })

  it('appends the current user turn after history', () => {
    const history: Message[] = [msg('user', 'hi'), msg('assistant', 'hello')]
    const out = buildChatMessages(history, 'what time is it')
    expect(out.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ])
    expect(out[out.length - 1]!.content).toBe('what time is it')
  })

  it('clamps history to the most recent N turns', () => {
    const history: Message[] = Array.from({ length: 12 }, (_, i) =>
      msg(i % 2 === 0 ? 'user' : 'assistant', `turn ${i}`),
    )
    const out = buildChatMessages(history, 'now', { maxHistoryTurns: 3 })
    // 1 system + 3 history + 1 current = 5
    expect(out).toHaveLength(5)
    expect(out[1]!.content).toBe('turn 9')
    expect(out[3]!.content).toBe('turn 11')
  })

  it('honours a custom system prompt', () => {
    const out = buildChatMessages([], 'hi', { system: 'be terse' })
    expect(out[0]!.content).toBe('be terse')
  })
})

describe('isSentenceBoundary', () => {
  it('detects ., !, ? as boundaries', () => {
    expect(isSentenceBoundary('hello.')).toBe(true)
    expect(isSentenceBoundary('really?')).toBe(true)
    expect(isSentenceBoundary('wow!')).toBe(true)
  })

  it('tolerates trailing whitespace', () => {
    expect(isSentenceBoundary('done.\n')).toBe(true)
    expect(isSentenceBoundary('done. ')).toBe(true)
  })

  it('returns false for mid-sentence text', () => {
    expect(isSentenceBoundary('hello world')).toBe(false)
    expect(isSentenceBoundary('still thinking…')).toBe(false)
    expect(isSentenceBoundary('')).toBe(false)
  })
})
