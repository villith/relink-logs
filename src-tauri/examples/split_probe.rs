//! TEMPORARY diagnostic: for one log, print the timeline of damage events keyed
//! by their source parent_index, so a player that got split between the synthetic
//! party-slot key and a raw actor index can be told apart from a flaky read.
//!
//! Run: cargo run -p gbfr-logs --example split_probe -- --log <id>

use std::collections::BTreeMap;
use std::path::PathBuf;

use anyhow::{Context, Result};
use gbfr_logs::parser::v1::Encounter;
use protocol::Message;
use rusqlite::Connection;

fn main() -> Result<()> {
    let mut db_path = PathBuf::from("src-tauri/logs.db");
    let mut log_id = 0i64;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => db_path = args.next().context("--db needs a path")?.into(),
            "--log" => log_id = args.next().context("--log needs an id")?.parse()?,
            other => anyhow::bail!("unknown arg: {other}"),
        }
    }

    let conn = Connection::open(&db_path)?;
    let blob: Vec<u8> = conn.query_row("SELECT data FROM logs WHERE id = ?", [log_id], |r| r.get(0))?;
    let mut encounter = Encounter::from_blob(&blob)?;
    encounter.repopulate_event_log();

    let all: Vec<(i64, protocol::Message)> = encounter.event_log().cloned().collect();
    let start = all.first().map(|(t, _)| *t).unwrap_or(0);

    // Per (parent_index) first/last offsets and hit counts, plus a coarse
    // per-second occupancy map so interleaving is visible.
    let mut seen: BTreeMap<u32, (i64, i64, u64, u32)> = BTreeMap::new();
    let mut buckets: BTreeMap<u32, Vec<i64>> = BTreeMap::new();

    for (ts, msg) in &all {
        let protocol::Message::DamageEvent(event) = msg else { continue };
        let idx = event.source.parent_index;
        let secs = (ts - start) / 1000;
        let entry = seen
            .entry(idx)
            .or_insert((secs, secs, 0, event.source.parent_actor_type));
        entry.0 = entry.0.min(secs);
        entry.1 = entry.1.max(secs);
        entry.2 += 1;
        buckets.entry(idx).or_default().push(secs);
    }

    println!("=== log {log_id}: {} events over {}s", all.len(), (all.last().map(|(t,_)| *t).unwrap_or(0) - start)/1000);
    for (idx, (first, last, hits, ty)) in &seen {
        println!(
            "  parent_index={idx} ({idx:#010x}) type={ty:#010x} hits={hits} first=+{first}s last=+{last}s"
        );
    }

    // Distinct (source.index, source.actor_type) -> parent_index pairings: proves
    // whether two rows are two actors or ONE actor resolving two ways.
    println!("--- source.index -> parent_index pairings ---");
    let mut pairs: BTreeMap<(u32, u32), BTreeMap<u32, u64>> = BTreeMap::new();
    for (_, msg) in &all {
        let protocol::Message::DamageEvent(e) = msg else { continue };
        *pairs
            .entry((e.source.index, e.source.actor_type))
            .or_default()
            .entry(e.source.parent_index)
            .or_insert(0) += 1;
    }
    for ((idx, ty), parents) in &pairs {
        let ps: Vec<String> = parents
            .iter()
            .map(|(p, n)| format!("{p:#010x}x{n}"))
            .collect();
        println!("  src={idx:#010x} type={ty:#010x} -> {}", ps.join(" "));
    }

    // Interleave check: for each pair of indices sharing a parent type, print a
    // per-5s occupancy string.
    println!("--- per-5s occupancy (each char = 5s bucket, '#' = has hits) ---");
    let span = seen.values().map(|v| v.1).max().unwrap_or(0);
    for (idx, secs) in &buckets {
        let mut line = vec![b'.'; (span / 5 + 1) as usize];
        for s in secs {
            line[(s / 5) as usize] = b'#';
        }
        println!("  {idx:#010x} {}", String::from_utf8_lossy(&line));
    }

    Ok(())
}
