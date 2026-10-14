# ZUI Files — Master Implementation Prompt

Paste this entire prompt into Sam's coding agent at the root of the existing ZUI repository. Begin implementation from the current files; do not create a replacement project, delete working code, or stop at a plan.

## Mission and non-negotiables
Improve the existing ZUI Files project into a secure, lossless, peer-to-peer file-transfer PWA. Preserve existing ZUI v1 codec, React/Vite frontend, streaming code, integrity checks, tests, and useful transfer features. Work incrementally on this branch, inspect the complete repository first, and report what is actually implemented.

Targets:
- 32 GB in 5 minutes; 64 GB in 10 minutes.
- Exact byte-for-byte reconstruction: no data loss, video quality change, or duration change.
- Strong documented encryption/privacy.
- Bounded memory and fair resource use for concurrent transfers.
- No mandatory paid infrastructure for basic direct transfers.
- Vercel free plan is **static PWA hosting only**. No Vercel Functions, file processing, payload proxy, upload/download routes, persistent workers, or required Vercel storage.

The speed goals are targets, not guarantees. Each requires about 107 MB/s / 853 Mbps sustained effective throughput. Measure actual performance, display honest ETA, and never fake results or progress.

## 1. Audit before editing
1. Inspect the repository tree, README, ZUI format specification, codec, server, storage adapters, frontend, configuration, deployment files and all tests.
2. Run baseline tests, typecheck, lint and build where possible; record failures.
3. Identify all file-payload paths through Express, server staging, cloud storage, or Vercel.
4. Reuse existing working code; avoid destructive rewrites and unrelated UI changes.
5. Never claim tests or load scenarios passed unless they were run.

## 2. Architecture and hosting
- Configure Vercel to serve only the built static PWA from the existing Vite app.
- Keep Express for local development or explicitly documented self-hosting if useful, but not as part of the Vercel free production data path.
- Implement direct browser-to-browser transfers using WebRTC DataChannels. File bytes must go between peers, not through Vercel or an application server.
- For the no-server path, create a short-lived invitation exchanged through QR code or copy/paste. Signaling must contain only connection metadata—not file bytes, plaintext, or secret keys.
- Public STUN can be a best-effort aid, with privacy and connectivity limitations documented. Some networks need TURN; relay traffic can cost money. Never silently enable paid relays or claim every network will support relay-free P2P.
- Any optional hosted signaling/relay must be disabled by default, replaceable and clearly documented.

## 3. Lossless transfer and integrity
- Use bounded file slices/streams; never load an entire multi-GB file into RAM.
- Keep the ZUI container format separate from the P2P transport protocol.
- Use deterministic chunk indexes/offsets, bounded workers and bounded in-flight bytes.
- Preserve source bytes exactly: no transcoding, lossy compression, metadata rewriting or mutation.
- Optional compression must be lossless and benchmark-driven; skip it if it increases size or slows transfer.
- Verify every received chunk before acknowledging it. Handle missing, duplicated, corrupt and out-of-order chunks.
- Reconstruct at exact offsets and compare final SHA-256 and byte count with the original before reporting completion.
- On mismatch, fail closed; never mark a corrupted file complete.
- Exact original bytes guarantee the video content is not re-encoded, so quality and duration remain unchanged.

## 4. Encryption and privacy
- Use WebRTC's standard authenticated DTLS transport encryption.
- Authenticate peers; a guessable transfer ID or QR alone must not authorize sensitive transfers.
- If adding application-level E2EE, use a reviewed protocol/library and authenticated key agreement. If AES-256-GCM is used, enforce unique nonces and correct key lifecycle. Do not invent cryptography.
- Never send plaintext payloads or encryption keys to Vercel, signaling, analytics, logs or crash reports.
- Minimize metadata exposure: filenames, sizes, MIME types and network information may still be visible.
- Validate message types, lengths, offsets, indexes, state and protocol version; protect against replay, unauthorized access and resource exhaustion.
- Keep secrets out of source control and browser bundles.
- Document threat model, trust assumptions, key lifecycle, dependency licences and limitations. Never call security “unbreakable”; describe exactly what is protected and what metadata remains visible.

## 5. Transfer engine and concurrency
Implement explicit states: created, waiting-for-peer, connecting, transferring, paused, verifying, completed, failed, cancelled.
- Chunk acknowledgements; retry only missing/corrupt chunks.
- Bounded in-flight data, backpressure and adaptive concurrency.
- Fair scheduling and isolation for independent transfers; no global lock that serializes all sessions.
- Cancellation, timeout handling, cleanup and pause/resume where browser support permits.
- Progress must count confirmed bytes, not queued bytes. Show measured throughput, elapsed time and honest ETA.
- Stream or use disk-backed reconstruction where supported; avoid huge Blob allocations and memory proportional to file size.
- Handle slow receivers, network interruption, browser storage limits and mobile Safari limitations.
- Retry transient errors with bounded exponential backoff and jitter.
- Never silently fall back to server uploads or paid storage/relay.
- Distinguish many separate P2P pairs from transfers competing on one device. Never promise unlimited concurrent users.

## 6. UI integration
Extend the existing UI, don't replace it. Add send/receive flow, QR/copy invitation, peer confirmation, connection status, file name/size, confirmed bytes, throughput, elapsed time, ETA, verification status, hash match, supported pause/resume/cancel, retry guidance, and clear browser/storage/network errors. Label whether a route is direct or relayed. Never show false encryption, completion or progress states.

## 7. Tests and benchmarks
Run available npm test, npm run typecheck, npm run lint, npm run build and browser E2E tests. Explain unavailable commands; never claim unrun tests passed.

Test empty/small/boundary/large files, final partial chunks, corrupt/missing/duplicate/out-of-order chunks, interrupted connections, retries, cancellation, supported resume, malformed messages, unauthorized peers, exact byte count and final SHA-256. Test invalid/expired invitations, replay attempts, malformed offsets/lengths and secret leakage into logs. Test simulated concurrency at 1/10/25/50/100 only if the environment can support it, clearly separating simulation from real browser-to-browser testing.

Every benchmark records device/browser, network bandwidth/latency, file size, chunk size, concurrency, route, setup time, transfer time, verify/save time, end-to-end time, throughput, CPU/RAM where measurable, retries and final integrity result. The 32 GB/5 minute and 64 GB/10 minute targets are accepted only under documented sufficient-throughput conditions. No fabricated metrics.

## 8. Required documentation and visuals
Create or update:
- ARCHITECTURE.md — components, control/data planes and static-only Vercel boundary.
- SECURITY.md — threat model, encryption, keys, metadata exposure, abuse protections and limitations.
- API.md — local/self-hosted APIs and optional signaling schemas, clearly separated from P2P.
- DEPLOYMENT.md — Vercel static deployment, local setup, optional self-hosting, environment variables, quotas and costs.
- PERFORMANCE.md — target calculations, benchmark method, actual results and bottlenecks.
- TESTING.md — commands, coverage, test matrix and actual results.
- ZUI_P2P_PROTOCOL.md — invitation, state machine, chunk framing, ACKs, retries, resume and versioning.
- docs/diagrams/architecture.mmd
- docs/diagrams/sender-receiver-sequence.mmd
- docs/diagrams/chunk-integrity.mmd
- docs/diagrams/encryption.mmd
- docs/diagrams/concurrency.mmd
- docs/diagrams/failure-recovery.mmd
- bench/ — reproducible benchmark scripts and raw machine-readable data.
- docs/reports/ — engineering report based on real test output.

Use editable Mermaid flowcharts/sequence diagrams. Generate charts from measured data for transfer time vs file size, throughput vs file size, concurrency vs throughput, concurrency vs latency, CPU/RAM vs concurrency, and retry/failure rate under impaired networks. A pie chart is allowed only when there is a real measured distribution (e.g. phase timings or route types). Include data and scripts. Until real measurements exist, mark charts “pending benchmark” or show explicitly labelled target lines—never invent slices, percentages or results.

## 9. Free and open source
Vercel is static PWA hosting only. The basic direct-transfer path must not require Vercel Functions, Vercel Blob, paid storage, paid processing servers or a mandatory TURN relay. Document that free tiers have limits and may change. Use an OSI-approved licence compatible with dependencies and include notices/attributions. Optional paid services must be off by default and clearly disclosed.

## 10. Implementation order and definition of done
1. Audit repository and record baseline.
2. Document architecture decisions and all payload routes.
3. Implement P2P invitation/connection state machine.
4. Connect existing streaming codec to WebRTC with bounded queues/backpressure.
5. Add integrity ACKs, retries and supported resumability.
6. Integrate UI and ensure Vercel static-only deployment.
7. Harden message validation and security boundaries.
8. Add tests, benchmark scripts, diagrams and charts.
9. Run tests/typecheck/lint/build; fix regressions.
10. Update README and deliver a report listing changed files, actual test results, measured performance, known gaps and optional costs.

Done means a supported browser can transfer directly to another supported browser, verify/reconstruct exact original bytes, show honest metrics and support concurrent sessions without unbounded memory; Vercel remains static-only and security claims match implementation. If any requirement cannot be completed, implement the safest useful part and clearly report the blocker and what remains unverified. Never weaken integrity, encryption or the hosting constraint to make a benchmark appear successful.
