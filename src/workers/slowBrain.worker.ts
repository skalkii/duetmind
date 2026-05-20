/// <reference lib="webworker" />
/**
 * Slow brain — Transformers.js pipeline in a Web Worker.
 *
 * Loads SmolLM2-360M-Instruct on first `load` message. Tries WebGPU and
 * falls back to WASM so the app keeps working on machines without WebGPU.
 * Progress callbacks are forwarded verbatim — the main thread decides how
 * to render them.
 *
 * T4.1 only covers model loading. T4.2 will add generate/abort/token.
 */

import { pipeline } from '@huggingface/transformers'
import type { SlowWorkerInbound, SlowWorkerOutbound } from '../types/protocol'

declare const self: DedicatedWorkerGlobalScope

const MODEL_ID = 'HuggingFaceTB/SmolLM2-360M-Instruct'

function pickDevice(): 'webgpu' | 'wasm' {
  if (typeof navigator !== 'undefined' && 'gpu' in navigator) {
    return 'webgpu'
  }
  return 'wasm'
}

interface ProgressEvent {
  status: string
  progress?: number
}

let loading: Promise<unknown> | null = null
let loaded = false

const post = (m: SlowWorkerOutbound): void => self.postMessage(m)

async function load(): Promise<void> {
  if (loaded) {
    post({ kind: 'ready' })
    return
  }
  if (loading) {
    await loading
    return
  }
  loading = (async () => {
    try {
      const options = {
        device: pickDevice(),
        dtype: 'q4',
        progress_callback: (event: ProgressEvent) => {
          if (typeof event.progress === 'number') {
            // Transformers.js reports progress as 0–100 per file.
            post({ kind: 'load_progress', pct: event.progress / 100 })
          }
        },
      } as unknown as Parameters<typeof pipeline>[2]
      await pipeline('text-generation', MODEL_ID, options)
      loaded = true
      post({ kind: 'ready' })
    } catch (err) {
      post({
        kind: 'error',
        message: err instanceof Error ? err.message : 'model load failed',
      })
    } finally {
      loading = null
    }
  })()
  await loading
}

self.addEventListener('message', (event: MessageEvent<SlowWorkerInbound>) => {
  const msg = event.data
  if (!msg) return
  if (msg.kind === 'load') {
    void load()
  }
  // T4.2 will handle generate/abort.
})
