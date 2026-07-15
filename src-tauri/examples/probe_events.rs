//! TEMPORARY diagnostic (not for commit): per-log event statistics from logs.db —
//! SBA events per actor, stun coverage, damage-cap coverage — to root-cause the
//! "SBA tab empty for AI" and "Stun/SPS are 0" reports.
//!
//! Run: cargo run -p gbfr-logs --bin probe_events [-- --db <path>] [--since <id>]

use std::collections::BTreeMap;
use std::path::PathBuf;

use anyhow::{Context, Result};
use gbfr_logs::parser::v1::Encounter;
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

    let conn =
        Connection::open(&db_path).with_context(|| format!("opening {}", db_path.display()))?;
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
        let mut encounter = match Encounter::from_blob(&blob) {
            Ok(e) => e,
            Err(e) => {
                eprintln!("warn: skipping log {id}: blob decode failed: {e}");
                continue;
            }
        };
        encounter.repopulate_event_log();

        println!("=== log {id} {time}");

        // SBA gauge updates per actor index.
        let mut sba: BTreeMap<u32, (u64, f32, f32)> = BTreeMap::new();
        // Damage stun/cap coverage per source parent.
        #[derive(Default)]
        struct D {
            hits: u64,
            stun_some: u64,
            stun_nonzero: u64,
            cap_some: u64,
        }
        let mut dmg: BTreeMap<u32, D> = BTreeMap::new();
        let mut other: BTreeMap<&'static str, u64> = BTreeMap::new();

        for (_, event) in encounter.event_log() {
            match event {
                Message::OnUpdateSBA(e) => {
                    let entry = sba.entry(e.actor_index).or_insert((0, f32::MAX, f32::MIN));
                    entry.0 += 1;
                    entry.1 = entry.1.min(e.sba_value);
                    entry.2 = entry.2.max(e.sba_value);
                }
                Message::DamageEvent(e) => {
                    let d = dmg.entry(e.source.parent_index).or_default();
                    d.hits += 1;
                    if let Some(s) = e.stun_value {
                        d.stun_some += 1;
                        if s > 0.0 {
                            d.stun_nonzero += 1;
                        }
                    }
                    if e.damage_cap.is_some() {
                        d.cap_some += 1;
                    }
                }
                Message::OnAttemptSBA(_) => *other.entry("attempt_sba").or_default() += 1,
                Message::OnPerformSBA(_) => *other.entry("perform_sba").or_default() += 1,
                Message::OnContinueSBAChain(_) => *other.entry("sba_chain").or_default() += 1,
                Message::OnDeathEvent(_) => *other.entry("death").or_default() += 1,
                _ => *other.entry("other").or_default() += 1,
            }
        }

        for (idx, (count, min, max)) in &sba {
            println!("  sba actor_index={idx} updates={count} min={min:.1} max={max:.1}");
        }
        if sba.is_empty() {
            println!("  sba: NO OnUpdateSBA events at all");
        }
        for (idx, d) in &dmg {
            println!(
                "  dmg parent={idx} hits={} stun_some={} stun>0={} cap_some={}",
                d.hits, d.stun_some, d.stun_nonzero, d.cap_some
            );
        }
        if !other.is_empty() {
            println!("  other events: {other:?}");
        }
    }

    Ok(())
}
