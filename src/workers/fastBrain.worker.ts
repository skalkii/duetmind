/// <reference lib="webworker" />
/**
 * Fast brain — pure rule engine in a Web Worker.
 *
 * Imports `decideTick` from the shared module so the rule logic lives in
 * exactly one place (DRY). This file is intentionally tiny — its job is to
 * be the transport boundary, not to host any new behavior.
 */

import { decideTick, type DecisionConfig } from '../lib/decisionRules'
import type { FastWorkerInbound, FastWorkerOutbound } from '../types/protocol'

declare const self: DedicatedWorkerGlobalScope

self.addEventListener('message', (event: MessageEvent<FastWorkerInbound>) => {
  const msg = event.data
  if (!msg || msg.kind !== 'tick') return
  const decision = decideTick(msg.input, {
    config: (msg.configOverride ?? {}) as Partial<DecisionConfig>,
  })
  const reply: FastWorkerOutbound = {
    kind: 'decision',
    tickId: msg.tickId,
    decision,
  }
  self.postMessage(reply)
})
