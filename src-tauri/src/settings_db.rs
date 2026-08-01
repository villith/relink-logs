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

use anyhow::Result;
use rusqlite::Connection;
use rusqlite_migration::{Migrations, M};

/// Every migration, in order. **Append only — never edit an existing entry**,
/// or a database that already ran it diverges from one that has not.
///
/// Split out of [`setup`] the same way `db::migrations()` is, so tests apply
/// the real list to an in-memory database instead of the user's file.
pub fn migrations() -> Migrations<'static> {
    Migrations::new(vec![M::up(
        r#"CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY NOT NULL,
            value TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        )"#,
    )])
}

/// Open `settings.db`, in WAL mode with a busy timeout: both windows write
/// through their own connection, so a concurrent write must wait rather than
/// return `SQLITE_BUSY`.
pub fn open() -> Result<Connection> {
    let conn = Connection::open(crate::data_paths::data_dir().join("settings.db"))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    Ok(conn)
}

/// Create the database and bring it to the latest migration.
pub fn setup() -> Result<()> {
    let mut conn = open()?;
    migrations().to_latest(&mut conn)?;
    Ok(())
}

/// Every stored setting. One round trip, because the frontend wants the whole
/// set at startup and there are only a handful of rows.
pub fn get_all(conn: &Connection) -> Result<HashMap<String, String>> {
    let mut stmt = conn.prepare("SELECT key, value FROM settings")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;

    let mut out = HashMap::new();
    for row in rows {
        let (key, value) = row?;
        out.insert(key, value);
    }
    Ok(out)
}

/// Upsert one key. Last write wins, which is what the cross-window event then
/// reconciles.
pub fn set(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        rusqlite::params![key, value, chrono::Utc::now().timestamp()],
    )?;
    Ok(())
}

/// Remove one key. Required by zustand's `StateStorage` contract.
pub fn delete(conn: &Connection, key: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM settings WHERE key = ?1",
        rusqlite::params![key],
    )?;
    Ok(())
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
}
