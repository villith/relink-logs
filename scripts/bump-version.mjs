// Bumps the app version in every place that must agree on release:
//   package.json            .version
//   src-tauri/tauri.conf.json .package.version
//   src-tauri/Cargo.toml    [package] version
//   Cargo.lock              the gbfr-logs package entry (kept in sync so the
//                           next cargo build doesn't dirty the lockfile)
//
// Usage:
//   npm run bump             -> patch bump (1.9.5 -> 1.9.6)
//   npm run bump -- 1.10.0   -> explicit version
//   npm run bump -- minor    -> 1.9.5 -> 1.10.0 (also: patch, major)
//
// The release workflow tags + publishes automatically when a commit on main
// carries a package.json version with no matching tag, so bump, commit, and
// merge to main to cut a release.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const pkgPath = resolve(root, "package.json");
const tauriConfPath = resolve(root, "src-tauri/tauri.conf.json");
const cargoTomlPath = resolve(root, "src-tauri/Cargo.toml");
const cargoLockPath = resolve(root, "Cargo.lock");

const current = JSON.parse(readFileSync(pkgPath, "utf8")).version;

const arg = process.argv[2] ?? "patch";
let next;
if (/^\d+\.\d+\.\d+$/.test(arg)) {
  next = arg;
} else if (["patch", "minor", "major"].includes(arg)) {
  const [major, minor, patch] = current.split(".").map(Number);
  next =
    arg === "major"
      ? `${major + 1}.0.0`
      : arg === "minor"
        ? `${major}.${minor + 1}.0`
        : `${major}.${minor}.${patch + 1}`;
} else {
  console.error(`[bump-version] invalid argument "${arg}" — expected x.y.z, patch, minor, or major`);
  process.exit(1);
}

// Edit files textually so formatting and key order survive untouched.
const replaceOnce = (path, pattern, replacement) => {
  const text = readFileSync(path, "utf8");
  const updated = text.replace(pattern, replacement);
  if (updated === text) {
    console.error(`[bump-version] no match for ${pattern} in ${path} — aborting, no files changed beyond earlier steps`);
    process.exit(1);
  }
  writeFileSync(path, updated);
  console.log(`[bump-version] ${path}: -> ${next}`);
};

replaceOnce(pkgPath, `"version": "${current}"`, `"version": "${next}"`);
replaceOnce(tauriConfPath, `"version": "${current}"`, `"version": "${next}"`);
replaceOnce(cargoTomlPath, `version = "${current}"`, `version = "${next}"`);
replaceOnce(
  cargoLockPath,
  new RegExp(`(name = "gbfr-logs"\\nversion = )"${current.replaceAll(".", "\\.")}"`),
  `$1"${next}"`
);

console.log(`[bump-version] ${current} -> ${next}`);
