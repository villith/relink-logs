# Handoff — damage-cap validation session, 2026-08-13

Branch `feat/remote-sba-gains` (cap-oracle branch is fully merged into it).
Five commits this session, all committed and building; suites untouched
(the one new test file self-skips). No uncommitted work. All analysis was
offline per the validating-models-against-logs skill — zero live rounds.

## Commits

| Commit | What |
|---|---|
| `1ceb8520` | `src-tauri/examples/cap_residual_scan.rs` — classifies the off-grid cap residual (transition / settling / half-grid / cobalt), sweep + `--dump` + `--trace` modes |
| `ccc297c9` | `--markdown` mode + `docs/damage-cap-coverage.md` (per-character coverage table); corrected Pl0300=Rackam (not Katalina), Pl0600=Rosetta (not Ferry) |
| `f70e1011` | `scripts/cap-stats-only.test.ts` — stats-only (no account rows) per-hit K prediction probe; skips unless `CAP_EVIDENCE` set |
| `92c551eb` | `src-tauri/examples/roster_census.rs` — corpus census of online slots and capture completeness |
| `11ba0ec0` | census fix: lobby discriminator was wrong; labels online-slot count only |

## What was established (details in memory files)

1. **Off-grid cap residual SOLVED** (`cap-off-grid-residual` memory).
   State-gated cap terms EASE over ~1.3s + a multi-second asymptotic tail
   (Id dragon form ±70, Rackam Duration windows). Mid-transition hits carry
   the game's own eased multiplier — bounded by the actor's on-grid states,
   which is the scan's `transition` class. Rosetta's build sits on a
   half-percent K grid (measured exactly 849.500). Corpus: 90,155 capped
   hits, 99.65% covered; worklist = 13 entries / 315 hits (top: Fediel log
   2560, constant K≈307.3, no loadout data in that log).

2. **Coverage table** `docs/damage-cap-coverage.md` — regenerate after new
   logs: `cargo run --release -p gbfr-logs --example cap_residual_scan -- --last 5000 --markdown > docs/damage-cap-coverage.md`

3. **Stats-only gap measured** (`cap-stats-only-probe` memory). Eustace,
   logs 2612/2617/2618: observed K = stats-only prediction + 784 account
   (684 mastery store + 100 master rank) + a PER-HIT scatter of +18..+96
   in ~11-unit steps (unidentified stack/count term — next lead: diff the
   offset against per-hit statuses; the snapshot is already in the
   evidence JSON).

4. **Remotes DO provide the account data** (census + probe on real
   lobbies 2619/2654, CJK rosters). Each remote slot carries their OWN
   masterLevel / limitBonusCap / capUp etc. — the game simulates every
   party record locally and the capture reads it. Thin slots = old
   capture-era logs (raw actor indices), not remoteness. Storage cannot
   distinguish enlisted characters from co-op remotes, and for data
   availability it doesn't matter.

5. **A synced quest mode exists**: log 2619 — Scott's own Eustace reads
   lbcap 231 (vs 684 normal) and observed K sits ~300-420 below even the
   equipment-only prediction: the mode scales account AND equipment
   contributions down. The captured store tracks the sync. **Ask Scott
   what quest 2619 was** to name the mode. Log 2654 (lobby) is normal.

6. **The "ML50+5★+trans10 ⇒ maxed account" heuristic**: needed only for
   pre-capture logs; two caveats — Io counterexample (ML55 but store
   390/412/412; AP trees are per-character), and the 2619 sync mode.
   The predictor sweep (limitBonusCap vs master/stars/transcendence over
   the 53 logs that captured it) was proposed but NOT run.

## Run recipes

```sh
# residual scan (also the patch-day regression gate)
cargo run --release -p gbfr-logs --example cap_residual_scan -- --last 60
#   --log N --dump      per-hit detail;  --trace 0xf000000N  TSV time series

# stats-only probe
cargo run --release -p gbfr-logs --example cap_evidence -- --log 2612 --log 2617 > ev.json
CAP_EVIDENCE=ev.json CAP_CHARACTER=Pl2700 npx vitest run scripts/cap-stats-only.test.ts

# roster census
cargo run --release -p gbfr-logs --example roster_census        # add --dump for every row
```

Gotcha: pipe census output through `PYTHONUTF8=1 python` when grepping
CJK names — default Windows codec eats them silently.

## Open items, in rough priority

1. Identify the ~11-step per-hit scatter term in the stats-only offset
   (correlate offset × per-hit statuses inside the probe).
2. Name the 2619 synced mode (ask Scott / check quest id in that log).
3. Fediel's constant K≈307.3 (needs a new Fediel log with loadout capture).
4. Rosetta's half-percent source (needs a Rosetta log with overmasteries).
5. Events-card verdict still renders transition hits ✗ + Unaccounted; a
   "state transition" verdict in `capLadder.ts` needs the per-actor
   grid-state set.
6. Predictor sweep for the maxed-account heuristic (item 6 above).

Memory: `cap-off-grid-residual`, `cap-stats-only-probe` (both updated with
today's corrections), MEMORY.md indexed. Older cap memories mislabel
Pl0300 as "Katalina" — trust `lang/en/characters.json`.
