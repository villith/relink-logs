# Stun-eligible-hit columns for the skill breakdown

## Problem

The meter shows total stun value, but a hit that lands while the boss is
already stunned or is stun-immune contributes **0** stun. That 0 is correct,
but it silently dilutes any "how much does this skill stun" reading and there is
no way to tell it happened. The user wants, **on the ability (skill-breakdown)
rows only**, two new columns:

1. **Stun Hits** — the number of hits that actually applied stun.
2. **Stun / Hit** — average stun per such hit.

## Definition of a "stun-eligible hit"

A hit counts as stun-eligible when it is a stun-capable action (i.e. **not** a
supplementary/echo hit and **not** a DoT tick) **and it actually applied stun**
(stun amount > 0). A stun-capable hit that dealt 0 stun because the target was
stunned/immune does **not** count — that is the whole point: comparing the plain
`Hits` column against `Stun Hits` reveals the wasted-stun situation.

`Stun / Hit` = `totalStunValue / stunEligibleHits` (0 when there are no eligible
hits), computed on the frontend — not stored.

## Scope

- **Skill-breakdown rows only** (both individual `SkillRow` and condensed
  `SkillGroupRow`). No player-row / main-meter columns — explicitly declined.
- Both columns are **opt-in** via the existing customizable skill-column picker;
  they are **not** added to `DEFAULT_SKILL_COLUMNS`, so no existing layout
  changes.
- Perfect Guard rows deal real stun and count naturally as stun hits.

## Solo vs online (why a mirrored count)

Stun is observed two ways, and the count must work in both:

- **Solo** — a per-hit accumulator delta. We see stun per individual hit, so
  "count hits whose stun delta > 0" is exact.
- **Online** — the per-hit delta is structurally 0 (host-authoritative); stun
  arrives as separate `OnPlayerStun` messages attributed to the last
  stun-capable skill row.

So mirror the pattern the code already uses for the stun *value*
(`total_stun_value = max(delta_sum, message_sum)`) for the *count*:

```
stun_eligible_hits = max(stun_delta_hits, stun_message_hits)
```

- `stun_delta_hits` increments on a delta-path stun with amount > 0
  (`SkillState::add_stun_delta`).
- `stun_message_hits` increments on an attributed network stun message with
  amount > 0 (`SkillState::add_stun_message`).
- `max()` dedupes the solo-loopback case (both paths fire) exactly like the
  value total does. Solo → delta wins; online → message count wins.

The value path (`total_stun_value`) is **unchanged**; the count is purely
additive.

## Data model

`SkillState` (Rust, `src-tauri/src/parser/v1/skill_state.rs`) gains, all
`#[serde(default)]`:

- `stun_delta_hits: u32`
- `stun_message_hits: u32`
- `stun_eligible_hits: u32` — derived; refreshed alongside `total_stun_value` in
  `refresh_total_stun` as `stun_delta_hits.max(stun_message_hits)`.

No `PlayerState` / `DerivedEncounterState` changes.

`types.ts` mirrors `stunEligibleHits` onto `SkillState` and `ComputedSkillGroup`
(summed across grouped skills in `useSkillBreakdown`).

## Frontend surface

- `SkillColumns` enum: `StunEligibleHits = "stun-hits"`,
  `StunPerEligibleHit = "stun-per-hit"`. Not in `DEFAULT_SKILL_COLUMNS`.
- `SkillRow` / `SkillGroupRow`: render the count directly and `Stun/Hit` from
  `totalStunValue / stunEligibleHits`; the PerfectGuardQuickening dash branch
  already dashes any non-Hits column.
- `en/ui.json`: `ui.skill-columns.stun-hits(+-description)` and
  `...stun-per-hit(+-description)` (only the `en` file is hand-edited).

## Backward compatibility

Logs reparse from the raw event log, so existing **solo** logs gain the count on
reparse; old cached blobs deserialize via `#[serde(default)]`. Online logs
predating this gain the message-path count on reparse too (messages are in the
raw log).

## Tests

- Rust (`skill_state.rs`): delta path counts a stunning hit and excludes a
  0-stun (immune) hit and supp/DoT rows; message path counts; `max()` dedupes
  delta-vs-message.
- Frontend (`SkillRow.test.tsx`): a row renders its stun-hit count and the
  Stun/Hit average when those columns are shown.
