# Missing Skill-Name Backfill — Design Spec

**Date:** 2026-07-11
**Branch:** `fix/xpac`
**Status:** Approved (design), pending written-spec review.

## Goal

Find every player skill that actually occurred in saved encounters but has no name
string in `ui.json`, and stub each one with a marked placeholder so it can be filled
in by hand. This covers new/expansion skills whose IDs cannot be mapped to names from
extracted game data.

## Background & constraints

- Skill names resolve in the **frontend** (`getSkillName` in `src/utils.ts`) via an
  i18next fallback chain: `skills.<childCharacterType>.<id>` →
  `skills.<characterType>.<id>` → `skills.default.<id>` → `skills.default.unknown-skill`
  ("Skill {{id}}"). The last tier is the runtime "unresolved" state.
- Only `ActionType::Normal(id)` and `ActionType::DamageOverTime(id)` need per-character
  named strings. `LinkAttack`, `SBA`, and `SupplementaryDamage` resolve to fixed
  `skills.default.*` keys and are never "missing" in this sense.
- Saved encounters live in `logs.db` (`logs` table), one row per encounter. The `data`
  BLOB is **zstd-compressed CBOR** (`cbor4ii`) of the `Encounter` struct. Its
  `raw_event_log: Vec<(i64, Message)>` holds every `DamageEvent`.
- A `DamageEvent`'s `source` Actor carries `actor_type` and `parent_actor_type`
  (character-type hashes). The parser derives the skill's owning character with real
  nuance — Seofon's avatar (`Pl2200`) collapses to the parent, Ferry's pets
  (`Pl0700`) use a special mapping, `Id`/`Pl2200` handling — in
  `parser/v1/player_state.rs`.
- `ui.json`'s `skills` section is `{ "<PlXXXX>": { "<numericId>": "<name>", ... } }`.
  Only `src-tauri/lang/en/ui.json` is hand-editable (per `lang/README.md`); other
  languages fall back to `en`.

## Approach

A standalone Rust binary `src-tauri/src/bin/skill_backfill.rs`, run manually:

```sh
cargo run -p gbfr-logs --bin skill_backfill
```

It follows the existing `src-hook/src/bin/sigscan.rs` bin pattern. Rust (not a
Python/JS script) because decoding an encounter needs the real `Encounter::from_blob`
(zstd + cbor4ii) **and** the exact child/parent character-type derivation already in
the parser. Reimplementing either elsewhere would drift from the app's own behaviour.

### Flow

1. Open `logs.db`; select every `data` blob from `logs` (ignore `run_id` — Conflux
   rooms are just as valid a source of skills).
2. `Encounter::from_blob` each blob; iterate `raw_event_log` for `DamageEvent`s.
3. For each event, reproduce the parser's key derivation to obtain the owning
   character key(s) and, for `Normal(id)` / `DamageOverTime(id)`, the `id`. Reuse the
   parser's derivation logic rather than duplicating it, so pet/avatar special cases
   stay correct.
4. Load `src-tauri/lang/en/ui.json`. A skill is **missing** when NONE of
   `skills.<child>.<id>`, `skills.<parent>.<id>`, `skills.default.<id>` exists —
   mirroring `getSkillName`'s fallback chain exactly.
5. For each missing `(char, id)`, insert `skills.<char>.<id> = "TODO: Skill <id>"`
   under the **child** character block. New keys added in numeric order; existing
   entries untouched; the rest of `ui.json` structure preserved.
6. Print a summary: total missing, grouped by character, so the run's effect is visible.

### Placeholder

Missing entries get the marked value `"TODO: Skill <id>"` — distinct from the runtime
`"Skill {{id}}"` fallback and trivially greppable, so every not-yet-named entry is
findable in `ui.json`.

## Isolation

One binary, three independently-testable units:

1. **DB blob reader** — open `logs.db`, yield decoded `Encounter`s (warn + skip a row
   whose blob fails to decode).
2. **Skill-key extractor** — from an `Encounter`, yield the set of
   `(character_key, id)` pairs for `Normal`/`DamageOverTime`, reusing the parser's
   character derivation.
3. **ui.json loader / differ / writer** — load skills map, compute misses against the
   fallback chain, insert placeholders, re-serialize.

## Behaviour & edge cases

- **Add-only:** never overwrites or removes an existing entry. A real name filled in
  since a prior run is preserved.
- **Idempotent:** an already-present placeholder counts as "present", so re-runs add
  nothing new and never duplicate.
- **Empty DB:** no-op, prints "0 missing".
- **Bad blob:** warn to stderr, skip that row, continue.
- **`Unknown(hash)` character:** skip — no `PlXXXX` key can be formed. (These are the
  ones that would need the hash mapped first; out of scope here.)

## Testing

Per project convention (no live-game harness), unit tests on the pure logic:

- **Differ:** given a fake skills map and a set of seen `(char, id)`, returns exactly
  the misses the fallback chain implies (present at child, parent, or default → not a
  miss).
- **Insertion:** placeholder added under the right character block, in numeric key
  order, with existing entries and other characters untouched; re-running is a no-op.

The blob-reading path is exercised opportunistically against the dev `logs.db` when
present, but is not required for the test suite to pass.

## Out of scope

- Mapping enemy/character/quest hashes to names (separate concern; see the
  game-data-extraction notes).
- Translating the placeholders into non-`en` languages (they fall back to `en`).
- Any live/in-app detection — this is an offline, manually-run maintenance script.
