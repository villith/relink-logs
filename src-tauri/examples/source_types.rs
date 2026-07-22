//! Diagnostic: dump every distinct source (actor_type, parent_actor_type) pair
//! across all Normal damage events in logs.db, with hit counts and up to a few
//! sample action ids — for cross-referencing unknown hashes against So####
//! (summon) / Wp#### (weapon) actor-id hash candidates.
//!
//!   cargo run -p gbfr-logs --example source_types [-- --db <path>]

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use anyhow::{Context, Result};
use gbfr_logs::parser::v1::Encounter;
use protocol::{ActionType, Message};
use rusqlite::Connection;

fn main() -> Result<()> {
    let mut db_path = PathBuf::from("src-tauri/logs.db");
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => db_path = args.next().context("--db needs a path")?.into(),
            other => anyhow::bail!("unknown arg: {other}"),
        }
    }

    // (actor_type, parent_actor_type) -> (hits, sample action ids)
    let mut stats: BTreeMap<(u32, u32), (u64, BTreeSet<u32>)> = BTreeMap::new();

    let conn = Connection::open(&db_path)?;
    let mut stmt = conn.prepare("SELECT id, data FROM logs")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
    })?;

    for row in rows {
        let (id, blob) = row?;
        let mut encounter = match Encounter::from_blob(&blob) {
            Ok(e) => e,
            Err(e) => {
                eprintln!("warn: skipping log {id}: {e}");
                continue;
            }
        };
        encounter.repopulate_event_log();
        for (_, event) in encounter.event_log() {
            if let Message::DamageEvent(dmg) = event {
                if let ActionType::Normal(action_id) = dmg.action_id {
                    let entry = stats
                        .entry((dmg.source.actor_type, dmg.source.parent_actor_type))
                        .or_default();
                    entry.0 += 1;
                    if entry.1.len() < 12 {
                        entry.1.insert(action_id);
                    }
                }
            }
        }
    }

    for ((actor, parent), (hits, actions)) in &stats {
        println!("src={actor:#010x} parent={parent:#010x} hits={hits} actions={actions:?}");
    }
    Ok(())
}
