/**
 * Fixture helpers that build REAL files (real container formats), so the
 * codec is exercised against genuine binary layout, not synthetic blobs.
 */

/** A minimal but structurally valid 1-page PDF. */
export function minimalPdf(): Uint8Array {
  const objects: string[] = [];
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  objects.push(
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>"
  );
  const stream = "BT /F1 24 Tf 72 720 Td (Hello, ZUI!) Tj ET";
  objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  const chunks: Uint8Array[] = [];
  const head = new TextEncoder().encode("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n");
  chunks.push(head);
  const offsets: number[] = [];
  let pos = head.byteLength;
  objects.forEach((body, i) => {
    offsets.push(pos);
    const part = new TextEncoder().encode(`${i + 1} 0 obj\n${body}\nendobj\n`);
    chunks.push(part);
    pos += part.byteLength;
  });
  const xrefPos = pos;
  const size = objects.length + 1;
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (const o of offsets) xref += `${String(o).padStart(10, "0")} 00000 n \n`;
  xref += `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  chunks.push(new TextEncoder().encode(xref));
  return Uint8Array.from(uncheckedConcat(chunks));
}

/** Minimal single-entry ZIP (STORE method, no compression) with a real CRC-32. */
function makeCrcTable(): number[] {
  const t = new Array<number>(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
}

function crc32(data: Uint8Array, table: number[]): number {
  let c = 0xffffffff;
  for (const b of data) c = (table[(c ^ b) & 0xff]! ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

export function makeZip(entryName: string, content: Uint8Array): Uint8Array {
  const table = makeCrcTable();
  const crc = crc32(content, table);
  const nameB = new TextEncoder().encode(entryName);
  const name = nameB.byteLength;
  const crcB = new DataView(new ArrayBuffer(4));
  crcB.setUint32(0, crc, true);
  const crcArr = new Uint8Array(crcB.buffer);

  const chunk = (b: Uint8Array): void => { parts.push(b); };
  const u16 = (v: number): void => {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, v, true);
    parts.push(b);
  };
  const u32 = (v: number): void => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v, true);
    parts.push(b);
  };
  const parts: Uint8Array[] = [];

  // local file header
  u32(0x04034b50);
  u16(20); u16(0); u16(0); u16(0); // version, flags, method(store)
  u16(0); u16(0); // time, date
  chunk(crcArr); u32(content.byteLength); u32(content.byteLength);
  u16(name); u16(0);
  chunk(nameB);
  chunk(content);
  const localLen = parts.reduce((s, p) => s + p.byteLength, 0);

  // central directory header
  u32(0x02014b50);
  u16(20); u16(20); u16(0); u16(0); u16(0); u16(0);
  u16(0); u16(0);
  chunk(crcArr); u32(content.byteLength); u32(content.byteLength);
  u16(name); u16(0); u16(0); u16(0); u16(0); u32(0);
  u32(0);
  chunk(nameB);

  const cdLength = parts.reduce((s, p) => s + p.byteLength, 0) - localLen;
  // end of central directory
  u32(0x06054b50);
  u16(0); u16(0); u16(1); u16(1);
  u32(cdLength); u32(localLen);
  u16(0);
  return Uint8Array.from(uncheckedConcat(parts));
}

function uncheckedConcat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}