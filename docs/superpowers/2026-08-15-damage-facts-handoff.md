# Damage facts capture — live-gate handoff (2026-08-15)

Branch `feat/damage-facts` (off `dev` at `6aa417e4`), through `d27246ac`.
Ships raw per-hit snapshot windows — DamageInstance `0xC0..0x340` post-call,
source actor `0x2480..0x24A0` + record `record+0x18..0x28` pre-call, raw
per-status term bits — plus a read-time facts index that interprets those
windows into gated facts (crit, weak point, back attack, Overdrive, Break,
debuffed, record dmg%) with per-fact **measured / inferred / unknown**
provenance. Also lands: Overdrive chart windows assembled from stored mode
events (backfilling logs captured since 2026-08-06, before the snapshot
existed), new crit/weak-point/back-attack analysis columns plus an OD/Break
hover split, and debug-panel gate rows that show real snapshot-measured
verdicts with a window-inferred OD/Break fallback for older logs. Hook is
0.2.1. Full offline gate (Task 12) is green — see below; only the live-game
checks remain.

## Task 12 — offline gate results (2026-08-15)

- `cargo test --workspace`: all green. game-reader 17, gbfr-logs lib 708,
  gbfr-logs bin 2, hook 110, protocol 23 — **860 passed, 0 failed**.
- `npm run test`: **232 test files / 2864 tests passed, 15 skipped**
  (2879 total), 0 failed.
- `npm run lint`: clean, no output.
- `npm run build`: tsc typecheck + vite build succeeded (`✓ built in
  7.76s`); only the pre-existing >500kB chunk-size advisory, not an error.
- `npm run format-check`: `All matched files use Prettier code style!`
- Hook reproducibility spot-check: two `cargo build --release -p hook
  --features eject` builds (second after touching `src-hook/src/lib.rs`)
  produced byte-identical `hook.dll`, SHA256
  `f31fd1d7bbb3e7b9ad716a4e05a54f3f3297c9e784aadb2958b3a5f6060a47d9`.

## Live gates (need Scott + the game; none automatable)

Rebuild the dev hook with the full feature set first —
`cargo build --release -p hook --features hook/console,hook/hookdiag,hook/dmgdiag,hook/fullassist,hook/eject`
— and tray → "Reload hook (dev)". A stale hook-dbg.dll silently drops the
new fields (decode errors are swallowed).

- **(a) Solo run.** New log → debug panel Debug page → cap tab: gate rows
  show real verdicts (crit rolls a verdict, weak point/back attack/OD/
  Break/debuffed valued); record dmg% row valued on Skill/SBA hits; the
  new crit column agrees with d0-cluster ground truth; OD/Break gate bytes
  agree with the chart's mode windows. Note the log's on-disk size delta
  vs a comparable pre-capture log.
- **(b) Online run.** The remote-population check — for REMOTE players'
  hits, which snapshot fields are zero vs stamped (target-side gate bytes
  especially). Outcomes: stamped → a follow-up can widen the measured
  boundary per-fact; zero → inference stands as designed. Also eyeball
  remote crit-rate columns (inferred, `~` marker) for plausibility.
- **(c) Re-parse old log 2656.** Panel rows unchanged except
  window-inferred OD/Break verdicts; new columns show dashes/inferred
  only; OD/Break hover split backfilled from mode windows; nothing
  fabricated.
- **(d) Table density check.** 9 columns at the abilities level —
  name-column squeeze at real widths; mixed old/new logs (dash rows under
  the same headers).

## Open follow-ups (from reviews)

- A Rust-side status-polarity asset would unlock debuffed inference (the
  generator exists frontend-only today: `scripts/gen-status-polarity.py`).
- Difficulty scalar deferred — `DAT_147beb720` row values + index
  semantics need one live oracle round (see the spec's out-of-scope note).
- `actor_type_id`'s pre-existing unguarded vfunc call is weaker than the
  new resolver's span-checked reads — candidate for the same treatment.
- Crit clustering's residual in-band mis-accept surfaces are documented in
  `damage_facts.rs` and validated by live gate (b) above.

## Commits (`6aa417e4..HEAD`)

```
d27246ac fix: honest exclusion for unknown-class record rows and record the call residual
9955e7a9 fix: span-bound the record resolver's image check
7d7e7f2d feat: capture the attacker record window per hit
71364ea0 fix: include fight-end-closed windows in mode inference and close review notes
4139f1d4 feat: window-inferred Overdrive and Break verdicts in the debug panel
c1d5a912 feat: real gate verdicts in the damage debug panel from recorded snapshots
94bbfae6 fix: metric-gate the hover facts attachment and close review notes
05a50bfc feat: crit, weak-point and back-attack columns with provenance and the OD-Break split card
af0f0116 test: pin the echo and taken-metric fact exclusions
385fba40 fix: tally facts only on the dealt stream
b755b67f feat: tally damage facts per group with provenance
04361fee fix: keep non-positive damages out of crit clustering and close review gaps
47c3c83c feat: assemble per-hit damage facts with measured and inferred provenance
2963df6a feat: assemble Overdrive chart windows from stored mode events
af204e11 test: pin every gate byte to its documented offset
e4cf22f7 refactor: drop inert dead_code allows from the facts interpreter
cd4f3741 feat: interpret raw damage-instance snapshots into gated facts
00b0b1a6 docs: correct the status-walk read count and record the taken-path snapshot tail caveat
05bd062d fix: pay the bypass-path snapshot copy only on the emit path
29bc7a61 feat: capture instance/source snapshot windows and raw status terms per hit
c68c5287 feat: raw window snapshot helper for per-hit capture
db856c6c refactor: rename snapshot fields, byte-string encoding, close compat-test gap
ad198873 feat: carry raw damage-instance and attacker snapshot windows on the wire
```
