use anyhow::Result;
use log::info;
use rusqlite::Connection;
use rusqlite_migration::{Migrations, M};

pub mod import;
pub mod legality;
pub mod logs;
pub mod runs;

/// Every migration, in order. **Append only — never edit an existing entry**,
/// or a database that already ran it diverges from one that has not.
///
/// Split out of [`setup_db`] so a test can apply the real list to an in-memory
/// database instead of the user's `logs.db`, and so the diagnostic examples can
/// migrate a COPY of a real `logs.db` — they cannot go through [`setup_db`],
/// which hard-codes the app's own data directory.
pub fn migrations() -> Migrations<'static> {
    Migrations::new(vec![
        M::up(
            r#"CREATE TABLE IF NOT EXISTS logs (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            time INTEGER NOT NULL,
            duration INTEGER NOT NULL,
            data BLOB NOT NULL
        )"#,
        ),
        M::up("ALTER TABLE logs ADD COLUMN version INTEGER NOT NULL DEFAULT 0"),
        M::up("ALTER TABLE logs ADD COLUMN primary_target INTEGER"),
        M::up("ALTER TABLE logs ADD COLUMN p1_name TEXT"),
        M::up("ALTER TABLE logs ADD COLUMN p1_type TEXT"),
        M::up("ALTER TABLE logs ADD COLUMN p2_name TEXT"),
        M::up("ALTER TABLE logs ADD COLUMN p2_type TEXT"),
        M::up("ALTER TABLE logs ADD COLUMN p3_name TEXT"),
        M::up("ALTER TABLE logs ADD COLUMN p3_type TEXT"),
        M::up("ALTER TABLE logs ADD COLUMN p4_name TEXT"),
        M::up("ALTER TABLE logs ADD COLUMN p4_type TEXT"),
        M::up("ALTER TABLE logs ADD COLUMN quest_id INTEGER"),
        M::up("ALTER TABLE logs ADD COLUMN quest_elapsed_time INTEGER"),
        M::up("ALTER TABLE logs ADD COLUMN quest_completed BOOLEAN"),
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
        // Stored build-legality verdicts. This is the only DDL for the table —
        // `legality`'s own tests migrate an in-memory db through here rather
        // than applying a copy that could drift away from it.
        M::up(
            r#"CREATE TABLE IF NOT EXISTS legality_findings (
            log_id INTEGER NOT NULL,
            player_index INTEGER NOT NULL,
            display_name TEXT NOT NULL,
            character_type TEXT NOT NULL,
            severity TEXT NOT NULL,
            rule TEXT NOT NULL,
            payload TEXT NOT NULL
        )"#,
        ),
        M::up("CREATE INDEX IF NOT EXISTS legality_findings_log ON legality_findings (log_id)"),
        // NULL means "never audited", which is every log that existed before
        // this shipped — the startup sweep treats it as stale and backfills.
        M::up("ALTER TABLE logs ADD COLUMN legality_rules_version INTEGER"),
        // 1 on rows copied in from another installation's logs.db, so the UI
        // can mark them: an imported log may lack data the source app never
        // recorded. Defaulted 0 — everything already here was recorded live.
        M::up("ALTER TABLE logs ADD COLUMN imported BOOLEAN NOT NULL DEFAULT 0"),
    ])
}

/// Setup database and run migrations.
pub fn setup_db() -> Result<()> {
    info!("Setting up the database, opening logs.db..");

    let mut conn = Connection::open(crate::data_paths::data_dir().join("logs.db"))?;

    conn.pragma_update(None, "journal_mode", "WAL")?;

    info!("Database found, running migrations..");

    migrations().to_latest(&mut conn)?;

    runs::sweep_orphaned_runs(&conn)?;
    legality::sweep_orphaned_findings(&conn)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Logs predating the legality work carry a NULL stamp, which is what
    /// marks them for the startup sweep. A `NOT NULL DEFAULT` here would have
    /// stamped every existing log as current and silently skipped the entire
    /// backfill.
    #[test]
    fn existing_logs_are_left_unstamped_so_the_sweep_finds_them() {
        let mut conn = Connection::open_in_memory().expect("in-memory db");
        migrations().to_latest(&mut conn).expect("migrations apply");

        conn.execute(
            "INSERT INTO logs (name, time, duration, data, version) VALUES ('', 1, 1, x'00', 1)",
            [],
        )
        .expect("insert a log the way a pre-legality build would");

        let stamp: Option<u32> = conn
            .query_row("SELECT legality_rules_version FROM logs", [], |row| {
                row.get(0)
            })
            .expect("read the stamp");
        assert_eq!(stamp, None);
    }
}

/// Copy the whole log store to `path`. `VACUUM INTO` rather than a file copy
/// for the same reason `settings_db::export_to` uses it: the database runs in
/// WAL mode, so copying logs.db alone would silently miss every encounter
/// still sitting in the -wal sidecar.
pub fn export_to(conn: &Connection, path: &std::path::Path) -> Result<()> {
    conn.execute("VACUUM INTO ?", [path.to_string_lossy().as_ref()])?;
    Ok(())
}

/// Connect to database.
pub fn connect_to_db() -> Result<Connection> {
    let conn = Connection::open(crate::data_paths::data_dir().join("logs.db"))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;

    Ok(conn)
}
