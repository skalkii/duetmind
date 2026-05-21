# File + Folder Structure

Annotated tree of every source file in DuetMind. Each entry says what
the file owns and what it does NOT own.

For _how_ these pieces fit together at runtime, see
[`FLOWCHARTS.md`](./FLOWCHARTS.md).

---

## Top level

```
duetmind/
├── README.md              ← project intro + install + try-it
├── VALIDATION.md          ← 6 spec acceptance criteria + recipes
├── LICENSE                ← MIT
│
├── index.html             ← single HTML entry; loads /src/main.tsx
├── package.json           ← deps + scripts + Prettier config (inline)
├── package-lock.json      ← reproducible install
├── vite.config.ts         ← Vite + Vitest (jsdom env, setup file)
├── tsconfig.json          ← references; project structure
├── tsconfig.app.json      ← strict TS for src/
├── tsconfig.node.json     ← strict TS for vite.config.ts
├── eslint.config.js       ← flat config; React + TS + react-hooks
├── postcss.config.js      ← Tailwind + autoprefixer
├── tailwind.config.js     ← color tokens + font families
├── .prettierignore        ← excludes dist/, node_modules/, etc.
├── .gitignore             ← node_modules/, dist/, coverage/
│
├── public/
│   ├── favicon.svg        ← amber→violet gradient lemniscate (∞)
│   └── icons.svg          ← (unused; Vite scaffold leftover, kept
│                             only so existing icon refs don't 404)
│
├── docs/
│   ├── STRUCTURE.md       ← this file
│   └── FLOWCHARTS.md      ← Mermaid diagrams of every flow
│
└── src/
    └── (annotated below)
```

---

## `src/` — the application

### `src/main.tsx`

React entry. Mounts `<App />` into `#root`. No logic.

### `src/App.tsx`

Composes the layout. Renders:

- `<SiteHeader>` (top)
- A hero `<h1>` ("two brains, / one tick loop.")
- `<SessionPanel>` (the main control surface)
- `<ConversationView>` (message history + streaming)
- `<DebugPanel>` (collapsible knobs + metrics)
- `<SiteFooter>` (bottom)

Holds the last decision + last barge ms in component state so the
debug panel can read them.

### `src/index.css`

- `@fontsource` imports for Instrument Serif / Geist / Geist Mono
  (latin subsets only)
- Tailwind directives
- Body background (two radial gradients on ink)
- Subtle noise grain via inline-SVG `body::before`
- `::selection` colour

### `src/types/protocol.ts`

The wire protocol between main thread and Web Workers, as
discriminated unions:

- `TickInput` — readonly snapshot of conversation state at one tick
- `TickAction` / `TickDecision` — what the fast brain returns
- `FastWorkerInbound` / `FastWorkerOutbound`
- `SlowWorkerInbound` / `SlowWorkerOutbound`
- `ChatMessage` — used by slow-brain prompts
- `exhaustiveCheck(value: never): never` — compile-time enforcement
  helper for `switch`/`default` arms

This file has **no runtime imports** — pure types.

### `src/types/__tests__/protocol.test.ts`

Compile + runtime exercises of the discriminated unions. The
`describeDecision` switch is the actual exhaustiveness gate: adding a
new `TickAction` variant without a handler breaks tsc.

---

## `src/state/` — Zustand stores

### `src/state/conversationStore.ts`

The single source of truth for conversation facts:

- `userSpeaking`, `selfSpeaking`
- `userTranscriptPartial`, `userTranscriptFinal`
- timestamp edges (`userStartedSpeakingAt`, `userLastSpokeAt`,
  `lastBackchannelAt`)
- `slowReplyText`, `slowReplyReady`
- `replyInFlight`
- `tickCount`
- `messages[]` (full chat history)

Plus pure setters for each. **No side effects in any setter.** Logic
lives elsewhere.

Also exports the pure `selectTickInput(state, now): TickInput` —
projects a store snapshot down to the protocol shape the rule engine
needs. Time-deltas are derived from edge timestamps using `+Infinity`
sentinels for "never happened."

### `src/state/debugConfigStore.ts`

Live-tunable subset of `DecisionConfig` that the debug panel mutates:

- `mode: 'duplex' | 'turn_based'`
- `modelId` (one of `MODEL_OPTIONS`)
- `silenceThresholdMs`, `backchannelRate`
- three mode-gating booleans (`bargeInEnabled`, `backchannelEnabled`,
  `fastStallEnabled`)

`toDecisionConfig(state)` projects to the shape the orchestrator hands
to `decideTick` — including the new `minBargeSpeechMs` guard that
filters speaker-bleed from triggering false barge-ins.

`MODEL_OPTIONS` lists the 5 known-good models with sizes for the UI
picker.

---

## `src/lib/` — domain logic

### `src/lib/audio.ts`

Mic capture + RMS-based level meter.

- `computeRms(Float32Array): number` — pure
- `createAudioMeter(deps?, options?): AudioMeter` — factory
- `UnsupportedAudioError` — named error class for unsupported browsers

`defaultAudioDeps()` requests
`echoCancellation: true, noiseSuppression: true, autoGainControl: true`
on `getUserMedia` so the assistant's own TTS doesn't bleed back into
the mic and trip false barge-ins.

Deps are injectable (`getUserMedia`, `createAudioContext`, scheduler)
so tests pass fakes. No React. No store coupling.

### `src/lib/stt.ts`

Wrapper over `webkitSpeechRecognition` / `SpeechRecognition`:

- `createStt(deps?, options?): Stt`
- Auto-restart on Chrome's silence-stop
- Throws `UnsupportedSttError` on Firefox/Safari
- Three listener sets: `onPartial`, `onFinal`, `onError`
- `formatSttError(code, isBrave)` maps raw error codes (`network`,
  `not-allowed`, `service-not-allowed`, …) to actionable strings.
  Brave is auto-detected via `navigator.brave?.isBrave()` and gets a
  pointer at `brave://settings/privacy → "Use Google services for
  push messaging"`.

### `src/lib/tts.ts`

Wrapper over `speechSynthesis`:

- `createTts(deps?, options?): Tts`
- `speak(text): Promise<void>` — settles deterministically on `onend`,
  `onerror`, or `stopAll()`. Never leaks.
- `stopAll()` — synchronous; the barge-in critical path
- 10s pause/resume heartbeat for Chrome's 15s synth bug
- Adapter → real `SpeechSynthesisUtterance` is bridged via a `WeakMap`
  inside `defaultTtsDeps()` so Chrome's `synth.speak()` accepts the
  argument (it `instanceof`-checks the prototype)
- Per-utterance `endFired` guard ensures `endListeners` fan out at most
  once per `speak()`. Chrome fires both `onerror('interrupted')` and
  `onend` for cancelled utterances; without the guard the orchestrator
  dispatched two slow sentences per real TTS event

### `src/lib/decisionRules.ts`

The fast brain. One pure function `decideTick(input, options): TickDecision`.

Exports:

- `decideTick`
- `DecisionConfig` interface + `DEFAULT_DECISION_CONFIG`
- `BACKCHANNEL_PHRASES` (10 dictionary-word entries Chrome's TTS
  pronounces correctly — "mmhm" / "uh-huh" got spelled out
  letter-by-letter)
- `FAST_STALL_PHRASES` (12 short stalls)

Defaults: `minUserSpeechForBackchannelMs: 1500`, `backchannelMinGapMs: 1500`,
`backchannelRate: 0.5`, `minBargeSpeechMs: 250`.

No DOM, no React, no timers, no module-level mutable state.

### `src/lib/turnEndPredictor.ts`

Heuristic classifier — stand-in for the original spec's distilled
BERT.

`predictTurnEnd(text): { complete, confidence }`. Confidence sums
weighted signals (terminal punctuation, end phrases, question opener

- question mark, length).

### `src/lib/prompt.ts`

Builds the chat-message array fed to the slow brain.

- `buildChatMessages(history, currentUser, options?): ChatMessage[]`
- `isSentenceBoundary(text): boolean` — regex check for `.!?`

### `src/lib/workerBridge.ts`

Typed `postMessage` adapter.

- `createTypedWorker<TIn, TOut>(worker, options?): TypedWorker<TIn, TOut>`
- Default `isValid` guard: drops messages without a string `kind`
  discriminant
- `terminate()` is idempotent + detaches listeners

### `src/lib/decisionSource.ts`

Pluggable source of `TickDecision`s.

- `createInlineDecisionSource(options?)` — runs `decideTick` on main
- `createWorkerDecisionSource(worker)` — sends ticks to the worker
  with tick-id correlation; drops stale responses

Both implement the same `DecisionSource` interface.

### `src/lib/slowBrainClient.ts`

Main-thread handle to the slow worker.

- `createSlowBrain(worker): SlowBrain`
- Tracks lifecycle: `idle | loading | ready | error`
- `load(modelId?)` resolves on `ready`
- `generate(options): SlowGenerateHandle` — streams tokens via
  callbacks; `abort()` cancels mid-stream
- runId-correlated routing; scoped errors fail just that run

### `src/lib/tickOrchestrator.ts`

The one place that wires audio + STT + TTS + slow brain to the store
and runs the 200ms loop.

Owns:

- subscriptions to audio level / STT events / TTS lifecycle
- VAD hysteresis: rising edge immediate, falling edge waits
  `speakingHangoverMs` (default 350 ms) so inter-word silences don't
  reset the sustained-speech gate that drives backchannels
- selfSpeaking gating: while assistant is talking, RMS threshold is
  tripled (filters residual echo) and STT partial/final updates are
  dropped (so the assistant doesn't transcribe itself)
- the in-flight tick-id guard
- the action-executor map (`Record<TickAction, handler>`)
- the fast→slow handoff state machine. Slow reply is dispatched
  **sentence by sentence** — a `slowSpokenLen` byte offset tracks how
  much of `slowReplyText` has been handed to TTS; the next sentence is
  sliced and queued once the current one finishes. Unpunctuated tails
  are flushed when the generator reports done.
- barge-in latency measurement

Does NOT own subsystem lifecycles — caller starts and stops audio /
STT / TTS / slowBrain themselves.

---

## `src/components/` — React UI

### `src/components/SiteHeader.tsx`

Site-wide header. Two interlocking dots (amber + violet) + the
DuetMind wordmark in italic Instrument Serif + a small mono version
chip (hidden on phones).

### `src/components/SiteFooter.tsx`

Privacy claim + three links (spec, transformers.js, model card).

### `src/components/SessionPanel.tsx`

The main control surface. Holds the start/stop button, the mode pill,
the model picker, the status badges, and the live transcript.

Owns the lifecycle of one session: creates audio / STT / TTS /
orchestrator / slowBrain on Start, tears them down on End.

Helper `tryWorker<TIn, TOut>(url, label)` constructs typed workers
defensively (catches the `Worker` ctor failure → falls back to inline
for the fast brain or null for the slow brain).

### `src/components/ConversationView.tsx`

Renders `messages[]` as role-coloured bubbles + the in-flight
streaming reply with a pulsing block cursor.

- `aria-live="polite"` so screen readers hear streaming tokens
- `motion-safe:animate-pulse` on the cursor

### `src/components/DebugPanel.tsx`

Collapsible. Shows:

- 4 live metrics (tick, last decision, last barge ms, slow buffer)
- 2 sliders (silence threshold, backchannel rate)
- 2 buttons (reset, export transcript)

`downloadTranscript()` builds a JSON blob from the conversation store

- debug config + tick count and triggers a synthetic `<a>` download.

---

## `src/workers/` — Web Worker entries

### `src/workers/fastBrain.worker.ts`

Pure transport boundary. Receives `{ kind: 'tick', tickId, input,
configOverride? }` and posts back `{ kind: 'decision', tickId,
decision }`. Imports `decideTick` from `lib/decisionRules.ts` so the
rule logic lives in exactly one place.

### `src/workers/slowBrain.worker.ts`

Hosts the Transformers.js pipeline.

- Loads the model on `load` (with optional `modelId`); falls back
  WebGPU → WASM via `pickDevice()`
- Generates on `generate(runId, messages)`. Each run gets its own
  `InterruptableStoppingCriteria` + an `emittedTerminal` flag so
  pre-empting a run emits exactly one terminal event (`aborted`)
- Aborts on `abort(runId)` — interrupts the active stopper

Owns no UI concerns. Outputs `load_progress`, `ready`, `token`,
`done`, `aborted`, `error` via `postMessage`.

---

## `src/test/`

### `src/test/setup.ts`

Vitest setup file referenced by `vite.config.ts`. Imports
`@testing-library/jest-dom/vitest` matchers and runs `cleanup()` after
each test.

---

## Test placement convention

Tests live next to the code they exercise, in a `__tests__/`
subfolder:

```
src/lib/audio.ts
src/lib/__tests__/audio.test.ts

src/components/SessionPanel.tsx
src/components/__tests__/SessionPanel.test.tsx        (none — UI tested
                                                       via App.test)

src/state/conversationStore.ts
src/state/__tests__/conversationStore.test.ts
```

The only exception is `src/__tests__/App.test.tsx` and
`src/__tests__/smoke.test.ts` which exercise the composed app rather
than a single sibling module.

---

## Import conventions

- **No barrel files.** Each module imports from a specific path.
- **Type-only imports use `import type`.** Required by
  `verbatimModuleSyntax: true` in `tsconfig.app.json`.
- **Relative imports inside `src/`.** No path aliases configured.
- **Workers imported via `new Worker(new URL('./foo.worker.ts',
import.meta.url), { type: 'module' })`** — Vite resolves these at
  build time and emits separate chunks.

---

## File-naming conventions

| pattern                             | meaning                                            |
| ----------------------------------- | -------------------------------------------------- |
| `*.ts`                              | pure module (no JSX)                               |
| `*.tsx`                             | contains JSX                                       |
| `*.worker.ts`                       | Web Worker entry point                             |
| `*.test.ts` / `*.test.tsx`          | Vitest spec                                        |
| `use*.ts`                           | React hook (currently none — `useStt` was removed) |
| `create*` exported fn               | factory returning an object the caller owns        |
| `predict*` / `decide*` / `compute*` | pure function, no side effects                     |

camelCase for files containing functions/factories. PascalCase only
for files whose default export is a React component.
