# Skill-Name Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an offline `skill_backfill` Rust binary that scans saved encounters in `logs.db`, finds player skills with no name in `en/ui.json`, and stubs each missing one with a `"TODO: Skill <id>"` placeholder under its character block.

**Architecture:** Extract `parser` + `db` into a shared `lib.rs` so both `main.rs` and a new `src/bin/skill_backfill.rs` can use them. A pure `derive_skill_key` helper maps a `DamageEvent` to `(child_key, parent_key, id)`. A pure `ui.json` module computes misses against `getSkillName`'s fallback chain and inserts placeholders (add-only, idempotent). The bin wires DB read → key extraction → diff/write.

**Tech Stack:** Rust (nightly), rusqlite (bundled sqlite), zstd + cbor4ii (encounter blob), serde_json (ui.json), strum (CharacterType Display).

---

## Spec reference

`docs/superpowers/specs/2026-07-11-skill-name-backfill-design.md`

## File structure

- Create `src-tauri/src/lib.rs` — library crate root: `pub mod parser; pub mod db;` (+ re-exports the bin/main need). Enables sharing with bins.
- Modify `src-tauri/src/main.rs:13-34` — import `parser`/`db` from the lib crate (`gbfr_logs`) instead of declaring them as local modules.
- Create `src-tauri/src/backfill.rs` — pure logic: `derive_skill_key`, the ui.json differ + placeholder writer, and their unit tests. Declared `pub mod backfill;` in `lib.rs`.
- Create `src-tauri/src/bin/skill_backfill.rs` — the runnable binary: opens `logs.db`, drives `backfill`.

Rationale: pure logic (`backfill.rs`) is unit-tested and lives in the lib; the bin is a thin I/O shell. `derive_skill_key` sits next to the differ because they change together (both encode the skill-key contract).

---

## Task 1: Extract `parser` + `db` into a shared library crate

No behaviour change — this is the enabling refactor so a second binary can reach `parser`/`db`. `main.rs` is currently the only crate root and its `mod parser; mod db;` are private to it.

**Files:**
- Create: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/main.rs:13-34`

- [ ] **Step 1: Create `lib.rs` exposing the shared modules**

Create `src-tauri/src/lib.rs`:

```rust
//! Library crate for gbfr-logs. Holds the parser + db modules so both the main
//! Tauri binary (`main.rs`) and auxiliary binaries (e.g. `bin/skill_backfill.rs`)
//! can share them. main.rs is a thin binary that `use`s this crate.
pub mod backfill;
pub mod db;
pub mod parser;
```

Note: `backfill` is created in Task 2; add its `pub mod` line now so `lib.rs` is written once. If compiling Task 1 alone, temporarily create an empty `src-tauri/src/backfill.rs` (`// placeholder`) — Task 2 fills it. (If executing strictly in order, create the empty file in this step.)

- [ ] **Step 2: Create the placeholder backfill module so lib.rs compiles**

Create `src-tauri/src/backfill.rs`:

```rust
// Filled in Task 2.
```

- [ ] **Step 3: Point `main.rs` at the library crate**

In `src-tauri/src/main.rs`, replace the two local module declarations (currently at lines 33-34):

```rust
mod db;
mod parser;
```

with a `use` of the library crate (the crate name `gbfr-logs` imports as `gbfr_logs`). Delete those two `mod` lines and add, alongside the other `use` statements near the top:

```rust
use gbfr_logs::{db, parser};
```

Leave every other `use db::...` / `use parser::...` line in `main.rs` unchanged — they now resolve through the imported modules.

- [ ] **Step 4: Verify the whole crate still builds and tests pass**

Run: `cargo build -p gbfr-logs`
Expected: builds clean (both the lib and the bin target compile).

Run: `cargo test -p gbfr-logs`
Expected: PASS — the same 26 tests as before, now compiled under the lib crate.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/src/backfill.rs src-tauri/src/main.rs
git commit -m "refactor(tauri): extract parser+db into lib crate for bin sharing"
```

---

## Task 2: Pure `derive_skill_key` helper

Maps a `DamageEvent` to the character keys + id the frontend would look up. Mirrors `getSkillName`'s child/parent derivation (`skills.<child>.<id>`, `skills.<parent>.<id>`): child = parent when parent is `Pl2200` (Seofon avatar collapse), else the source `actor_type`; parent = source `parent_actor_type`. Only `Normal(id)` and `DamageOverTime(id)` produce a key (those are the per-character named skills); other action types return `None`. `Unknown(hash)` characters return `None` (no `PlXXXX` key).

**Files:**
- Modify: `src-tauri/src/backfill.rs`
- Test: `src-tauri/src/backfill.rs` (inline `#[cfg(test)]`)

- [ ] **Step 1: Write the failing tests**

Replace the placeholder contents of `src-tauri/src/backfill.rs` with:

```rust
//! Offline skill-name backfill logic (pure; driven by `bin/skill_backfill.rs`).
//!
//! `derive_skill_key` reproduces the frontend `getSkillName` character derivation
//! so we can tell, per damage event, which `skills.<char>.<id>` key a name would be
//! looked up under. The ui.json differ then finds ids that resolve nowhere.

use protocol::{ActionType, DamageEvent};

use crate::parser::constants::CharacterType;

/// The lookup coordinates for one skill occurrence: the character block a name
/// would live under (child, then parent as fallback) and the numeric skill id.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SkillKey {
    pub child_key: String,
    pub parent_key: String,
    pub id: u32,
}

/// Returns the `SkillKey` for a damage event, or `None` when the event is not a
/// per-character named skill (link/SBA/supplementary) or the character is unknown.
pub fn derive_skill_key(event: &DamageEvent) -> Option<SkillKey> {
    let id = match event.action_id {
        ActionType::Normal(id) | ActionType::DamageOverTime(id) => id,
        _ => return None,
    };

    let parent = CharacterType::from_hash(event.source.parent_actor_type);
    // Seofon's avatar (Pl2200) collapses into Seofon; otherwise the child is the
    // concrete source actor. Mirrors parser/v1/player_state.rs.
    let child = if parent == CharacterType::Pl2200 {
        parent
    } else {
        CharacterType::from_hash(event.source.actor_type)
    };

    let child_key = character_key(child)?;
    let parent_key = character_key(parent)?;
    Some(SkillKey {
        child_key,
        parent_key,
        id,
    })
}

/// A `PlXXXX` key string for a known character, or `None` for `Unknown(_)`
/// (strum renders the inner hash for the default variant, never a `Pl` key).
fn character_key(character: CharacterType) -> Option<String> {
    if matches!(character, CharacterType::Unknown(_)) {
        return None;
    }
    Some(character.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::Actor;

    fn event(parent_hash: u32, actor_hash: u32, action: ActionType) -> DamageEvent {
        DamageEvent {
            source: Actor {
                index: 0,
                actor_type: actor_hash,
                parent_actor_type: parent_hash,
                parent_index: 0,
            },
            target: Actor {
                index: 1,
                actor_type: 0,
                parent_actor_type: 0,
                parent_index: 1,
            },
            action_id: action,
            damage: 100,
            flags: 0,
            attack_rate: None,
            stun_value: None,
            damage_cap: None,
        }
    }

    #[test]
    fn normal_skill_yields_child_parent_id() {
        // Use a known character hash: Katalina Pl0100 (see constants.rs from_hash).
        let katalina = katalina_hash();
        let key = derive_skill_key(&event(katalina, katalina, ActionType::Normal(200))).unwrap();
        assert_eq!(key.child_key, "Pl0100");
        assert_eq!(key.parent_key, "Pl0100");
        assert_eq!(key.id, 200);
    }

    #[test]
    fn seofon_avatar_collapses_child_to_parent() {
        // parent = Seofon (Pl2200), child actor = something else -> child collapses to Pl2200.
        let seofon = seofon_hash();
        let other = katalina_hash();
        let key = derive_skill_key(&event(seofon, other, ActionType::Normal(1))).unwrap();
        assert_eq!(key.child_key, "Pl2200");
        assert_eq!(key.parent_key, "Pl2200");
    }

    #[test]
    fn link_and_sba_and_supplementary_have_no_key() {
        let k = katalina_hash();
        assert!(derive_skill_key(&event(k, k, ActionType::LinkAttack)).is_none());
        assert!(derive_skill_key(&event(k, k, ActionType::SBA)).is_none());
        assert!(derive_skill_key(&event(k, k, ActionType::SupplementaryDamage(5))).is_none());
    }

    #[test]
    fn dot_yields_a_key() {
        let k = katalina_hash();
        let key = derive_skill_key(&event(k, k, ActionType::DamageOverTime(9))).unwrap();
        assert_eq!(key.id, 9);
    }

    #[test]
    fn unknown_character_has_no_key() {
        // 0xDEADBEEF is not a known character hash -> Unknown -> skip.
        assert!(derive_skill_key(&event(0xDEAD_BEEF, 0xDEAD_BEEF, ActionType::Normal(1))).is_none());
    }

    // Resolve real hashes by reversing from_hash: find the hash that maps to the
    // wanted CharacterType. constants.rs is the source of truth; look up the arm.
    fn katalina_hash() -> u32 {
        find_hash_for("Pl0100")
    }
    fn seofon_hash() -> u32 {
        find_hash_for("Pl2200")
    }
    fn find_hash_for(pl: &str) -> u32 {
        // Brute-force the known hash set is impractical; instead read the exact
        // hash from constants.rs from_hash arms. These two are stable:
        match pl {
            // From src-tauri/src/parser/constants.rs from_hash():
            "Pl0100" => 0x9498420D, // Katalina (verified in constants.rs from_hash)
            "Pl2200" => 0x59DB0CD9, // Seofon (verified in constants.rs from_hash)
            _ => panic!("add hash for {pl}"),
        }
    }
}
```

Note for the implementer: the character hashes `Pl0100 = 0x9498420D` and `Pl2200 = 0x59DB0CD9` are verified against `src-tauri/src/parser/constants.rs` `from_hash`. No changes needed unless a future game patch renumbers them.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p gbfr-logs backfill::tests`
Expected: the 5 tests compile and PASS immediately, because Step 1 wrote both the tests AND the `derive_skill_key` implementation together (TDD note: this task's "failing" state is the pre-Step-1 absence of the module; if you prefer a strict red phase, stub `derive_skill_key` to `None` first, watch the 4 non-`None` tests fail, then restore).

- [ ] **Step 3: Confirm implementation makes them pass**

The implementation (`derive_skill_key` + `character_key`) is already written above. With correct hashes, tests pass.

Run: `cargo test -p gbfr-logs backfill::tests`
Expected: PASS (5 tests).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/backfill.rs
git commit -m "feat(backfill): derive_skill_key mapping damage events to ui.json skill keys"
```

---

## Task 3: ui.json differ + placeholder insertion

Given the `skills` map from `en/ui.json` and a set of `SkillKey`s, compute which ids resolve nowhere (checking `skills.<child>.<id>`, `skills.<parent>.<id>`, `skills.default.<id>` — the exact `getSkillName` chain), then insert `"TODO: Skill <id>"` under the child block. Add-only and idempotent.

**Files:**
- Modify: `src-tauri/src/backfill.rs`
- Test: `src-tauri/src/backfill.rs` (inline `#[cfg(test)]`)

- [ ] **Step 1: Write the failing tests**

Append to `src-tauri/src/backfill.rs` (above the existing `#[cfg(test)]` module, add the impl; add tests inside the test module):

Implementation to add (after `character_key`):

```rust
use serde_json::{Map, Value};
use std::collections::BTreeSet;

/// The placeholder written for an unmapped skill. Marked + greppable, distinct
/// from the runtime `"Skill {{id}}"` fallback.
pub fn placeholder_for(id: u32) -> String {
    format!("TODO: Skill {id}")
}

/// True if `skills` already resolves a name for `key` via the getSkillName chain:
/// child block, then parent block, then the `default` block.
fn is_resolved(skills: &Map<String, Value>, key: &SkillKey) -> bool {
    let id = key.id.to_string();
    for block in [&key.child_key, &key.parent_key, "default"] {
        if let Some(Value::Object(entries)) = skills.get(*block) {
            if entries.contains_key(&id) {
                return true;
            }
        }
    }
    false
}

/// Inserts `"TODO: Skill <id>"` placeholders into `skills` for every `key` that
/// does not already resolve. Returns the number of placeholders added. Add-only:
/// never overwrites or removes. Idempotent: an already-present placeholder counts
/// as resolved. New entries land under the child block.
pub fn insert_missing(skills: &mut Map<String, Value>, keys: &BTreeSet<SkillKey>) -> usize {
    let mut added = 0;
    for key in keys {
        if is_resolved(skills, key) {
            continue;
        }
        let block = skills
            .entry(key.child_key.clone())
            .or_insert_with(|| Value::Object(Map::new()));
        if let Value::Object(entries) = block {
            entries.insert(key.id.to_string(), Value::String(placeholder_for(key.id)));
            added += 1;
        }
    }
    added
}
```

Add these test helpers + tests inside the existing `mod tests`:

```rust
    use serde_json::json;
    use std::collections::BTreeSet;

    fn key(child: &str, parent: &str, id: u32) -> SkillKey {
        SkillKey {
            child_key: child.to_string(),
            parent_key: parent.to_string(),
            id,
        }
    }

    #[test]
    fn missing_skill_is_inserted_under_child_block() {
        let mut skills = json!({ "Pl0100": { "100": "Slice" } })
            .as_object()
            .unwrap()
            .clone();
        let mut keys = BTreeSet::new();
        keys.insert(key("Pl0100", "Pl0100", 999));

        let added = insert_missing(&mut skills, &keys);
        assert_eq!(added, 1);
        assert_eq!(skills["Pl0100"]["999"], json!("TODO: Skill 999"));
        assert_eq!(skills["Pl0100"]["100"], json!("Slice"), "existing untouched");
    }

    #[test]
    fn resolved_via_child_parent_or_default_is_skipped() {
        let mut skills = json!({
            "Pl0100": { "1": "Child" },
            "Pl2200": { "2": "Parent" },
            "default": { "3": "Default" }
        })
        .as_object()
        .unwrap()
        .clone();
        let mut keys = BTreeSet::new();
        keys.insert(key("Pl0100", "Pl0100", 1)); // in child
        keys.insert(key("PlXXXX", "Pl2200", 2)); // in parent
        keys.insert(key("PlYYYY", "PlZZZZ", 3)); // in default

        let added = insert_missing(&mut skills, &keys);
        assert_eq!(added, 0, "all three already resolve");
    }

    #[test]
    fn is_idempotent_on_rerun() {
        let mut skills = Map::new();
        let mut keys = BTreeSet::new();
        keys.insert(key("Pl0100", "Pl0100", 42));

        assert_eq!(insert_missing(&mut skills, &keys), 1);
        assert_eq!(insert_missing(&mut skills, &keys), 0, "second run adds nothing");
        assert_eq!(skills["Pl0100"]["42"], json!("TODO: Skill 42"));
    }
```

- [ ] **Step 2: Run tests to verify they pass (impl written with them)**

Run: `cargo test -p gbfr-logs backfill::tests`
Expected: PASS — the 5 Task-2 tests plus the 3 new ones (8 total).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/backfill.rs
git commit -m "feat(backfill): diff seen skills vs ui.json and insert TODO placeholders"
```

---

## Task 4: The `skill_backfill` binary

Thin I/O shell: open `logs.db`, decode every encounter blob, gather `SkillKey`s, load `en/ui.json`, insert placeholders, write `ui.json` back (2-space indent, trailing newline), print a summary. No new logic — just wiring the pure pieces.

**Files:**
- Create: `src-tauri/src/bin/skill_backfill.rs`

- [ ] **Step 1: Write the binary**

Create `src-tauri/src/bin/skill_backfill.rs`:

```rust
//! Offline maintenance tool: scan saved encounters in logs.db for player skills
//! that have no name in en/ui.json and stub each with a `"TODO: Skill <id>"`
//! placeholder under its character block. Add-only + idempotent.
//!
//! Run from the repo root:
//!   cargo run -p gbfr-logs --bin skill_backfill
//! Optional args: --db <path to logs.db> --ui <path to en/ui.json>

use std::collections::BTreeSet;
use std::path::PathBuf;

use anyhow::{Context, Result};
use gbfr_logs::backfill::{derive_skill_key, insert_missing, SkillKey};
use gbfr_logs::parser::v1::Encounter;
use protocol::Message;
use rusqlite::Connection;
use serde_json::{Map, Value};

fn main() -> Result<()> {
    let mut db_path = PathBuf::from("src-tauri/logs.db");
    let mut ui_path = PathBuf::from("src-tauri/lang/en/ui.json");

    // Minimal flag parsing: --db <path>, --ui <path>.
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => db_path = args.next().context("--db needs a path")?.into(),
            "--ui" => ui_path = args.next().context("--ui needs a path")?.into(),
            other => anyhow::bail!("unknown arg: {other}"),
        }
    }

    let keys = collect_skill_keys(&db_path)?;
    println!("Collected {} distinct skill keys from {}", keys.len(), db_path.display());

    let mut ui: Value = serde_json::from_slice(
        &std::fs::read(&ui_path).with_context(|| format!("reading {}", ui_path.display()))?,
    )?;
    let skills = ui
        .get_mut("skills")
        .and_then(Value::as_object_mut)
        .context("ui.json has no `skills` object")?;

    let added = insert_missing(skills, &keys);

    if added == 0 {
        println!("No missing skills — nothing to write.");
        return Ok(());
    }

    // Serialize with 2-space indent + trailing newline to match the existing file.
    let mut out = serde_json::to_string_pretty(&ui)?;
    out.push('\n');
    std::fs::write(&ui_path, out).with_context(|| format!("writing {}", ui_path.display()))?;
    println!("Added {added} placeholder(s) to {}", ui_path.display());
    Ok(())
}

/// Reads every encounter blob from `logs.db` and returns the set of skill keys seen.
/// A row whose blob fails to decode is warned about and skipped.
fn collect_skill_keys(db_path: &std::path::Path) -> Result<BTreeSet<SkillKey>> {
    let conn = Connection::open(db_path)
        .with_context(|| format!("opening {}", db_path.display()))?;
    let mut stmt = conn.prepare("SELECT id, data FROM logs")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
    })?;

    let mut keys = BTreeSet::new();
    for row in rows {
        let (id, blob) = row?;
        let mut encounter = match Encounter::from_blob(&blob) {
            Ok(e) => e,
            Err(e) => {
                eprintln!("warn: skipping log {id}: blob decode failed: {e}");
                continue;
            }
        };
        encounter.repopulate_event_log();
        for (_, event) in encounter.event_log() {
            if let Message::DamageEvent(dmg) = event {
                if let Some(k) = derive_skill_key(dmg) {
                    keys.insert(k);
                }
            }
        }
    }
    Ok(keys)
}
```

Note: `Encounter`, `Encounter::from_blob`, `repopulate_event_log`, and `event_log()` are `pub` in `parser/v1/mod.rs` (verified). If `Encounter` is not re-exported at `gbfr_logs::parser::v1::Encounter`, adjust the `use` to its actual path (it is declared `pub struct Encounter` in `parser::v1`).

- [ ] **Step 2: Build the binary**

Run: `cargo build -p gbfr-logs --bin skill_backfill`
Expected: builds clean. If `Encounter`/its methods aren't visible, make them `pub` in `parser/v1/mod.rs` (they already are) or fix the `use` path, then rebuild.

- [ ] **Step 3: Dry-run against a COPY of the dev DB and ui.json**

Never test-write the real file first. Copy both, run against the copies:

```bash
cp src-tauri/lang/en/ui.json /tmp/ui.json
cargo run -p gbfr-logs --bin skill_backfill -- --db src-tauri/logs.db --ui /tmp/ui.json
```

Expected: prints "Collected N distinct skill keys..." and either "No missing skills" or "Added M placeholder(s)...". Inspect `/tmp/ui.json`:

```bash
git --no-pager diff --no-index src-tauri/lang/en/ui.json /tmp/ui.json | head -60
```

Expected: only additions of `"<id>": "TODO: Skill <id>"` lines under character blocks; no existing lines changed.

- [ ] **Step 4: Verify idempotency**

Run the same command a second time against `/tmp/ui.json`:

```bash
cargo run -p gbfr-logs --bin skill_backfill -- --db src-tauri/logs.db --ui /tmp/ui.json
```

Expected: "No missing skills — nothing to write." (all placeholders now present).

- [ ] **Step 5: Commit the binary (NOT the generated ui.json changes)**

```bash
git add src-tauri/src/bin/skill_backfill.rs
git commit -m "feat(backfill): skill_backfill binary — scan logs.db, stub missing ui.json skills"
```

Applying the tool to the real `en/ui.json` (and hand-filling the TODOs) is a separate, reviewed step — not part of this plan's commits.

---

## Self-review notes

- **Spec coverage:** offline Rust bin (Task 4) ✓; reuse `Encounter::from_blob` + parser derivation (Tasks 1-2) ✓; fallback-chain diff (Task 3) ✓; marked placeholder under child block (Task 3) ✓; add-only + idempotent (Task 3 tests) ✓; warn+skip bad blob, empty-DB no-op (Task 4) ✓; unit tests on differ + key extraction (Tasks 2-3) ✓.
- **Character hashes verified against `constants.rs`:** Katalina `Pl0100 = 0x9498420D`, Seofon `Pl2200 = 0x59DB0CD9`. `Encounter::from_blob`/`repopulate_event_log`/`event_log` confirmed `pub`. Remove the now-stale "REPLACE if constants.rs differs" mindset — values are correct as written.
- **Conflux rooms** are included as skill sources (the query has no `run_id` filter) — intentional per spec.
