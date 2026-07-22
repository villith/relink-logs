//! TEMPORARY diagnostic (not for commit): dump per-hit (damage, cap) ratios for
//! a given skill id from recent logs, to explain why the meter classifies some
//! hits as under-cap while the in-game overcap display says everything caps.
//!
//! Run: cargo run -p gbfr-logs --example cap_check -- [--db path] [--last N] [--skill ID]

use std::collections::HashMap;
use std::path::PathBuf;

use anyhow::{Context, Result};
use gbfr_logs::parser::v1::Encounter;
use protocol::{ActionType, Message};
use rusqlite::Connection;

const BUCKET: f64 = 0.002;

// Mirrors parser::v1::cap_detection::learn_cap_peaks (module is private).
fn learn_cap_peaks<K: PartialEq>(hits: impl Iterator<Item = (K, i32, i32)>) -> Vec<f64> {
    struct Bucket<K> {
        count: u64,
        first_skill: K,
        multi_skill: bool,
    }
    let mut buckets: HashMap<i64, Bucket<K>> = HashMap::new();
    for (skill, damage, cap) in hits {
        if cap <= 0 || damage <= 0 {
            continue;
        }
        let ratio = damage as f64 / cap as f64;
        buckets
            .entry((ratio / BUCKET).round() as i64)
            .and_modify(|b| {
                b.count += 1;
                if b.first_skill != skill {
                    b.multi_skill = true;
                }
            })
            .or_insert(Bucket {
                count: 1,
                first_skill: skill,
                multi_skill: false,
            });
    }
    buckets
        .into_iter()
        .filter(|(idx, b)| b.count >= 3 && (*idx >= 500 || b.multi_skill))
        .map(|(b, _)| b as f64 * BUCKET)
        .collect()
}

// Mirrors parser::v1::cap_detection::is_capped.
fn is_capped(damage: i32, cap: i32, mults: &[f64]) -> bool {
    if cap <= 0 || damage <= 0 {
        return false;
    }
    if mults.is_empty() {
        return damage >= cap;
    }
    let tol = (0.003 * damage as f64).max(2.0);
    mults
        .iter()
        .any(|&m| (cap as f64 * m - damage as f64).abs() <= tol)
}

fn main() -> Result<()> {
    let mut db_path = PathBuf::from("src-tauri/logs.db");
    let mut last = 3i64;
    let mut skill_id: u32 = 130;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => db_path = args.next().context("--db needs a path")?.into(),
            "--last" => last = args.next().context("--last needs a count")?.parse()?,
            "--skill" => skill_id = args.next().context("--skill needs an id")?.parse()?,
            other => anyhow::bail!("unknown arg: {other}"),
        }
    }

    let conn = Connection::open(db_path)?;
    let mut stmt =
        conn.prepare("SELECT id, data FROM logs WHERE version = 1 ORDER BY id DESC LIMIT ?")?;
    let rows = stmt.query_map([last], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
    })?;

    for row in rows {
        let (id, blob) = row?;
        let encounter = match Encounter::from_blob(&blob) {
            Ok(e) => e,
            Err(err) => {
                println!("=== log {id}: failed to decode: {err}");
                continue;
            }
        };

        // Same inputs as the parser's learner: all damage events with cap info,
        // supplementary excluded.
        let events: Vec<_> = encounter
            .event_log()
            .filter_map(|(_, msg)| match msg {
                Message::DamageEvent(e) => Some(e.clone()),
                _ => None,
            })
            .collect();
        let mults = learn_cap_peaks(events.iter().filter_map(|e| {
            if matches!(e.action_id, ActionType::SupplementaryDamage(_)) {
                return None;
            }
            e.damage_cap.map(|cap| (e.action_id, e.damage, cap))
        }));
        let mut sorted_mults = mults.clone();
        sorted_mults.sort_by(|a, b| a.partial_cmp(b).unwrap());
        println!(
            "\n=== log {id} (quest {:?}), {} damage events",
            encounter.quest_id,
            events.len()
        );
        println!("learned multipliers: {sorted_mults:?}");

        // Per-hit breakdown for the requested skill, grouped by source player.
        let mut per_player: HashMap<u32, Vec<&protocol::DamageEvent>> = HashMap::new();
        for e in &events {
            if e.action_id == ActionType::Normal(skill_id) {
                per_player.entry(e.source.parent_index).or_default().push(e);
            }
        }

        for (player, hits) in &per_player {
            let mut capped = 0usize;
            let mut no_cap_info = 0usize;
            let mut under_cap: Vec<&&protocol::DamageEvent> = Vec::new();
            let mut off_peak: Vec<&&protocol::DamageEvent> = Vec::new();
            let mut caps_seen: HashMap<i32, usize> = HashMap::new();

            for e in hits {
                let Some(cap) = e.damage_cap.filter(|c| *c > 0) else {
                    no_cap_info += 1;
                    continue;
                };
                *caps_seen.entry(cap).or_default() += 1;
                if is_capped(e.damage, cap, &mults) {
                    capped += 1;
                } else if e.damage < cap {
                    under_cap.push(e);
                } else {
                    off_peak.push(e);
                }
            }

            println!(
                "\n  skill {skill_id} player_idx={player}: {} hits | capped={} under_cap={} over_cap_off_peak={} no_cap_info={}",
                hits.len(), capped, under_cap.len(), off_peak.len(), no_cap_info
            );
            let mut caps: Vec<_> = caps_seen.into_iter().collect();
            caps.sort();
            println!("  distinct caps seen (cap -> hits): {caps:?}");
            for e in under_cap.iter().take(15) {
                let cap = e.damage_cap.unwrap();
                println!(
                    "    UNDER  dmg={:>9} cap={:>9} ratio={:.4} flags={:#010x}",
                    e.damage,
                    cap,
                    e.damage as f64 / cap as f64,
                    e.flags
                );
            }
            for e in off_peak.iter().take(15) {
                let cap = e.damage_cap.unwrap();
                println!(
                    "    OFFPK  dmg={:>9} cap={:>9} ratio={:.4} flags={:#010x}",
                    e.damage,
                    cap,
                    e.damage as f64 / cap as f64,
                    e.flags
                );
            }
        }

        // Full ratio histogram (all actions, supp/DoT excluded): shows the true
        // peak structure, including sub-1.0 peaks and sub-threshold repeats.
        let mut buckets: HashMap<i64, usize> = HashMap::new();
        for e in &events {
            if matches!(
                e.action_id,
                ActionType::SupplementaryDamage(_) | ActionType::DamageOverTime(_)
            ) {
                continue;
            }
            let Some(cap) = e.damage_cap.filter(|c| *c > 0) else {
                continue;
            };
            let ratio = e.damage as f64 / cap as f64;
            *buckets.entry((ratio / BUCKET).round() as i64).or_default() += 1;
        }
        let mut hist: Vec<_> = buckets.iter().filter(|(_, c)| **c >= 3).collect();
        hist.sort_by_key(|(b, _)| **b);
        println!(
            "\n  ratio buckets with >=3 hits (ratio: count, * = would be learned at 1% threshold):"
        );
        let total_at_or_over: usize = buckets
            .iter()
            .filter(|(b, _)| **b >= 500)
            .map(|(_, c)| *c)
            .sum();
        let one_pct = (total_at_or_over / 100).max(3);
        for (b, c) in &hist {
            let ratio = **b as f64 * BUCKET;
            let learned = ratio >= 0.999 && **c >= one_pct;
            let doubled = (ratio * 2.0 / BUCKET).round() as i64;
            let half_of = if ratio < 1.0 {
                let near: usize = (doubled - 2..=doubled + 2)
                    .filter_map(|k| buckets.get(&k))
                    .sum();
                if near >= 3 {
                    format!("  (x2={:.3} also a peak, {} hits)", ratio * 2.0, near)
                } else {
                    String::new()
                }
            } else {
                String::new()
            };
            println!(
                "    {:>7.3}: {:>4}{}{}",
                ratio,
                c,
                if learned { " *" } else { "" },
                half_of
            );
        }

        // Composition of sub-1.0 buckets with >=3 hits: which skill hit which
        // target, so we can tell fixed-damage uncapped hits from capped hits
        // that went through a post-cap reduction.
        let mut sub_comp: HashMap<(i64, String, u32), usize> = HashMap::new();
        for e in &events {
            if matches!(
                e.action_id,
                ActionType::SupplementaryDamage(_) | ActionType::DamageOverTime(_)
            ) {
                continue;
            }
            let Some(cap) = e.damage_cap.filter(|c| *c > 0) else {
                continue;
            };
            let ratio = e.damage as f64 / cap as f64;
            let b = (ratio / BUCKET).round() as i64;
            if ratio < 1.0 && buckets.get(&b).copied().unwrap_or(0) >= 3 {
                *sub_comp
                    .entry((b, format!("{:?}", e.action_id), e.target.actor_type))
                    .or_default() += 1;
            }
        }
        let mut sub: Vec<_> = sub_comp.into_iter().collect();
        sub.sort();
        println!("\n  sub-1.0 bucket composition (ratio, action, target_type -> hits):");
        for ((b, action, target), count) in sub {
            println!(
                "    {:>7.3} {action:<20} target={target:#010x} -> {count}",
                b as f64 * BUCKET
            );
        }

        // Global per-action summary so we can see if this is skill-specific.
        #[derive(Default)]
        struct ActionAgg {
            hits: usize,
            capped: usize,
            under: usize,
            off_peak: usize,
        }
        let mut per_action: HashMap<String, ActionAgg> = HashMap::new();
        for e in &events {
            if matches!(
                e.action_id,
                ActionType::SupplementaryDamage(_) | ActionType::DamageOverTime(_)
            ) {
                continue;
            }
            let Some(cap) = e.damage_cap.filter(|c| *c > 0) else {
                continue;
            };
            let agg = per_action.entry(format!("{:?}", e.action_id)).or_default();
            agg.hits += 1;
            if is_capped(e.damage, cap, &mults) {
                agg.capped += 1;
            } else if e.damage < cap {
                agg.under += 1;
            } else {
                agg.off_peak += 1;
            }
        }
        let mut actions: Vec<_> = per_action
            .into_iter()
            .filter(|(_, a)| a.hits >= 10)
            .collect();
        actions.sort_by_key(|(_, a)| std::cmp::Reverse(a.hits));
        println!("\n  per-action (>=10 cappable hits): action hits capped under off-peak");
        for (name, a) in actions.iter().take(25) {
            println!(
                "    {name:<28} {:>5} {:>6} {:>5} {:>8}   ({}% capped)",
                a.hits,
                a.capped,
                a.under,
                a.off_peak,
                a.capped * 100 / a.hits
            );
        }
    }

    Ok(())
}
