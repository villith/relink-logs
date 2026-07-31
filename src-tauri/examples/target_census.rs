//! Diagnostic: per-target census of one stored log — every distinct damage
//! target (`target.parent_actor_type`), how many hits and how much damage each
//! took, which source parents hit it, and the HP pool the hook read for it.
//!
//! Written to root-cause "an unknown enemy is being counted as a target and
//! contributing to a player's damage".
//!
//!   cargo run -p gbfr-logs --example target_census [-- --db <path>] [--log <id>]

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use anyhow::{Context, Result};
use gbfr_logs::parser::v1::Encounter;
use protocol::{ActionType, Message};
use rusqlite::Connection;

#[derive(Default)]
struct TargetStats {
    hits: u64,
    damage: i64,
    indexes: BTreeSet<u32>,
    actor_types: BTreeSet<u32>,
    sources: BTreeMap<(u32, u32), (u64, i64)>,
    actions: BTreeSet<String>,
    hp_seen: BTreeSet<(u64, u64)>,
    first_ms: Option<i64>,
    last_ms: Option<i64>,
}

fn main() -> Result<()> {
    let mut db_path = PathBuf::from("src-tauri/logs.db");
    let mut log_id: Option<i64> = None;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => db_path = args.next().context("--db needs a path")?.into(),
            "--log" => log_id = Some(args.next().context("--log needs an id")?.parse()?),
            other => anyhow::bail!("unknown arg: {other}"),
        }
    }

    let conn =
        Connection::open(&db_path).with_context(|| format!("opening {}", db_path.display()))?;

    let id: i64 = match log_id {
        Some(id) => id,
        None => conn.query_row("SELECT MAX(id) FROM logs", [], |row| row.get(0))?,
    };

    let (time, p1, blob): (String, Option<String>, Vec<u8>) = conn.query_row(
        "SELECT datetime(time/1000,'unixepoch','localtime'), p1_type, data FROM logs WHERE id = ?",
        [id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;

    let mut encounter = Encounter::from_blob(&blob)?;
    encounter.repopulate_event_log();

    println!(
        "=== log {id} {time} p1_type={p1:?} quest={:?}",
        encounter.quest_id
    );
    for slot in encounter.player_data.iter().flatten() {
        println!(
            "  party: name={:?} type={:?}",
            slot.display_name(),
            slot.character_type()
        );
    }

    // Optional chronological dump of every damage event, so a phantom hit can be
    // lined up against the real hit it accompanies.
    if std::env::var("DUMP_EVENTS").is_ok() {
        let t0 = encounter
            .event_log()
            .next()
            .map(|(ts, _)| *ts)
            .unwrap_or_default();
        for (ts, event) in encounter.event_log() {
            if let Message::DamageEvent(dmg) = event {
                println!(
                    "t+{:>6}ms tgt={:#010x} idx={:#010x} act={:?} dmg={:>10} cap={:?} base={:?} hp={:?}/{:?} flags={:#x}",
                    ts - t0,
                    dmg.target.parent_actor_type,
                    dmg.target.index,
                    dmg.action_id,
                    dmg.damage,
                    dmg.damage_cap,
                    dmg.base_damage,
                    dmg.target_current_hp,
                    dmg.target_max_hp,
                    dmg.flags
                );
            }
        }
        println!("---");
    }

    let mut targets: BTreeMap<u32, TargetStats> = BTreeMap::new();
    let mut total_damage: i64 = 0;

    for (ts, event) in encounter.event_log() {
        let Message::DamageEvent(dmg) = event else {
            continue;
        };
        let stats = targets.entry(dmg.target.parent_actor_type).or_default();
        stats.hits += 1;
        stats.damage += dmg.damage as i64;
        total_damage += dmg.damage as i64;
        stats.indexes.insert(dmg.target.index);
        stats.actor_types.insert(dmg.target.actor_type);
        let src = stats
            .sources
            .entry((dmg.source.parent_actor_type, dmg.source.actor_type))
            .or_default();
        src.0 += 1;
        src.1 += dmg.damage as i64;
        if stats.actions.len() < 16 {
            stats.actions.insert(match dmg.action_id {
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
        if let (Some(cur), Some(max)) = (dmg.target_current_hp, dmg.target_max_hp) {
            if stats.hp_seen.len() < 8 {
                stats.hp_seen.insert((cur, max));
            }
        }
        stats.first_ms.get_or_insert(*ts);
        stats.last_ms = Some(*ts);
    }

    // What the app actually shows: the derived state the parser builds from the
    // same raw events, so the phantom-target rule can be checked end to end.
    // Read through the serde payload the frontend consumes, so this asserts the
    // shipped numbers rather than internal fields (which are private).
    let parser = gbfr_logs::parser::v1::Parser::from_encounter_blob(&blob)?;
    let derived: serde_json::Value = serde_json::to_value(&parser.derived_state)?;
    println!("--- derived: totalDamage={}", derived["totalDamage"]);
    if let Some(party) = derived["party"].as_object() {
        for (index, player) in party {
            println!(
                "    player {index} {} totalDamage={}",
                player["characterType"], player["totalDamage"]
            );
        }
    }

    println!("--- targets (total damage {total_damage})");
    let mut ordered: Vec<_> = targets.iter().collect();
    ordered.sort_by_key(|(_, s)| -s.damage);
    for (parent_type, s) in ordered {
        let share = if total_damage > 0 {
            (s.damage as f64 / total_damage as f64) * 100.0
        } else {
            0.0
        };
        let span = match (s.first_ms, s.last_ms) {
            (Some(a), Some(b)) => b - a,
            _ => 0,
        };
        println!(
            "target parent={parent_type:#010x} ({parent_type}) hits={} dmg={} ({share:.1}%) span={span}ms",
            s.hits, s.damage
        );
        println!(
            "    target.index={:?} target.actor_type={:?}",
            s.indexes
                .iter()
                .map(|i| format!("{i:#010x}"))
                .collect::<Vec<_>>(),
            s.actor_types
                .iter()
                .map(|i| format!("{i:#010x}"))
                .collect::<Vec<_>>()
        );
        println!("    hp(cur,max) samples={:?}", s.hp_seen);
        println!("    actions={:?}", s.actions);
        for ((sp, sa), (hits, dmg)) in &s.sources {
            println!("    src parent={sp:#010x} actor={sa:#010x} hits={hits} dmg={dmg}");
        }
    }

    Ok(())
}
