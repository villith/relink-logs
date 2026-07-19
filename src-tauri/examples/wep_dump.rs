//! TEMPORARY diagnostic (not for commit): dump per-player weapon state
//! (weapon id, awakening, innate traits + levels) from stored logs.
//!
//! Run: cargo run -p gbfr-logs --example wep_dump [-- --db <path>] [--last <n>]

use std::path::PathBuf;

use anyhow::{Context, Result};
use gbfr_logs::parser::v1::Encounter;
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
        let encounter = match Encounter::from_blob(&blob) {
            Ok(e) => e,
            Err(e) => {
                eprintln!("warn: skipping log {id}: {e}");
                continue;
            }
        };

        println!("== log {id} @ {time} ==");
        for player in encounter.player_data.iter().flatten() {
            let value = serde_json::to_value(player)?;
            println!(
                "  {} ({}):",
                value["displayName"].as_str().unwrap_or("?"),
                value["characterType"].as_str().unwrap_or("?"),
            );
            let ws = &value["weaponState"];
            if ws.is_null() {
                println!("    weaponState: null (weaponInfo: {})", value["weaponInfo"]);
                continue;
            }
            println!(
                "    weapon {:08x} star {} plus {} awakening {} exp {}",
                ws["weaponId"].as_u64().unwrap_or(0),
                ws["starLevel"],
                ws["plusMarks"],
                ws["awakeningLevel"],
                ws["exp"],
            );
            if let Some(traits) = ws["innateTraits"].as_array() {
                for t in traits {
                    println!(
                        "    innate {:08x} lvl {}",
                        t["id"].as_u64().unwrap_or(0),
                        t["level"],
                    );
                }
            }
        }
    }

    Ok(())
}
