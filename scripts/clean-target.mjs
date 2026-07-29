// Reclaims disk in target/ by deleting *superseded generations* of build artifacts.
//
// Why this exists: cargo names every artifact (and every rustc incremental-cache
// directory) after a `-C metadata` hash that includes the PACKAGE VERSION, and it
// never garbage-collects the artifacts of a hash that is no longer current. CI
// auto-bumps src-tauri/Cargo.toml on every push to `dev`, so each version that
// passes through the working tree strands a full generation of artifacts for all
// ~35 targets in the gbfr-logs package (lib + bin + the diag examples) — roughly
// 350 MB of incremental cache per target plus a ~130 MB PDB in deps/. Left alone
// that reached 67 GB / 2,682 stale incremental directories here.
//
// The rule is deliberately narrower than an mtime sweep: an entry is deleted only
// if it is BOTH outside the newest `--keep` generations of its own family (same
// artifact name and extension, different hash) AND untouched for `--days`. A
// family with a single generation — an unchanged third-party rlib — is never
// touched, so pruning does not force a dependency rebuild.
//
// Only the artifact subdirectories are scanned (deps, examples, build,
// .fingerprint, incremental). Everything at the profile root — hook.dll, the built
// exes, bundle/, and the logs.db the app writes next to the binary — is out of
// scope and left alone. The worst case is a rebuild, never data loss.
//
// `npm run dev` runs this with --quiet as a prelude (a scan is ~0.5s and stays
// silent unless it actually reclaims something), so the dev loop keeps target/
// bounded on its own. Run `npm run clean:target` by hand for a report.
//
//   node scripts/clean-target.mjs [--days N] [--keep N] [--dry-run] [--quiet] [--json]
import { readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Cargo's artifact hash: 16 lowercase hex, before an optional extension. */
const HASHED = /^(.*)-([0-9a-f]{16})(\..+)?$/;
/** rustc's incremental crate id: 13 chars of base-36, never an extension. */
const HASHED_INCREMENTAL = /^(.*)-([0-9a-z]{13})$/;

/** The subdirectories of a profile that hold hash-named, regenerable artifacts. */
const ARTIFACT_DIRS = ["incremental", "deps", "examples", "build", ".fingerprint"];

/**
 * The identity an entry shares with its older and newer generations: the artifact
 * name with the hash removed. Returns null when there is no hash — those entries
 * are not generations of anything and are never deletion candidates.
 */
export function familyKey(name, incremental = false) {
  const match = (incremental ? HASHED_INCREMENTAL : HASHED).exec(name);
  if (!match) return null;
  return incremental ? match[1] : match[1] + (match[3] ?? "");
}

/**
 * Picks the entries that are safe to delete: outranked within their family *and*
 * older than minAgeMs, so an in-flight build's outputs always survive.
 */
export function selectStale(entries, { keep = 3, minAgeMs = 24 * 60 * 60 * 1000, now = Date.now() } = {}) {
  const families = new Map();
  for (const entry of entries) {
    if (!entry.family) continue;
    const group = families.get(entry.family);
    if (group) group.push(entry);
    else families.set(entry.family, [entry]);
  }

  const stale = [];
  for (const group of families.values()) {
    group.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
    for (let rank = keep; rank < group.length; rank++) {
      if (now - group[rank].mtimeMs >= minAgeMs) stale.push(group[rank]);
    }
  }
  return stale;
}

/** Recursive size of a path, for the freed-bytes report. Unreadable paths count as empty. */
function measure(path) {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return 0;
  }
  if (!stat.isDirectory()) return stat.size;

  let size = 0;
  let children;
  try {
    children = readdirSync(path, { withFileTypes: true });
  } catch {
    return size;
  }
  for (const child of children) size += measure(join(path, child.name));
  return size;
}

/**
 * Every hash-named entry under a profile's artifact subdirectories.
 *
 * Ranking uses the entry's OWN mtime rather than its newest descendant's: the
 * recursive walk that would find the latter costs ~12k inode touches on a
 * freshly-pruned tree (far more before a sweep) and runs ahead of every
 * `npm run dev`. Cargo bumps a generation's top-level mtime whenever it adds or
 * removes anything inside it, and `keep`/`--days` are the real safety net — so
 * the worst case of the cheaper stat is a rebuild, never data loss. Sizes are
 * measured later, for the handful of entries actually being deleted.
 */
function scanProfile(profileDir) {
  const entries = [];
  for (const artifactDir of ARTIFACT_DIRS) {
    const dir = join(profileDir, artifactDir);
    let children;
    try {
      children = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const incremental = artifactDir === "incremental";
    for (const child of children) {
      const family = familyKey(child.name, incremental);
      if (!family) continue;
      const path = join(dir, child.name);
      let mtimeMs;
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      entries.push({ name: child.name, path, family, mtimeMs });
    }
  }
  return entries;
}

/** target/{debug,release} plus the same pair under any cross-compile triple. */
function profileDirs(targetDir) {
  const dirs = [];
  const visit = (base) => {
    for (const profile of ["debug", "release"]) {
      const dir = join(base, profile);
      try {
        if (statSync(dir).isDirectory()) dirs.push(dir);
      } catch {
        /* profile not built */
      }
    }
  };
  visit(targetDir);
  let children = [];
  try {
    children = readdirSync(targetDir, { withFileTypes: true });
  } catch {
    return dirs;
  }
  for (const child of children) {
    if (child.isDirectory() && child.name.includes("-") && !["debug", "release"].includes(child.name)) {
      visit(join(targetDir, child.name));
    }
  }
  return dirs;
}

const gb = (bytes) => `${(bytes / 1024 ** 3).toFixed(2)} GB`;

function main(argv) {
  const flag = (name, fallback) => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? fallback : Number(argv[index + 1]);
  };
  const days = flag("days", 1);
  const keep = flag("keep", 3);
  const dryRun = argv.includes("--dry-run");
  const asJson = argv.includes("--json");
  const quiet = argv.includes("--quiet");

  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const targetDir = process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : join(root, "target");

  let scanned = 0;
  let freed = 0;
  let deleted = 0;
  let locked = 0;

  for (const profileDir of profileDirs(targetDir)) {
    const entries = scanProfile(profileDir);
    scanned += entries.length;
    const stale = selectStale(entries, { keep, minAgeMs: days * 24 * 60 * 60 * 1000 });
    let profileFreed = 0;
    for (const entry of stale) {
      // Measured before the delete, and only for what is actually going away.
      const size = measure(entry.path);
      if (!dryRun) {
        try {
          rmSync(entry.path, { recursive: true, force: true });
        } catch {
          // Windows keeps a handle on artifacts a running app or IDE has open.
          locked++;
          continue;
        }
      }
      profileFreed += size;
      deleted++;
    }
    freed += profileFreed;
    if (!asJson && !quiet) {
      console.log(
        `[clean-target] ${profileDir}: ${stale.length}/${entries.length} generations stale, ${gb(profileFreed)}`
      );
    }
  }

  const summary = { targetDir, scanned, deleted, locked, freedBytes: freed, days, keep, dryRun };
  if (asJson) console.log(JSON.stringify(summary, null, 2));
  else if (!quiet || freed > 0) {
    console.log(
      `[clean-target] ${dryRun ? "would free" : "freed"} ${gb(freed)} ` +
        `(${deleted} superseded generations, keeping the newest ${keep} of each and anything newer than ${days}d)`
    );
    if (locked) {
      console.log(
        `[clean-target] ${locked} entries were locked and left in place — close the app/game/IDE and re-run.`
      );
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2));
}
