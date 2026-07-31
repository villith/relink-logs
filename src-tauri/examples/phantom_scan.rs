//! Diagnostic: aggregate census of every damage TARGET across the whole log
//! database — hits, damage, the HP pool the hook read for it, which source
//! characters hit it, and which actions. Built to find "phantom" targets:
//! actors that can receive damage but are not the enemy (e.g. 1-HP marker
//! objects), which currently inflate a player's logged damage.
//!
//!   cargo run -p gbfr-logs --example phantom_scan [-- --db <path>]

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use anyhow::{Context, Result};
use gbfr_logs::parser::v1::Encounter;
use protocol::{ActionType, Message};
use rusqlite::Connection;

#[derive(Default)]
struct Agg {
    logs: BTreeSet<i64>,
    hits: u64,
    damage: i64,
    max_hps: BTreeSet<u64>,
    hp_missing: u64,
    sources: BTreeSet<u32>,
    actions: BTreeSet<String>,
}

fn main() -> Result<()> {
    let mut db_path = PathBuf::from("src-tauri/logs.db");
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => db_path = args.next().context("--db needs a path")?.into(),
            other => anyhow::bail!("unknown arg: {other}"),
        }
    }

    let conn =
        Connection::open(&db_path).with_context(|| format!("opening {}", db_path.display()))?;
    let mut stmt = conn.prepare("SELECT id, data FROM logs ORDER BY id")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
    })?;

    let mut agg: BTreeMap<u32, Agg> = BTreeMap::new();
    // Per-log totals so a phantom's share of the log can be reported.
    let mut log_totals: BTreeMap<i64, i64> = BTreeMap::new();
    let mut phantom_share: BTreeMap<u32, BTreeMap<i64, i64>> = BTreeMap::new();

    for row in rows {
        let (id, blob) = row?;
        let mut encounter = match Encounter::from_blob(&blob) {
            Ok(e) => e,
            Err(e) => {
                eprintln!("warn: skipping log {id}: {e}");
                continue;
            }
        };
        encounter.repopulate_event_log();

        for (_, event) in encounter.event_log() {
            let Message::DamageEvent(dmg) = event else {
                continue;
            };
            *log_totals.entry(id).or_default() += dmg.damage as i64;
            let a = agg.entry(dmg.target.parent_actor_type).or_default();
            a.logs.insert(id);
            a.hits += 1;
            a.damage += dmg.damage as i64;
            match dmg.target_max_hp {
                Some(max) => {
                    if a.max_hps.len() < 12 {
                        a.max_hps.insert(max);
                    }
                }
                None => a.hp_missing += 1,
            }
            a.sources.insert(dmg.source.parent_actor_type);
            if a.actions.len() < 12 {
                a.actions.insert(match dmg.action_id {
                    ActionType::Normal(id) => format!("n{id}"),
                    ActionType::LinkAttack => "link".into(),
                    ActionType::SBA => "sba".into(),
                    ActionType::SupplementaryDamage(id) => format!("supp{id}"),
                    ActionType::DamageOverTime(id) => format!("dot{id}"),
                    ActionType::PerfectGuard => "pg".into(),
                    ActionType::PerfectGuardQuickening => "pgq".into(),
                    ActionType::StunEffect(id) => format!("stun{id}"),
                });
            }
            *phantom_share
                .entry(dmg.target.parent_actor_type)
                .or_default()
                .entry(id)
                .or_default() += dmg.damage as i64;
        }
    }

    // REPARSE=1: re-derive every log through the real parser — a regression
    // check that the target rule neither panics nor swallows a real enemy.
    // Reports each log's raw event sum against what the app would now show.
    if std::env::var("REPARSE").is_ok() {
        let mut stmt = conn.prepare("SELECT id, data FROM logs ORDER BY id")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
        })?;
        let (mut ok, mut failed, mut removed, mut raw_total) = (0u32, 0u32, 0i64, 0i64);
        let mut biggest: Vec<(f64, i64, i64, i64)> = Vec::new();
        for row in rows {
            let (id, blob) = row?;
            match gbfr_logs::parser::v1::Parser::from_encounter_blob(&blob) {
                Ok(parser) => {
                    ok += 1;
                    let derived: serde_json::Value =
                        serde_json::to_value(&parser.derived_state).unwrap_or_default();
                    let after = derived["totalDamage"].as_i64().unwrap_or(0);
                    let before = log_totals.get(&id).copied().unwrap_or(0);
                    raw_total += before;
                    removed += before - after;
                    if before > 0 && after < before {
                        let pct = ((before - after) as f64 / before as f64) * 100.0;
                        biggest.push((pct, id, before, after));
                    }
                }
                Err(e) => {
                    failed += 1;
                    eprintln!("reparse FAILED log {id}: {e}");
                }
            }
        }
        biggest.sort_by(|a, b| b.0.total_cmp(&a.0));
        println!("=== reparse: {ok} ok, {failed} failed");
        println!("raw event sum {raw_total}, removed {removed} across all logs");
        println!("largest per-log reductions (includes the Primal Burst filter):");
        for (pct, id, before, after) in biggest.iter().take(12) {
            println!("  log {id}: {before} -> {after} (-{pct:.1}%)");
        }
        println!();
    }

    // FOCUS=<hex hash>: per-log breakdown for one target, worst share first.
    if let Ok(focus) = std::env::var("FOCUS") {
        let hash = u32::from_str_radix(focus.trim_start_matches("0x"), 16)?;
        println!("=== per-log breakdown for {hash:#010x}");
        let mut per_log: Vec<_> = phantom_share
            .get(&hash)
            .map(|m| m.iter().collect())
            .unwrap_or_default();
        per_log.sort_by_key(|(log, dmg)| {
            let total = log_totals.get(log).copied().unwrap_or(1).max(1);
            -((**dmg as f64 / total as f64) * 1e6) as i64
        });
        for (log, dmg) in per_log.iter().take(15) {
            let total = log_totals.get(log).copied().unwrap_or(0);
            let share = if total > 0 {
                (**dmg as f64 / total as f64) * 100.0
            } else {
                0.0
            };
            println!("  log {log}: dmg={dmg} of {total} ({share:.1}%)");
        }
        println!();
    }

    println!("distinct target hashes: {}", agg.len());
    let mut ordered: Vec<_> = agg.iter().collect();
    ordered.sort_by_key(|(_, a)| -a.damage);
    for (hash, a) in ordered {
        // Worst per-log share this target ever contributed.
        let worst = phantom_share
            .get(hash)
            .map(|per_log| {
                per_log
                    .iter()
                    .map(|(log, dmg)| {
                        let total = log_totals.get(log).copied().unwrap_or(0);
                        if total > 0 {
                            (*dmg as f64 / total as f64) * 100.0
                        } else {
                            0.0
                        }
                    })
                    .fold(0.0f64, f64::max)
            })
            .unwrap_or(0.0);
        println!(
            "{hash:#010x} logs={} hits={} dmg={} worst_log_share={worst:.1}% max_hp={:?} hp_missing={} srcs={:?} actions={:?}",
            a.logs.len(),
            a.hits,
            a.damage,
            a.max_hps,
            a.hp_missing,
            a.sources
                .iter()
                .map(|s| format!("{s:#010x}"))
                .collect::<Vec<_>>(),
            a.actions
        );
    }

    Ok(())
}
