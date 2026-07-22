//! TEMPORARY diagnostic (not for commit): dump every Perfect Guard / stun
//! message in a stored log with its RELATIVE timestamp, so we can tell whether a
//! player's N perfect-guard rows are N genuinely-separate guards (spread across
//! the fight) or ONE guard whose stun got split into N counter events (a tight
//! cluster within ~150ms).
//!
//! Run: cargo run -p gbfr-logs --example pg_inspect -- [--db <path>] [--log <id>]
//! Default log = the most recent (max id).

use std::collections::BTreeMap;
use std::path::PathBuf;

use anyhow::{Context, Result};
use gbfr_logs::parser::v1::Parser;
use protocol::Message;
use rusqlite::Connection;

fn main() -> Result<()> {
    let mut db_path = PathBuf::from("src-tauri/logs.db");
    let mut only_log: Option<i64> = None;
    let mut all = false;
    let mut trace: Option<(i64, i64)> = None;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => db_path = args.next().context("--db needs a path")?.into(),
            "--log" => only_log = Some(args.next().context("--log needs an id")?.parse()?),
            "--all" => all = true,
            "--trace" => {
                let from = args.next().context("--trace needs from_ms")?.parse()?;
                let to = args.next().context("--trace needs to_ms")?.parse()?;
                trace = Some((from, to));
            }
            other => anyhow::bail!("unknown arg: {other}"),
        }
    }

    let conn = Connection::open(&db_path)?;

    if all {
        // Across EVERY log: per characterType, the distribution of PerfectGuardStun
        // amounts. A genuine ramp-riding guard counter varies (0 vs immune, higher
        // with ramp); a fixed-value source is one repeated number.
        let mut stmt = conn.prepare("SELECT id, data FROM logs ORDER BY id")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?)))?;
        let mut by_char: BTreeMap<String, BTreeMap<String, u32>> = BTreeMap::new();
        for row in rows {
            let (id, blob) = row?;
            let Ok(parser) = Parser::from_encounter_blob(&blob) else {
                continue;
            };
            let mut slot_char: BTreeMap<u32, String> = BTreeMap::new();
            for slot in parser.encounter.player_data.iter().flatten() {
                let v = serde_json::to_value(slot)?;
                slot_char.insert(
                    v["actorIndex"].as_u64().unwrap_or(0) as u32,
                    v["characterType"].to_string(),
                );
            }
            for (_, e) in parser.encounter.event_log() {
                if let Message::OnPerfectGuardStun(pg) = e {
                    let ch = slot_char
                        .get(&pg.actor_index)
                        .cloned()
                        .unwrap_or_else(|| format!("{:#010x}", pg.actor_index));
                    *by_char
                        .entry(ch)
                        .or_default()
                        .entry(format!("{:.2}", pg.stun_amount))
                        .or_default() += 1;
                }
            }
            let _ = id;
        }
        println!("=== PerfectGuardStun amount distribution per character (all logs) ===");
        for (ch, dist) in &by_char {
            let parts: Vec<String> = dist.iter().map(|(amt, n)| format!("{amt}x{n}")).collect();
            println!("  {ch:<10} {}", parts.join("  "));
        }
        return Ok(());
    }

    let log_id: i64 = match only_log {
        Some(id) => id,
        None => conn.query_row("SELECT MAX(id) FROM logs", [], |r| r.get(0))?,
    };
    let (time, blob): (String, Vec<u8>) = conn.query_row(
        "SELECT datetime(time/1000,'unixepoch','localtime'), data FROM logs WHERE id = ?",
        [log_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;

    let parser = Parser::from_encounter_blob(&blob)?;
    let start = parser.start_time();
    println!("=== log {log_id} ({time}) ===");

    // Slot key -> label, so amounts can be read as "Eugen" not "0xf0000000".
    let mut label: BTreeMap<u32, String> = BTreeMap::new();
    println!("--- players ---");
    for slot in parser.encounter.player_data.iter().flatten() {
        let v = serde_json::to_value(slot)?;
        let actor = v["actorIndex"].as_u64().unwrap_or(0) as u32;
        let ch = v["characterType"].to_string();
        let name = v["displayName"].as_str().unwrap_or("").to_string();
        let l = format!("{ch} \"{name}\"");
        println!("  actor={actor:#010x} {l}");
        label.insert(actor, l);
    }

    // Per (actor, kind): count, stun sum, and the relative-ms timestamps.
    let mut agg: BTreeMap<(u32, &'static str), (u32, f64, Vec<i64>)> = BTreeMap::new();
    println!("--- guard / stun events (relative ms) ---");
    for (ts, event) in parser.encounter.event_log() {
        let rel = ts - start;
        let (kind, actor, amount) = match event {
            Message::OnPerfectGuardStun(e) => ("PerfectGuardStun", e.actor_index, e.stun_amount),
            Message::OnPerfectGuardQuickening(e) => ("PerfectGuardQuick", e.actor_index, e.stun_amount),
            Message::OnPlayerStun(e) => ("PlayerStun(net)", e.actor_index, e.stun_amount),
            _ => continue,
        };
        let who = label.get(&actor).cloned().unwrap_or_default();
        println!("  t={rel:>7}ms  {kind:<18} actor={actor:#010x} {who:<20} amount={amount:.2}");
        let entry = agg.entry((actor, kind)).or_insert((0, 0.0, Vec::new()));
        entry.0 += 1;
        entry.1 += amount as f64;
        entry.2.push(rel);
    }

    // Full merged timeline in a window: every damage event (who hit whom, with
    // what action) plus the guard/stun events — to read the combat context and
    // tell a reactive guard (enemy attack co-timed) from a sustained tick.
    if let Some((from, to)) = trace {
        println!("--- trace [{from},{to}]ms ---");
        for (ts, event) in parser.encounter.event_log() {
            let rel = ts - start;
            if rel < from || rel > to {
                continue;
            }
            match event {
                Message::DamageEvent(d) => {
                    let src = label
                        .get(&d.source.parent_index)
                        .cloned()
                        .unwrap_or_else(|| format!("{:#010x}", d.source.parent_actor_type));
                    println!(
                        "  t={rel:>7}ms  DMG   src=[{src}] tgt_type={:#010x} {:?} dmg={} stun={:?}",
                        d.target.parent_actor_type, d.action_id, d.damage, d.stun_value
                    );
                }
                Message::OnPerfectGuardStun(e) => {
                    let who = label.get(&e.actor_index).cloned().unwrap_or_default();
                    println!("  t={rel:>7}ms  PGSTUN [{who}] amount={:.2}", e.stun_amount);
                }
                Message::OnPerfectGuardQuickening(e) => {
                    let who = label.get(&e.actor_index).cloned().unwrap_or_default();
                    println!("  t={rel:>7}ms  PGQUICK [{who}]", );
                    let _ = e;
                }
                _ => {}
            }
        }
        return Ok(());
    }

    // For each PerfectGuardStun, what was the guarding actor doing right then?
    // A reactive guard is triggered by the ENEMY; a stun-applying SKILL of the
    // guarder's own would instead show that actor's damage hits co-timed with it.
    println!("--- context around each PerfectGuardStun (actor's own damage in [-400ms,+200ms]) ---");
    let pg_events: Vec<(u32, i64)> = parser
        .encounter
        .event_log()
        .filter_map(|(ts, e)| match e {
            Message::OnPerfectGuardStun(pg) => Some((pg.actor_index, ts - start)),
            _ => None,
        })
        .collect();
    for (actor, at) in &pg_events {
        let who = label.get(actor).cloned().unwrap_or_default();
        let mut near: Vec<String> = Vec::new();
        for (ts, e) in parser.encounter.event_log() {
            if let Message::DamageEvent(d) = e {
                if d.source.parent_index == *actor {
                    let off = (ts - start) - at;
                    if (-400..=200).contains(&off) {
                        near.push(format!("{off:+}ms {:?} dmg={}", d.action_id, d.damage));
                    }
                }
            }
        }
        println!("  {who} PG@{at}ms  nearby-own-hits: [{}]", near.join(", "));
    }

    println!("--- summary per (actor, kind) ---");
    for ((actor, kind), (count, sum, mut times)) in agg {
        times.sort();
        let who = label.get(&actor).cloned().unwrap_or_default();
        let span = times.last().unwrap_or(&0) - times.first().unwrap_or(&0);
        // Max gap between consecutive events: a genuine multi-guard fight has big
        // gaps; a split-into-N artifact clusters (all gaps tiny).
        let max_gap = times.windows(2).map(|w| w[1] - w[0]).max().unwrap_or(0);
        println!(
            "  {who:<20} {kind:<18} count={count:<3} sum={sum:>8.2} avg={:>7.2} span={span}ms max_gap={max_gap}ms",
            sum / count as f64,
        );
    }

    Ok(())
}
