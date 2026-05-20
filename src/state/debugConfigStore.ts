/**
 * Live-tunable subset of DecisionConfig + the duplex/turn-based mode toggle.
 * The orchestrator reads this on every tick (via a getter passed at
 * construction), so a slider or mode flip in the UI moves behaviour
 * without restarting the session.
 */

import { create } from 'zustand'
import {
  DEFAULT_DECISION_CONFIG,
  type DecisionConfig,
} from '../lib/decisionRules'

export type InteractionMode = 'duplex' | 'turn_based'

export interface DebugConfigState {
  readonly mode: InteractionMode
  readonly silenceThresholdMs: number
  readonly backchannelRate: number
  readonly bargeInEnabled: boolean
  readonly backchannelEnabled: boolean
  readonly fastStallEnabled: boolean
}

export interface DebugConfigActions {
  setMode(mode: InteractionMode): void
  setSilenceThresholdMs(ms: number): void
  setBackchannelRate(rate: number): void
  reset(): void
}

const DUPLEX: DebugConfigState = {
  mode: 'duplex',
  silenceThresholdMs: DEFAULT_DECISION_CONFIG.silenceThresholdMs,
  backchannelRate: DEFAULT_DECISION_CONFIG.backchannelRate,
  bargeInEnabled: true,
  backchannelEnabled: true,
  fastStallEnabled: true,
}

const TURN_BASED: DebugConfigState = {
  ...DUPLEX,
  mode: 'turn_based',
  bargeInEnabled: false,
  backchannelEnabled: false,
  fastStallEnabled: false,
}

export const useDebugConfigStore = create<
  DebugConfigState & DebugConfigActions
>((set) => ({
  ...DUPLEX,
  setMode: (mode) => set(mode === 'duplex' ? DUPLEX : TURN_BASED),
  setSilenceThresholdMs: (ms) => set({ silenceThresholdMs: Math.max(0, ms) }),
  setBackchannelRate: (rate) =>
    set({ backchannelRate: Math.min(1, Math.max(0, rate)) }),
  reset: () => set(DUPLEX),
}))

/**
 * Project a snapshot of the debug-config store down to the
 * `Partial<DecisionConfig>` shape the orchestrator hands to `decideTick`.
 */
export function toDecisionConfig(s: DebugConfigState): Partial<DecisionConfig> {
  return {
    silenceThresholdMs: s.silenceThresholdMs,
    backchannelRate: s.backchannelRate,
    bargeInEnabled: s.bargeInEnabled,
    backchannelEnabled: s.backchannelEnabled,
    fastStallEnabled: s.fastStallEnabled,
  }
}
