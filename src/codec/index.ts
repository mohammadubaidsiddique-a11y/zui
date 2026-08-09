/**
 * ZUI v1 codec — public API.
 *
 * Environment-agnostic (Node + browser). Native acceleration is registered by
 * `./node-adapters` from Node entry points.
 */

export type { ByteSource, ByteSink } from "./streams";
export { BufferedReader, nodeStreamToSource, webStreamToSource } from "./streams";
export { createSha256, sha256Of, registerNativeSha256 } from "./sha256";
export type { HashLike } from "./sha256";
export {
  compressionSupported,
  compressChunk,
  decompressChunk,
  parseCompressionName,
  probeCompressible,
  registerNativeDeflater,
} from "./compress";
export type { CompressionMode } from "./compress";
export { registerFilePayloadStore, createPayloadStore } from "./payload";
export type { PayloadStore } from "./payload";
export { encodeZui, buildTrailer } from "./encode";
export type { ZuiEncodeOptions, ZuiEncodeResult, ChunkRecord } from "./encode";
export { ZuiDecoder, inspectZui, verifyZui, verifyZuiOrThrow } from "./decode";
export type { DecodedChunk, ZuiVerifyResult, ZuiInspectResult } from "./decode";
export { chunkCountFor, rawSizeAt, chunkStartByte } from "./plan";
export { MAGIC, FORMAT_VERSION, encodeFixedPrefix, encodeHeaderBlock, decodeHeaderBlock } from "./header";
export type { ZuiHeader, ZuiHeaderFields } from "./header";