//! TEMPORARY diagnostic (not for commit): compare cap-detection behaviour between
//! two encounters that differ only in a player's equipped damage cap.
//!
//! Purpose: the user ran the SAME quest twice — once with damage-cap gear removed
//! (low cap) and once with it equipped (normal cap) — and observed that the meter's
//! Cap% was LOWER in the high-cap run, which they believe is backwards / inaccurate.
//! This dumps, per encounter and per player: the distinct caps seen (proving the
//! gear swap), the learned cap peaks, the capped/under/off-peak split (== reported
//! Cap%), and how many genuinely at-or-over-cap hits are NOT counted as capped
//! because their damage/cap ratio bucket failed the MIN_PEAK_HITS=3 learner
//! threshold. That last number is the suspected source of the asymmetry.
//!
//! Run: cargo run -p gbfr-logs --example cap_compare -- [--db path] --ids 360,361

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;

use anyhow::{Context, Result};
use gbfr_logs::parser::constants::CharacterType;
use gbfr_logs::parser::v1::Encounter;
use protocol::{ActionType, Message};
use rusqlite::Connection;

const BUCKET: f64 = 0.002;
const MIN_PEAK_HITS: u64 = 3;
const AT_CAP_BUCKET: i64 = 500; // ratio 1.0

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
        .filter(|(idx, b)| b.count >= MIN_PEAK_HITS && (*idx >= AT_CAP_BUCKET || b.multi_skill))
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
    mults.iter().any(|&m| (cap as f64 * m - damage as f64).abs() <= tol)
}

fn main() -> Result<()> {
    let mut db_path = PathBuf::from("src-tauri/logs.db");
    let mut ids: Vec<i64> = vec![360, 361];

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => db_path = args.next().context("--db needs a path")?.into(),
            "--ids" => {
                ids = args
                    .next()
                    .context("--ids needs a comma list")?
                    .split(',')
                    .map(|s| s.trim().parse::<i64>())
                    .collect::<std::result::Result<_, _>>()?
            }
            other => anyhow::bail!("unknown arg: {other}"),
        }
    }

    let conn = Connection::open_with_flags(
        &db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .with_context(|| format!("opening {}", db_path.display()))?;

    for id in ids {
        let blob: Vec<u8> = conn.query_row("SELECT data FROM logs WHERE id = ?", [id], |r| r.get(0))?;
        let mut encounter = match Encounter::from_blob(&blob) {
            Ok(e) => e,
            Err(err) => {
                println!("=== log {id}: decode failed: {err}");
                continue;
            }
        };
        encounter.repopulate_event_log();

        // player_data is empty in v2.0.2 logs, so identify players by their source
        // character hash (parent_actor_type -> CharacterType; Pl2700 = Eustace).

        let events: Vec<_> = encounter
            .event_log()
            .filter_map(|(_, msg)| match msg {
                Message::DamageEvent(e) => Some(e.clone()),
                _ => None,
            })
            .collect();

        // Learner input == parser's: non-supplementary, has cap. Keyed by action_id.
        let mults = learn_cap_peaks(events.iter().filter_map(|e| {
            if matches!(e.action_id, ActionType::SupplementaryDamage(_)) {
                return None;
            }
            e.damage_cap.map(|cap| (e.action_id, e.damage, cap))
        }));
        let mut sorted = mults.clone();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());

        println!("\n============================================================");
        println!(
            "=== log {id} (quest {:?}) — {} damage events",
            encounter.quest_id,
            events.len()
        );
        println!("learned cap peaks ({}): {:?}", sorted.len(),
            sorted.iter().map(|m| (m * 1000.0).round() / 1000.0).collect::<Vec<_>>());

        // Per source-player aggregates over cappable (non-supp, has-cap) hits.
        #[derive(Default)]
        struct Agg {
            hits: u64,
            capped: u64,
            under: u64,      // damage < cap, classified not-capped
            off_peak: u64,   // damage >= cap but ratio matches no learned peak
            // of the not-capped hits, how many are genuinely at-or-over the cap
            // (ratio >= 0.999) — i.e. physically capped but the learner missed the peak
            missed_at_cap: u64,
            caps: BTreeMap<i32, u64>,
            // ratio buckets at-or-over cap that DIDN'T become peaks, and their counts
            unlearned_at_cap_buckets: BTreeMap<i64, u64>,
        }
        // Key by (character hash, parent_index) so two players on the same character
        // don't merge, but the label is the readable CharacterType.
        let mut per_player: BTreeMap<(u32, u32), Agg> = BTreeMap::new();

        for e in &events {
            if matches!(e.action_id, ActionType::SupplementaryDamage(_)) {
                continue;
            }
            let Some(cap) = e.damage_cap.filter(|c| *c > 0) else { continue };
            let a = per_player
                .entry((e.source.parent_actor_type, e.source.parent_index))
                .or_default();
            a.hits += 1;
            *a.caps.entry(cap).or_default() += 1;
            let ratio = e.damage as f64 / cap as f64;
            if is_capped(e.damage, cap, &mults) {
                a.capped += 1;
            } else if e.damage < cap {
                a.under += 1;
            } else {
                a.off_peak += 1;
                if ratio >= 0.999 {
                    a.missed_at_cap += 1;
                    *a.unlearned_at_cap_buckets
                        .entry((ratio / BUCKET).round() as i64)
                        .or_default() += 1;
                }
            }
        }

        // Per-skill Cap% for Eustace (Pl2700 = 0x91418145), both the crit-aware rule
        // (history) and the naive damage>=cap rule (live overlay), to see which number
        // the user read and whether any skill inverts between the two logs.
        {
            #[derive(Default)]
            struct Sk {
                hits: u64,
                capped_aware: u64,
                capped_naive: u64,
                total_dmg: i64,
            }
            let mut per_skill: BTreeMap<u32, Sk> = BTreeMap::new();
            for e in &events {
                if e.source.parent_actor_type != 0x91418145 {
                    continue;
                }
                if matches!(e.action_id, ActionType::SupplementaryDamage(_)) {
                    continue;
                }
                let sid = match e.action_id {
                    ActionType::Normal(sid) => sid,
                    ActionType::LinkAttack => u32::MAX,
                    ActionType::SBA => u32::MAX - 1,
                    ActionType::DamageOverTime(x) => x,
                    ActionType::SupplementaryDamage(_) => continue,
                };
                let Some(cap) = e.damage_cap.filter(|c| *c > 0) else { continue };
                let s = per_skill.entry(sid).or_default();
                s.hits += 1;
                s.total_dmg += e.damage as i64;
                if is_capped(e.damage, cap, &mults) {
                    s.capped_aware += 1;
                }
                if e.damage >= cap {
                    s.capped_naive += 1;
                }
            }
            let mut skills: Vec<_> = per_skill.into_iter().filter(|(_, s)| s.hits >= 3).collect();
            skills.sort_by_key(|(_, s)| std::cmp::Reverse(s.total_dmg));
            println!("\n  -- Eustace per-skill (>=3 hits), sorted by total damage (MAX=LA, MAX-1=SBA) --");
            println!("     skill      hits  aware%  naive%   avg_dmg");
            for (sid, s) in skills.iter().take(25) {
                println!(
                    "     {:>9}  {:>4}  {:>5.1}  {:>5.1}   {:>10}",
                    sid,
                    s.hits,
                    s.capped_aware as f64 / s.hits as f64 * 100.0,
                    s.capped_naive as f64 / s.hits as f64 * 100.0,
                    s.total_dmg / s.hits as i64,
                );
            }
        }

        for ((ctype_hash, idx), a) in &per_player {
            if a.hits == 0 {
                continue;
            }
            let ch = CharacterType::from_hash(*ctype_hash);
            let cap_pct = a.capped as f64 / a.hits as f64 * 100.0;
            println!(
                "\n  {ch} (idx={idx}): {} cappable hits | Cap%={:.1}  (capped={} under={} off_peak={})",
                a.hits, cap_pct, a.capped, a.under, a.off_peak
            );
            let mut caps: Vec<_> = a.caps.iter().collect();
            caps.sort();
            println!(
                "    distinct caps (cap -> hits): {:?}",
                caps.iter().map(|(c, n)| (**c, **n)).collect::<Vec<_>>()
            );
            println!(
                "    at-or-over-cap hits missed by learner (physically capped, counted UNCAPPED): {}",
                a.missed_at_cap
            );
            if false && !a.unlearned_at_cap_buckets.is_empty() {
                let mut b: Vec<_> = a.unlearned_at_cap_buckets.iter().collect();
                b.sort();
                println!("      unlearned >=cap ratio buckets (ratio -> hits, <{MIN_PEAK_HITS} => never learnable):");
                for (idx, n) in b.iter().take(20) {
                    println!("        {:.3} -> {}", **idx as f64 * BUCKET, n);
                }
            }
        }
    }

    Ok(())
}
