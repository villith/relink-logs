//! The app's durable settings store.
//!
//! Deliberately a *separate* database from `logs.db`: a user who deletes one to
//! reclaim space must not lose the other, and a corrupt settings file must not
//! cost anyone their encounter history.
//!
//! Values are opaque strings — the zustand persist envelope, verbatim. Rust
//! never learns a store's shape, so schema evolution stays in the frontend
//! where zustand's `version`/`migrate` already handle it.
//!
//! This exists because every user-authored setting used to live only in the
//! webview's `localStorage`, which the app neither owns nor backs up. On Linux
//! each window gets its own `WebContext` over one data directory
//! (tauri-apps/tauri#10981), and users lost their toolbox data across updates.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use anyhow::{bail, Result};
use rusqlite::Connection;
use rusqlite_migration::{Migrations, M};

/// Every migration, in order. **Append only — never edit an existing entry**,
/// or a database that already ran it diverges from one that has not.
///
/// Split out of [`setup`] the same way `db::migrations()` is, so tests apply
/// the real list to an in-memory database instead of the user's file.
///
/// `updated_at` is written but nothing reads it: change detection compares
/// values, not timestamps. It is there for a human looking at the file with a
/// sqlite shell, and as the only material a future conflict resolution would
/// have — do not mistake it for live data.
pub fn migrations() -> Migrations<'static> {
    Migrations::new(vec![M::up(
        r#"CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY NOT NULL,
            value TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        )"#,
    )])
}

/// Open `settings.db`, in WAL mode with a busy timeout: anything else holding
/// the file (a stray copy of the app, a user's sqlite shell) must make a write
/// wait rather than return `SQLITE_BUSY`.
///
/// `synchronous = NORMAL` because the commands that reach this are declared
/// without `async`, which in Tauri v1 means they run on the main thread — and
/// they run *often*: a settings write happens on every store mutation, and a
/// Mantine `Slider`/`ColorInput` `onChange` fires per pointer move, so dragging
/// the transparency slider is one commit per frame. The default `FULL` fsyncs
/// each of those. In WAL mode `NORMAL` is the documented safe setting: it
/// cannot corrupt the database, it only risks losing the last few commits to a
/// power cut — which for a settings file costs the user one slider drag.
fn open() -> Result<Connection> {
    let conn = Connection::open(crate::data_paths::data_dir().join("settings.db"))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    Ok(conn)
}

/// Run `f` against the process-wide connection, opening it on first use.
///
/// One connection for the app's lifetime, deliberately: settings are written on
/// every store mutation, which includes continuous controls — dragging the
/// transparency slider or the colour picker writes per pointer move. Opening a
/// connection per write meant re-running the WAL pragma and then, on drop,
/// checkpointing and unlinking `-wal`/`-shm` every time, in the install
/// directory. `logs.db`'s per-call `connect_to_db` is fine by contrast because
/// its callers are once-in-a-while user actions.
fn with_conn<T>(f: impl FnOnce(&mut Connection) -> Result<T>) -> Result<T> {
    static CONN: OnceLock<Mutex<Connection>> = OnceLock::new();

    if CONN.get().is_none() {
        // A loser of the race simply drops its connection; either is usable.
        let _ = CONN.set(Mutex::new(open()?));
    }

    let mut guard = CONN
        .get()
        .expect("connection was just initialised")
        .lock()
        // A panic mid-write cannot corrupt the database — SQLite either
        // committed the statement or it did not — so the poison is not a
        // reason to stop persisting settings.
        .unwrap_or_else(|e| e.into_inner());

    f(&mut guard)
}

/// Create the database and bring it to the latest migration.
pub fn setup() -> Result<()> {
    with_conn(|conn| Ok(migrations().to_latest(conn)?))
}

/// Every stored setting. See [`get_all`].
pub fn read_all() -> Result<HashMap<String, String>> {
    with_conn(|conn| get_all(conn))
}

/// Upsert one key, reporting whether it changed. See [`set`].
pub fn write(key: &str, value: &str) -> Result<bool> {
    with_conn(|conn| set(conn, key, value))
}

/// Remove one key, reporting whether it existed. See [`delete`].
pub fn remove(key: &str) -> Result<bool> {
    with_conn(|conn| delete(conn, key))
}

/// Copy the whole store to `path`. `VACUUM INTO` rather than a file copy for
/// the same reason `export_logs_db` uses it: the database runs in WAL mode, so
/// copying the file alone would miss writes still sitting in the -wal sidecar.
pub fn export_to(path: &Path) -> Result<()> {
    with_conn(|conn| {
        conn.execute("VACUUM INTO ?", [path.to_string_lossy().as_ref()])?;
        Ok(())
    })
}

/// Every row of a *source* settings database, after checking it is one.
fn read_source_settings(source: &Connection) -> Result<Vec<(String, String)>> {
    let columns: Vec<String> = source
        .prepare("SELECT name FROM pragma_table_info('settings')")?
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for required in ["key", "value"] {
        if !columns.iter().any(|c| c == required) {
            bail!("not a settings database: no `settings.{required}` column");
        }
    }

    let mut stmt = source.prepare("SELECT key, value FROM settings")?;
    let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Overwrite our settings with every row of the settings database at `path`
/// (an export, or another installation's settings.db). Keys the source lacks
/// are kept. Returns the pairs whose stored value actually changed, so the
/// caller can announce exactly those to the windows.
///
/// The source open (read-only first, retried writable so SQLite can recover a
/// WAL sidecar) is the logs importer's `with_source`.
pub fn import_from(path: &Path) -> Result<Vec<(String, String)>> {
    let rows = crate::db::import::with_source(path, read_source_settings)?;

    with_conn(|conn| {
        let mut changed = Vec::new();
        for (key, value) in rows {
            if set(conn, &key, &value)? {
                changed.push((key, value));
            }
        }
        Ok(changed)
    })
}

/// Delete every stored setting, returning the keys that were removed so the
/// caller can tell the windows which caches to drop.
pub fn reset_all() -> Result<Vec<String>> {
    with_conn(|conn| {
        let keys: Vec<String> = conn
            .prepare("SELECT key FROM settings")?
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        conn.execute("DELETE FROM settings", [])?;
        Ok(keys)
    })
}

/// Every stored setting. One round trip, because the frontend wants the whole
/// set at startup and there are only a handful of rows.
pub fn get_all(conn: &Connection) -> Result<HashMap<String, String>> {
    let mut stmt = conn.prepare("SELECT key, value FROM settings")?;
    let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;

    Ok(rows.collect::<rusqlite::Result<HashMap<String, String>>>()?)
}

/// Upsert one key. Last write wins, which is what the cross-window event then
/// reconciles.
///
/// Returns whether the stored value actually changed. Writing the value a key
/// already holds is a no-op — the `WHERE` on the upsert leaves the row (and
/// the file) untouched — and the caller must not broadcast one, because a
/// window that hears a change rehydrates, and rehydrating writes back. Callers
/// on both sides suppress that echo, but this is the layer that can guarantee
/// termination: an unchanged value announces nothing, so no sync loop between
/// windows can sustain itself no matter who writes.
pub fn set(conn: &Connection, key: &str, value: &str) -> Result<bool> {
    let changed = conn.execute(
        "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
         WHERE settings.value <> excluded.value",
        rusqlite::params![key, value, chrono::Utc::now().timestamp()],
    )?;
    Ok(changed > 0)
}

/// Remove one key. Required by zustand's `StateStorage` contract.
///
/// Returns whether a row was actually removed, for the same reason [`set`]
/// does: deleting an absent key is not a change and must not be announced.
pub fn delete(conn: &Connection, key: &str) -> Result<bool> {
    let removed = conn.execute(
        "DELETE FROM settings WHERE key = ?1",
        rusqlite::params![key],
    )?;
    Ok(removed > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn migrated() -> Connection {
        let mut conn = Connection::open_in_memory().expect("in-memory db");
        migrations().to_latest(&mut conn).expect("migrations apply");
        conn
    }

    #[test]
    fn set_then_get_all_round_trips() {
        let conn = migrated();
        set(&conn, "meter-settings", r#"{"state":{}}"#).expect("set");

        let all = get_all(&conn).expect("get_all");
        assert_eq!(
            all.get("meter-settings").map(String::as_str),
            Some(r#"{"state":{}}"#)
        );
    }

    /// The whole point of the store: a second write to one key replaces it.
    /// A plain INSERT would fail on the primary key and lose the new value.
    #[test]
    fn writing_a_key_twice_replaces_it() {
        let conn = migrated();
        set(&conn, "synthesis-form", "first").expect("first set");
        set(&conn, "synthesis-form", "second").expect("second set");

        let all = get_all(&conn).expect("get_all");
        assert_eq!(all.len(), 1);
        assert_eq!(
            all.get("synthesis-form").map(String::as_str),
            Some("second")
        );
    }

    #[test]
    fn delete_removes_only_the_named_key() {
        let conn = migrated();
        set(&conn, "a", "1").expect("set a");
        set(&conn, "b", "2").expect("set b");

        delete(&conn, "a").expect("delete a");

        let all = get_all(&conn).expect("get_all");
        assert_eq!(all.len(), 1);
        assert!(all.contains_key("b"));
    }

    #[test]
    fn get_all_on_an_empty_store_is_empty_not_an_error() {
        assert!(get_all(&migrated()).expect("get_all").is_empty());
    }

    /// The termination guarantee for cross-window sync: rewriting the value a
    /// key already holds reports "no change", so the caller emits nothing and
    /// the other window is never told to rehydrate. Without this, two windows
    /// echoing each other's writes never reach a fixed point.
    #[test]
    fn rewriting_an_identical_value_reports_no_change() {
        let conn = migrated();

        assert!(set(&conn, "meter-settings", "same").expect("first set"));
        assert!(!set(&conn, "meter-settings", "same").expect("second set"));
        assert!(set(&conn, "meter-settings", "different").expect("third set"));
    }

    #[test]
    fn deleting_an_absent_key_reports_no_change() {
        let conn = migrated();
        set(&conn, "a", "1").expect("set a");

        assert!(delete(&conn, "a").expect("delete a"));
        assert!(!delete(&conn, "a").expect("delete a again"));
        assert!(!delete(&conn, "never-existed").expect("delete absent"));
    }

    /// A picked file that is not a settings database reports an error instead
    /// of silently importing nothing.
    #[test]
    fn a_database_without_a_settings_table_is_rejected() {
        let conn = Connection::open_in_memory().expect("in-memory db");

        let err = read_source_settings(&conn).expect_err("reject");

        assert!(err.to_string().contains("not a settings database"));
    }

    #[test]
    fn a_source_settings_database_reads_every_row() {
        let conn = migrated();
        set(&conn, "meter-settings", "a").expect("set");
        set(&conn, "i18nextLng", "en").expect("set");

        let mut rows = read_source_settings(&conn).expect("read");
        rows.sort();

        assert_eq!(
            rows,
            vec![
                ("i18nextLng".into(), "en".into()),
                ("meter-settings".into(), "a".into())
            ]
        );
    }

    /// A no-op upsert must not quietly drop the row it declined to update.
    #[test]
    fn an_unchanged_write_keeps_the_stored_value() {
        let conn = migrated();
        set(&conn, "synthesis-form", "kept").expect("set");
        set(&conn, "synthesis-form", "kept").expect("set again");

        let all = get_all(&conn).expect("get_all");
        assert_eq!(all.get("synthesis-form").map(String::as_str), Some("kept"));
    }
}
