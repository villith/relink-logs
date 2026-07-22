//! Diagnostic: dump every Normal(<target id>) damage event with its damage, rate,
//! flags — and the previous few actions by the SAME source actor, to identify
//! what shared system ids (800, 0, 9995...) actually are.
//!
//!   cargo run -p gbfr-logs --example action_context -- <action_id> [--db <path>]

use std::path::PathBuf;

use anyhow::{Context, Result};
use gbfr_logs::parser::constants::CharacterType;
use gbfr_logs::parser::v1::Encounter;
use protocol::{ActionType, Message};
use rusqlite::Connection;

fn main() -> Result<()> {
    let mut db_path = PathBuf::from("src-tauri/logs.db");
    let mut target_id: Option<u32> = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => db_path = args.next().context("--db needs a path")?.into(),
            other => target_id = Some(other.parse().context("action id must be a number")?),
        }
    }
    let target_id = target_id.context("usage: action_context <action_id>")?;

    let conn = Connection::open(&db_path)?;
    let mut stmt = conn.prepare("SELECT id, data FROM logs")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
    })?;

    for row in rows {
        let (log_id, blob) = row?;
        let mut encounter = match Encounter::from_blob(&blob) {
            Ok(e) => e,
            Err(_) => continue,
        };
        encounter.repopulate_event_log();
        let events: Vec<(i64, Message)> = encounter.event_log().cloned().collect();
        for (i, (ts, event)) in events.iter().enumerate() {
            let Message::DamageEvent(dmg) = event else {
                continue;
            };
            if dmg.action_id != ActionType::Normal(target_id) {
                continue;
            }
            let who = CharacterType::from_hash(dmg.source.actor_type);
            println!(
                "log {log_id} t={ts} {who} dmg={} rate={:?} flags={:#x} stun={:?} cap={:?}",
                dmg.damage, dmg.attack_rate, dmg.flags, dmg.stun_value, dmg.damage_cap
            );
            // Previous 4 damage events by the same source (any action).
            let mut shown = 0;
            for (pts, pe) in events[..i].iter().rev() {
                if let Message::DamageEvent(p) = pe {
                    if p.source.index == dmg.source.index
                        && p.source.actor_type == dmg.source.actor_type
                    {
                        println!(
                            "    prev dt={}ms action={:?} dmg={}",
                            ts - pts,
                            p.action_id,
                            p.damage
                        );
                        shown += 1;
                        if shown == 4 {
                            break;
                        }
                    }
                }
            }
        }
    }
    Ok(())
}
