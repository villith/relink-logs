// Sets a new BASE version (X.Y.Z) across every file that carries one.
//
// Versions are normally managed by CI: every push to dev auto-bumps to the
// next RC (X.Y.Z-N), and the release button strips the suffix. See the header
// of .github/workflows/release.yaml. The one thing CI cannot decide for you is
// whether the next release is a patch, minor, or major — so this script exists
// to set that base in a PR:
//
//   npm run bump -- minor    -> 1.11.2-3 becomes 1.12.0
//   npm run bump -- 1.13.0   -> explicit version
//   npm run bump             -> patch bump of the base
//
// CI then appends the RC number, so this always writes a plain X.Y.Z with no
// -N suffix. The current version may already carry one (dev almost always
// does); it is stripped before the bump — parsing it as a plain X.Y.Z used to
// yield "1.11.NaN" and silently corrupt every version file.
//
// The actual writing is delegated to set-version.mjs so there is exactly one
// implementation of "write this version everywhere" (it also covers
// package-lock.json, which this script historically missed, leaving `npm ci`
// to fail on a lockfile/package.json version mismatch).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { extractSection } from "./extract-changelog.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const current = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;

const parsed = /^(\d+)\.(\d+)\.(\d+)(?:-\d+)?$/.exec(current);
if (!parsed) {
  console.error(`[bump-version] current version "${current}" is not X.Y.Z or X.Y.Z-N`);
  process.exit(1);
}
const [major, minor, patch] = parsed.slice(1, 4).map(Number);

const arg = process.argv[2] ?? "patch";
let next;
if (/^\d+\.\d+\.\d+$/.test(arg)) {
  next = arg;
} else if (arg === "major") {
  next = `${major + 1}.0.0`;
} else if (arg === "minor") {
  next = `${major}.${minor + 1}.0`;
} else if (arg === "patch") {
  next = `${major}.${minor}.${patch + 1}`;
} else {
  console.error(`[bump-version] invalid argument "${arg}" — expected x.y.z, patch, minor, or major`);
  process.exit(1);
}

execFileSync(process.execPath, [resolve(root, "scripts/set-version.mjs"), next], {
  cwd: root,
  stdio: "inherit",
});
console.log(`[bump-version] ${current} -> ${next}`);

// Catch the missing-notes case here rather than as a failed release later: the
// stable release is gated on this section existing, and it must be written by
// a human.
if (extractSection(readFileSync(resolve(root, "CHANGELOG.md"), "utf8"), next) === null) {
  console.log(
    `[bump-version] CHANGELOG.md has no "## ${next}" section yet — write one before releasing ${next}`,
  );
}
