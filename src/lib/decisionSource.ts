/**
 * Pluggable source of `TickDecision`s.
 *
 * The orchestrator depends only on the `DecisionSource` shape, so the rule
 * engine can live either inline on the main thread (tests, jsdom, fallback)
 * or in a Web Worker (production hot path). When the source is the worker,
 * each tick is correlated by `tickId` and stale responses are dropped — if
 * the orchestrator has already moved past the tick a response refers to,
 * we don't apply it.
 *
 * `decide` takes an optional `configOverride` so live-tuned thresholds
 * (debug panel knobs) reach both inline and worker engines per tick.
 */

import { decideTick, type DecisionConfig } from './decisionRules'
import type { TypedWorker } from './workerBridge'
import type {
  FastWorkerInbound,
  FastWorkerOutbound,
  TickDecision,
  TickInput,
} from '../types/protocol'

export interface DecisionSource {
  decide(
    tickId: number,
    input: TickInput,
    configOverride?: Partial<DecisionConfig>,
  ): Promise<TickDecision>
  dispose(): void
}

export interface InlineDecisionOptions {
  readonly random?: () => number
}

export function createInlineDecisionSource(
  options: InlineDecisionOptions = {},
): DecisionSource {
  return {
    async decide(_tickId, input, configOverride) {
      return decideTick(input, {
        ...(configOverride ? { config: configOverride } : {}),
        ...(options.random ? { random: options.random } : {}),
      })
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
    if (!slot) return
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
    decide(tickId, input, configOverride) {
      return new Promise<TickDecision>((resolve, reject) => {
        pending.set(tickId, { resolve, reject })
        worker.send({
          kind: 'tick',
          tickId,
          input,
          ...(configOverride
            ? {
                configOverride: configOverride as Readonly<
                  Record<string, number>
                >,
              }
            : {}),
        })
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
