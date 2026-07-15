//! TEMPORARY diagnostic (not for commit): dump per-encounter player identity state
//! from logs.db to investigate wrong/unstable player names.
//!
//! For each encounter: the stored player_data slots (actor_index, name, char type,
//! online flag) vs the actor parent_index values that actually dealt damage in the
//! event log. A name shown in the meter is player_data whose actor_index matches a
//! damage source's parent_index — mismatches/stale entries show up directly here.
//!
//! Run: cargo run -p gbfr-logs --bin identity_dump [-- --db <path>] [--since <id>]

use std::collections::BTreeMap;
use std::path::PathBuf;

use anyhow::{Context, Result};
use gbfr_logs::parser::v1::Encounter;
use protocol::Message;
use rusqlite::Connection;
use serde_json::Value;

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

    let conn =
        Connection::open(&db_path).with_context(|| format!("opening {}", db_path.display()))?;
    let mut stmt = conn.prepare(
        "SELECT id, datetime(time/1000,'unixepoch','localtime'), quest_id, data \
         FROM logs WHERE id >= ? ORDER BY id",
    )?;
    let rows = stmt.query_map([since_id], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<i64>>(2)?,
            row.get::<_, Vec<u8>>(3)?,
        ))
    })?;

    for row in rows {
        let (id, time, quest_id, blob) = row?;
        let mut encounter = match Encounter::from_blob(&blob) {
            Ok(e) => e,
            Err(e) => {
                eprintln!("warn: skipping log {id}: blob decode failed: {e}");
                continue;
            }
        };
        encounter.repopulate_event_log();

        println!("=== log {id} {time} quest={quest_id:?}");

        // player_data slots as stored at save time (Serialize -> JSON to reach
        // the private fields).
        for (slot, pd) in encounter.player_data.iter().enumerate() {
            match pd {
                Some(pd) => {
                    let v: Value = serde_json::to_value(pd)?;
                    println!(
                        "  slot{} actor_index={} name={:?} char={:?} online={} char_name={:?}",
                        slot + 1,
                        v["actorIndex"],
                        v["displayName"].as_str().unwrap_or(""),
                        v["characterType"],
                        v["isOnline"],
                        v["characterName"].as_str().unwrap_or(""),
                    );
                }
                None => println!("  slot{} <empty>", slot + 1),
            }
        }

        // Damage sources actually seen this encounter: parent_index -> (parent_type,
        // hits, total damage, distinct raw source indices/types feeding it).
        #[derive(Default)]
        struct Src {
            parent_type: u32,
            hits: u64,
            damage: u64,
            raw_indices: BTreeMap<u32, u32>, // source.index -> source.actor_type
        }
        let mut sources: BTreeMap<u32, Src> = BTreeMap::new();
        for (_, event) in encounter.event_log() {
            if let Message::DamageEvent(d) = event {
                let e = sources.entry(d.source.parent_index).or_default();
                e.parent_type = d.source.parent_actor_type;
                e.hits += 1;
                e.damage += d.damage.max(0) as u64;
                e.raw_indices.insert(d.source.index, d.source.actor_type);
            }
        }
        for (idx, s) in &sources {
            let raws: Vec<String> = s
                .raw_indices
                .iter()
                .map(|(i, t)| format!("{i}:{t:#010x}"))
                .collect();
            println!(
                "  dmg parent_index={idx} parent_type={:#010x} hits={} dmg={} raw=[{}]",
                s.parent_type,
                s.hits,
                s.damage,
                raws.join(", ")
            );
        }

        // Reparse through the CURRENT derive code and show the resulting party rows
        // (verifies e.g. the Pl2000 dragon-form merge against real encounters).
        let mut parser = gbfr_logs::parser::v1::Parser::from_encounter_blob(&blob)?;
        parser.reparse();
        let party: Value = serde_json::to_value(&parser.derived_state)?;
        if let Some(rows) = party.get("party").and_then(Value::as_object) {
            for (idx, row) in rows {
                println!(
                    "  reparse row idx={idx} char={} dmg={}",
                    row["characterType"], row["totalDamage"]
                );
            }
        }
    }

    Ok(())
}
