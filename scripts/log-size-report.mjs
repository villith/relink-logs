/** Finds out WHY stored encounters grew, and whether the growth was worth it.
 *
 * Three questions, three sections:
 *
 *   jumps   When did per-event cost or event rate step up? A step on a given
 *           day is a code change on that day — take the date to `git log` and
 *           you have the commit that started storing more.
 *   audit   Inside each event type, which fields cost the bytes, and which
 *           look like they need not be stored at all (always null, constant,
 *           or a copy of a sibling field).
 *   save    What each candidate change is actually worth ON DISK. Findings are
 *           re-measured by rebuilding real blobs without the field and
 *           recompressing at the app's zstd level, because zstd already erases
 *           most raw-byte waste — a field that looks expensive uncompressed
 *           can be worth nearly nothing on disk, and only this section can
 *           tell the two apart.
 *
 * Usage:
 *   node scripts/log-size-report.mjs [--db <path>] [--jumps|--audit|--save]
 *
 * The database path comes from --db, then $RELINK_LOGS_DB, then a .env file at
 * the repo root. Nothing is hardcoded — logs.db lives wherever the app was run
 * from, which differs per machine.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import zlib, { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { cborReader, encodeFloat32, encodeHead, encodeText, isStructMap } from "./cbor.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_KEY = "RELINK_LOGS_DB";
const KB = 1024;
/** Matches `Encounter::to_blob`. A simulation compressed at any other level
 * would not be comparable to the stored blob it is measured against. */
const ZSTD_LEVEL = 3;

// ---------------------------------------------------------------- config ---

/** Parses the `KEY=value` subset of .env we need: comments, blank lines, and
 * optional surrounding quotes. No interpolation — a Windows path is a literal. */
export const parseEnv = (text) => {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (value.length > 1 && /^(".*"|'.*')$/.test(value)) value = value.slice(1, -1);
    out[trimmed.slice(0, eq).trim()] = value;
  }
  return out;
};

export const resolveDbPath = ({ flag, env = {}, envFile } = {}) => {
  if (flag) return flag;
  if (env[ENV_KEY]) return env[ENV_KEY];
  if (envFile && existsSync(envFile)) {
    const fromFile = parseEnv(readFileSync(envFile, "utf8"))[ENV_KEY];
    if (fromFile) return fromFile;
  }
  return null;
};

export const parseArgs = (argv) => {
  const opts = {
    db: null,
    minDuration: 60,
    minJump: 1.3,
    window: 5,
    auditLogs: 200,
    simLogs: 30,
    since: "7d",
    sections: new Set(),
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db") opts.db = argv[++i];
    else if (a === "--since") opts.since = argv[++i];
    else if (a === "--min-duration") opts.minDuration = Number(argv[++i]);
    else if (a === "--min-jump") opts.minJump = Number(argv[++i]);
    else if (a === "--window") opts.window = Number(argv[++i]);
    else if (a === "--audit-logs") opts.auditLogs = Number(argv[++i]);
    else if (a === "--sim-logs") opts.simLogs = Number(argv[++i]);
    else if (a === "--jumps") opts.sections.add("jumps");
    else if (a === "--audit") opts.sections.add("audit");
    else if (a === "--save") opts.sections.add("save");
    else if (a === "--json") opts.json = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!opts.sections.size) opts.sections = new Set(["jumps", "audit", "save"]);
  return opts;
};

/** `--since` accepts a date, a lookback like `14d`, or `all`. The lookback is
 * measured from the newest log in the database rather than from today, so the
 * report says the same thing whether it runs the day after a session or a
 * fortnight later. */
export const resolveSince = (spec, newestMs) => {
  if (!spec || spec === "all") return null;
  const rel = /^(\d+)d$/.exec(spec);
  if (rel) return newestMs - Number(rel[1]) * 86400000;
  const parsed = Date.parse(spec);
  if (Number.isNaN(parsed)) throw new Error(`--since wants YYYY-MM-DD, Nd, or all (got ${spec})`);
  return parsed;
};

// ------------------------------------------------------------- decoding ----

const dayKey = (ms) => new Date(Number(ms)).toISOString().slice(0, 10);

/** serde encodes a unit variant as a string and every other variant as a
 * single-key map, so both shapes name the variant. */
const variantName = (value) => {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1) return keys[0];
  }
  return "<unknown>";
};

/** Locates `rawEventLog` and calls `onEvent(name, startOffset, endOffset)` for
 * each element, leaving the cursor after the array. Returns per-field byte
 * totals for the encounter's top level. */
const walkEncounter = (raw, onEvent) => {
  const rd = cborReader(raw);
  if (raw[0] >> 5 !== 5) return null;
  const { count: keyCount, start } = rd.header(0);
  if (keyCount == null) return null;

  const fields = new Map();
  let found = false;
  rd.seek(start);
  for (let i = 0; i < keyCount; i++) {
    const key = rd.read();
    const fieldStart = rd.pos();
    rd.read();
    const fieldEnd = rd.pos();
    fields.set(key, (fields.get(key) ?? 0) + (fieldEnd - fieldStart));
    if (key !== "rawEventLog") continue;

    const arr = rd.header(fieldStart);
    if (arr.count == null) continue;
    found = true;
    rd.seek(arr.start);
    for (let e = 0; e < arr.count; e++) {
      const evStart = rd.pos();
      const pair = rd.read();
      onEvent(variantName(Array.isArray(pair) ? pair[1] : pair), evStart, rd.pos(), rd);
    }
    rd.seek(fieldEnd);
  }
  return found ? { fields } : null;
};

/** Per-variant byte and count totals for one decompressed encounter. */
export const summarizeBlob = (raw) => {
  const variants = new Map();
  const top = walkEncounter(raw, (name, from, to) => {
    const slot = variants.get(name) ?? { bytes: 0, count: 0 };
    slot.bytes += to - from;
    slot.count += 1;
    variants.set(name, slot);
  });
  if (!top) return null;
  return { variants, fields: top.fields, rawBytes: raw.length };
};

// ---------------------------------------------------------------- jumps ----

const weightedMean = (points) => {
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += p.value * p.weight;
    den += p.weight;
  }
  return den ? num / den : 0;
};

/** Step detection for a daily series. Compares the weighted mean of the `w`
 * days before each boundary with the `w` days at and after it, keeps the
 * boundaries whose ratio clears `minRatio`, then suppresses any weaker
 * boundary within `w` days of a stronger one so a single step is reported
 * once rather than smeared across its neighbours.
 *
 * Deliberately not a general changepoint algorithm: what we are looking for is
 * a deploy, which is a step, and a step is what this finds. */
export const detectJumps = (series, { minRatio = 1.3, w = 5 } = {}) => {
  const withData = series.filter((p) => p.weight > 0);
  if (withData.length < 3) return [];

  const candidates = [];
  for (let i = 1; i < withData.length; i++) {
    const before = weightedMean(withData.slice(Math.max(0, i - w), i));
    const after = weightedMean(withData.slice(i, i + w));
    if (before === 0 && after === 0) continue;
    const ratio = before === 0 ? Infinity : after / before;
    if (ratio >= minRatio || ratio <= 1 / minRatio) {
      candidates.push({
        index: i,
        day: withData[i].key,
        before,
        after,
        ratio,
        strength: before === 0 ? Infinity : Math.abs(Math.log(ratio)),
      });
    }
  }

  const accepted = [];
  for (const c of candidates.sort((a, b) => b.strength - a.strength)) {
    if (accepted.some((a) => Math.abs(a.index - c.index) < w)) continue;
    accepted.push(c);
  }
  return accepted.sort((a, b) => a.index - b.index);
};

/** Builds the two daily series that separate the two ways a log can grow:
 * bytes per event (the struct got fatter) and events per minute (we started
 * recording more of them). */
export const buildSeries = (records, variant) => {
  const days = new Map();
  for (const rec of records) {
    const d = days.get(rec.day) ?? { bytes: 0, count: 0, minutes: 0 };
    const slot = variant ? rec.summary.variants.get(variant) : null;
    if (variant) {
      d.bytes += slot?.bytes ?? 0;
      d.count += slot?.count ?? 0;
    } else {
      for (const s of rec.summary.variants.values()) {
        d.bytes += s.bytes;
        d.count += s.count;
      }
    }
    d.minutes += rec.durationSec / 60;
    days.set(rec.day, d);
  }
  const ordered = [...days].sort((a, b) => a[0].localeCompare(b[0]));
  return {
    bytesPerEvent: ordered.map(([key, d]) => ({ key, value: d.count ? d.bytes / d.count : 0, weight: d.count })),
    eventsPerMin: ordered.map(([key, d]) => ({ key, value: d.minutes ? d.count / d.minutes : 0, weight: d.minutes })),
  };
};

// ---------------------------------------------------------------- audit ----

/** Flattens one event's payload into dotted field paths, charging key-name
 * bytes separately from value bytes. Nested structs recurse; an enum value is
 * charged whole, because its shape varies per variant and a path per Rust
 * variant would be noise rather than a finding. */
const walkStruct = (rd, at, prefix, out) => {
  const { count, start } = rd.header(at);
  if (count == null) return;
  rd.seek(start);
  for (let i = 0; i < count; i++) {
    const kStart = rd.pos();
    const key = rd.read();
    const keyBytes = rd.pos() - kStart;
    const vStart = rd.pos();
    const val = rd.read();
    const after = rd.pos();
    const valueBytes = after - vStart;
    const p = prefix ? `${prefix}.${key}` : key;

    if (isStructMap(val)) {
      const kids = [];
      walkStruct(rd, vStart, p, kids);
      rd.seek(after);
      const kidBytes = kids.reduce((s, k) => s + k.keyBytes + k.valueBytes, 0);
      out.push({ path: p, keyBytes, valueBytes: valueBytes - kidBytes, value: undefined, container: true });
      out.push(...kids);
    } else {
      out.push({ path: p, keyBytes, valueBytes, value: val });
    }
  }
};

const isDefaultish = (v) => v === null || v === 0 || v === false || v === "" || (Array.isArray(v) && !v.length);

const newFieldStat = () => ({
  keyBytes: 0,
  valueBytes: 0,
  n: 0,
  nulls: 0,
  defaults: 0,
  distinct: new Set(),
  container: false,
});

/** Per-field statistics for each event type, plus pairs of fields that hold
 * the same value in the same event (Actor's parent fields are documented to
 * mirror index/actorType whenever there is no parent, so most events carry
 * each of those numbers twice). */
export const auditRecords = (records) => {
  const byVariant = new Map();

  for (const rec of records) {
    walkEncounter(rec.raw, (name, from, to, rd) => {
      const v = byVariant.get(name) ?? { count: 0, bytes: 0, fields: new Map(), pairs: new Map(), envelope: 0 };
      v.count += 1;
      v.bytes += to - from;
      byVariant.set(name, v);

      // pair = [timestamp, message]; descend to the message's payload map.
      rd.seek(from);
      const pairHeader = rd.header(from);
      if (pairHeader.count !== 2) return;
      rd.seek(pairHeader.start);
      rd.read(); // timestamp
      const msgAt = rd.pos();
      const msg = rd.read();
      if (typeof msg === "string") {
        v.envelope += to - from;
        return;
      }
      const msgHeader = rd.header(msgAt);
      if (msgHeader.count !== 1) return;
      rd.seek(msgHeader.start);
      rd.read(); // variant name
      const payloadAt = rd.pos();
      const payload = rd.read();
      if (!isStructMap(payload)) {
        v.envelope += to - from;
        return;
      }

      const flat = [];
      walkStruct(rd, payloadAt, "", flat);
      let charged = 0;
      const primitives = [];
      for (const f of flat) {
        charged += f.keyBytes + f.valueBytes;
        const stat = v.fields.get(f.path) ?? newFieldStat();
        stat.keyBytes += f.keyBytes;
        stat.valueBytes += f.valueBytes;
        stat.n += 1;
        if (f.container) stat.container = true;
        else {
          if (f.value === null) stat.nulls += 1;
          if (isDefaultish(f.value)) stat.defaults += 1;
          if (stat.distinct.size <= 64) stat.distinct.add(typeof f.value === "object" ? "<obj>" : f.value);
          if (typeof f.value === "number") primitives.push(f);
        }
        v.fields.set(f.path, stat);
      }
      v.envelope += to - from - charged;

      if (primitives.length <= 20) {
        for (let a = 0; a < primitives.length; a++) {
          for (let b = a + 1; b < primitives.length; b++) {
            const key = `${primitives[a].path}==${primitives[b].path}`;
            const slot = v.pairs.get(key) ?? { same: 0, n: 0, bytes: 0 };
            slot.n += 1;
            if (primitives[a].value === primitives[b].value) slot.same += 1;
            slot.bytes += primitives[b].keyBytes + primitives[b].valueBytes;
            v.pairs.set(key, slot);
          }
        }
      }
    });
  }
  return byVariant;
};

// ----------------------------------------------------------- simulation ----

/** Rebuilds an encounter blob under a policy, splicing original byte spans for
 * everything it keeps. `policy.dropVariants` removes whole event streams;
 * `policy.dropField(variant, path, value)` removes one field from every event;
 * `policy.renameField` shortens key names. */
export const rewriteEncounter = (raw, policy = {}) => {
  const rd = cborReader(raw);
  const slice = (a, b) => raw.subarray(a, b);

  const rewriteStruct = (at, variant, prefix, siblings) => {
    const { count, start } = rd.header(at);
    if (count == null) return slice(at, at);
    const saved = [];
    rd.seek(start);
    for (let i = 0; i < count; i++) {
      const kStart = rd.pos();
      const key = rd.read();
      const kEnd = rd.pos();
      const vStart = rd.pos();
      const val = rd.read();
      const after = rd.pos();
      const p = prefix ? `${prefix}.${key}` : key;

      if (policy.dropField?.(variant, p, val, siblings)) continue;
      const renamed = policy.renameField?.(variant, p);
      const keyBuf = renamed ? encodeText(renamed) : slice(kStart, kEnd);

      // 0xfa/0xfb are the CBOR float headers. Checking the byte rather than the
      // decoded value is what distinguishes a stored f32 from an integer that
      // merely round-trips through a JS number.
      let valBuf;
      const isFloat = raw[vStart] === 0xfa || raw[vStart] === 0xfb;
      const q = isFloat ? policy.quantize?.(variant, p, val) : undefined;
      const r = isFloat && q === undefined ? policy.roundFloat?.(variant, p, val) : undefined;
      if (q !== undefined) valBuf = q >= 0 ? encodeHead(0, q) : encodeHead(1, -1 - q);
      else if (r !== undefined) valBuf = encodeFloat32(r);
      else if (isStructMap(val)) valBuf = rewriteStruct(vStart, variant, p, val);
      else valBuf = slice(vStart, after);

      rd.seek(after);
      saved.push(keyBuf, valBuf);
    }
    rd.seek(at);
    rd.read();
    return Buffer.concat([encodeHead(5, saved.length / 2), ...saved]);
  };

  const rewriteEvent = (from, to, name) => {
    rd.seek(from);
    const pairHeader = rd.header(from);
    if (pairHeader.count !== 2) return slice(from, to);
    rd.seek(pairHeader.start);
    const tsStart = rd.pos();
    rd.read();
    const tsEnd = rd.pos();
    const msgAt = tsEnd;
    const msg = rd.read();
    if (typeof msg === "string") return slice(from, to);

    const msgHeader = rd.header(msgAt);
    if (msgHeader.count !== 1) return slice(from, to);
    rd.seek(msgHeader.start);
    const nameStart = rd.pos();
    rd.read();
    const nameEnd = rd.pos();
    const payloadAt = nameEnd;
    const payload = rd.read();
    if (!isStructMap(payload)) return slice(from, to);

    const body = rewriteStruct(payloadAt, name, "", payload);
    return Buffer.concat([encodeHead(4, 2), slice(tsStart, tsEnd), encodeHead(5, 1), slice(nameStart, nameEnd), body]);
  };

  const { count: keyCount, start } = rd.header(0);
  const out = [];
  rd.seek(start);
  for (let i = 0; i < keyCount; i++) {
    const kStart = rd.pos();
    const key = rd.read();
    const kEnd = rd.pos();
    const vStart = rd.pos();
    rd.read();
    const vEnd = rd.pos();

    if (key !== "rawEventLog") {
      out.push(slice(kStart, kEnd), slice(vStart, vEnd));
      continue;
    }
    const arr = rd.header(vStart);
    const events = [];
    rd.seek(arr.start);
    for (let e = 0; e < arr.count; e++) {
      const evStart = rd.pos();
      const pair = rd.read();
      const evEnd = rd.pos();
      const name = variantName(Array.isArray(pair) ? pair[1] : pair);
      if (policy.dropVariants?.has(name)) continue;
      if (policy.keepEvent && !policy.keepEvent(name, Array.isArray(pair) ? pair[0] : 0)) continue;
      events.push(rewriteEvent(evStart, evEnd, name));
      rd.seek(evEnd);
    }
    rd.seek(vEnd);
    out.push(slice(kStart, kEnd), encodeHead(4, events.length), ...events);
  }
  return Buffer.concat([encodeHead(5, keyCount), ...out]);
};

const compress = (buf) =>
  zstdCompressSync(buf, { params: { [zlib.constants.ZSTD_c_compressionLevel]: ZSTD_LEVEL } }).length;

// --------------------------------------------------------------- output ----

const pad = (v, w) => String(v).padStart(w);
const padr = (v, w) => String(v).padEnd(w);
const pct = (x) => `${(x * 100).toFixed(1)}%`;

const reportJumps = (records, opts) => {
  console.log("== JUMPS ==============================================================");
  console.log("A step on a date is a code change on that date. Two series per event");
  console.log("type: bytes/event (struct grew) and events/min (we record more).");
  console.log("");

  const totals = new Map();
  for (const rec of records) {
    for (const [name, slot] of rec.summary.variants) {
      const t = totals.get(name) ?? { bytes: 0, count: 0 };
      t.bytes += slot.bytes;
      t.count += slot.count;
      totals.set(name, t);
    }
  }
  const allBytes = [...totals.values()].reduce((s, t) => s + t.bytes, 0);
  const ranked = [...totals].sort((a, b) => b[1].bytes - a[1].bytes);

  const show = (label, series, unit) => {
    const jumps = detectJumps(series, { minRatio: opts.minJump, w: opts.window });
    if (!jumps.length) return false;
    for (const j of jumps) {
      const arrow = j.before === 0 ? "NEW" : `${j.ratio.toFixed(2)}x`;
      console.log(
        `  ${padr(j.day, 12)} ${padr(label, 22)} ${pad(j.before.toFixed(1), 9)} -> ${pad(j.after.toFixed(1), 9)} ${padr(unit, 12)} ${arrow}`
      );
    }
    return true;
  };

  const overall = buildSeries(records, null);
  show("ALL events", overall.bytesPerEvent, "bytes/event");
  show("ALL events", overall.eventsPerMin, "events/min");
  console.log("");

  for (const [name, t] of ranked) {
    if (t.bytes / allBytes < 0.002) continue;
    const s = buildSeries(records, name);
    const a = show(name, s.bytesPerEvent, "bytes/event");
    const b = show(name, s.eventsPerMin, "events/min");
    if (a || b) {
      console.log(`  ${padr("", 12)} ${padr("", 22)} (${pct(t.bytes / allBytes)} of all event bytes today)`);
      console.log("");
    }
  }
};

const reportAudit = (byVariant, opts) => {
  console.log("== FIELD AUDIT ========================================================");
  console.log(`Newest ${opts.auditLogs} logs, so a recently added field is not judged`);
  console.log("against logs written before it existed. Bytes are UNCOMPRESSED.");
  console.log("");

  const allBytes = [...byVariant.values()].reduce((s, v) => s + v.bytes, 0);
  const ranked = [...byVariant].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 6);

  for (const [name, v] of ranked) {
    if (!v.fields.size) continue;
    console.log(
      `${name} — ${pct(v.bytes / allBytes)} of event bytes, ${(v.bytes / v.count).toFixed(0)} B/event, ${v.count} events`
    );
    const keyTotal = [...v.fields.values()].reduce((s, f) => s + f.keyBytes, 0);
    console.log(
      `  ${padr("field", 26)} ${pad("B/evt", 7)} ${pad("key", 6)} ${pad("val", 6)} ${pad("uniq", 6)} ${pad("null", 7)}  note`
    );

    const fields = [...v.fields].sort((a, b) => b[1].keyBytes + b[1].valueBytes - (a[1].keyBytes + a[1].valueBytes));
    for (const [p, f] of fields) {
      const per = (f.keyBytes + f.valueBytes) / v.count;
      const uniq = f.distinct.size > 64 ? ">64" : String(f.distinct.size);
      const notes = [];
      if (f.container) notes.push("nested struct");
      else if (f.nulls === f.n) notes.push("ALWAYS NULL — never stored usefully");
      else if (f.distinct.size === 1) notes.push(`CONSTANT (${[...f.distinct][0]})`);
      else if (f.nulls / f.n > 0.95) notes.push(`${pct(f.nulls / f.n)} null — skip_serializing_if`);
      else if (f.defaults / f.n > 0.95) notes.push(`${pct(f.defaults / f.n)} default`);
      console.log(
        `  ${padr(p, 26)} ${pad(per.toFixed(1), 7)} ${pad((f.keyBytes / v.count).toFixed(1), 6)} ${pad((f.valueBytes / v.count).toFixed(1), 6)} ${pad(uniq, 6)} ${pad(pct(f.nulls / f.n), 7)}  ${notes.join("")}`
      );
    }
    console.log(
      `  -> field NAMES cost ${(keyTotal / v.count).toFixed(1)} B/event (${pct(keyTotal / v.bytes)} of this event type)`
    );

    const dupes = [...v.pairs]
      .filter(([, s]) => s.n > 20 && s.same / s.n > 0.9)
      .sort((a, b) => b[1].bytes - a[1].bytes);
    for (const [key, s] of dupes) {
      console.log(
        `  -> ${key} in ${pct(s.same / s.n)} of events (${(s.bytes / v.count).toFixed(1)} B/event duplicated)`
      );
    }
    console.log("");
  }
};

/** Evenly spaced pick across the window. Taking the newest N instead would
 * quietly sample the tail of the distribution — long recent runs — and every
 * absolute KB figure in the section would then read high against the real
 * average log. The percentages survive either way; the baseline does not. */
export const evenSample = (records, n) => {
  if (records.length <= n) return records;
  const step = records.length / n;
  return Array.from({ length: n }, (_, i) => records[Math.floor(i * step)]);
};

const reportSavings = (samples, byVariant, opts) => {
  console.log("== SAVINGS (measured on disk) =========================================");
  console.log(`Each policy rebuilds ${samples.length} real encounters, spread evenly across the`);
  console.log("window, and recompresses at zstd level 3. Read the PERCENTAGES: the KB column");
  console.log("is this sample's mean, not the mean log — see the header line for that.");
  console.log("");

  const baseline = samples.reduce((s, r) => s + r.compressedBytes, 0);
  /** `policy` may be a factory, for policies that carry per-encounter state
   * (a stateful policy must not leak state between encounters). */
  const measure = (label, policy) => {
    let total = 0;
    for (const r of samples)
      total += compress(rewriteEncounter(r.raw, typeof policy === "function" ? policy() : policy));
    const delta = (baseline - total) / baseline;
    console.log(
      `  ${padr(label, 46)} ${pad((total / samples.length / KB).toFixed(1) + " KB", 10)} ${pad((delta >= 0 ? "-" : "+") + pct(Math.abs(delta)), 8)}`
    );
    return delta;
  };

  console.log(
    `  ${padr("as stored (mean of this sample)", 46)} ${pad((baseline / samples.length / KB).toFixed(1) + " KB", 10)} ${pad("—", 8)}`
  );
  measure("re-encoded unchanged (fidelity check)", {});
  console.log("");

  // Fields the audit found are never usefully stored.
  const alwaysNull = new Map();
  for (const [name, v] of byVariant) {
    const paths = [...v.fields].filter(([, f]) => !f.container && f.nulls === f.n).map(([p]) => p);
    if (paths.length) alwaysNull.set(name, new Set(paths));
  }
  if (alwaysNull.size) {
    const listed = [...alwaysNull].map(([n, s]) => `${n}.{${[...s].join(",")}}`).join(" ");
    measure("drop always-null fields", {
      dropField: (variant, p) => alwaysNull.get(variant)?.has(p),
    });
    console.log(`     (${listed})`);
  }

  measure("omit every null Option (skip_serializing_if)", { dropField: (_v, _p, val) => val === null });
  // Actor documents parent_* as mirroring index/actor_type whenever the actor
  // has no parent, so those bytes are a copy the parser could reconstruct.
  measure("drop Actor parent fields when they mirror the child", {
    dropField: (_v, p, val, siblings) =>
      (p.endsWith(".parent_index") && val === siblings?.index) ||
      (p.endsWith(".parent_actor_type") && val === siblings?.actor_type),
  });

  const shortNames = new Map();
  measure("shorten every field name (serde rename)", {
    renameField: (variant, p) => {
      const key = `${variant}|${p}`;
      if (!shortNames.has(key)) shortNames.set(key, shortNames.size.toString(36));
      return shortNames.get(key);
    },
  });
  console.log("");

  const ranked = [...byVariant].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 6);
  for (const [name] of ranked) {
    measure(`drop the ${name} stream entirely`, { dropVariants: new Set([name]) });
  }

  // Precision is the lever that costs no events. An f32 read out of the game is
  // a near-unique 4-byte pattern per event, which is the worst possible input to
  // a compressor; the same quantity rounded to the precision anyone actually
  // reads collapses to a small alphabet of integers that zstd can model.
  console.log("");
  console.log("  (quantizing keeps every event — it only drops digits nobody reads)");
  // Rounding while KEEPING the f32 type is the compatible half of this idea:
  // stored logs stay readable. Switching the field to an integer type is not —
  // cbor4ii rejects a stored float for a u16 field — so those lines below are
  // the ceiling, reachable only behind a new message variant.
  for (const scale of [1, 10]) {
    measure(`round ALL floats to 1/${scale}, keep f32 (compatible)`, {
      roundFloat: (_v, _p, val) => Math.round(val * scale) / scale,
    });
  }
  for (const scale of [1, 10, 100]) {
    measure(`quantize ALL floats to 1/${scale} (needs new variant)`, {
      quantize: (_v, _p, val) => Math.round(val * scale),
    });
  }
  for (const [name, v] of ranked) {
    const floats = [...v.fields].filter(([, f]) => !f.container && f.distinct.size > 32).length;
    if (!floats) continue;
    measure(`round ${name} floats to 1/10, keep f32`, {
      roundFloat: (variant, _p, val) => (variant === name ? Math.round(val * 10) / 10 : undefined),
    });
  }

  // Renaming one event type's fields is compatible in a way retyping is not:
  // #[serde(rename)] + #[serde(alias = "<old key>")] + #[serde(default)] leaves
  // the value's TYPE alone, which is the thing cbor4ii dispatches on.
  console.log("");
  for (const [name] of ranked) {
    const short = new Map();
    measure(`shorten ${name} field names only`, {
      renameField: (variant, p) => {
        if (variant !== name) return undefined;
        if (!short.has(p)) short.set(p, short.size.toString(36));
        return short.get(p);
      },
    });
  }

  // sba_value is a running total of sba_added per actor — 99.2% of events
  // satisfy value == prev + added, and the exceptions are gauge spends, which
  // OnPerformSBA already records. Storing both is storing the same number twice.
  console.log("");
  measure("drop OnUpdateSBA.sba_value (derivable from sba_added)", {
    dropField: (variant, p) => variant === "OnUpdateSBA" && p === "sba_value",
  });
  measure("both: round to 1/10 (f32) and drop sba_value", {
    dropField: (variant, p) => variant === "OnUpdateSBA" && p === "sba_value",
    roundFloat: (_v, _p, val) => Math.round(val * 10) / 10,
  });
};

// ----------------------------------------------------------------- main ----

const main = () => {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }

  if (opts.help) {
    console.log(
      [
        "Usage: node scripts/log-size-report.mjs [options]",
        "",
        "  --db <path>          logs.db to read (else $RELINK_LOGS_DB, else .env)",
        "  --jumps              when storage stepped up, and in which event type",
        "  --audit              per-field cost and never-needed fields",
        "  --save               what each change is worth on disk",
        "                       (no section flag runs all three)",
        "  --since <when>       YYYY-MM-DD, Nd back from the newest log, or all",
        "                       (default: 7d)",
        "  --min-duration <s>   ignore encounters shorter than this (default: 60)",
        "  --min-jump <ratio>   step size to report (default: 1.3)",
        "  --window <days>      days compared either side of a step (default: 5)",
        "  --audit-logs <n>     newest logs used for the audit (default: 200)",
        "  --sim-logs <n>       newest logs rebuilt for savings (default: 30)",
      ].join("\n")
    );
    return;
  }

  const configured = resolveDbPath({ flag: opts.db, env: process.env, envFile: path.join(REPO_ROOT, ".env") });
  // A relative path in .env is relative to the repo, not to the cwd.
  const dbPath = configured && !path.isAbsolute(configured) ? path.resolve(REPO_ROOT, configured) : configured;

  if (!dbPath) {
    console.error(
      `no database path. Pass --db <path>, set ${ENV_KEY}, or add ${ENV_KEY}=... to .env (see .env.example).`
    );
    process.exit(2);
  }
  if (!existsSync(dbPath)) {
    console.error(`database not found: ${dbPath}`);
    process.exit(2);
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const newest = db.prepare(`SELECT MAX(time) AS t FROM logs`).get()?.t;
  let since;
  try {
    since = resolveSince(opts.since, Number(newest ?? 0));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  const rows = db
    .prepare(`SELECT time, duration, data FROM logs WHERE duration > ? AND time >= ? ORDER BY time`)
    .all(opts.minDuration * 1000, since ?? 0);
  db.close();

  const records = [];
  let skipped = 0;
  for (const r of rows) {
    const blob = Buffer.from(r.data);
    let raw = null;
    let summary = null;
    try {
      raw = zstdDecompressSync(blob);
      summary = summarizeBlob(raw);
    } catch {
      summary = null;
    }
    if (!summary) {
      skipped++;
      continue;
    }
    records.push({
      day: dayKey(r.time),
      durationSec: Number(r.duration) / 1000,
      compressedBytes: blob.length,
      raw,
      summary,
    });
  }

  if (!records.length) {
    console.error(`no decodable encounters over ${opts.minDuration}s in ${dbPath}`);
    process.exit(1);
  }

  const stored = records.reduce((s, r) => s + r.compressedBytes, 0);
  console.log(`db: ${dbPath}`);
  console.log(
    `${records.length} encounters over ${opts.minDuration}s, ${records[0].day} to ${records.at(-1).day}` +
      ` (--since ${opts.since})` +
      `${skipped ? `, ${skipped} skipped` : ""}`
  );
  console.log(`${(stored / KB / KB).toFixed(1)} MB stored, ${(stored / records.length / KB).toFixed(1)} KB per log`);
  console.log("");

  if (opts.sections.has("jumps")) reportJumps(records, opts);

  const auditSet = records.slice(-opts.auditLogs);
  const byVariant = opts.sections.has("audit") || opts.sections.has("save") ? auditRecords(auditSet) : null;
  if (opts.sections.has("audit")) reportAudit(byVariant, opts);
  if (opts.sections.has("save")) reportSavings(evenSample(records, opts.simLogs), byVariant, opts);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
