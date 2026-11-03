# Soniox Billing and Lifecycle Audit

Audit date: 2026-11-03

Source revision reviewed: `65df180fae7e54f2f97328f204196554afc5349d`.

Scope: investigate application and provider explanations for continuing Soniox charges; produce a repair and verification plan. No application fixes, credential changes, deployments, or paid provider experiments were performed.

## 1. Assessment

There are confirmed application defects capable of opening unnecessary Soniox streams, reopening streams after microphone shutdown, and losing track of live sockets. Soniox documents that real-time streams are charged for their full duration, not only for the audio sent. Therefore, suppressing microphone frames is not sufficient to stop charges.

The strongest identified chain is:

1. A session remains `active` after its microphone is turned off, or after an End request fails.
2. A TV/attendee sends an ordinary HTTP presence ping, joins, disconnects, or changes language.
3. Session statistics emit `languages_updated`.
4. The server calls `syncGates()` because the session is still active.
5. `syncGates()` opens configured Soniox streams without requiring an enabled microphone, a publisher, or recent speech.
6. Silence cleanup closes the streams, but a later presence event can reopen them again.

This is a recurring stream creation problem, not necessarily one socket staying open forever.

However, a successful server-side End or Delete does have protection: lifecycle events close matching gates, the session validator rejects inactive/deleted sessions, and audio handlers reject inactive sessions. The audit does NOT establish that a correctly ended/deleted session on a single healthy process will keep billing indefinitely. For that exact symptom, investigate failed stop requests, another still-active session, another deployment/process, socket races, and provider request timestamps.

Simply assigning a key does not initiate a network connection in this service. The constructor and `setApiKey()` only store/validate the key locally. A started session or another gate-opening path is needed. If a completely idle fresh process truly incurs new usage merely from storing a key, that observation points beyond the constructor and needs account/deployment evidence.

No account-specific billing error by Soniox has been proven. The absence of negative user reviews does not establish that a provider cannot have an individual billing issue.

## 2. Evidence and Limits

Reviewed `server/services/sonioxService.js`, session lifecycle and WebSocket handlers in `server/index.js`, `server/sessionManager.js`, microphone/admin controls, attendee and TV presence paths, deployment entry points, existing Soniox tests, and prior implementation documentation.

Verified public Soniox documentation about streaming charges, stream termination, usage records, activity counters, and spending limits. Sources are listed in section 10.

Ran the following without contacting Soniox:

- `SONIOX_API_KEY= node test/soniox_gate_test.js`: passed.
- An isolated in-memory verification harness using a replacement `ws` module and fake timers, exercising the real service implementation: six defects/behaviors reproduced, listed in section 5.

No `.env` secrets were read or displayed. No authenticated Soniox account queries were made. No production process was stopped. The complete application suite was not run; this was a targeted billing audit. The lifecycle audit test was reviewed rather than executed because it invokes session deletion/history persistence against the application's normal data location.

Fake socket tests establish application control-flow defects. They do not measure real provider billing or prove that every newly configured request is accepted and charged; validation failures, first-audio timeouts, and account limits can reject some attempts.

## 3. Provider Findings

### P1. Full stream duration is billable

Soniox's Connection Keepalive and Manual Finalization documentation explicitly states: "You are charged for the full stream duration, not just the audio processed."

Consequences:

- Stopping audio transmission while keeping a configured stream alive is not a reliable cost stop.
- Silence and `keepalive` can preserve a billable stream.
- `finalize` finalizes pending text but does not end the stream; audio may continue afterward.
- A stopped browser microphone, a cleared transcript, a closed admin page, and a deleted application session are different events. Only application logic that actually terminates all owned provider streams can connect those actions to a billing stop.

### P2. The current end-of-stream frame is correct, but closure confirmation is missing

Soniox requires an empty TEXT frame (`ws.send('')`) to end a stream. An empty binary audio frame does not end it. The service already sends the correct empty string in `closeGate()`; the audit does not identify an incorrect frame type as the primary cause.

The documented provider completion response may contain `tokens: []` and `finished: true`. The service ignores such a response because it returns early when tokens are empty. Soniox normally closes the socket after finishing anyway, so this parser defect alone is not proof of indefinite billing.

### P3. The app's hourly price is not an authoritative bill

`getStatus()` estimates `gateCount * 0.18` USD/hr. `.env.example` and `SONIOX_IMPLEMENTATION_PLAN.md` repeat a flat $0.18/hr assumption.

The current public pricing page describes token-based pricing: real-time input audio at $2.00 per million tokens, input text at $4.00 per million, output text at $4.00 per million, with an approximate transcription equivalent of $0.12/hr. Context and translation output affect the exact total. Historical invoices and model/account terms must be evaluated against the rate in effect for those requests.

The page also markets translation as included with no separate translation surcharge. That must not be interpreted as unlimited output tokens or multiple independent language streams costing the same as one stream.

The local estimate excludes cumulative duration, overlapping closing sockets, untracked sockets, other processes, context tokens, and actual provider usage. It can say zero while an existing socket is still open. It must not be presented as an actual bill or a guaranteed zero-cost state.

### P4. Provider tools can distinguish the competing explanations

Soniox documents:

- Per-request usage logs containing model, UTC start/end times, tokens, duration, cost, request UUID, and optional `client_reference_id`.
- Live project and organization concurrent request counts, plus historical concurrency.
- Usage summaries splitting API and console playground costs.
- Organization/project monthly usage limits; limits may take time to apply and can have some overrun.

Usage logs are documented as recording successfully completed requests, so an absent entry does not prove there is no active stream. Use live activity together with completed logs.

Public status reported all systems operational and no notices for the preceding seven days when checked. This does not rule out an account-specific billing problem, a historical incident, or reporting delay. No published billing settlement delay was verified; delayed posting is a hypothesis, not an established explanation for this account.

## 4. Application Findings

Severity reflects potential spend and operational impact. "Confirmed" means visible in source and/or reproduced locally, not proven against an invoice.

### F1. High: mic-off is not remembered, so presence events can reopen streams

Evidence:

- `sonioxService.js:848`: `onMicrophoneOff()` only closes existing gates.
- `sonioxService.js:243`: `syncGates()` checks session active status, not microphone/publisher state.
- `sessionManager.js:475`: HTTP presence pings call `notifyStatsUpdate()`.
- `sessionManager.js:651`: statistics emit `languages_updated` even without an actual demand change.
- `server/index.js:282`: an active session's language update calls `syncGates()`.

The same pattern applies after silence auto-close. An unchanged heartbeat can recreate streams even when no audio follows. TV and attendee clients send periodic HTTP pings; ordinary room join/leave and settings activity can also trigger synchronization. A WebSocket heartbeat does not always resync by itself; the confirmed recurring path is the HTTP ping/statistics path.

Impact: recurring configured streams after mic-off or silence while session status remains active. The application's comments claiming "$0 cost" and "0ms" shutdown overstate the guarantee.

Repair: persist server-side microphone/publisher authorization, separate desired language tracking from opening paid connections, and require an authorized active publisher plus fresh speech before opening a stream. A viewer heartbeat must never authorize spend.

### F2. High: End/Pause UI claims success before the server confirms it

Evidence: `public/admin.js:709-729` updates the local lifecycle UI before `fetch()`. End and Pause do not check `res.ok`; errors only produce console warnings. The admin statistics poll at `admin.js:1116` refreshes statistics, not lifecycle state.

An End request returning HTTP 500, reaching the wrong worker, or failing in transit can leave the browser saying ENDED while the server remains active. Local audio transmission stops because it checks the local status, but TV/attendee presence can continue reopening Soniox streams through F1.

End/Pause state setters do not stop microphone tracks or the AudioContext. Logout only removes local authentication and shows the modal (`admin.js:170`), without stopping capture. This creates inconsistent publisher state and surprising resume behavior.

Delete is better: it checks `res.ok` before refreshing the list. It still does not verify actual provider closure across processes.

Repair: stop local capture immediately on stop intent, explicitly report pending server shutdown, verify success/status, reconcile lifecycle after errors/reconnects, and do not display a billing-stop confirmation based solely on local UI state.

### F3. High: an old socket's close event can erase a newer live gate

Evidence:

- `sonioxService.js:857-890`: close marks a gate closed and deletes its map entry before the socket has closed.
- `sonioxService.js:451-454`: the old socket's close handler later unconditionally deletes by the same gate key.
- `sonioxService.js:333-381`: another synchronization can install a new gate under that key in between.

Reproduced order: close gate A; create/open gate B with the same session/language; receive A's delayed close event; the handler removes B's registration. B's socket is still open, but `closeSessionGates()` and `closeAllGates()` can no longer find it.

Impact: incorrect zero-gate reporting, concurrency undercount, missed stop cleanup, and possible duplicate streams. The untracked gate's own silence behavior and Soniox's timeout may eventually close it; this race is not evidence that it necessarily survives indefinitely after all audio stops.

Repair: compare object/socket generation identity before cleanup, track every socket through closing until confirmed closed or forcibly terminated, and count closing/connecting sockets in concurrency protection. Stop must enumerate the ownership registry, not just desired language entries.

### F4. High: shutdown is fire-and-forget and has no forced-termination deadline

Evidence: `sonioxService.js:875-890` sends `finalize`, sends an empty string, schedules `ws.close()` after 500ms, marks the gate closed, and deletes it immediately. Errors are discarded. `getStatus()` only counts remaining map entries.

The 500ms delay is not a provider completion acknowledgement. A close handshake may take longer, and exceptions or races are invisible. The `ws` library has its own close handling, but the application has no explicit tracked deadline and no final `terminate()` enforcement. End/Delete HTTP responses do not wait for local transport closure.

Repair: make stopping idempotent and awaitable; enter `closing`; send documented EOS; process completion independent of token contents; await close within a bounded grace period; terminate if necessary; cancel every timer; expose closing versus closed accurately. Provider accounting confirmation remains a separate observation.

### F5. High: paid streams can open before any microphone audio

Evidence: `server/index.js:657-691` starts/resumes a session and immediately synchronizes languages. `syncGates()` calls `ensureGate()` immediately; the socket open handler immediately sends the provider configuration (`sonioxService.js:398-405`).

This also affects text-only/demo use: the admin Simulation button first calls the normal start endpoint (`admin.js:757`), which can open Soniox streams although simulation does not require Soniox microphone recognition.

Repair: keep start/resume as session lifecycle operations, arm an explicit publisher separately, and open configured streams only on eligible audio. Keep demo/text injection paths out of paid audio startup. Buffer a small bounded speech pre-roll to avoid losing initial words.

### F6. High: remote control and audio publishing are not authenticated on the server

Evidence: start/resume/settings/ping endpoints have no authorization middleware; `/api/auth/verify` accepts any sufficiently long Bearer string (`server/index.js:537`); fallback PINs remain accepted (`:522`). WebSocket roles/session IDs are client claims (`:935-955`, `:984-1016`). Binary audio and `AUDIO_DATA` check active session status, not authenticated publisher ownership (`:956-978`, `:1107-1121`).

Someone with access to the deployment/session can start a session or inject audio without possessing the Soniox key. There is no evidence this has occurred, but this is a concrete spend-control vulnerability. CORS does not provide authentication.

Repair: real verified admin sessions, protected mutations, an authenticated publisher binding/lease, explicit room authorization, audio-rate/payload limits, and prevention of cross-room overrides. Public attendees may read and choose allowed languages without being allowed to publish microphone audio or start paid sessions.

### F7. Medium/High: independent processes cannot enforce a global stop

Evidence: sessions, gates, and validators are process-local Maps. `api/index.js` exports a server constructed inside a serverless entry point; `vercel.json` routes API and WebSocket requests there. There is no shared stream owner, worker routing, or cross-process stop channel.

A stop handled by process B cannot close a socket owned by process A. Local servers, previews, production, and abandoned development instances can also use the same key independently. A rewritten `/ws` URL is not evidence that the hosting platform supports a durable WebSocket server; deployment behavior must be verified against the actual host.

No second active deployment was proven in this audit. This is a strong investigation target for charges continuing after a confirmed stop on the instance visible to the operator.

Repair: initially use one dedicated persistent stream worker with explicit ownership; route all start/stop/audio operations to it. For multiple workers, use shared state, a lease/fencing mechanism, worker-directed shutdown, and a stop acknowledgement from the actual owner. Tag development, preview, and production separately.

### F8. Medium: languages remain billable after listeners leave

Evidence: `sessionManager.js:388` makes activation sticky; `:618` includes every sticky language in the required set. The set is not reset by the current start/end methods. Disconnecting a listener does not remove its language from that set.

This contradicts the service comment that gates close when listener count reaches zero. One participant cycling through several languages can leave multiple streams requested for later speech. The default TV language is always requested even without a TV. `zh` and `zh-TW` both map to Soniox `zh`, but separate gate keys create separate provider requests.

Repair: separate historical/backfill language availability from live stream demand; expire viewer presence; remove unused live gates after a short grace period; reset run demand; share the `zh` provider stream and convert locally for Traditional Chinese where appropriate. Reassess the always-on TV/default-English policy deliberately.

### F9. Medium: multi-session policy can cause repeated connection churn

Evidence: `ensureGate()` closes every other session's gates (`sonioxService.js:324-330`), but those other sessions remain `active`. Their next presence/audio synchronization may reopen their gates and close the first session's gates in return.

Impact: competing rooms repeatedly open/close streams, extra context setup, overlap during close, and disrupted captions. This is incompatible with the service header's full multi-session isolation claim.

Repair: choose one policy explicitly. For a single-broadcast prototype, reject/stop a previous publisher before activating another. For genuine multi-mosque support, keep independent owners and enforce a global provider capacity budget without destroying unrelated sessions.

### F10. Medium: VAD detects energy, not speech; no independent publisher lease

Evidence: `broadcastAudio()` classifies all RMS values above the fixed threshold as voice (`sonioxService.js:779-785`). Noise, feedback, a fan, or amplified audio can refresh timers continuously. The browser and server thresholds also differ, so browser-transmitted noise can exceed the server threshold.

The server socket close handler only removes a subscriber (`server/index.js:1140`); it does not revoke a producer or close its streams directly. Silence timers eventually help but can be counteracted by F1. The keepalive check runs every 5s, so a nominal 12s cutoff can occur around 15s after gate creation; timer scheduling is not an exact real-time guarantee.

Repair: publisher lease/heartbeat plus a bounded audio inactivity watchdog independent of viewer presence. Use calibrated speech VAD where justified, preserve a trailing audio window, and test mosque background noise. Treat VAD as an optimization, never the sole authority for spending.

### F11. Medium: reconnect and key changes bypass important lifecycle checks

Evidence: `connectGate()` checks operational/closing flags but not session activity or current gate identity (`sonioxService.js:385`). Its retry callback tests `activeGates.has(key)`, not whether that entry is still the same gate (`:480-484`). The open handler does not revalidate ownership before sending config/queued audio. `setApiKey()` does not close streams created with the previous key (`:167`). Validator exceptions return true (`:130`).

Normal End/Delete cleanup cancels tracked retries, so absence of revalidation alone does not demonstrate a normal stopped session reconnecting. It is a defense gap when state changes, timers race, ownership changes, or integration code omits cleanup.

Repair: fail closed; validate session, microphone lease, generation, key generation, and registry identity before connect/open/retry/audio flush. Key removal/rotation must revoke and drain old streams, not only change future configuration.

### F12. Medium: completion handling and tests give false confidence

Evidence: `onSonioxMessage()` returns on empty tokens before checking `finished` (`sonioxService.js:549-550`, `:592`). The test files replace `connectGate()` with a plain object that never emits asynchronous socket close/open/error events. The lifecycle audit treats a zero Map size as "$0 cost" and never waits for the actual silence cutoff.

The existing tests pass without testing the real timer installation, close handshake, provider completion, old socket races, heartbeat reopening, or other workers. Their "100% cost gates verified" message is not supported by what they measure.

Repair: injectable socket transport and clock; exercise the actual lifecycle implementation with an EventEmitter-compatible fake and a local WebSocket test server. Verify transport closure and absence of future opens after all queued events, not just Map deletion.

### F13. Medium: no auditable spending ledger or independent hard limit

Evidence: `buildConfig()` has no `client_reference_id`; status has no stream IDs, cumulative duration, byte counts, owner, close acknowledgements, or reconciled cost. There is no app-level maximum session duration, rolling connection-attempt budget, or spend circuit breaker. Concurrency uses only a Map size and an unvalidated environment integer.

Repair: per-stream attribution, append-only lifecycle records, bounded duration/retries/concurrency, validated configuration, and independent provider project/org usage limits. Do not equate quota failures with billed usage; provider docs say invalid/rejected-before-start requests are not counted in usage summaries.

## 5. Reproduced Results

The in-memory harness intercepted `require('ws')`, supplied fake sockets and timers, and used a fake key. It did not load the production server or initiate network connections.

| Check | Observed result | Interpretation |
| --- | --- | --- |
| Synchronize active-session languages before audio | Socket open sends configuration with no audio received | Startup/demand can initiate streams without speech |
| Call mic-off on an open gate | Map becomes empty while fake socket remains OPEN pending the scheduled close | Local zero count is not transport closure |
| Synchronize the same language after mic-off | A new gate and connection are created without audio | Mic-off does not block later reopening |
| Close old gate after replacement opens | Replacement removed from Map; replacement socket remains OPEN and close-all misses it | Identity/ownership cleanup race |
| Deliver `tokens: [], finished: true` | Handler returns without closing/marking finished | Normal completion shape is ignored |
| Schedule retry, then make validator report inactive | Retry constructs a new socket | Retry lacks independent session revalidation |

These tests deliberately demonstrated defects rather than changing behavior. They do not claim that the normal end lifecycle was bypassed in every scenario or that provider cost was measured.

## 6. Account Investigation and Immediate Containment

Recommended operational steps below were NOT performed by this audit.

1. Record an incident window in UTC: session ID, Start click, microphone-off click, End/Delete click, HTTP response status, server process/deployment, and subsequent balance changes. Avoid relying on the local ENDED badge alone.
2. Inspect Soniox project Usage > Activity and organization activity. Check current and historical STT concurrency. Zero local gates with nonzero provider activity indicates an untracked socket or another owner/key consumer, subject to dashboard refresh behavior.
3. Collect completed request usage logs for that window, including UUID, model, start/end, duration, tokens, cost, and project. Separate API from playground usage. Do not assume a missing completion log means no live request.
4. Inventory every key consumer: local Node processes, remote server instances, preview/production deployments, scripts, console playgrounds, other applications, and other project members. Use separate project credentials for future attribution.
5. For unwanted ongoing spend, disable Soniox in every known deployment and stop/restart the owning processes deliberately. Revoke an exposed/shared old key if necessary and verify activity falls; do not assume revocation alone guarantees immediate termination of already-authenticated streams without checking provider behavior.
6. Set conservative project and organization usage limits plus email alerts before further testing. Account limits can have propagation delay/overrun; use margin below the maximum tolerable spend.
7. Reconcile request start/end times, not only the time a balance changes. A request ending before the recorded shutdown with cost appearing later supports posting/aggregation behavior, not new post-stop processing.
8. If a request starts after confirmed shutdown on every known owner, isolate with a newly created, restricted project/key used only by one audited worker. A replacement key within a still-shared project is weaker evidence because project usage can include other keys.
9. If unexplained billed duration remains after isolation, send Soniox support the UUIDs, UTC timeline, model, charged tokens/duration, lifecycle evidence, and relevant project ID. Ask for server-side request termination and accounting timestamps. Never send the secret key or assume a public status page resolves an invoice dispute.

Evidence that would support a provider issue: a reproducible charge inconsistent with the documented token/duration accounting after isolated requests and confirmed transport closure, or provider-side request duration materially exceeding the transport timeline with no other key consumers. Request-level records are necessary to distinguish this from delayed posting or hidden streams.

## 7. Implementation Plan

All phases below are proposed, not implemented. Complete the spend/lifecycle correctness work before optimizing translation architecture.

### Phase 1: Make stop authoritative and connection ownership correct

Target files: `server/services/sonioxService.js`, `server/sessionManager.js`, `server/index.js`.

1. Introduce explicit server-owned publisher/microphone state, separate from session `status`. Assign a run/publisher generation. A disabled publisher cannot be re-enabled by attendee presence, language activation, retry, or queued audio.
2. Centralize eligibility: active session, authenticated live publisher, valid lease, fresh eligible audio, service enabled, valid generation, and capacity available. Enforce at gate creation, retry, socket open, and audio flush. Validator exceptions deny eligibility.
3. Make language synchronization update desired demand without opening a paid stream on its own. First eligible speech opens required streams; retain a bounded pre-roll rather than opening streams when Start is clicked.
4. Replace delete-before-close with tracked lifecycle states: connecting, open, closing, closed. Maintain per-socket identity until terminal closure; only remove a language entry if it still refers to the same generation. Global shutdown must include all owned sockets, including superseded/closing ones.
5. Make end/pause/delete/mic-off idempotently revoke the publisher generation first, then drain/close all owned streams. Use canonical IDs consistently. Cleanup must not depend on `isConfigured()` still being true.
6. Handle `finished` and errors before token-specific parsing. Send documented empty text EOS; allow bounded final-result drain; close transport; force `terminate()` on deadline. Return shutdown completion/pending/error accurately rather than asserting zero billing at request submission.
7. Cancel retries, removal timers, inactivity timers, emit timers, and close deadlines on terminal cleanup. A delayed callback must not operate on a replacement generation. Key changes and service disabling drain old-key connections.

Acceptance: mic-off/end/delete followed by arbitrary viewer pings and queued callbacks creates zero new configured provider requests until explicit authorized reactivation with fresh audio. Every created socket has a terminal event or forced termination; late old events never remove new ownership.

### Phase 2: Make browser controls and publisher lifetime truthful

Target files: `public/admin.js`, server publisher handlers.

1. Stop/disconnect microphone processing, tracks, speech recognition, and AudioContext on stop intent/logout and terminal lifecycle transitions. Make repeated stop safe and bind pending `getUserMedia()` completion to the current generation so it cannot revive a cancelled microphone.
2. Show stopping/pending/failed state until the server confirms. Check HTTP status and structured response; after reconnect poll server lifecycle and publisher state, not only attendance statistics.
3. Add a publisher lease renewed only by the authorized publisher, independent of attendee pings. Revoke it on disconnect after a short deliberate grace period and on lease expiry after network loss. Browser pagehide/beacon can assist but must not be the only guarantee.
4. Preserve pause/resume UX through explicit capture reactivation rules. Text/demo session start must not arm a paid microphone stream.

Acceptance: failed End cannot leave a falsely confirmed stop; abandoned admin pages expire their provider streams even while TVs stay connected.

### Phase 3: Enforce authorization and bounded demand

Target files: authentication/mutation/WebSocket handlers in `server/index.js`, demand logic in `server/sessionManager.js`, Soniox gate admission.

1. Replace fake token acceptance and hardcoded alternate PIN bypasses with verified admin sessions. Protect start/resume/end/delete/settings and publisher activation. Bind audio to an authenticated session/publisher rather than trusting `role` or a message-supplied session ID.
2. Permit public viewer presence without granting stream-start or publisher permissions. Validate requested languages and limit language-switch/request rates and payload sizes.
3. Split sticky historical translation availability from current live demand. Expire disconnected viewers, close unused languages after a bounded grace period, reset run demand, and deduplicate provider-equivalent language targets.
4. Decide single-live-session versus multiple independent mosques. Reject conflicting single-session starts, or implement isolated multi-room capacity scheduling; do not let each room silently destroy/reopen the other's sockets.
5. Validate concurrency configuration as a bounded positive integer. Count connecting and closing requests; cap duration, attempts per time window, and buffered audio. Trip a circuit breaker on repeated starts without useful audio or excessive estimated duration.

Acceptance: a public attendee cannot start/publish a paid stream; disconnected historical languages do not remain live; competing rooms cannot cause reconnect thrash.

### Phase 4: Establish deployment ownership and forensic visibility

Target files: server startup/shutdown, hosting configuration, Soniox config/status, structured logging, admin status.

1. Run the paid stream owner on a persistent supported runtime. For the prototype prefer one owner; if scaling, introduce shared ownership leases and worker-directed stop acknowledgements with fencing against stale workers.
2. Add SIGTERM/SIGINT and server shutdown draining. Do not rely on graceful handlers alone for abrupt termination; leases/provider timeouts remain necessary.
3. Attach `client_reference_id` with environment, deployment/worker, session/run, language, and stream generation within provider length limits. Never log API keys or authorization headers.
4. Record created/configured/first-audio/last-audio/EOS/provider-finished/transport-closed timestamps, close reason/code, bytes, publisher owner, retries, and accumulated duration. Persist useful incident records outside the live process.
5. Report open/connecting/closing counts separately and estimated accrued usage separately from reconciled provider cost. Replace unsupported "$0"/"0ms" claims. Reconcile provider UUIDs/tokens/cost; retain the provider pricing version used for estimates.
6. Use separate environment projects/keys and provider budgets. Add alerts for streams without publisher leases, prolonged closing, unexpected restart rate, and provider/local concurrency disagreement.

Acceptance: each provider request can be attributed to one deployment/run; an End command reaches its real owner; accounting and transport status can be investigated after a restart.

### Phase 5: Optional cost architecture evaluation

Only after lifecycle correctness, compare the existing one-stream-per-language model against one shared transcription stream plus server-side text translation. The latter reduces duplicated audio recognition but changes latency, translation cost, and quality; it is not a substitute for fixing stop logic. Fan out each chosen language result to all viewers rather than adding a stream per viewer. Preserve Arabic/source captions, languages, TV layout, and phone audio in either design.

## 8. Required Verification Matrix

Use fake sockets/clocks first, then a local WebSocket server; block external network access in normal tests. Inject transport/clock dependencies instead of replacing the lifecycle method under test.

| Scenario | Required invariant |
| --- | --- |
| Key configured, new process idle | No configured provider stream |
| Start without microphone; text/demo mode | No configured provider stream |
| Mic-off then viewer HTTP ping/join/leave/language switch | No reopened stream |
| Silence close followed by unchanged presence | Remains closed until eligible audio |
| End/delete during connecting/open/reconnecting/closing | Publisher revoked; no retry/flush; every socket terminal |
| Old socket closes after replacement opens | Replacement remains tracked and stoppable |
| Empty-token finished response | Completion recorded; no further keepalive/reconnect for that generation |
| Socket never acknowledges close | Forced termination within deadline; accurate pending state beforehand |
| Failed stop HTTP response/network loss | Browser reports pending/failure and reconciles; local mic stopped |
| Browser disappears but TVs keep pinging | Publisher lease expires; no new stream |
| Noise, quiet speech, pauses, continuous speech | Correct bounded behavior without clipping speech starts |
| Last viewer for a language leaves | Live demand expires; historical translations remain accessible |
| zh and zh-TW coexist | Shared provider stream if that optimization is enabled |
| Invalid key/balance/429/transient failure | Classified failures, bounded retries, no unauthenticated spend path |
| Unauthorized role/audio/start/cross-room message | Rejected before any provider connection |
| Key disabled/rotated; SIGTERM | Existing owned sockets drained, not just future connections disabled |
| Two workers receive audio/stop separately | Stop reaches owner; stale generations cannot reopen |
| Multiple sessions request capacity | Explicit policy enforced; no destructive oscillation |

After local checks pass, perform a deliberately short, budgeted staging trial in an isolated project. Capture UTC times and provider concurrency before/during/after. Stop while viewers remain open, verify no new requests, then reconcile completed usage logs. Include no-audio-after-stop observation long enough to cover viewer heartbeats and retry timers. This live billing check was not performed in the audit.

## 9. Priority and Release Criteria

Recommended order: containment/account evidence; Phase 1 connection ownership and mic-off gating; Phase 2 truthful stop/publisher lease; Phase 3 authorization/demand bounds; Phase 4 deployment attribution and reconciliation. Implement deterministic regressions alongside each phase, not after release.

Release blockers:

- A viewer ping can open a stream without authorized fresh audio.
- A late socket event can remove another socket's ownership.
- A stop reports completion while local transports are neither closed nor explicitly pending under a deadline.
- A worker that does not own the stream can report a globally completed shutdown.
- Normal CI can accidentally contact Soniox with production credentials.

Final incident attribution remains open until request-level provider evidence is reconciled. The confirmed application defects justify repairs now; they do not justify declaring Soniox fraudulent or declaring the account's billing correct without inspecting its records.

## 10. Sources

Public documentation accessed 2026-11-03:

- [Soniox pricing](https://soniox.com/pricing): token rates and approximate hourly equivalents.
- [Connection keepalive](https://soniox.com/docs/stt/rt/connection-keepalive): full-duration charging, keepalives, and timeout behavior.
- [Manual finalization](https://soniox.com/docs/stt/rt/manual-finalization): finalize does not end a stream; full-duration charging.
- [WebSocket API](https://soniox.com/docs/api-reference/stt/websocket-api): empty text EOS, finished response, reference IDs, errors, and authentication semantics.
- [Usage logs](https://soniox.com/docs/guides/usage-logs): per-request cost/timing and completed-request limitation.
- [Usage summary](https://soniox.com/docs/guides/usage-summary): API versus playground cost and rejected-before-start accounting.
- [Concurrency limits](https://soniox.com/docs/guides/concurrency-limits): live/historical project and organization activity.
- [Console limits](https://soniox.com/docs/console/limits): monthly budgets, alerts, and possible propagation overrun.
- [Console overview](https://soniox.com/docs/console): organization billing and project usage locations.
- [Public API status](https://status.soniox.com): operational status at audit time; not account-level billing evidence.
