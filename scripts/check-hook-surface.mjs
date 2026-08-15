// Asserts that the injected Windows hook.dll carries none of the Proton-only
// surface, and that the Proton hook.dll still does.
//
//   node scripts/check-hook-surface.mjs <windows-hook.dll> <proton-hook.dll>
//
// Why this exists: the `proton` feature adds a DirectInput8Create export, a
// LoadLibraryW on a hardcoded system32 path, and a localhost TCP listener.
// None of it ever ran on Windows (is_wine() is false there), but all of it
// shipped inside the DLL we inject into the game process — which is the exact
// triad AV heuristics read as a DLL-hijack backdoor, and our hook.dll scored
// 18 detections on VirusTotal while upstream's scored 1.
//
// It scans the BUILT ARTIFACT rather than the source, because source gating is
// not sufficient on its own: gating the TCP code but still naming
// TOOLBOX_TCP_ADDR at a now-dead call site left "127.0.0.1:39372" in the
// shipped DLL's string table anyway. Only the bytes settle it.
//
// The Proton side is asserted too, deliberately. A check that only looks for
// absence passes just as happily when the scanner is broken or when the Proton
// build has silently lost its proxy export — a green run and a Linux release
// that cannot hook anything.

import { readFileSync } from "node:fs";
import process from "node:process";

/** Strings that must appear ONLY in the Proton build. */
export const PROTON_MARKERS = [
  "DirectInput8Create",
  "dinput8.dll",
  "LoadLibraryW",
  "GBFR_LOGS_FORCE_TCP",
  "wine_get_version",
  "127.0.0.1",
];

/** The one symbol the Proton DLL must export to work as a dinput8 proxy. */
export const PROXY_EXPORT = "DirectInput8Create";

/**
 * Log-line prefixes that must appear in NO release build, either platform.
 *
 * Every diagnostic in `src-hook` is supposed to sit behind `hookdiag` (or
 * `dmgdiag`), which compiles its format string out entirely — so a marker
 * found here means a `log::` call escaped its gate. Three `CONFLUX` lines did
 * exactly that and shipped in every release until a byte scan found them: they
 * were ordinary `warn!`/`info!` calls that source review kept walking past.
 *
 * Only prefixes unique to a diagnostic belong here. `HOOKDIAG` covers the
 * `ev!`/probe family wholesale; the rest are the per-subsystem prefixes the
 * `src-hook/src/hooks/*.rs` probes print. Adding a new diagnostic means adding
 * its prefix.
 */
export const DIAG_MARKERS = [
  "HOOKDIAG",
  "CONFLUX",
  "CAPORACLE",
  "CAPEXTRAS",
  "DMGHEAD",
  "DMGREC",
  "DMGEXTRAS",
  "DMGDIAG",
  "DISPDIAG",
  "ALTDMG",
  "TAKENAPPLY",
  "PGDIAG",
  "PGCOUNTER",
  "PGDMG",
  "PGWATCH",
  "UNATTRB90",
  "UNSRC",
  "SBAGATE",
  "SBAPOLL",
  "SBASITE",
  "SBANET",
  "SBAUPD",
  "SBAGAIN",
  "SBAUNK",
  "SBAGRANT",
  "SBAWEIGHT",
  "STUNNET",
  "SMNBODY",
  "IDDIAG",
  "ARDIAG",
  "PRDIAG",
  "STDIAG",
  "WSDIAG",
  "WPDIAG",
  "MLDIAG",
  "APDIAG",
  "SBDIAG",
  "LODIAG",
  "RECDIAG",
];

/**
 * Occurrences of `needle` in `buf`, counted as both ASCII and UTF-16LE —
 * Rust's `w!()` wide literals are stored UTF-16, narrow ones ASCII, and the
 * marker matters either way.
 */
export function countMarker(buf, needle) {
  let total = 0;
  for (const encoding of ["latin1", "utf16le"]) {
    const pat = Buffer.from(needle, encoding);
    let i = 0;
    for (;;) {
      i = buf.indexOf(pat, i);
      if (i === -1) break;
      total++;
      i += pat.length;
    }
  }
  return total;
}

/** Exported names from a PE32+ image, via the export directory. */
export function exportedNames(buf) {
  const peOff = buf.readUInt32LE(0x3c);
  const numSections = buf.readUInt16LE(peOff + 6);
  const optOff = peOff + 24;
  const optSize = buf.readUInt16LE(peOff + 20);
  // PE32+ optional header: the data directories start at +112, export is #0.
  const exportRva = buf.readUInt32LE(optOff + 112);
  if (exportRva === 0) return [];

  const sections = [];
  for (let i = 0; i < numSections; i++) {
    const s = optOff + optSize + i * 40;
    sections.push({
      va: buf.readUInt32LE(s + 12),
      vsize: buf.readUInt32LE(s + 8),
      raw: buf.readUInt32LE(s + 20),
    });
  }
  const toOff = (rva) => {
    const s = sections.find((x) => rva >= x.va && rva < x.va + x.vsize);
    if (!s) throw new Error(`RVA ${rva} is outside every section`);
    return rva - s.va + s.raw;
  };

  const dir = toOff(exportRva);
  const count = buf.readUInt32LE(dir + 24);
  // An image can carry an export directory while exporting nothing by name,
  // which is exactly what the injected Windows hook.dll does. AddressOfNames
  // is then 0 — not an RVA to resolve.
  if (count === 0) return [];
  const namesTable = toOff(buf.readUInt32LE(dir + 32));
  const names = [];
  for (let i = 0; i < count; i++) {
    let off = toOff(buf.readUInt32LE(namesTable + i * 4));
    const start = off;
    while (buf[off] !== 0) off++;
    names.push(buf.toString("latin1", start, off));
  }
  return names;
}

/** Marker counts + exports for one DLL. */
export function scanBuffer(buf) {
  return {
    markers: Object.fromEntries(PROTON_MARKERS.map((m) => [m, countMarker(buf, m)])),
    diag: Object.fromEntries(DIAG_MARKERS.map((m) => [m, countMarker(buf, m)])),
    exports: exportedNames(buf),
  };
}

/**
 * The whole decision, over two scan results. Returns a list of human-readable
 * problems; empty means the split is intact.
 */
export function checkSurface({ windows, proton }) {
  const errors = [];

  for (const marker of PROTON_MARKERS) {
    if (windows.markers[marker] > 0) {
      errors.push(
        `the Windows hook.dll contains "${marker}" (${windows.markers[marker]}x) — ` +
          `Proton-only surface must not ship in the injected DLL`
      );
    }
  }
  // Diagnostics are gated by cargo feature, not by platform, so BOTH release
  // artifacts must be clean.
  for (const [label, scan] of [
    ["Windows", windows],
    ["Proton", proton],
  ]) {
    for (const marker of DIAG_MARKERS) {
      if (scan.diag[marker] > 0) {
        errors.push(
          `the ${label} hook.dll contains the diagnostic marker "${marker}" ` +
            `(${scan.diag[marker]}x) — every diagnostic must sit behind hookdiag/dmgdiag`
        );
      }
    }
  }

  if (windows.exports.length > 0) {
    errors.push(
      `the Windows hook.dll exports ${windows.exports.length} symbol(s) ` +
        `(${windows.exports.join(", ")}) — it is injected and must export nothing`
    );
  }

  // Sanity checks on the other side, so a broken scan cannot read as a pass.
  if (!proton.exports.includes(PROXY_EXPORT)) {
    errors.push(`the Proton hook.dll does not export ${PROXY_EXPORT} — it cannot act as a dinput8 proxy`);
  }
  const present = PROTON_MARKERS.filter((m) => proton.markers[m] > 0);
  if (present.length === 0) {
    errors.push(
      `the Proton hook.dll contains none of the expected markers — ` + `the build is wrong or this scan is broken`
    );
  }

  return errors;
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"));
if (invokedDirectly) {
  const [windowsPath, protonPath] = process.argv.slice(2);
  if (!windowsPath || !protonPath) {
    console.error("usage: node scripts/check-hook-surface.mjs <windows-hook.dll> <proton-hook.dll>");
    process.exit(1);
  }

  const windows = scanBuffer(readFileSync(windowsPath));
  const proton = scanBuffer(readFileSync(protonPath));

  const report = (label, scan) => {
    console.log(
      `${label}: ${scan.exports.length} export(s)${scan.exports.length ? ` [${scan.exports.join(", ")}]` : ""}`
    );
    for (const m of PROTON_MARKERS) console.log(`    ${scan.markers[m] ? "HIT " : "ok  "} ${m} x${scan.markers[m]}`);
    // Only the hits, and a one-line all-clear otherwise: 39 diagnostic markers
    // printed per DLL would bury the Proton lines above them.
    const diagHits = DIAG_MARKERS.filter((m) => scan.diag[m] > 0);
    if (diagHits.length === 0) console.log(`    ok   no diagnostic markers (${DIAG_MARKERS.length} checked)`);
    else for (const m of diagHits) console.log(`    HIT  diag ${m} x${scan.diag[m]}`);
  };
  report(`windows (${windowsPath})`, windows);
  report(`proton  (${protonPath})`, proton);

  const errors = checkSurface({ windows, proton });
  for (const e of errors) console.error(`::error::${e}`);
  if (errors.length) process.exit(1);
  console.log("hook surface split is intact");
}
