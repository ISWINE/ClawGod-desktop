#!/usr/bin/env node
/**
 * apply-fast.js — Node.js port of scripts/apply_localization.ps1 (DD05-SR/claude-desktop-zh-cn)
 *
 * Faithfully mirrors the PowerShell implementation in common.ps1 / apply_localization.ps1:
 *   - effective patches = patches/main-ui-patches.json + runtime-zh-CN.translations.json x 7 shapes
 *   - analyze: matched / alreadyPatched / required gate
 *   - missing translation scan (Test-VisibleEnglishText filters)
 *   - backup layout backups/<ts>/{root,ion,ion-overrides,statsig,assets} (compatible with rollback_localization.ps1)
 *   - takeown/icacls grants, locale artifact copies, sequential all-occurrence replace, .zst -> .zst.bak
 *   - apply-report.json + verification re-scan
 *
 * Usage:
 *   node apply-fast.js scan     # read-only compatibility check (diagnose_compatibility.ps1 equivalent)
 *   node apply-fast.js apply    # full apply (requires elevation)
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const PROJECT_ROOT = __dirname;

// ---------- helpers ----------

function log(msg) { process.stdout.write(msg + "\n"); }

function readUtf8Text(p) {
  let t = fs.readFileSync(p, "utf8");
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1); // strip BOM like .NET ReadAllText
  return t;
}

function writeUtf8Text(p, content) {
  fs.writeFileSync(p, content, "utf8"); // no BOM, mirrors UTF8Encoding($false)
}

function readJsonObject(p) { return JSON.parse(readUtf8Text(p)); }

function getValue(obj, key, dflt) {
  if (obj == null) return dflt;
  if (Array.isArray(obj) || typeof obj !== "object") {
    return (key in obj) ? obj[key] : dflt;
  }
  return (Object.prototype.hasOwnProperty.call(obj, key)) ? obj[key] : dflt;
}

/** Mirror of [Regex]::Unescape for the common cases used by patch texts. */
function regexUnescape(value) {
  if (typeof value !== "string") return value;
  return value.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\n\r\t\\'"0abfv])/g, (m, g) => {
    if (g[0] === "u" || g[0] === "x") return String.fromCharCode(parseInt(g.slice(1), 16));
    switch (g) {
      case "n": return "\n"; case "r": return "\r"; case "t": return "\t";
      case "0": return "\0"; case "a": return "\x07"; case "b": return "\b";
      case "f": return "\f"; case "v": return "\v";
      default: return g; // \\ \' \" -> literal char
    }
  });
}

function countLiteral(text, value) {
  if (!value) return 0;
  let count = 0, idx = 0;
  while ((idx = text.indexOf(value, idx)) !== -1) { count++; idx += value.length; }
  return count;
}

function replaceAll(text, find, replaceWith) {
  return text.split(find).join(replaceWith);
}

// ---------- config / install ----------

function getConfig() {
  return readJsonObject(path.join(PROJECT_ROOT, "config.json"));
}

function newClaudeInstallInfo(resourcesDir, version) {
  const resources = path.resolve(resourcesDir);
  const i18n = path.join(resources, "ion-dist", "i18n");
  return {
    version: version,
    resourcesDir: resources,
    appAsar: path.join(resources, "app.asar"),
    i18nDir: i18n,
    statsigDir: path.join(i18n, "statsig"),
    assetsDir: path.join(resources, "ion-dist", "assets", "v1"),
    rootLocale: path.join(resources, "zh-CN.json"),
    ionLocale: path.join(i18n, "zh-CN.json"),
    ionLocaleZst: path.join(i18n, "zh-CN.json.zst"),
    ionOverrides: path.join(i18n, "zh-CN.overrides.json"),
    ionOverridesZst: path.join(i18n, "zh-CN.overrides.json.zst"),
    statsigLocale: path.join(i18n, "statsig", "zh-CN.json"),
    statsigLocaleZst: path.join(i18n, "statsig", "zh-CN.json.zst"),
  };
}

function resolveClaudeInstall(config) {
  const discovery = getValue(config, "installDiscovery", {}) || {};
  const manualInstallRoot = getValue(discovery, "manualInstallRoot", null);
  if (manualInstallRoot) {
    const manual = newClaudeInstallInfo(manualInstallRoot, "manual");
    if (!(fs.existsSync(manual.appAsar) && fs.statSync(manual.appAsar).isFile())) {
      throw new Error("Manual Claude resources directory is incomplete (app.asar missing): " + manualInstallRoot);
    }
    if (!fs.existsSync(manual.i18nDir) || !fs.statSync(manual.i18nDir).isDirectory()) {
      throw new Error("Manual Claude resources directory is incomplete (i18n missing): " + manualInstallRoot);
    }
    if (!fs.existsSync(manual.assetsDir) || !fs.statSync(manual.assetsDir).isDirectory()) {
      throw new Error("Manual Claude resources directory is incomplete (assets missing): " + manualInstallRoot);
    }
    return manual;
  }
  throw new Error("No discovery method available; set installDiscovery.manualInstallRoot in config.json");
}

function getProjectArtifacts() {
  return {
    rootLocale: path.join(PROJECT_ROOT, "locales", "root-zh-CN.json"),
    ionLocale: path.join(PROJECT_ROOT, "locales", "ion-zh-CN.json"),
    ionLocaleZst: path.join(PROJECT_ROOT, "locales", "ion-zh-CN.json.zst"),
    ionOverrides: path.join(PROJECT_ROOT, "locales", "ion-zh-CN.overrides.json"),
    ionOverridesZst: path.join(PROJECT_ROOT, "locales", "ion-zh-CN.overrides.json.zst"),
    statsigLocale: path.join(PROJECT_ROOT, "locales", "statsig", "zh-CN.json"),
    statsigLocaleZst: path.join(PROJECT_ROOT, "locales", "statsig", "zh-CN.json.zst"),
    missingTranslations: path.join(PROJECT_ROOT, "locales", "missing-zh-CN.json"),
  };
}

function assertProjectArtifacts(artifacts) {
  for (const key of ["rootLocale", "ionLocale", "ionLocaleZst", "ionOverrides", "ionOverridesZst", "statsigLocale", "statsigLocaleZst"]) {
    if (!fs.existsSync(artifacts[key])) throw new Error("project artifact " + key + " missing: " + artifacts[key]);
  }
}

// ---------- patches ----------

function getPatches() { return readJsonObject(path.join(PROJECT_ROOT, "patches", "main-ui-patches.json")); }

function getRuntimeTranslations() { return readJsonObject(path.join(PROJECT_ROOT, "locales", "runtime-zh-CN.translations.json")); }

function newRuntimeTranslationPatches(translations) {
  const patches = [];
  const shapes = [
    { kind: "defaultMessage", prefix: 'defaultMessage:"', suffix: '"' },
    { kind: "label", prefix: 'label:"', suffix: '"' },
    { kind: "title", prefix: 'title:"', suffix: '"' },
    { kind: "cowork", prefix: 'cowork:"', suffix: '"' },
    { kind: "placeholder", prefix: 'placeholder:"', suffix: '"' },
    { kind: "aria-label", prefix: 'aria-label:"', suffix: '"' },
    { kind: "string", prefix: '"', suffix: '"' },
  ];
  const sources = Object.keys(translations).sort();
  for (const source of sources) {
    const target = translations[source];
    if (!source || !source.trim() || target == null || String(target).trim() === "") continue;
    for (const shape of shapes) {
      patches.push({
        description: "Runtime translation: " + source,
        kind: "runtime-translation",
        required: false,
        find: shape.prefix + source + shape.suffix,
        replace: shape.prefix + target + shape.suffix,
      });
    }
  }
  return patches;
}

function getEffectivePatches() {
  const base = getPatches();
  const runtime = newRuntimeTranslationPatches(getRuntimeTranslations());
  return base.concat(runtime);
}

// ---------- asset scanning ----------

function getAssetFiles(assetsDir) {
  const files = [];
  for (const ext of [".js", ".css"]) {
    for (const name of fs.readdirSync(assetsDir)) {
      const full = path.join(assetsDir, name);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.isFile() && path.extname(name).toLowerCase() === ext) files.push({ name, full });
    }
  }
  files.sort((a, b) => (a.full < b.full ? -1 : a.full > b.full ? 1 : 0));
  return files;
}

function analyzePatchHits(patches, assetFiles) {
  // Single pass over files, all patches checked in memory (mirrors Analyze-PatchHits results).
  const results = patches.map(p => ({
    description: getValue(p, "description", ""),
    kind: getValue(p, "kind", "runtime"),
    required: !!getValue(p, "required", false),
    find: getValue(p, "find"),
    replace: getValue(p, "replace"),
    matchedFiles: [], replacedFiles: [], totalHits: 0, totalReplacedHits: 0,
    matched: false, alreadyPatched: false,
  }));
  const cache = new Map(); // decoded find/replace per patch index
  patches.forEach((p, i) => {
    cache.set(i, { find: regexUnescape(p.find), replace: regexUnescape(p.replace) });
  });
  for (const file of assetFiles) {
    const text = readUtf8Text(file.full);
    for (let i = 0; i < patches.length; i++) {
      const { find, replace } = cache.get(i);
      const hits = countLiteral(text, find);
      const replacedHits = countLiteral(text, replace);
      if (hits > 0) {
        results[i].matchedFiles.push({ file: file.full, count: hits });
        results[i].totalHits += hits;
      }
      if (replacedHits > 0) {
        results[i].replacedFiles.push({ file: file.full, count: replacedHits });
        results[i].totalReplacedHits += replacedHits;
      }
    }
  }
  for (const r of results) {
    r.matched = r.totalHits > 0;
    r.alreadyPatched = r.totalHits === 0 && r.totalReplacedHits > 0;
  }
  return results;
}

function getRequiredPatchIssues(patchAnalysis) {
  const issues = [];
  for (const r of patchAnalysis) {
    if (r.required && !r.matched && !r.alreadyPatched) {
      issues.push("Required patch did not match and needs maintenance: " + r.description);
    }
  }
  return issues;
}

function getPatchTargetFiles(patchAnalysis) {
  const targets = new Set();
  for (const r of patchAnalysis) {
    for (const f of r.matchedFiles.concat(r.replacedFiles)) targets.add(f.file);
  }
  return [...targets];
}

function getCompressedAssetPath(assetPath) { return assetPath + ".zst"; }

// ---------- missing translation scan (Scan-MissingTranslations port) ----------

function testVisibleEnglishText(value, kind) {
  if (value == null || value.trim() === "") return false;
  if (/[\u4e00-\u9fff]/.test(value)) return false;
  if (value.length > 80) return false;
  if (!/[A-Za-z]/.test(value)) return false;
  if (/[{}%]/.test(value)) return false;
  if (/<[^>]+>/.test(value)) return false;
  if (/[\\/]|\.([A-Za-z0-9]{1,8})(\s|$)/.test(value)) return false;
  if (/^[A-Z0-9_./:-]+$/.test(value)) return false;
  if (/^[A-Za-z0-9_.:-]+$/.test(value) && /[_.:-]/.test(value)) return false;
  if (/\b(API|URL|URI|HTTP|HTTPS|JSON|JWT|OAuth|CORS|SDK|CLI|MCP|DOM|CSS|HTML|JS|TS|SQL|SCIM|HIPAA|CVC|UUID|ID)\b/i.test(value)) return false;
  if (/\b(Opus|Sonnet|Haiku|Gemini|Llama|Mistral|Bedrock|Vertex|Foundry|GPT|AWS|Azure|GCP)\b/i.test(value)) return false;
  if (/https?:\/\//i.test(value)) return false;
  if (/\bhttps\b/i.test(value)) return false;
  if (/^[0-9]+[dhms]$/i.test(value)) return false;
  if (/^(Sundays|Mondays|Tuesdays|Wednesdays|Thursdays|Fridays|Saturdays)$/i.test(value)) return false;
  if (/^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)$/i.test(value)) return false;
  if (/^(January|February|March|April|May|June|July|August|September|October|November|December)$/i.test(value)) return false;
  if (/^Aria label /i.test(value)) return false;
  if (/^MCP server /i.test(value)) return false;
  if (/^[a-z][a-z0-9-]*$/.test(value)) return false;
  if (/^[A-Za-z0-9]+(Route|Icon|Content|Layout|Provider|Context|Component|Props|State|Type|Code|List|Map)$/.test(value)) return false;
  if (/^[A-Za-z]+[A-Z][A-Za-z0-9]+$/.test(value) && !/\s/.test(value)) return false;
  if (["div","span","section","article","button","input","textarea","label","form","main","nav","header","footer","code"].includes(value)) return false;
  if (kind === "string") {
    if (!/\s/.test(value)) return false;
    if (/^[A-Z][a-z]+( [A-Z][a-z]+)*$/.test(value) && value.length < 18) return false;
    if (/\b(error|failed|loading|choose|select|create|delete|enable|disable|open|close|save|cancel|try|search|settings|session|task|folder|branch|workspace|privacy|notification|permission|account|message|conversation|schedule|routine|connect|install|update|review|payment|billing)\b/i.test(value)) return true;
    return false;
  }
  return true;
}

function scanMissingTranslations(assetsDir, outputPath, knownTranslations) {
  const seen = new Set();
  const items = [];
  const patterns = [
    { kind: "defaultMessage", regex: /defaultMessage:"([^"]+)"/g },
    { kind: "label", regex: /label:"([^"]+)"/g },
    { kind: "title", regex: /title:"([^"]+)"/g },
    { kind: "cowork", regex: /cowork:"([^"]+)"/g },
  ];
  for (const file of getAssetFiles(assetsDir)) {
    const text = readUtf8Text(file.full);
    for (const pattern of patterns) {
      pattern.regex.lastIndex = 0;
      let m;
      while ((m = pattern.regex.exec(text)) !== null) {
        const value = regexUnescape(m[1]);
        if (!testVisibleEnglishText(value, pattern.kind)) continue;
        if (Object.prototype.hasOwnProperty.call(knownTranslations, value)) continue;
        if (seen.has(value)) continue;
        seen.add(value);
        items.push({ text: value, translation: "", kind: pattern.kind, file: file.full });
      }
    }
    const bare = /"([A-Za-z][A-Za-z ]{2,60})"/g;
    let m;
    while ((m = bare.exec(text)) !== null) {
      const value = m[1];
      if (!testVisibleEnglishText(value, "string")) continue;
      if (Object.prototype.hasOwnProperty.call(knownTranslations, value)) continue;
      if (seen.has(value)) continue;
      seen.add(value);
      items.push({ text: value, translation: "", kind: "string", file: file.full });
    }
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(items, null, 2) + os.EOL, "utf8");
  return items;
}

// ---------- backup / permissions / copy (Grant-PathAccess, Copy-FileWithAccess ports) ----------

function isAdmin() {
  try { execFileSync("net", ["session"], { stdio: "ignore" }); return true; }
  catch { return false; }
}

let currentUserSid = null;
function getCurrentUserSid() {
  if (currentUserSid) return currentUserSid;
  const out = execFileSync("whoami", ["/user", "/fo", "list"], { encoding: "utf8" });
  const m = out.match(/SID:\s*(S-1-5-[^\s]+)/i);
  if (!m) throw new Error("Could not determine current user SID");
  currentUserSid = m[1];
  return currentUserSid;
}

const grantedPaths = new Set();

function runChecked(cmd, args, what) {
  try {
    execFileSync(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
  } catch (e) {
    throw new Error(what + " failed: " + cmd + " " + args.join(" ") + " :: " + (e.stderr ? e.stderr.toString().trim() : e.message));
  }
}

function grantPathAccess(p) {
  let target = p;
  if (!fs.existsSync(target)) target = path.dirname(p);
  if (!fs.existsSync(target)) throw new Error("Cannot locate permission target: " + p);
  const key = target;
  if (grantedPaths.has(key)) return;
  runChecked("takeown.exe", ["/F", target, "/A"], "takeown");
  const isDir = fs.statSync(target).isDirectory();
  const adminGrant = isDir ? "*S-1-5-32-544:(OI)(CI)F" : "*S-1-5-32-544:F";
  runChecked("icacls.exe", [target, "/grant", adminGrant, "/C"], "icacls");
  const userGrant = (isDir ? "*" + getCurrentUserSid() + ":(OI)(CI)F" : "*" + getCurrentUserSid() + ":F");
  runChecked("icacls.exe", [target, "/grant", userGrant, "/C"], "icacls");
  grantedPaths.add(key);
}

function setNormalAttributes(p) {
  try { fs.chmodSync(p, 0o666); } catch { /* ignore */ }
}

function backupFile(source, backupDir) {
  let st;
  try { st = fs.statSync(source); } catch { return; } // skip missing, mirrors Backup-File
  if (!st.isFile()) return;
  fs.mkdirSync(backupDir, { recursive: true });
  const dest = path.join(backupDir, path.basename(source));
  // Stream-style copy (read + write), mirroring PS File.OpenRead+CopyTo.
  // fs.copyFileSync (CopyFileW) additionally needs READ_CONTROL on WindowsApps
  // package files, which standard users lack -> UNKNOWN error.
  fs.writeFileSync(dest, fs.readFileSync(source));
  setNormalAttributes(dest);
}

function copyFileWithAccess(source, destination) {
  const parent = path.dirname(destination);
  if (parent) {
    if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true }); // e.g. i18n\statsig missing on newer builds
    grantPathAccess(parent);
  }
  if (fs.existsSync(destination)) {
    grantPathAccess(destination);
    setNormalAttributes(destination);
  }
  // Stream-style copy (read + write) instead of CopyFileW, see backupFile note.
  fs.writeFileSync(destination, fs.readFileSync(source));
  setNormalAttributes(destination);
}

// ---------- apply ----------

function timestamp() {
  const d = new Date();
  const p = (n, w) => String(n).padStart(w || 2, "0");
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function main() {
  const mode = process.argv[2] || "scan";
  log("[*] Mode: " + mode);
  log("[1/7] Loading config and detecting Claude Desktop...");
  const config = getConfig();
  const install = resolveClaudeInstall(config);
  const artifacts = getProjectArtifacts();
  assertProjectArtifacts(artifacts);
  log("      Version: " + install.version);
  log("      resources: " + install.resourcesDir);

  log("[2/7] Scanning runtime patch matches...");
  const patches = getEffectivePatches();
  const assetFiles = getAssetFiles(install.assetsDir);
  log("      Asset files: " + assetFiles.length + " (top-level js/css)");
  const patchAnalysis = analyzePatchHits(patches, assetFiles);
  const requiredIssues = getRequiredPatchIssues(patchAnalysis);
  const matched = patchAnalysis.filter(r => r.matched).length;
  const alreadyPatched = patchAnalysis.filter(r => r.alreadyPatched).length;
  const unmatched = patchAnalysis.filter(r => !r.matched && !r.alreadyPatched).length;
  log("      Effective patches: " + patches.length);
  log("      Matched: " + matched + "; already applied: " + alreadyPatched + "; unmatched: " + unmatched);

  if (mode === "scan") {
    const resourcesFound = fs.existsSync(install.resourcesDir);
    const i18nFound = fs.existsSync(install.i18nDir);
    const assetsFound = fs.existsSync(install.assetsDir);
    const requiredUnmatched = patchAnalysis.filter(r => r.required && !r.matched && !r.alreadyPatched).length;
    let recommendation = "APPLY_OK";
    if (!resourcesFound || !i18nFound || !assetsFound) recommendation = "UNSUPPORTED_STRUCTURE";
    else if (requiredUnmatched > 0) recommendation = "NEEDS_MAINTENANCE";
    log("---- compatibility report ----");
    log("Version: " + install.version);
    log("Resources: " + install.resourcesDir);
    log("Resources found: " + resourcesFound);
    log("I18n found: " + i18nFound);
    log("Assets found: " + assetsFound);
    log("Asset files: " + assetFiles.length);
    log("Patch matches: " + matched);
    log("Already applied: " + alreadyPatched);
    log("Unmatched patches: " + unmatched);
    log("Required unmatched: " + requiredUnmatched);
    log("Recommendation: " + recommendation);
    if (recommendation === "APPLY_OK") { log("This version looks compatible enough to apply."); process.exit(0); }
    log("This version needs maintenance before applying.");
    process.exit(1);
  }

  if (mode !== "apply") { log("Unknown mode: " + mode); process.exit(2); }

  if (requiredIssues.length > 0) {
    for (const issue of requiredIssues) log("      - " + issue);
    throw new Error("Required patch did not match. This Claude version needs maintenance before applying.");
  }

  log("[3/7] Generating missing translation list...");
  const missing = scanMissingTranslations(install.assetsDir, artifacts.missingTranslations, getRuntimeTranslations());
  log("      English candidates: " + missing.length);
  log("      List: " + artifacts.missingTranslations);

  if (!isAdmin()) {
    throw new Error("Elevation required: re-run this script from an elevated (administrator) PowerShell.");
  }
  log("      Elevated: yes");

  log("[4/7] Creating backup...");
  const runDir = path.join(PROJECT_ROOT, "backups", timestamp());
  const entries = [
    { source: install.rootLocale, dir: "root" },
    { source: install.ionLocale, dir: "ion" },
    { source: install.ionLocaleZst, dir: "ion" },
    { source: install.ionOverrides, dir: "ion-overrides" },
    { source: install.ionOverridesZst, dir: "ion-overrides" },
    { source: install.statsigLocale, dir: "statsig" },
    { source: install.statsigLocaleZst, dir: "statsig" },
  ];
  for (const entry of entries) backupFile(entry.source, path.join(runDir, entry.dir));
  const patchTargets = getPatchTargetFiles(patchAnalysis);
  for (const assetPath of patchTargets) {
    backupFile(assetPath, path.join(runDir, "assets"));
    backupFile(getCompressedAssetPath(assetPath), path.join(runDir, "assets"));
  }
  log("      Backup directory: " + runDir);

  log("[5/7] Requesting write permissions...");
  for (const p of [install.resourcesDir, install.i18nDir, install.statsigDir, install.assetsDir]) grantPathAccess(p);
  for (const assetPath of patchTargets) {
    grantPathAccess(assetPath);
    const compressed = getCompressedAssetPath(assetPath);
    if (fs.existsSync(compressed)) grantPathAccess(compressed);
  }

  log("[6/7] Copying zh-CN resources and applying runtime patches...");
  copyFileWithAccess(artifacts.rootLocale, install.rootLocale);
  copyFileWithAccess(artifacts.ionLocale, install.ionLocale);
  copyFileWithAccess(artifacts.ionLocaleZst, install.ionLocaleZst);
  copyFileWithAccess(artifacts.ionOverrides, install.ionOverrides);
  copyFileWithAccess(artifacts.ionOverridesZst, install.ionOverridesZst);
  copyFileWithAccess(artifacts.statsigLocale, install.statsigLocale);
  copyFileWithAccess(artifacts.statsigLocaleZst, install.statsigLocaleZst);

  const decoded = patches.map(p => ({ find: regexUnescape(p.find), replace: regexUnescape(p.replace) }));
  const fileReport = [];
  let totalChanges = 0;
  for (const assetPath of patchTargets) {
    let text = readUtf8Text(assetPath);
    const changes = [];
    for (let i = 0; i < patches.length; i++) {
      const { find, replace } = decoded[i];
      if (find === replace) continue;
      const count = countLiteral(text, find);
      if (count > 0) {
        text = replaceAll(text, find, replace);
        changes.push({ description: patches[i].description, count });
        totalChanges += count;
      }
    }
    if (changes.length > 0) {
      writeUtf8Text(assetPath, text);
      fileReport.push({ file: assetPath, changes });
      const compressed = getCompressedAssetPath(assetPath);
      if (fs.existsSync(compressed)) {
        fs.renameSync(compressed, path.join(path.dirname(compressed), path.basename(compressed) + ".bak"));
      }
    }
  }
  log("      Patched files: " + fileReport.length + " (total replacements: " + totalChanges + ")");

  const report = {
    install: { version: install.version, resourcesDir: install.resourcesDir, assetsDir: install.assetsDir },
    summary: {
      totalPatches: patches.length,
      matchedPatches: matched,
      alreadyPatchedPatches: alreadyPatched,
      unmatchedPatches: unmatched,
      missingTranslationCandidates: missing.length,
      patchedFiles: fileReport.length,
      totalReplacements: totalChanges,
    },
    patches: patchAnalysis.map(r => ({
      description: r.description, kind: r.kind, required: r.required,
      matched: r.matched, alreadyPatched: r.alreadyPatched,
      totalHits: r.totalHits, totalReplacedHits: r.totalReplacedHits,
      files: r.matchedFiles, replacedFiles: r.replacedFiles,
    })),
    files: fileReport,
    missingTranslations: artifacts.missingTranslations,
    backupDirectory: runDir,
  };
  fs.writeFileSync(path.join(runDir, "apply-report.json"), JSON.stringify(report, null, 2) + os.EOL, "utf8");

  log("[7/7] Running verification...");
  const verifyAnalysis = analyzePatchHits(patches, getAssetFiles(install.assetsDir));
  const verifyIssues = getRequiredPatchIssues(verifyAnalysis);
  const nowMatched = verifyAnalysis.filter(r => r.matched).length;
  const nowAlready = verifyAnalysis.filter(r => r.alreadyPatched).length;
  log("      Post-apply: matched " + nowMatched + ", already-applied " + nowAlready);
  if (verifyIssues.length > 0) {
    for (const issue of verifyIssues) log(" - " + issue);
    log("Apply completed, but verification found issues.");
    process.exit(1);
  }
  log("Localization applied.");
  log("Backup directory: " + runDir);
  log("Missing translation list: " + artifacts.missingTranslations);
  process.exit(0);
}

try {
  main();
} catch (e) {
  log("Apply failed: " + (e && e.message ? e.message : e));
  process.exit(1);
}
