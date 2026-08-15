//! Diagnostic: does the authored weight table ADD UP against real remote bars?
//!
//! The share formula rests on one physical claim: a remote's poll rise is the
//! sum of per-hit grants `K × spArtsRate(action)` over the interval since that
//! slot's previous tick, with `K` constant per (fight, actor). The local-slot
//! replay in `sba_infer_score` validates the split against captioned truth,
//! but only ever on locally simulated bars. THIS tool tests the claim on the
//! bars the feature actually exists for: every stored log with true remote
//! slots (rises with no hook-read gains, in a log whose local slot IS
//! captioned — proof the hook era could have read them).
//!
//! Per remote slot it fits the single unknown, `K = median(rise / Σweight)`,
//! over the rises whose interval evidence is clean, then reports how much of
//! the gauge reconstructs to within tolerance — and puts every excluded rise
//! in a named bucket (chain grant, damage-taken contamination, an action the
//! table does not cover, no hit at all). The unknown-action histogram is the
//! weight table's curation feedback loop.
//!
//! Unlike the shipped rule this deliberately applies NO lookback: the fit uses
//! the full inter-tick interval, because the question is whether the MODEL
//! holds, not whether the shipped windowing recovers it.
//!
//! Run: cargo run -p gbfr-logs --example sba_share_check -- [--db <path>]
//!      [--log <id>] [--recent <n>] [--all] [--lag <ms>] [--verbose]

use std::collections::HashMap;
use std::path::PathBuf;

use anyhow::{Context, Result};
use gbfr_logs::parser::constants::CharacterType;
use gbfr_logs::parser::v1::sba_inference::{
    self, authored_hit_weight, is_flat_grant, Windows, MIN_RESIDUAL,
};
use gbfr_logs::parser::v1::{is_damage_taken_event, Encounter};
use protocol::{ActionType, Message, SbaGainCause};
use rusqlite::{Connection, OpenFlags};

/// A slot with at least this much polled gauge is worth classifying at all.
const MIN_POLLED: f64 = 20.0;
/// Read gains explaining less than this fraction of the polled total marks a
/// remote slot; more than half marks a locally simulated one. In between is
/// reported as "partial" and fitted anyway (the residual walk removes the
/// captioned part).
const REMOTE_READ_FRACTION: f64 = 0.05;
const LOCAL_READ_FRACTION: f64 = 0.5;

#[derive(Default)]
struct Evidence {
    rises: Vec<(i64, f64)>,
    read_gains: Vec<(i64, f64)>,
    /// Gauge-eligible variants only (Normal / LinkAttack), matching the
    /// pipeline's own `gather` — echoes, DoT ticks and SBA hits weigh 0.0 by
    /// corpus-proven policy and cannot contaminate an interval.
    hits: Vec<(i64, ActionType)>,
    taken: Vec<i64>,
    /// Captioned skill gains, for the local slot's direct K measurement.
    captioned: Vec<(ActionType, f64)>,
}

/// One residual rise, classified by the evidence inside its interval.
enum RiseClass {
    /// Clean: every hit priced by the table, no incoming damage. Carries Σw.
    Fittable(f64),
    Chain,
    Taken,
    Unknown,
    ZeroWeight,
    NoEvidence,
}

struct SlotReport {
    character: Option<CharacterType>,
    polled: f64,
    /// (kept for the per-log detail print)
    rises: usize,
    /// Residual gauge per bucket: [fittable, chain, taken, unknown, zero-w, no-hit].
    bucket_gauge: [f64; 6],
    bucket_count: [usize; 6],
    fitted_k: Option<f64>,
    /// Of the fittable gauge, how much sits in rises reconstructed to ±5/±10/±25%.
    within: [f64; 3],
    within_count: [usize; 3],
    /// Rises beyond ±25% that DO reconstruct once a 100.0 chain grant embedded
    /// in the lump is subtracted first.
    chain_embedded: usize,
    chain_embedded_gauge: f64,
    /// Worst misses, for the verbose print: (t, amount, predicted).
    worst: Vec<(i64, f64, f64)>,
    /// The whole-fight test, immune to tick-boundary jitter: cumulative
    /// residual gauge (flat chain grants subtracted) against cumulative
    /// consumed weight, under the single end-to-end K. `None` when no weight
    /// was consumed at all.
    tracking: Option<Tracking>,
    /// Table holes seen in this slot's intervals: action → implicated gauge.
    unknown_here: HashMap<ActionType, f64>,
}

struct Tracking {
    /// `R_end / W_end` — the K one gets by trusting only the totals.
    k_total: f64,
    /// max |R(t) − K·W(t)| over the fight, as a fraction of R_end. Small means
    /// one K explains the whole curve and the per-rise misses are only
    /// boundary jitter; large means the model itself drifts.
    max_deviation: f64,
    /// Same, at the median tick — how far off the curve TYPICALLY sits.
    median_deviation: f64,
}

fn median(samples: &mut [f64]) -> Option<f64> {
    if samples.is_empty() {
        return None;
    }
    samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
    Some(samples[samples.len() / 2])
}

fn gather(events: &[(i64, Message)]) -> HashMap<u32, Evidence> {
    let mut by_player: HashMap<u32, Evidence> = HashMap::new();
    for (timestamp, event) in events {
        match event {
            Message::OnUpdateSBA(update) if update.sba_added > 0.0 => {
                by_player
                    .entry(update.actor_index)
                    .or_default()
                    .rises
                    .push((*timestamp, update.sba_added as f64));
            }
            Message::SbaGain(gain) => {
                let evidence = by_player.entry(gain.actor_index).or_default();
                evidence.read_gains.push((*timestamp, gain.amount as f64));
                if let Some(SbaGainCause::Skill(action)) = gain.cause {
                    evidence.captioned.push((action, gain.amount as f64));
                }
            }
            Message::DamageEvent(damage) if is_damage_taken_event(damage) => {
                by_player
                    .entry(damage.target.parent_index)
                    .or_default()
                    .taken
                    .push(*timestamp);
            }
            Message::DamageEvent(damage)
                if matches!(
                    damage.action_id,
                    ActionType::Normal(_) | ActionType::LinkAttack
                ) =>
            {
                by_player
                    .entry(damage.source.parent_index)
                    .or_default()
                    .hits
                    .push((*timestamp, damage.action_id));
            }
            _ => {}
        }
    }
    by_player
}

/// The direct K measurement only a captioned slot allows: every skill-captioned
/// gain divided by its action's authored weight. One number per fight if the
/// model holds.
fn local_k(evidence: &Evidence, character: Option<CharacterType>) -> Option<(f64, f64, usize)> {
    let mut ks: Vec<f64> = evidence
        .captioned
        .iter()
        .filter_map(|(action, amount)| {
            let weight = authored_hit_weight(character, *action)?;
            (weight > 0.0).then(|| amount / weight)
        })
        .collect();
    let n = ks.len();
    let k = median(&mut ks)?;
    let spread = ks
        .iter()
        .map(|sample| (sample / k - 1.0).abs())
        .fold(0.0f64, f64::max);
    Some((k, spread, n))
}

/// Classify every residual rise of one slot, fit K over the clean ones, and
/// score the reconstruction. `unknown_actions` collects (character, action) →
/// implicated gauge across the whole run — the table's curation worklist.
fn check_slot(
    evidence: &Evidence,
    character: Option<CharacterType>,
    lag: i64,
    unknown_actions: &mut HashMap<(String, ActionType), f64>,
    proposed: &mut HashMap<(String, ActionType), Vec<f64>>,
) -> SlotReport {
    let windows = Windows::default();
    let residuals =
        sba_inference::residuals(&evidence.rises, &evidence.read_gains, windows.poll_lag_ms);
    let polled: f64 = evidence.rises.iter().map(|(_, amount)| amount).sum();
    let character_name =
        character.map_or_else(|| "unknown".to_string(), |character| character.to_string());

    // Consumption walk: a hit (or incoming hit) belongs to the first tick at or
    // after it, exactly like the pipeline spends read gains — cursors, so
    // nothing is counted into two intervals.
    let mut hit_cursor = 0usize;
    let mut taken_cursor = 0usize;

    let mut classified: Vec<(i64, f64, RiseClass)> = Vec::new();
    let mut unknown_gauge: HashMap<ActionType, f64> = HashMap::new();
    // (action, hit count, residual, Σw of the priced hits beside it) — rises a
    // single table hole can be solved from once K is known.
    let mut solvable: Vec<(ActionType, usize, f64, f64)> = Vec::new();
    // The cumulative series behind `Tracking`. Every tick contributes — even
    // sub-threshold ones — because their hits were consumed and their gauge
    // rose; a flat chain grant contributes its residual MINUS the flat value
    // (the grant is real gauge, just not hit-priced).
    let mut cumulative: Vec<(f64, f64)> = Vec::new();
    let (mut r_cum, mut w_cum) = (0.0f64, 0.0f64);
    for (at, residual) in &residuals {
        let until = at + lag;
        let mut sum_weight = 0.0f64;
        let mut n_hits = 0usize;
        let mut unknown_here: HashMap<ActionType, usize> = HashMap::new();
        while hit_cursor < evidence.hits.len() && evidence.hits[hit_cursor].0 <= until {
            let (_, action) = evidence.hits[hit_cursor];
            hit_cursor += 1;
            n_hits += 1;
            match authored_hit_weight(character, action) {
                Some(weight) => sum_weight += weight,
                None => *unknown_here.entry(action).or_default() += 1,
            }
        }
        let mut taken_here = 0usize;
        while taken_cursor < evidence.taken.len() && evidence.taken[taken_cursor] <= until {
            taken_cursor += 1;
            taken_here += 1;
        }

        // The tracking series takes only the ticks whose gauge is entirely
        // hit-priced: a flat chain grant contributes its excess, and a tick
        // holding incoming damage or an unpriceable action is dropped WHOLE
        // (residual and weight both) — contamination must not read as model
        // drift.
        if taken_here == 0 && unknown_here.is_empty() {
            r_cum += if is_flat_grant(*residual) {
                0.0
            } else {
                *residual
            };
            w_cum += sum_weight;
            cumulative.push((r_cum, w_cum));
        }

        if *residual < MIN_RESIDUAL {
            continue; // Interval evidence is still consumed above, on purpose.
        }
        for action in unknown_here.keys() {
            *unknown_actions
                .entry((character_name.clone(), *action))
                .or_default() += residual;
            *unknown_gauge.entry(*action).or_default() += residual;
        }
        // A rise whose ONLY unpriced evidence is one unknown action solves for
        // that action's weight once K is fitted: w = (rise − K·Σw_known) / n.
        if unknown_here.len() == 1 && taken_here == 0 && !is_flat_grant(*residual) {
            let (action, count) = unknown_here.iter().next().unwrap();
            solvable.push((*action, *count, *residual, sum_weight));
        }
        let class = if is_flat_grant(*residual) {
            RiseClass::Chain
        } else if taken_here > 0 {
            RiseClass::Taken
        } else if !unknown_here.is_empty() {
            RiseClass::Unknown
        } else if n_hits == 0 {
            RiseClass::NoEvidence
        } else if sum_weight <= 0.0 {
            RiseClass::ZeroWeight
        } else {
            RiseClass::Fittable(sum_weight)
        };
        classified.push((*at, *residual, class));
    }

    let tracking = (w_cum > 0.0 && r_cum > 0.0).then(|| {
        let k_total = r_cum / w_cum;
        let mut deviations: Vec<f64> = cumulative
            .iter()
            .map(|(r, w)| (r - k_total * w).abs() / r_cum)
            .collect();
        deviations.sort_by(|a, b| a.partial_cmp(b).unwrap());
        Tracking {
            k_total,
            max_deviation: *deviations.last().unwrap(),
            median_deviation: deviations[deviations.len() / 2],
        }
    });

    // Score against the totals-fitted K, not the median of per-rise ratios:
    // boundary jitter moves hits between adjacent ticks, which skews individual
    // ratios far more than it skews the clean-tick totals. The median is kept
    // as a fallback for a slot with no clean ticks at all.
    let mut ratios: Vec<f64> = classified
        .iter()
        .filter_map(|(_, amount, class)| match class {
            RiseClass::Fittable(sum_weight) => Some(amount / sum_weight),
            _ => None,
        })
        .collect();
    let fitted_k = tracking
        .as_ref()
        .map(|tracking| tracking.k_total)
        .or_else(|| median(&mut ratios));

    if let Some(k) = fitted_k {
        for (action, count, residual, sum_weight) in solvable {
            let estimate = (residual - k * sum_weight) / (k * count as f64);
            // A negative estimate means the priced hits alone already exceed
            // the rise — boundary jitter, not evidence about the hole.
            if estimate > 0.0 {
                proposed
                    .entry((character_name.clone(), action))
                    .or_default()
                    .push(estimate);
            }
        }
    }

    let mut report = SlotReport {
        character,
        polled,
        rises: evidence.rises.len(),
        bucket_gauge: [0.0; 6],
        bucket_count: [0; 6],
        fitted_k,
        within: [0.0; 3],
        within_count: [0; 3],
        chain_embedded: 0,
        chain_embedded_gauge: 0.0,
        worst: Vec::new(),
        tracking,
        unknown_here: unknown_gauge,
    };

    for (at, amount, class) in &classified {
        let bucket = match class {
            RiseClass::Fittable(_) => 0,
            RiseClass::Chain => 1,
            RiseClass::Taken => 2,
            RiseClass::Unknown => 3,
            RiseClass::ZeroWeight => 4,
            RiseClass::NoEvidence => 5,
        };
        report.bucket_gauge[bucket] += amount;
        report.bucket_count[bucket] += 1;

        let (RiseClass::Fittable(sum_weight), Some(k)) = (class, fitted_k) else {
            continue;
        };
        let predicted = k * sum_weight;
        let err = (predicted - amount).abs() / amount;
        for (slot, tolerance) in [0.05, 0.10, 0.25].into_iter().enumerate() {
            if err <= tolerance {
                report.within[slot] += amount;
                report.within_count[slot] += 1;
            }
        }
        if err > 0.25 {
            // A chain grant delivered inside the same sync lump is invisible to
            // the exact-value rule; subtracting it first is the obvious rescue.
            if *amount > 100.0 && ((amount - 100.0) - predicted).abs() / amount <= 0.10 {
                report.chain_embedded += 1;
                report.chain_embedded_gauge += amount;
            }
            report.worst.push((*at, *amount, predicted));
        }
    }
    report.worst.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
    report.worst.truncate(4);
    report
}

fn main() -> Result<()> {
    let mut db_path = PathBuf::from("src-tauri/logs.db");
    let mut log_id: Option<i64> = None;
    let mut recent: i64 = 300;
    let mut all = false;
    let mut lag: i64 = Windows::default().move_ms;
    let mut verbose = false;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => db_path = args.next().context("--db needs a path")?.into(),
            "--log" => log_id = Some(args.next().context("--log needs an id")?.parse()?),
            "--recent" => recent = args.next().context("--recent needs a count")?.parse()?,
            "--all" => all = true,
            "--lag" => lag = args.next().context("--lag needs ms")?.parse()?,
            "--verbose" => verbose = true,
            other => anyhow::bail!("unknown arg: {other}"),
        }
    }
    if all {
        recent = i64::MAX;
    }

    let conn = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mut stmt = conn.prepare(
        "SELECT id, datetime(time/1000,'unixepoch','localtime'), data \
         FROM logs WHERE (?1 IS NULL OR id = ?1) ORDER BY id DESC LIMIT ?2",
    )?;
    let rows: Vec<(i64, String, Vec<u8>)> = stmt
        .query_map(rusqlite::params![log_id, recent], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?
        .collect::<std::result::Result<_, _>>()?;

    let mut scanned = 0usize;
    let mut qualifying = 0usize;
    // (character name) → [fittable, chain, taken, unknown, zero-w, no-hit]
    // gauge, plus the within-tolerance slices, pooled over every remote slot.
    let mut per_character: HashMap<String, ([f64; 6], [f64; 3], f64)> = HashMap::new();
    let mut unknown_actions: HashMap<(String, ActionType), f64> = HashMap::new();
    let mut proposed_weights: HashMap<(String, ActionType), Vec<f64>> = HashMap::new();
    let mut total_chain_embedded = 0.0f64;

    for (id, when, blob) in rows {
        scanned += 1;
        let mut encounter = match Encounter::from_blob(&blob) {
            Ok(encounter) => encounter,
            Err(error) => {
                if log_id.is_some() {
                    println!("log {id}: unreadable: {error}");
                }
                continue;
            }
        };
        encounter.repopulate_event_log();
        let events: Vec<(i64, Message)> = encounter
            .event_log()
            .map(|(timestamp, event)| (*timestamp, event.clone()))
            .collect();
        let by_player = gather(&events);
        let aliases = sba_inference::character_aliases(&encounter.player_data);

        // A slot only counts as remote inside a log whose local slot proves the
        // hook could caption at all — otherwise every pre-SbaGain-era log would
        // read as "all remotes".
        let mut locals: Vec<u32> = Vec::new();
        let mut remotes: Vec<u32> = Vec::new();
        let mut partials: Vec<u32> = Vec::new();
        for (index, evidence) in &by_player {
            let polled: f64 = evidence.rises.iter().map(|(_, amount)| amount).sum();
            if polled < MIN_POLLED {
                continue;
            }
            let read: f64 = evidence.read_gains.iter().map(|(_, amount)| amount).sum();
            if read >= polled * LOCAL_READ_FRACTION {
                locals.push(*index);
            } else if read <= polled * REMOTE_READ_FRACTION {
                remotes.push(*index);
            } else {
                partials.push(*index);
            }
        }
        if locals.is_empty() || remotes.is_empty() {
            if log_id.is_some() {
                println!(
                    "log {id} ({when}): no remote slots to check \
                     (locals={}, remotes={}, partials={})",
                    locals.len(),
                    remotes.len(),
                    partials.len()
                );
            }
            continue;
        }
        qualifying += 1;

        let detail = verbose || log_id.is_some();
        println!("log {id} ({when}):");
        for index in &locals {
            let evidence = &by_player[index];
            let character = aliases.get(index).copied();
            let name = character.map_or_else(|| "unknown".into(), |c| c.to_string());
            match local_k(evidence, character) {
                Some((k, spread, n)) => println!(
                    "  local  {index:#010x} ({name}): K={k:.4} (n={n}, max dev {:.1}%)",
                    spread * 100.0
                ),
                None => println!("  local  {index:#010x} ({name}): no captioned skill gains"),
            }
        }
        for index in remotes.iter().chain(&partials) {
            let evidence = &by_player[index];
            let character = aliases.get(index).copied();
            let name = character.map_or_else(|| "unknown".into(), |c| c.to_string());
            let kind = if partials.contains(index) {
                "part."
            } else {
                "remote"
            };
            let report = check_slot(
                evidence,
                character,
                lag,
                &mut unknown_actions,
                &mut proposed_weights,
            );
            let [fittable, chain, taken, unknown, zero_weight, no_hit] = report.bucket_gauge;
            let k_text = report
                .fitted_k
                .map_or_else(|| "unfittable".to_string(), |k| format!("K={k:.4}"));
            println!(
                "  {kind} {index:#010x} ({name}): rises={} polled={:.1} {k_text}",
                report.rises, report.polled
            );
            println!(
                "    buckets: fittable={fittable:.1}/{} chain={chain:.1}/{} taken={taken:.1}/{} \
                 unknown={unknown:.1}/{} zero-w={zero_weight:.1}/{} no-hit={no_hit:.1}/{}",
                report.bucket_count[0],
                report.bucket_count[1],
                report.bucket_count[2],
                report.bucket_count[3],
                report.bucket_count[4],
                report.bucket_count[5],
            );
            if fittable > 0.0 {
                println!(
                    "    reconstructed: ±5% {:.1} ({:.0}%, n={})  ±10% {:.1} ({:.0}%, n={})  \
                     ±25% {:.1} ({:.0}%, n={})  chain-embedded {:.1}/{}",
                    report.within[0],
                    100.0 * report.within[0] / fittable,
                    report.within_count[0],
                    report.within[1],
                    100.0 * report.within[1] / fittable,
                    report.within_count[1],
                    report.within[2],
                    100.0 * report.within[2] / fittable,
                    report.within_count[2],
                    report.chain_embedded_gauge,
                    report.chain_embedded,
                );
            }
            if let Some(tracking) = &report.tracking {
                println!(
                    "    whole-fight: K_total={:.4}  cumulative deviation median {:.1}% \
                     max {:.1}% of the residual total",
                    tracking.k_total,
                    tracking.median_deviation * 100.0,
                    tracking.max_deviation * 100.0,
                );
            }
            if detail {
                for (at, amount, predicted) in &report.worst {
                    let offset = events.first().map_or(0, |(start, _)| at - start);
                    println!(
                        "      miss at t={:.1}s: rise={amount:.2} predicted={predicted:.2}",
                        offset as f64 / 1000.0
                    );
                }
                if !report.unknown_here.is_empty() {
                    let mut holes: Vec<_> = report.unknown_here.iter().collect();
                    holes.sort_by(|a, b| b.1.partial_cmp(a.1).unwrap());
                    let listed: Vec<String> = holes
                        .iter()
                        .map(|(action, gauge)| format!("{action:?} ({gauge:.1})"))
                        .collect();
                    println!("      table holes: {}", listed.join("  "));
                }
            }

            let entry = per_character
                .entry(
                    report
                        .character
                        .map_or_else(|| "unknown".into(), |c| c.to_string()),
                )
                .or_default();
            for (slot, gauge) in report.bucket_gauge.into_iter().enumerate() {
                entry.0[slot] += gauge;
            }
            for (slot, gauge) in report.within.into_iter().enumerate() {
                entry.1[slot] += gauge;
            }
            entry.2 += report.polled;
            total_chain_embedded += report.chain_embedded_gauge;
        }
        println!();
    }

    if log_id.is_none() {
        println!("scanned {scanned} logs, {qualifying} had captioned local + remote slots\n");
        if qualifying == 0 {
            return Ok(());
        }
        println!("per character, pooled over every remote slot:");
        let mut characters: Vec<_> = per_character.into_iter().collect();
        characters.sort_by(|a, b| {
            let total_a: f64 = a.1 .0.iter().sum();
            let total_b: f64 = b.1 .0.iter().sum();
            total_b.partial_cmp(&total_a).unwrap()
        });
        let mut totals = ([0.0f64; 6], [0.0f64; 3]);
        for (name, (buckets, within, _polled)) in &characters {
            let [fittable, chain, taken, unknown, zero_weight, no_hit] = *buckets;
            for (slot, gauge) in buckets.iter().enumerate() {
                totals.0[slot] += gauge;
            }
            for (slot, gauge) in within.iter().enumerate() {
                totals.1[slot] += gauge;
            }
            let residual: f64 = buckets.iter().sum();
            println!(
                "  {name:<10} residual={residual:8.1}  fittable={fittable:8.1} \
                 (±5% {:3.0}%  ±10% {:3.0}%  ±25% {:3.0}%)  chain={chain:.1} taken={taken:.1} \
                 unknown={unknown:.1} zero-w={zero_weight:.1} no-hit={no_hit:.1}",
                if fittable > 0.0 {
                    100.0 * within[0] / fittable
                } else {
                    0.0
                },
                if fittable > 0.0 {
                    100.0 * within[1] / fittable
                } else {
                    0.0
                },
                if fittable > 0.0 {
                    100.0 * within[2] / fittable
                } else {
                    0.0
                },
            );
        }
        let residual_total: f64 = totals.0.iter().sum();
        let fittable_total = totals.0[0];
        println!(
            "\nTOTAL: residual={residual_total:.1}  fittable={fittable_total:.1} \
             ({:.0}% of residual)  of fittable within ±5%: {:.0}%  ±10%: {:.0}%  ±25%: {:.0}%  \
             chain-embedded rescue: {total_chain_embedded:.1}",
            if residual_total > 0.0 {
                100.0 * fittable_total / residual_total
            } else {
                0.0
            },
            if fittable_total > 0.0 {
                100.0 * totals.1[0] / fittable_total
            } else {
                0.0
            },
            if fittable_total > 0.0 {
                100.0 * totals.1[1] / fittable_total
            } else {
                0.0
            },
            if fittable_total > 0.0 {
                100.0 * totals.1[2] / fittable_total
            } else {
                0.0
            },
        );

        if !unknown_actions.is_empty() {
            println!("\nactions the weight table does not cover (gauge implicated):");
            let mut holes: Vec<_> = unknown_actions.into_iter().collect();
            holes.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
            for ((character, action), gauge) in holes.iter().take(20) {
                println!("  {character:<10} {action:?}: {gauge:.1}");
            }
        }
        if !proposed_weights.is_empty() {
            println!(
                "\nweights solvable from sole-unknown rises (candidates for curation.json, \
                 confidence = agreement across rises):"
            );
            let mut proposals: Vec<_> = proposed_weights.into_iter().collect();
            proposals.sort_by(|a, b| b.1.len().cmp(&a.1.len()));
            for ((character, action), mut estimates) in proposals {
                let n = estimates.len();
                let Some(w) = median(&mut estimates) else {
                    continue;
                };
                let spread = estimates
                    .iter()
                    .map(|estimate| (estimate / w - 1.0).abs())
                    .fold(0.0f64, f64::max);
                println!(
                    "  {character:<10} {action:?}: w≈{w:.3} (n={n}, max dev {:.0}%)",
                    spread * 100.0
                );
            }
        }
    }

    Ok(())
}
