import { describe, expect, it, vi } from 'vitest'
import { createTypedWorker, type WorkerLike } from '../workerBridge'

interface FakeWorker extends WorkerLike {
  emitMessage(data: unknown): void
  emitError(event: ErrorEvent): void
  posted: unknown[]
  terminated: boolean
}

function makeFakeWorker(): FakeWorker {
  const messageListeners: Array<(e: { data: unknown }) => void> = []
  const errorListeners: Array<(e: ErrorEvent) => void> = []
  return {
    posted: [],
    terminated: false,
    postMessage(data) {
      this.posted.push(data)
    },
    addEventListener(type, listener) {
      if (type === 'message') {
        messageListeners.push(listener as (e: { data: unknown }) => void)
      } else {
        errorListeners.push(listener as (e: ErrorEvent) => void)
      }
    },
    removeEventListener(type, listener) {
      const arr =
        type === 'message'
          ? (messageListeners as Array<unknown>)
          : (errorListeners as Array<unknown>)
      const i = arr.indexOf(listener)
      if (i >= 0) arr.splice(i, 1)
    },
    terminate() {
      this.terminated = true
    },
    emitMessage(data) {
      for (const l of messageListeners.slice()) l({ data })
    },
    emitError(event) {
      for (const l of errorListeners.slice()) l(event)
    },
  }
}

interface InMsg {
  kind: 'ping'
  payload: number
}
interface OutMsg {
  kind: 'pong'
  payload: number
}

describe('createTypedWorker', () => {
  it('send posts the message verbatim', () => {
    const w = makeFakeWorker()
    const bridge = createTypedWorker<InMsg, OutMsg>(w)
    bridge.send({ kind: 'ping', payload: 1 })
    expect(w.posted).toEqual([{ kind: 'ping', payload: 1 }])
  })

  it('routes worker messages to onMessage listeners', () => {
    const w = makeFakeWorker()
    const bridge = createTypedWorker<InMsg, OutMsg>(w)
    const received: OutMsg[] = []
    bridge.onMessage((m) => received.push(m))
    w.emitMessage({ kind: 'pong', payload: 42 })
    expect(received).toEqual([{ kind: 'pong', payload: 42 }])
  })

  it('unsubscribing stops further calls', () => {
    const w = makeFakeWorker()
    const bridge = createTypedWorker<InMsg, OutMsg>(w)
    const cb = vi.fn()
    const off = bridge.onMessage(cb)
    w.emitMessage({ kind: 'pong', payload: 1 })
    off()
    w.emitMessage({ kind: 'pong', payload: 2 })
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('routes errors to onError', () => {
    const w = makeFakeWorker()
    const bridge = createTypedWorker<InMsg, OutMsg>(w)
    const seen: ErrorEvent[] = []
    bridge.onError((e) => seen.push(e))
    const evt = { message: 'boom' } as unknown as ErrorEvent
    w.emitError(evt)
    expect(seen).toEqual([evt])
  })

  it('terminate detaches listeners + flips isTerminated + calls worker.terminate', () => {
    const w = makeFakeWorker()
    const bridge = createTypedWorker<InMsg, OutMsg>(w)
    const cb = vi.fn()
    bridge.onMessage(cb)
    bridge.terminate()
    expect(bridge.isTerminated).toBe(true)
    expect(w.terminated).toBe(true)
    w.emitMessage({ kind: 'pong', payload: 1 })
    expect(cb).not.toHaveBeenCalled()
  })

  it('send after terminate is a no-op', () => {
    const w = makeFakeWorker()
    const bridge = createTypedWorker<InMsg, OutMsg>(w)
    bridge.terminate()
    bridge.send({ kind: 'ping', payload: 1 })
    expect(w.posted).toEqual([])
  })

  it('terminate is idempotent', () => {
    const w = makeFakeWorker()
    const bridge = createTypedWorker<InMsg, OutMsg>(w)
    bridge.terminate()
    bridge.terminate()
    expect(w.terminated).toBe(true)
  })
})
