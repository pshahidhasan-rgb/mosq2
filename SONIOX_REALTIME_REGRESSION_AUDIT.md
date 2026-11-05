# Real-Time Translation Regression Audit

Date: 2026-11-05

Reviewed revision: `6d6ce8316f45f15b19cae00fdd0befac511d211b`.

Compared baseline: `65df180`, immediately before the billing lifecycle fixes.

Scope: explain the reported regression from mid-speech captions to sentences appearing only after the speaker pauses; identify fixes while preserving spend controls. This document is an audit and proposed implementation plan. Application code was not modified. No paid provider calls were made.

## 1. Assessment

The current native Soniox token path has NOT been changed into a final-only renderer. It still processes provisional tokens and emits them through a 60 ms scheduling window. An isolated test of the actual service and session relay delivered non-final English translation to both TV and phone subscribers without an endpoint, punctuation, or speech completion.

The reported symptom strongly matches falling out of native Soniox streaming and into the existing sentence-based fallback. That fallback explicitly disables browser interim results and submits only finalized speech to batch text translation. Several confirmed defects can cause or preserve that transition.

The most direct regression in the latest commit is removal of the fallback English/source gate combined with stricter live language demand. If all requested languages are excluded from this application's Soniox whitelist, such as Uzbek or Somali, the current code opens zero Soniox gates. The previous code opened an English gate when voice arrived. This difference was reproduced against both revisions with identical synthetic audio and fake provider sockets.

This does not establish that the user's failing live session uses Uzbek/Somali. The affected target language, active provider, WebSocket frames, selected model, and live audio flow were not captured. If a native target such as English or Bengali is also sentence-only, investigate audio ingress, provider errors, subscriber delivery, polling-only transport, and the confirmed cooldown recovery defect rather than attributing every case to language routing.

The billing and latency goals are compatible: revoke streams when a publisher stops, but continuously forward eligible audio and provisional text while a publisher is speaking. Do not undo the billing protections to restore latency.

## 2. Evidence and Reproductions

The worktree was clean at the beginning of this audit. The only application commit since the baseline is `6d6ce83`, which changes `admin.js`, `server/index.js`, `sessionManager.js`, and `sonioxService.js`. `public/display.js` and `public/join.js` have no diff between these two revisions.

Tests used fake sockets/timers and fake credentials. No `.env` values were read, no real microphone was recorded, and no server with production provider credentials was started.

| Check | Baseline | Current | Result |
| --- | --- | --- | --- |
| Voice with only `uz` requested | Opens one English/source gate | Opens zero gates | Confirmed routing regression |
| Non-final English translation without endpoint | Emits partial | Emits partial | Core parser still streams |
| Current partial through real session relay | Not compared | TV and phone receive non-final `translatedFull` | Relay does not require finalization |
| Retry after an expired 429 cooldown | Baseline clears flag during gate admission | Current leaves flag set; retry callback refuses to connect | Confirmed recovery regression |
| Existing `soniox_latency_bench.js` | Not executed on baseline | Fails at gate setup: `0 !== 2` | Benchmark currently supplies no latency evidence |

The synthetic tests show application behavior under controlled inputs, not provider recognition latency or browser paint latency. They do not prove that Soniox delivered provisional tokens in the reported live session.

## 3. How the Paths Differ

### A. Native Soniox path

Microphone PCM -> server publisher validation -> Soniox gate -> original/translation tokens -> `schedulePartial()` -> `STREAMING_TOKEN` -> TV/phone live DOM.

References:

- `public/admin.js:892-933`: PCM processing and binary socket send.
- `server/index.js:1008-1037`: binary ingress and publisher validation.
- `server/services/sonioxService.js:563-657`: provisional token parsing.
- `server/services/sonioxService.js:779-833`: 60 ms partial scheduling.
- `server/index.js:368`: partial event forwarding.
- `server/sessionManager.js:773-838`: language-filtered TV/phone relay.
- `public/display.js:832-938`: provisional text placed into the live columns.
- `public/join.js:574-594`: provisional translated text placed into live state.

No step above requires an endpoint. Finalization persists a stable segment and may trigger audio; it should not be required to show captions.

### B. Browser fallback path

Browser SpeechRecognition -> finalized utterance -> `/inject-text` -> translation across ten targets -> wait for TTS -> `LIVE_SUBTITLE` -> completed text displayed.

References:

- `public/admin.js:993-1009`: `interimResults = false` and `isFinal` filtering.
- `public/admin.js:1033`: final transcript submission.
- `server/index.js:80-140`: batch translation, then TTS, then broadcast.

This path intentionally has no word-by-word output while speech remains provisional. Once it becomes the effective path, the pause-dependent behavior is expected. The regression question is why native streaming is missing, not whether this fallback secretly became streaming.

### C. Indirect target-language path

Native Soniox source/other-language stream -> `sentence_finalized` -> secondary translation -> `isFinal: true` event for missing language.

References: `server/index.js:388-454`.

Even with a healthy English Soniox stream, Uzbek/Somali secondary translations currently wait for sentence commit. A final result may commit on punctuation or length before a pause, but there is no continuous provisional translation for those targets. Restoring a source gate alone restores recognition, not native mid-sentence translation in every target language.

### D. HTTP polling path

`sendSessionFeed()` returns saved `session.transcripts`, not the active provisional token buffers (`server/index.js:900-936`). Soniox writes history on `sentence_finalized`, not on every partial. Therefore a polling-only display cannot receive the mid-speech text that only exists in WebSocket token messages. The 2 s TV or 2.5 s phone polling interval adds delivery delay after finalization as well.

## 4. Findings

### R1. High: unsupported-only language rooms lose their source stream

Change introduced in `6d6ce83`:

- `broadcastAudio()` no longer calls `ensureGate(sid, 'en')` after `session_needs_sync`.
- Live demand no longer includes sticky historical languages, reducing accidental English gates.
- Gate admission still rejects languages outside `SONIOX_SUPPORTED_TRANSLATION_LANGUAGES`.

Current references: `sonioxService.js:37-39`, `:353`, `:895-901`; `sessionManager.js:710-736`; `server/index.js:335-341`.

If `tvLanguage` and all live viewers request `uz`/`so`, resync attempts only those rejected targets. No provider receives microphone audio. `isStreaming()` stays false, allowing finalized browser speech through the fallback. This reproduces a concrete route to the reported symptom.

Repair: explicitly plan one source/transcription stream when active live targets require indirect translation and no native source gate covers them. Open it only under valid publisher authorization and eligible fresh audio. Share that source across indirect targets; do not restore unconditional idle English streams. Make live source recognition and final archive commit separate concerns.

Important limit: the current provider public language list also omits Uzbek and Somali. Do not simply add those codes to the whitelist and assume acceptance. Validate coverage for the selected model; retain a deliberate indirect translation path where needed.

### R2. High: fallback has the exact final-only behavior the user observes

`interimResults = false` plus `evt.results[i].isFinal` means the browser does not submit provisional text. The server then calls `translateMultiple()` and waits for TTS before publishing captions.

This behavior predates the billing commit. New gate admission/recovery failures make it more visible. It is a strong symptom explanation, not by itself proof of which native failure occurred.

Repair: restore native PCM/provider operation first. Report the effective provider and degraded mode visibly. If streaming fallback is a product requirement, design a separate provisional channel with stable segment IDs, bounded translation cadence, cancellation/version checks, and final-only history/TTS. Merely setting `interimResults = true` is insufficient while the handler still ignores non-final results. Sending every provisional update through the current injection endpoint would duplicate finalized history and paid translation/TTS work.

### R3. High: missing-language translation is explicitly finalization-gated

`server/index.js:430-451` creates secondary translations only inside `sentence_finalized`; emitted updates are always `isFinal: true`. Thus a native source gate cannot provide word-by-word Uzbek/Somali through the current secondary translator.

The same indirect route may be used for a normally native target if its provider gate was denied by the five-gate cap, failed, or was not active. That target can become sentence-only while another target still streams.

Repair: maintain per-target routing state. For indirect live targets, translate bounded rolling source segments before endpoint, attach revisions, discard stale results, and finalize once. Debounce and cap concurrent work; do not retranslate every token without limits. Preserve provider-native streaming for languages with native gates.

### R4. High: cooldown expiry no longer clears the rate-limit flag

The baseline `ensureGate()` reset `isRateLimited = false` when the deadline passed. The refactored gate admission checks the deadline but never resets the flag.

Current references: `sonioxService.js:157-164`, `:543-549`, `:585-597`.

After expiry, a new gate can be admitted because eligibility checks the timestamp, but the scheduled reconnect still requires `!this.isRateLimited`. That retry is skipped while the stale flag remains true. A later resync/audio event can replace the gate, so this is not proof that recovery always remains permanently disabled. It is a reproducible inconsistent recovery state that can prolong degradation and sentence fallback.

Repair: centralize cooldown state/expiry and use the same timestamp-aware policy for admission, retry, and status. Preserve retry backoff and publisher eligibility; do not bypass real 429 limits. Test expiry followed by transient close with and without subsequent demand events.

### R5. High: fallback arbitration tests socket openness, not useful output

The browser uses a 3.5 s last-token heuristic, but the server suppresses browser fallback if ANY gate is merely open (`server/index.js:147`, `:832`). `isStreaming()` only checks socket state (`sonioxService.js:181-192`). `SONIOX_STATUS` also reports streaming before provider audio/results are confirmed (`:447-453`).

An open gate can have no audio, no translated output, or no coverage for the selected target. The browser may attempt recovery, only for the server to suppress it. Conversely, no open gate leads to final-only fallback. These inconsistent definitions hide which engine actually produces the visible sentences.

Repair: track audio ingress, provider send, last original token, last nonempty translation token, and per-target routing. Distinguish configured/connecting/audio-active/result-active/degraded. Use bounded, target-aware takeover with segment-level deduplication; do not treat a socket-open notification or an empty token update as proof of useful translation.

### R6. Medium: raw audio can fail while browser recognition continues

`startMicrophone()` catches PCM processor setup failures as a console notice (`admin.js:935`) and continues starting browser SpeechRecognition. It does not explicitly await `audioContext.resume()` or prove PCM delivery. When the publisher WebSocket is down, PCM frames are discarded, while the browser can still send finalized transcripts over HTTP.

This is an independent path to the exact symptom even for English. It was not newly introduced by the billing commit, and no actual browser AudioContext failure was reproduced here. Browser audio capture, sample rate, `bufferedAmount`, processor callbacks, and outbound binary frames need live observation.

Repair: record/verify AudioContext running state and audio byte counters, resume under user interaction, and visibly distinguish capture-only from provider-ready. Buffer only a bounded pre-roll during connection setup. Modernizing deprecated ScriptProcessor to AudioWorklet may help stability, but is a separate change and not a proven required fix for this incident.

### R7. Medium: authorization latency is not inherently sentence buffering

The new publisher lease lasts 10 s and renews every 3 s; binary audio itself activates/renews it (`server/index.js:1024-1033`). In the reviewed single-process code, it does not intentionally queue audio until the next heartbeat, sentence end, or pause. Native partial tests pass with publisher validation enabled.

Lease churn, multiple workers with independent Maps, late mic-off beacons, or start/reset races can still interrupt streams. For example, `startSession()` clears publisher state, and delayed renewal/off requests have no publisher-generation fence. These require an event timeline to connect them to the observed incident.

Repair: tie activation/renewal/off to publisher/run generation and connection ownership; log revocation reasons. Preserve immediate stop denial. Do not increase lease duration or remove validation as a speculative latency fix.

### R8. Medium: polling cannot reconstruct provisional speech

The feed serves finalized transcripts only. If native provider tokens exist but the TV/phone WebSocket is blocked, the screen can remain empty during speech and receive sentences afterward. Faster polling does not fix missing provisional data.

The TV watchdog also uses general message activity rather than selected-language subtitle activity, so statistics or PONG messages can mask subtitle failure. Its polling sequence cursor advances on provisional WebSocket sequence numbers (`display.js:1170-1175`), potentially excluding the later finalized record of the same segment from delta recovery.

Repair: if streaming over HTTP fallback is required, expose an ephemeral latest partial snapshot per session/target/run with a separate revision cursor. Keep final-history and provisional cursors distinct. Use subtitle-specific liveness, not unrelated control messages. Preserve ES5-safe display code.

### R9. Medium: current tests do not demonstrate microphone-to-visible streaming

The latency benchmark fails at `test/soniox_latency_bench.js:53`: it calls the obsolete default-session sync signature, which gate eligibility rejects. It also looks up the gate as `en` instead of a session-qualified key, drops `translatedFull`/replacement fields in its relay, and assumes synchronous delivery despite the 60 ms timer. Even repaired mechanically, a synthetic token-to-send benchmark does not measure real speech-to-caption latency.

The new authoritative billing test replaces `connectGate()` and focuses on shutdown; it does not assert that sustained speech produces provisional captions before endpoint. `package.json` does not include either the new authoritative lifecycle test or the latency benchmark in its normal test command. A green shutdown suite is therefore not evidence that live translation survived the change.

Repair: add end-to-end provisional delivery regressions to the required test command, alongside the spend regressions. Test actual protocol fields and await the scheduling window; measure provider/audio/browser latency separately from internal relay latency.

## 5. Incident Diagnosis Procedure

The missing evidence should be collected during one 15-20 s continuous utterance with no deliberate long pause. This audit did not initiate that live experiment.

| Observation while speech continues | Likely failing stage | Next check |
| --- | --- | --- |
| No outbound binary microphone frames | Capture/AudioContext/publisher socket | Processor callbacks, context state, WebSocket state |
| Binary frames reach server; zero gates; only `uz`/`so` demand | R1 routing regression | Planned source gate and indirect target routing |
| No gates for native English/Bengali demand | Eligibility/configuration/provider connection | Publisher status, 400/401/402/429, selected model |
| Provider receives audio but returns no partial text | Provider/config/audio quality/timing | Audio format/rate, processing progress, original versus translated tokens |
| Source partials arrive; only selected translation waits | Indirect translation/capacity or provider translation | Target gate admission and R3 |
| Server emits partials but viewer receives no frames | Subscriber language/session/transport | Room ID, language filter, connection/reconnect ownership |
| Viewer receives non-final `translatedFull` but DOM stays empty | Client renderer/filter/runtime error | Target match, Arabic-corruption filter, actual DOM updates |
| Only `/inject-text` and `LIVE_SUBTITLE` appear after pause | Sentence fallback is effective | Native PCM/gate failure reason |
| Only `/feed` responses supply captions | Polling-only final-history transport | Viewer WebSocket plus R8 |
| Caption appears only on physical mic OFF with `gate-close` commits | Provider did not deliver usable partials or pipeline lost them | Timestamp provider receive and app emit before shutdown |

Capture deployment revision/environment, session/run/publisher generation, source and target languages, actual selected model, active gates and demand, provider errors, and the transport in use. Record counts/timestamps and sanitized protocol samples; never log keys. Audio content capture is optional and should be deliberate.

If Arabic/source text also waits until the pause, prioritize the shared audio/provider/transport stage. If Arabic streams but only translation waits, prioritize target routing and secondary translation. If phones stream while the TV waits, prioritize TV transport/rendering rather than provider lifecycle.

## 6. Implementation Plan

### Phase 1: Establish path visibility and preserve the billing boundary

1. Add per-session/target diagnostics: desired route, gate admission reason, publisher generation/lease state, audio bytes received/sent, last nonempty original/translation token, partial/final counts, and fallback reason.
2. Distinguish native streaming, secondary live translation, sentence fallback, and polling recovery in admin status. Show degradation without exposing engineering details to attendees unnecessarily.
3. Keep no-publisher/no-audio startup safeguards, stop/revoke behavior, identity checks, and termination deadline as regression invariants.

Deliverable: a single continuous-speech trace can identify the first stage that stops producing useful output. Avoid adding broad logging of transcript contents by default.

### Phase 2: Fix the confirmed source routing and cooldown regressions

1. Compute native targets and indirect targets from current live demand and model capability.
2. Reuse a native source-bearing stream when available; otherwise plan exactly one source stream for indirect targets, gated by valid publisher and fresh audio. Do not require an English viewer as an accidental trigger for recognition.
3. Separate source-stream ownership from output language filters so original captions can flow even when the target translator has not produced text yet.
4. Normalize cooldown expiry in one place and make gate admission/retry/status consistent. Revalidate publisher ownership at every retry/open/audio flush.

Deliverable: an Uzbek-only or Somali-only room has continuous source recognition during active speech, and a native target recovers automatically after cooldown plus network blip without needing a new viewer event.

### Phase 3: Restore mid-speech translation on indirect/degraded paths

1. Continue native provisional forwarding unchanged for supported targets; test actual field values through browser DOM updates.
2. Add provisional secondary translation for indirect targets using bounded rolling segments and a measured cadence, for example 300-700 ms as an initial tuning range rather than a guaranteed end-to-end latency.
3. Tag each task with run/segment/revision and discard stale completions. Coalesce updates, cap in-flight work, cancel work on mic-off/end/delete, and finalize the segment once.
4. Publish available caption text before TTS completes. Keep history and speech synthesis tied to stable/final text to avoid repeating audio and corrupting archives.
5. Make fallback takeover depend on useful per-target progress during active audio, with a bounded grace period and duplicate prevention. If browser interim fallback is enabled, use the same provisional protocol instead of `/inject-text` for every update.

Deliverable: indirect translation updates while the speaker continues, with bounded translation work and no additional idle Soniox streams. Native output is not delayed behind secondary translation or TTS.

### Phase 4: Address transport/capture only where the incident trace points

1. Verify/resume capture context and show actionable PCM/socket failures rather than silently treating a moving microphone meter as successful provider input.
2. If polling-only streaming is required, add short-lived per-target provisional snapshots, run IDs, revisions, and explicit expiry. Keep final transcript delta cursors independent.
3. Track caption-specific liveness and language coverage rather than all WebSocket traffic. Reconcile per-run cursors on reconnect and preserve Smart TV ES5 compatibility.
4. Fence publisher renew/off requests by generation and verify the persistent stream worker owns the stop/start/audio events. Avoid routing one publisher's lease across uncoordinated process-local session stores.

Deliverable: transport degradation has explicit behavior; polling cannot falsely claim native word streaming while serving only finalized history.

### Phase 5: Require both latency and spend checks

1. Repair or replace the obsolete benchmark, retaining its scope as internal relay latency only. Add the authoritative lifecycle and provisional streaming regressions to the normal test command.
2. Add a deterministic local fake-provider test: feed incremental original and translated non-final tokens during a long utterance, assert TV and phone DOM text changes BEFORE injecting any final token or endpoint.
3. Add unsupported-only demand, target-capacity fallback, cooldown expiry/reconnect, publisher expiry/recovery, quiet speech, noise, and polling snapshot cases.
4. After offline checks pass, use a short budget-limited staging trial with representative continuous speech. Measure first useful original, first useful translation, successive updates, finalization delay, and stop-to-transport-close independently. Verify no stream reopens from viewer pings after mic-off.

Do not claim universal sub-200 ms microphone-to-translation latency from the 60 ms scheduler. Provider inference, linguistic context, network, and browser paint contribute additional time. The required behavioral acceptance is visible useful updates DURING sustained speech, not merely fast delivery after an endpoint.

## 7. Acceptance Matrix

| Scenario | Latency expectation | Cost/lifecycle expectation |
| --- | --- | --- |
| 15-20 s native English/Bengali speech | Multiple visible provisional updates before first endpoint | Only demanded/authorized streams |
| Only Uzbek or Somali viewers/TV | Source partials plus provisional secondary target output | At most one shared source when no native source exists |
| Native plus indirect targets | Native output not blocked by secondary jobs | Shared recognition, bounded translation work |
| Quiet sustained speech | No artificial wait for mic-off; capture/VAD diagnosed if weak | Stop guard unaffected |
| 429 cooldown then transient socket close | Automatic timestamp-aware recovery | Backoff respected, no reconnect storm |
| Slow/out-of-order secondary translations | Latest revision wins; no caption rollback | Bounded concurrency and stale-job cancellation |
| TV WebSocket blocked | Provisional snapshot updates if this capability is implemented | No separate Soniox stream per viewer |
| Mic off/end/delete while jobs are pending | No stale new-run captions or restarted publisher | Provider close deadline and zero unauthorized reopen |
| Viewer heartbeat after silence shutdown | Viewer traffic alone cannot authorize fresh paid work | Fresh-audio eligibility retained |
| TTS slow/unavailable | Captions still publish when text is ready | No duplicated speech jobs for provisional text |

## 8. What Not to Change Blindly

- Do not remove the publisher validator or restore opening gates at session Start.
- Do not disable endpoint detection as the first fix. Soniox documents that non-final tokens stream while endpoint detection is enabled; endpoint settings govern finalization, not whether provisional text may be displayed.
- Do not reduce the 12 s silence cutoff to force sentence commits; this sacrifices continuity and increases connection churn.
- Do not mistake typewriter animation of a completed sentence for provider token streaming.
- Do not add Uzbek/Somali to a provider whitelist without model capability evidence.
- Do not promise that turning on browser interim results alone makes translation streaming; the rest of the fallback currently consumes final results only.
- Do not upgrade from the configured/default `stt-rt-v5` to a new model as an unverified workaround. The latest documentation advertises v6, but this audit did not establish a model change as the cause. Validate actual model behavior separately under controlled conditions.

## 9. Sources and Remaining Uncertainty

Sources accessed 2026-11-05:

- [Soniox real-time translation](https://soniox.com/docs/translation/stt-translation/rt-translation): translation tokens can arrive mid-sentence alongside original tokens.
- [Soniox endpoint detection](https://soniox.com/docs/stt/rt/endpoint-detection): provisional tokens stream while the speaker talks even with endpoint detection enabled.
- [Soniox translation languages](https://soniox.com/docs/translation/supported-languages): current published language list; neither Uzbek nor Somali is listed.
- Repository comparison `65df180..6d6ce83` and the source references above.

Confirmed: source-gate loss for excluded-only targets; cooldown state inconsistency; final-only fallback/secondary/polling behavior; functioning native non-final service relay in isolated tests; obsolete failing benchmark.

Not established: which target/provider/transport the user was using, whether live Soniox emitted provisional tokens, whether a browser capture failure occurred, actual deployed model/revision, and measured real-world speech-to-caption latency. Resolve those through the short path trace in section 5 before claiming one finding explains every target or making a broad rewrite.
