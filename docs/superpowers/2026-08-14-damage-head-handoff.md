# Handoff — damage-head RE spike, 2026-08-14

Branch `feat/damage-head-oracle` (off `dev`), commits `12a639f5` (DMGHEAD
oracle) → `f14f7a4d` (round-1 scorer). Supersedes nothing; this opens the
damage-AMOUNT arc that `2026-08-14-cap-explainability-handoff.md` item 6
called for. Suites: oracle builds clean under the dev feature set; the
scorer's 5 unit tests green. Detailed formula tree lives in the gitignored
`docs/superpowers/specs/2026-08-14-damage-head-formula-tree.md`; durable
summary in the `damage-head-formula-re` memory.

## What the spike established (one static day + one live round)

- **The pre-cap formula is fully mapped** (v2.0.4). `d4 =
  (int)FUN_141f44920` — an 11-factor product over the attack chain
  (`FUN_141f43670`), crit, motion value (`inst+0xE0`), class record dmg%,
  the IStatusAttackBuff walk, Stamina/Enmity HP-curves, Lumen/Nyx,
  target-state traits, and the difficulty scalar. `d0` = chain × crit ×
  MV. Variance is ONE-SIDED (+0–5%), gated on two flag masks (any-bit).
- **All trait tags named** — tag = `gameXxhash32(SKILL_###_## key)`.
  Gate bytes decoded: `+0x15D` crit, `+0x15E` weak point, `+0x15F` back
  attack, `+0x160` internal ×1.2 state (SKILL_015_00), `+0x161` debuffed,
  `+0x162` Overdrive, `+0x163` Break. Class flag `0x20000` = Link Attack.
- **Round 1 (Pl2700 solo, 499 joined hits) proved the attacker side**:
  `d0 == trunc(chain × critMult × MV)` on 499/499 with critMult exactly
  2.550 all round; the Skill class ratio matched the record term
  (`1 + dmg_skill×0.01 = 1.32`) exactly.
- **The `+0x22F0` virtuals are CLOSED for Pl2700** (and the route for all
  characters found): the slice is a base subobject of the character class
  — `table_rva` resolved to `Pl2700::vftable`. Slots `0x40/0x58` return
  1.0 and `0x80/0x88` return 0 in the base impl; slot `0x70` (the cap
  arc's `fVar30`) is Thunderwolf's Acuity (`0xBE3404B9`, SKILL_176_01)
  selected per action-id set + Pl2700 stack state. Enumerate every
  character statically with `DumpVtableSlot.java "Pl" 0x40|0x58|0x70|0x80|0x88`.
- **`+0xE0` is the authored per-hit-PART power ratio** — small repeating
  value-sets per action id (e.g. 1310 → {0.96, 1.04, 1.6, 7.2}), so the
  forward model needs part-level identity, not just the action id.

## What round 1 could NOT close (the milestone-2 worklist, ranked)

1. **The target-side pre-clamp chain.** `precap@2d4 / builder d4` ran
   ×1.37–1.79, drifting — elemental × damage-taken debuffs applied inside
   ProcessDamageEvent between the builder call and the `0x2D4` store. The
   builder is attacker-side only. Entry point: decompile PDE
   (`0x1fb82d0`) between its builder call and the clamp.
2. **The quantized extra factors** {1.26000, 1.356, 1.512} on normal-class
   hits with identical gate bytes — a state outside the instance (the
   HP-scaled Stamina walk is the prime suspect). Resolution: a round-2
   oracle that also logs `FUN_140bd3d90`'s return and the
   45290/45430-scaled terms per hit, or model-from-loadout comparison.
3. **SBA class ratio unverified** — DMGDIAG's 500-hit cap meant no
   SBA-class hit joined. Either bump `DIAG_N` for one round or log d0/d4
   from the oracle itself at builder exit.
4. **Per-character slot sweep** (static, no game): `DumpVtableSlot` over
   `Pl*::vftable` for the five slots — also completes the cap model's
   extras term for every character.
5. **Crit multiplier decomposition**: measured exactly 2.550 vs record
   critdmg 135% — the remaining 20 points are the crit base
   (`slice+0x140`) + Lucky Charge; verify once slot values are swept.

## Milestone 2 — target-side PDE decompile (2026-08-14 pm, static, DONE)

The whole ProcessDamageEvent pipeline is now mapped (detail + decompile
paths in the gitignored formula-tree spec, "PDE FUN_141fb82d0" section).
Headlines:

- **Architecture settled.** PDE's a1 is the target's **ExDamage**
  component (per-class 26-slot vftables, 371 total: 121 Em-base / 36
  Pl-base / 53 stage-object / 133 stub / ~15 boss overrides). The hook's
  "specified instance" actor ptr is a subobject at **holder+0xD00**; its
  25-slot vftable carries the damage builder at +0x58 and the stun
  builder at +0x60 — **both are called INSIDE PDE** (step 3), after the
  Em gate-byte writer (step 1) refreshes `+0x15E..0x163/0x168` from live
  target state. Weak point = authored part flag by part id `inst+0x148`;
  back attack = the <90° angle test; `+0x160` = target action inside an
  authored vulnerable window.
- **The ×1.37–1.79 final/precap gap is the post-cap chain**, now fully
  decomposed: elemental advantage mult (`1 + base@+0x2488 + agg(0x1A)
  pair + record+0x5964%`), × the **Amplify chain** (ΣIStatusAmplifyBuff
  ± , Celestial Aqua/Ventus + textless SKILL_168_00 traits, EDL_CHAOS
  per-action row, agg ids 3/0x23/0x30), + the **at-cap-only overflow**:
  `cap × k@+0x249C × (ATK-buff-chain − 1)` — ATK buffs pierce the cap on
  capped hits. Sync-quest min-clamp last (`inst+0x154`, quest row).
- **Variance site corrected**: for enemy targets the +0–5% roll is in the
  Em taken-chain (`FUN_140b283d0`), not the builder's flag-gated copy
  (which never fired in round 1). Two unknown Em-actor virtuals
  (+0x728/+0x730) run just before it — the only still-unread pre-precap
  step.
- **Player-taken damage** (`FUN_1409b85f0`): DEF aggregator pair (ids
  1/0x21), per-element taken-trait table `DAT_1459b0bd0`, Garrison +
  Stronghold as HP-curve DEF traits, %-max-HP damage on flags bit 0x3A,
  and a hard 999,999 clamp on player-taken hits.
- **New trait names**: Garrison, Stronghold, Steel Nerves, Steady Focus,
  Celestial Aqua {amplify, Break/mode-gated}, Celestial Ventus
  {amplify}, textless SKILL_026_00 / SKILL_035_00 / SKILL_168_00.
  New aggregator param ids: 1/0x21 DEF, 3/0x23 amplify, 0x1A elemental,
  0x30 amplify-conditional.

Still open in milestone 2: Em +0x728/+0x730, the ~15 boss-specific taken
overrides, provenance of `+0x2488/+0x248C/+0x2490/+0x249C`, live
verification of the post-cap decomposition (extend the oracle to log
elem/amplify/overflow terms per hit), and the original items 2–5 below.

## Tooling (copy, don't re-derive)

Capture: dev hook (`hookdiag` build) → play a NON-SYNC quest → extract
with `grep -E "DMGHEAD|DMGREC|DMGEXTRAS|DMGDIAG|CAPORACLE" gbfr-logs.txt`
(3.7 GB log — never read whole). Score:
`cargo run --release -p gbfr-logs --example dmg_head_check -- <capture>`.
Trait naming: scratchpad `dmg_tag_match.py` pattern — hash SKILL keys with
`scripts/gbfr_hash.py`, match against `lang/en/traits.json`;
skill_status.tbl extraction via GBFRDataTools
(`-p:NoWarn=NU1605 -p:RunAnalyzers=false`) from `G:/SteamLibrary/.../data.i`.

## Rulings in force

Level-sync quests are excluded from ALL cap/damage modeling — detect and
drop, never model (`exclude-level-sync-quests` memory).
