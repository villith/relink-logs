//! TEMPORARY diagnostic (not for commit): analyze stored logs for the four
//! online-multiplayer bug reports (stun/SPS, overcap, SBA tracking, and
//! same-character collapse).
//!
//! Run: cargo run -p gbfr-logs --example online_diag -- --since <id>

use std::collections::HashMap;
use std::path::PathBuf;

use anyhow::{Context, Result};
use gbfr_logs::parser::v1::Parser;
use protocol::Message;
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

    for row in rows {
        let (id, time, blob) = row?;
        let parser = match Parser::from_encounter_blob(&blob) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("warn: log {id}: {e}");
                continue;
            }
        };

        println!("=== log {id} ({time})");

        // Player data slots
        for (i, slot) in parser.encounter.player_data.iter().enumerate() {
            match slot {
                Some(p) => {
                    let v = serde_json::to_value(p).unwrap();
                    println!(
                        "  slot{}: actor_index={} name={:?} char={:?} online={}",
                        i,
                        v.get("actorIndex").unwrap_or(&serde_json::json!(null)),
                        v.get("displayName")
                            .and_then(|s| s.as_str())
                            .unwrap_or("<?>"),
                        v.get("characterType")
                            .map(|c| c.to_string())
                            .unwrap_or_default(),
                        v.get("isOnline")
                            .and_then(|b| b.as_bool())
                            .unwrap_or(false),
                    );
                }
                None => println!("  slot{i}: <none>"),
            }
        }

        // Per-source-parent damage event stats
        #[derive(Default)]
        struct Agg {
            events: u64,
            damage: u64,
            stun_events: u64,
            stun_sum: f64,
            cap_events: u64,
            base_events: u64,
            char_types: HashMap<u32, u64>,
        }
        let mut per_source: HashMap<u32, Agg> = HashMap::new();
        let mut sba_events: HashMap<u32, [u64; 4]> = HashMap::new(); // update/attempt/perform/continue

        for (_, event) in parser.encounter.event_log() {
            match event {
                Message::DamageEvent(e) => {
                    let agg = per_source.entry(e.source.parent_index).or_default();
                    agg.events += 1;
                    agg.damage += e.damage.max(0) as u64;
                    if let Some(s) = e.stun_value {
                        if s > 0.0 {
                            agg.stun_events += 1;
                            agg.stun_sum += s as f64;
                        }
                    }
                    if e.damage_cap.is_some() {
                        agg.cap_events += 1;
                    }
                    if e.base_damage.is_some() {
                        agg.base_events += 1;
                    }
                    *agg.char_types.entry(e.source.parent_actor_type).or_default() += 1;
                }
                Message::OnUpdateSBA(e) => sba_events.entry(e.actor_index).or_default()[0] += 1,
                Message::OnAttemptSBA(e) => sba_events.entry(e.actor_index).or_default()[1] += 1,
                Message::OnPerformSBA(e) => sba_events.entry(e.actor_index).or_default()[2] += 1,
                Message::OnContinueSBAChain(e) => {
                    sba_events.entry(e.actor_index).or_default()[3] += 1
                }
                _ => {}
            }
        }

        let mut sources: Vec<_> = per_source.iter().collect();
        sources.sort_by_key(|(_, a)| std::cmp::Reverse(a.damage));
        for (idx, agg) in sources {
            let chars: Vec<String> = agg
                .char_types
                .iter()
                .map(|(c, n)| format!("{c:#010x}x{n}"))
                .collect();
            println!(
                "  src parent_idx={idx}: events={} dmg={} stun_ev={} stun_sum={:.1} cap_ev={} base_ev={} chars=[{}]",
                agg.events, agg.damage, agg.stun_events, agg.stun_sum, agg.cap_events, agg.base_events,
                chars.join(",")
            );
        }
        for (idx, counts) in &sba_events {
            println!(
                "  sba actor_idx={idx}: update={} attempt={} perform={} continue={}",
                counts[0], counts[1], counts[2], counts[3]
            );
        }
    }

    Ok(())
}
