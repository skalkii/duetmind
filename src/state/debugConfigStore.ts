/**
 * Live-tunable subset of DecisionConfig. The orchestrator reads this on
 * every tick (via a getter passed at construction), so a slider in the
 * debug panel can move the thresholds without restarting the session.
 */

import { create } from 'zustand'
import { DEFAULT_DECISION_CONFIG } from '../lib/decisionRules'

export interface DebugConfigState {
  readonly silenceThresholdMs: number
  readonly backchannelRate: number
}

export interface DebugConfigActions {
  setSilenceThresholdMs(ms: number): void
  setBackchannelRate(rate: number): void
  reset(): void
}

const INITIAL: DebugConfigState = {
  silenceThresholdMs: DEFAULT_DECISION_CONFIG.silenceThresholdMs,
  backchannelRate: DEFAULT_DECISION_CONFIG.backchannelRate,
}

export const useDebugConfigStore = create<
  DebugConfigState & DebugConfigActions
>((set) => ({
  ...INITIAL,
  setSilenceThresholdMs: (ms) => set({ silenceThresholdMs: Math.max(0, ms) }),
  setBackchannelRate: (rate) =>
    set({ backchannelRate: Math.min(1, Math.max(0, rate)) }),
  reset: () => set(INITIAL),
}))
