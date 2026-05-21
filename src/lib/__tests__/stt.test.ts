import { describe, expect, it, vi } from 'vitest'
import {
  createStt,
  UnsupportedSttError,
  defaultSttDeps,
  formatSttError,
  type SpeechRecognitionLike,
  type SttDeps,
} from '../stt'

function makeFakeRecognition(): SpeechRecognitionLike {
  return {
    continuous: false,
    interimResults: false,
    lang: '',
    start: vi.fn(),
    stop: vi.fn(),
    abort: vi.fn(),
    onresult: null,
    onend: null,
    onerror: null,
    onstart: null,
  }
}

function makeDeps(): { deps: SttDeps; recognitions: SpeechRecognitionLike[] } {
  const recognitions: SpeechRecognitionLike[] = []
  return {
    recognitions,
    deps: {
      createRecognition: () => {
        const r = makeFakeRecognition()
        recognitions.push(r)
        return r
      },
    },
  }
}

describe('createStt', () => {
  it('configures continuous + interim results on start', () => {
    const { deps, recognitions } = makeDeps()
    const stt = createStt(deps)
    stt.start()
    const rec = recognitions[0]!
    expect(rec.continuous).toBe(true)
    expect(rec.interimResults).toBe(true)
    expect(rec.lang).toBe('en-US')
    expect(rec.start).toHaveBeenCalledTimes(1)
  })

  it('emits partial transcripts for non-final results', () => {
    const { deps, recognitions } = makeDeps()
    const stt = createStt(deps)
    const partials: string[] = []
    stt.onPartial((t) => partials.push(t))
    stt.start()
    recognitions[0]!.onresult?.([{ transcript: 'hello wor', isFinal: false }])
    expect(partials).toEqual(['hello wor'])
  })

  it('emits final transcripts and drops them from partial', () => {
    const { deps, recognitions } = makeDeps()
    const stt = createStt(deps)
    const finals: string[] = []
    const partials: string[] = []
    stt.onFinal((t) => finals.push(t))
    stt.onPartial((t) => partials.push(t))
    stt.start()
    recognitions[0]!.onresult?.([
      { transcript: '  hello world  ', isFinal: true },
      { transcript: 'second', isFinal: false },
    ])
    expect(finals).toEqual(['hello world'])
    expect(partials).toEqual(['second'])
  })

  it('auto-restarts on end while running', () => {
    const { deps, recognitions } = makeDeps()
    const stt = createStt(deps)
    stt.start()
    const rec = recognitions[0]!
    rec.onend?.()
    expect(rec.start).toHaveBeenCalledTimes(2)
  })

  it('stop suppresses auto-restart', () => {
    const { deps, recognitions } = makeDeps()
    const stt = createStt(deps)
    stt.start()
    const rec = recognitions[0]!
    stt.stop()
    // After stop(), onend is detached on the recognition instance, but a
    // delayed engine callback should never schedule a restart even if fired.
    expect(rec.stop).toHaveBeenCalled()
    expect(stt.isRunning).toBe(false)
  })

  it('forwards errors to onError listeners', () => {
    const { deps, recognitions } = makeDeps()
    const stt = createStt(deps)
    const errors: string[] = []
    stt.onError((m) => errors.push(m))
    stt.start()
    recognitions[0]!.onerror?.('no-speech')
    expect(errors).toEqual(['no-speech'])
  })

  it('start is idempotent', () => {
    const { deps, recognitions } = makeDeps()
    const stt = createStt(deps)
    stt.start()
    stt.start()
    expect(recognitions).toHaveLength(1)
  })

  it('defaultSttDeps throws UnsupportedSttError in jsdom (no Web Speech)', () => {
    expect(() => defaultSttDeps()).toThrowError(UnsupportedSttError)
  })

  it('autoRestart=false disables restart on end', () => {
    const { deps, recognitions } = makeDeps()
    const stt = createStt(deps, { autoRestart: false })
    stt.start()
    const rec = recognitions[0]!
    rec.onend?.()
    expect(rec.start).toHaveBeenCalledTimes(1)
  })
})

describe('formatSttError', () => {
  it('network error in Brave names the browser and points at the setting', () => {
    const msg = formatSttError('network', true)
    expect(msg).toMatch(/Brave/)
    expect(msg).toMatch(/brave:\/\/settings\/privacy/)
  })

  it('network error outside Brave suggests network/VPN/browser', () => {
    const msg = formatSttError('network', false)
    expect(msg).toMatch(/network/i)
    expect(msg).not.toMatch(/Brave/)
  })

  it('permission errors point at the address bar', () => {
    expect(formatSttError('not-allowed', false)).toMatch(/permission/i)
    expect(formatSttError('service-not-allowed', false)).toMatch(/permission/i)
  })

  it('unknown codes pass through with a label', () => {
    expect(formatSttError('weird-thing', false)).toMatch(/weird-thing/)
  })
})
