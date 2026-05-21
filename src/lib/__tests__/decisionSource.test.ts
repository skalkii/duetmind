import { describe, expect, it, vi } from 'vitest'
import {
  createInlineDecisionSource,
  createWorkerDecisionSource,
} from '../decisionSource'
import type { TypedWorker } from '../workerBridge'
import type {
  FastWorkerInbound,
  FastWorkerOutbound,
  TickInput,
} from '../../types/protocol'

function baseInput(over: Partial<TickInput> = {}): TickInput {
  return {
    userSpeaking: false,
    userTranscriptPartial: '',
    userTranscriptFinal: '',
    msSinceUserLastSpoke: Number.POSITIVE_INFINITY,
    msSinceUserStartedSpeaking: 0,
    selfSpeaking: false,
    slowReplyReady: false,
    slowReplyText: null,
    tickCount: 0,
    msSinceLastBackchannel: Number.POSITIVE_INFINITY,
    replyInFlight: false,
    turnEndConfidence: 0,
    ...over,
  }
}

describe('createInlineDecisionSource', () => {
  it('resolves with the synchronous rule result', async () => {
    const src = createInlineDecisionSource({ random: () => 0 })
    const decision = await src.decide(
      1,
      baseInput({
        userSpeaking: true,
        selfSpeaking: true,
        msSinceUserStartedSpeaking: 500,
      }),
    )
    expect(decision.action).toBe('interrupt_self')
  })

  it('dispose is a no-op', () => {
    const src = createInlineDecisionSource()
    expect(() => src.dispose()).not.toThrow()
  })
})

interface FakeFastWorker extends TypedWorker<
  FastWorkerInbound,
  FastWorkerOutbound
> {
  emit(message: FastWorkerOutbound): void
  emitError(message: string): void
  sent: FastWorkerInbound[]
  isTerminated: boolean
}

function makeFakeFastWorker(): FakeFastWorker {
  const messageListeners = new Set<(m: FastWorkerOutbound) => void>()
  const errorListeners = new Set<(e: ErrorEvent) => void>()
  let terminated = false
  const sent: FastWorkerInbound[] = []
  return {
    sent,
    get isTerminated() {
      return terminated
    },
    send(msg) {
      sent.push(msg)
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
    emit(message) {
      for (const cb of messageListeners) cb(message)
    },
    emitError(message) {
      const evt = { message } as unknown as ErrorEvent
      for (const cb of errorListeners) cb(evt)
    },
  }
}

describe('createWorkerDecisionSource', () => {
  it('round-trips a tick via tickId correlation', async () => {
    const w = makeFakeFastWorker()
    const src = createWorkerDecisionSource(w)
    const p = src.decide(7, baseInput())
    expect(w.sent[0]).toEqual({ kind: 'tick', tickId: 7, input: baseInput() })
    w.emit({ kind: 'decision', tickId: 7, decision: { action: 'silent' } })
    expect((await p).action).toBe('silent')
  })

  it('drops responses whose tickId is not pending', async () => {
    const w = makeFakeFastWorker()
    const src = createWorkerDecisionSource(w)
    const p = src.decide(1, baseInput())
    w.emit({ kind: 'decision', tickId: 999, decision: { action: 'silent' } })
    w.emit({
      kind: 'decision',
      tickId: 1,
      decision: { action: 'request_slow_reply' },
    })
    expect((await p).action).toBe('request_slow_reply')
  })

  it('rejects pending ticks on worker error', async () => {
    const w = makeFakeFastWorker()
    const src = createWorkerDecisionSource(w)
    const p = src.decide(1, baseInput())
    w.emitError('boom')
    await expect(p).rejects.toThrow(/boom/)
  })

  it('dispose terminates the worker and rejects pending ticks', async () => {
    const w = makeFakeFastWorker()
    const src = createWorkerDecisionSource(w)
    const p = src.decide(1, baseInput())
    const onRej = vi.fn()
    p.catch(onRej)
    src.dispose()
    await Promise.resolve()
    expect(w.isTerminated).toBe(true)
    expect(onRej).toHaveBeenCalled()
  })
})
