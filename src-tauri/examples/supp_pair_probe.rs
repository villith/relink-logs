//! Evidence for `parser::v1::supp_pairing::PAIRING_WINDOW_MS`: can a
//! supplementary-damage event be paired to the hit that triggered it, purely
//! from event ORDER?
//!
//! Strategy C is what `supp_pairing` implements, line for line. Re-run this
//! after a game patch: a shifted echo lag shows up as a rising ORPHAN%, and the
//! window constant is re-derived from the reported time gaps.
//!
//! Deliberately assumes NOTHING about the supp/trigger damage ratio — the older
//! `supp_scan` scored pairings against a 0.2/0.4 hypothesis that later work
//! superseded, so its numbers answer a different question.
//!
//! Four pairing strategies are run side by side over the same events:
//!
//!   A  (source, aid) FIFO, no expiry          — the naive "in order" reading
//!   B  (source, aid) FIFO, expire > WINDOW ms — same, but a trigger that never
//!                                               procs stops poisoning the queue
//!   C  B + prefer a candidate on the SAME TARGET
//!   D  (source, target, aid) FIFO, expiry     — target folded into the key
//!
//! Judged by three signals, none of which assumes a ratio:
//!
//!   ORPHAN%    echoes left with no candidate. Low = the rule finds triggers.
//!   TGTMISS%   paired trigger had a different target. Low = independent
//!              corroboration (A/B never look at the target, so agreement there
//!              is evidence the ordering alone found the right hit).
//!   QUANT%     paired ratios landing on a clean multiple of 0.05. High = the
//!              pairs are real; mispairing smears this to noise.
//!
//! Run: cargo run -p gbfr-logs --example supp_pair_probe [-- --db <path>] [--log <id>] [--since <id>]

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::PathBuf;

use anyhow::{Context, Result};
use gbfr_logs::parser::v1::Encounter;
use protocol::{ActionType, Message};
use rusqlite::Connection;

/// How long a trigger stays claimable. Chosen from the measured lag, not
/// guessed: log 2573 puts the echo p50 at 151ms and p99 at 169ms behind its
/// trigger, so 500ms is ~3x the observed tail.
const WINDOW_MS: i64 = 500;

#[derive(Clone, Copy)]
struct Pending {
    timestamp: i64,
    damage: i32,
    target_index: u32,
    target_actor_type: u32,
}

#[derive(Clone, Copy, PartialEq)]
enum Strategy {
    FifoNoExpiry,
    Fifo,
    PreferTarget,
    TargetKeyed,
}

#[derive(Default)]
struct Stats {
    echoes: u64,
    orphans: u64,
    target_hit: u64,
    target_miss: u64,
    quantized: u64,
    paired: u64,
    ratios: BTreeMap<String, u64>,
}

/// A ratio that is a clean multiple of 0.05 — the quantization the paired
/// population shows when the pairs are real. Ratio-value agnostic: it does not
/// care WHICH multiple, only that the population is not a smear.
fn is_quantized(ratio: f64) -> bool {
    (ratio / 0.05 - (ratio / 0.05).round()).abs() * 0.05 < 0.001
}

fn run(strategy: Strategy, events: &[(i64, protocol::DamageEvent)]) -> Stats {
    let mut stats = Stats::default();
    // Key is (source index, source actor type, action id) — plus the target for
    // the target-keyed strategy.
    let mut pending: HashMap<(u32, u32, u32, u32, u32), VecDeque<Pending>> = HashMap::new();

    let key_of = |source: (u32, u32), aid: u32, target: (u32, u32)| match strategy {
        Strategy::TargetKeyed => (source.0, source.1, aid, target.0, target.1),
        _ => (source.0, source.1, aid, 0, 0),
    };

    for (timestamp, event) in events {
        let source = (event.source.index, event.source.actor_type);
        let target = (event.target.index, event.target.actor_type);

        match event.action_id {
            ActionType::Normal(aid) if event.damage > 0 => {
                pending
                    .entry(key_of(source, aid, target))
                    .or_default()
                    .push_back(Pending {
                        timestamp: *timestamp,
                        damage: event.damage,
                        target_index: target.0,
                        target_actor_type: target.1,
                    });
            }
            ActionType::SupplementaryDamage(aid) => {
                stats.echoes += 1;
                let queue = pending.entry(key_of(source, aid, target)).or_default();

                // A trigger that never procced would otherwise sit in the queue
                // forever and shift every later echo by one — a desync that
                // never self-corrects.
                if strategy != Strategy::FifoNoExpiry {
                    while queue
                        .front()
                        .is_some_and(|p| timestamp - p.timestamp > WINDOW_MS)
                    {
                        queue.pop_front();
                    }
                }

                let picked = if strategy == Strategy::PreferTarget {
                    queue
                        .iter()
                        .position(|p| p.target_index == target.0 && p.target_actor_type == target.1)
                        .and_then(|at| queue.remove(at))
                        .or_else(|| queue.pop_front())
                } else {
                    queue.pop_front()
                };

                match picked {
                    Some(trigger) => {
                        stats.paired += 1;
                        if trigger.target_index == target.0 && trigger.target_actor_type == target.1
                        {
                            stats.target_hit += 1;
                        } else {
                            stats.target_miss += 1;
                        }
                        let ratio = event.damage as f64 / trigger.damage as f64;
                        if is_quantized(ratio) {
                            stats.quantized += 1;
                        }
                        *stats.ratios.entry(format!("{ratio:.3}")).or_default() += 1;
                    }
                    None => stats.orphans += 1,
                }
            }
            _ => {}
        }
    }
    stats
}

fn main() -> Result<()> {
    let mut db_path = PathBuf::from("src-tauri/logs.db");
    let mut only_log: Option<i64> = None;
    let mut since_id = 0i64;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => db_path = args.next().context("--db needs a path")?.into(),
            "--log" => only_log = Some(args.next().context("--log needs an id")?.parse()?),
            "--since" => since_id = args.next().context("--since needs an id")?.parse()?,
            other => anyhow::bail!("unknown arg: {other}"),
        }
    }

    let conn =
        Connection::open(&db_path).with_context(|| format!("opening {}", db_path.display()))?;
    let mut stmt = conn.prepare(
        "SELECT id, data FROM logs WHERE (?1 IS NULL OR id = ?1) AND id >= ?2 ORDER BY id",
    )?;
    let rows = stmt.query_map(rusqlite::params![only_log, since_id], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
    })?;

    // Corpus totals per strategy, so one weird log cannot carry the verdict.
    let names = [
        "A fifo-no-expiry",
        "B fifo+expiry",
        "C prefer-target",
        "D target-keyed",
    ];
    let strategies = [
        Strategy::FifoNoExpiry,
        Strategy::Fifo,
        Strategy::PreferTarget,
        Strategy::TargetKeyed,
    ];
    let mut totals: Vec<Stats> = (0..4).map(|_| Stats::default()).collect();
    let mut logs = 0u64;

    for row in rows {
        let (id, blob) = row?;
        let mut encounter = match Encounter::from_blob(&blob) {
            Ok(e) => e,
            Err(e) => {
                eprintln!("warn: skipping log {id}: blob decode failed: {e}");
                continue;
            }
        };
        encounter.repopulate_event_log();
        let events: Vec<(i64, protocol::DamageEvent)> = encounter
            .event_log()
            .filter_map(|(ts, message)| match message {
                Message::DamageEvent(e) => Some((*ts, e.clone())),
                _ => None,
            })
            .collect();
        if events.is_empty() {
            continue;
        }
        logs += 1;

        for (slot, strategy) in strategies.iter().enumerate() {
            let s = run(*strategy, &events);
            let t = &mut totals[slot];
            t.echoes += s.echoes;
            t.orphans += s.orphans;
            t.target_hit += s.target_hit;
            t.target_miss += s.target_miss;
            t.quantized += s.quantized;
            t.paired += s.paired;
            for (ratio, count) in s.ratios {
                *t.ratios.entry(ratio).or_default() += count;
            }
        }

        if only_log.is_some() {
            for (slot, name) in names.iter().enumerate() {
                let s = &totals[slot];
                println!(
                    "  {name:<18} orphan={:>5.1}%  tgtmiss={:>5.1}%  quant={:>5.1}%  (n={})",
                    s.orphans as f64 / s.echoes.max(1) as f64 * 100.0,
                    s.target_miss as f64 / s.paired.max(1) as f64 * 100.0,
                    s.quantized as f64 / s.paired.max(1) as f64 * 100.0,
                    s.paired
                );
            }
        }
    }

    println!("\n=== corpus totals over {logs} logs");
    for (slot, name) in names.iter().enumerate() {
        let s = &totals[slot];
        println!(
            "  {name:<18} orphan={:>5.2}%  tgtmiss={:>5.2}%  quant={:>5.2}%  (echoes={}, paired={})",
            s.orphans as f64 / s.echoes.max(1) as f64 * 100.0,
            s.target_miss as f64 / s.paired.max(1) as f64 * 100.0,
            s.quantized as f64 / s.paired.max(1) as f64 * 100.0,
            s.echoes,
            s.paired
        );
    }

    // The winning strategy's ratio histogram — the population itself, unjudged.
    let best = &totals[2];
    let mut top: Vec<(&String, &u64)> = best.ratios.iter().collect();
    top.sort_by_key(|(_, count)| std::cmp::Reverse(**count));
    println!(
        "\n  C prefer-target ratio histogram (echo/trigger), top 12 of {}:",
        best.ratios.len()
    );
    for (ratio, count) in top.iter().take(12) {
        println!(
            "    {ratio} x{count} ({:.2}%)",
            **count as f64 / best.paired.max(1) as f64 * 100.0
        );
    }

    Ok(())
}
