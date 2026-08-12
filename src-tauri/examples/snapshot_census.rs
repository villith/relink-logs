//! Census of the per-hit attacker snapshot (`source_current_hp` /
//! `source_max_hp` / `source_statuses`) over stored logs — the offline half of
//! the live-gate checklist for the cap-factor capture.
//!
//! Per log it reports, for every party actor: how many hits carry the
//! snapshot, HP sanity (current in (0, max], max stable), how many snapshot
//! statuses were never seen applied to that actor in the status stream, and
//! how often a status's stack count RISES between consecutive hits (the claim
//! fake memory could not support). Hits that must NOT carry a snapshot —
//! summon-path hits (class flag 0x80) and non-party sources — are counted as
//! violations when they do.
//!
//! Run: cargo run -p gbfr-logs --example snapshot_census -- [--db path] [--last N]

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use anyhow::{Context, Result};
use protocol::Message;
use rusqlite::{Connection, OpenFlags};

#[derive(Default)]
struct ActorStats {
    hits: usize,
    hp_present: usize,
    statuses_present: usize,
    hp_zero: usize,
    hp_over_max: usize,
    max_values: BTreeSet<u64>,
    distinct_statuses: BTreeSet<u32>,
    unapplied_statuses: BTreeSet<u32>,
    stack_rises: usize,
    max_stacks: BTreeMap<u32, u32>,
    uncaptured_source_types: BTreeSet<u32>,
    status_presence: BTreeMap<u32, usize>,
}

fn main() -> Result<()> {
    let mut db = PathBuf::from("src-tauri/logs.db");
    let mut last = 15usize;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => db = PathBuf::from(args.next().context("--db needs a path")?),
            "--last" => last = args.next().context("--last needs N")?.parse()?,
            other => anyhow::bail!("unknown argument {other}"),
        }
    }

    let conn = Connection::open_with_flags(
        &db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| format!("open {}", db.display()))?;
    let mut stmt = conn.prepare(
        "SELECT id, time, length(data), data, version FROM logs ORDER BY id DESC LIMIT ?1",
    )?;
    let rows = stmt.query_map([last], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, Vec<u8>>(3)?,
            row.get::<_, u8>(4)?,
        ))
    })?;

    for row in rows {
        let (id, time, blob_len, blob, version) = row?;
        let Ok(parsed) = gbfr_logs::parser::deserialize_version(&blob, version) else {
            println!("log {id}: undecodable (version {version})");
            continue;
        };

        let party: BTreeSet<u32> = parsed.derived_state.party.keys().copied().collect();
        let mut actors: BTreeMap<u32, ActorStats> = BTreeMap::new();
        // (actor, status) pairs the status stream vouches for, and the last
        // snapshot stacks per (actor, status) for the rise check.
        let mut applied: BTreeSet<(u32, u32)> = BTreeSet::new();
        let mut last_stacks: BTreeMap<(u32, u32), u32> = BTreeMap::new();
        let mut forbidden_with_snapshot = 0usize;
        let mut summon_hits = 0usize;

        for (_, event) in parsed.encounter.raw_event_log.iter() {
            match event {
                Message::StatusApply(apply) => {
                    applied.insert((apply.actor_index, apply.status_id));
                }
                Message::DamageEvent(hit) => {
                    let is_party = party.contains(&hit.source.parent_index);
                    let is_summon = hit.class_flags.is_some_and(|f| f & 0x80 != 0);
                    if !is_party || is_summon {
                        if is_summon {
                            summon_hits += 1;
                        }
                        if hit.source_current_hp.is_some() || hit.source_statuses.is_some() {
                            forbidden_with_snapshot += 1;
                        }
                        continue;
                    }
                    let actor = actors.entry(hit.source.parent_index).or_default();
                    actor.hits += 1;
                    if hit.source_current_hp.is_none() && hit.source_statuses.is_none() {
                        actor.uncaptured_source_types.insert(hit.source.actor_type);
                    }
                    if let (Some(current), Some(max)) = (hit.source_current_hp, hit.source_max_hp) {
                        actor.hp_present += 1;
                        if current == 0 {
                            actor.hp_zero += 1;
                        }
                        if current > max {
                            actor.hp_over_max += 1;
                        }
                        actor.max_values.insert(max);
                    }
                    if let Some(statuses) = &hit.source_statuses {
                        actor.statuses_present += 1;
                        for status in statuses {
                            actor.distinct_statuses.insert(status.status_id);
                            *actor.status_presence.entry(status.status_id).or_default() += 1;
                            if !applied.contains(&(hit.source.parent_index, status.status_id)) {
                                actor.unapplied_statuses.insert(status.status_id);
                            }
                            let key = (hit.source.parent_index, status.status_id);
                            if let Some(prev) = last_stacks.get(&key) {
                                if status.stacks > *prev {
                                    actor.stack_rises += 1;
                                }
                            }
                            last_stacks.insert(key, status.stacks);
                            let peak = actor.max_stacks.entry(status.status_id).or_default();
                            *peak = (*peak).max(status.stacks);
                        }
                    }
                }
                _ => {}
            }
        }

        if actors.values().all(|a| a.hits == 0) {
            continue;
        }
        println!(
            "log {id} (time {time}, {:.1} MB, v{version}): summon hits {summon_hits}, forbidden-with-snapshot {forbidden_with_snapshot}",
            blob_len as f64 / 1e6
        );
        // The stored per-player Mastery capture, via the serialized form the
        // frontend reads (the parser's fields are private to its own module).
        for slot in parsed.encounter.player_data.iter().flatten() {
            let player = serde_json::to_value(slot).unwrap_or_default();
            let cap = |key: &str| {
                player
                    .get(key)
                    .and_then(|v| v.as_f64())
                    .map_or("-".into(), |v| format!("{v}"))
            };
            println!(
                "  loadout {}: lbcap n:{} s:{} b:{}",
                player
                    .get("actorIndex")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0),
                cap("limitBonusCapNormal"),
                cap("limitBonusCapSkill"),
                cap("limitBonusCapSba"),
            );
        }
        for (index, actor) in &actors {
            let stacked: Vec<String> = actor
                .max_stacks
                .iter()
                .filter(|(_, peak)| **peak > 1)
                .map(|(id, peak)| format!("{id}x{peak}"))
                .collect();
            let character = parsed
                .derived_state
                .party
                .get(index)
                .map(|p| format!("{:?}", p.character_type))
                .unwrap_or_else(|| "?".into());
            println!(
                "  actor {index:#x} {character}: {} hits, hp {}/{} statuses {}/{} | hp0 {} over-max {} max-values {:?} | {} distinct statuses, {} unapplied {:?}, {} stack rises{}",
                actor.hits,
                actor.hp_present,
                actor.hits,
                actor.statuses_present,
                actor.hits,
                actor.hp_zero,
                actor.hp_over_max,
                actor.max_values,
                actor.distinct_statuses.len(),
                actor.unapplied_statuses.len(),
                actor.unapplied_statuses,
                actor.stack_rises,
                if stacked.is_empty() {
                    String::new()
                } else {
                    format!(" | stacked: {}", stacked.join(" "))
                }
            );
            if actor.statuses_present > 0 {
                // A status held on only PART of the hits is a mid-fight
                // transition the snapshot observed — the per-hit claim.
                let transient: Vec<String> = actor
                    .status_presence
                    .iter()
                    .filter(|(_, n)| **n < actor.statuses_present)
                    .map(|(id, n)| format!("{id}:{n}/{}", actor.statuses_present))
                    .collect();
                if !transient.is_empty() {
                    println!("      transient statuses: {}", transient.join(" "));
                }
            }
            if !actor.uncaptured_source_types.is_empty() {
                let types: Vec<String> = actor
                    .uncaptured_source_types
                    .iter()
                    .map(|t| format!("{t:#010x}"))
                    .collect();
                println!("      uncaptured source types: {}", types.join(" "));
            }
        }
    }
    Ok(())
}
