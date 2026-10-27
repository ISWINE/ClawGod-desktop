#!/usr/bin/env node
// inspect-pe.js — PE 节表 / 证书 / .bun 布局检查器
// 用法: node inspect-pe.js <bun-standalone.exe>
"use strict";
const fs = require("fs");
const exe = process.argv[2];
if (!exe) { console.error("usage: node inspect-pe.js <exe>"); process.exit(1); }
const buf = fs.readFileSync(exe);
console.log("file size:", buf.length);
const peOff = buf.readUInt32LE(0x3c);
if (buf.toString("ascii", peOff, peOff + 4) !== "PE\0\0") { console.error("not a PE file"); process.exit(1); }
const numSect = buf.readUInt16LE(peOff + 6);
const optHdrSize = buf.readUInt16LE(peOff + 0x14);
const sectTable = peOff + 0x18 + optHdrSize;
let last = { end: 0, name: null };
for (let i = 0; i < numSect; i++) {
  const e = sectTable + i * 0x28;
  const name = buf.toString("ascii", e, e + 8).replace(/\0+$/, "");
  const virtSize = buf.readUInt32LE(e + 8);
  const virtAddr = buf.readUInt32LE(e + 0xc);
  const rawSize = buf.readUInt32LE(e + 0x10);
  const rawOff = buf.readUInt32LE(e + 0x14);
  const end = rawOff + rawSize;
  if (end > last.end) last = { end, name };
  console.log(`${name.padEnd(8)} vsize=0x${virtSize.toString(16)} vaddr=0x${virtAddr.toString(16)} rawsize=0x${rawSize.toString(16)} (${rawSize}) rawoff=0x${rawOff.toString(16)} end=${end}`);
}
console.log("last section end:", last.end, `(${last.name})`, " file end:", buf.length, " overlay bytes after sections:", buf.length - last.end);
const ddBase = peOff + 0x18 + 0x70;
const numDD = buf.readUInt32LE(peOff + 0x18 + 0x6c);
console.log("NumberOfRvaAndSizes:", numDD);
const certOff = buf.readUInt32LE(ddBase + 4 * 8);
const certSize = buf.readUInt32LE(ddBase + 4 * 8 + 4);
console.log("CertificateTable: offset=0x" + certOff.toString(16), "size=0x" + certSize.toString(16), certSize > 0 ? "(SIGNED - repack/modification invalidates it)" : "(no signature)");
console.log("PE CheckSum field: 0x" + buf.readUInt32LE(peOff + 0x18 + 0x40).toString(16));
for (let i = 0; i < numSect; i++) {
  const e = sectTable + i * 0x28;
  const name = buf.toString("ascii", e, e + 8).replace(/\0+$/, "");
  if (name === ".bun") {
    const rawOff = buf.readUInt32LE(e + 0x14), rawSize = buf.readUInt32LE(e + 0x10);
    const payloadSize = Number(buf.readBigUInt64LE(rawOff));
    console.log(`.bun: rawoff=0x${rawOff.toString(16)} rawsize=${rawSize} payload=${payloadSize} slack=${rawSize - 8 - payloadSize}`);
  }
}
