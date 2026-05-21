# Flowcharts

Mermaid diagrams of every flow in DuetMind. GitHub renders Mermaid
inline; local viewers usually do too.

For _what_ each file does, see [`STRUCTURE.md`](./STRUCTURE.md).

---

## 1. Architecture overview

Top-level threads + the store that binds them.

```mermaid
flowchart LR
  subgraph MAIN["Main thread"]
    direction TB
    UI[React UI<br/>SessionPanel + ConversationView + DebugPanel]
    Audio["audio.ts<br/>RMS meter @ 50ms"]
    STT["stt.ts<br/>Web Speech"]
    TTS["tts.ts<br/>speechSynthesis"]
    Orch["tickOrchestrator.ts<br/>200ms loop"]
    Store[("Zustand store<br/>conversationStore + debugConfigStore")]
  end

  subgraph FAST["fastBrain.worker.ts"]
    Decide["decideTick(input, config)<br/>pure 5 rules"]
  end

  subgraph SLOW["slowBrain.worker.ts"]
    Pipe["@huggingface/transformers<br/>pipeline + TextStreamer"]
  end

  Mic[/Microphone/] --> Audio
  Audio --> Orch
  Audio --> STT
  STT --> Orch
  Orch <--> Store
  UI <--> Store
  Orch -- "tick + input + config" --> Decide
  Decide -- "TickDecision" --> Orch
  Orch -- "generate(runId, messages)" --> Pipe
  Pipe -- "token / done / aborted" --> Orch
  Orch --> TTS
  TTS --> Speakers[/Speakers/]

  style FAST fill:#ffb86b22,stroke:#ffb86b
  style SLOW fill:#b083ff22,stroke:#b083ff
  style MAIN fill:#17141f44,stroke:#2d2738
```

---

## 2. The 200ms tick loop

What happens every 200ms inside the orchestrator.

```mermaid
flowchart TD
  Timer["setInterval fires<br/>(every 200ms)"]
  Drop["Drop tick — keep loop running"]
  Snap["incrementTick + read store snapshot"]
  Sel["selectTickInput(state, now)<br/>derives ms-deltas + turnEndConfidence"]
  Send["decisionSource.decide(tickId, input, configOverride)"]
  Resolve{Promise settled?}
  Stale["Tick #N+1 already running →<br/>drop this response<br/>(stale tickId)"]
  Apply[onTick callback + dispatch]
  Map["handlers[decision.action](decision)<br/>(exhaustive map, no switch ladder)"]

  Timer --> Check{inFlightTickId != -1?}
  Check -- yes --> Drop
  Check -- no --> Snap
  Snap --> Sel
  Sel --> Send
  Send --> Resolve
  Resolve -- "matches current tickId" --> Apply
  Resolve -- "tickId superseded" --> Stale
  Apply --> Map

  style Drop fill:#ff6b8a22,stroke:#ff6b8a
  style Map fill:#ffb86b22,stroke:#ffb86b
```

---

## 3. Decision rule evaluation

Top-down. First matching rule wins.

```mermaid
flowchart TD
  In([TickInput + DecisionConfig])

  R1{"Rule 1 — barge-in<br/>userSpeaking AND selfSpeaking<br/>AND speech sustained 250ms+<br/>AND bargeInEnabled?"}
  R2{"Rule 2 — backchannel<br/>userSpeaking AND speech over 1.5s<br/>AND cooldown OK AND random under 0.5<br/>AND backchannelEnabled?"}
  R4{"Rule 4 — handoff<br/>selfSpeaking && slowReplyReady<br/>&& replyInFlight?"}
  R3{"Rule 3 — start reply<br/>not speaking AND no replyInFlight<br/>AND transcript non-empty AND<br/>silence over 700ms OR (silence over 300ms<br/>AND confidence at or above 0.7)?"}
  R5{Else}

  A1[["interrupt_self"]]
  A2[["backchannel<br/>+ phrase"]]
  A4[["handoff_to_slow"]]
  A3[["start_fast_reply<br/>+ stall phrase"]]
  A5[["silent"]]

  In --> R1
  R1 -- yes --> A1
  R1 -- no --> R2
  R2 -- yes --> A2
  R2 -- no --> R4
  R4 -- yes --> A4
  R4 -- no --> R3
  R3 -- yes --> A3
  R3 -- no --> R5
  R5 --> A5

  style A1 fill:#ff6b8a22,stroke:#ff6b8a
  style A2 fill:#ffb86b22,stroke:#ffb86b
  style A4 fill:#b083ff22,stroke:#b083ff
  style A3 fill:#ffb86b22,stroke:#ffb86b
  style A5 fill:#17141f,stroke:#2d2738
```

---

## 4. Reply turn lifecycle (fast → slow handoff)

The state machine that owns one user→assistant turn. Spans multiple
ticks + TTS lifecycle events. All transitions live in the
orchestrator.

```mermaid
stateDiagram-v2
  [*] --> Idle

  Idle: idle<br/>no reply pending

  Idle --> StartFastReply: rule 3 fires<br/>(silence OR confident turn-end)

  state StartFastReply {
    [*] --> Snapshot
    Snapshot: commit user message<br/>clear transcript
    Snapshot --> StallSpeaking: tts.speak(stall phrase)<br/>slowBrain.generate(messages)
  }

  StartFastReply --> StallSpeaking: selfSpeaking=true<br/>replyInFlight=true
  StallSpeaking: STALL_SPEAKING<br/>fast TTS active<br/>slow brain streaming tokens
  StallSpeaking --> StallSpeaking: token arrives → appendSlowReply<br/>(boundary → slowReplyReady=true)
  StallSpeaking --> InterruptSelf: rule 1 — sustained user speech (≥250ms)
  StallSpeaking --> SlowSpeaking: tts.onEnd<br/>→ dispatchNextSentence() → tts.speak(sentence #1)
  StallSpeaking --> WaitingForSlow: tts.onEnd && no sentence yet<br/>(slow still streaming)

  WaitingForSlow: WAITING<br/>fast TTS ended,<br/>no audio playing,<br/>slow still generating
  WaitingForSlow --> SlowSpeaking: first sentence boundary lands<br/>→ dispatchNextSentence() fires
  WaitingForSlow --> InterruptSelf: rule 1 — sustained user speech

  SlowSpeaking: SLOW_SPEAKING<br/>slow reply TTS active<br/>slowSpokenLen advances per sentence
  SlowSpeaking --> SlowSpeaking: tts.onEnd → dispatchNextSentence()<br/>speaks sentence #N+1 if buffered
  SlowSpeaking --> InterruptSelf: rule 1 — sustained user speech
  SlowSpeaking --> Done: tts.onEnd AND no unspoken text<br/>AND generator done

  Done: finishReplyTurn<br/>commit assistant message<br/>setSelfSpeaking(false)<br/>markReplyEnded
  Done --> Idle

  InterruptSelf: INTERRUPTED<br/>tts.stopAll()<br/>slowBrain.abort()<br/>clearSlowReply<br/>measure barge ms
  InterruptSelf --> Idle
```

---

## 5. Barge-in latency measurement

How the perceptual budget (< 200ms) is captured.

```mermaid
sequenceDiagram
  participant Mic as Microphone
  participant Audio as audio.ts
  participant Orch as Orchestrator
  participant Fast as Fast worker
  participant TTS as tts.ts
  participant Store as Store
  participant UI as UI callback

  Note over Mic,UI: AI is mid-reply (selfSpeaking = true)

  Mic->>Audio: voice begins
  Audio->>Audio: RMS ≥ threshold × 3 (selfSpeaking guard)
  Audio->>Orch: onLevel(rms)
  Orch->>Orch: bargeInArmedAt = now() (T1)
  Orch->>Store: setUserSpeaking(true, now)

  Note right of Orch: rule 1 requires msSinceUserStartedSpeaking ≥ 250ms<br/>(filters speaker bleed) — next qualifying tick fires within 250–450ms

  Orch->>Fast: send TickInput
  Fast->>Orch: TickDecision interrupt_self

  Orch->>Orch: armed = bargeInArmedAt
  Orch->>TTS: stopAll() — synchronous
  Orch->>Orch: stoppedAt = now() (T2)
  Orch->>Store: setSelfSpeaking(false) + markReplyEnded
  Orch->>UI: onBargeInLatency(T2 - T1)

  Note over Audio,UI: Budget — T2 minus T1 stays under 200ms<br/>(typically 50 to 150ms on Apple Silicon)
```

---

## 6. Audio → STT → store pipeline

The input side of the conversation.

```mermaid
flowchart LR
  Mic[/Microphone/]
  Stream["MediaStream<br/>getUserMedia()"]
  Anal["AnalyserNode"]
  RMS["computeRms(Float32Array)<br/>every 50ms"]
  LevelCb[orchestrator audio.onLevel]
  Recog[webkitSpeechRecognition<br/>continuous + interim]
  Partial[onPartial]
  Final[onFinal]

  StoreSpeak["setUserSpeaking(speaking, now)<br/>+ arm bargeInArmedAt"]
  StorePart["updateUserPartial(text)<br/>gated: drop while selfSpeaking"]
  StoreFinal["commitUserFinal(text, now)<br/>gated: drop while selfSpeaking"]

  Mic --> Stream
  Stream --> Anal
  Anal --> RMS
  RMS --> LevelCb
  Stream --> Recog
  Recog --> Partial
  Recog --> Final
  Partial --> StorePart
  Final --> StoreFinal
  LevelCb -- "rising edge<br/>(threshold×3 while selfSpeaking)" --> StoreSpeak
  LevelCb -- "falling edge<br/>after 350ms hangover" --> StoreSpeak

  style RMS fill:#ffb86b22,stroke:#ffb86b
  style Recog fill:#ffb86b22,stroke:#ffb86b
```

---

## 7. Slow brain — load + generate

Sequence inside the slow worker.

```mermaid
sequenceDiagram
  participant Main as Main thread
  participant Client as slowBrainClient
  participant Worker as slowBrain.worker
  participant TS as Transformers.js pipeline

  Main->>Client: load(modelId?)
  Client->>Worker: { kind: 'load', modelId }
  Worker->>Worker: pickDevice() → webgpu | wasm
  Worker->>TS: pipeline('text-generation', modelId, { device, dtype:'q4' })
  loop per-file progress
    TS-->>Worker: progress event
    Worker-->>Client: { kind: 'load_progress', pct }
    Client-->>Main: onProgress(pct)
  end
  TS-->>Worker: pipeline ready
  Worker-->>Client: { kind: 'ready' }
  Client-->>Main: load() promise resolves

  Main->>Client: generate({ messages, onToken, onDone, onAborted, onError })
  Client->>Client: runId = crypto.randomUUID()
  Client->>Worker: { kind: 'generate', runId, messages }
  Worker->>Worker: stopper = new InterruptableStoppingCriteria()
  Worker->>Worker: activeRun = { runId, stopper, emittedTerminal: false }
  Worker->>TS: generator(messages, { streamer, stopping_criteria: stopper })
  loop per-token
    TS-->>Worker: text chunk via TextStreamer callback
    Worker-->>Client: { kind: 'token', runId, text }
    Client-->>Main: onToken(text)
  end

  alt user barges in mid-generation
    Main->>Client: handle.abort()
    Client->>Worker: { kind: 'abort', runId }
    Worker->>Worker: stopper.interrupt()
    TS-->>Worker: model loop returns
    Worker-->>Client: { kind: 'aborted', runId } (emittedTerminal=true)
    Client-->>Main: onAborted()
  else clean finish
    TS-->>Worker: model loop returns
    Worker-->>Client: { kind: 'done', runId } (emittedTerminal=true)
    Client-->>Main: onDone()
  end
```

---

## 8. Mode toggle — duplex vs turn-based

What flipping the pill at the top of `SessionPanel` actually changes
inside `decideTick`.

```mermaid
flowchart LR
  subgraph DUPLEX["duplex mode (default)"]
    D1[Rule 1 barge-in ✓]
    D2[Rule 2 backchannel ✓]
    D3a[Rule 3a confident turn-end ✓]
    D3[Rule 3 silence reply ✓]
    D4[Rule 4 handoff ✓]
    Dfs[fast stall TTS ✓]
  end

  subgraph TURN["turn_based mode"]
    T1[Rule 1 ✗ disabled]
    T2[Rule 2 ✗ disabled]
    T3a[Rule 3a ✓ still fires]
    T3[Rule 3 ✓ still fires]
    T4[Rule 4 ✓ still fires]
    Tfs[fast stall TTS ✗ skipped]
  end

  Toggle{{User flips mode pill}}
  Toggle -- "duplex → turn_based" --> TURN
  Toggle -- "turn_based → duplex" --> DUPLEX

  Effect["Turn-based effect:<br/>• no 'mmhm' interjections<br/>• can't be interrupted<br/>• no fast stall — slow brain<br/>  produces the entire reply first<br/>• handoff fires on first sentence<br/>  boundary, speaks the full text"]

  TURN --> Effect

  style DUPLEX fill:#ffb86b22,stroke:#ffb86b
  style TURN fill:#b083ff22,stroke:#b083ff
  style Effect fill:#17141f,stroke:#2d2738
```

---

## 9. Worker bridge — typed postMessage

What `createTypedWorker` does between threads.

```mermaid
flowchart LR
  subgraph Main["Main thread"]
    Caller["caller.send(msg: TIn)"]
    OnMsg["caller.onMessage(cb)"]
  end

  subgraph Bridge["createTypedWorker"]
    SendFn[".send → postMessage(msg)"]
    Listener["addEventListener('message')"]
    Guard{"isValid(data)?<br/>defaults to typeof === 'object'<br/>&& 'kind' in data"}
    Fanout[fan out to all onMessage subscribers]
    Drop[console.warn + drop]
  end

  subgraph Worker["Worker scope"]
    WorkerCode[worker.ts message handler]
  end

  Caller --> SendFn
  SendFn --> WorkerCode

  WorkerCode -- "postMessage(out)" --> Listener
  Listener --> Guard
  Guard -- yes --> Fanout
  Guard -- no --> Drop
  Fanout --> OnMsg

  style Drop fill:#ff6b8a22,stroke:#ff6b8a
  style Guard fill:#b083ff22,stroke:#b083ff
```

---

## 10. Session lifecycle (start to end)

What happens when the user clicks **Start session** + **End session**.

```mermaid
sequenceDiagram
  participant User
  participant Panel as SessionPanel
  participant Audio as audio.ts
  participant STT as stt.ts
  participant TTS as tts.ts
  participant Orch as Orchestrator
  participant Slow as slowBrainClient
  participant Workers as Web Workers

  User->>Panel: click "Start session"
  Panel->>Audio: createAudioMeter()
  Panel->>STT: createStt()
  Panel->>TTS: createTts()
  Panel->>Workers: new Worker(fastBrain.worker.ts)
  Panel->>Workers: new Worker(slowBrain.worker.ts)
  Panel->>Slow: createSlowBrain(typedWorker)
  Panel->>Orch: createTickOrchestrator({ deps, getConfig, onBargeInLatency })

  Panel->>Audio: start() — requestUserMedia
  Note right of Audio: ⚠ user grants mic permission

  Panel->>STT: start()
  Panel->>Orch: start() — begin 200ms tick loop
  Panel->>Slow: load(modelId) — kicks off model download in parallel

  loop while live
    Slow-->>Panel: onProgress(pct) → violet bar
    Slow-->>Panel: onStatus('ready') → "slow · ready" badge
  end

  Note over User,Workers: ... conversation happens ...

  User->>Panel: click "End session"
  Panel->>Orch: stop() — clears timer + listeners
  Panel->>STT: stop()
  Panel->>Audio: stop() — releases mic
  Panel->>TTS: stopAll() — synth.cancel()
  Panel->>Slow: terminate() — worker.terminate()
  Panel->>Panel: useConversationStore.reset()
```

---

## Glossary of dotted/dashed edges

- **Solid arrow `-->`** — synchronous direct call or message
- **Dashed arrow `-->>` (in sequence diagrams)** — async response
- **Note over** — annotation, not a control-flow edge

Mermaid renders these inline on GitHub. To preview locally, install
the Mermaid VS Code extension or paste into
[https://mermaid.live/](https://mermaid.live/).
