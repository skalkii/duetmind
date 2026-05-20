/**
 * Typed `postMessage` adapter over a Worker.
 *
 * Single place where any inbound/outbound message type lives at runtime —
 * everywhere else, the channel looks like `send(msg: TIn)` and
 * `onMessage(cb: (m: TOut) => void)`. No `postMessage(undefined as any)`
 * leaks into business code.
 *
 * Accepts a constructed Worker-like rather than a URL so callers in
 * production wire `new Worker(new URL('./foo.worker.ts', import.meta.url),
 * { type: 'module' })` and tests pass a fake.
 */

export interface WorkerLike {
  postMessage(data: unknown): void
  addEventListener(
    type: 'message',
    listener: (event: { data: unknown }) => void,
  ): void
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void
  removeEventListener(
    type: 'message',
    listener: (event: { data: unknown }) => void,
  ): void
  removeEventListener(
    type: 'error',
    listener: (event: ErrorEvent) => void,
  ): void
  terminate(): void
}

export interface TypedWorker<TIn, TOut> {
  send(message: TIn): void
  onMessage(cb: (message: TOut) => void): () => void
  onError(cb: (event: ErrorEvent) => void): () => void
  terminate(): void
  readonly isTerminated: boolean
}

/**
 * Default narrow-check: every protocol message in this codebase is a
 * discriminated union keyed by `kind`. Anything missing a string `kind`
 * is either uninitialised noise or a malformed payload from a buggy /
 * compromised worker — drop it instead of casting unchecked.
 */
function defaultIsValid(data: unknown): boolean {
  return (
    typeof data === 'object' &&
    data !== null &&
    'kind' in data &&
    typeof (data as { kind: unknown }).kind === 'string'
  )
}

export interface TypedWorkerOptions<TOut> {
  /** Runtime guard for inbound messages. Defaults to a `kind: string` check. */
  isValid?: (data: unknown) => data is TOut
}

export function createTypedWorker<TIn, TOut>(
  worker: WorkerLike,
  options: TypedWorkerOptions<TOut> = {},
): TypedWorker<TIn, TOut> {
  const messageListeners = new Set<(m: TOut) => void>()
  const errorListeners = new Set<(e: ErrorEvent) => void>()
  let terminated = false
  const isValid =
    options.isValid ?? ((data: unknown): data is TOut => defaultIsValid(data))

  const handleMessage = (event: { data: unknown }): void => {
    if (!isValid(event.data)) {
      console.warn('[workerBridge] dropping malformed message', event.data)
      return
    }
    for (const cb of messageListeners) cb(event.data)
  }
  const handleError = (event: ErrorEvent): void => {
    for (const cb of errorListeners) cb(event)
  }

  worker.addEventListener('message', handleMessage)
  worker.addEventListener('error', handleError)

  return {
    send(message: TIn): void {
      if (terminated) return
      worker.postMessage(message)
    },
    onMessage(cb): () => void {
      messageListeners.add(cb)
      return () => {
        messageListeners.delete(cb)
      }
    },
    onError(cb): () => void {
      errorListeners.add(cb)
      return () => {
        errorListeners.delete(cb)
      }
    },
    terminate(): void {
      if (terminated) return
      terminated = true
      worker.removeEventListener('message', handleMessage)
      worker.removeEventListener('error', handleError)
      messageListeners.clear()
      errorListeners.clear()
      worker.terminate()
    },
    get isTerminated(): boolean {
      return terminated
    },
  }
}
