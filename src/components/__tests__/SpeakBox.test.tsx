import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SpeakBox } from '../SpeakBox'
import type { Tts } from '../../lib/tts'

function makeFakeTts(): { tts: Tts; resolve: () => void } {
  let resolveSpeak: (() => void) | null = null
  const tts: Tts = {
    speak: vi.fn(
      () =>
        new Promise<void>((res) => {
          resolveSpeak = res
        }),
    ),
    stopAll: vi.fn(),
    onBoundary: vi.fn(() => () => undefined),
    onEnd: vi.fn(() => () => undefined),
    onError: vi.fn(() => () => undefined),
    get isSpeaking() {
      return resolveSpeak !== null
    },
  }
  return {
    tts,
    resolve: () => {
      resolveSpeak?.()
      resolveSpeak = null
    },
  }
}

describe('<SpeakBox />', () => {
  it('calls tts.speak with current textarea content', async () => {
    const { tts, resolve } = makeFakeTts()
    render(<SpeakBox ttsFactory={() => tts} />)
    await userEvent.click(screen.getByRole('button', { name: /^speak$/i }))
    expect(tts.speak).toHaveBeenCalledTimes(1)
    expect(vi.mocked(tts.speak).mock.calls[0]![0]).toMatch(/DuetMind/)
    act(() => resolve())
  })

  it('Stop calls stopAll', async () => {
    const { tts } = makeFakeTts()
    render(<SpeakBox ttsFactory={() => tts} />)
    await userEvent.click(screen.getByRole('button', { name: /^speak$/i }))
    await userEvent.click(screen.getByRole('button', { name: /^stop$/i }))
    expect(tts.stopAll).toHaveBeenCalledTimes(1)
  })
})
