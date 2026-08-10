//! Solver evidence dump: the per-hit and per-player facts the attack-group
//! solver joins against the cap oracle's capture.
//!
//! ## Why this exists
//!
//! A `CAPORACLE` line itemizes the conditional-channel terms of one hit but
//! not WHO dealt it — the join to a stored log's `DamageEvent`s (by time
//! offset, action id and cap) is what names the character and their loadout.
//! This example emits that log side as JSON: every capped `Normal` hit with
//! its timestamp/action/cap/rate join key and its per-hit attacker state, plus
//! each party slot's stored `PlayerData` in the same camelCase shape the
//! frontend consumes, so `scripts/solve-attack-groups.mjs` reads both ends
//! with one schema.
//!
//! Run: cargo run -p gbfr-logs --example cap_evidence -- [--db path] --log N [--log M ...]

use std::path::PathBuf;

use anyhow::{Context, Result};
use protocol::{ActionType, Message};
use rusqlite::{Connection, OpenFlags};
use serde_json::json;

fn main() -> Result<()> {
    let mut db = PathBuf::from("src-tauri/logs.db");
    let mut log_ids: Vec<i64> = Vec::new();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => db = PathBuf::from(args.next().context("--db needs a path")?),
            "--log" => log_ids.push(args.next().context("--log needs an id")?.parse()?),
            other => anyhow::bail!("unknown argument {other}"),
        }
    }
    anyhow::ensure!(!log_ids.is_empty(), "at least one --log id is required");

    let conn = Connection::open_with_flags(
        &db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;

    let mut logs = Vec::new();
    for id in &log_ids {
        let (blob, version): (Vec<u8>, u8) = conn.query_row(
            "SELECT data, version FROM logs WHERE id = ?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let parsed = gbfr_logs::parser::deserialize_version(&blob, version)
            .map_err(|e| anyhow::anyhow!("log {id}: {e}"))?;

        // The stored loadouts, slot order preserved: the solver maps a hit's
        // parent actor index to a slot through each entry's own `actorIndex`.
        let players: Vec<serde_json::Value> = parsed
            .encounter
            .player_data
            .iter()
            .map(|slot| serde_json::to_value(slot).unwrap_or(serde_json::Value::Null))
            .collect();

        let mut hits = Vec::new();
        for (timestamp, event) in parsed.encounter.raw_event_log.iter() {
            let Message::DamageEvent(hit) = event else {
                continue;
            };
            // Normal payloads only: link/SBA carry no action id to join on, and
            // an echo or DoT payload names its CAUSE, which must not be matched
            // against the oracle's per-build action id.
            let ActionType::Normal(action) = hit.action_id else {
                continue;
            };
            let (Some(cap), Some(rate), Some(flags)) =
                (hit.damage_cap, hit.attack_rate, hit.class_flags)
            else {
                continue;
            };
            if cap <= 0 || !rate.is_finite() {
                continue;
            }
            hits.push(json!({
                "t": timestamp,
                "actor": hit.source.parent_index,
                "action": action,
                "cap": cap,
                "rate": rate,
                "classFlags": flags,
                // A summon-curve hit (its cap is not the attacker's own
                // conditional channel); kept for the time join, excluded from
                // attribution by the solver.
                "summon": hit.flags & 0x80 != 0,
                "hp": hit.source_current_hp,
                "maxHp": hit.source_max_hp,
                "statuses": hit.source_statuses.as_ref().map(|statuses| {
                    statuses
                        .iter()
                        .map(|s| json!({"statusId": s.status_id, "stacks": s.stacks}))
                        .collect::<Vec<_>>()
                }),
            }));
        }
        logs.push(json!({"id": id, "players": players, "hits": hits}));
    }

    println!("{}", serde_json::to_string(&json!({ "logs": logs }))?);
    Ok(())
}
