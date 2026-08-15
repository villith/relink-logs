# Handoff — cap explainability, 2026-08-14

Branch `feat/remote-sba-gains`, continuing from
`2026-08-13-remote-cap-card-handoff.md` (everything in it is resolved or
carried forward here). Working tree clean through `641c466d` +
`653f819e`; all suites, tsc, eslint green.

## North star (Scott, 2026-08-14)

**Every damage event should be explainable.** For any local or remote
player: what the hit was, base damage / pre-cap / post-cap, an itemized
breakdown of cap sources, and the buffs/debuffs that modified it — a
forward model simulated from captured state, compared against the game's
number, with every residual either attributed or on a worklist. Tolerance
without attribution is the failure mode; the
`validating-models-against-logs` skill is the method.

## Where the cap forward-model stands

- **Predicted cap card** (remote rows): shipped. `trunc(ladderBase × (1 +
  record + dmgCapTrait + activeChannel))`, `≈` styling, Unresolved row.
  `PREDICTED_CAP_DENYLIST` = **Rosetta (Pl0600) only** — Fediel and Seofon
  were cleared by the log-2655 capture (see the 08-13 handoff banners).
- **Summon path modeled** (`641c466d`): `isSummonClass` (class-flag bit 7)
  → predicted cap = bare `SO0000` ladder base, no player terms, in both the
  card and the sweep. Evidence: all 57 corpus summon-class capped hits log
  `cap == trunc(base)` exactly (log 2654, three rates) plus the decompiled
  separate curve path. One character so far (Zeta); wrong-direction risk is
  undershoot-only; the sweep re-verifies as more summon hits land.
- **Blind sweep tightened** (`641c466d`,
  `src/pages/logs/view/events/predictedCap.blind.test.ts`):
  - Level-sync guard: drops whole logs whose median hit overshoots
    (caught exactly 2619/2621/2622 across 500 logs — sync clamps more than
    the store, so captured-store predictions overshoot there).
  - Open-channel bucket only excuses an undershoot within
    `unresolved × ladderBase`; everything else feeds the error bars.
  - Direction gate: overshoots < 10% of hits AND worst overshoot < 50% of
    the logged cap (easing is percent-scale; factor-scale = missing branch).
  - WIRING gate needs a complete-model character with ≥500 hits at 100%
    exact — single-log fixtures fail it BY DESIGN.
- **Honest per-character error bars** (500-log corpus, post-tightening):
  exact 100% for Pl0000/0200/0800/1300/2100/2400; Seofon 97% exact (rest =
  the SBA +10% term); Fediel 73% exact (transient +10%/+30%); mismatch p50:
  Pl2700 1.5%, Zeta 2.3%, Id 3.5%, Siegfried 3.7%, Eustace 3.7%, Pl1000
  3.9%, Eugen 6.3%, Fediel 6.6%, **Rackam 7.4%**, Pl2800 9.8% (n=60),
  **Io 19.4%**.

## Tooling (copy, don't re-derive)

`cargo run --release -p gbfr-logs --example cap_predict_dump -- --last 500`
→ JSONL fixture → `CAP_BLIND_FIXTURE=<path> npx vitest run
src/pages/logs/view/events/predictedCap.blind.test.ts`. Gotchas:
PowerShell `>` writes a BOM the test chokes on (use `cmd /c` redirect);
run examples `--release`; the dev `src-tauri/logs.db` WAL holds recent
fights (check `logs.db-wal` mtime, not `logs.db`).

## Worklist, ranked by implicated magnitude

1. **Rosetta's flat term** (un-denylists her): +2.33 (log 2567) / +2.635
   (log 2655) of ladder base, class-independent, per-loadout, half-percent
   grid, plus status-correlated increments +0.05/+0.10/+0.25/+0.30/+0.45
   (statuses 7/42/57 in the non-base buckets). Leads: diff her two
   loadouts; the buff-term capture below would read it live.
2. **Io (Pl0400), p50 19.4%** — now the largest live gap. Also two small
   systematic OVERSHOOTS: `Normal:13010` ~5% and `Normal:214` ~0.8%,
   constant per log across many logs — a store term applying to actions it
   shouldn't (per-action exclusion, like the attack-group terms).
3. **Buff-term production capture** (`cap-buff-term-field` memory: live
   term at `IStatusDamageLimitBuff+8`) — needs protocol + stored-log
   design; shrinks every Unresolved row and likely closes Rosetta,
   Fediel's +10/+30, the SBA +10% on Seofon/Fediel.
4. **Sync detection for the card itself**: the shipped card has no sync
   guard, so on a level-sync log it overstates for ANY character. Fallback
   rule ready: a store-carrying roster where a known-maxed player reads
   <684 marks the log synced (`quest-level-sync` memory).
5. **Manual eyeball on lobby log 2654** — still never done. Now also
   covers newly-enabled Fediel/Seofon remote rows and a summon-class row.
6. **The next big arc — the damage-AMOUNT forward model.** Nothing models
   pre-cap damage (motion value × attack × multipliers); the meter reports
   what the game says. Entry point: the DamageInstance builder
   `FUN_1409c1cf0` (`damage-cap-formula-re` memory) — its cap tail is
   RE'd, its damage head is not. Plan this as its own effort.

## Memory files (all current tonight)

`remote-cap-card` (state + audit), `quest-level-sync` (sync ≠ store-only,
guard rationale), `damage-cap-formula-re` (the RE'd builder),
`cap-buff-term-field`, `cap-stats-only-probe`.
