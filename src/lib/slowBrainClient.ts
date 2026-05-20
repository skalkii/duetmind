/**
 * Main-thread client for the slow brain worker.
 *
 * Owns nothing about the model itself — the worker does. This file only
 * tracks lifecycle (idle → loading → ready | error), surfaces progress
 * events, and resolves a `load()` promise once the worker reports `ready`.
 */

import type { TypedWorker } from './workerBridge'
import type { SlowWorkerInbound, SlowWorkerOutbound } from '../types/protocol'

export type SlowBrainStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface SlowBrain {
  load(): Promise<void>
  onProgress(cb: (pct: number) => void): () => void
  onStatus(cb: (status: SlowBrainStatus) => void): () => void
  terminate(): void
  readonly status: SlowBrainStatus
  readonly error: string | null
  readonly progress: number
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
      case 'error':
        error = msg.message
        setStatus('error')
        settleReady(new Error(msg.message))
        return
      // T4.2 will handle token/done/aborted.
      default:
        return
    }
  })

  worker.onError((event) => {
    error = event.message ?? 'slow worker errored'
    setStatus('error')
    settleReady(new Error(error))
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
