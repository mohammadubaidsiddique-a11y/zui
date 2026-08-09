# ZUI v1 — Container Format Specification

**Status:** implemented (see `src/codec`)
**Version:** 1
**Magic:** `5A 55 49 01` ("ZUI" + 0x01)

ZUI v1 is a deterministic, streaming, chunk-based binary container. It stores a
single original file together with its metadata, a per-chunk hash table, and a
full integrity trail. The format never requires the whole file to be in memory:
all fields are laid out so a decoder can stream chunk-by-chunk.

All multi-byte integers are **big-endian**.

---

## 1. Byte layout (top level)

```
+---------------------------------+
| Fixed Prefix          (16 B)     |
| Header Block          (h bytes)  |
| Chunk Size Records    (4 B each) |
| Chunk Data            (var)      |
| Chunk Table / Trailer (var)      |
+---------------------------------+
```

```
+-----------------------------+
| Magic Bytes   (4 bytes)      |
+-----------------------------+
| Version       (2 bytes)      |
+-----------------------------+
| Flags         (2 bytes)      |
+-----------------------------+
| Header Length (8 bytes)      |
+-----------------------------+
| Header Block (length bytes)  |
+-----------------------------+
| Chunk Size Records ...       |
| Chunk Data ...               |
| Trailer: table + footer mark |
+-----------------------------+
```

### 1.1 Fixed prefix (16 bytes)

| Offset | Size | Field | Encoding | Meaning |
|--------|------|-------|----------|---------|
| 0      | 4    | magic | raw bytes | `5A 55 49 01` ("ZUI", 0x01) |
| 4      | 2    | version | u16 BE | must be `1` |
| 6      | 2    | flags  | u16 BE  | bit 0: `FLAG_COMPRESSED` |
| 8      | 8    | headerLength | u64 BE | byte length of the header block |

Valid `headerLength` range: `1..134_217_728` (128 MiB).

### 1.2 Flags

| Bit | Name | Meaning |
|-----|------|---------|
| 0   | `FLAG_COMPRESSED` | chunk data is `deflate-raw` compressed |

The flag must agree with the compression name stored in the header.

### 1.3 Header block (variable)

| Order | Size | Field | Encoding | Meaning |
|-------|------|-------|----------|---------|
| 1 | 4 | chunkSize | u32 BE | bytes of each full chunk (raw bytes) |
| 2 | 4 | chunkCount | u32 BE | number of chunks; `0` only if original is empty |
| 3 | 8 | origSize | u64 BE | original (uncompressed) file size |
| 4 | 32 | origSha256 | raw bytes | SHA-256 of the original file bytes |
| 5 | 2+N | fileName | u16 BE length + UTF-8 | original file name (≤ 1024 bytes) |
| 6 | 2+M | mimeType | u16 BE length + UTF-8 | MIME type (≤ 256 bytes) |
| 7 | 2+C | compression | u16 BE length + UTF-8 | `"none"` or `"deflate-raw"` |

Validation rules enforced by the decoder:

- `chunkSize > 0`
- `origSize` is a non-negative safe integer
- `chunkCount == 0` iff `origSize == 0`
- unknown compression names are rejected
- strings are UTF-8; malformed encodings are rejected

## 2. Payload (chunk records + chunk data)

For each chunk `i` from `0..chunkCount-1`:

```
+-----------------+----------------------------+
| storedSize u32BE | storedSize bytes of data   |
|  (4 B)          |  (compressed if flagged)    |
+-----------------+----------------------------+
```

Rules (decoder, chunk by chunk):

- `storedSize` must be in `1..536_870_912` (512 MiB)
- when compression is `"none"`, `storedSize` must equal the expected raw size
  (`rawSizeAt(origSize, chunkSize, i, chunkCount)`); for an empty file no chunks
  exist
- the raw (decompressed) size of each chunk must equal the expected raw size
- each chunk's stored bytes are hashed incrementally as they are read
- a truncated chunk body is an integrity error

## 3. Trailer (chunk table)

```
+-------------------+--------------------------------------------+
| tableLen  u32 BE  | tableLen = chunkCount * 40                 |
+-------------------+--------------------------------------------+
| entry 0 ... n-1   | per entry: size u64 BE (8B) + sha (32 raw) |
+-------------------+--------------------------------------------+
| TRAILER_MARK 4 B  | "ZTRE" (5A 54 52 45)                       |
+-------------------+--------------------------------------------+
```

Each table entry re-states the chunk's `storedSize` (u64 BE) and its SHA-256
(raw 32 bytes). On decode, every entry is compared against the hash computed
while streaming that chunk. After the mark, no trailing bytes may exist.

## 3. Compression

- `none`: stored bytes are the original bytes.
- `deflateRaw`: each chunk is compressed/decompressed in isolation with raw
  DEFLATE (RFC 1951). This is standard compression; it is **not** applied to
  already-compressed media unless requested, and ZUI never claims lossless
  compression of already-compressed formats (MP4/JPEG/PNG/...) yields size
  reductions.

Compressed chunks must still round-trip byte-for-byte (lossless).

## 4. Determinism

Given identical input bytes, options, and compression mode, encode output is
byte-identical (verified by test). No timestamps or entropy are embedded.

## 5. API (codec)

```
encodeZui(openSource, { fileName, mimeType, chunkSize, compression }, sink)
ZuiDecoder.open(source)            -> decoder
decoder.chunks()                    -> AsyncGenerator<DecodedChunk>
decoder.reconstruct()               -> AsyncGenerator<Uint8Array>
inspectZui(source)                  -> { header, chunks, trailerOk, containerBytes }
verifyZui(source)                   -> ZuiVerifyResult (never throws)
verifyZuiOrThrow(source)            -> ZuiVerifyResult
chunkCountFor(size, chunkSize)
rawSizeAt(size, chunkSize, index, chunkCount)
```

All buffer-consuming operations stream; memory scales with `chunkSize`, not
file size.

## 6. Error taxonomy

| Error | Meaning |
|-------|---------|
| `InvalidMagicError` | first 4 bytes are not the magic |
| `UnsupportedVersionError` | version != 1 |
| `HeaderCorruptError` | header block malformed or violates rules |
| `ContainerIntegrityError` | chunk/record/trailer mismatch, truncation, trailing bytes |
| `ChunkIntegrityError` | per-chunk hash mismatch |
| `OriginalIntegrityError` | reconstructed SHA-256 != header `origSha256` |
| `SourceReopenError` | the byte source could not be opened |

Reconstruction is only considered complete after the trailer matches and
`SHA-256(reconstructed) == origSha256`. Any mismatch is reported as an
integrity failure — success is never claimed otherwise.