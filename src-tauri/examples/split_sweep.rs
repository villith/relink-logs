//! TEMPORARY diagnostic: sweep stored logs for damage source actors whose
//! `parent_index` resolved MORE THAN ONE WAY inside a single encounter (the
//! synthetic party-slot key on some hits, the raw actor index on others). That
//! split is what strands one of the two resulting meter rows with no party slot,
//! hence no name and no build.
//!
//! Run: cargo run -p gbfr-logs --example split_sweep -- --since <id>

use std::collections::BTreeMap;
use std::path::PathBuf;

use anyhow::{Context, Result};
use gbfr_logs::parser::v1::Encounter;
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
    let mut stmt = conn.prepare(
        "SELECT id, datetime(time/1000,'unixepoch','localtime'), data \
         FROM logs WHERE id >= ? ORDER BY id",
    )?;
    let rows = stmt.query_map([since_id], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Vec<u8>>(2)?,
        ))
    })?;

    let mut scanned = 0u32;
    let mut split = 0u32;

    for row in rows {
        let (id, time, blob) = row?;
        let mut encounter = match Encounter::from_blob(&blob) {
            Ok(e) => e,
            Err(_) => continue,
        };
        encounter.repopulate_event_log();
        scanned += 1;

        let mut pairs: BTreeMap<u32, BTreeMap<u32, u64>> = BTreeMap::new();
        for (_, msg) in encounter.event_log() {
            let protocol::Message::DamageEvent(e) = msg else {
                continue;
            };
            // Player actors only: the slot key is only ever minted for players,
            // so an enemy/pet with a raw parent is normal, not a split.
            *pairs
                .entry(e.source.index)
                .or_default()
                .entry(e.source.parent_index)
                .or_insert(0) += 1;
        }

        let offenders: Vec<(u32, Vec<(u32, u64)>)> = pairs
            .into_iter()
            .filter(|(_, parents)| {
                parents.len() > 1 && parents.keys().any(|p| protocol::is_player_slot_key(*p))
            })
            .map(|(src, parents)| (src, parents.into_iter().collect()))
            .collect();

        if offenders.is_empty() {
            continue;
        }
        split += 1;
        println!("=== log {id} {time}");
        for (src, parents) in offenders {
            let ps: Vec<String> = parents
                .iter()
                .map(|(p, n)| format!("{p:#010x}x{n}"))
                .collect();
            println!("  src={src:#010x} -> {}", ps.join(" "));
        }
    }

    println!("--- {split} split / {scanned} scanned ---");
    Ok(())
}
