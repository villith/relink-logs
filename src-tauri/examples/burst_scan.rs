//! Diagnostic: how summon / primal-burst damage (action 80000) relates to SBA
//! chains in saved logs, and what else shows up right after a multi-player SBA
//! chain (a Chain Burst candidate).
//!
//!   cargo run -p gbfr-logs --example burst_scan -- [--db <path>] [--window <ms>]

use std::collections::BTreeMap;
use std::path::PathBuf;

use anyhow::{Context, Result};
use gbfr_logs::parser::constants::CharacterType;
use gbfr_logs::parser::v1::Encounter;
use protocol::{ActionType, Message, SUMMON_ATTACK_ACTION_ID as SUMMON_ACTION};
use rusqlite::Connection;

#[derive(Default, Clone)]
struct Stat {
    hits: usize,
    damage: i64,
}

impl Stat {
    fn add(&mut self, damage: i32) {
        self.hits += 1;
        self.damage += damage as i64;
    }
}

fn main() -> Result<()> {
    let mut db_path = PathBuf::from("src-tauri/logs.db");
    // How long after the last SBA of a chain we consider damage "part of" it.
    let mut window_ms: i64 = 8000;
    // Max gap between two SBA usages for them to count as chained.
    let mut chain_gap_ms: i64 = 12000;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => db_path = args.next().context("--db needs a path")?.into(),
            "--window" => window_ms = args.next().context("--window needs ms")?.parse()?,
            "--chain-gap" => chain_gap_ms = args.next().context("--chain-gap needs ms")?.parse()?,
            other => anyhow::bail!("unknown arg: {other}"),
        }
    }

    let conn = Connection::open(&db_path)?;
    let mut stmt = conn.prepare("SELECT id, data FROM logs ORDER BY id")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
    })?;

    // action key -> stats, globally and in post-chain windows.
    let mut global: BTreeMap<String, Stat> = BTreeMap::new();
    let mut in_window: BTreeMap<String, Stat> = BTreeMap::new();
    // Every damage source whose own class is not a known player character.
    let mut non_player_sources: BTreeMap<String, Stat> = BTreeMap::new();
    // Distinct summon body classes seen on action 80000.
    let mut summon_bodies: BTreeMap<u32, Stat> = BTreeMap::new();
    // Chain size (distinct players) -> how many chains, and how many were
    // followed by summon damage.
    let mut chain_sizes: BTreeMap<usize, (usize, usize)> = BTreeMap::new();
    let mut summon_bursts_total = 0usize;
    let mut summon_bursts_after_chain: BTreeMap<usize, usize> = BTreeMap::new();
    let mut summon_bursts_orphan = 0usize;
    let mut logs_scanned = 0usize;
    let mut logs_with_summon = 0usize;

    for row in rows {
        let (log_id, blob) = row?;
        let mut encounter = match Encounter::from_blob(&blob) {
            Ok(e) => e,
            Err(_) => continue,
        };
        encounter.repopulate_event_log();
        logs_scanned += 1;

        let events = &encounter.raw_event_log;

        // --- SBA usages: one per (player, burst of SBA hits) ---------------
        // key = source parent (the player), value = last SBA hit timestamp.
        let mut last_sba: BTreeMap<(u32, u32), i64> = BTreeMap::new();
        let mut sba_usages: Vec<(i64, (u32, u32))> = Vec::new();

        // --- summon bursts: action 80000 hits grouped by 5s idle gaps ------
        let mut summon_bursts: Vec<(i64, i64, Stat, Vec<u32>)> = Vec::new();

        for (ts, event) in events {
            let Message::DamageEvent(dmg) = event else {
                continue;
            };
            let key = event_key(dmg.action_id, dmg.source.actor_type);
            global.entry(key).or_default().add(dmg.damage);

            // Anything whose SOURCE class is not a known Pl#### character: the
            // shape a chain-burst / system actor would take if one existed.
            if matches!(
                CharacterType::from_hash(dmg.source.actor_type),
                CharacterType::Unknown(_)
            ) {
                non_player_sources
                    .entry(format!(
                        "{:08x} parent={} action={:?}",
                        dmg.source.actor_type,
                        CharacterType::from_hash(dmg.source.parent_actor_type),
                        dmg.action_id
                    ))
                    .or_default()
                    .add(dmg.damage);
            }

            match dmg.action_id {
                ActionType::SBA => {
                    let who = (dmg.source.parent_actor_type, dmg.source.parent_index);
                    let fresh = last_sba
                        .get(&who)
                        .map(|prev| ts - prev > 4000)
                        .unwrap_or(true);
                    if fresh {
                        sba_usages.push((*ts, who));
                    }
                    last_sba.insert(who, *ts);
                }
                ActionType::Normal(SUMMON_ACTION) => {
                    summon_bodies
                        .entry(dmg.source.actor_type)
                        .or_default()
                        .add(dmg.damage);
                    match summon_bursts.last_mut() {
                        Some((_, end, stat, bodies)) if *ts - *end <= 5000 => {
                            *end = *ts;
                            stat.add(dmg.damage);
                            if !bodies.contains(&dmg.source.actor_type) {
                                bodies.push(dmg.source.actor_type);
                            }
                        }
                        _ => {
                            let mut stat = Stat::default();
                            stat.add(dmg.damage);
                            summon_bursts.push((*ts, *ts, stat, vec![dmg.source.actor_type]));
                        }
                    }
                }
                _ => {}
            }
        }

        if !summon_bursts.is_empty() {
            logs_with_summon += 1;
        }

        // --- group SBA usages into chains ---------------------------------
        let mut chains: Vec<(i64, i64, Vec<(u32, u32)>)> = Vec::new();
        for (ts, who) in &sba_usages {
            match chains.last_mut() {
                Some((_, end, members)) if *ts - *end <= chain_gap_ms => {
                    *end = *ts;
                    if !members.contains(who) {
                        members.push(*who);
                    }
                }
                _ => chains.push((*ts, *ts, vec![*who])),
            }
        }

        for (_, end, members) in &chains {
            let size = members.len();
            let followed = summon_bursts
                .iter()
                .any(|(start, _, _, _)| *start >= *end - 2000 && *start <= *end + window_ms);
            let entry = chain_sizes.entry(size).or_insert((0, 0));
            entry.0 += 1;
            if followed {
                entry.1 += 1;
            }
        }

        // One line per burst: which players SBA'd in the 45s before it. A Primal
        // Burst needs four back-to-back SBAs, so the count of distinct SBA users
        // in front of every burst is the test of "is 80000 always a Primal Burst".
        for (start, _, stat, bodies) in &summon_bursts {
            let mut users: Vec<(i64, (u32, u32))> = sba_usages
                .iter()
                .filter(|(ts, _)| *start - *ts <= 45000 && *ts <= *start)
                .map(|(ts, who)| (*start - *ts, *who))
                .collect();
            users.sort_by_key(|(dt, _)| *dt);
            let mut distinct: Vec<(u32, u32)> = Vec::new();
            for (_, who) in &users {
                if !distinct.contains(who) {
                    distinct.push(*who);
                }
            }
            let offsets: Vec<String> = users
                .iter()
                .map(|(dt, who)| {
                    format!("{}@-{:.1}s", CharacterType::from_hash(who.0), *dt as f64 / 1000.0)
                })
                .collect();
            println!(
                "burst log {log_id} hits={:<3} dmg={:<12} bodies={:<12} sba_users={} [{}]",
                stat.hits,
                stat.damage,
                bodies
                    .iter()
                    .map(|b| format!("{b:08x}"))
                    .collect::<Vec<_>>()
                    .join("+"),
                distinct.len(),
                offsets.join(", ")
            );
        }

        for (start, _, stat, bodies) in &summon_bursts {
            summon_bursts_total += 1;
            let chain = chains
                .iter()
                .filter(|(_, end, _)| *start >= *end - 2000 && *start - *end <= window_ms)
                .max_by_key(|(_, end, _)| *end);
            match chain {
                Some((_, _, members)) => {
                    *summon_bursts_after_chain.entry(members.len()).or_insert(0) += 1;
                }
                None => {
                    summon_bursts_orphan += 1;
                    if summon_bursts_orphan <= 15 {
                        let names: Vec<String> =
                            bodies.iter().map(|b| format!("{:08x}", b)).collect();
                        println!(
                            "orphan summon burst: log {log_id} t={start} hits={} dmg={} bodies=[{}]",
                            stat.hits,
                            stat.damage,
                            names.join(", ")
                        );
                    }
                }
            }
        }

        // --- what happens in the window after a 2+ player chain -----------
        for (_, end, members) in &chains {
            if members.len() < 2 {
                continue;
            }
            for (ts, event) in events {
                if *ts < *end || *ts > *end + window_ms {
                    continue;
                }
                let Message::DamageEvent(dmg) = event else {
                    continue;
                };
                in_window
                    .entry(event_key(dmg.action_id, dmg.source.actor_type))
                    .or_default()
                    .add(dmg.damage);
            }
        }
    }

    println!("\nlogs scanned: {logs_scanned}, logs with action-{SUMMON_ACTION} damage: {logs_with_summon}");
    println!("summon/primal bursts: {summon_bursts_total}, orphan (no SBA chain within {window_ms}ms): {summon_bursts_orphan}");
    println!("\nsummon bursts by preceding chain size (distinct SBA users):");
    for (size, count) in &summon_bursts_after_chain {
        println!("  chain of {size}: {count} bursts");
    }
    println!("\nSBA chains by size -> (chains, followed by summon damage):");
    for (size, (chains, followed)) in &chain_sizes {
        println!("  size {size}: {chains} chains, {followed} followed by summon damage");
    }

    println!("\nnon-player damage sources (class not a Pl#### character):");
    for (key, stat) in &non_player_sources {
        println!("  {key:<64} hits={:<6} dmg={}", stat.hits, stat.damage);
    }

    println!("\naction-{SUMMON_ACTION} source body classes:");
    for (body, stat) in &summon_bodies {
        println!(
            "  {:08x} ({}): hits={} dmg={}",
            body,
            CharacterType::from_hash(*body),
            stat.hits,
            stat.damage
        );
    }

    println!("\nenrichment in the {window_ms}ms after a 2+ player SBA chain (window hits / global hits):");
    let mut rows: Vec<(f64, &String, &Stat, Stat)> = in_window
        .iter()
        .map(|(k, s)| {
            let g = global.get(k).cloned().unwrap_or_default();
            let ratio = if g.hits == 0 {
                0.0
            } else {
                s.hits as f64 / g.hits as f64
            };
            (ratio, k, s, g)
        })
        .collect();
    rows.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap().then(b.2.hits.cmp(&a.2.hits)));
    for (ratio, key, s, g) in rows.iter().take(40) {
        println!(
            "  {ratio:>5.2}  {key:<52} window hits={:<7} dmg={:<12} global hits={}",
            s.hits, s.damage, g.hits
        );
    }

    Ok(())
}

/// One histogram row: the action, plus who dealt it (so a shared system action
/// id like 80000 is split by the actor behind it).
fn event_key(action: ActionType, source_type: u32) -> String {
    format!(
        "{action:?} by {} ({:08x})",
        CharacterType::from_hash(source_type),
        source_type
    )
}
