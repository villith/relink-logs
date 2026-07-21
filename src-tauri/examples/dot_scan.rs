//! TEMPORARY diagnostic (not for commit): scan logs.db for DamageOverTime events to
//! test whether DoT damage is being recorded at all.
//!
//! Reports, per encounter: quest, party, hits of the DoT-applying skills we care about
//! (Eugen's Venom Grenade = Pl0500 skill 5 -> Poison, Zeta's Thousand Flames =
//! Pl1600 skill 1610 -> Burn), and any DamageOverTime events found.
//!
//! Run: cargo run -p gbfr-logs --example dot_scan -- --db "<path to logs.db>"

use std::collections::BTreeMap;
use std::path::PathBuf;

use anyhow::{Context, Result};
use gbfr_logs::parser::constants::CharacterType;
use gbfr_logs::parser::v1::Encounter;
use protocol::{ActionType, Message};
use rusqlite::Connection;

/// Bosses immune to DoT — encounters on these quests prove nothing.
const IMMUNE_QUESTS: [i64; 2] = [0x40a313, 0x40b313];

fn main() -> Result<()> {
    let mut db_path = PathBuf::from("src-tauri/logs.db");
    let mut all = false;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => db_path = args.next().context("--db needs a path")?.into(),
            // print every encounter, not just candidate (Eugen/Zeta, non-immune) ones
            "--all" => all = true,
            other => anyhow::bail!("unknown arg: {other}"),
        }
    }

    let conn =
        Connection::open(&db_path).with_context(|| format!("opening {}", db_path.display()))?;
    let mut stmt = conn.prepare(
        "SELECT id, datetime(time/1000,'unixepoch','localtime'), quest_id, \
                p1_type, p2_type, p3_type, p4_type, data \
         FROM logs ORDER BY id",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<i64>>(2)?,
            [
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
            ],
            row.get::<_, Vec<u8>>(7)?,
        ))
    })?;

    let mut total_logs = 0u64;
    let mut logs_with_dot = 0u64;
    let mut total_dot_events = 0u64;
    let mut candidates = 0u64;
    let mut candidates_with_dot = 0u64;
    let mut last_dot: Option<(i64, String)> = None;

    for row in rows {
        let (id, time, quest_id, party, blob) = row?;
        total_logs += 1;

        let mut encounter = match Encounter::from_blob(&blob) {
            Ok(e) => e,
            Err(e) => {
                eprintln!("warn: skipping log {id}: blob decode failed: {e}");
                continue;
            }
        };
        encounter.repopulate_event_log();

        let mut dot_by_source: BTreeMap<String, (u64, i64)> = BTreeMap::new();
        let mut venom_hits = 0u64;
        let mut flames_hits = 0u64;
        let mut chars_seen: BTreeMap<String, u64> = BTreeMap::new();

        for (_, event) in encounter.event_log() {
            let Message::DamageEvent(e) = event else {
                continue;
            };
            let src = CharacterType::from_hash(e.source.parent_actor_type);
            let src_name = format!("{src}");
            *chars_seen.entry(src_name.clone()).or_default() += 1;

            match e.action_id {
                ActionType::DamageOverTime(_) => {
                    let entry = dot_by_source.entry(src_name).or_default();
                    entry.0 += 1;
                    entry.1 += e.damage as i64;
                }
                ActionType::Normal(5) if src == CharacterType::Pl0500 => venom_hits += 1,
                ActionType::Normal(1610) if src == CharacterType::Pl1600 => flames_hits += 1,
                _ => {}
            }
        }

        let dot_events: u64 = dot_by_source.values().map(|(n, _)| n).sum();
        total_dot_events += dot_events;
        if dot_events > 0 {
            logs_with_dot += 1;
            last_dot = Some((id, time.clone()));
        }

        let party_has =
            |c: &str| party.iter().flatten().any(|p| p == c) || chars_seen.contains_key(c);
        let has_eugen = party_has("Pl0500");
        let has_zeta = party_has("Pl1600");
        let immune = quest_id.map_or(false, |q| IMMUNE_QUESTS.contains(&q));
        let is_candidate =
            !immune && (has_eugen || has_zeta) && (venom_hits > 0 || flames_hits > 0);
        if is_candidate {
            candidates += 1;
            if dot_events > 0 {
                candidates_with_dot += 1;
            }
        }

        if !all && !is_candidate {
            continue;
        }

        println!(
            "log {id:>5} {time} quest={} {}",
            quest_id.map_or("?".to_string(), |q| format!("{q:#x}")),
            if immune { "[DoT-IMMUNE BOSS]" } else { "" }
        );
        println!(
            "  party={:?} venom_grenade_hits={venom_hits} thousand_flames_hits={flames_hits}",
            party.iter().flatten().collect::<Vec<_>>()
        );
        if dot_by_source.is_empty() {
            println!("  DoT events: NONE");
        } else {
            for (src, (hits, dmg)) in &dot_by_source {
                println!("  DoT events: {src} hits={hits} damage={dmg}");
            }
        }
    }

    println!("\n=== summary ({})", db_path.display());
    println!("  logs scanned:                 {total_logs}");
    println!("  logs with >=1 DoT event:      {logs_with_dot}");
    println!("  total DoT events:             {total_dot_events}");
    println!("  candidate logs (Eugen/Zeta used a DoT skill, non-immune boss): {candidates}");
    println!("    of those, with DoT events:  {candidates_with_dot}");
    match last_dot {
        Some((id, time)) => println!("  most recent log with DoT:     {id} @ {time}"),
        None => println!("  most recent log with DoT:     (none in this database)"),
    }

    Ok(())
}
