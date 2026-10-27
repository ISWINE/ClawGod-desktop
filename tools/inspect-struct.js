#!/usr/bin/env node
// inspect-struct.js — __BUN Offsets 结构 / 模块表检查器
// 用法: node inspect-struct.js <bun-standalone.exe>
"use strict";
const fs = require("fs");
const exe = process.argv[2];
if (!exe) { console.error("usage: node inspect-struct.js <exe>"); process.exit(1); }
const buf = fs.readFileSync(exe);
const TRAILER = Buffer.from("\n---- Bun! ----\n");
const peOff = buf.readUInt32LE(0x3c);
const numSect = buf.readUInt16LE(peOff + 6);
const optHdrSize = buf.readUInt16LE(peOff + 0x14);
const sectTable = peOff + 0x18 + optHdrSize;
let bun = null;
for (let i = 0; i < numSect; i++) {
  const e = sectTable + i * 0x28;
  const name = buf.toString("ascii", e, e + 8).replace(/\0+$/, "");
  if (name === ".bun") bun = { rawOff: buf.readUInt32LE(e + 0x14), rawSize: buf.readUInt32LE(e + 0x10), vsize: buf.readUInt32LE(e + 8), vaddr: buf.readUInt32LE(e + 0xc) };
}
if (!bun) { console.error("no .bun section"); process.exit(1); }
const payloadSize = Number(buf.readBigUInt64LE(bun.rawOff));
const payload = buf.subarray(bun.rawOff + 8, bun.rawOff + 8 + payloadSize);
const start = payload.length - TRAILER.length - 32;
const struct = payload.subarray(start, start + 32);
console.log("offset struct 32B hex:", struct.toString("hex"));
console.log("  byte_count@+0(u64) =", Number(struct.readBigUInt64LE(0)));
console.log("  modules_offset@+8 =", struct.readUInt32LE(8), " modules_size@+12 =", struct.readUInt32LE(12), " (records:", struct.readUInt32LE(12) / 52 + ")");
console.log("  entry_point_id@+16 =", struct.readUInt32LE(16));
console.log("  compile_exec_argv@+20/24 =", struct.readUInt32LE(20), struct.readUInt32LE(24));
console.log("  flags@+28 = 0x" + struct.readUInt32LE(28).toString(16));
console.log("trailer ok:", payload.subarray(payload.length - TRAILER.length).equals(TRAILER));
const tableOff = struct.readUInt32LE(8), tableSize = struct.readUInt32LE(12);
const table = payload.subarray(tableOff, tableOff + tableSize);
let maxEnd = 0, minContent = Infinity, jsBc = 0;
const n = tableSize / 52;
for (let i = 0; i < n; i++) {
  const rec = table.subarray(i * 52, (i + 1) * 52);
  const nameOff = rec.readUInt32LE(0), nameSize = rec.readUInt32LE(4);
  const contentOff = rec.readUInt32LE(8), contentSize = rec.readUInt32LE(12);
  const bcOff = rec.readUInt32LE(24), bcLen = rec.readUInt32LE(28);
  const loader = rec.readUInt8(49);
  maxEnd = Math.max(maxEnd, contentOff + contentSize, nameOff + nameSize);
  if (contentSize > 0) minContent = Math.min(minContent, contentOff);
  if (bcLen > 0 && loader === 1) jsBc++;
}
console.log("payload len:", payload.length, " table region:", tableOff, "..", tableOff + tableSize);
console.log("max blob end (names+contents):", maxEnd, " min content off:", minContent);
console.log("js modules with bytecode:", jsBc, "/", n);
