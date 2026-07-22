// Computes the version the release workflow should publish for a branch.
//
//   git tag | node scripts/next-version.mjs dev  <fileVersion>   -> next RC (X.Y.Z-N)
//   git tag | node scripts/next-version.mjs main <fileVersion>   -> stable  (X.Y.Z)
//
// dev: the base is whatever the files carry when it is ahead of the newest
// stable tag (set a new base version in a PR to make a release minor/major);
// otherwise the newest stable tag plus a patch bump. The RC number is the
// next -N not already tagged for that base. N must stay numeric and <= 65535:
// WiX turns it into the MSI ProductVersion's 4th field, and rejects anything
// like -rc.1.
//
// main: the file version with any RC suffix stripped.
//
// Tags that are not X.Y.Z or X.Y.Z-N (e.g. the legacy 1.8.0.alpha.* tags) are
// ignored.

const parse = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-(\d+))?$/.exec(v.trim());
  return m && { major: +m[1], minor: +m[2], patch: +m[3], rc: m[4] === undefined ? null : +m[4] };
};
const cmpBase = (a, b) => a.major - b.major || a.minor - b.minor || a.patch - b.patch;
const baseStr = (v) => `${v.major}.${v.minor}.${v.patch}`;

const [channel, fileVersion] = process.argv.slice(2);
if (!["dev", "main"].includes(channel) || !fileVersion) {
  console.error("usage: git tag | node scripts/next-version.mjs <dev|main> <fileVersion>");
  process.exit(1);
}
const current = parse(fileVersion);
if (!current) {
  console.error(`[next-version] file version "${fileVersion}" is not X.Y.Z or X.Y.Z-N`);
  process.exit(1);
}

if (channel === "main") {
  console.log(baseStr(current));
  process.exit(0);
}

let stdin = "";
for await (const chunk of process.stdin) stdin += chunk;
const tags = stdin.split(/\r?\n/).map(parse).filter(Boolean);

const stables = tags.filter((t) => t.rc === null);
const lastStable = stables.reduce(
  (a, b) => (cmpBase(a, b) >= 0 ? a : b),
  { major: 0, minor: 0, patch: 0, rc: null },
);

const base =
  cmpBase(current, lastStable) > 0
    ? { major: current.major, minor: current.minor, patch: current.patch }
    : { major: lastStable.major, minor: lastStable.minor, patch: lastStable.patch + 1 };

const rcs = tags.filter((t) => t.rc !== null && cmpBase(t, base) === 0).map((t) => t.rc);
const n = (rcs.length ? Math.max(...rcs) : 0) + 1;
if (n > 65535) {
  console.error(`[next-version] RC number ${n} exceeds 65535, the MSI ProductVersion field limit`);
  process.exit(1);
}
console.log(`${baseStr(base)}-${n}`);
