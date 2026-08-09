# ZUI

**Fast. Reliable. Quality Preserved.**

ZUI is a custom binary container format (`.zui`) and a file-sharing platform
built around it: chunk-based, resumable, integrity-verified transfers between a
sender and a receiver, with a browser-based Codec Lab that proves the format
works.

## What ZUI actually is

- **A deterministic binary format** — `ZUI_SPEC.md` documents the exact byte
  layout: magic, versioned header, metadata, per-chunk SHA-256 table, payload,
  and integrity trailer.
- **A streaming codec** — `encodeZui`, `ZuiDecoder`, `inspectZui`, `verifyZui`,
  `reconstructZui`-style operations that never load a whole file into memory.
  Memory scales with the chunk size, not the file size.
- **Chunked, resumable transfer** — files travel as independently verified
  chunks (default 2 MiB). Interrupted uploads and downloads resume from
  completed chunks.
- **Proven integrity** — reconstruction is only reported as complete when
  `SHA-256(reconstructed) == SHA-256(original)`.
- **Compress → travel → enhance** — an optional transparent pipeline: the file
  is deflated (per chunk) before it travels, so less bytes cross the wire, and
  the receiver verifies and restores the exact original bytes.

### Honest claims

ZUI can truthfully say:

- Custom ZUI file format
- Chunk-based file transfer
- Resumable uploads and downloads
- Progressive file receiving
- Cryptographic integrity verification
- Original file reconstructed byte-for-byte

ZUI does **not** claim to:

- transfer a 59-minute video instantly (transfer time is bounded by file size,
  bandwidth, latency, and server speed)
- dramatically compress every video without quality loss (MP4/JPEG/PNG/HEIC
  are already compressed; lossless re-packaging does not shrink them)
- bypass internet bandwidth limits

## Repository layout

```
src/codec/    environment-agnostic ZUI v1 codec (Node + browser)
src/server/   Express transfer API, storage adapters, sessions, auth
src/shared/   shared constants and format helpers
src/web/      React web app (Codec Lab; sender/receiver pages)
tests/        unit + integration tests (codec, storage, API, security)
```

## Run it

```bash
npm install
npm run dev        # web (http://localhost:5173) + API (http://localhost:3000)
```

Open <http://localhost:5173/zui-lab> — the Codec Lab runs entirely in your
browser: pick a real file, encode it to `.zui`, inspect the chunk table, verify
the container, reconstruct the original, and confirm the SHA-256s match.

API-only:

```bash
npm start          # API on http://localhost:3000 (config via env, see .env.example)
```

## Verify

```bash
npm run test          # 80+ unit/integration tests
npm run typecheck     # strict TS on node + web projects
npm run lint          # eslint (src, tests)
```

## Documentation

- `ZUI_SPEC.md` — the binary format specification
- `ARCHITECTURE.md` / `SECURITY.md` / `API.md` / `DEPLOYMENT.md` — added with
  the respective phases

## Development phases

1. ✅ ZUI v1 format + codec + tests + Codec Lab
2. ✅ Transfer sessions, storage abstraction, chunk APIs, resumability
3. 🔜 Sender UI, receiver UI, sharing links, browser E2E
4. 🔜 Security hardening + production storage
5. 🔜 Performance optimization + production deployment
6. ⏸ Future: WebRTC/P2P (fallback to server transfer, never fake P2P)