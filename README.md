# DuetMind

> A browser-native experiment in the _interaction model_ architecture —
> two brains, one tick loop. No backend. No API keys. Runs offline after
> the first model download.

[![tests](https://img.shields.io/badge/tests-129%20passing-success)](#)
[![bundle](https://img.shields.io/badge/main%20bundle-69kB%20gz-blue)](#)
[![license](https://img.shields.io/badge/license-MIT-lightgrey)](#)

```
┌─────────────────────────────────────────────────────────────┐
│                      MAIN THREAD (UI)                       │
│  Web Speech STT · speechSynthesis TTS · audio meter         │
│  200ms tick orchestrator · Zustand store                    │
└──────┬──────────────────────┬───────────────────────────────┘
       │                      │
       ▼                      ▼
┌──────────────────┐  ┌──────────────────────────────────────┐
│   FAST BRAIN     │  │           SLOW BRAIN                 │
│   (Web Worker)   │  │   (Web Worker + Transformers.js)     │
│                  │  │                                      │
│   decideTick:    │  │   SmolLM2-360M-Instruct on WebGPU    │
│   when to listen │  │   (or WASM fallback)                 │
│   when to nod    │  │                                      │
│   when to talk   │  │   Streaming tokens, abortable        │
│   when to stop   │  │                                      │
└──────────────────┘  └──────────────────────────────────────┘
```

## The thesis

Most voice AIs are a pipeline: wait → transcribe → think → reply. DuetMind
is one connected loop that listens-and-thinks-and-talks at once. The
**fast brain** is a pure rule engine that decides _when_ to act every
200ms. The **slow brain** is a 360M-parameter language model that decides
_what_ to say. They run in separate Web Workers so the UI never freezes.

The point is the _interaction texture_ — backchannels, barge-in, the
fast→slow handoff at a sentence boundary — not the model's intelligence.
A non-technical user should be able to describe what feels different
after a 2-minute demo. See [`VALIDATION.md`](./VALIDATION.md) for the
six acceptance criteria.

## Try it

```bash
git clone https://github.com/skalkii/duetmind.git
cd duetmind
npm install
npm run dev
# → http://localhost:5173/
```

Open in **Chrome or Edge**. Click _Start session_, grant mic. The first
visit downloads the model (~200–500 MB, cached in IndexedDB). Subsequent
visits are instant.

## Scripts

| script                  | what it does                  |
| ----------------------- | ----------------------------- |
| `npm run dev`           | Vite dev server with HMR      |
| `npm run build`         | `tsc -b && vite build`        |
| `npm test`              | Vitest run (129 tests)        |
| `npm run test:watch`    | Vitest watch mode             |
| `npm run test:coverage` | Coverage report (v8)          |
| `npm run typecheck`     | TypeScript project references |
| `npm run lint`          | ESLint flat config            |
| `npm run format`        | Prettier write                |
| `npm run format:check`  | Prettier check                |

## File layout

```
duetmind/
├── index.html
├── public/favicon.svg              ← amber→violet lemniscate
├── src/
│   ├── App.tsx                     ← layout
│   ├── components/
│   │   ├── SiteHeader.tsx
│   │   ├── SiteFooter.tsx
│   │   ├── SessionPanel.tsx        ← one-button session control
│   │   ├── ConversationView.tsx    ← live transcript + history
│   │   └── DebugPanel.tsx          ← live config sliders
│   ├── lib/
│   │   ├── audio.ts                ← mic + RMS meter
│   │   ├── stt.ts                  ← Web Speech wrapper
│   │   ├── tts.ts                  ← speechSynthesis + barge-in
│   │   ├── decisionRules.ts        ← pure rule engine (5 rules)
│   │   ├── decisionSource.ts       ← inline + worker variants
│   │   ├── tickOrchestrator.ts     ← 200ms loop, state machine
│   │   ├── slowBrainClient.ts      ← typed slow-worker handle
│   │   ├── workerBridge.ts         ← typed postMessage adapter
│   │   ├── prompt.ts               ← chat-message builder
│   │   └── useStt.ts               ← React hook over stt.ts
│   ├── state/
│   │   ├── conversationStore.ts    ← Zustand: messages, edges
│   │   └── debugConfigStore.ts     ← live-tunable thresholds
│   ├── types/protocol.ts           ← wire-protocol types
│   └── workers/
│       ├── fastBrain.worker.ts     ← decideTick in a worker
│       └── slowBrain.worker.ts     ← Transformers.js pipeline
└── VALIDATION.md                   ← spec acceptance recipes
```

## The five rules

Implemented in [`src/lib/decisionRules.ts`](./src/lib/decisionRules.ts) as
a single pure function `decideTick(input, options): TickDecision`. Evaluated
top-down — earlier rules dominate.

| #   | When                                                                        | Action                                                                           |
| --- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1   | user is speaking AND we're speaking                                         | **interrupt_self** (barge-in)                                                    |
| 2   | user has been speaking > 3s AND last backchannel > 2s ago AND random < 0.3  | **backchannel** ("mmhm", "right", …)                                             |
| 3   | user just paused > 700ms AND has a final transcript AND no reply in flight  | **start_fast_reply** ("Let me think about that.") + parallel slow-brain dispatch |
| 4   | self is speaking the fast stall AND slow reply is ready AND reply in flight | **handoff_to_slow** (queued at TTS sentence boundary)                            |
| 5   | otherwise                                                                   | **silent**                                                                       |

## The 200ms tick

`tickOrchestrator.ts` runs an interval. Each tick:

1. snapshots `TickInput` from the Zustand store (with timestamp-derived deltas)
2. asks the **decision source** (worker or inline) for a `TickDecision`
3. dispatches the decision through an exhaustive action map

Decision source is injectable — production uses
`createWorkerDecisionSource` wrapping `fastBrain.worker.ts`; tests use
`createInlineDecisionSource`. Both share the same `decideTick`
implementation (DRY).

Per-tick config (debug-panel sliders) rides along on the message via
`FastTickInbound.configOverride`, so live tuning works across the worker
boundary without restarting the session.

## Browser support

| Browser     | STT     | TTS | WebGPU  | Status                   |
| ----------- | ------- | --- | ------- | ------------------------ |
| Chrome 122+ | ✓       | ✓   | ✓       | first-class              |
| Edge 122+   | ✓       | ✓   | ✓       | first-class              |
| Firefox     | —       | ✓   | ✓       | UI loads, no voice input |
| Safari      | partial | ✓   | partial | not supported            |
| iOS Safari  | —       | ✓   | —       | unsupported by design    |

The slow brain falls back to **WASM** automatically when `navigator.gpu`
is absent — slower first-token latency but the conversation still works.

## Model picker

The slow brain ships with **SmolLM2-360M-Instruct** by default. Switch via
the dropdown in the session panel (only available before _Start session_).
Choices:

| Model                 | Approx. download | Notes              |
| --------------------- | ---------------- | ------------------ |
| SmolLM2-135M-Instruct | ~100 MB          | smallest + fastest |
| SmolLM2-360M-Instruct | ~280 MB          | default            |
| SmolLM2-1.7B-Instruct | ~1.1 GB          | smarter, slower    |
| Qwen2.5-0.5B-Instruct | ~360 MB          | alternative family |
| Qwen2.5-1.5B-Instruct | ~1.1 GB          | smarter, slower    |

Each model is cached separately in IndexedDB after the first download.

## Mode toggle

A two-segment pill at the top of the session panel:

- **duplex** (default) — listen, nod, interrupt; the full interaction
  model.
- **turn-based** — disables rules 1 (barge-in), 2 (backchannel), and the
  fast stall. The slow brain produces the entire reply before TTS speaks
  anything. Use this back-to-back with the duplex default to viscerally
  hear what the project is actually demonstrating.

## Debug panel

Bottom of the page. Open it to see:

- **tick count** — every 200ms increment
- **last decision** — what the rule engine picked
- **barge ms** — most recent barge-in latency (target < 200ms, amber/coral coded)
- **slow buffer** — chars accumulated in the streaming slow reply

Two sliders:

- **silence threshold** (100–2000ms) — how long the user has to pause before a fast reply starts
- **backchannel rate** (0–1) — probability per tick of a "mmhm" once eligible

Reset returns to spec defaults from `DEFAULT_DECISION_CONFIG`.

## Tech stack

- **Vite 8** + **React 19** + **TypeScript 6** (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`)
- **Zustand 5** for store
- **@huggingface/transformers v4** for the slow brain (WebGPU + WASM)
- **Web Speech API** for STT + **speechSynthesis** for TTS
- **Vitest 4** + **@testing-library/react** + **jsdom** for tests
- **Tailwind CSS v3** + **Instrument Serif** + **Geist** + **Geist Mono**

No backend. No external API calls beyond the initial model download from
the Hugging Face CDN.

## Architecture principles

- **SRP** — one concern per file (`audio.ts`, `stt.ts`, `tts.ts`, …)
- **OCP** — `DecisionSource` interface lets the rule engine swap between inline + worker without a single call-site change
- **DIP** — orchestrator takes injected `store / audio / stt / tts / scheduler / now / random / decisionSource / slowBrain`; tests pass fakes
- **DRY** — `decideTick` lives in one module; both worker and inline source import it
- **No premature abstraction** — no `VoiceProvider` plugin layer until a second voice engine exists

## Inspiration

Thinking Machines Lab's
[Interaction Models](https://thinkingmachines.ai/blog/interaction-models/)
post argued that today's voice AIs are bolted-together hacks and proposed
building this as one unified system. Their model is 276 B parameters and
runs on a server farm. **DuetMind is a tiny, free, browser-based proof
that the architecture — not the model size — is what makes this approach
interesting.**

## License

MIT.
