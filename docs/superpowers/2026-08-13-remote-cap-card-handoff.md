# Handoff — the remote-prediction cap card, 2026-08-13 (evening)

> **SUPERSEDED 2026-08-14** by `2026-08-14-cap-explainability-handoff.md` —
> start there. This file is the history: the feature as designed, plus the
> banners below recording how its open items resolved. The body's "open
> questions" and "Also open" lists are all settled or carried forward.

> **SHIPPED 2026-08-13 (late evening)** through `feat/remote-sba-gains`.
> Design + plan in `docs/superpowers/{specs,plans}/2026-08-13-remote-cap-card*`
> (gitignored). The open questions below resolved as: (1) remote hits carry
> everything except the cap fields, so the prediction is per-hit; (2) title
> "Predicted cap" + `≈`, computed Unresolved row; (3) capture-era only — no
> 684 rule, no sync detection; (4) card only; (5) deferred with (3). The
> blind-local sweep (86,440 hits) proved the arithmetic exact for complete
> factor models, put Rosetta (constant ~27% undershoot) and Seofon (~5x
> OVERprediction, cause unknown) on the denylist beside Fediel, and measured
> the Eustace/Zeta/Id/Rackam undershoots at p50 1–3%. Still pending: a manual
> eyeball of the predicted card on lobby log 2654, and the Seofon cause.
>
> **FOLLOW-UP 2026-08-14** — the requested Rosetta/Fediel/Seofon local
> capture landed as log 2655 (4,255/1,406/2,326 captioned hits) and shrank
> the denylist to Rosetta alone:
> - **Seofon cleared.** Exact on 2,326/2,326 non-SBA hits. The "~5x
>   overprediction" was ENTIRELY level-sync contamination: his only prior
>   hits were 78 in sync quest 2622. The blind sweep now evaluates first and
>   drops any log whose median hit OVERSHOOTS (>10%) whole — that caught
>   exactly 2619/2621/2622, the known sync family, and nothing else.
> - **Fediel cleared.** Median ratio 1.000 on both her logs; the coverage
>   doc's "stable unknown cap source" (off-grid K≈307.3) is just her
>   off-grid capUp store, which the prediction consumes directly. Misses are
>   transient additive +10%/+30% undershoots (p50 6.6%), the Zeta class.
> - **Rosetta measured, still denylisted.** One flat class-independent term
>   the model doesn't carry: +2.33 (log 2567) / +2.635 (log 2655) of ladder
>   base — per-loadout, on the half-percent grid — plus status-correlated
>   increments (+0.05/+0.10/+0.25/+0.30/+0.45; statuses 7/42/57 implicated).
>   Same shape as the buff-carried terms ([[cap-buff-term-field]]).
> Still pending: the manual card eyeball on lobby log 2654, and naming
> Rosetta's flat term.
>
> **AUDIT + TIGHTENING, same day (`641c466d`)** — Scott asked whether the
> sweep's tolerance buckets hid shortcuts; two did. (1) The "Zeta ~5x
> transients" were 57 summon-class hits whose cap is exactly the bare
> SO0000 ladder base — now modeled (`isSummonClass` → predict base only,
> card + sweep; all 57 exact). (2) The open-channel bucket exempted any
> mismatch with an open potential; it now only excuses undershoots within
> unresolved × base, moving the error bars to honest values (Rackam p50
> 2.8%→7.4%, Io 19.4%; bucket 56k→32k hits). The direction gate gained a
> worst-overshoot <50% magnitude ceiling. Corpus sweep green on merit.
> North star recorded: EVERY damage event should be explainable — the cap
> forward-model is ~closed; the damage-AMOUNT forward model (motion value ×
> attack × multipliers) is not built and is the next big arc.

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
