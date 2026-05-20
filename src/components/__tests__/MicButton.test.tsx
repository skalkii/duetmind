import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { MicButton } from '../MicButton'
import type { AudioMeter } from '../../lib/audio'

function makeFakeMeter(overrides?: Partial<AudioMeter>): AudioMeter {
  let levelCb: ((rms: number) => void) | null = null
  const meter: AudioMeter = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(),
    getRms: vi.fn(() => 0),
    onLevel: vi.fn((cb) => {
      levelCb = cb
      return () => {
        levelCb = null
      }
    }),
    isRunning: false,
    ...overrides,
  }
  ;(meter as AudioMeter & { __emit?: (n: number) => void }).__emit = (n) =>
    levelCb?.(n)
  return meter
}

describe('<MicButton />', () => {
  it('starts the meter when clicked', async () => {
    const meter = makeFakeMeter()
    render(<MicButton meterFactory={() => meter} />)
    await userEvent.click(screen.getByRole('button', { name: /start mic/i }))
    expect(meter.start).toHaveBeenCalledTimes(1)
    expect(
      await screen.findByRole('button', { name: /stop mic/i }),
    ).toBeInTheDocument()
  })

  it('shows a friendly error if start rejects', async () => {
    const meter = makeFakeMeter({
      start: vi.fn(async () => {
        throw new Error('NotAllowedError')
      }),
    })
    render(<MicButton meterFactory={() => meter} />)
    await userEvent.click(screen.getByRole('button', { name: /start mic/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /NotAllowedError/,
    )
  })

  it('stops the meter on toggle', async () => {
    const meter = makeFakeMeter()
    render(<MicButton meterFactory={() => meter} />)
    await userEvent.click(screen.getByRole('button', { name: /start mic/i }))
    await userEvent.click(screen.getByRole('button', { name: /stop mic/i }))
    expect(meter.stop).toHaveBeenCalled()
    expect(
      screen.getByRole('button', { name: /start mic/i }),
    ).toBeInTheDocument()
  })
})
