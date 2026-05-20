import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { TranscriptView } from '../TranscriptView'
import type { Stt } from '../../lib/stt'

interface FakeStt extends Stt {
  emitPartial: (t: string) => void
  emitFinal: (t: string) => void
}

function makeFakeStt(): FakeStt {
  let partialCb: ((t: string) => void) | null = null
  let finalCb: ((t: string) => void) | null = null
  let running = false
  return {
    start: vi.fn(() => {
      running = true
    }),
    stop: vi.fn(() => {
      running = false
    }),
    onPartial: vi.fn((cb) => {
      partialCb = cb
      return () => {
        partialCb = null
      }
    }),
    onFinal: vi.fn((cb) => {
      finalCb = cb
      return () => {
        finalCb = null
      }
    }),
    onError: vi.fn(() => () => undefined),
    get isRunning() {
      return running
    },
    emitPartial: (t) => partialCb?.(t),
    emitFinal: (t) => finalCb?.(t),
  } as FakeStt
}

describe('<TranscriptView />', () => {
  it('renders partial then appends final on commit', async () => {
    const stt = makeFakeStt()
    render(<TranscriptView sttFactory={() => stt} />)
    await userEvent.click(screen.getByRole('button', { name: /listen/i }))
    act(() => stt.emitPartial('hello wor'))
    expect(screen.getByTestId('transcript-partial')).toHaveTextContent(
      'hello wor',
    )
    act(() => stt.emitFinal('hello world'))
    expect(screen.getByTestId('transcript-final')).toHaveTextContent(
      'hello world',
    )
    expect(screen.getByTestId('transcript-partial')).toHaveTextContent('')
  })

  it('toggles via Stop', async () => {
    const stt = makeFakeStt()
    render(<TranscriptView sttFactory={() => stt} />)
    await userEvent.click(screen.getByRole('button', { name: /listen/i }))
    await userEvent.click(screen.getByRole('button', { name: /stop/i }))
    expect(stt.stop).toHaveBeenCalled()
  })
})
