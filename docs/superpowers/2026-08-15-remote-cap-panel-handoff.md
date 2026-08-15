# Remote-cap panel + record-resolver hunt — handoff (2026-08-15 afternoon)

Branch `feat/damage-facts`, through `e7968ea7`. This session merged
`feat/remote-sba-gains` into the damage-facts stack, made the cap debug tab
predict remote caps, fixed the builder-populated discriminator against real
online data, and cornered the record-capture failure to one instrumented
resolver. Supersedes nothing — read it WITH
`2026-08-15-damage-facts-handoff.md`, which still owns the capture layout and
live gates (a)/(c)/(d).

## Why the session started

The cap debug view showed blanks everywhere (Attack Chain "x held", target
DEF, elemental, at-cap overflow) and did no inference for remote players.
Investigation against online log 2657 (4-player lobby, 3 remote) found four
distinct causes:

1. **"x held" / elemental / overflow blanks** — the deliberate raw-value
   display deferral recorded in `93810d34`. The data IS captured
   (`source_snapshot` +0x2488/+0x249C, per-status `term_bits`); no `src/`
   code reads it yet. Scott wants these displayed — the deferral is now a
   TODO, not a decision. Note: 2657 shows elemental moves only on LOCAL hits
   (0 / 0.3 by target); remote hits always read 0, so the row is local-only.
2. **Target DEF / taken-side blank** — a real capture gap, not a deferral.
   The taken chain lives on the target actor (Em vfn+0x728/+0x730, Pl DEF
   chain); no captured window covers it. Needs new RE + hook capture work.
3. **Remote cap inference absent** — the predicted-cap machinery lived on
   `feat/remote-sba-gains`, a SIBLING branch off the same dev commit
   (`8a84b146`), never an ancestor. Scott had assumed the three branches
   were stacked; only oracle→facts was.
4. **A new bug**: the `d0 || precap` builder-populated rule read ALL 24,729
   of 2657's remote hits as measured, because d0 (+0xD0) arrives NONZERO
   over the network (the "both zero, log 405" assumption was wrong). The
   unstamped target-state gate bytes then presented as measured "no", and
   the window-inferred OD/Break fallback never fired.

## What landed (all on `feat/damage-facts`)

- `0e1990be` — builder-populated is **precap-only**, both copies
  (`damage_facts.rs`, `damageSnapshot.ts`), remote-signature tests pinning
  d0-nonzero/precap-zero as unpopulated. This ANSWERS live gate (b):
  target-state bytes are unstamped zeros on remote hits (local player on the
  same targets read debuffed 87%); the crit byte looks genuinely stamped
  (~94% remote vs 91% local) — a per-fact measured-widening candidate after
  a cluster cross-check.
- `74cc2aa2` — **merge of `feat/remote-sba-gains`** (36 commits: predicted
  cap card, blind sweep, grid-state registry, SBA weight-share validation,
  and `fix/hook-cleanup`'s process-relative exe lookup underneath). One
  content conflict (`CapTab.tsx`), resolved as a union: `hitPanels` now also
  feeds `gridStates` into `explainCapHit`. Both branches had already bumped
  the hook to 0.2.1 — the merged, unshipped hook keeps that single bump.
- `2ee085ab` — the blind sweep's fixture statuses map `term_bits: null` at
  the parse boundary (damage-facts made the field required on
  `SourceStatus`).
- `b0e7863e` — **the cap debug tab predicts remote caps.** `explainCapHit`
  gained `predictable` (CapTab passes `capPredictableKey(abilityKey)`); a
  capless predictable hit renders "3. Predicted cap (none logged)" in the
  cap-up section's place, using the events-card's own gates and arithmetic
  (denylist = Rosetta, summon path = bare ladder base,
  `trunc(base × (1 + record + DMG Cap trait + active channel))`). The
  predicted total is marked inferred (ⓘ); record components, conditional
  potentials and the unresolved remainder itemize under it; a declined
  prediction names its reason. Five TDD'd tests in `capExplain.test.ts`.
- `e7968ea7` — RECDIAG instrumentation (below).
- `facts_census.rs` (new committed example) — per-log, per-actor census of
  every capture field; the patch-day regression gate for the capture.

Verified fresh at session end: cargo lib 710, vitest events+debug 489,
tsc/build/lint clean.

## The record-resolver hunt (OPEN — one reload from an answer)

`record_snapshot` is None on EVERY hit ever captured — 2657 plus all nine
fresh-hook logs 2658–2666 (~23,000 hits; zero over that N is a measurement).
Everything else populates 100%, so the hook is current and
`resolve_player_record` (damage.rs) fails live on every call.

The decisive contrast: the SAME session's fern log shows `DMGREC` lines with
real record values — `dmg_oracle::player_record` resolves the identical
holder→vtable→+0x9F0 chain from the BUILDER's own pointer. The production
resolver differs in two ways, and the corpus cannot discriminate (no
captured window covers `attacker+0x2300`, no log line carries a player body
pointer):

- its base pointer: it folds to `specified_instance + 0x2300`, ASSUMING the
  damage detour's specified-instance pointer equals the builder's rcx;
- its guard: `9955e7a9` span-bounds vtable AND slot to
  `[module_base, +256MB)`, where the oracle only floor-checks.

`e7968ea7` therefore instruments every return branch with rate-limited
`RECDIAG` lines (32/session, hookdiag-only) carrying the pointer values.
The dev hook is BUILT (target/release/hook.dll, 12:12, full diag feature
set). **Next step: tray → "Reload hook (dev)", land one hit, read the fern
log** (`%APPDATA%\gbfr-logs\gbfr-logs.txt`, grep RECDIAG). The failing
branch names the fix:

- `holder-read-failed` / `vtable-read-failed` → the fold is wrong; capture
  the builder's rcx instead (BuildGuard-style handoff to the damage detour).
- `vtable-out-of-image` / `slot-out-of-image` → the span guard is wrong for
  a legitimate value; the logged delta says by how much.
- `getter-returned-null` → chain right, record absent at that timing.
- `ok` → the resolver works and the loss is downstream
  (`snapshot_window(record, 0x18, 0x10)`).

Until this is fixed, the panel's "record dmg%" row stays value-unrecorded.

## Other open items

- **Raw-value rows un-deferral** (Scott has asked for them): elemental
  (+0x2488, local-only), at-cap overflow k (+0x249C, read 0 in all logs so
  far), per-status `term_bits` on the "x held" row. Display labeled-as-raw.
- **Taken-side capture** — new RE: target-side DEF/taken-chain window.
- **Weak-point gate byte** reads 0 across ~12k populated hits in 2658–2666
  and 2657 — plausibly no weak-point targets in those quests; check against
  a Vulnerable-part boss before suspecting the offset.
- Live gates (a)/(c)/(d) from the damage-facts handoff remain.
- From the merged branch: Rosetta's flat cap term (un-denylist vehicle),
  lobby-2654 remote-card eyeball.

## Cleanliness

`scripts/__pycache__/gbfr_hash.cpython-310.pyc` (tracked, modified) and the
stray root PNG predate this session; neither belongs in a merge to dev.
