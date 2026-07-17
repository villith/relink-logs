//! TEMPORARY diagnostic: dump per-player identity/online info for given logs.
//! Run: cargo run -p gbfr-logs --example party_check -- --since <id>

use std::path::PathBuf;

use anyhow::{Context, Result};
use gbfr_logs::parser::v1::Parser;
use rusqlite::Connection;

fn main() -> Result<()> {
    let mut db_path = PathBuf::from("src-tauri/logs.db");
    let mut since_id = 0i64;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => db_path = args.next().context("--db needs a path")?.into(),
            "--since" => since_id = args.next().context("--since needs an id")?.parse()?,
            other => anyhow::bail!("unknown arg: {other}"),
        }
    }

    let conn = Connection::open(&db_path)?;
    let mut stmt = conn.prepare("SELECT id, data FROM logs WHERE id >= ? ORDER BY id")?;
    let rows = stmt.query_map([since_id], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
    })?;

    for row in rows {
        let (id, blob) = row?;
        let parser = match Parser::from_encounter_blob(&blob) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("warn: log {id}: {e}");
                continue;
            }
        };
        let slots: Vec<String> = parser
            .encounter
            .player_data
            .iter()
            .map(|p| match p {
                Some(p) => {
                    let mut v = serde_json::to_value(p).unwrap();
                    if let Some(obj) = v.as_object_mut() {
                        // Sigils are huge; keep only the count.
                        let n = obj
                            .get("sigils")
                            .and_then(|s| s.as_array())
                            .map(|a| a.len())
                            .unwrap_or(0);
                        obj.insert("sigils".into(), serde_json::json!(n));
                    }
                    v.to_string()
                }
                None => "<none>".into(),
            })
            .collect();
        println!("=== log {id}");
        for s in &slots {
            println!("    {s}");
        }
    }

    Ok(())
}
