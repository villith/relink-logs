# Handoff — damage-cap session #4, 2026-08-10 late night

Branch `feat/damage-cap-oracle`, everything committed through `35823296`;
working tree clean (the untracked `src-tauri/examples/supp_pair_probe.rs`
predates this session). Offline state: tsc 0; `src/pages/logs/view` full
suite green (108 files / 1360 tests) plus the generator suites; cargo
untouched. Supersedes `2026-08-10-cap-session-handoff-3.md` for the
attack-group/unaccounted arc; handoff-3 still holds the solver/engine
background and the morning handoff the oracle format.

## What this session closed: Eustace's "300–400% unaccounted" (log 2573)

Method (cheap to rebuild): a throwaway vitest file next to capExplain that
joins `scratchpad/oracle.txt` (rg CAPORACLE of the 2.7 GB app log) to
`cargo --example cap_evidence` dumps via `solve-attack-groups.mjs`'s own
exported `splitSessions`/`alignOffset`/`joinHits`, then runs the REAL
`explainCapHit` per hit and prints per-action medians. Joined 528/528.
Gotcha: the test env never runs the skill-name-sources asset loader —
call `setSkillNameSources(...)` from `src-tauri/assets/` or ability-scoped
nodes read `unknown` that the app resolves fine.

The decomposition proved exact, and three commits landed:

1. **`0d98d11d` Sigil Booster.** The flat +18% on every hit of every
   local player = DMG Cap trait at level 63 not 60: the terminus innate
   Sigil Booster (live variant id 0x57E92E3F, base 0x57E8A93F) adds its
   level to EACH equipped sigil's traits; DMG Cap sat on 3 sigils.
   `dmgCapTraitValue` now adds booster × sigil-instance-count. The trait
   ladder pins it: level 60 = 220, 63 = 238. NOTE: enumerateTraits /
   record components / conditional traits are still UNboosted
   (record-side is informational; TW's table clamps at 15 so its A/B
   values are unaffected).

2. **`c179b242` Channel crediting.** `CapFactor.placement` splits the
   game's two stores, oracle-proven: counted-sigil board nodes NEVER
   appear in a hit's FreeWork `terms=[]` — they are fused into the
   captured record (they are 2×100 of Eustace's 1668) — while
   always/attack-group/gated/grants-status nodes ARE the per-hit channel
   (modeled actives match the oracle multiset EXACTLY on every normal
   action). Active channel factors now join `attributed` in the debug
   panel (rendered depth-1 beside the record, not as record sub-rows)
   and in the hover card (one aggregate "Derived channel terms" row via
   `deriveChannelTotal`; `EventRow.capConditions` built by
   `conditionsForHit`, threaded through EventsTab → AmountCell).
   Conditional traits stay rendered-never-summed (Scott's 2026-08-08
   ruling — untouched).

3. **`35823296` g10 solved.** `ability_group.tbl` = 56-byte rows,
   435 = 29 characters × 15 group keys, 12 member-ability slots each.
   Group `819ee45b` (what every "Skill DMG Cap +35%" node points at) is
   EMPTY for every character, and the engine reads an empty group as
   "every skill" — proven by the node riding every skill hit. The
   generator (`gen-skillboard-cap-sources.mjs`) now takes the table as a
   6th input and resolves AbilityId1: direct ability kept (0097's
   aea6d151 = Heaven Comes Down, action 1700 — bridges fine), group with
   members expanded, empty group widened to `scope:"always",
   capClass:"skill"` (59 effects). Asset regenerated; diff was exactly
   the widening.

Post-fix reconciliation, log 2573 Eustace (was 389–556% everywhere):
110/120/1700 = **0**; 1310 ≈ 11 (buff terms); 121/125 ≈ 21/26 (TW 10/15
+ buffs, TW excluded from the sum by ruling); 115 ≈ 26; 130/140 ≈ 78.

## Side discoveries recorded (memory: cap-source-derivation-feasibility)

- **Party-dependent +50**: present in party logs 2571/2573, absent in
  solo 2574/2575, loadouts bit-identical — and it lands in the captured
  record OR the runtime extras depending on capture timing vs party
  assembly (2571: record 1618 + 50 extra; 2573: record 1668, no extra).
  Never treat the captured record as loadout-derivable.
- **Live weapon-innate ids are upgrade-resolved VARIANTS** absent from
  the trait tables (0x79052848 vs table 79027fc8 "Unbound Master",
  0x7CD1C74F vs f17850b9) — they contribute 0 to the modeled record
  components. Part of why modeled components reach only 868 vs the
  1668 captured (with 2×100 counted nodes and booster inflation);
  display-only gap, no unaccounted impact.
- Pl1900 = Id; Pl2800 the other AI. Trait 1e1cecce (Catastrophe Nova
  conditional, +500 potential) evaluates ACTIVE via an hpAtMost check
  that is almost certainly wrong semantics — harmless today
  (conditionals never sum) but worth a look before anyone credits
  conditionals.

## Open items, suggested order

1. **Live spot-check** (needs the game): hover Eustace damage rows —
   the card's new "Derived channel terms" row and shrunken Unaccounted;
   the debug panel's channel rows at depth 1. Also confirm no jank from
   evaluating factors per hovered row.
2. **The unidentified action extras**: Eustace 115:+15, 130:+25 (beyond
   TW's +20), 140:+45; Id flat +20 on every hit. Constant per action,
   loadout-independent across all four logs, invisible to BOTH capture
   streams (the Thunderwolf path). A/B cannot reach action-inherent
   bonuses — candidates are the engine-defined keystones (the
   `unknown:0` board rows); needs keystone valuing or RE of the
   runtime-extras evaluator.
3. **Buff-magnitude factor family** (open since the morning): 56→50%,
   118→11%×stacks, 125→5%, 74→5%, 83→20%, status 55 ladder 270–310%.
   Now the LARGEST remaining unaccounted share on most actions. Design
   question for Scott still outstanding (credit from the hit's own
   status snapshot?).
4. **Record itemization** (display-only): map variant innate ids to
   their table skills (deriveTranscendence already handles variants
   positionally — reuse), apply Sigil Booster to enumerateTraits'
   levels, and the record-explained % gets honest. The party +50 means
   perfect closure is impossible by design — document, don't chase.
5. **Conditional/named mechanics needing oracle runs** (unchanged from
   handoff-3): Lancelot g15/g16, Siegfried g19, Charlotta g16, Yodarha
   g15, Sandalphon g5, Gallanza g16, Maglielle g15, Beatrix g15, Zeta
   g17, Seofon g5 — solo runs with the nodes unlocked; solver + audit
   close them. Plus the 14 engine-silent one-off families (Scott
   one-liners).
6. **Per-hit capture** (release path, unchanged): detour the two
   aggregators (`0x6cf390`, `0x766ad0`); runtime extras still ride
   neither, so the per-action evaluator stays necessary.
7. **UI surfacing** of evidence classes / input icons — still ask Scott
   first.

## Tooling notes added this session

- `GBFRDataTools.exe` at
  `C:\Users\Scott\Projects\GBFRDataTools\GBFRDataTools\bin\Release\net10.0\`,
  game at `G:\SteamLibrary\steamapps\common\Granblue Fantasy Relink\data.i`.
  Extracted tables live in the session scratchpad under `tbl/system/table`.
- Regen now needs ability_group.tbl too:
  `node scripts/gen-skillboard-cap-sources.mjs <dir>/system/table`.
- `npx eslint scripts/...` directly reports process/Buffer no-undef —
  pre-existing config scope (lint covers ./src), not real errors.
