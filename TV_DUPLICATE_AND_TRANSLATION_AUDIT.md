# Duplicate Captions and Missing TV Translation Audit

Date: 2026-11-05

Reviewed revision: `6b5af2fce7cadfc3aa40e905604b191f91937c39`.

Scope: investigate repeated captions and Smart TV showing only original speech in split/translation-only modes. Deliver findings and a detailed repair plan. No application fixes or deployments were made; no paid AI calls were opened.

## 1. Assessment

The repeated subtitles have a confirmed application cause: the TV renderer is not idempotent. It uses the CSS class `streaming` to decide which paragraph to update instead of locating a paragraph by a stable speech-segment ID. Once a final result removes that class, a second final for the same segment creates another paragraph. A late provisional translation can also reopen a finalized segment as a new paragraph.

The latest streaming repair increases the likelihood of those event sequences: rolling translations run asynchronously without revisions or cancellation, while each native language's sentence-final event can start another translation of the same missing target. Several server-produced updates can therefore represent one spoken sentence, and the renderer treats them as new speech.

The original-only symptom has multiple concrete paths, not one verified Smart TV CSS failure:

- Original tokens can intentionally arrive with empty translation, with no durable translation-pending/error state.
- Admin target-language changes alter the TV's local language filter but do not immediately update its server subscription.
- HTTP polling receives screen mode and language settings but does not apply them, making the TV particularly vulnerable when WebSockets are blocked.
- Translation resolution sometimes substitutes English or even original text rather than preserving the requested-language boundary.
- Script-based validation can silently discard translated text while source text continues rendering.

The reviewed HTML has two columns and a translation-only rule that hides the source column. A real translation-only screen showing source could mean the mode was not applied, source/pass-through text entered the translation column, or a device-specific layout problem. No physical TV or live incident trace was available, so this audit does not claim which of those occurred on that device.

There is no special rule in the code that intentionally repeats every sentence exactly three times. The number depends on result ordering, number of active language streams, secondary translation jobs, replays, and fallback events. Three copies are reproducible, but should not be fixed by deleting every second/third line.

## 2. Verification and Limits

The worktree was clean before the audit. Reviewed display rendering, HTML/CSS, server streaming/finalization callbacks, translation validation, gate sequences, settings changes, presence updates, polling, history restoration, and relevant tests.

Created an isolated reproduction harness outside the repository, using committed source loaded into Node VM contexts, a minimal fake DOM, fake sockets, and manually resolved translation promises. It exercised actual display functions and actual server callback bodies without starting the production server. The fake DOM validates row counts and text assignment, not real TV layout, fonts, CSS visibility, or browser paint.

| Reproduction | Result |
| --- | --- |
| Deliver identical final sequence three times through TV socket handler | Three original rows, three translation rows, one recent-history item |
| Deliver final, then late partial, then final for same sequence | Two original rows instead of one |
| Admin changes target from English to Bengali | Local filter changes; no `CHANGE_LANGUAGE` message sent; old English events ignored |
| Translation includes Arabic script for English target | Source row remains; translation suppressed without an unavailable-state card |
| Bengali target receives only English source/pass-through in translations map | English source appears in translation column |
| Resolve older rolling translation after newer translation | Old result broadcasts last |
| Resolve rolling translation after session status becomes ended | Result still broadcasts |
| Two native-language finals for one sequence while Uzbek missing | Two independent Uzbek final translation jobs launch |
| Combine final jobs, late partial, and final replay | Three original rows for one sequence |
| Commit first segment on two independent gates | Both assign `seq: 1`, even for different source text |

`node test/es5_syntax_test.js` passed: the current display script remains ES5 parse-compatible. This is useful evidence against a new general ES6 parse crash, not proof that all TV rendering works.

No provider retransmission behavior, acoustic echo, live duplicate audio publisher, or physical TV CSS defect was reproduced. Those remain alternative contributors if application repairs do not explain the captured event sequence. The entire suite was not run; this audit used targeted offline reproductions and source review.

## 3. Confirmed Findings

### D1. High: repeated final events append duplicate DOM rows

References: `public/display.js:832-980`, especially `:859`, `:915`, `:940`, and `:955`.

`handleStreamingToken()` receives `seq` but does not use it to find DOM nodes. It looks for `.para-item.current.streaming`. A final update removes `streaming`; the next final for the same sequence cannot find the node and appends another. Only the separate `recentFeedItems` collection merges by sequence after DOM changes have already happened.

The socket handler records seen keys (`display.js:1170-1182`) but never checks those keys before rendering streaming/final events. Thus recording an event as seen does not make its rendering idempotent.

Impact: duplicated original/translated rows, repeated finalized TTS, misleading history alignment, and different behavior before/after a rerender or refresh.

Required repair: upsert one source/translation row pair by canonical segment identity; distinguish new revisions from repeated events. Final delivery must be safe to repeat. Preserve legitimate spoken repetitions by giving different speech segments different IDs, even when their text is identical.

### D2. High: rolling translations can arrive after finalization or in reverse order

Reference: `server/index.js:367-418`.

The 450 ms throttle is a launch-rate check, not a single-flight queue. It allows several long-running translation calls at once. Completion handlers have no current-segment/revision comparison and no session/run/publisher validity check. They retain old source, sequence, and timestamp and publish whenever their promise resolves.

Consequences:

- A shorter/older translation can replace a newer one.
- A provisional event can arrive after the final for the same segment.
- D1 then creates another source paragraph.
- Pending callbacks can publish after End/Delete/Clear or after a new run starts.
- Slow provider chains can build many overlapping jobs and unnecessary translation cost.

The throttle is keyed only by session. Every gate can feed it, so multiple independent language recognizers compete to define the source of indirect translation. The winning source can change between ticks.

Required repair: choose a source owner, maintain bounded per-segment/per-target jobs and monotonically increasing revisions, coalesce obsolete work, invalidate pending partials on final/clear/end/run change, and check validity again at completion. Partial delivery must not reopen a finalized segment.

### D3. High: every language gate can launch duplicate final translation work

References: `server/index.js:425-495`; `sonioxService.js:760-814`.

Each native gate emits `sentence_finalized`. The server merges records by `seq`, then starts translations for any currently missing language. If English and Bengali finish while Uzbek is missing, both callbacks can start Uzbek jobs before either completes. The second job is not prevented by the first being in flight. This can also race a native target's own final with a secondary translation started because that target had not finalized yet.

Each completion broadcasts another `isFinal: true` event. Even if final texts match, D1 appends rows. Different texts make text-only duplicate suppression even less reliable. Chinese fan-out can likewise invoke history/final handlers more than once from one provider gate.

Required repair: track requested/in-flight/completed translation state per canonical segment and target; establish native versus secondary target ownership; merge language results as updates to an existing segment. A late valid final correction may update the same row but must not create new speech or replay audio.

### D4. High: `seq` is not the stable session-wide identity the code assumes

References: `sonioxService.js:450`, `:765`, `:855`; `server/index.js:434-455`; `display.js:957`, `:1207`.

Every language gate has its own `seq`, starting at zero. Different languages can segment the same speech differently, yet the server assumes equal numeric sequences mean the same source segment. A gate created after silence/reconnection also starts from zero; sequence values are reused within a session's lifetime.

Consequences include wrong language/source history merges, unrelated results overwriting each other, reused IDs during reconnect, and polling cursors skipping newly generated low-number sequences. Adding client deduplication using only `seq` would conceal some valid speech and cannot fully fix the protocol.

Required repair: a server-owned run ID and canonical source-segment ID, independent of per-gate counters. Map target results onto those source segments using a deliberate alignment strategy. If alignment is unavailable, retain distinct stream-local identities and do not merge equal counters as if they represented the same utterance. A new global display ordering counter alone is not sufficient to align independent recognizers.

### D5. High: TV language filter and server subscription diverge after admin changes

References: `display.js:1127-1148`, `:1115-1118`; `sessionManager.js:793-808` and `:547-564`.

On `TV_SETTINGS_UPDATE`, the TV changes `targetLang`, rerenders history, and requests backfill, but does not send `CHANGE_LANGUAGE`. The server continues filtering live tokens by that subscriber's old language, while the TV rejects those events because its local filter is already the new language.

The TV's next ten-second heartbeat includes the new language, and `touchSubscriber()` updates the subscription then. Therefore this is often a temporary gap up to the next successful heartbeat, not necessarily permanent. A blocked heartbeat, stale connection, or inconsistent join-time settings can prolong it. A join confirmation that changes `targetLang` has the same missing immediate reconciliation.

Required repair: synchronize effective target and subscription atomically, acknowledge the effective language, and resync on join/reconnect. Define how URL overrides interact with admin settings. Do not depend on a presence heartbeat to apply a user-visible language change.

### D6. High: polling-only TV does not apply language/source/mode settings

References: `display.js:1200-1270`; `server/index.js:941-978`.

Feed responses include `tvLanguage`, `tvScreenMode`, and `sourceLanguage`. The display polling callback applies font/audio/QR settings but ignores these three. A TV with WebSockets blocked will not reflect later split/translation-only or target-language changes through polling. Initial REST state is applied, but updates can remain stale until refresh.

This is especially relevant to built-in TV browsers because polling resilience was explicitly added for those devices.

Required repair: one settings-application function used by initialization, join, WebSocket settings, and polling. Include a settings revision and consistent override policy. Source rendering must remain hidden in translation-only mode regardless of which transport delivered settings.

### D7. High: translation content is not consistently restricted to the requested target

References: `display.js:635-659`, `:733-739`, `:779-785`, `:1250-1255`; `sessionManager.js:900-907`.

The display uses different resolution rules in different paths:

- Streaming reads `translatedFull` and applies a script filter.
- History/append selects `transObj[targetLang] || transObj.en` without the same validation.
- Rerender tries the requested language, then English, then any other acceptable value.
- Polling constructs a `translated` fallback using target translation, English, or `item.arabic`.

If a translations map is absent, that last fallback can be wrapped under the requested target as if original speech were a translation. If the original speech is English and English is present as source/pass-through, a Bengali/Turkish/etc. screen can display English in its translation column. The synthetic Bengali-target test confirmed this behavior. A blanket script filter cannot detect same-script wrong-language text.

Required repair: explicit source and requested-language translation fields with translation availability/state. Do not silently substitute source or another target language. If source and target are deliberately the same language, handle that as an explicit product rule rather than guessing from text equality. Missing translation should produce an honest pending/unavailable state, not mislabeled source.

### D8. Medium/High: source-only updates have no adequate translation failure state

References: `sonioxService.js:872-887`; `display.js:848-949`, `:524-544`; `translationService.js:281-286`.

The anchor implementation explicitly sends indirect targets original-only partials with `translatedFull: ''`. The display removes idle placeholders and renders source. It may show a temporary ellipsis, but no translation timeout, retry/degraded state, or target-specific progress indicator distinguishes a normal initial gap from failed translation. Final source-only events can leave no meaningful translation row.

The English/non-Arabic filter rejects any string containing Arabic code points. A translated sentence containing an Arabic quote, name, or religious phrase can therefore be discarded in full. The filter can prevent corrupt source leakage, but it is not language detection and should not silently blank otherwise useful output. Urdu is treated as an Arabic-script target, so raw Arabic leakage is not rejected by this heuristic either.

Required repair: preserve fast source updates in split mode while showing clear translation pending/degraded state; never render the source column in translation-only mode. Validate translation provenance and target routing, then handle mixed-script spans deliberately. Do not remove validation wholesale and reintroduce raw source under translation labels.

### D9. Medium: settings and viewer connection events unnecessarily reconnect recognition

References: `admin.js:1545-1587`; `display.js:1066-1082`; `sonioxService.js:222-242`; `server/index.js:889-891`, `:1157-1194`.

Admin screen settings are sent through both WebSocket and HTTP and include the source language even when only layout/target changes. `setSourceLanguage()` reconnects all relevant gates even when the language has not changed, and commits pending text before doing so. A TV also sends `SET_SOURCE_LANGUAGE` every time its socket opens.

Consequences: layout changes or TV reconnects can finalize/reconnect microphone recognition, create additional source/translation events, and amplify races. Repeated delivery of the same settings is not harmless at the provider lifecycle layer.

Required repair: viewers read source settings instead of writing them on connect; source setters return early on no-op changes; settings mutations are idempotent or versioned; only a genuine authorized source-language change reconnects recognition, once. Retain the current run/segment identity across target/layout changes.

### D10. Medium: history, polling, and animation paths bypass segment reconciliation

References: `display.js:580-632`, `:685-830`, `:983-1008`, `:1170-1182`, `:1204-1266`, `:1337-1352`.

- `appendToFeed()` pushes history without sequence/timestamp metadata.
- `handleIncomingSpeech()` can push duplicate recent-history items even when a visible text match prevents a new row.
- Typewriter intervals are not cancelled when an in-place update finalizes their node; old callbacks can continue appending old words to corrected content.
- Clear does not cancel active animations or reset `lastSeqReceived`.
- Streaming partials advance the final-history polling cursor; final enrichment to that sequence is then excluded.
- Polling can mark records seen even when it decides not to render them.
- Final-only `since_seq` cannot deliver translations that become available later on an existing sequence.

Required repair: one segment store and update reducer across live frames, history, backfill, polling, and reconnect. Keep event/update revisions separate from final ordering. Either avoid synthetic typewriter replay for already-complete history or give every animation an explicit cancellable owner.

### D11. Medium: test coverage verifies original-only streaming but not successful TV translation

References: `test/soniox_realtime_regression_fix_test.js:143-163`; `test/tv_display_e2e_test.js`; `package.json:10-14`.

The new anchor regression test passes when Uzbek receives original text with no translated text. It never exercises the asynchronous translation completion or browser rendering. The TV "E2E" test checks session manager values and a copied delta-filter function; it does not run `display.js` in a browser/DOM or validate columns, deduplication, or settings propagation. Neither of those test files is included in the current default test script.

Required repair: add protocol-to-DOM tests and true transport settings tests to the required suite, and verify both columns' actual content. Keep ES5 parsing, mid-speech output, and billing shutdown invariants in the same release criteria.

## 4. Root-Cause Chains

### Repeated sentence

1. Native source/language streams produce provisional and final versions of one spoken utterance.
2. Multiple language finals can launch overlapping secondary final translations for one target.
3. Rolling translation may resolve after the final or in reverse order.
4. The TV updates the current streaming node, finalizes it, then creates a fresh node for a repeated final or late partial.
5. The same original sentence remains in several history rows, even if the recent-history array has only one segment.

The server should emit useful revisions; the client should tolerate replay. Both sides need correction. Fixing only duplicate server jobs leaves ordinary reconnect/replay unsafe. Fixing only DOM row counts leaves wrong-language merges and unnecessary translation work.

### Original visible, translation absent or wrong

1. An anchor/source result is available before a valid target translation, or target subscription/settings are stale.
2. Source renders immediately, while translation is empty, filtered, or not delivered.
3. Polling cannot correct all mode/language changes, and some fallback paths use source/English instead of a target-specific unavailable state.
4. Split mode appears source-only; translation-only may remain in the old mode or display mislabeled source in its translation column.

The reviewed CSS already hides `#arabic-col` for `screen-mode-trans-only`. If that rule applies and the source column is still visible on a particular TV, inspect real computed styles and dimensions. No evidence from this audit justifies declaring all flex layout broken or replacing the TV design blindly.

## 5. Detailed Implementation Plan

All work below is proposed, not implemented.

### Phase 1: Introduce a correct speech-segment and update contract

Target: `server/services/sonioxService.js`, `server/index.js`, `server/sessionManager.js`.

1. Assign `runId` and canonical source `segmentId`; define one source stream/segmentation owner for indirect translation. Preserve stream generation and provider audio offsets where needed to align independent targets.
2. Specify each event's target language, source text, translated text, translation state, revision, final status, and source producer. Keep source identity separate from display order and transport delivery IDs.
3. Define merge semantics: duplicate revision is ignored; older revision cannot replace newer; final cannot regress to provisional; a valid final correction updates the existing segment; a genuinely repeated spoken phrase has a new segment ID.
4. Stop merging arbitrary equal per-gate sequence counters. Provide a deliberate alignment policy for native language results. Preserve existing transcripts/history through explicit normalization where persisted records lack new IDs, rather than blindly treating old `seq` as globally unique.
5. Carry the same identity through partials, secondary finals, `LIVE_SUBTITLE`, history, backfill, and polling. Clear/end invalidate the correct run/epoch so old callbacks cannot repopulate the screen.

Acceptance: one utterance has one source identity across all routes; two legitimately spoken identical sentences remain distinct; reconnect cannot reuse a previous segment's identity.

### Phase 2: Bound and version asynchronous translations

Target: rolling/final translation callbacks in `server/index.js` and translation orchestration.

1. Use the selected source owner rather than all gate/sub-language events as triggers.
2. Maintain per-segment/per-target single-flight or explicitly bounded coalescing. Reuse identical work and track final requests already in flight.
3. At completion verify session/run, publisher generation, segment revision, target demand, and provisional/final status. Drop obsolete or invalid results.
4. Finalization cancels/supersedes provisional work. Native targets own their live final output unless a deliberate failover grants secondary ownership; late results become corrections, not additional sentences.
5. Cancel/invalidate work on clear/end/delete/restart; clean up throttle/job maps. Cancellation guards are necessary even if an underlying HTTP request cannot be aborted.
6. Publish translated text immediately when ready; keep finalized TTS and archives separate from provisional updates. Deduplicate TTS by segment/target final identity.

Acceptance: two native finals launch at most one necessary final translation per target; old partials cannot publish after final or stop; slow translation cannot create an unbounded queue.

### Phase 3: Make the TV renderer idempotent

Target: `public/display.js`, preserving ES5 compatibility.

1. Use an ES5-compatible object store indexed by `runId`/`segmentId`, with one pair of source/translation DOM nodes per segment. Do not choose identity using `.current.streaming`.
2. Route every transport/history update through one merge function before DOM mutation. Compare revision/finality and update the correct node in place.
3. Store source and target translation state together. Translation arriving later updates the existing pair and does not append source again.
4. Use ordering independent of timestamps that change on every update; cap/prune the store and DOM together. Separate current styling from data identity.
5. Cancel owned animations on replacement, finalization, clear, language switch, and session transition. Prefer direct provisional replacement and static final/history rendering over replaying completed text word by word.
6. Deduplicate finalized audio separately from visual corrections. Rendering a replayed final must neither create a row nor speak it again.

Acceptance: partial -> final -> duplicate final -> late partial -> corrected final stays one row pair; two distinct equal-text segments stay two row pairs.

### Phase 4: Enforce requested-language content and reliable screen modes

Target: display initialization/settings/polling, server TV subscription handling, `public/display.html` for state presentation.

1. Apply settings through one function on REST init, join, settings event, and feed response. Include settings revision and a documented URL/admin override policy.
2. Reconcile the effective target language with the server subscription immediately. Use an acknowledged language change or an equivalent server-driven subscription update; resync on reconnect and join.
3. Apply `tvLanguage`, `tvScreenMode`, and `sourceLanguage` during polling, not only font/audio/QR settings.
4. Resolve translation only from the requested target's result. Remove implicit original/English/arbitrary-language substitution from translation content paths. Provide pending/unavailable/retry state without relabeling source.
5. For split mode, show source plus the selected translation or a clear translation state. For translation-only mode, keep source column hidden during startup, loading, error, and reconnect. A brief translation-pending state is honest; the implementation cannot guarantee a translation before a provider has produced one.
6. Revise mixed-script validation using result provenance and intentional quoted spans. Preserve safeguards against raw source leakage. Handle actual source=target explicitly.
7. Make source-language configuration no-op-safe and remove viewer writes on connect. Layout/target changes must not reconnect the recognition stream.
8. Keep QR, Arabic direction/font fallback, scrolling, and legacy safe JavaScript intact. Inspect real TV column widths/computed visibility before adding any CSS layout fallback.

Acceptance: changing split/translation-only or target updates a polling-only TV and an open-WebSocket TV consistently; no original/English fallback masquerades as Bengali/Uzbek/etc.; repeated layout settings do not reconnect Soniox.

### Phase 5: Make polling and recovery merge updates, not replay sentences

Target: feed response/cursors, TV poller, reconnect/history/backfill.

1. Use an update cursor/revision that can represent later translation enrichment on an existing segment. Do not advance a final transcript cursor merely because a provisional sequence was seen.
2. Include run/settings identity and, if live HTTP fallback is required, a short-lived latest-partial snapshot with revision. Final-history ordering and provisional updates need separate semantics.
3. Reconcile polling/WS/backfill through the same segment store. Mark an update accepted only after processing; replay is safe rather than suppressed by a prematurely advanced seen set.
4. Track selected-language caption progress separately from generic PONG/stats traffic. Reset run state/cursors on clear/new session appropriately.

Acceptance: WS partial then polling final, HTTP-to-WS recovery, backfill, and repeated history fetch all produce one segment; later translations of old segments are not silently skipped.

### Phase 6: Add release-blocking integration and TV checks

Target: tests and `package.json`.

1. Add actual display-script DOM tests with both native and indirect event sequences, not only session-manager state checks.
2. Exercise the real server callback orchestration with deferred fake translation responses in both normal and reversed order; verify job counts, emitted identities, and finality.
3. Add native multi-gate segmentation/reconnect tests; equal numeric gate counters must not merge unrelated utterances.
4. Add real subscription tests for admin language changes, heartbeat recovery, and initial join races. Add polling-only settings tests.
5. Preserve ES5 parse checks, pre-endpoint caption updates, and mic-off/end/delete spend invariants. Include relevant streaming/authoritative lifecycle suites in the default release checks after correcting stale assumptions.
6. Perform desktop DOM/layout smoke checks plus representative physical Samsung/LG/Android TV checks, using recorded sanitized event fixtures to isolate rendering from microphone/provider behavior.

## 6. Required Test Matrix

| Scenario | Expected result |
| --- | --- |
| Same final replayed three times | One source row, one target row, at most one TTS action |
| Final -> late partial -> final correction | One row pair; no provisional rollback |
| Older translation resolves after newer | Latest valid revision wins |
| Two native gates finish before indirect translation completes | One necessary indirect final job/result identity |
| Different utterances on two gates both have seq=1 | No incorrect cross-language merge |
| Speaker genuinely repeats same phrase twice | Two distinct segments retained |
| Translation arrives after source | Existing source row enriched; no duplicate source |
| Target missing, English/source available | Target pending/unavailable; no mislabeled fallback |
| Translation contains valid Arabic quotation | Deliberate mixed-script handling; no silent whole-column failure |
| Target changes while connected | Immediate subscription/filter agreement |
| Target/mode changes on polling-only TV | New settings apply without refresh |
| Translation-only startup/reconnect/error | Source column remains hidden |
| Layout/QR/font update includes unchanged source language | Recognition stream not restarted |
| WS partial -> polling final -> backfill | One consistent segment |
| Clear/end/delete while jobs/animations are pending | No stale captions or unauthorized provider reopen |
| Gate restarts after long silence | New identities/order work; old poll cursor cannot erase new speech |

## 7. Incident Evidence to Capture

For one sentence that repeats, capture sanitized received events with session/run, provider gate/generation, target language, sequence/segment, final flag, source/translation strings, emitted/received times, and producer route. Count source and translation DOM rows after each event. This distinguishes provider text repetition inside one event from multiple application events or client-only row duplication.

For the physical TV, record effective target, selected screen mode, body mode class, computed `display` and widths of both columns, WebSocket state, last settings revision, and latest feed settings. Identify whether original text is in `arabic-feed`, incorrectly in `trans-feed`, or both. That distinction determines whether settings, translation resolution, or CSS is responsible.

No screenshots or live traces were captured by this audit. Confirmed code defects should be fixed regardless, but those measurements are necessary before claiming the exact same mechanism explains every physical-TV observation.

## 8. Recommended Order

Start with canonical segment/update identity and translation job ownership, then the TV upsert renderer and shared settings application. Remove unsafe language fallback while introducing explicit translation states. Finish recovery cursor integration and required tests before deploying.

A text-only duplicate filter is insufficient: it would hide genuine repeated speech while leaving wrong segment alignment, repeated translation costs, stale settings, and late-result races intact. Preserve both recent improvements: mid-speech translation and authoritative billing shutdown.
