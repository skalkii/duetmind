import { describe, expect, it, vi } from 'vitest'
import { createSlowBrain } from '../slowBrainClient'
import type { TypedWorker } from '../workerBridge'
import type {
  SlowWorkerInbound,
  SlowWorkerOutbound,
} from '../../types/protocol'

interface FakeSlow extends TypedWorker<SlowWorkerInbound, SlowWorkerOutbound> {
  emit(msg: SlowWorkerOutbound): void
  emitError(message: string): void
  sent: SlowWorkerInbound[]
  isTerminated: boolean
}

function makeFakeSlow(): FakeSlow {
  const messageListeners = new Set<(m: SlowWorkerOutbound) => void>()
  const errorListeners = new Set<(e: ErrorEvent) => void>()
  let terminated = false
  const sent: SlowWorkerInbound[] = []
  return {
    sent,
    get isTerminated() {
      return terminated
    },
    send(m) {
      sent.push(m)
    },
    onMessage(cb) {
      messageListeners.add(cb)
      return () => {
        messageListeners.delete(cb)
      }
    },
    onError(cb) {
      errorListeners.add(cb)
      return () => {
        errorListeners.delete(cb)
      }
    },
    terminate() {
      terminated = true
    },
    emit(m) {
      for (const cb of messageListeners) cb(m)
    },
    emitError(message) {
      const evt = { message } as unknown as ErrorEvent
      for (const cb of errorListeners) cb(evt)
    },
  }
}

describe('createSlowBrain', () => {
  it('starts in idle and sends a load message on load()', () => {
    const w = makeFakeSlow()
    const sb = createSlowBrain(w)
    expect(sb.status).toBe('idle')
    void sb.load()
    expect(sb.status).toBe('loading')
    expect(w.sent).toEqual([{ kind: 'load' }])
  })

  it('resolves load() when worker emits ready', async () => {
    const w = makeFakeSlow()
    const sb = createSlowBrain(w)
    const p = sb.load()
    w.emit({ kind: 'ready' })
    await p
    expect(sb.status).toBe('ready')
    expect(sb.progress).toBe(1)
  })

  it('fans out load_progress to listeners', () => {
    const w = makeFakeSlow()
    const sb = createSlowBrain(w)
    const seen: number[] = []
    sb.onProgress((p) => seen.push(p))
    void sb.load()
    w.emit({ kind: 'load_progress', pct: 0.25 })
    w.emit({ kind: 'load_progress', pct: 0.75 })
    expect(seen).toEqual([0.25, 0.75])
    expect(sb.progress).toBe(0.75)
  })

  it('rejects load() and flips to error on worker error message', async () => {
    const w = makeFakeSlow()
    const sb = createSlowBrain(w)
    const p = sb.load()
    w.emit({ kind: 'error', message: 'gpu unavailable' })
    await expect(p).rejects.toThrow(/gpu unavailable/)
    expect(sb.status).toBe('error')
    expect(sb.error).toBe('gpu unavailable')
  })

  it('rejects load() on a worker ErrorEvent', async () => {
    const w = makeFakeSlow()
    const sb = createSlowBrain(w)
    const p = sb.load()
    w.emitError('runtime crash')
    await expect(p).rejects.toThrow(/runtime crash/)
    expect(sb.status).toBe('error')
  })

  it('load() after ready resolves immediately without re-sending', async () => {
    const w = makeFakeSlow()
    const sb = createSlowBrain(w)
    const p = sb.load()
    w.emit({ kind: 'ready' })
    await p
    await sb.load()
    expect(w.sent).toEqual([{ kind: 'load' }])
  })

  it('emits status transitions for subscribers', () => {
    const w = makeFakeSlow()
    const sb = createSlowBrain(w)
    const statuses: string[] = []
    sb.onStatus((s) => statuses.push(s))
    void sb.load()
    w.emit({ kind: 'load_progress', pct: 0.5 })
    w.emit({ kind: 'ready' })
    expect(statuses).toEqual(['loading', 'ready'])
  })

  it('terminate rejects pending loads and propagates to the worker', async () => {
    const w = makeFakeSlow()
    const sb = createSlowBrain(w)
    const p = sb.load()
    const onRej = vi.fn()
    p.catch(onRej)
    sb.terminate()
    await Promise.resolve()
    expect(onRej).toHaveBeenCalled()
    expect(w.isTerminated).toBe(true)
  })
})

describe('createSlowBrain — generate()', () => {
  it('sends a generate message with a unique runId', () => {
    const w = makeFakeSlow()
    const sb = createSlowBrain(w)
    const h = sb.generate({ prompt: 'hi', onToken: () => undefined })
    expect(w.sent[0]).toEqual({
      kind: 'generate',
      runId: h.runId,
      prompt: 'hi',
    })
  })

  it('routes tokens for the matching runId to onToken', () => {
    const w = makeFakeSlow()
    const sb = createSlowBrain(w)
    const tokens: string[] = []
    const h = sb.generate({
      prompt: 'hi',
      onToken: (t) => tokens.push(t),
    })
    w.emit({ kind: 'token', runId: h.runId, text: 'Hello' })
    w.emit({ kind: 'token', runId: h.runId, text: ' world' })
    expect(tokens).toEqual(['Hello', ' world'])
  })

  it('drops tokens for unknown runIds', () => {
    const w = makeFakeSlow()
    const sb = createSlowBrain(w)
    const tokens: string[] = []
    sb.generate({ prompt: 'hi', onToken: (t) => tokens.push(t) })
    w.emit({ kind: 'token', runId: 'not-my-run', text: 'noise' })
    expect(tokens).toEqual([])
  })

  it('calls onDone once and stops routing further tokens', () => {
    const w = makeFakeSlow()
    const sb = createSlowBrain(w)
    const tokens: string[] = []
    const onDone = vi.fn()
    const h = sb.generate({
      prompt: 'hi',
      onToken: (t) => tokens.push(t),
      onDone,
    })
    w.emit({ kind: 'token', runId: h.runId, text: 'a' })
    w.emit({ kind: 'done', runId: h.runId })
    w.emit({ kind: 'token', runId: h.runId, text: 'b' })
    expect(tokens).toEqual(['a'])
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('abort() sends an abort message and onAborted fires on aborted event', () => {
    const w = makeFakeSlow()
    const sb = createSlowBrain(w)
    const onAborted = vi.fn()
    const h = sb.generate({ prompt: 'hi', onAborted })
    h.abort()
    expect(w.sent[1]).toEqual({ kind: 'abort', runId: h.runId })
    w.emit({ kind: 'aborted', runId: h.runId })
    expect(onAborted).toHaveBeenCalledTimes(1)
  })

  it('abort() after completion is a no-op', () => {
    const w = makeFakeSlow()
    const sb = createSlowBrain(w)
    const h = sb.generate({ prompt: 'hi' })
    w.emit({ kind: 'done', runId: h.runId })
    h.abort()
    expect(w.sent.filter((m) => m.kind === 'abort')).toEqual([])
  })

  it('worker error message rejects every active generation', () => {
    const w = makeFakeSlow()
    const sb = createSlowBrain(w)
    const onErrorA = vi.fn()
    const onErrorB = vi.fn()
    sb.generate({ prompt: 'one', onError: onErrorA })
    sb.generate({ prompt: 'two', onError: onErrorB })
    w.emit({ kind: 'error', message: 'OOM' })
    expect(onErrorA).toHaveBeenCalledWith('OOM')
    expect(onErrorB).toHaveBeenCalledWith('OOM')
  })

  it('terminate aborts active generations through onError', () => {
    const w = makeFakeSlow()
    const sb = createSlowBrain(w)
    const onError = vi.fn()
    sb.generate({ prompt: 'hi', onError })
    sb.terminate()
    expect(onError).toHaveBeenCalledWith('slow brain terminated')
  })
})
