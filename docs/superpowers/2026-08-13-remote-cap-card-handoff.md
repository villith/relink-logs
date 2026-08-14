# Handoff — the remote-prediction cap card, 2026-08-13 (evening)

Branch `feat/remote-sba-gains`, continuing from
`2026-08-13-cap-validation-handoff.md` (all its workable items closed).
Scott approved this feature as the next session's item 1. **Start with the
brainstorming skill** — the presentation questions below are his to decide.

## The problem, verified

The events-view cap card (enabled today, `1faec317`) explains a hit from
its captured cap fields. True matchmade remotes have none: in lobby log
2654 the local player carries `damage_cap` + `base_damage` on 870 of
1,711 hits while the three remote slots carry **zero across ~9,200 hits**
— their damage arrives network-applied, outside the local cap builder.
The card therefore (correctly) never opens on a remote row. Enlisted
characters are local AI and already get full cards; only real co-op
remotes are dark.

## The feature

A remote row's Amount cell opens a **predicted** breakdown: cap estimated
from the remote's transmitted loadout plus their captured account store,
presented honestly as a prediction with its unresolved terms — never
styled as the ground-truth reading the local card gives.

## Every piece already exists

| Piece | Where | State |
|---|---|---|
| Factor model under per-hit conditions | `collectCapFactors` / `evaluateCapFactors` (`capFactors/`) | shipped; the probe drives it stats-only today |
| Ladder base per (character, rate, class) | `capLadder.ts` | shipped — but a remote hit carries no `attack_rate`/`class_flags` either; see open questions |
| Remote account store | census: remotes transmit their own `limitBonusCap*`/`capUp*` on capture-era logs | verified (2654, 2619) |
| Maxed-store fallback for storeless slots | predictor sweep (`roster_census --predictor`): ML55+6★+awaken10 ⇒ 684 in 311/317; misses = sync quests + per-character AP (Tweyen 331) | measured `971662fd` |
| Sync-quest exclusion | `quest-level-sync` memory: PWR-threshold sync; structural check needs quest base info's recommendedCombatPower (not yet extracted); fallback: a known-maxed player reading <684 marks the log synced | mechanism known |
| Prediction error bar | stats-only probe: offset = account + per-action attack-group terms + buff-level terms; per-loadout constants (Eustace +18, Zeta +43/+93) | measured, `cap-stats-only-probe` memory |
| Buff-carried terms | `cap-buff-term-field` memory: live term cached at `IStatusDamageLimitBuff`+8; production capture proposed, needs protocol/storage design | RE'd, not built |

## Open questions for the design session

1. **What does a remote hit actually carry?** No cap fields — but does it
   carry `attack_rate`, `class_flags`, `source_statuses`, HP? Check with
   the 2654 census pattern (five-minute scratch example; today's checked
   only cap/base). Without rate+class there is no ladder base per hit,
   and the card must predict at the class level instead of per hit.
2. **Presentation.** How loudly does the card say "prediction"? Distinct
   title? `≈` on every figure? A row for the unresolved slice (the
   probe's per-loadout constant + unresolved factors)? Scott decides.
3. **Store source order.** Captured store → 684 rule (only when proxies
   maxed AND log not sync-flagged) → otherwise show the equipment-only
   prediction with the account slice as an explicit unknown?
4. **Scope.** Card only, or also the debug panel's remote rows?
5. **Sync detection.** Ship the fallback rule now and extract
   recommendedCombatPower later, or block the 684 rule on the extraction?

## Also open from today (unrelated to this feature)

- The +25 on Eustace actions 130/140 — engine-defined per-action flat,
  worklisted in `cap-stats-only-probe`.
- Buff-term production capture design (protocol + stored-log versioning).
- Fediel / Rosetta logs; an Eustace hookdiag round confirms Flamek's
  0.11/0.22/0.33 terms directly (`buffs=[...]` in the oracle output).
- Eyeball the newly enabled local card on a busy fight — trim if too tall.

## Session state

Today's commits on `feat/remote-sba-gains`: `1ceb8520`..`1faec317`
(morning: residual scan, coverage table, probe, census; afternoon:
scatter solved, predictor sweep, level sync named, attack-group fix,
transition verdict shipped, buff-term RE, card enabled). All suites
green; `SHOWS_CAP_CARD` is now ON. Memory files:
`cap-stats-only-probe`, `quest-level-sync`, `cap-buff-term-field`,
`cap-off-grid-residual` — all current as of tonight.
