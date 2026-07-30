use anyhow::Result;
use log::info;
use rusqlite::Connection;
use rusqlite_migration::{Migrations, M};

pub mod legality;
pub mod logs;
pub mod runs;

/// Every migration, in order. **Append only — never edit an existing entry**,
/// or a database that already ran it diverges from one that has not.
///
/// Split out of [`setup_db`] so a test can apply the real list to an in-memory
/// database instead of the user's `logs.db`.
fn migrations() -> Migrations<'static> {
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
        // Stored build-legality verdicts. The DDL is `legality::SCHEMA` split
        // into one migration per statement, so the tests in that module
        // exercise the shape this creates.
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

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The migration that creates `legality_findings` and the `SCHEMA` the
    /// module's own tests run against are two copies of one DDL, and only this
    /// notices when they drift. A migration is append-only, so a divergence
    /// here can never be fixed by editing the migration — it would have to be
    /// a whole new one, which is exactly the mess worth catching early.
    #[test]
    fn the_migrations_build_the_findings_table_the_legality_module_expects() {
        let mut conn = Connection::open_in_memory().expect("in-memory db");
        migrations().to_latest(&mut conn).expect("migrations apply");

        let finding = crate::legality::Finding {
            rule: crate::legality::Rule::SummonBonusMagnitude,
            severity: crate::legality::Severity::Impossible,
            subject: crate::legality::Subject::Summon(3),
            observed: crate::legality::Value::Amount(75.0),
            allowed: crate::legality::Value::Amount(50.0),
            odds: None,
        };

        legality::write_findings(&conn, 537, 2, "炎顺帝", "Pl1600", &[finding.clone()])
            .expect("the migrated table accepts what the module writes");
        let stored = legality::findings_for_log(&conn, 537).expect("read back");
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].finding, finding);
    }

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

/// Connect to database.
pub fn connect_to_db() -> Result<Connection> {
    let conn = Connection::open(crate::data_paths::data_dir().join("logs.db"))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;

    Ok(conn)
}
