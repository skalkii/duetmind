# DuetMind

> A small experiment in what a voice AI feels like when it can listen,
> nod, and interrupt — all at the same time, just like a real
> conversation. **Runs entirely in your browser.** No accounts, no API
> keys, no servers.

[![tests](https://img.shields.io/badge/tests-143%20passing-success)](#)
[![bundle](https://img.shields.io/badge/main%20bundle-71kB%20gz-blue)](#)
[![offline](https://img.shields.io/badge/works%20offline-after%20first%20load-violet)](#)
[![license](https://img.shields.io/badge/license-MIT-lightgrey)](#)

```
┌─────────────────────────────────────────────────────────────┐
│                      MAIN THREAD (UI)                       │
│  speech-in · speech-out · audio meter · 200ms tick loop     │
└──────┬──────────────────────┬───────────────────────────────┘
       │                      │
       ▼                      ▼
┌──────────────────┐  ┌──────────────────────────────────────┐
│   FAST BRAIN     │  │           SLOW BRAIN                 │
│   (Web Worker)   │  │   (Web Worker + Transformers.js)     │
│                  │  │                                      │
│   decides WHEN   │  │   decides WHAT                       │
│   to listen,     │  │   to say.                            │
│   nod, talk,     │  │                                      │
│   or stop.       │  │   SmolLM2 / Qwen2.5 on WebGPU.       │
└──────────────────┘  └──────────────────────────────────────┘
```

---

## What is this?

Today's voice AIs work like a relay: you talk → it listens → you stop
→ it transcribes → it thinks → it talks back. One thing at a time.

DuetMind tries something different. It does all of those things **at
once**:

- It can say "mmhm" while you're still talking.
- It can start replying before you've fully stopped — like a friend
  who's eager to answer.
- It cuts itself off the instant you start talking over it.
- It uses one cheap, fast brain to decide _when_ to react, and a
  slower, smarter brain (running entirely in your browser) to decide
  _what_ to say.

It will feel weird. That's the whole point. See
[`VALIDATION.md`](./VALIDATION.md) for the six things to listen for
when you try it.

> **Heads up:** The AI is small (~360 MB). Its answers will often be
> short, wrong, or shallow. The _interaction feel_ is what we're
> demonstrating — not its intelligence.

---

## Try it in your browser

### Quickest path (no install)

If somebody is hosting this for you, just open the URL in **Chrome or
Edge**, click **Start session**, and grant microphone access.

The first time you start a session, it downloads a ~280 MB language
model into your browser's storage. That's the one big download. After
that, **everything runs offline.**

### Run it locally (your own machine)

If you want to host it yourself or read the code, here's the path
assuming you've never opened a terminal before.

#### 1. Install the tools

You need two free things on your computer:

- **Node.js** (a runtime that powers modern web tools)
  → Download from [https://nodejs.org/](https://nodejs.org/) and pick
  the **LTS** (Long-Term Support) version. Run the installer. Done.
- **Git** (a tool for downloading code)
  → Most Macs already have it. If not, the first time you type `git`
  in a terminal it will offer to install it. On Windows, get it from
  [https://git-scm.com/](https://git-scm.com/).

#### 2. Open a terminal

- **macOS:** press <kbd>⌘</kbd>+<kbd>Space</kbd>, type "Terminal", hit
  Enter.
- **Windows:** press the Windows key, type "PowerShell", hit Enter.

#### 3. Download + start the app

Paste these lines one at a time and press Enter after each:

```bash
git clone https://github.com/skalkii/duetmind.git
cd duetmind
npm install
npm run dev
```

That's it. The last command will say something like:

```
  ➜  Local:   http://localhost:5173/
```

Open that URL in **Chrome or Edge**.

#### 4. Press Start session

The browser will ask for microphone permission. Click **Allow**.

You'll see a violet progress bar download the AI model. Wait a minute
or two on the first visit; after that, the model is cached and
subsequent sessions start in seconds.

Talk to it. Pause occasionally. Try interrupting it mid-sentence. Read
the [`VALIDATION.md`](./VALIDATION.md) checklist while you do.

To stop it: press <kbd>Ctrl</kbd>+<kbd>C</kbd> in the terminal.

---

## What to try once it's running

| Test                                   | What you should hear                                                                          |
| -------------------------------------- | --------------------------------------------------------------- |
| Speak continuously for ~1.5+ seconds   | A casual "okay" / "right" / "yeah" / "got it" while you're still talking |
| Ask "what time is it?" then stop       | A quick stall ("Let me see." / "Good question.") then a full answer |
| Interrupt the AI mid-reply             | Audio cuts off within a fraction of a second (sustain ≥ 250 ms — filters speaker bleed) |
| End session, refresh, start again      | `slow • ready` lights up immediately — no re-download           |
| DevTools → Network → Offline → refresh | Everything still works                                          |

There's a **mode toggle** at the top of the session panel — flip it to
**turn-based** to hear the same AI without backchannels, without
barge-in, and without the early stall. Switching back and forth makes
the difference obvious.

There's also a **debug panel** at the bottom — open it to see live
metrics and adjust the thresholds (how long the AI waits before
replying, how often it backchannels) on the fly.

---

## I want to read the code

- **What lives where:** [`docs/STRUCTURE.md`](./docs/STRUCTURE.md)
- **How the pieces flow together (diagrams):** [`docs/FLOWCHARTS.md`](./docs/FLOWCHARTS.md)
- **Six acceptance criteria + manual recipes:** [`VALIDATION.md`](./VALIDATION.md)

### Scripts

| script                  | what it does                    |
| ----------------------- | ------------------------------- |
| `npm run dev`           | Vite dev server with hot reload |
| `npm run build`         | Production bundle               |
| `npm test`              | Run all 143 tests               |
| `npm run test:watch`    | Tests in watch mode             |
| `npm run test:coverage` | v8 coverage report              |
| `npm run typecheck`     | TypeScript project references   |
| `npm run lint`          | ESLint flat config              |
| `npm run format`        | Prettier write                  |

### The five decision rules

The fast brain is [`src/lib/decisionRules.ts`](./src/lib/decisionRules.ts)
— a single pure function evaluated every 200ms. Rules are checked
top-down; earlier ones dominate.

| #   | When                                                                                                                             | Action                                                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 1   | user has sustained speech ≥ 250 ms AND we're speaking                                                                            | **interrupt_self** (barge-in — speaker-bleed filtered)       |
| 2   | user has been speaking > 1.5s AND last backchannel > 1.5s ago AND random < 0.5                                                   | **backchannel** ("right", "okay", "got it", …)               |
| 3   | user paused AND has a final transcript AND no reply yet AND (silence > 700ms OR (silence > 300ms AND turn-end confidence ≥ 0.7)) | **start_fast_reply** + parallel slow-brain dispatch          |
| 4   | self speaking the fast stall AND slow reply is ready AND reply in flight                                                         | **handoff_to_slow** (sentence-by-sentence dispatch)          |
| 5   | otherwise                                                                                                                        | **silent**                                                   |

The turn-end confidence is computed by
[`src/lib/turnEndPredictor.ts`](./src/lib/turnEndPredictor.ts) — a
heuristic stand-in for what would otherwise be a tiny classifier
model. Signals: terminal punctuation, common end phrases, question
opener + question mark, sentence length.

### Browser support

| Browser           | STT | TTS | WebGPU  | Status                                                |
| ----------------- | --- | --- | ------- | ----------------------------------------------------- |
| Chrome 122+       | ✓   | ✓   | ✓       | first-class                                           |
| Edge 122+         | ✓   | ✓   | ✓       | first-class                                           |
| Brave (Chromium)  | ✗   | ✓   | ✓       | STT backend blocked — friendly error surfaces in UI   |
| Firefox           | ✗   | ✓   | ✓       | UI loads, no voice input                              |
| Safari / iOS      | ✗   | ✓   | partial | unsupported                                           |

STT uses the Web Speech API which Chrome routes through Google's
speech backend. Brave disables that backend by default for privacy;
Firefox + Safari never shipped it. **Use vanilla Chrome or Edge.**

The slow brain falls back to **WASM** automatically when WebGPU isn't
available — slower first-token latency but the conversation still
works.

### Model picker

Default is **SmolLM2-360M-Instruct** (~280 MB). Switch via the
dropdown in the session panel (only available before _Start session_).
Choices range from 100 MB (SmolLM2-135M) up to 1.1 GB (Qwen2.5-1.5B).
Each model is cached separately in IndexedDB.

### Tech stack

- **Vite 8** + **React 19** + **TypeScript 6** (strict +
  `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`)
- **Zustand 5** for state
- **@huggingface/transformers v4** for the slow brain (WebGPU + WASM)
- **Web Speech API** for STT + **speechSynthesis** for TTS
- **Vitest 4** + **@testing-library/react** + **jsdom** for tests
- **Tailwind CSS v3** + self-hosted **Instrument Serif** / **Geist** /
  **Geist Mono** via `@fontsource`

No backend. No external runtime dependencies after the model download.

### Architecture principles

- **SRP** — one concern per file
- **OCP** — `DecisionSource` interface lets the rule engine swap
  between inline + worker without a call-site change
- **DIP** — orchestrator takes injected `store / audio / stt / tts /
scheduler / now / random / decisionSource / slowBrain`; tests pass
  fakes
- **DRY** — `decideTick` lives in one module; both worker and inline
  source import it
- **No premature abstraction** — no plugin layer until a second
  concrete impl exists

---

## Inspiration

Thinking Machines Lab's
[Interaction Models](https://thinkingmachines.ai/blog/interaction-models/)
post argued that today's voice AIs are bolted-together hacks and
proposed building this as one unified system. Their model is 276 B
parameters and runs on a server farm.

**DuetMind is a tiny, free, browser-based proof that the architecture
— not the model size — is what makes this approach interesting.**

---

## License

MIT.
