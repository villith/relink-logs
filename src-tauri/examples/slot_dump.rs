//! TEMPORARY diagnostic: dump the full stored PlayerData for given logs, so a
//! slot with no name can be told apart from a slot with no identity event at all.
//!
//! Run: cargo run -p gbfr-logs --example slot_dump -- --since <id>

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
        println!("=== log {id}");
        for (i, slot) in parser.encounter.player_data.iter().enumerate() {
            match slot {
                None => println!("  slot{} <none>", i + 1),
                Some(p) => {
                    let json = serde_json::to_value(p)?;
                    let obj = json.as_object().expect("PlayerData serializes to a map");
                    let mut keys: Vec<&String> = obj.keys().collect();
                    keys.sort();
                    let summary: Vec<String> = keys
                        .iter()
                        .map(|k| {
                            let v = &obj[k.as_str()];
                            let desc = match v {
                                serde_json::Value::Array(a) => format!("[{} items]", a.len()),
                                serde_json::Value::Object(o) => {
                                    if o.is_empty() {
                                        "{}".to_string()
                                    } else {
                                        format!("{{{} fields}}", o.len())
                                    }
                                }
                                serde_json::Value::Null => "null".to_string(),
                                other => other.to_string(),
                            };
                            format!("{k}={desc}")
                        })
                        .collect();
                    println!("  slot{} {}", i + 1, summary.join(" "));
                }
            }
        }
    }

    Ok(())
}
