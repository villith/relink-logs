---
name: validating-models-against-logs
description: Use when a reverse-engineered table or formula — SBA gauge weights, the damage-cap model, stun values, any per-hit quantity the parser computes — needs verifying against real gameplay; when pricing ids or values the game data does not author; when tempted to trust a fit from one or two samples; or when about to ask for a live capture round to check derived constants.
---

# Validating Computed Models Against the Log Corpus

## Overview

`src-tauri/logs.db` (the dev copy — the AppData one is empty) is not just
history: it is a **labeled measurement corpus**. Encounters store the raw
event log, and the hook-read fields in it are ground-truth labels a model can
be scored against offline, hit by hit: captioned SBA gains
(`SbaGainCause::Skill(action)`), the per-hit `damage_cap` on every
`DamageEvent`, buff lists, stun deltas. Core principle: **exhaust the corpus
before asking for a live round.** The SBA weight table went to 68/68 verified
(character, action) values with zero live play; treat a proposed capture
session as a smell that the corpus hasn't been mined yet.

## The loop

1. Implement the model as a pure function/table in the parser crate, loadable
   by examples (the `sba_weights.rs` / `assets/*.json` shape).
2. Write a **committed diag example** in `src-tauri/examples/` that replays
   EVERY log and scores model vs ground truth per (character, id). Give it
   three modes: corpus-wide sweep, single-log detail dump (`--dump-log` — for
   identifying what an unknown id physically IS from its damage signature and
   company), and targeted-id measurement.
3. The sweep must emit **its own worklist**: every unexplained value, ranked
   by implicated magnitude, with a candidate solve where one exists (always
   printing n and max deviation).
4. Resolve the top worklist entries — game data first (the extracted table
   catalog beats guessing), measurement decides when the data is ambiguous or
   silent. Write provenance into the table (see below).
5. Re-run the sweep. Iterate until the worklist is **empty**. The sweep then
   becomes the regression gate you re-run after every game patch.

## Key moves

- **Absolute vs scale-ambiguous — decide first.** Cap values are absolute:
  score them exact, no tolerance bands, ever. Gauge-like quantities are only
  measurable up to a per-fight constant K: find an **authored anchor present
  in every log** (LinkAttack = 5.0 for SBA) and divide it out. K cancellation
  is what makes offline verification possible at all; without an anchor,
  ratios between values are still exact evidence.
- **Zero is a measurement, not a default.** N hits with zero associated
  ground-truth signal proves the value is 0 — and the claim must state N
  ("317 summon hits across four characters, 0 captioned grants"). File it
  with that provenance, same standard as a nonzero value.
- **Exact clusters beat noisy fits.** Captioned local slots yield exact
  repeated values (Ferry 9995 measured as precisely {0.0439, 0.1385, 0.2});
  indirect/remote fits are leads only. **A fit with n≤2 or high deviation
  goes on the worklist, never in the table** — the remote n=2 solves for
  action 80000 said 0.16–0.58; the corpus said exactly 0.
- **Classify misses honestly, in named buckets** (contaminated, unknown-id,
  no-evidence…), and drop contaminated samples WHOLE — contamination must
  never read as model drift. Fit with **medians**, report sums separately:
  sums are pulled by unobservable contamination (K_med < K_total turned out
  to be invisible damage-taken gauge, not drift).
- **Errors must fail honest.** Prefer the failure mode that under-claims (an
  explicit unnamed remainder) over one that invents values. Check the
  DIRECTION of residual error before accepting it as tolerable.
- **Provenance lives in the table.** Every value carries a confidence tier
  (`verified`/`high`/`med`/`low`), its source, n, and the log ids it was
  measured from — so the next game patch's re-derivation re-verifies
  mechanically (the `build_final.py` MEAS pattern) instead of re-arguing.

## Repo mechanics (copy, don't re-derive)

- Decode: `Encounter::from_blob(&blob)` → `repopulate_event_log()` →
  `event_log()`. Slot→character via
  `sba_inference::character_aliases(&encounter.player_data)` — identity comes
  from the roster, NOT the event log, and must alias both raw actor_index and
  slot keys. Open sqlite read-only. Copy the `gather` pattern from
  `sba_share_check.rs` / `sba_grant_scan.rs`.
- A slot is trustworthy ground truth only when hook-read gains explain ≥50%
  of its polled total (`LOCAL_READ_FRACTION`) — measure on captioned local
  slots, validate models on them first, then check remotes.
- Run examples with `--release`; run tests as
  `cargo test -p gbfr-logs --lib <module>` in DEBUG — the release test binary
  inherits the admin manifest and dies with "requires elevation" (os 740).
- Worked examples: `sba_grant_scan` (targeted measurement, `--dump-log`,
  `--taken-lag`), `sba_share_check` (sweep + worklist + whole-fight
  tracking), `sba_infer_score` (shipped-pipeline replay scored against
  captioned truth), the `cap_*` family (per-hit `damage_cap` ground truth).

## When a live round IS earned

Only when the corpus provably cannot discriminate (both branches of a
stack-or-replace hypothesis produce identical stored logs; a character/id
appears in no captioned local slot). Then: ONE targeted round with a written
checklist, a control measurement on the LOCAL slot first (a failed control
voids the experiment), single-variable deltas, and the anchor in view to pin
K.

## Common mistakes

| Mistake | Reality |
|---|---|
| "We need a capture session to verify this" | 1,800+ logs already hold labeled per-hit ground truth. Mine them first; live time is the scarcest resource. |
| Trusting an n=1/n=2 solve | Small-n indirect fits have been off by ∞ (0.16 vs true 0). Worklist it; measure it from captioned locals. |
| Widening tolerance / fitting a fudge factor to make numbers pass | Every mismatch is a missing input, wrong constant, or capture bug. Resolve by RE or mark unsupported — never curve-fit. |
| Reporting "no signal → value unknown" | Absence over stated-N hits IS the measurement: the value is 0. |
| Reading sum-based statistics as model drift | Unobservable contamination inflates sums, not medians. Compare both; investigate the gap before blaming the model. |
| A scan's null result reported as "not in the data" | Say what you searched and what that method cannot see (case/spelling-insensitive sweeps: `spartsGageRate` hid from every `spArtsRate` grep). |
| One-off scratch scripts for scoring | Commit the example. It is the patch-day regression gate and the next id's curation tool. |
