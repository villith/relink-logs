//! Blind-sweep fixture dump: every LOCAL predictable hit (Normal/LinkAttack/
//! SBA, cap fields present) plus its player's captured store and loadout, as
//! JSONL for `predictedCap.blind.test.ts` — which re-predicts each cap through
//! the frontend's own arithmetic and compares against the logged value.
//!
//! Run: cargo run --release -p gbfr-logs --example cap_predict_dump -- --last 500 > blind.jsonl

use std::collections::BTreeSet;
use std::path::PathBuf;

use anyhow::{Context, Result};
use protocol::{ActionType, Message};
use rusqlite::{Connection, OpenFlags};

fn main() -> Result<()> {
    let mut db = PathBuf::from("src-tauri/logs.db");
    let mut last = 500i64;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => db = PathBuf::from(args.next().context("--db needs a path")?),
            "--last" => last = args.next().context("--last needs N")?.parse()?,
            other => anyhow::bail!("unknown argument {other}"),
        }
    }

    let conn = Connection::open_with_flags(
        db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let log_ids: Vec<i64> = conn
        .prepare("SELECT id FROM logs ORDER BY id DESC LIMIT ?1")?
        .query_map([last], |row| row.get(0))?
        .collect::<std::result::Result<Vec<i64>, _>>()?;

    for id in log_ids {
        let Ok((blob, version)) = conn.query_row(
            "SELECT data, version FROM logs WHERE id = ?1",
            [id],
            |row| Ok((row.get::<_, Vec<u8>>(0)?, row.get::<_, u8>(1)?)),
        ) else {
            continue;
        };
        let Ok(parsed) = gbfr_logs::parser::deserialize_version(&blob, version) else {
            continue;
        };

        let cap_up = gbfr_logs::parser::v1::cap_up_by_source(&parsed.encounter.player_data);
        let mut dumped: BTreeSet<u32> = BTreeSet::new();
        for slot in parsed.encounter.player_data.iter() {
            let value = serde_json::to_value(slot).unwrap_or(serde_json::Value::Null);
            let Some(actor) = value["actorIndex"].as_u64().map(|a| a as u32) else {
                continue;
            };
            let Some(capture) = cap_up.get(&actor) else {
                continue;
            };
            println!(
                "{}",
                serde_json::json!({
                    "t": "player", "log": id, "actor": actor,
                    "capUp": capture, "loadout": value,
                })
            );
            dumped.insert(actor);
        }
        if dumped.is_empty() {
            continue;
        }

        for (_ts, event) in parsed.encounter.raw_event_log.iter() {
            let Message::DamageEvent(hit) = event else {
                continue;
            };
            if !matches!(
                hit.action_id,
                ActionType::Normal(_) | ActionType::LinkAttack | ActionType::SBA
            ) {
                continue;
            }
            let (Some(cap), Some(rate), Some(flags)) =
                (hit.damage_cap, hit.attack_rate, hit.class_flags)
            else {
                continue;
            };
            if cap <= 0 || !dumped.contains(&hit.source.parent_index) {
                continue;
            }
            println!(
                "{}",
                serde_json::json!({
                    "t": "hit", "log": id, "actor": hit.source.parent_index,
                    "action": hit.action_id, "rate": rate, "classFlags": flags, "cap": cap,
                    "sourceCurrentHp": hit.source_current_hp, "sourceMaxHp": hit.source_max_hp,
                    "sourceStatuses": hit.source_statuses,
                })
            );
        }
    }
    Ok(())
}
