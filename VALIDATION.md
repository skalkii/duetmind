# Validation

Spec defines six acceptance criteria for "done enough." Each is checked
against (a) what the test suite covers automatically and (b) what a human
has to verify with mic + speakers in front of them.

The automated `npm test` suite has **129 passing tests**. Type-check, lint,
production build, Prettier format all pass clean. The bullets below cover
the parts that need a real browser + real audio.

Browser: **Chrome or Edge** (Web Speech API is the limiter). WebGPU
preferred; WASM fallback works on machines without it.

---

## 1. Can hold a 30-second conversation without feeling broken

**Automated coverage:**

- Orchestrator handoff state machine: `src/lib/__tests__/tickOrchestrator.slow.test.ts` covers stall → slow handoff at TTS end, mid-stream streaming, handoff after stall, assistant message commit, no-double-handoff.
- Store keeps multi-turn history (`Message[]`); `buildChatMessages` clamps to last 6 turns for slow brain prompts (`src/lib/__tests__/prompt.test.ts`).

**Manual recipe:**

1. Start session, wait for `slow · ready` badge.
2. Speak: _"What's the capital of Japan?"_
3. Hear fast stall → slow reply.
4. Reply with: _"And the population of that city?"_ (tests context carry-over).
5. Continue for ~3 turns over 30s.

**Pass criteria:** Each reply lands. Context is carried across turns
(assistant references prior content). No deadlock, no stuck `replyInFlight`,
no double-speak.

---

## 2. Backchannels happen during your speech, don't feel intrusive

**Automated coverage:**

- Rule 2 (backchannel) is the only rule that fires while `userSpeaking=true`.
- `src/lib/__tests__/decisionRules.test.ts` proves: requires `msSinceUserStartedSpeaking > 3000`, cooldown `> 2000ms`, random gate, barge-in rule dominates.
- Default rate `0.3` per tick at 200ms cadence → expected ~1.5 backchannels per 10s of sustained speech once past the 3s warm-up.

**Manual recipe:**

1. Start session.
2. Speak continuously for ≥ 5 seconds.
3. Listen for "mmhm" / "right" / "uh-huh" / "yeah" interjections.

**Pass criteria:** Backchannel fires ≥ once during 5s of speech.
Doesn't fire in the first 3s. Doesn't fire while you're silent.
Volume + tone are unobtrusive (browser default voice).

**Tuning:** Debug panel → "backchannel rate" slider. Set to 0 to silence
them entirely; 1.0 fires every eligible tick. Defaults match
`DEFAULT_DECISION_CONFIG` in `src/lib/decisionRules.ts`.

---

## 3. Barge-in cuts AI off within 200ms perceptually

**Automated coverage:**

- `src/lib/__tests__/tickOrchestrator.test.ts > reports barge-in latency`
  exercises the arm-on-rising-edge → measure-at-stopAll path with a
  fake clock. Asserts the emitted ms matches the elapsed clock exactly.
- `interrupt_self` action handler in `src/lib/tickOrchestrator.ts` runs
  `tts.stopAll()` strictly synchronously; the latency window captures
  audio-edge → cancel return. Anything async (active gen abort, store
  mutations) runs **after** the snapshot.

**Manual recipe:**

1. Start session.
2. Trigger a reply: _"Tell me about octopuses."_
3. While the reply is mid-sentence, start speaking over it.
4. Watch the `barge · Nms` badge appear.

**Pass criteria:** Badge value < 200 (amber chip). On Apple Silicon /
Chrome, typically 50–150ms. Audio cuts within perceptual instant.

**Failure mode:** If badge is coral (≥ 200ms), the audio meter's 50ms
sample interval + 200ms tick interval is the floor. Reduce
`DEFAULT_SAMPLE_INTERVAL_MS` in `src/lib/audio.ts` or
`TICK_INTERVAL_MS` in `src/lib/tickOrchestrator.ts` for snappier
response — at the cost of more CPU.

---

## 4. Fast → slow handoff is noticeable but not jarring ≥ 50% of trials

**Automated coverage:**

- 6 cases in `tickOrchestrator.slow.test.ts > orchestrator handoff state machine` verify the state machine: handoff at TTS end, streaming mid-stall, late boundary post-stall-end, assistant commit, no double handoff.
- `isSentenceBoundary` regex (`.!?`) drives the trigger.
- `lastSpokenSlow` + `slowHandedOff` guards prevent double-speak.

**Manual recipe (5 trials):**

1. Ask a short factual question (one that fits in ≤ 2 sentences).
2. Listen for fast stall → seamless transition into the slow reply.
3. Note: did it feel like one turn or two disjoint utterances?

**Pass criteria:** ≥ 3 of 5 trials feel like a single connected turn. Stall
sounds like genuine thinking, not filler. Slow reply picks up the topic
without a noticeable gap.

**Common failure:** Slow brain takes too long to produce a sentence
boundary. The orchestrator keeps the turn open in silence (no premature
finishReplyTurn), so the worst case is "fast stall ends, brief pause,
then slow reply" — which is acceptable but loses the seamless feel. Try a
shorter user turn or a more declarative question.

---

## 5. Runs entirely offline after first load

**Automated coverage:**

- No code references `fetch()` against a backend.
- `index.html` only loads Google Fonts as a third-party CSS dependency.
- Transformers.js model is cached in IndexedDB by the library itself; second load is the cache hit.

**Manual recipe:**

1. First visit: start session, watch the violet progress bar finish, then `slow · ready`.
2. End session.
3. DevTools → Network tab → check **Offline**.
4. Reload the page.
5. Start a new session.

**Pass criteria:** Mic + STT + TTS + fast brain + slow brain all work
without any network requests. Conversation completes end-to-end. The only
artifact that can't load offline is the Google Fonts CSS — UI falls back to
system-ui automatically, no broken layout.

**Note:** Google Fonts loads with no SRI. For a stricter offline guarantee
the fonts could be self-hosted in `public/`; deferred as out-of-scope
polish.

---

## 6. Non-technical friend can describe what feels different after 2 minutes

**Automated coverage:** None possible.

**Manual recipe:**

1. Hand someone the laptop, headphones, and ~2 minutes.
2. Don't pre-explain. Let them ask questions.
3. Afterwards: _"What felt different from ChatGPT voice mode?"_

**Pass criteria:** They volunteer at least one of:

- "It interrupts itself when I talk."
- "It says little things like 'mmhm' while I'm talking."
- "It starts answering before I'm done thinking."
- "It feels more like talking than waiting for replies."

If they describe it as "smart" or "fast," the experiment failed —
the _intelligence_ is supposed to be unremarkable (it's a 360M model).
The _interaction texture_ is the point.

---

## T7.2 — Playwright smoke test (deferred)

The plan called for a Playwright E2E test that mocks `getUserMedia` and
asserts a backchannel reaches the DOM. The Playwright MCP bridge browser
extension is not installed on this machine — `browser_navigate` returned
"Extension connection timeout. Make sure the 'Playwright MCP Bridge'
extension is installed."

Scripted approach when re-enabled:

```ts
import { test, expect } from '@playwright/test'

test('backchannel fires after 3s of sustained speech', async ({ page }) => {
  await page.context().grantPermissions(['microphone'])
  await page.goto('http://localhost:5173/')
  await page.getByRole('button', { name: /start session/i }).click()
  // Inject synthetic RMS via window-exposed test hook
  // (TODO: expose `window.__duetmind_emit_rms(rms: number)` behind a
  //  Vite import.meta.env.MODE === 'test' guard for this purpose.)
  for (let i = 0; i < 20; i++) {
    await page.evaluate((rms) => window.__duetmind_emit_rms?.(rms), 0.5)
    await page.waitForTimeout(200)
  }
  // Backchannel speaks via speechSynthesis — assert the action via the
  // debug panel's "last decision" readout instead of audio.
  await page.getByRole('button', { name: /debug/i }).click()
  await expect(page.getByText(/last decision/i)).toContainText('backchannel')
})
```

Run with `npx playwright test` once the extension and a `window.__duetmind_*`
test seam are in place.

---

## Status

| Criterion               | Automated                     | Manual                    | Status      |
| ----------------------- | ----------------------------- | ------------------------- | ----------- |
| 1. 30s conversation     | ✓ orchestrator + prompt tests | requires mic + ears       | needs human |
| 2. Backchannels         | ✓ rule 2 boundary tests       | requires mic + ears       | needs human |
| 3. Barge-in < 200ms     | ✓ latency unit test           | requires mic + ears       | needs human |
| 4. Handoff feel         | ✓ handoff state machine       | subjective, 5 trials      | needs human |
| 5. Offline after load   | n/a                           | DevTools offline + reload | needs human |
| 6. Non-tech friend test | n/a                           | 2-minute demo             | needs human |

**Gates green at `330a002`:** 129/129 tests · `tsc -b` · `eslint .` ·
`vite build` · `prettier --check .`.
