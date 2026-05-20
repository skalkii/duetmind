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
import type { SlowWorkerInbound, SlowWorkerOutbound } from '../types/protocol'

export type SlowBrainStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface SlowGenerateOptions {
  readonly prompt: string
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
  load(): Promise<void>
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
      case 'error':
        error = msg.message
        // Errors don't carry a runId, so route them to all active runs and
        // also reject any pending load — whichever was waiting deserves the
        // signal. Status flips iff there is nothing else in flight.
        if (activeRuns.size > 0) {
          failAllRuns(msg.message)
        }
        if (pendingReady.length > 0) {
          setStatus('error')
          settleReady(new Error(msg.message))
        }
        return
    }
  })

  worker.onError((event) => {
    error = event.message ?? 'slow worker errored'
    if (activeRuns.size > 0) failAllRuns(error)
    if (pendingReady.length > 0) {
      setStatus('error')
      settleReady(new Error(error))
    }
  })

  return {
    load(): Promise<void> {
      if (status === 'ready') return Promise.resolve()
      return new Promise<void>((resolve, reject) => {
        pendingReady.push({ resolve, reject })
        if (status !== 'loading') {
          setStatus('loading')
          worker.send({ kind: 'load' })
        }
      })
    },
    generate(options): SlowGenerateHandle {
      const runId = makeRunId()
      activeRuns.set(runId, { options })
      worker.send({ kind: 'generate', runId, prompt: options.prompt })
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
