# Sup +% player column (supersedes per-skill supp/echo attribution)

Date: 2026-07-16
Status: approved (replaces `2026-07-16-supp-echo-attribution-design.md`)

## Problem

The per-skill supplementary/echo attribution feature (merge toggle, Supp/Supp%/Echo/Echo%
skill columns, segmented damage bars, ratio-based proc classifier in the parser) is too
confusing in practice. There are three sources of supplementary damage — the supplementary
sigil, Berserker echo, and Spartan echo — each proccing an extra 20% of the trigger hit
(never crits, never capped), stacking to at most +60%. Because the per-proc amount is a
known constant, per-skill breakdowns add noise without insight.

## Decision

Remove the per-skill attribution end-to-end and show a single **Sup** column on the player
row displaying the player's realized extra damage from all supplementary sources:

```
Sup +% = suppTotal / (playerTotal − suppTotal) × 100     (rendered as "+42%")
```

`suppTotal` is the total of the merged "Supplementary Damage" skill row, which pre-dates
the removed feature and already aggregates all three sources. Values naturally range
+0%…+60% (bounded by the stacked proc rates). No parser changes are needed to compute it.

## Scope of removal

- **Parser:** `ProcKind`, `classify_proc`, the `recent_hits` ring buffer, ratio constants,
  and the `supp_hits`/`echo_hits`/`supp_damage`/`echo_damage` fields on `SkillState`;
  the attribution block in `PlayerState::update_from_damage_event` reverts to the original
  "merge all supplementary events into one row" loop. Safe for old logs: only the raw
  `Encounter` is persisted; derived state is recomputed on load.
- **Frontend:** `merge_supplementary` setting + Settings checkbox, `mergeSupplementaryRows`
  helper and tests, per-skill Supp/Supp%/Echo/Echo% columns, segmented supp/echo damage
  bars + CSS, `totalDisplayDamage`/`suppPercentage`/`echoPercentage` computed fields, and
  all `[echo-debug]` logging.

## Addition

- `MeterColumns.SupPercentage` (`"sup-percentage"`): available as an overlay column
  (addable in Settings), always shown in the non-live log view table, sortable.
  Computed in a shared `computeSupPercentage(player)` util (unit-tested) used by
  `usePlayerRow` and `sortPlayers`. Rendered as `+N%`.
- i18n: `ui.meter-columns.sup-percentage` ("Sup") + description in `lang/en/ui.json`;
  other languages fall back to English.
