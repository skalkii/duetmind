/**
 * Pluggable source of `TickDecision`s.
 *
 * The orchestrator depends only on the `DecisionSource` shape, so the rule
 * engine can live either inline on the main thread (tests, jsdom, fallback)
 * or in a Web Worker (production hot path). When the source is the worker,
 * each tick is correlated by `tickId` and stale responses are dropped — if
 * the orchestrator has already moved past the tick a response refers to,
 * we don't apply it.
 */

import { decideTick, type DecideTickOptions } from './decisionRules'
import type { TypedWorker } from './workerBridge'
import type {
  FastWorkerInbound,
  FastWorkerOutbound,
  TickDecision,
  TickInput,
} from '../types/protocol'

export interface DecisionSource {
  decide(tickId: number, input: TickInput): Promise<TickDecision>
  dispose(): void
}

export function createInlineDecisionSource(
  options: DecideTickOptions = {},
): DecisionSource {
  return {
    async decide(_tickId, input) {
      return decideTick(input, options)
    },
    dispose() {
      /* no-op */
    },
  }
}

interface PendingTick {
  resolve(decision: TickDecision): void
  reject(error: Error): void
}

export function createWorkerDecisionSource(
  worker: TypedWorker<FastWorkerInbound, FastWorkerOutbound>,
): DecisionSource {
  const pending = new Map<number, PendingTick>()

  const offMessage = worker.onMessage((msg) => {
    const slot = pending.get(msg.tickId)
    if (!slot) return // stale or superseded
    pending.delete(msg.tickId)
    slot.resolve(msg.decision)
  })

  const offError = worker.onError((event) => {
    for (const [, slot] of pending) {
      slot.reject(new Error(event.message ?? 'fast worker errored'))
    }
    pending.clear()
  })

  return {
    decide(tickId, input) {
      return new Promise<TickDecision>((resolve, reject) => {
        pending.set(tickId, { resolve, reject })
        worker.send({ kind: 'tick', tickId, input })
      })
    },
    dispose() {
      offMessage()
      offError()
      for (const [, slot] of pending) {
        slot.reject(new Error('decision source disposed'))
      }
      pending.clear()
      worker.terminate()
    },
  }
}
