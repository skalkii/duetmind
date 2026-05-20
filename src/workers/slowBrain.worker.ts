/// <reference lib="webworker" />
/**
 * Slow brain — Transformers.js pipeline in a Web Worker.
 *
 * Loads SmolLM2-360M-Instruct on first `load` message. Tries WebGPU and
 * falls back to WASM so the app keeps working on machines without WebGPU.
 *
 * Generation streams tokens via a TextStreamer and is cancellable via an
 * InterruptableStoppingCriteria. Each run is tracked as its own object so
 * a pre-emption (new generate while one is in flight) emits exactly one
 * terminal event (`aborted` or `error`) for the old run — never zero,
 * never two.
 */

import {
  pipeline,
  TextStreamer,
  InterruptableStoppingCriteria,
} from '@huggingface/transformers'
import type {
  ChatMessage,
  SlowWorkerInbound,
  SlowWorkerOutbound,
} from '../types/protocol'

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

interface ActiveRun {
  readonly runId: string
  readonly stopper: InterruptableStoppingCriteria
  emittedTerminal: boolean
}

let loading: Promise<unknown> | null = null
let generator: PipelineLike | null = null
let activeRun: ActiveRun | null = null

const post = (m: SlowWorkerOutbound): void => self.postMessage(m)

const emitTerminal = (run: ActiveRun, msg: SlowWorkerOutbound): void => {
  if (run.emittedTerminal) return
  run.emittedTerminal = true
  post(msg)
}

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

async function generate(
  runId: string,
  messages: readonly ChatMessage[],
): Promise<void> {
  if (!generator) {
    post({ kind: 'error', message: 'model not loaded', runId })
    return
  }
  // Pre-empt any in-flight run deterministically: interrupt + emit its
  // terminal event right now, before the old generator loop unwinds. The
  // old run's tail no-ops because emittedTerminal is already true.
  if (activeRun) {
    activeRun.stopper.interrupt()
    emitTerminal(activeRun, { kind: 'aborted', runId: activeRun.runId })
  }

  const stopper = new InterruptableStoppingCriteria()
  const myRun: ActiveRun = { runId, stopper, emittedTerminal: false }
  activeRun = myRun

  const streamer = new TextStreamer(generator.tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (text: string) => {
      if (activeRun !== myRun) return
      if (!text) return
      post({ kind: 'token', runId, text })
    },
  })

  try {
    await generator(messages, {
      max_new_tokens: DEFAULT_MAX_NEW_TOKENS,
      do_sample: false,
      streamer,
      stopping_criteria: stopper,
    })
    emitTerminal(
      myRun,
      stopper.interrupted
        ? { kind: 'aborted', runId }
        : { kind: 'done', runId },
    )
  } catch (err) {
    emitTerminal(myRun, {
      kind: 'error',
      message: err instanceof Error ? err.message : 'generation failed',
      runId,
    })
  } finally {
    if (activeRun === myRun) activeRun = null
  }
}

function abort(runId: string): void {
  if (activeRun?.runId === runId) {
    activeRun.stopper.interrupt()
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
      void generate(msg.runId, msg.messages)
      return
    case 'abort':
      abort(msg.runId)
      return
  }
})
