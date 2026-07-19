# Conflux Runs UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Represent Conflux (Endless) runs in GBFR Logs — rooms grouped under runs, each room with its own damage meter, plus per-room buff deltas, in a dedicated "Conflux" logs tab.

**Architecture:** Promote the existing `hookdiag`-only Conflux hooks to real emitters of four new `protocol::Message` variants. The `v1::Parser` owns run identity: it inserts a `runs` row on run-start, stamps each saved room encounter with `run_id`/`room_index` (reusing the per-encounter save mechanic), accumulates per-room buff deltas, and finalizes the run on run-end. A new `fetch_conflux_runs` Tauri command feeds a new React "Conflux" tab of expandable run rows; each room "View" reuses the existing `/logs/:id` encounter view.

**Tech Stack:** Rust (hook `retour` detours, `protocol` bincode, `rusqlite` + `rusqlite_migration`, Tauri commands), TypeScript/React (Mantine UI, Zustand, react-router, i18next).

**Reference spec:** `docs/superpowers/specs/2026-07-11-conflux-runs-ui-design.md`

---

## File Structure

**Protocol**
- Modify `protocol/src/lib.rs` — add 4 event structs + 4 `Message` variants.

**Hook (`src-hook/`)**
- Modify `src-hook/src/hooks/endless.rs` — 3 hooks gain `event::Tx`, emit real messages (run-start, buff, run-end).
- Modify `src-hook/src/hooks/quest.rs` — `OnLoadQuestHook` gains `event::Tx`, emits room-enter when in an endless run.
- Modify `src-hook/src/hooks/mod.rs` — pass `tx.clone()` to the promoted hooks.

**DB (`src-tauri/src/db/`)**
- Modify `src-tauri/src/db/mod.rs` — append migrations: `logs.run_id`, `logs.room_index`, `logs.total_damage`, and `CREATE TABLE runs`.
- Create `src-tauri/src/db/runs.rs` — `runs`-table read/write helpers + `ConfluxRun`/`ConfluxRoom`/`ConfluxBuffDelta` structs.
- Modify `src-tauri/src/db/mod.rs` — `pub mod runs;`.

**Parser (`src-tauri/src/parser/v1/`)**
- Modify `src-tauri/src/parser/v1/mod.rs` — parser run-state fields + 4 handlers + stamp room rows on save + `total_damage` on save.

**Tauri backend (`src-tauri/src/main.rs`)**
- Modify — new `fetch_conflux_runs` command; wire 4 new messages in `connect_and_run_parser`; register command in `generate_handler!`.

**Frontend (`src/`)**
- Modify `src/types.ts` — `ConfluxRun`, `ConfluxRoom`, `ConfluxBuffDelta`, `ConfluxSearchResult`.
- Modify `src/pages/Logs.tsx` — "Conflux" NavLink.
- Modify `src/App.tsx` — `/logs/conflux` route.
- Create `src/pages/logs/ConfluxIndex.tsx` — the run table + expandable rows.
- Create `src/pages/logs/useConfluxIndex.tsx` — data fetching + refresh-on-save.

---

## Task 1: Protocol — new message variants

**Files:**
- Modify: `protocol/src/lib.rs` (after `PlayerIdentityEvent`, and the `Message` enum near line 238)

- [ ] **Step 1: Add the four event structs**

In `protocol/src/lib.rs`, after the `PlayerIdentityEvent` struct, add:

```rust
/// Emitted when a Conflux (EndlessMode) run begins — the reception dispatcher
/// builds an EndlessMode reception flow (quest_type 8). See src-hook endless.rs.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ConfluxRunStartEvent {}

/// Emitted on each Conflux room load while a run is active. `quest_id` is the
/// room's quest identifier (each room is an isolated quest load).
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ConfluxRoomEnterEvent {
    pub quest_id: u32,
}

/// Emitted when a Conflux upgrade/buff installs on the player. `buff_id` is the
/// raw ability/buff identifier; single-player, so no player attribution.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ConfluxBuffAcquiredEvent {
    pub buff_id: u32,
}

/// Emitted when a Conflux run concludes (EndlessModeQuestManager destroyed).
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ConfluxRunEndEvent {}
```

- [ ] **Step 2: Add the four `Message` variants**

In the `Message` enum (after `PlayerIdentityEvent(PlayerIdentityEvent)`), add:

```rust
    /// Conflux (EndlessMode) run lifecycle. Run identity is assigned by the parser,
    /// not the hook — these carry only the raw signal.
    ConfluxRunStart(ConfluxRunStartEvent),
    ConfluxRoomEnter(ConfluxRoomEnterEvent),
    ConfluxBuffAcquired(ConfluxBuffAcquiredEvent),
    ConfluxRunEnd(ConfluxRunEndEvent),
```

- [ ] **Step 3: Verify protocol compiles**

Run: `cargo build -p protocol`
Expected: PASS (compiles clean).

- [ ] **Step 4: Commit**

```bash
git add protocol/src/lib.rs
git commit -m "feat(protocol): add Conflux run/room/buff message variants"
```

---

## Task 2: DB migrations — runs table + logs columns

**Files:**
- Modify: `src-tauri/src/db/mod.rs:16-39` (the `Migrations::new(vec![...])` list)

- [ ] **Step 1: Append the new migrations**

In `src-tauri/src/db/mod.rs`, append these `M::up(...)` entries to the END of the existing
`vec![...]` (after the `quest_completed` migration — **never reorder existing entries**):

```rust
        M::up("ALTER TABLE logs ADD COLUMN run_id INTEGER"),
        M::up("ALTER TABLE logs ADD COLUMN room_index INTEGER"),
        M::up("ALTER TABLE logs ADD COLUMN total_damage INTEGER"),
        M::up(
            r#"CREATE TABLE IF NOT EXISTS runs (
            id INTEGER PRIMARY KEY,
            start_time INTEGER NOT NULL,
            end_time INTEGER,
            duration INTEGER,
            room_count INTEGER NOT NULL DEFAULT 0,
            completed BOOLEAN,
            buffs TEXT
        )"#,
        ),
```

- [ ] **Step 2: Verify migrations apply on a fresh DB**

Run: `cargo test -p gbfr-logs db::` (if no db tests exist yet, this is covered by Task 3's test).
Interim check — build the crate:
Run: `cargo build -p gbfr-logs`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/db/mod.rs
git commit -m "feat(db): add runs table and run_id/room_index/total_damage columns"
```

---

## Task 3: DB runs helpers + a migration smoke test

**Files:**
- Create: `src-tauri/src/db/runs.rs`
- Modify: `src-tauri/src/db/mod.rs` (add `pub mod runs;` near `pub mod logs;`)

- [ ] **Step 1: Write the failing test (migration + insert/read round-trip)**

Create `src-tauri/src/db/runs.rs` with the structs, helpers, and a test:

```rust
use anyhow::Result;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

/// A single buff acquired during a run, tagged with the room it was picked up in.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfluxBuffDelta {
    pub room_index: u32,
    pub buff_ids: Vec<u32>,
}

/// One room within a run, summarised for the run list (full meter via /logs/:id).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfluxRoom {
    pub log_id: i64,
    pub room_index: u32,
    pub quest_id: Option<u32>,
    pub primary_target: Option<u32>,
    pub duration: i64,
    pub total_damage: Option<i64>,
}

/// A Conflux run with its nested rooms and per-room buff deltas.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfluxRun {
    pub id: i64,
    pub start_time: i64,
    pub end_time: Option<i64>,
    pub duration: Option<i64>,
    pub room_count: u32,
    pub completed: Option<bool>,
    pub buffs: Vec<ConfluxBuffDelta>,
    pub rooms: Vec<ConfluxRoom>,
}

/// Inserts a new in-progress run, returning its id.
pub fn insert_run(conn: &Connection, start_time: i64) -> Result<i64> {
    conn.execute(
        "INSERT INTO runs (start_time, room_count) VALUES (?, 0)",
        params![start_time],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Finalises a run: end_time, duration, completed, room_count, and buffs JSON.
pub fn finalize_run(
    conn: &Connection,
    run_id: i64,
    end_time: i64,
    duration: i64,
    room_count: u32,
    completed: bool,
    buffs: &[ConfluxBuffDelta],
) -> Result<()> {
    let buffs_json = serde_json::to_string(buffs)?;
    conn.execute(
        "UPDATE runs SET end_time = ?, duration = ?, room_count = ?, completed = ?, buffs = ? WHERE id = ?",
        params![end_time, duration, room_count, completed, buffs_json, run_id],
    )?;
    Ok(())
}

/// Reads a page of runs (newest first) with their rooms joined from `logs`.
pub fn get_runs(conn: &Connection, per_page: u32, offset: u32) -> Result<Vec<ConfluxRun>> {
    let mut stmt = conn.prepare(
        "SELECT id, start_time, end_time, duration, room_count, completed, buffs
         FROM runs ORDER BY start_time DESC LIMIT ? OFFSET ?",
    )?;
    let run_rows = stmt.query_map(params![per_page, offset], |row| {
        let buffs_json: Option<String> = row.get(6)?;
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, Option<i64>>(2)?,
            row.get::<_, Option<i64>>(3)?,
            row.get::<_, u32>(4)?,
            row.get::<_, Option<bool>>(5)?,
            buffs_json,
        ))
    })?;

    let mut runs = Vec::new();
    for r in run_rows {
        let (id, start_time, end_time, duration, room_count, completed, buffs_json) = r?;
        let buffs: Vec<ConfluxBuffDelta> = buffs_json
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_default();
        let rooms = get_rooms_for_run(conn, id)?;
        runs.push(ConfluxRun {
            id, start_time, end_time, duration, room_count, completed, buffs, rooms,
        });
    }
    Ok(runs)
}

/// Reads the room summaries (from `logs`) for one run, ordered by room_index.
pub fn get_rooms_for_run(conn: &Connection, run_id: i64) -> Result<Vec<ConfluxRoom>> {
    let mut stmt = conn.prepare(
        "SELECT id, room_index, quest_id, primary_target, duration, total_damage
         FROM logs WHERE run_id = ? ORDER BY room_index ASC",
    )?;
    let rows = stmt.query_map(params![run_id], |row| {
        Ok(ConfluxRoom {
            log_id: row.get(0)?,
            room_index: row.get::<_, Option<u32>>(1)?.unwrap_or(0),
            quest_id: row.get(2)?,
            primary_target: row.get(3)?,
            duration: row.get(4)?,
            total_damage: row.get(5)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Total count of runs (for pagination).
pub fn get_runs_count(conn: &Connection) -> Result<i32> {
    Ok(conn.query_row("SELECT COUNT(*) FROM runs", [], |r| r.get(0))?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use rusqlite_migration::{Migrations, M};

    fn migrated_conn() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        // Mirror the production migration list closely enough to exercise the
        // runs table + new logs columns (append-only; matches db/mod.rs).
        let migrations = Migrations::new(vec![
            M::up("CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY, name TEXT NOT NULL, time INTEGER NOT NULL, duration INTEGER NOT NULL, data BLOB NOT NULL)"),
            M::up("ALTER TABLE logs ADD COLUMN version INTEGER NOT NULL DEFAULT 0"),
            M::up("ALTER TABLE logs ADD COLUMN primary_target INTEGER"),
            M::up("ALTER TABLE logs ADD COLUMN quest_id INTEGER"),
            M::up("ALTER TABLE logs ADD COLUMN run_id INTEGER"),
            M::up("ALTER TABLE logs ADD COLUMN room_index INTEGER"),
            M::up("ALTER TABLE logs ADD COLUMN total_damage INTEGER"),
            M::up("CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY, start_time INTEGER NOT NULL, end_time INTEGER, duration INTEGER, room_count INTEGER NOT NULL DEFAULT 0, completed BOOLEAN, buffs TEXT)"),
        ]);
        migrations.to_latest(&mut conn).unwrap();
        conn
    }

    #[test]
    fn run_insert_finalize_and_read_roundtrip() {
        let conn = migrated_conn();
        let run_id = insert_run(&conn, 1_000).unwrap();

        // Two room logs tagged to the run.
        conn.execute(
            "INSERT INTO logs (name, time, duration, data, version, quest_id, primary_target, run_id, room_index, total_damage) VALUES ('',1000,5000,x'00',1,10,100,?,0,4200000)",
            params![run_id],
        ).unwrap();
        conn.execute(
            "INSERT INTO logs (name, time, duration, data, version, quest_id, primary_target, run_id, room_index, total_damage) VALUES ('',2000,6000,x'00',1,11,200,?,1,6100000)",
            params![run_id],
        ).unwrap();

        let buffs = vec![
            ConfluxBuffDelta { room_index: 0, buff_ids: vec![0xAA, 0xBB] },
            ConfluxBuffDelta { room_index: 1, buff_ids: vec![0xCC] },
        ];
        finalize_run(&conn, run_id, 8_000, 7_000, 2, true, &buffs).unwrap();

        let runs = get_runs(&conn, 10, 0).unwrap();
        assert_eq!(runs.len(), 1);
        let run = &runs[0];
        assert_eq!(run.room_count, 2);
        assert_eq!(run.completed, Some(true));
        assert_eq!(run.duration, Some(7_000));
        assert_eq!(run.rooms.len(), 2);
        assert_eq!(run.rooms[0].room_index, 0);
        assert_eq!(run.rooms[0].total_damage, Some(4_200_000));
        assert_eq!(run.rooms[1].room_index, 1);
        assert_eq!(run.buffs.len(), 2);
        assert_eq!(run.buffs[0].buff_ids, vec![0xAA, 0xBB]);
        assert_eq!(get_runs_count(&conn).unwrap(), 1);
    }
}
```

Add `pub mod runs;` in `src-tauri/src/db/mod.rs` next to `pub mod logs;`.

- [ ] **Step 2: Verify the test fails (module not yet wired / compiles)**

Run: `cargo test -p gbfr-logs db::runs::tests::run_insert_finalize_and_read_roundtrip`
Expected: initially FAIL if `serde_json` isn't a dependency — see Step 3.

- [ ] **Step 3: Ensure `serde_json` is available**

Check `src-tauri/Cargo.toml` for `serde_json`. If absent, add under `[dependencies]`:

```toml
serde_json = "1"
```

- [ ] **Step 4: Verify the test passes**

Run: `cargo test -p gbfr-logs db::runs::tests::run_insert_finalize_and_read_roundtrip`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/db/runs.rs src-tauri/src/db/mod.rs src-tauri/Cargo.toml
git commit -m "feat(db): runs read/write helpers with roundtrip test"
```

---

## Task 4: Parser — run lifecycle state + handlers

**Files:**
- Modify: `src-tauri/src/parser/v1/mod.rs` (Parser struct fields; new handler methods; `save_encounter_to_db` stamping; import `db::runs`)

- [ ] **Step 1: Write failing tests for the run lifecycle**

Add to the `tests` module in `src-tauri/src/parser/v1/mod.rs`. These tests use an in-memory
DB so the parser can insert/finalize runs.

```rust
    fn parser_with_memory_db() -> Parser {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        let migrations = rusqlite_migration::Migrations::new(vec![
            rusqlite_migration::M::up("CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY, name TEXT NOT NULL, time INTEGER NOT NULL, duration INTEGER NOT NULL, data BLOB NOT NULL, version INTEGER NOT NULL DEFAULT 0, primary_target INTEGER, p1_name TEXT, p1_type TEXT, p2_name TEXT, p2_type TEXT, p3_name TEXT, p3_type TEXT, p4_name TEXT, p4_type TEXT, quest_id INTEGER, quest_elapsed_time INTEGER, quest_completed BOOLEAN, run_id INTEGER, room_index INTEGER, total_damage INTEGER)"),
            rusqlite_migration::M::up("CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY, start_time INTEGER NOT NULL, end_time INTEGER, duration INTEGER, room_count INTEGER NOT NULL DEFAULT 0, completed BOOLEAN, buffs TEXT)"),
        ]);
        let mut conn = conn;
        migrations.to_latest(&mut conn).unwrap();
        Parser { db: Some(conn), ..Default::default() }
    }

    fn a_damage_event() -> DamageEvent {
        DamageEvent {
            source: Actor { index: 0, actor_type: 0x2AF6_78E8, parent_actor_type: 0x2AF6_78E8, parent_index: 0 },
            target: Actor { index: 1, actor_type: 0, parent_actor_type: 0, parent_index: 1 },
            damage: 500, flags: 0, action_id: ActionType::Normal(1),
            attack_rate: None, stun_value: None, damage_cap: None,
        }
    }

    #[test]
    fn conflux_run_lifecycle_groups_rooms_and_buffs() {
        let mut parser = parser_with_memory_db();

        // Run starts -> a runs row exists and is active.
        parser.on_conflux_run_start();
        assert!(parser.active_run_id.is_some());

        // Room 0: some damage, then next room-enter cuts it off + saves it.
        parser.on_damage_event(a_damage_event());
        parser.on_conflux_buff_acquired(protocol::ConfluxBuffAcquiredEvent { buff_id: 0xAA });
        parser.on_conflux_buff_acquired(protocol::ConfluxBuffAcquiredEvent { buff_id: 0xAA }); // dup
        parser.on_conflux_room_enter(protocol::ConfluxRoomEnterEvent { quest_id: 11 });

        // Room 1: more damage + a buff, then run ends (which saves the last room).
        parser.on_damage_event(a_damage_event());
        parser.on_conflux_buff_acquired(protocol::ConfluxBuffAcquiredEvent { buff_id: 0xCC });
        parser.on_conflux_run_end();

        assert!(parser.active_run_id.is_none(), "run cleared after end");

        let conn = parser.db.as_ref().unwrap();
        let runs = crate::db::runs::get_runs(conn, 10, 0).unwrap();
        assert_eq!(runs.len(), 1);
        let run = &runs[0];
        assert_eq!(run.rooms.len(), 2, "two rooms saved and tagged to the run");
        assert_eq!(run.rooms[0].room_index, 0);
        assert_eq!(run.rooms[1].room_index, 1);
        assert_eq!(run.completed, Some(true));
        // Buff deltas: room 0 has 0xAA (deduped to one), room 1 has 0xCC.
        let r0 = run.buffs.iter().find(|b| b.room_index == 0).unwrap();
        assert_eq!(r0.buff_ids, vec![0xAA]);
        let r1 = run.buffs.iter().find(|b| b.room_index == 1).unwrap();
        assert_eq!(r1.buff_ids, vec![0xCC]);
    }

    #[test]
    fn buff_and_room_without_active_run_are_ignored_for_runs() {
        let mut parser = parser_with_memory_db();
        // No run started.
        parser.on_conflux_buff_acquired(protocol::ConfluxBuffAcquiredEvent { buff_id: 0x1 });
        parser.on_conflux_room_enter(protocol::ConfluxRoomEnterEvent { quest_id: 5 });
        assert!(parser.active_run_id.is_none());
        let conn = parser.db.as_ref().unwrap();
        assert_eq!(crate::db::runs::get_runs_count(conn).unwrap(), 0);
    }
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `cargo test -p gbfr-logs parser::v1::tests::conflux_run_lifecycle_groups_rooms_and_buffs`
Expected: FAIL — `on_conflux_run_start`/`active_run_id` not defined.

- [ ] **Step 3: Add run-state fields to `Parser`**

In the `Parser` struct (`src-tauri/src/parser/v1/mod.rs`), add fields:

```rust
    /// Active Conflux run id (None when not in a run). Assigned on run-start.
    #[serde(skip)]
    active_run_id: Option<i64>,
    /// 0-based index of the room currently being recorded within the active run.
    #[serde(skip)]
    active_room_index: u32,
    /// Per-room buff deltas accumulated during the active run.
    #[serde(skip)]
    active_run_buffs: Vec<crate::db::runs::ConfluxBuffDelta>,
    /// Start timestamp (ms) of the active run.
    #[serde(skip)]
    active_run_start: i64,
```

- [ ] **Step 4: Add imports**

Ensure the top of the file imports the new protocol events and db runs module:

```rust
use protocol::{
    AreaEnterEvent, ConfluxBuffAcquiredEvent, ConfluxRoomEnterEvent, DamageEvent, Message,
    OnAttemptSBAEvent, OnContinueSBAChainEvent, OnDeathEvent, OnPerformSBAEvent, OnUpdateSBAEvent,
    PlayerIdentityEvent, PlayerLoadEvent, QuestCompleteEvent,
};
use crate::db::runs::{finalize_run, insert_run, ConfluxBuffDelta};
```

(Keep existing `super::{...}` imports; add the `crate::db::runs` line separately.)

- [ ] **Step 5: Implement the four handlers + room-save helper**

Add these methods to `impl Parser`:

```rust
    /// Conflux run begins: open a runs row and reset per-run accumulators.
    pub fn on_conflux_run_start(&mut self) {
        let now = Utc::now().timestamp_millis();
        self.active_room_index = 0;
        self.active_run_buffs.clear();
        self.active_run_start = now;
        if let Some(conn) = &self.db {
            match insert_run(conn, now) {
                Ok(id) => self.active_run_id = Some(id),
                Err(_) => self.active_run_id = None,
            }
        }
    }

    /// A new Conflux room loads: cut off + save the previous room (stamped with the
    /// run id + room index), then advance to the next room. Mirrors on_area_enter_event.
    pub fn on_conflux_room_enter(&mut self, event: ConfluxRoomEnterEvent) {
        // Ignore if we somehow missed the run-start.
        if self.active_run_id.is_none() {
            return;
        }

        self.encounter.quest_id = Some(event.quest_id);

        if self.status == ParserStatus::InProgress {
            self.update_status(ParserStatus::Stopped);
            if self.has_damage() {
                let _ = self.save_room_to_db();
                self.active_room_index += 1;
            }
        }

        self.encounter.quest_completed = false;
        self.encounter.reset_player_data();

        if let Some(window) = &self.window_handle {
            let _ = window.emit("on-area-enter", &self.derived_state);
        }
    }

    /// A Conflux buff installs. Accumulate under the active room index, deduped.
    pub fn on_conflux_buff_acquired(&mut self, event: ConfluxBuffAcquiredEvent) {
        if self.active_run_id.is_none() {
            return;
        }
        let room = self.active_room_index;
        let entry = self
            .active_run_buffs
            .iter_mut()
            .find(|b| b.room_index == room);
        match entry {
            Some(delta) => {
                if !delta.buff_ids.contains(&event.buff_id) {
                    delta.buff_ids.push(event.buff_id);
                }
            }
            None => self.active_run_buffs.push(ConfluxBuffDelta {
                room_index: room,
                buff_ids: vec![event.buff_id],
            }),
        }
    }

    /// The Conflux run ends: save the final room, finalize the runs row, clear state,
    /// and notify the frontend.
    pub fn on_conflux_run_end(&mut self) {
        let Some(run_id) = self.active_run_id else { return };

        let mut room_count = self.active_room_index;
        if self.status == ParserStatus::InProgress {
            self.update_status(ParserStatus::Stopped);
            if self.has_damage() {
                let _ = self.save_room_to_db();
                room_count += 1;
            }
        }

        let now = Utc::now().timestamp_millis();
        let duration = (now - self.active_run_start).max(1);
        if let Some(conn) = &self.db {
            let _ = finalize_run(
                conn,
                run_id,
                now,
                duration,
                room_count,
                true,
                &self.active_run_buffs,
            );
        }

        self.active_run_id = None;
        self.active_run_buffs.clear();
        self.active_room_index = 0;

        if let Some(app) = &self.app {
            let _ = app.emit_all("conflux-run-saved", run_id);
        }
    }

    /// Saves the current encounter as a room row (like save_encounter_to_db, but
    /// stamped with run_id/room_index/total_damage). Returns the inserted log id.
    fn save_room_to_db(&mut self) -> Result<Option<i64>> {
        let run_id = self.active_run_id;
        let room_index = self.active_room_index;
        self.save_encounter_to_db_inner(run_id, Some(room_index))
    }
```

- [ ] **Step 6: Refactor `save_encounter_to_db` to accept run tagging**

Rename the existing `save_encounter_to_db` body into `save_encounter_to_db_inner(&mut self, run_id: Option<i64>, room_index: Option<u32>)`, and keep a thin `save_encounter_to_db` that calls it with `None, None`. Add `run_id`, `room_index`, `total_damage` to the INSERT.

Replace the existing `fn save_encounter_to_db(&mut self) -> Result<Option<i64>> {` signature and INSERT with:

```rust
    fn save_encounter_to_db(&mut self) -> Result<Option<i64>> {
        self.save_encounter_to_db_inner(None, None)
    }

    fn save_encounter_to_db_inner(
        &mut self,
        run_id: Option<i64>,
        room_index: Option<u32>,
    ) -> Result<Option<i64>> {
        let duration_in_millis = self.derived_state.duration();
        let start_datetime = self.derived_state.utc_start_time()?;
        let total_damage = self.derived_state.total_damage as i64;

        let primary_target = self
            .derived_state
            .get_primary_target()
            .map(|target| target.raw_target_type);

        if primary_target == Some(0xA379AC65) {
            self.encounter.quest_id = None;
            self.encounter.quest_timer = None;
        }

        let encounter_data = self.encounter.to_blob()?;

        let p1 = self.encounter.player_data[0].as_ref();
        let p2 = self.encounter.player_data[1].as_ref();
        let p3 = self.encounter.player_data[2].as_ref();
        let p4 = self.encounter.player_data[3].as_ref();

        if let Some(conn) = &mut self.db {
            conn.execute(
                r#"INSERT INTO logs (
                        name, time, duration, data, version, primary_target,
                        p1_name, p1_type, p2_name, p2_type, p3_name, p3_type, p4_name, p4_type,
                        quest_id, quest_elapsed_time, quest_completed,
                        run_id, room_index, total_damage
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
                params![
                    "",
                    start_datetime.timestamp_millis(),
                    duration_in_millis,
                    &encounter_data,
                    1,
                    primary_target,
                    p1.map(|p| p.display_name.as_str()),
                    p1.map(|p| p.character_type.to_string()),
                    p2.map(|p| p.display_name.as_str()),
                    p2.map(|p| p.character_type.to_string()),
                    p3.map(|p| p.display_name.as_str()),
                    p3.map(|p| p.character_type.to_string()),
                    p4.map(|p| p.display_name.as_str()),
                    p4.map(|p| p.character_type.to_string()),
                    self.encounter.quest_id,
                    self.encounter.quest_timer,
                    self.encounter.quest_completed,
                    run_id,
                    room_index,
                    total_damage
                ],
            )?;
            let id = conn.last_insert_rowid();
            return Ok(Some(id));
        }
        Ok(None)
    }
```

- [ ] **Step 7: Run the tests to confirm they pass**

Run: `cargo test -p gbfr-logs parser::v1::tests::conflux_run_lifecycle_groups_rooms_and_buffs parser::v1::tests::buff_and_room_without_active_run_are_ignored_for_runs`
Expected: PASS (both).

- [ ] **Step 8: Run the whole crate's tests to catch regressions**

Run: `cargo test -p gbfr-logs`
Expected: PASS (existing parser tests unaffected).

- [ ] **Step 9: Commit**

```bash
git add src-tauri/src/parser/v1/mod.rs
git commit -m "feat(parser): Conflux run lifecycle — group rooms and buff deltas"
```

---

## Task 5: Tauri — wire messages + fetch_conflux_runs command

**Files:**
- Modify: `src-tauri/src/main.rs` (the `connect_and_run_parser` match ~line 475-506; a new command; `generate_handler!` ~line 684)

- [ ] **Step 1: Wire the four new messages into the parser dispatch**

In `connect_and_run_parser`'s `match msg { ... }` (after `Message::OnDeathEvent(event) => {...}`), add:

```rust
                                protocol::Message::ConfluxRunStart(_) => {
                                    state.on_conflux_run_start();
                                }
                                protocol::Message::ConfluxRoomEnter(event) => {
                                    state.on_conflux_room_enter(event);
                                }
                                protocol::Message::ConfluxBuffAcquired(event) => {
                                    state.on_conflux_buff_acquired(event);
                                }
                                protocol::Message::ConfluxRunEnd(_) => {
                                    state.on_conflux_run_end();
                                }
```

- [ ] **Step 2: Add the `fetch_conflux_runs` command + response struct**

Near `fetch_logs` in `src-tauri/src/main.rs`, add:

```rust
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfluxSearchResult {
    runs: Vec<db::runs::ConfluxRun>,
    page: u32,
    page_count: u32,
    run_count: i32,
}

#[tauri::command]
fn fetch_conflux_runs(page: Option<u32>) -> Result<ConfluxSearchResult, String> {
    let conn = db::connect_to_db().map_err(|e| e.to_string())?;
    let page = page.unwrap_or(1);
    let per_page = 10u32;
    let offset = page.saturating_sub(1) * per_page;

    let runs = db::runs::get_runs(&conn, per_page, offset).map_err(|e| e.to_string())?;
    let run_count = db::runs::get_runs_count(&conn).map_err(|e| e.to_string())?;
    let page_count = (run_count as f64 / per_page as f64).ceil() as u32;

    Ok(ConfluxSearchResult { runs, page, page_count, run_count })
}
```

- [ ] **Step 3: Register the command**

In `tauri::generate_handler![ ... ]`, add `fetch_conflux_runs,` alongside `fetch_logs,`.

- [ ] **Step 4: Build the backend**

Run: `cargo build -p gbfr-logs`
Expected: PASS (all four messages handled, command registered).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/main.rs
git commit -m "feat(tauri): dispatch Conflux messages + fetch_conflux_runs command"
```

---

## Task 6: Hook — promote endless.rs emitters

**Files:**
- Modify: `src-hook/src/hooks/endless.rs`

- [ ] **Step 1: Give the three hooks an `event::Tx` and emit messages**

For `OnReceptionFlowDispatchHook`, `OnEndlessBuffInstallHook`, `OnEndlessMgrDtorHook`:
- Add a `tx: crate::event::Tx` field; change `new()` to `new(tx: crate::event::Tx) -> Self`.
- Keep the `#[cfg(feature = "hookdiag")]` diagnostic logging where present.
- Emit the real message (make emission unconditional, not `hookdiag`-gated):

In `OnReceptionFlowDispatchHook::run`, after computing `flow_type_after`, emit run-start
**only on the null/other → EndlessMode transition**. Add near the top of the impl:

```rust
/// The EndlessMode reception-flow type hash (flow+0x7c8). See endless.rs header.
const ENDLESS_FLOW_TYPE: u32 = 0x887ae0b0;
```

Then in `run`, after `let flow_type_after = ...`:

```rust
        // Run START edge: transitioned INTO an EndlessMode flow.
        if flow_type_before != ENDLESS_FLOW_TYPE && flow_type_after == ENDLESS_FLOW_TYPE {
            let _ = self.tx.send(protocol::Message::ConfluxRunStart(
                protocol::ConfluxRunStartEvent {},
            ));
        }
```

In `OnEndlessBuffInstallHook::run`, emit the buff id. The buff id is read from the buff
component; per the endless.rs notes the ability slots populate at +0xc0 (stride 0x80). Emit
the id at +0xc0 as the representative buff id (the parser dedups):

```rust
        let buff_id = crate::hooks::diag::read_u32_guarded(a1 as usize, 0xc0);
        if buff_id != 0 {
            let _ = self.tx.send(protocol::Message::ConfluxBuffAcquired(
                protocol::ConfluxBuffAcquiredEvent { buff_id },
            ));
        }
```

> NOTE (buff-ID risk): `read_u32_guarded(base, off)` reads `*(base+off)` guarded. If live
> testing shows +0xc0 is not the stable buff id, this single line is where to adjust the
> offset; grouping/meters are unaffected. This is the deliberately-isolated risk point.

In `OnEndlessMgrDtorHook::run`, emit run-end before calling the original:

```rust
        let _ = self.tx.send(protocol::Message::ConfluxRunEnd(
            protocol::ConfluxRunEndEvent {},
        ));
```

- [ ] **Step 2: Make emission compile without `hookdiag`**

The three `run` methods and the `tx` field must exist regardless of features. Ensure the
`run` methods are NOT `#[cfg(feature = "hookdiag")]`-gated (only the internal `diag::ev!` /
`probe_*` calls are). `setup` for the non-hookdiag path still returns `Ok(())` but the hook
must still install to emit — see Step 3.

- [ ] **Step 3: Install the hooks in non-hookdiag builds too**

The current `#[cfg(not(feature = "hookdiag"))] setup` is a no-op. Change all three hooks so
`setup` installs the detour in BOTH builds (the detour is what lets us emit). Replace the
two `setup` variants with a single unconditional `setup` that searches the signature and
enables the detour (same body as the current `hookdiag` variant), keeping `diag::*` calls
inside `run` behind `#[cfg(feature = "hookdiag")]`.

Example for `OnEndlessMgrDtorHook` (apply the analogous change to the other two):

```rust
    pub fn setup(&self, process: &Process) -> Result<()> {
        let cloned_self = self.clone();
        if let Ok(addr) = process.search_address(ON_ENDLESS_MGR_DTOR_SIG) {
            unsafe {
                let func: OnEndlessMgrDtorFunc = std::mem::transmute(addr);
                OnEndlessMgrDtor.initialize(func, move |a1| cloned_self.run(a1))?;
                OnEndlessMgrDtor.enable()?;
            }
            Ok(())
        } else {
            Err(anyhow!("Could not find endless_mgr_dtor"))
        }
    }
```

Remove the now-unused `#[cfg(feature = "hookdiag")]` gates on the signature consts, the
detour statics, and the func typedefs (they are needed unconditionally now). Keep
`use anyhow::anyhow;` unconditional.

- [ ] **Step 3b: Add `tx` field + struct derives**

Each of the three structs becomes e.g.:

```rust
#[derive(Clone)]
pub struct OnEndlessMgrDtorHook {
    tx: crate::event::Tx,
}
impl OnEndlessMgrDtorHook {
    pub fn new(tx: crate::event::Tx) -> Self {
        OnEndlessMgrDtorHook { tx }
    }
    // ... setup + run
}
```

- [ ] **Step 4: Build the hook (release + console feature)**

Run: `cargo build -p hook`
Expected: PASS. Then verify the diag feature still compiles:
Run: `cargo build -p hook --features hookdiag`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-hook/src/hooks/endless.rs
git commit -m "feat(hook): emit Conflux run-start/buff/run-end messages"
```

---

## Task 7: Hook — promote quest.rs room-enter emitter

**Files:**
- Modify: `src-hook/src/hooks/quest.rs`

- [ ] **Step 1: Give `OnLoadQuestHook` an `event::Tx`**

Change the struct + `new`:

```rust
#[derive(Clone)]
pub struct OnLoadQuestHook {
    tx: event::Tx,
}

impl OnLoadQuestHook {
    pub fn new(tx: event::Tx) -> Self {
        OnLoadQuestHook { tx }
    }
```

- [ ] **Step 2: Emit room-enter when inside an EndlessMode run**

In `OnLoadQuestHook::run`, after storing `QUEST_STATE_PTR` and before the `#[cfg(feature = "hookdiag")]` block, add:

```rust
        // Conflux room boundary: if this quest load happens while an EndlessMode
        // reception flow is active, it's a room enter. The reception-flow slot lives
        // at manager+0x210; its type hash at flow+0x7c8 identifies EndlessMode.
        let reception_flow = unsafe { a1.byte_add(0x210).read() };
        let flow_type = crate::hooks::diag::read_u32_guarded(reception_flow, 0x7c8);
        if flow_type == 0x887ae0b0 {
            let quest_id = unsafe { (*quest_state_ptr).quest_id };
            let _ = self.tx.send(Message::ConfluxRoomEnter(
                protocol::ConfluxRoomEnterEvent { quest_id },
            ));
        }
```

(Confirm `read_u32_guarded` is reachable from quest.rs — it is `pub` in `hooks::diag` per
endless.rs usage. `Message` is already imported; add `use protocol;` if needed, or fully
qualify `protocol::ConfluxRoomEnterEvent`.)

- [ ] **Step 3: Build the hook**

Run: `cargo build -p hook`
Expected: FAIL — `OnLoadQuestHook::new()` in mod.rs is called with no args. Fixed in Task 8.

- [ ] **Step 4: Commit (after Task 8 makes it build) — defer commit to Task 8.**

---

## Task 8: Hook — wire tx into mod.rs setup

**Files:**
- Modify: `src-hook/src/hooks/mod.rs:93,98-109`

- [ ] **Step 1: Pass `tx.clone()` to the promoted hooks**

Update the `try_step` calls:

```rust
    try_step("quest_load_state", OnLoadQuestHook::new(tx.clone()).setup(&process));
```

```rust
    try_step(
        "endless_reception",
        OnReceptionFlowDispatchHook::new(tx.clone()).setup(&process),
    );
    try_step(
        "endless_buff_install",
        OnEndlessBuffInstallHook::new(tx.clone()).setup(&process),
    );
    try_step(
        "endless_run_end",
        OnEndlessMgrDtorHook::new(tx.clone()).setup(&process),
    );
```

- [ ] **Step 2: Build the whole hook crate (both feature sets)**

Run: `cargo build -p hook`
Expected: PASS.
Run: `cargo build -p hook --features hookdiag`
Expected: PASS.

- [ ] **Step 3: Build the workspace**

Run: `cargo build`
Expected: PASS.

- [ ] **Step 4: Commit (quest.rs + mod.rs together)**

```bash
git add src-hook/src/hooks/quest.rs src-hook/src/hooks/mod.rs
git commit -m "feat(hook): emit Conflux room-enter + wire tx into setup"
```

---

## Task 9: Frontend types

**Files:**
- Modify: `src/types.ts` (after the `Log` type ~line 256)

- [ ] **Step 1: Add the Conflux types**

```typescript
export type ConfluxBuffDelta = {
  roomIndex: number;
  buffIds: number[];
};

export type ConfluxRoom = {
  logId: number;
  roomIndex: number;
  questId: number | null;
  primaryTarget: number | null;
  duration: number;
  totalDamage: number | null;
};

export type ConfluxRun = {
  id: number;
  startTime: number;
  endTime: number | null;
  duration: number | null;
  roomCount: number;
  completed: boolean | null;
  buffs: ConfluxBuffDelta[];
  rooms: ConfluxRoom[];
};

export type ConfluxSearchResult = {
  runs: ConfluxRun[];
  page: number;
  pageCount: number;
  runCount: number;
};
```

- [ ] **Step 2: Typecheck**

Run: `npm run build` (runs `tsc`) — or `npx tsc --noEmit`.
Expected: PASS (types are unused so far, but valid).

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat(ui): Conflux run/room/buff types"
```

---

## Task 10: Frontend — Conflux index page + hook

**Files:**
- Create: `src/pages/logs/useConfluxIndex.tsx`
- Create: `src/pages/logs/ConfluxIndex.tsx`

- [ ] **Step 1: Create the data hook**

`src/pages/logs/useConfluxIndex.tsx`:

```tsx
import { ConfluxSearchResult } from "@/types";
import { invoke } from "@tauri-apps/api";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";

const EMPTY: ConfluxSearchResult = { runs: [], page: 1, pageCount: 1, runCount: 0 };

export default function useConfluxIndex() {
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<ConfluxSearchResult>(EMPTY);

  const fetchRuns = useCallback(async () => {
    try {
      const res = await invoke<ConfluxSearchResult>("fetch_conflux_runs", { page });
      setResult(res);
    } catch (e) {
      console.error("fetch_conflux_runs failed", e);
      setResult(EMPTY);
    }
  }, [page]);

  useEffect(() => {
    fetchRuns();
  }, [fetchRuns]);

  useEffect(() => {
    const l = listen("conflux-run-saved", () => fetchRuns());
    return () => {
      l.then((f) => f());
    };
  }, [fetchRuns]);

  return { result, page, setPage };
}
```

- [ ] **Step 2: Create the page with expandable run rows**

`src/pages/logs/ConfluxIndex.tsx`:

```tsx
import { ConfluxRoom, ConfluxRun } from "@/types";
import { epochToLocalTime, millisecondsToElapsedFormat, translateEnemyTypeId, translateQuestId } from "@/utils";
import { Badge, Box, Button, Center, Collapse, Divider, Group, Pagination, Table, Text } from "@mantine/core";
import { CaretDown, CaretRight } from "@phosphor-icons/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import useConfluxIndex from "./useConfluxIndex";

function formatDamage(n: number | null): string {
  if (n === null) return "-";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function RoomRow({ room, buffIds }: { room: ConfluxRoom; buffIds: number[] }) {
  const { t } = useTranslation();
  return (
    <Table.Tr>
      <Table.Td />
      <Table.Td>
        <Text size="xs">#{room.roomIndex + 1}</Text>
      </Table.Td>
      <Table.Td>
        <Text size="xs">{room.questId ? translateQuestId(room.questId) : ""}</Text>
      </Table.Td>
      <Table.Td>
        <Text size="xs">{room.primaryTarget !== null ? translateEnemyTypeId(room.primaryTarget) : ""}</Text>
      </Table.Td>
      <Table.Td>
        <Text size="xs">{millisecondsToElapsedFormat(room.duration)}</Text>
      </Table.Td>
      <Table.Td>
        <Text size="xs">{formatDamage(room.totalDamage)}</Text>
      </Table.Td>
      <Table.Td>
        <Group gap={4}>
          {buffIds.map((id) => (
            <Badge key={id} size="xs" variant="light">
              {t(`conflux-buffs:${id}`, String(id))}
            </Badge>
          ))}
        </Group>
      </Table.Td>
      <Table.Td>
        <Button size="xs" variant="default" component={Link} to={`/logs/${room.logId}`}>
          View
        </Button>
      </Table.Td>
    </Table.Tr>
  );
}

function RunRow({ run }: { run: ConfluxRun }) {
  const [open, setOpen] = useState(false);
  const buffsFor = (roomIndex: number) => run.buffs.find((b) => b.roomIndex === roomIndex)?.buffIds ?? [];

  return (
    <>
      <Table.Tr style={{ cursor: "pointer" }} onClick={() => setOpen((o) => !o)}>
        <Table.Td>{open ? <CaretDown size="1rem" /> : <CaretRight size="1rem" />}</Table.Td>
        <Table.Td>
          <Text size="xs">{epochToLocalTime(run.startTime)}</Text>
        </Table.Td>
        <Table.Td>
          <Text size="xs">Conflux Run</Text>
        </Table.Td>
        <Table.Td>
          <Badge size="xs" variant="light">
            ×{run.roomCount} rooms
          </Badge>
        </Table.Td>
        <Table.Td>
          <Text size="xs">{run.duration ? millisecondsToElapsedFormat(run.duration) : ""}</Text>
        </Table.Td>
        <Table.Td>
          <Text size="xs">{run.completed === null ? "" : run.completed ? "✓" : "✗"}</Text>
        </Table.Td>
        <Table.Td />
        <Table.Td />
      </Table.Tr>
      <Table.Tr>
        <Table.Td colSpan={8} style={{ padding: 0, border: open ? undefined : "none" }}>
          <Collapse in={open}>
            <Table>
              <Table.Tbody>
                {run.rooms.map((room) => (
                  <RoomRow key={room.logId} room={room} buffIds={buffsFor(room.roomIndex)} />
                ))}
              </Table.Tbody>
            </Table>
          </Collapse>
        </Table.Td>
      </Table.Tr>
    </>
  );
}

export const ConfluxIndexPage = () => {
  const { result, page, setPage } = useConfluxIndex();

  return (
    <Box>
      <Group>
        <Text>Conflux Runs ({result.runCount})</Text>
      </Group>
      {result.runs.length === 0 ? (
        <Center py="xl">
          <Text c="dimmed">No Conflux runs recorded yet.</Text>
        </Center>
      ) : (
        <Box>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th />
                <Table.Th>Date</Table.Th>
                <Table.Th>Type</Table.Th>
                <Table.Th>Rooms</Table.Th>
                <Table.Th>Duration</Table.Th>
                <Table.Th>Cleared</Table.Th>
                <Table.Th />
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {result.runs.map((run) => (
                <RunRow key={run.id} run={run} />
              ))}
            </Table.Tbody>
          </Table>
          <Divider my="sm" />
          <Pagination total={result.pageCount} value={page} onChange={setPage} />
        </Box>
      )}
    </Box>
  );
};
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS. (If `epochToLocalTime`/`millisecondsToElapsedFormat`/`translateEnemyTypeId`/
`translateQuestId` are not exported from `@/utils`, confirm the exact names in `src/utils.ts`
and adjust imports — they are used identically in `src/pages/logs/Index.tsx`.)

- [ ] **Step 4: Commit**

```bash
git add src/pages/logs/ConfluxIndex.tsx src/pages/logs/useConfluxIndex.tsx
git commit -m "feat(ui): Conflux runs page with expandable room breakdown + buffs"
```

---

## Task 11: Frontend — route + nav link

**Files:**
- Modify: `src/App.tsx:17-21`
- Modify: `src/pages/Logs.tsx:54-61`

- [ ] **Step 1: Add the route**

In `src/App.tsx`, import and add the route inside `<Route path="/logs" ...>` (BEFORE the
`:id` route so `conflux` isn't captured as an id):

```tsx
import { ConfluxIndexPage } from "./pages/logs/ConfluxIndex";
```

```tsx
        <Route path="/logs" element={<Logs />}>
          <Route index element={<LogIndexPage />} />
          <Route path="conflux" element={<ConfluxIndexPage />} />
          <Route path=":id" element={<LogViewPage />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>
```

- [ ] **Step 2: Add the nav link**

In `src/pages/Logs.tsx`, import an icon and add a NavLink in the `grow` section under the
existing "Logs" link:

```tsx
import { Gear, House, Flag } from "@phosphor-icons/react";
```

```tsx
          <AppShell.Section grow>
            <NavLink label="Logs" leftSection={<House size="1rem" />} component={Link} to="/logs" />
            <NavLink label="Conflux" leftSection={<Flag size="1rem" />} component={Link} to="/logs/conflux" />
          </AppShell.Section>
```

- [ ] **Step 3: Typecheck + build the frontend**

Run: `npx tsc --noEmit && npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx src/pages/Logs.tsx
git commit -m "feat(ui): Conflux tab route + nav link"
```

---

## Task 12: Full build + verification handoff

- [ ] **Step 1: Build the hook DLL prerequisite + full app**

The Tauri build needs `hook.dll` present. Per the `building-gbfr-logs` skill, build the hook
in release first, then the app:

Run: `cargo build -p hook --release`
Then: `cargo build -p gbfr-logs`
Expected: PASS.

- [ ] **Step 2: Frontend production build**

Run: `npm run build`
Expected: PASS (tsc + vite).

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: PASS (or only pre-existing warnings).

- [ ] **Step 4: Hand off to the user for live verification**

The user drives a Conflux run in-game (requires admin + live game process) to confirm:
- run-start / room-enter / run-end signals fire (watch the console build or `hookdiag`),
- rooms group under a run in the new Conflux tab,
- each room's "View" opens its damage meter,
- per-room buff badges populate (the +0xc0 buff-id offset is the tuning point if not).

- [ ] **Step 5: Final commit if any fixes were applied during verification.**

---

## Self-Review notes

- **Spec coverage:** hooks (Tasks 1,6,7,8) ✓; runs table + logs columns (Task 2) ✓; run
  identity in parser (Task 4) ✓; per-room buff deltas (Task 4 accumulate, Task 6 emit) ✓;
  `fetch_conflux_runs` + message wiring (Task 5) ✓; separate Conflux tab, expandable rows,
  room View reuse, buff display (Tasks 9,10,11) ✓; `conflux-run-saved` refresh (Tasks 4,10) ✓.
- **`total_damage` source:** resolved via a new `logs.total_damage` column populated at save
  (Task 2 + Task 4 Step 6) — avoids decompressing every room blob for the list.
- **Type consistency:** `ConfluxRun`/`ConfluxRoom`/`ConfluxBuffDelta` fields match Rust serde
  camelCase across `db/runs.rs`, `main.rs`, and `types.ts`. Handler names
  (`on_conflux_run_start`/`_room_enter`/`_buff_acquired`/`_run_end`) consistent between parser
  (Task 4) and dispatch (Task 5). Flow-type hash `0x887ae0b0` consistent between endless.rs
  (Task 6) and quest.rs (Task 7).
- **Buff-ID risk** deliberately isolated to one line (Task 6 Step 1) so grouping/meters ship
  regardless.
```
