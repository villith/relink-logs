// Writes one version into every file that carries it:
// package.json, src-tauri/tauri.conf.json, src-tauri/Cargo.toml, Cargo.lock.
// These four must always agree — the app reports tauri.conf.json's version to
// the updater, and a mismatch with the release tag breaks update comparisons.
//
//   node scripts/set-version.mjs 1.12.0-1
//
// Edits are targeted line replacements (not parse/re-serialize) so file
// formatting survives; each edit is verified after writing.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-\d+)?$/.test(version ?? "")) {
  console.error("usage: node scripts/set-version.mjs <X.Y.Z or X.Y.Z-N>");
  process.exit(1);
}

const edit = (rel, pattern, replacement, verify) => {
  const path = resolve(root, rel);
  const before = readFileSync(path, "utf8");
  const after = before.replace(pattern, replacement);
  if (after === before && !verify(before)) {
    throw new Error(`${rel}: version pattern not found`);
  }
  writeFileSync(path, after);
  if (!verify(after)) {
    throw new Error(`${rel}: verification failed after edit`);
  }
  console.log(`${rel} -> ${version}`);
};

edit(
  "package.json",
  /("version":\s*")[^"]+(")/,
  `$1${version}$2`,
  (s) => JSON.parse(s).version === version,
);
edit(
  "src-tauri/tauri.conf.json",
  /("version":\s*")[^"]+(")/,
  `$1${version}$2`,
  (s) => JSON.parse(s).package.version === version,
);
edit(
  "src-tauri/Cargo.toml",
  /^version\s*=\s*"[^"]+"/m,
  `version = "${version}"`,
  (s) => new RegExp(`^version\\s*=\\s*"${version.replace(/[.-]/g, "\\$&")}"`, "m").test(s),
);
edit(
  "Cargo.lock",
  /(name = "gbfr-logs"\r?\nversion = ")[^"]+(")/,
  `$1${version}$2`,
  (s) => new RegExp(`name = "gbfr-logs"\\r?\\nversion = "${version.replace(/[.-]/g, "\\$&")}"`).test(s),
);
