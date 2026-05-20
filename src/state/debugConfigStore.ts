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

export interface ModelOption {
  readonly id: string
  readonly label: string
  readonly approxDownloadMb: number
}

export const MODEL_OPTIONS: readonly ModelOption[] = [
  {
    id: 'HuggingFaceTB/SmolLM2-135M-Instruct',
    label: 'SmolLM2 · 135M (fastest)',
    approxDownloadMb: 100,
  },
  {
    id: 'HuggingFaceTB/SmolLM2-360M-Instruct',
    label: 'SmolLM2 · 360M (default)',
    approxDownloadMb: 280,
  },
  {
    id: 'HuggingFaceTB/SmolLM2-1.7B-Instruct',
    label: 'SmolLM2 · 1.7B (smarter, slower)',
    approxDownloadMb: 1100,
  },
  {
    id: 'Qwen/Qwen2.5-0.5B-Instruct',
    label: 'Qwen2.5 · 0.5B',
    approxDownloadMb: 360,
  },
  {
    id: 'Qwen/Qwen2.5-1.5B-Instruct',
    label: 'Qwen2.5 · 1.5B',
    approxDownloadMb: 1100,
  },
]

export const DEFAULT_MODEL_ID = MODEL_OPTIONS[1]!.id

export interface DebugConfigState {
  readonly mode: InteractionMode
  readonly modelId: string
  readonly silenceThresholdMs: number
  readonly backchannelRate: number
  readonly bargeInEnabled: boolean
  readonly backchannelEnabled: boolean
  readonly fastStallEnabled: boolean
}

export interface DebugConfigActions {
  setMode(mode: InteractionMode): void
  setModelId(modelId: string): void
  setSilenceThresholdMs(ms: number): void
  setBackchannelRate(rate: number): void
  reset(): void
}

const DUPLEX: DebugConfigState = {
  mode: 'duplex',
  modelId: DEFAULT_MODEL_ID,
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
  setMode: (mode) =>
    set((s) =>
      mode === 'duplex'
        ? { ...DUPLEX, modelId: s.modelId }
        : { ...TURN_BASED, modelId: s.modelId },
    ),
  setModelId: (modelId) => set({ modelId }),
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
