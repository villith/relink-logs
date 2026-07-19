//! TEMPORARY diagnostic (not for commit): dump per-player skillboard node ids
//! from stored logs, to match them against skillboard_effect.tbl keys.
//!
//! Run: cargo run -p gbfr-logs --example sb_dump [-- --db <path>] [--last <n>]

use std::path::PathBuf;

use anyhow::{Context, Result};
use gbfr_logs::parser::v1::Encounter;
use protocol::Message;
use rusqlite::Connection;

fn main() -> Result<()> {
    let mut db_path = PathBuf::from("src-tauri/logs.db");
    let mut last = 3i64;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => db_path = args.next().context("--db needs a path")?.into(),
            "--last" => last = args.next().context("--last needs a count")?.parse()?,
            other => anyhow::bail!("unknown arg: {other}"),
        }
    }

    let conn =
        Connection::open(&db_path).with_context(|| format!("opening {}", db_path.display()))?;
    let mut stmt = conn.prepare(
        "SELECT id, datetime(time/1000,'unixepoch','localtime'), data \
         FROM logs ORDER BY id DESC LIMIT ?",
    )?;
    let rows = stmt.query_map([last], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Vec<u8>>(2)?,
        ))
    })?;

    for row in rows {
        let (id, time, blob) = row?;
        let mut encounter = match Encounter::from_blob(&blob) {
            Ok(e) => e,
            Err(e) => {
                eprintln!("warn: skipping log {id}: {e}");
                continue;
            }
        };
        encounter.repopulate_event_log();

        println!("== log {id} @ {time} ==");
        for player in encounter.player_data.iter().flatten() {
            let value = serde_json::to_value(player)?;
            let ids: Vec<u64> = value["skillboard"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_u64()).collect())
                .unwrap_or_default();
            let hex: Vec<String> = ids.iter().map(|v| format!("{v:08x}")).collect();
            println!(
                "  {} ({}): {} nodes: {}",
                value["characterType"].as_str().unwrap_or("?"),
                value["characterName"].as_str().unwrap_or("?"),
                ids.len(),
                hex.join(" ")
            );
        }
    }
    Ok(())
}
