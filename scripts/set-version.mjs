// Writes one version into every file that carries it: package.json,
// package-lock.json (root + packages[""]), src-tauri/tauri.conf.json,
// src-tauri/Cargo.toml, Cargo.lock.
// These must always agree — the app reports tauri.conf.json's version to
// the updater, and a mismatch with the release tag breaks update comparisons.
//
//   node scripts/set-version.mjs 1.12.0-1
//
// The npm-owned pair goes through `npm version` (offline, no dependency
// re-resolution — unlike `npm install`, which can churn the lock). The other
// three get targeted line replacements so file formatting survives; every
// file is verified after writing.
import { execSync } from "node:child_process";
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

// A shell string is deliberate: npm is npm.cmd on Windows, which Node
// refuses to spawn shell-less (CVE-2024-27980). Injection-safe because
// `version` is locked to \d+.\d+.\d+(-\d+)? above.
execSync(`npm version ${version} --no-git-tag-version --allow-same-version`, {
  cwd: root,
  stdio: "pipe",
});
for (const rel of ["package.json", "package-lock.json"]) {
  const parsed = JSON.parse(readFileSync(resolve(root, rel), "utf8"));
  const got = rel === "package-lock.json" ? parsed.packages[""].version : parsed.version;
  if (parsed.version !== version || got !== version) {
    throw new Error(`${rel}: npm version did not set ${version}`);
  }
  console.log(`${rel} -> ${version}`);
}
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
