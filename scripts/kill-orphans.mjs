// `npm run dev` prelude (so it also fronts `npm run tauri dev`, which runs
// `npm run dev` as its beforeDevCommand). Kills processes left over from a
// previous dev loop.
//
// Two things survive a Ctrl+C / crashed dev loop and then break the next one:
//
//   1. The app itself. `GBFR Logs.exe` hides to the system tray instead of
//      exiting (`on_window_event` in main.rs), so closing its windows does not
//      end the process — and Ctrl+C in the tauri dev terminal does not always
//      reach it. A survivor holds an exclusive lock on `target/debug/GBFR
//      Logs.exe`, so the next `cargo build` dies with "Access is denied", and it
//      keeps owning the `\\.\pipe\gbfr-logs` reader, so the new instance sees no
//      events even once it does build.
//   2. The Vite dev server. If it keeps port 1420, the next Vite picks 1421
//      while tauri.conf.json's devPath still points at 1420 — the app then
//      renders the STALE frontend with no visible error.
//
// Matching is by path, not by name: only executables that live under this
// repo's `target/` are killed, so an installed release copy of GBFR Logs (same
// exe name) and any other project's Vite are left alone. The game process is
// never touched — the injected hook lives inside it, and killing the game is
// not this script's business.
//
// Windows-only, like the rest of the live dev loop; a no-op elsewhere.
//
// Flags: --quiet (say nothing when there was nothing to kill)
//        --dry-run (report what would be killed, kill nothing)
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGET_DIR = path.join(REPO_ROOT, "target");
const VITE_PORT = Number(process.env.VITE_PORT ?? 1420);

const quiet = process.argv.includes("--quiet");
const dryRun = process.argv.includes("--dry-run");

const log = (msg) => console.log(`[kill-orphans] ${msg}`);

if (process.platform !== "win32") {
  if (!quiet) log("non-Windows host: skipping (the live dev loop is Windows-only).");
  process.exit(0);
}

// Discovery + termination in one PowerShell round trip; the script prints a
// single JSON document on stdout and nothing else.
const PS = `
$ErrorActionPreference = 'SilentlyContinue'
$target = $env:ORPHAN_TARGET_DIR
$repo   = $env:ORPHAN_REPO_ROOT
$port   = [int]$env:ORPHAN_VITE_PORT
$dry    = $env:ORPHAN_DRY_RUN -eq '1'
$cmp    = [System.StringComparison]::OrdinalIgnoreCase

$victims = New-Object System.Collections.ArrayList
$notes   = New-Object System.Collections.ArrayList

foreach ($p in (Get-CimInstance Win32_Process)) {
  if (-not $p.ExecutablePath) { continue }
  if ($p.ProcessId -eq $PID) { continue }
  if ($p.ExecutablePath.StartsWith($target, $cmp)) {
    [void]$victims.Add([pscustomobject]@{ pid = $p.ProcessId; name = $p.Name; reason = 'built from target/' })
  } elseif ($p.Name -eq 'node.exe' -and $p.CommandLine -and $p.CommandLine.IndexOf($repo, $cmp) -ge 0 -and $p.CommandLine.IndexOf('vite', $cmp) -ge 0) {
    [void]$victims.Add([pscustomobject]@{ pid = $p.ProcessId; name = $p.Name; reason = 'stale vite dev server' })
  }
}

# Anything still listening on the dev port that we did not already match: report
# it rather than kill it, since it belongs to something outside this repo.
foreach ($owner in (Get-NetTCPConnection -LocalPort $port -State Listen | Select-Object -ExpandProperty OwningProcess -Unique)) {
  if ($victims.pid -contains $owner) { continue }
  $p = Get-CimInstance Win32_Process -Filter "ProcessId = $owner"
  $who = if ($p) { "$($p.Name) (pid $owner)" } else { "pid $owner" }
  [void]$notes.Add("port $port is held by $who, which is not ours - leaving it (Vite will fall back to another port and the app will load the stale one)")
}

$killed = New-Object System.Collections.ArrayList
foreach ($v in $victims) {
  if ($dry) { [void]$killed.Add(($v | Select-Object pid, name, reason, @{n='status';e={'would kill'}})); continue }
  try {
    Stop-Process -Id $v.pid -Force -ErrorAction Stop
    [void]$killed.Add(($v | Select-Object pid, name, reason, @{n='status';e={'killed'}}))
  } catch {
    [void]$killed.Add(($v | Select-Object pid, name, reason, @{n='status';e={"failed: $($_.Exception.Message)"}}))
  }
}

ConvertTo-Json -Compress -Depth 3 @{ killed = @($killed); notes = @($notes) }
`;

let raw;
try {
  raw = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", PS], {
    encoding: "utf8",
    env: {
      ...process.env,
      ORPHAN_TARGET_DIR: TARGET_DIR,
      ORPHAN_REPO_ROOT: REPO_ROOT,
      ORPHAN_VITE_PORT: String(VITE_PORT),
      ORPHAN_DRY_RUN: dryRun ? "1" : "0",
    },
  });
} catch (err) {
  // Never block the dev loop on this: a stale process that survives just
  // reproduces today's behaviour, whereas a hard exit stops the build outright.
  log(`WARNING: could not scan for orphans (${err.message.trim()}); continuing.`);
  process.exit(0);
}

let report;
try {
  report = JSON.parse(raw);
} catch {
  log(`WARNING: unexpected scan output; continuing.\n${raw.trim()}`);
  process.exit(0);
}

for (const note of report.notes ?? []) log(`NOTE: ${note}`);

const killed = report.killed ?? [];
if (killed.length === 0) {
  if (!quiet) log("no orphaned processes.");
  process.exit(0);
}

for (const k of killed) log(`${k.status}: ${k.name} (pid ${k.pid}) - ${k.reason}`);

// An "Access is denied" failure is the interesting case: the app runs elevated
// against the game, so an unelevated dev shell cannot kill it.
if (killed.some((k) => String(k.status).startsWith("failed"))) {
  log("some processes could not be killed - if it is the app, re-run this shell as administrator.");
}
