//! Diagnostic: for each (character, action_id) Normal-skill pair seen in logs.db,
//! print the set of distinct flag values and hit counts — looking for a flag bit
//! that separates summon-call attacks (the 99999/100xxx id cluster) from real
//! character skills.
//!
//!   cargo run -p gbfr-logs --example action_flags [-- --db <path>] [--all]
//!
//! By default only the suspicious id cluster (>= 90000) is printed; --all dumps
//! every action id.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use anyhow::{Context, Result};
use gbfr_logs::parser::constants::CharacterType;
use gbfr_logs::parser::v1::Encounter;
use protocol::{ActionType, Message};
use rusqlite::Connection;

fn main() -> Result<()> {
    let mut db_path = PathBuf::from("src-tauri/logs.db");
    let mut all = false;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => db_path = args.next().context("--db needs a path")?.into(),
            "--all" => all = true,
            other => anyhow::bail!("unknown arg: {other}"),
        }
    }

    // (child_char, action_id) -> flags value -> hit count
    let mut stats: BTreeMap<(String, u32), BTreeMap<u64, u64>> = BTreeMap::new();

    // Which logs contain the suspicious ids, and are they Conflux rooms (run_id set)?
    let mut origins: Vec<(i64, Option<i64>, u32)> = Vec::new();

    let conn = Connection::open(&db_path)?;
    let mut stmt = conn.prepare("SELECT id, data, run_id FROM logs")?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, Vec<u8>>(1)?,
            row.get::<_, Option<i64>>(2)?,
        ))
    })?;

    for row in rows {
        let (id, blob, run_id) = row?;
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
                    if !all && action_id < 90_000 {
                        continue;
                    }
                    if action_id >= 90_000 {
                        origins.push((id, run_id, action_id));
                    }
                    let child = CharacterType::from_hash(dmg.source.actor_type);
                    let key = (child.to_string(), action_id);
                    *stats.entry(key).or_default().entry(dmg.flags).or_default() += 1;
                }
            }
        }
    }

    // Per-log summary of where the high ids came from.
    {
        let mut per_log: BTreeMap<(i64, Option<i64>), BTreeSet<u32>> = BTreeMap::new();
        for (id, run_id, action_id) in &origins {
            per_log
                .entry((*id, *run_id))
                .or_default()
                .insert(*action_id);
        }
        for ((id, run_id), actions) in &per_log {
            println!("log {id} run_id={run_id:?} high-ids={actions:?}");
        }
    }

    for ((child, action_id), flag_counts) in &stats {
        println!("{child} action {action_id}:");
        for (flags, count) in flag_counts {
            println!("  flags={flags:#018x} x{count}");
        }
    }
    Ok(())
}
