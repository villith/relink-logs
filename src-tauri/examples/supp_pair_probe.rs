//! Evidence for `parser::v1::supp_pairing::PAIRING_WINDOW_MS`: can a
//! supplementary-damage event be paired to the hit that triggered it, purely
//! from event ORDER?
//!
//! Strategy C IS `supp_pairing` — it calls `SuppPairing::learned_from` rather
//! than reproducing it, so this can never end up measuring a rule the parser no
//! longer runs. Re-run after a game patch: a shifted echo lag shows up as a
//! rising ORPHAN%, and `PAIRING_WINDOW_MS` is re-derived from the reported time
//! gaps.
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
//!   C  the shipped rule: B + prefer a candidate on the SAME TARGET
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
use gbfr_logs::parser::v1::supp_pairing::{SuppPairing, PAIRING_WINDOW_MS};
use gbfr_logs::parser::v1::Encounter;
use protocol::{ActionType, Message};
use rusqlite::Connection;

#[derive(Clone, Copy)]
struct Pending {
    timestamp: i64,
    damage: i32,
    target_index: u32,
    target_actor_type: u32,
}

/// The variants strategy C is judged AGAINST. C itself is not here — it is the
/// shipped rule, run through `run_shipped`.
#[derive(Clone, Copy, PartialEq)]
enum Strategy {
    FifoNoExpiry,
    Fifo,
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

impl Stats {
    /// Scores one echo that found a trigger. Shared by every strategy so the
    /// three reported signals cannot be computed differently for the shipped
    /// rule than for the variants it is judged against.
    fn record_pair(&mut self, echo_damage: i32, trigger_damage: i32, same_target: bool) {
        self.paired += 1;
        if same_target {
            self.target_hit += 1;
        } else {
            self.target_miss += 1;
        }
        let ratio = echo_damage as f64 / trigger_damage as f64;
        if is_quantized(ratio) {
            self.quantized += 1;
        }
        *self.ratios.entry(format!("{ratio:.3}")).or_default() += 1;
    }
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
                        .is_some_and(|p| timestamp - p.timestamp > PAIRING_WINDOW_MS)
                    {
                        queue.pop_front();
                    }
                }

                match queue.pop_front() {
                    Some(trigger) => stats.record_pair(
                        event.damage,
                        trigger.damage,
                        (trigger.target_index, trigger.target_actor_type) == target,
                    ),
                    None => stats.orphans += 1,
                }
            }
            _ => {}
        }
    }
    stats
}

/// Strategy C: the SHIPPED rule, called rather than reproduced.
///
/// The probe's job after a game patch is to say whether what the parser does
/// still holds. A local copy of the rule — however faithful the day it was
/// written — would keep reporting on a rule that had since moved, and the
/// numbers would still print, so the drift would be invisible.
fn run_shipped(events: &[(i64, protocol::DamageEvent)]) -> Stats {
    // `learned_from` keys its links by position in the slice it walks, so it is
    // handed exactly the events the other strategies walk — same order, same
    // indexes — and the four columns stay comparable. (The parser itself pairs
    // over the MIXED message stream, where non-damage messages take positions
    // too; that changes which index a hit has, never which hit an echo picks.)
    let stream: Vec<(i64, Message)> = events
        .iter()
        .map(|(timestamp, event)| (*timestamp, Message::DamageEvent(event.clone())))
        .collect();
    let pairing = SuppPairing::learned_from(&stream);

    let mut stats = Stats::default();
    for (position, (_, event)) in events.iter().enumerate() {
        if !matches!(event.action_id, ActionType::SupplementaryDamage(_)) {
            continue;
        }
        stats.echoes += 1;
        match pairing.trigger_of(position) {
            Some(at) => {
                let trigger = &events[at].1;
                stats.record_pair(
                    event.damage,
                    trigger.damage,
                    (trigger.target.index, trigger.target.actor_type)
                        == (event.target.index, event.target.actor_type),
                );
            }
            None => stats.orphans += 1,
        }
    }
    stats
}

/// The four strategies in report order — the order `names` and the histogram's
/// `totals[2]` both read.
fn run_at(slot: usize, events: &[(i64, protocol::DamageEvent)]) -> Stats {
    match slot {
        0 => run(Strategy::FifoNoExpiry, events),
        1 => run(Strategy::Fifo, events),
        2 => run_shipped(events),
        _ => run(Strategy::TargetKeyed, events),
    }
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

        for slot in 0..4 {
            let s = run_at(slot, &events);
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
