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

pub fn sweep_orphaned_runs(conn: &Connection) -> Result<()> {
    conn.execute(
        "DELETE FROM runs WHERE end_time IS NULL
         AND NOT EXISTS (SELECT 1 FROM logs WHERE logs.run_id = runs.id)",
        [],
    )?;
    conn.execute(
        "UPDATE runs SET
            end_time = (SELECT MAX(time + duration) FROM logs WHERE logs.run_id = runs.id),
            duration = MAX((SELECT MAX(time + duration) FROM logs WHERE logs.run_id = runs.id), start_time) - start_time,
            room_count = (SELECT COUNT(*) FROM logs WHERE logs.run_id = runs.id)
         WHERE end_time IS NULL",
        [],
    )?;
    Ok(())
}

/// Deletes any run that has no remaining room logs. Unlike [`sweep_orphaned_runs`]
/// (which only reaps still-in-progress runs at startup), this also removes finalized
/// runs, so deleting a run's logs from the Logs page can't leave a permanent
/// zero-room ghost row in the Conflux tab.
pub fn delete_runs_without_rooms(conn: &Connection) -> Result<()> {
    conn.execute(
        "DELETE FROM runs WHERE NOT EXISTS (SELECT 1 FROM logs WHERE logs.run_id = runs.id)",
        [],
    )?;
    Ok(())
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

    // Collect run tuples first so the prepared statement is released before we
    // issue the per-run room queries below (rusqlite borrows `conn` per stmt).
    let run_tuples = run_rows.collect::<rusqlite::Result<Vec<_>>>()?;

    let mut runs = Vec::new();
    for (id, start_time, end_time, duration, _room_count, completed, buffs_json) in run_tuples {
        let buffs: Vec<ConfluxBuffDelta> = buffs_json
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_default();
        let rooms = get_rooms_for_run(conn, id)?;
        // The stored room_count/duration columns are only written at finalize, so an
        // in-progress (or orphaned) run would show 0 rooms and no duration. Derive
        // both from the room logs instead: count what's actually saved, and fall back
        // to "end of the last saved room minus run start" for the duration.
        let room_count = rooms.len() as u32;
        let duration = duration.or_else(|| {
            conn.query_row(
                "SELECT MAX(time + duration) FROM logs WHERE run_id = ?",
                params![id],
                |r| r.get::<_, Option<i64>>(0),
            )
            .ok()
            .flatten()
            .map(|last_room_end| (last_room_end - start_time).max(0))
        });
        runs.push(ConfluxRun {
            id,
            start_time,
            end_time,
            duration,
            room_count,
            completed,
            buffs,
            rooms,
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
    fn sweep_closes_orphans_with_rooms_and_deletes_empty_ones() {
        let conn = migrated_conn();

        // Orphan WITH rooms: gets closed out from its last room's end.
        let orphan = insert_run(&conn, 1_000).unwrap();
        conn.execute(
            "INSERT INTO logs (name, time, duration, data, version, run_id, room_index) VALUES ('',2000,5000,x'00',1,?,0)",
            params![orphan],
        ).unwrap();

        // Orphan WITHOUT rooms: junk row, deleted.
        let empty = insert_run(&conn, 5_000).unwrap();

        // Properly finalized run: untouched.
        let done = insert_run(&conn, 9_000).unwrap();
        finalize_run(&conn, done, 20_000, 11_000, 1, true, &[]).unwrap();

        sweep_orphaned_runs(&conn).unwrap();

        let runs = get_runs(&conn, 10, 0).unwrap();
        assert_eq!(runs.len(), 2, "empty orphan deleted");
        assert!(!runs.iter().any(|r| r.id == empty));

        let swept = runs.iter().find(|r| r.id == orphan).unwrap();
        assert_eq!(
            swept.end_time,
            Some(7_000),
            "closed at last room end (2000+5000)"
        );
        assert_eq!(swept.duration, Some(6_000));
        assert_eq!(
            swept.completed, None,
            "outcome never observed stays unknown"
        );

        let finalized = runs.iter().find(|r| r.id == done).unwrap();
        assert_eq!(finalized.completed, Some(true));
        assert_eq!(finalized.duration, Some(11_000));
    }

    #[test]
    fn in_progress_run_derives_room_count_and_duration_from_saved_rooms() {
        // The stored room_count/duration columns are only written at finalize; an
        // in-progress (or orphaned) run must still show its saved rooms and elapsed
        // time instead of "×0 rooms" with a blank duration.
        let conn = migrated_conn();
        let run_id = insert_run(&conn, 1_000).unwrap();

        conn.execute(
            "INSERT INTO logs (name, time, duration, data, version, run_id, room_index) VALUES ('',2000,5000,x'00',1,?,0)",
            params![run_id],
        ).unwrap();
        conn.execute(
            "INSERT INTO logs (name, time, duration, data, version, run_id, room_index) VALUES ('',9000,4000,x'00',1,?,1)",
            params![run_id],
        ).unwrap();

        let runs = get_runs(&conn, 10, 0).unwrap();
        assert_eq!(runs.len(), 1);
        let run = &runs[0];
        assert_eq!(run.room_count, 2, "counts the saved rooms, not the column");
        // Last room ends at 9000+4000=13000; run started at 1000.
        assert_eq!(run.duration, Some(12_000));
        assert_eq!(run.completed, None);
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
            ConfluxBuffDelta {
                room_index: 0,
                buff_ids: vec![0xAA, 0xBB],
            },
            ConfluxBuffDelta {
                room_index: 1,
                buff_ids: vec![0xCC],
            },
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
