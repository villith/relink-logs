//! Stored-log compatibility sweep. Reads every encounter blob in a `logs.db`
//! and reports which ones the current parser can no longer deserialize —
//! renaming or adding a field without `#[serde(default)]` anywhere in the tree
//! reachable from `Encounter` breaks logs already on disk, and nothing else
//! catches that against REAL logs.
//!
//! Run: cargo run -p gbfr-logs --example log_compat -- --db <path-to-logs.db>
//!
//! The DB is WAL-mode, so when copying one out of the install dir take its
//! `-wal` sidecar too — without it the newest encounters are silently missing
//! from the sweep.

use std::{collections::BTreeMap, path::PathBuf};

use anyhow::{Context, Result};
use rusqlite::{Connection, OpenFlags};

fn main() -> Result<()> {
    let mut db_path = PathBuf::from("src-tauri/logs.db");

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => db_path = args.next().context("--db needs a path")?.into(),
            other => anyhow::bail!("unknown arg: {other}"),
        }
    }

    let conn = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mut stmt = conn.prepare("SELECT id, version, data FROM logs ORDER BY id")?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, u64>(0)?,
            row.get::<_, u8>(1)?,
            row.get::<_, Vec<u8>>(2)?,
        ))
    })?;

    let mut total = 0usize;
    // Keyed by error message, so each distinct breakage is reported once with a
    // count and the first log that hit it. `deserialize_version` reports only
    // the FIRST missing field per log, so re-run this after every fix.
    let mut failures: BTreeMap<String, (usize, u64)> = BTreeMap::new();

    for row in rows {
        let (id, version, blob) = row?;
        total += 1;
        // The same call `fetch_encounter_state` makes, so a clean sweep means
        // the app can open every one of these logs.
        if let Err(e) = gbfr_logs::parser::deserialize_version(&blob, version) {
            failures
                .entry(e.to_string())
                .and_modify(|(count, _)| *count += 1)
                .or_insert((1, id));
        }
    }

    let failed: usize = failures.values().map(|(count, _)| count).sum();
    println!("logs: {total}, ok: {}, failed: {failed}", total - failed);
    for (err, (count, first_id)) in &failures {
        println!("  [{count} logs, first id {first_id}] {err}");
    }

    Ok(())
}
