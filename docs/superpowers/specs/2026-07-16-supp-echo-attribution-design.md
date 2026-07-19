# Supplementary/Echo Attribution Per Skill — Design

**Date:** 2026-07-16
**Status:** Approved

## Problem

Supplementary Damage and Echo procs deal a fixed fraction of their trigger hit's
damage (20% and 40% respectively) and bypass damage caps, so they are a large
part of post-2.0.2 DPS. The meter lumps every proc into one "Supplementary
Damage" row. Users cannot see which skills triggered the procs, how often they
trigger, or how much damage each skill really contributes.

## Findings that shape the design

Analysis of logs.db (2026-07-16, temp probe `src-tauri/examples/supp_scan.rs`):

- Every `SupplementaryDamage` event carries the **trigger skill's action_id**,
  so per-skill attribution needs no hook or protocol changes.
- Proc damage is exactly **0.2×** or **0.4×** the trigger's final displayed
  damage. Flags do not separate the two populations; ratio is the only
  discriminator.
- Caveat: pre-patch logs show 0.24/0.25 tails (0.2 × old crit multipliers) and
  almost no 0.4, so the 0.4 population may be critted supplementary rather than
  a distinct Echo mechanic. The user reports they are separate mechanics. If
  that proves wrong, only the column labels are wrong — the plumbing is
  identical.

## Design

### Parser (`src-tauri/src/parser/v1/`)

`SkillState` gains four `#[serde(default)]` fields:

| Field | Type | Meaning |
|---|---|---|
| `supp_hits` | u32 | procs classified as Supplementary (≈0.2×) |
| `echo_hits` | u32 | procs classified as Echo (≈0.4×) |
| `supp_damage` | u64 | damage attributed to Supplementary procs |
| `echo_damage` | u64 | damage attributed to Echo procs |

`SkillState` also keeps a `#[serde(skip)]` ring buffer of the last 8 hit
damages (the `cappable_samples` pattern) for ratio matching.

In `PlayerState::update_from_damage_event`, a `SupplementaryDamage(aid)` event:

1. Updates the merged "Supplementary Damage" row exactly as today. Parser
   output stays backward-compatible; the toggle is purely presentation.
2. Finds the skill row keyed `Normal(aid)` with the same child character type.
   If none exists, stop — the proc stays only in the merged row.
3. Classifies by ratio: compute `proc_damage / hit_damage` against each hit in
   the row's ring buffer and keep the ratio closest to 0.2 or 0.4. Below the
   0.283 midpoint → Supplementary; at or above → Echo. An empty buffer →
   Supplementary. Measured on the 10 most recent logs (ids 230–239,
   2026-07-16), this classifies 93–100% of procs to a near-exact 0.2/0.4 match,
   versus 84–92% for "previous hit is the trigger" (the game batches multi-hit
   and AoE damage events before their procs, so strict ordering fails).
   Refinements:
   - Hits on the proc's target are tried first; an exact match there
     (|r − target| < 0.002) ends the search. Exact matches elsewhere also end
     the search — nothing can beat them.
   - Ambiguous procs (window contains both a clean 0.2 and a clean 0.4
     candidate — hits in a 2× ratio; measured at 0–1% per encounter)
     tie-break to the same-target candidate, then to the most recent.
   - Window size 8 comes from a sweep on logs 244–247: clean-rate rises
     steeply to K=4, plateaus by K=8 (95.4–98.2%), and stays flat through
     K=16 while the ambiguity rate roughly doubles. Larger windows add only
     coin-flip cases.
4. Increments the chosen counters on that skill row.

Ferry's remapped pet action_ids keep their existing behavior; attribution for
her pet-skill procs may be imperfect. Known limitation, out of scope.

### Frontend (`src/`)

**Setting.** New persisted `merge_supplementary: boolean` in
`useMeterSettingsStore`, default false, with a checkbox on the settings page
beside the condensed-skills option.

**Types.** `SkillState` in `types.ts` gains `suppHits`, `echoHits`,
`suppDamage`, `echoDamage`.

**Toggle OFF (default).** The breakdown table adds two columns: **Supp%**
(`suppHits / hits`) and **Echo%** (`echoHits / hits`). The Supplementary Damage
row renders as today, blank in the new columns.

**Toggle ON.**

- The merged Supplementary Damage row is hidden — but only when its damage is
  fully attributed. If classification left a remainder (procs with no matching
  skill row), a residual "Supplementary Damage" row shows that remainder so the
  encounter total never silently loses damage.
- Each skill row's Total, Avg, %, and the sort order use **combined** damage
  (own + supp + echo), computed in `useSkillBreakdown`.
- Two more columns, **Supp** and **Echo**, show the attributed damage amounts.
- The damage bar renders three segments: own damage in the row color, supp in
  a lighter shade, echo lighter still (same hue, reduced opacity).

**Groups.** Condensed skill groups sum all four new fields. Min/max stay
own-damage-only.

Column headers are hardcoded English in `SkillBreakdown.tsx`, matching the
existing columns.

## Out of scope

- Hook, protocol, and DB changes (none needed; old logs re-parse).
- Player-level supp/echo totals in the main meter rows.
- Distinguishing Echo from critted supplementary beyond the ratio heuristic.

## Testing

- Parser unit tests (TDD): 0.2 classifies as supp; 0.4 as echo; interleaved
  multi-hit skills match the best recent hit; empty buffer defaults to supp;
  missing skill row attributes nothing while the merged row still counts;
  serde default round-trip for old states.
- Frontend: `npm run build` typecheck, existing vitest suite, and a manual
  visual check of bar segments and columns via `npm run tauri dev`.
