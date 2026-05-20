/// <reference lib="webworker" />
/**
 * Slow brain — Transformers.js pipeline in a Web Worker.
 *
 * Loads SmolLM2-360M-Instruct on first `load` message. Tries WebGPU and
 * falls back to WASM so the app keeps working on machines without WebGPU.
 *
 * Generation streams tokens via a TextStreamer and is cancellable via an
 * InterruptableStoppingCriteria — the orchestrator's `interrupt_self`
 * action will pull the abort lever when the user barges in.
 */

import {
  pipeline,
  TextStreamer,
  InterruptableStoppingCriteria,
} from '@huggingface/transformers'
import type { SlowWorkerInbound, SlowWorkerOutbound } from '../types/protocol'

declare const self: DedicatedWorkerGlobalScope

const MODEL_ID = 'HuggingFaceTB/SmolLM2-360M-Instruct'
const DEFAULT_MAX_NEW_TOKENS = 96

interface PipelineLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (input: unknown, options: Record<string, unknown>): Promise<any>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tokenizer: any
}

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
let generator: PipelineLike | null = null
let activeRunId: string | null = null
let stopper: InterruptableStoppingCriteria | null = null

const post = (m: SlowWorkerOutbound): void => self.postMessage(m)

async function load(): Promise<void> {
  if (generator) {
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
            post({ kind: 'load_progress', pct: event.progress / 100 })
          }
        },
      } as unknown as Parameters<typeof pipeline>[2]
      const pipe = await pipeline('text-generation', MODEL_ID, options)
      generator = pipe as unknown as PipelineLike
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

async function generate(runId: string, prompt: string): Promise<void> {
  if (!generator) {
    post({ kind: 'error', message: 'model not loaded' })
    return
  }
  // Pre-empt any in-flight generation. Old run will emit `aborted` once the
  // stopper trips inside the model loop.
  if (activeRunId && stopper) stopper.interrupt()

  activeRunId = runId
  const localStopper = new InterruptableStoppingCriteria()
  stopper = localStopper

  const streamer = new TextStreamer(generator.tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (text: string) => {
      if (activeRunId !== runId) return
      if (!text) return
      post({ kind: 'token', runId, text })
    },
  })

  try {
    // The orchestrator sends either a plain user-turn string or a
    // JSON-serialised chat message array. Detect + parse.
    let messages: Array<{ role: string; content: string }>
    if (prompt.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(prompt)
        if (Array.isArray(parsed)) {
          messages = parsed as Array<{ role: string; content: string }>
        } else {
          messages = [{ role: 'user', content: prompt }]
        }
      } catch {
        messages = [{ role: 'user', content: prompt }]
      }
    } else {
      messages = [{ role: 'user', content: prompt }]
    }
    await generator(messages, {
      max_new_tokens: DEFAULT_MAX_NEW_TOKENS,
      do_sample: false,
      streamer,
      stopping_criteria: localStopper,
    })
    if (localStopper.interrupted) {
      post({ kind: 'aborted', runId })
    } else {
      post({ kind: 'done', runId })
    }
  } catch (err) {
    post({
      kind: 'error',
      message: err instanceof Error ? err.message : 'generation failed',
    })
  } finally {
    if (activeRunId === runId) {
      activeRunId = null
      stopper = null
    }
  }
}

function abort(runId: string): void {
  if (activeRunId === runId && stopper) {
    stopper.interrupt()
  }
}

self.addEventListener('message', (event: MessageEvent<SlowWorkerInbound>) => {
  const msg = event.data
  if (!msg) return
  switch (msg.kind) {
    case 'load':
      void load()
      return
    case 'generate':
      void generate(msg.runId, msg.prompt)
      return
    case 'abort':
      abort(msg.runId)
      return
  }
})
