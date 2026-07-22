//! TEMPORARY diagnostic (not for commit): determine which damage-source classes can
//! trigger supplementary damage, by attributing every SupplementaryDamage event in
//! logs.db to a preceding trigger hit (clean 0.2x / 0.4x ratio, same source).
//!
//! Ground truth: Skybound Arts cannot trigger supplementary damage. If the method is
//! sound, SBA's observed attribution stays ~0 while its "expected if eligible" count
//! (player's Normal-hit proc rate x SBA hits) is substantial.
//!
//! Run: cargo run -p gbfr-logs --example supp_eligibility [-- --db <path>] [--since <id>]

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use anyhow::{Context, Result};
use gbfr_logs::parser::v1::Encounter;
use protocol::{ActionType, Message};
use rusqlite::Connection;

const RATIO_TOL: f64 = 0.01;
const LOOKBACK: usize = 400;

fn clean_ratio(r: f64) -> bool {
    (r - 0.2).abs() < RATIO_TOL || (r - 0.4).abs() < RATIO_TOL
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
enum TriggerClass {
    NormalAidMatch,
    NormalOther,
    LinkAttack,
    Sba,
    Dot,
    Unattributed,
}

impl TriggerClass {
    fn name(self) -> &'static str {
        match self {
            TriggerClass::NormalAidMatch => "normal (aid match)",
            TriggerClass::NormalOther => "normal (other aid)",
            TriggerClass::LinkAttack => "link attack",
            TriggerClass::Sba => "sba",
            TriggerClass::Dot => "dot",
            TriggerClass::Unattributed => "unattributed",
        }
    }
}

#[derive(Default)]
struct ClassStats {
    hits: u64,
    attributed: u64,
    /// Sum over player-logs of proc_rate * hits: supp events we'd expect from this
    /// class if it procced at the same rate as the player's Normal hits.
    expected_if_eligible: f64,
}

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

    // Aggregates across all logs.
    let mut global_class: BTreeMap<&'static str, ClassStats> = BTreeMap::new();
    let mut global_attr: BTreeMap<TriggerClass, u64> = BTreeMap::new();
    // Of the supps ratio-attributed to LA/SBA/DoT, how many embed an aid that IS one
    // of the source's Normal skill ids (i.e. are really Normal-triggered supps whose
    // true trigger fell outside the window)?
    let mut nonnormal_attr_aid_in_normal: BTreeMap<TriggerClass, (u64, u64)> = BTreeMap::new();
    // Forward per-hit test: (followed-by-matching-supp, total-hits) per class, counted
    // only for player-logs with proc_rate >= 0.2 on Normal hits. "tight" additionally
    // requires the supp's aid NOT be in the source's Normal aid set — a supp that a
    // Normal skill can't explain.
    let mut fwd_loose: BTreeMap<&'static str, (u64, u64)> = BTreeMap::new();
    let mut fwd_tight: BTreeMap<&'static str, (u64, u64)> = BTreeMap::new();
    const FWD_WINDOW: usize = 30;
    // aid-membership: supp aid seen as a Normal aid from the same source in this log?
    let (mut aid_in_normal, mut aid_not_in_normal) = (0u64, 0u64);
    let mut unknown_aids: BTreeMap<u32, u64> = BTreeMap::new();
    let mut logs_with_supp = 0u64;

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
        let events: Vec<&Message> = encounter.event_log().map(|(_, e)| e).collect();

        // Per-source (index, actor_type) tallies for this log.
        type Src = (u32, u32);
        #[derive(Default)]
        struct SrcTally {
            normal_hits: u64,
            la_hits: u64,
            sba_hits: u64,
            dot_hits: u64,
            supp_events: u64,
            normal_aids: BTreeSet<u32>,
            attributed: BTreeMap<TriggerClass, u64>,
        }
        let mut tallies: BTreeMap<Src, SrcTally> = BTreeMap::new();

        for event in &events {
            let Message::DamageEvent(e) = event else {
                continue;
            };
            if e.damage <= 0 {
                continue;
            }
            let t = tallies
                .entry((e.source.index, e.source.actor_type))
                .or_default();
            match e.action_id {
                ActionType::Normal(aid) => {
                    t.normal_hits += 1;
                    t.normal_aids.insert(aid);
                }
                ActionType::LinkAttack => t.la_hits += 1,
                ActionType::SBA => t.sba_hits += 1,
                ActionType::DamageOverTime(_) => t.dot_hits += 1,
                ActionType::SupplementaryDamage(_) => t.supp_events += 1,
                ActionType::PerfectGuard
                | ActionType::PerfectGuardQuickening
                | ActionType::StunEffect(_) => {}
            }
        }

        // Attribute each supp event to the cleanest-ratio candidate in the lookback
        // window. A Normal hit whose aid matches the supp's embedded trigger aid wins
        // outright; otherwise the candidate (any class) closest to a clean ratio wins.
        for (i, event) in events.iter().enumerate() {
            let Message::DamageEvent(e) = event else {
                continue;
            };
            let ActionType::SupplementaryDamage(supp_aid) = e.action_id else {
                continue;
            };
            let src = (e.source.index, e.source.actor_type);

            let mut best: Option<(TriggerClass, f64)> = None; // (class, ratio distance)
            let dist = |r: f64| (r - 0.2).abs().min((r - 0.4).abs());
            for prev in events[..i].iter().rev().take(LOOKBACK) {
                let Message::DamageEvent(p) = prev else {
                    continue;
                };
                if (p.source.index, p.source.actor_type) != src || p.damage <= 0 {
                    continue;
                }
                let r = e.damage as f64 / p.damage as f64;
                if !clean_ratio(r) {
                    continue;
                }
                let class = match p.action_id {
                    ActionType::Normal(paid) if paid == supp_aid => TriggerClass::NormalAidMatch,
                    ActionType::Normal(_) => TriggerClass::NormalOther,
                    ActionType::LinkAttack => TriggerClass::LinkAttack,
                    ActionType::SBA => TriggerClass::Sba,
                    ActionType::DamageOverTime(_) => TriggerClass::Dot,
                    ActionType::SupplementaryDamage(_)
                    | ActionType::PerfectGuard
                    | ActionType::PerfectGuardQuickening
                    | ActionType::StunEffect(_) => continue,
                };
                if class == TriggerClass::NormalAidMatch {
                    best = Some((class, 0.0));
                    break;
                }
                if best.map_or(true, |(_, bd)| dist(r) < bd) {
                    best = Some((class, dist(r)));
                }
            }
            let class = best.map_or(TriggerClass::Unattributed, |(c, _)| c);
            *tallies
                .entry(src)
                .or_default()
                .attributed
                .entry(class)
                .or_default() += 1;
            *global_attr.entry(class).or_default() += 1;

            // aid membership (against the full-log Normal aid set for this source)
            let known = tallies
                .get(&src)
                .is_some_and(|t| t.normal_aids.contains(&supp_aid));
            if known {
                aid_in_normal += 1;
            } else {
                aid_not_in_normal += 1;
                *unknown_aids.entry(supp_aid).or_default() += 1;
            }
            if matches!(
                class,
                TriggerClass::LinkAttack | TriggerClass::Sba | TriggerClass::Dot
            ) {
                let c = nonnormal_attr_aid_in_normal.entry(class).or_default();
                c.1 += 1;
                if known {
                    c.0 += 1;
                }
            }
        }

        let log_supp: u64 = tallies.values().map(|t| t.supp_events).sum();
        if log_supp == 0 {
            continue;
        }
        logs_with_supp += 1;
        println!("=== log {id} {time}");

        let mut proc_rates: BTreeMap<Src, f64> = BTreeMap::new();
        for (src, t) in &tallies {
            if t.supp_events == 0 {
                continue;
            }
            let normal_attr = t
                .attributed
                .get(&TriggerClass::NormalAidMatch)
                .copied()
                .unwrap_or(0)
                + t.attributed
                    .get(&TriggerClass::NormalOther)
                    .copied()
                    .unwrap_or(0);
            let proc_rate = if t.normal_hits > 0 {
                normal_attr as f64 / t.normal_hits as f64
            } else {
                0.0
            };
            println!(
                "  src {:#x}/{}: normal={} la={} sba={} dot={} supp={} proc_rate={:.3}",
                src.1,
                src.0,
                t.normal_hits,
                t.la_hits,
                t.sba_hits,
                t.dot_hits,
                t.supp_events,
                proc_rate
            );
            proc_rates.insert(*src, proc_rate);
            for (class, n) in &t.attributed {
                println!("    -> {}: {n}", class.name());
            }

            // Roll into global per-class stats (opportunity-weighted by this
            // player-log's Normal proc rate).
            for (name, hits, attributed) in [
                ("normal", t.normal_hits, normal_attr),
                (
                    "link attack",
                    t.la_hits,
                    t.attributed
                        .get(&TriggerClass::LinkAttack)
                        .copied()
                        .unwrap_or(0),
                ),
                (
                    "sba",
                    t.sba_hits,
                    t.attributed.get(&TriggerClass::Sba).copied().unwrap_or(0),
                ),
                (
                    "dot",
                    t.dot_hits,
                    t.attributed.get(&TriggerClass::Dot).copied().unwrap_or(0),
                ),
            ] {
                let s = global_class.entry(name).or_default();
                s.hits += hits;
                s.attributed += attributed;
                s.expected_if_eligible += proc_rate * hits as f64;
            }
        }

        // Forward per-hit test, restricted to sources with a solid Normal proc rate:
        // is this hit followed (within FWD_WINDOW events) by a same-source supp at a
        // clean ratio of THIS hit's damage? For Normal hits the supp must also embed
        // this hit's aid (true-positive benchmark). "tight" for LA/SBA/DoT requires
        // the supp's aid to NOT be any Normal skill of the source — a supp no Normal
        // hit could explain.
        for (i, event) in events.iter().enumerate() {
            let Message::DamageEvent(h) = event else {
                continue;
            };
            if h.damage <= 0 {
                continue;
            }
            let src = (h.source.index, h.source.actor_type);
            if proc_rates.get(&src).copied().unwrap_or(0.0) < 0.2 {
                continue;
            }
            let (class, hit_aid) = match h.action_id {
                ActionType::Normal(aid) => ("normal", Some(aid)),
                ActionType::LinkAttack => ("link attack", None),
                ActionType::SBA => ("sba", None),
                ActionType::DamageOverTime(_) => ("dot", None),
                ActionType::SupplementaryDamage(_)
                | ActionType::PerfectGuard
                | ActionType::PerfectGuardQuickening
                | ActionType::StunEffect(_) => continue,
            };
            let normal_aids = &tallies[&src].normal_aids;
            let (mut loose_hit, mut tight_hit) = (false, false);
            for next in events[i + 1..].iter().take(FWD_WINDOW) {
                let Message::DamageEvent(s) = next else {
                    continue;
                };
                let ActionType::SupplementaryDamage(said) = s.action_id else {
                    continue;
                };
                if (s.source.index, s.source.actor_type) != src || s.damage <= 0 {
                    continue;
                }
                if !clean_ratio(s.damage as f64 / h.damage as f64) {
                    continue;
                }
                if let Some(aid) = hit_aid {
                    if said == aid {
                        loose_hit = true;
                    }
                } else {
                    loose_hit = true;
                    if !normal_aids.contains(&said) {
                        tight_hit = true;
                    }
                }
            }
            let l = fwd_loose.entry(class).or_default();
            l.1 += 1;
            if loose_hit {
                l.0 += 1;
            }
            let t = fwd_tight.entry(class).or_default();
            t.1 += 1;
            if tight_hit {
                t.0 += 1;
            }
        }
    }

    println!();
    println!(
        "==================== AGGREGATE ({logs_with_supp} logs with supp) ===================="
    );
    println!("supp attribution by trigger class:");
    for (class, n) in &global_attr {
        println!("  {}: {n}", class.name());
    }
    println!();
    println!("per-class eligibility (only player-logs that had supp procs):");
    println!(
        "  {:<12} {:>10} {:>12} {:>20}",
        "class", "hits", "attributed", "expected-if-eligible"
    );
    for (name, s) in &global_class {
        println!(
            "  {:<12} {:>10} {:>12} {:>20.1}",
            name, s.hits, s.attributed, s.expected_if_eligible
        );
    }
    println!();
    println!("of supps ratio-attributed to LA/SBA/DoT, how many embed a Normal-skill aid:");
    for (class, (in_normal, total)) in &nonnormal_attr_aid_in_normal {
        println!("  {}: {in_normal}/{total}", class.name());
    }
    println!();
    println!("forward per-hit test (sources with Normal proc_rate >= 0.2):");
    println!(
        "  {:<12} {:>18} {:>24}",
        "class", "followed (loose)", "followed (tight, non-Normal aid)"
    );
    for (class, (n, tot)) in &fwd_loose {
        let (tn, ttot) = fwd_tight.get(class).copied().unwrap_or((0, 0));
        println!(
            "  {:<12} {:>10}/{:<7} ({:>5.1}%) {:>10}/{:<7} ({:>5.1}%)",
            class,
            n,
            tot,
            if *tot > 0 {
                *n as f64 / *tot as f64 * 100.0
            } else {
                0.0
            },
            tn,
            ttot,
            if ttot > 0 {
                tn as f64 / ttot as f64 * 100.0
            } else {
                0.0
            },
        );
    }
    println!();
    println!(
        "supp aid membership: {aid_in_normal} aids seen as Normal from same source, \
         {aid_not_in_normal} not"
    );
    if !unknown_aids.is_empty() {
        let mut top: Vec<_> = unknown_aids.iter().collect();
        top.sort_by_key(|(_, n)| std::cmp::Reverse(**n));
        println!("  top unknown supp aids (aid x count):");
        for (aid, n) in top.iter().take(15) {
            println!("    {aid} x{n}");
        }
    }

    Ok(())
}
