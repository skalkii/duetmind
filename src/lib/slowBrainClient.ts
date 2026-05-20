/**
 * Main-thread client for the slow brain worker.
 *
 * Owns nothing about the model itself — the worker does. This file:
 *  - tracks lifecycle (idle → loading → ready | error)
 *  - surfaces load progress events
 *  - resolves a `load()` promise once the worker reports `ready`
 *  - exposes a `generate()` handle that streams tokens, completes on
 *    `done` or `aborted`, and lets the caller `abort()` mid-stream.
 *
 * Each generation is keyed by a runId. The orchestrator's barge-in path
 * calls `abort()` on the active handle synchronously.
 */

import type { TypedWorker } from './workerBridge'
import type {
  ChatMessage,
  SlowWorkerInbound,
  SlowWorkerOutbound,
} from '../types/protocol'

export type SlowBrainStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface SlowGenerateOptions {
  /** Structured chat messages. Worker applies the model's chat template. */
  readonly messages: readonly ChatMessage[]
  onToken?(text: string): void
  onDone?(): void
  onAborted?(): void
  onError?(message: string): void
}

export interface SlowGenerateHandle {
  readonly runId: string
  abort(): void
}

export interface SlowBrain {
  load(modelId?: string): Promise<void>
  generate(options: SlowGenerateOptions): SlowGenerateHandle
  onProgress(cb: (pct: number) => void): () => void
  onStatus(cb: (status: SlowBrainStatus) => void): () => void
  terminate(): void
  readonly status: SlowBrainStatus
  readonly error: string | null
  readonly progress: number
}

function makeRunId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `r${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

interface ActiveRun {
  options: SlowGenerateOptions
}

export function createSlowBrain(
  worker: TypedWorker<SlowWorkerInbound, SlowWorkerOutbound>,
): SlowBrain {
  let status: SlowBrainStatus = 'idle'
  let error: string | null = null
  let progress = 0
  const progressListeners = new Set<(pct: number) => void>()
  const statusListeners = new Set<(s: SlowBrainStatus) => void>()
  const pendingReady: Array<{
    resolve: () => void
    reject: (e: Error) => void
  }> = []
  const activeRuns = new Map<string, ActiveRun>()

  const setStatus = (next: SlowBrainStatus): void => {
    if (status === next) return
    status = next
    for (const cb of statusListeners) cb(next)
  }

  const settleReady = (err: Error | null): void => {
    const waiters = pendingReady.splice(0, pendingReady.length)
    for (const w of waiters) {
      if (err) w.reject(err)
      else w.resolve()
    }
  }

  const failAllRuns = (message: string): void => {
    const runs = [...activeRuns.entries()]
    activeRuns.clear()
    for (const [, { options }] of runs) {
      options.onError?.(message)
    }
  }

  worker.onMessage((msg) => {
    switch (msg.kind) {
      case 'load_progress':
        progress = msg.pct
        for (const cb of progressListeners) cb(msg.pct)
        return
      case 'ready':
        progress = 1
        error = null
        setStatus('ready')
        settleReady(null)
        return
      case 'token': {
        const run = activeRuns.get(msg.runId)
        run?.options.onToken?.(msg.text)
        return
      }
      case 'done': {
        const run = activeRuns.get(msg.runId)
        activeRuns.delete(msg.runId)
        run?.options.onDone?.()
        return
      }
      case 'aborted': {
        const run = activeRuns.get(msg.runId)
        activeRuns.delete(msg.runId)
        run?.options.onAborted?.()
        return
      }
      case 'error': {
        error = msg.message
        // Always flip status — a mid-generation error means the worker is
        // in an unknown state, and silently leaving it on `ready` would
        // mislead the UI and let subsequent loads resolve immediately.
        setStatus('error')
        // Scoped error (carries runId) → fail just that run. Otherwise
        // fail everything in flight.
        if (msg.runId !== undefined) {
          const run = activeRuns.get(msg.runId)
          activeRuns.delete(msg.runId)
          run?.options.onError?.(msg.message)
        } else if (activeRuns.size > 0) {
          failAllRuns(msg.message)
        }
        settleReady(new Error(msg.message))
        return
      }
    }
  })

  worker.onError((event) => {
    error = event.message ?? 'slow worker errored'
    setStatus('error')
    if (activeRuns.size > 0) failAllRuns(error)
    settleReady(new Error(error))
  })

  return {
    load(modelId?: string): Promise<void> {
      if (status === 'ready') return Promise.resolve()
      return new Promise<void>((resolve, reject) => {
        pendingReady.push({ resolve, reject })
        if (status !== 'loading') {
          setStatus('loading')
          worker.send(
            modelId !== undefined
              ? { kind: 'load', modelId }
              : { kind: 'load' },
          )
        }
      })
    },
    generate(options): SlowGenerateHandle {
      const runId = makeRunId()
      activeRuns.set(runId, { options })
      worker.send({
        kind: 'generate',
        runId,
        messages: options.messages,
      })
      return {
        runId,
        abort: (): void => {
          if (!activeRuns.has(runId)) return
          worker.send({ kind: 'abort', runId })
        },
      }
    },
    onProgress(cb): () => void {
      progressListeners.add(cb)
      return () => {
        progressListeners.delete(cb)
      }
    },
    onStatus(cb): () => void {
      statusListeners.add(cb)
      return () => {
        statusListeners.delete(cb)
      }
    },
    terminate(): void {
      settleReady(new Error('slow brain terminated'))
      failAllRuns('slow brain terminated')
      progressListeners.clear()
      statusListeners.clear()
      worker.terminate()
    },
    get status(): SlowBrainStatus {
      return status
    },
    get error(): string | null {
      return error
    },
    get progress(): number {
      return progress
    },
  }
}
