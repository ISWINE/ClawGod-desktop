#!/usr/bin/env node
/**
 * repack.js — rebuild Claude's Bun standalone PE with patched module contents.
 *
 * Layout produced (all offsets relative to payload start):
 *   [original data region 0..oldDataEnd)        — preserved verbatim
 *       (names, contents, sourcemaps, bytecode, module_info, OLD table, chained records)
 *   [appended new contents for patched modules]
 *   [NEW module table (52B x N, patched records → appended contents, bytecode ptr zeroed)]
 *   [chained optional records copied verbatim from oldTableEnd..oldDataEnd]
 *   [Offsets struct 32B — byte_count/modules_ptr updated, rest preserved]
 *   [trailer "\n---- Bun! ----\n"]
 *
 * PE edits: .bun SizeOfRawData/VirtualSize grown, SizeOfImage updated,
 * certificate directory + overlay stripped, checksum zeroed.
 *
 * Usage: node repack.js <original.exe> <patched-scan-dir> <output.exe>
 */
"use strict";
const fs = require("fs");
const path = require("path");

const TRAILER = Buffer.from("\n---- Bun! ----\n");
const REC = 52, STRUCT = 32, OFF_STRUCT_SIZE = 32;
const FA_ALIGN = 0x200, SEC_ALIGN = 0x1000;

function die(m) { throw new Error(m); }
function readU64(buf, off) { const v = buf.readBigUInt64LE(off); if (v > BigInt(Number.MAX_SAFE_INTEGER)) die("u64 too big"); return Number(v); }

const [,, exePath, scanDir, outPath] = process.argv;
if (!exePath || !scanDir || !outPath) die("usage: node repack.js <exe> <scan-dir> <out>");

const buf = fs.readFileSync(exePath);
console.log("original size:", buf.length);

// ---- PE parse ----
const peOff = buf.readUInt32LE(0x3c);
if (buf.toString("ascii", peOff, peOff + 4) !== "PE\0\0") die("not PE");
const numSect = buf.readUInt16LE(peOff + 6);
const optHdr = peOff + 0x18;
const optSize = buf.readUInt16LE(peOff + 0x14);
const sectTable = peOff + 0x18 + optSize;
let bunEntry = -1;
for (let i = 0; i < numSect; i++) {
  const e = sectTable + i * 0x28;
  if (buf.toString("ascii", e, e + 8).replace(/\0+$/, "") === ".bun") { bunEntry = e; break; }
}
if (bunEntry < 0) die("no .bun section");
const bunRawOff = buf.readUInt32LE(bunEntry + 0x14);
const bunRawSize = buf.readUInt32LE(bunEntry + 0x10);
const bunVsize = buf.readUInt32LE(bunEntry + 8);
const bunVaddr = buf.readUInt32LE(bunEntry + 0xc);

// ---- payload parse ----
const payloadSize = readU64(buf, bunRawOff);
const payload = Buffer.from(buf.subarray(bunRawOff + 8, bunRawOff + 8 + payloadSize));
if (!payload.subarray(payload.length - TRAILER.length).equals(TRAILER)) die("trailer mismatch");
const sStart = payload.length - TRAILER.length - STRUCT;
const struct = Buffer.from(payload.subarray(sStart, sStart + STRUCT));
const byteCount = readU64(struct, 0); // data region size (everything before struct)
const oldTableOff = struct.readUInt32LE(8);
const tableSize = struct.readUInt32LE(12);
const entryId = struct.readUInt32LE(16);
const ceaOff = struct.readUInt32LE(20), ceaLen = struct.readUInt32LE(24);
const flags = struct.readUInt32LE(28);
const n = tableSize / REC;
if (tableSize % REC) die("table size not multiple of 52");
if (byteCount !== payload.length - STRUCT - TRAILER.length) die("byte_count mismatch: " + byteCount);
const oldDataEnd = byteCount;
const oldTableEnd = oldTableOff + tableSize;
const chained = Buffer.from(payload.subarray(oldTableEnd, oldDataEnd)); // optional records (flag bit order)
console.log(`payload=${payloadSize} modules=${n} entry=${entryId} flags=0x${flags.toString(16)} chained=${chained.length}B cea=(${ceaOff},${ceaLen})`);

// ---- records ----
const table = payload.subarray(oldTableOff, oldTableEnd);
const recs = [];
for (let i = 0; i < n; i++) {
  const r = table.subarray(i * REC, (i + 1) * REC);
  recs.push({
    nameOff: r.readUInt32LE(0), nameLen: r.readUInt32LE(4),
    cOff: r.readUInt32LE(8), cLen: r.readUInt32LE(12),
    smOff: r.readUInt32LE(16), smLen: r.readUInt32LE(20),
    bcOff: r.readUInt32LE(24), bcLen: r.readUInt32LE(28),
    miOff: r.readUInt32LE(32), miLen: r.readUInt32LE(36),
    bopOff: r.readUInt32LE(40), bopLen: r.readUInt32LE(44),
    enc: r.readUInt8(48), loader: r.readUInt8(49), fmt: r.readUInt8(50), side: r.readUInt8(51),
  });
}
const nameOf = (r) => payload.toString("utf8", r.nameOff, r.nameOff + r.nameLen).replace(/\0+$/, "");

// ---- patched content mapping ----
const pathMap = JSON.parse(fs.readFileSync(path.join(scanDir, "pathmap.json"), "utf8"));
const entryFile = path.join(scanDir, "cli.original.cjs");
const patched = []; // {idx, content}
let jsWithBytecode = 0;
for (let i = 0; i < n; i++) {
  const r = recs[i];
  const nm = nameOf(r).replaceAll("\\", "/");
  if (r.bcLen > 0 && r.loader === 1) jsWithBytecode++;
  let file = null;
  if (i === entryId) file = entryFile;
  else if (Object.prototype.hasOwnProperty.call(pathMap, nm)) file = path.join(scanDir, pathMap[nm]);
  if (!file || !fs.existsSync(file)) continue;
  const orig = payload.subarray(r.cOff, r.cOff + r.cLen);
  const now = fs.readFileSync(file);
  if (Buffer.compare(Buffer.from(orig), now) === 0) continue;
  // original must be strict UTF-8: Latin1/UTF-16 modules would be mangled by the
  // text round-trip (hljsBundle etc.) — keep original bytes for those.
  const origStrict = Buffer.from(orig.toString("utf8"), "utf8");
  if (Buffer.compare(origStrict, orig) !== 0) {
    console.log(`  SKIP non-utf8 module (kept original): ${nm} (${orig.length}B)`);
    continue;
  }
  const delta = now.length - orig.length;
  if (Math.abs(delta) > 65536 || now.length > orig.length + 65536) die(`suspicious delta for ${nm}: ${delta}`);
  // utf8 sanity (patched content must be strict-valid utf8)
  const strict = Buffer.from(now.toString("utf8"), "utf8");
  if (Buffer.compare(strict, now) !== 0) die(`non-utf8 roundtrip: ${nm}`);
  patched.push({ idx: i, name: nm, content: now, delta, hadBytecode: r.bcLen > 0 });
}
console.log(`patched modules: ${patched.length} (js modules w/ bytecode: ${jsWithBytecode})`);
for (const p of patched) console.log(`  #${p.idx} ${p.name}  ${p.delta >= 0 ? "+" : ""}${p.delta}B${p.hadBytecode ? " [HAD BYTECODE → zeroed]" : ""}`);

// ---- build new payload ----
const appended = [];
let appLen = 0;
for (const p of patched) {
  p.newOff = oldDataEnd + appLen;
  // appendCountZ contract: every module's contents are NUL-terminated in the payload
  appended.push(p.content, Buffer.from([0]));
  appLen += p.content.length + 1;
}
const newTable = Buffer.from(table); // copy
for (const p of patched) {
  const base = p.idx * REC;
  newTable.writeUInt32LE(p.newOff, base + 8);   // contents.off
  newTable.writeUInt32LE(p.content.length, base + 12); // contents.len
  newTable.writeUInt32LE(0, base + 24); newTable.writeUInt32LE(0, base + 28); // bytecode → none
  newTable.writeUInt32LE(0, base + 32); newTable.writeUInt32LE(0, base + 36); // module_info → none
  newTable.writeUInt32LE(0, base + 40); newTable.writeUInt32LE(0, base + 44); // bytecode_origin_path → none
}
// source_hashes chain: zero patched modules' hash slots (first chained record when bit5 set)
const chainedNew = Buffer.from(chained);
if (flags & (1 << 5)) {
  if (chained.length < n * 4) die("chained region too small for source hashes");
  for (const p of patched) chainedNew.writeUInt32LE(0, p.idx * 4);
}
const newTableOff = oldDataEnd + appLen;
const newDataEnd = newTableOff + tableSize + chained.length;
const newStruct = Buffer.from(struct);
newStruct.writeBigUInt64LE(BigInt(newDataEnd), 0);
newStruct.writeUInt32LE(newTableOff, 8);
newStruct.writeUInt32LE(tableSize, 12);
newStruct.writeUInt32LE(entryId, 16);
// cea (+20/+24): original values point into preserved region — keep
newStruct.writeUInt32LE(ceaOff, 20); newStruct.writeUInt32LE(ceaLen, 24);
newStruct.writeUInt32LE(flags, 28);
const newPayload = Buffer.concat([
  payload.subarray(0, oldDataEnd), ...appended, newTable, chainedNew, newStruct, TRAILER,
]);
const newSection = Buffer.alloc(Math.ceil((8 + newPayload.length) / FA_ALIGN) * FA_ALIGN);
newSection.writeBigUInt64LE(BigInt(newPayload.length), 0);
newPayload.copy(newSection, 8);
console.log(`new payload: ${newPayload.length} (+${newPayload.length - payload.length}), section: ${newSection.length} (was ${bunRawSize})`);
if (newSection.length <= bunRawSize) die("internal: new section unexpectedly smaller — use in-place path");

// ---- rebuild file ----
const out = Buffer.alloc(bunRawOff + newSection.length);
buf.copy(out, 0, 0, bunRawOff);
newSection.copy(out, bunRawOff);
out.writeUInt32LE(newSection.length, bunEntry + 0x10);                    // .bun SizeOfRawData
out.writeUInt32LE(Math.max(bunVsize, newSection.length), bunEntry + 8);   // VirtualSize
out.writeUInt32LE(0, optHdr + 0x40);                                      // checksum → 0
const dd = optHdr + 0x70;
out.writeUInt32LE(0, dd + 4 * 8); out.writeUInt32LE(0, dd + 4 * 8 + 4);   // certificate table → none
const newVsize2 = Math.max(bunVsize, newSection.length);
const sizeOfImage = (bunVaddr + newVsize2 + SEC_ALIGN - 1) & ~(SEC_ALIGN - 1);
out.writeUInt32LE(sizeOfImage, optHdr + 0x38);
fs.writeFileSync(outPath, out);
console.log("written:", outPath, out.length);

// ---- self verify: re-parse ----
{
  const b = fs.readFileSync(outPath);
  const pe = b.readUInt32LE(0x3c);
  const ns = b.readUInt16LE(pe + 6), os = b.readUInt16LE(pe + 0x14);
  const st = pe + 0x18 + os;
  let e2 = -1;
  for (let i = 0; i < ns; i++) { const e = st + i * 0x28; if (b.toString("ascii", e, e + 8).replace(/\0+$/, "") === ".bun") { e2 = e; break; } }
  const ro = b.readUInt32LE(e2 + 0x14), rs = b.readUInt32LE(e2 + 0x10);
  const ps = readU64(b, ro);
  const pl = b.subarray(ro + 8, ro + 8 + ps);
  if (!pl.subarray(pl.length - TRAILER.length).equals(TRAILER)) die("VERIFY: trailer");
  const ss = pl.length - TRAILER.length - STRUCT;
  if (readU64(pl, ss) !== ps - STRUCT - TRAILER.length) die("VERIFY: byte_count");
  const to = pl.readUInt32LE(ss + 8), ts = pl.readUInt32LE(ss + 12), eid = pl.readUInt32LE(ss + 16);
  if (ts / REC !== n || eid !== entryId) die("VERIFY: table/entry");
  const tb = pl.subarray(to, to + ts);
  let okPatch = 0;
  for (const p of patched) {
    const cOff = tb.readUInt32LE(p.idx * REC + 8), cLen = tb.readUInt32LE(p.idx * REC + 12);
    const got = pl.subarray(cOff, cOff + cLen);
    if (Buffer.compare(Buffer.from(got), p.content) === 0) okPatch++;
    else die("VERIFY: patched content mismatch #" + p.idx);
    if (tb.readUInt32LE(p.idx * REC + 24) !== 0 || tb.readUInt32LE(p.idx * REC + 28) !== 0) die("VERIFY: bytecode not zeroed");
  }
  // unpatched modules byte-identical
  let okOrig = 0;
  for (let i = 0; i < n; i++) {
    const co = tb.readUInt32LE(i * REC + 8), cl = tb.readUInt32LE(i * REC + 12);
    const o2 = recs[i];
    if (Buffer.compare(Buffer.from(pl.subarray(co, co + cl)), Buffer.from(payload.subarray(o2.cOff, o2.cOff + o2.cLen))) === 0) okOrig++;
  }
  console.log(`VERIFY ok: ${okPatch}/${patched.length} patched, ${okOrig}/${n} modules byte-identical to original`);
}
