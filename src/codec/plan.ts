/** Chunk planning helpers shared by codec, server and client. */

export function chunkCountFor(origSize: number, chunkSize: number): number {
  if (origSize === 0) return 0;
  return Math.ceil(origSize / chunkSize);
}

export function rawSizeAt(origSize: number, chunkSize: number, index: number, count: number): number {
  if (index < 0 || index >= count) throw new RangeError(`chunk index ${index} out of range 0..${count - 1}`);
  if (count === 0) return 0;
  if (index < count - 1) return chunkSize;
  return origSize - index * chunkSize;
}

export function chunkStartByte(origSize: number, chunkSize: number, index: number): number {
  return index * chunkSize;
}