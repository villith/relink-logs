//! Diagnostic: how well SBA inference could name a REMOTE party member's bar.
//!
//! `sba_inference` splits each poll rise the hook could not caption across the
//! actor's own hits by their authored gauge weights (`assets/sba-weights.json`).
//! The headline section here is the SHARE-FORMULA REPLAY: it runs that pipeline
//! over the LOCAL slot's rises as if they were uncaptioned and scores the
//! per-action result against the captioned truth the hook actually read —
//! `--lookback`/`--lag` probe the shipped windows. The timing statistics and
//! the sole-action window sweep below it predate the share formula and are kept
//! for comparing against the historical rule.
//!
//! The replay and the leftover report call the parser's own `sba_inference`
//! (public for this example, the way `supp_pairing` is public for its probe),
//! so what is scored here is the pipeline that actually ships — nothing is
//! mirrored, and a rule change scores itself.
//!
//! Run: cargo run -p gbfr-logs --example sba_infer_score -- [--db <path>]
//!      [--log <id>] [--lookback <ms>] [--lag <ms>]

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use anyhow::{Context, Result};
use gbfr_logs::parser::v1::sba_inference::{self, Windows, MIN_RESIDUAL};
use gbfr_logs::parser::v1::{is_damage_taken_event, Encounter};
use protocol::{ActionType, Message, SbaGainCause};
use rusqlite::{Connection, OpenFlags};

/// The move windows to sweep. 64 is what ships as `Windows::move_ms`.
const SWEEP: [i64; 8] = [16, 32, 64, 128, 250, 500, 1000, 2000];

#[derive(Default)]
struct Evidence {
    rises: Vec<(i64, f64)>,
    read_gains: Vec<(i64, f64)>,
    hits: Vec<(i64, ActionType)>,
    /// Timestamps of hits this player RECEIVED — the damage-taken rule's
    /// evidence, and the third thing the shipped pipeline tries.
    taken: Vec<i64>,
}

/// An echo is caused BY the skill it names, so it is not a second candidate for
/// the same gauge — folding it onto its parent is the difference between
/// evidence that agrees and evidence the rule calls ambiguous. `sole_action_near`
/// does NOT do this today, which is what this reports the cost of.
fn folded(action: ActionType) -> ActionType {
    match action {
        ActionType::SupplementaryDamage(id) => ActionType::Normal(id),
        other => other,
    }
}

/// How many DISTINCT actions of this actor's sit within `window` of `at`.
fn actions_near(hits: &[(i64, ActionType)], at: i64, window: i64, fold: bool) -> usize {
    hits.iter()
        .filter(|(hit_at, _)| (hit_at - at).abs() <= window)
        .map(|(_, action)| if fold { folded(*action) } else { *action })
        .collect::<HashSet<_>>()
        .len()
}

fn nearest_hit_gap(hits: &[(i64, ActionType)], at: i64) -> Option<i64> {
    hits.iter().map(|(hit_at, _)| (hit_at - at).abs()).min()
}

fn main() -> Result<()> {
    let mut db_path = PathBuf::from("src-tauri/logs.db");
    let mut log_id: Option<i64> = None;
    // The share replay's windows, overridable — defaulting to the SHIPPED
    // values themselves, so a retune cannot leave this probing stale ones.
    let shipped = Windows::default();
    let mut lookback: i64 = shipped.move_lookback_ms;
    let mut lag: i64 = shipped.move_ms;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => db_path = args.next().context("--db needs a path")?.into(),
            "--log" => log_id = Some(args.next().context("--log needs an id")?.parse()?),
            "--lookback" => {
                lookback = args.next().context("--lookback needs ms")?.parse()?;
            }
            "--lag" => lag = args.next().context("--lag needs ms")?.parse()?,
            other => anyhow::bail!("unknown arg: {other}"),
        }
    }

    let conn = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let id: i64 = match log_id {
        Some(id) => id,
        None => conn.query_row("SELECT MAX(id) FROM logs", [], |row| row.get(0))?,
    };
    let (when, blob): (String, Vec<u8>) = conn.query_row(
        "SELECT datetime(time/1000,'unixepoch','localtime'), data FROM logs WHERE id = ?",
        [id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;

    let mut encounter = Encounter::from_blob(&blob)?;
    encounter.repopulate_event_log();

    let start = encounter
        .event_log()
        .next()
        .map(|(timestamp, _)| *timestamp)
        .context("empty log")?;

    // Owned copy for the pipeline calls below — `infer_tagged` takes a slice,
    // and the replay filters per-player variants out of it.
    let events: Vec<(i64, Message)> = encounter
        .event_log()
        .map(|(timestamp, event)| (*timestamp, event.clone()))
        .collect();

    let mut by_player: HashMap<u32, Evidence> = HashMap::new();
    // Every captioned gain in the log, whoever it belongs to. The shipped rules
    // only ever look at ONE player's evidence; a gain the hook read for the
    // local slot is the obvious untried witness for a remote's rise at the same
    // instant, so it is collected globally here.
    let mut captioned: Vec<(i64, u32, protocol::SbaGainCause, f64)> = Vec::new();
    // Every rise in the log, for testing whether slots rise together.
    let mut all_rises: Vec<(i64, u32, f64)> = Vec::new();
    // Damaging hits with their amounts, for testing whether a move's gauge is a
    // constant or a function of the damage it dealt.
    let mut damaging: Vec<(i64, u32, ActionType, f64)> = Vec::new();
    // Attack rate per action. The outgoing per-hit grant (v2.0.4 FUN_1409aecd0)
    // scales its gauge by a per-hit float off the hit record; if that float is
    // the attack rate, gauge becomes derivable for EVERY player from what the
    // damage event already carries, which is the whole question.
    let mut rates: HashMap<ActionType, Vec<f64>> = HashMap::new();

    for (timestamp, event) in encounter.event_log() {
        match event {
            Message::OnUpdateSBA(update) if update.sba_added > 0.0 => {
                by_player
                    .entry(update.actor_index)
                    .or_default()
                    .rises
                    .push((*timestamp, update.sba_added as f64));
                all_rises.push((*timestamp, update.actor_index, update.sba_added as f64));
            }
            Message::SbaGain(gain) => {
                by_player
                    .entry(gain.actor_index)
                    .or_default()
                    .read_gains
                    .push((*timestamp, gain.amount as f64));
                if let Some(cause) = gain.cause {
                    captioned.push((*timestamp, gain.actor_index, cause, gain.amount as f64));
                }
            }
            Message::DamageEvent(damage) if is_damage_taken_event(damage) => by_player
                .entry(damage.target.parent_index)
                .or_default()
                .taken
                .push(*timestamp),
            Message::DamageEvent(damage) => {
                by_player
                    .entry(damage.source.parent_index)
                    .or_default()
                    .hits
                    .push((*timestamp, damage.action_id));
                damaging.push((
                    *timestamp,
                    damage.source.parent_index,
                    damage.action_id,
                    damage.damage as f64,
                ));
                if let Some(rate) = damage.attack_rate {
                    rates.entry(damage.action_id).or_default().push(rate as f64);
                }
            }
            _ => {}
        }
    }

    println!("log {id} ({when})\n");

    // GROUND TRUTH, and the premise the whole splitting idea rests on: for the
    // LOCAL slot the hook read both the cause and the amount, so this says
    // whether a given move grants a FIXED amount of gauge per hit. If it does,
    // a lumped remote rise can be decomposed into known per-move quanta. If it
    // does not, no amount of correlation will ever split one.
    let mut per_move: HashMap<ActionType, Vec<f64>> = HashMap::new();
    for (_, _, cause, amount) in &captioned {
        if let protocol::SbaGainCause::Skill(action) = cause {
            per_move.entry(*action).or_default().push(*amount);
        }
    }
    let mut moves: Vec<_> = per_move.into_iter().collect();
    moves.sort_by_key(|(_, samples)| std::cmp::Reverse(samples.len()));
    println!("per-move gauge, from the LOCAL slot's captioned gains:");
    let (mut fixed, mut varying) = (0usize, 0usize);
    for (action, samples) in &moves {
        let min = samples.iter().cloned().fold(f64::INFINITY, f64::min);
        let max = samples.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        let mean = samples.iter().sum::<f64>() / samples.len() as f64;
        // "Fixed" generously: within 1% of the mean across every sample.
        if max - min <= mean.abs() * 0.01 {
            fixed += 1;
        } else {
            varying += 1;
        }
        if samples.len() >= 3 {
            println!(
                "  {action:?} n={} mean={mean:.3} min={min:.3} max={max:.3} spread={:.1}%",
                samples.len(),
                if mean > 0.0 {
                    100.0 * (max - min) / mean
                } else {
                    0.0
                }
            );
        }
    }
    println!("  => {fixed} actions grant a fixed amount per hit, {varying} vary");

    // THE test for the scaling lead: if the grant's per-hit float is the attack
    // rate, then gauge/rate is one constant across ALL of a character's moves —
    // and gauge for a remote follows from their damage event alone.
    println!("  gauge vs attack rate (local slot):");
    for (action, samples) in &moves {
        let gauge = samples.iter().sum::<f64>() / samples.len() as f64;
        let Some(rate_samples) = rates.get(action) else {
            continue;
        };
        let rate = rate_samples.iter().sum::<f64>() / rate_samples.len() as f64;
        if samples.len() >= 3 && rate > 0.0 {
            println!(
                "    {action:?} n={} gauge={gauge:.3} rate={rate:.4} gauge/rate={:.4}",
                samples.len(),
                gauge / rate
            );
        }
    }

    // For the moves that DON'T grant a constant: is the gauge a function of the
    // damage that hit dealt? That decides whether a persisted table can be
    // (action -> constant) or has to be (action -> gauge per point of damage).
    println!("  moves whose grant varies, against the damage of the paired hit:");
    for (action, samples) in &moves {
        let min = samples.iter().cloned().fold(f64::INFINITY, f64::min);
        let max = samples.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        let mean = samples.iter().sum::<f64>() / samples.len() as f64;
        if max - min <= mean.abs() * 0.01 || samples.len() < 3 {
            continue;
        }
        // Pair each gain with the local slot's own damage event of the same
        // action nearest in time; gauge and its damage event are emitted from
        // the same frame, so anything beyond a few ms is a mismatch.
        let mut ratios: Vec<f64> = Vec::new();
        for (gain_at, gain_index, cause, amount) in &captioned {
            if !matches!(cause, protocol::SbaGainCause::Skill(a) if a == action) {
                continue;
            }
            let paired = damaging
                .iter()
                .filter(|(hit_at, hit_index, hit_action, damage)| {
                    hit_index == gain_index
                        && hit_action == action
                        && *damage > 0.0
                        && (hit_at - gain_at).abs() <= 50
                })
                .min_by_key(|(hit_at, _, _, _)| (hit_at - gain_at).abs());
            if let Some((_, _, _, damage)) = paired {
                ratios.push(amount / damage);
            }
        }
        if ratios.len() < 3 {
            println!("    {action:?}: too few pairs to judge ({})", ratios.len());
            continue;
        }
        let rmin = ratios.iter().cloned().fold(f64::INFINITY, f64::min);
        let rmax = ratios.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        let rmean = ratios.iter().sum::<f64>() / ratios.len() as f64;
        println!(
            "    {action:?}: gauge/damage n={} mean={rmean:.3e} spread={:.1}% \
             (gauge spread was {:.1}%)",
            ratios.len(),
            100.0 * (rmax - rmin) / rmean,
            100.0 * (max - min) / mean,
        );
    }
    println!();

    let mut players: Vec<_> = by_player.into_iter().collect();
    players.sort_by_key(|(index, _)| *index);

    // SHARE-FORMULA REPLAY. The shipped rule splits a rise across the hits it
    // reports by their authored weights (assets/sba-weights.json). The local
    // slot is the only place truth exists — the hook read both cause and
    // amount — so run the SHIPPED pipeline over its rises AS IF they were
    // uncaptioned (this player's `SbaGain` events filtered out) and compare
    // per-action totals against the captioned truth. Overattribution from
    // non-hit gauge (awards, effects, damage taken) that the flat rule does
    // not catch is part of what this measures.
    let aliases = sba_inference::character_aliases(&encounter.player_data);
    let replay_windows = Windows {
        move_ms: lag,
        move_lookback_ms: lookback,
        ..Windows::default()
    };
    for (index, evidence) in &players {
        // Only slots with captioned gains have truth to score against.
        if evidence.read_gains.is_empty() || evidence.rises.is_empty() {
            continue;
        }
        let mut truth: HashMap<ActionType, f64> = HashMap::new();
        for (_, gain_index, cause, amount) in &captioned {
            if gain_index == index {
                if let SbaGainCause::Skill(action) = cause {
                    *truth.entry(*action).or_default() += amount;
                }
            }
        }
        let character = aliases.get(index);
        let replay_events: Vec<(i64, Message)> = events
            .iter()
            .filter(
                |(_, event)| !matches!(event, Message::SbaGain(gain) if gain.actor_index == *index),
            )
            .cloned()
            .collect();
        let mut predicted: HashMap<ActionType, f64> = HashMap::new();
        let (mut flat, mut taken_gauge, mut named) = (0.0f64, 0.0f64, 0.0f64);
        for (gain, _) in
            sba_inference::infer_tagged(&replay_events, &|_| true, &aliases, replay_windows)
        {
            if gain.actor_index != *index {
                continue;
            }
            named += gain.amount;
            match gain.cause {
                SbaGainCause::Inferred(action) => {
                    *predicted.entry(action).or_default() += gain.amount;
                }
                SbaGainCause::InferredChainGrant => flat += gain.amount,
                SbaGainCause::InferredDamageTaken => taken_gauge += gain.amount,
                _ => {}
            }
        }
        // With this player's read gains filtered out, every rise IS its own
        // residual — so the unnamed remainder is what the pipeline declined
        // to verdict of the scoreable rises.
        let scoreable: f64 = evidence
            .rises
            .iter()
            .map(|(_, amount)| amount)
            .filter(|amount| **amount >= MIN_RESIDUAL)
            .sum();
        let unnamed = (scoreable - named).max(0.0);
        let polled: f64 = evidence.rises.iter().map(|(_, amount)| amount).sum();
        println!(
            "share replay for {index:#010x} ({}):",
            character.map_or_else(|| "unknown character".to_string(), |c| c.to_string())
        );
        let mut actions: Vec<ActionType> = truth
            .keys()
            .chain(predicted.keys())
            .copied()
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        actions.sort_by_key(|action| format!("{action:?}"));
        let (mut abs_err, mut truth_total) = (0.0f64, 0.0f64);
        for action in actions {
            let expected = truth.get(&action).copied().unwrap_or(0.0);
            let got = predicted.get(&action).copied().unwrap_or(0.0);
            abs_err += (got - expected).abs();
            truth_total += expected;
            if expected.max(got) >= 5.0 {
                println!(
                    "  {action:?} truth={expected:8.1} predicted={got:8.1} err={:+.1}%",
                    if expected > 0.0 {
                        100.0 * (got - expected) / expected
                    } else {
                        f64::INFINITY
                    }
                );
            }
        }
        println!("  polled={polled:.1} flat={flat:.1} taken={taken_gauge:.1} unnamed={unnamed:.1}");
        println!(
            "  per-action |err| total={abs_err:.1} = {:.1}% of captioned skill gauge {truth_total:.1}\n",
            if truth_total > 0.0 {
                100.0 * abs_err / truth_total
            } else {
                0.0
            }
        );
    }

    // The SHIPPED pipeline over the log AS-IS (read gains and all): which
    // ticks it names, and which of those were chain grants — the leftover
    // report and the quantum learner below key off these instead of
    // re-deriving any rule.
    let shipped_verdicts =
        sba_inference::infer_tagged(&events, &|_| true, &aliases, Windows::default());
    let named_ticks: HashSet<(u32, i64)> = shipped_verdicts
        .iter()
        .map(|(gain, _)| (gain.actor_index, gain.at))
        .collect();
    let chain_ticks: HashSet<(u32, i64)> = shipped_verdicts
        .iter()
        .filter(|(gain, _)| gain.cause == SbaGainCause::InferredChainGrant)
        .map(|(gain, _)| (gain.actor_index, gain.at))
        .collect();

    for (index, evidence) in players {
        if evidence.rises.is_empty() {
            continue;
        }
        let polled: f64 = evidence.rises.iter().map(|(_, amount)| amount).sum();
        let read: f64 = evidence.read_gains.iter().map(|(_, amount)| amount).sum();

        // Rise cadence: a synced gauge that arrives in occasional lumps is a
        // different problem from one that ticks with the game.
        let mut gaps: Vec<i64> = evidence
            .rises
            .windows(2)
            .map(|pair| pair[1].0 - pair[0].0)
            .collect();
        gaps.sort_unstable();
        let median_cadence = gaps.get(gaps.len() / 2).copied().unwrap_or(0);

        // Echo count, because "folding changed nothing" has two very different
        // readings: a kit that never echoes, or a window too narrow to have
        // held two candidates in the first place.
        let echo_hits = evidence
            .hits
            .iter()
            .filter(|(_, action)| matches!(action, ActionType::SupplementaryDamage(_)))
            .count();

        println!(
            "player {index:#010x}  rises={} polled={polled:.1} read_gains={} read={read:.1} \
             hits={} (echoes={echo_hits}) median_rise_gap={median_cadence}ms",
            evidence.rises.len(),
            evidence.read_gains.len(),
            evidence.hits.len(),
        );

        let scored: Vec<(i64, f64)> = sba_inference::residuals(
            &evidence.rises,
            &evidence.read_gains,
            Windows::default().poll_lag_ms,
        )
        .into_iter()
        .filter(|(_, residual)| *residual >= MIN_RESIDUAL)
        .collect();
        let unexplained: f64 = scored.iter().map(|(_, amount)| amount).sum();
        println!(
            "  residual after read gains: {unexplained:.1} over {} rises",
            scored.len()
        );

        // How far the unexplained gauge sits from the nearest hit of this
        // actor's. This is the number the move window has to cover.
        let mut nearest: Vec<i64> = scored
            .iter()
            .filter_map(|(at, _)| nearest_hit_gap(&evidence.hits, *at))
            .collect();
        nearest.sort_unstable();
        if !nearest.is_empty() {
            let at = |q: f64| nearest[((nearest.len() - 1) as f64 * q) as usize];
            println!(
                "  nearest own-hit gap: p10={}ms p25={}ms p50={}ms p75={}ms p90={}ms max={}ms",
                at(0.10),
                at(0.25),
                at(0.50),
                at(0.75),
                at(0.90),
                nearest[nearest.len() - 1],
            );
        }

        // The interval a rise actually reports: everything since that slot's
        // PREVIOUS tick. This is the span the residual model itself says the
        // gauge accrued over, so it — not a symmetric window round the tick —
        // is the population a correct rule has to decide from.
        let tick_times: Vec<i64> = evidence.rises.iter().map(|(at, _)| *at).collect();
        let mut distinct: Vec<usize> = Vec::new();
        let (mut interval_none, mut interval_one, mut interval_many) = (0usize, 0usize, 0usize);
        let (mut gauge_one, mut gauge_many) = (0.0, 0.0);
        for (at, residual) in &scored {
            let previous = tick_times
                .iter()
                .filter(|tick| *tick < at)
                .next_back()
                .copied()
                .unwrap_or(i64::MIN);
            let count = evidence
                .hits
                .iter()
                .filter(|(hit_at, _)| *hit_at > previous && hit_at <= at)
                .map(|(_, action)| *action)
                .collect::<HashSet<_>>()
                .len();
            distinct.push(count);
            match count {
                0 => interval_none += 1,
                1 => {
                    interval_one += 1;
                    gauge_one += residual;
                }
                _ => {
                    interval_many += 1;
                    gauge_many += residual;
                }
            }
        }
        distinct.sort_unstable();
        println!(
            "  in-interval distinct actions: p50={} p90={} max={}  |  none={interval_none} \
             one={interval_one} ({gauge_one:.1}) many={interval_many} ({gauge_many:.1})",
            distinct.get(distinct.len() / 2).copied().unwrap_or(0),
            distinct
                .get((distinct.len() as f64 * 0.9) as usize)
                .copied()
                .unwrap_or(0),
            distinct.last().copied().unwrap_or(0),
        );

        // What the SHIPPED pipeline actually leaves behind: the residual ticks
        // its own run verdicts nothing for — read straight off `infer_tagged`'s
        // output rather than re-deriving any rule. This is the band the SBA
        // tab shows as unattributed, and the only thing worth explaining
        // further.
        let leftover: Vec<(i64, f64)> = scored
            .iter()
            .copied()
            .filter(|(at, _)| !named_ticks.contains(&(index, *at)))
            .collect();
        let leftover_gauge: f64 = leftover.iter().map(|(_, amount)| amount).sum();
        println!(
            "  UNNAMED by the shipped rules: {leftover_gauge:.1} over {} rises",
            leftover.len()
        );

        // Do the leftovers cluster on exact VALUES? A flat award has one size,
        // and the chain grant is already named that way — any other repeated
        // exact value is another award waiting to be recognised.
        let mut by_value: HashMap<u64, (usize, f64)> = HashMap::new();
        for (_, amount) in &leftover {
            let entry = by_value.entry((amount * 100.0).round() as u64).or_default();
            entry.0 += 1;
            entry.1 += amount;
        }
        let mut values: Vec<_> = by_value.into_iter().collect();
        values.sort_by(|a, b| b.1 .1.partial_cmp(&a.1 .1).unwrap());
        let top: Vec<String> = values
            .iter()
            .take(6)
            .map(|(value, (count, total))| {
                format!("{:.2}x{count} ({total:.0})", *value as f64 / 100.0)
            })
            .collect();
        println!(
            "    top leftover values: {}  [{} distinct]",
            top.join("  "),
            values.len()
        );

        // Does another slot rise at the same instant with the same amount? That
        // is what a party-wide broadcast looks like from here, and the local
        // slot's copy of it is captioned by the hook.
        let mut simultaneous = 0usize;
        let mut simultaneous_gauge = 0.0;
        let mut witnessed = 0usize;
        let mut witnessed_gauge = 0.0;
        for (at, amount) in &leftover {
            let twin = all_rises
                .iter()
                .any(|(other_at, other_index, other_amount)| {
                    *other_index != index
                        && (other_at - at).abs() <= 50
                        && (other_amount - amount).abs() < 0.01
                });
            if twin {
                simultaneous += 1;
                simultaneous_gauge += amount;
            }
            // A captioned gain on ANY other slot within the same instant: the
            // hook saw a cause, just not for this player.
            if captioned.iter().any(|(gain_at, gain_index, _, _)| {
                *gain_index != index && (gain_at - at).abs() <= 50
            }) {
                witnessed += 1;
                witnessed_gauge += amount;
            }
        }
        println!(
            "    of those: {simultaneous} ({simultaneous_gauge:.1}) match another slot's rise \
             exactly; {witnessed} ({witnessed_gauge:.1}) coincide with a captioned gain elsewhere"
        );

        // THE experiment. Learn each action's per-hit quantum from this
        // player's OWN unambiguous rises — an interval holding N hits of one
        // action says that action grants amount/N — then try to reconstruct
        // every OTHER rise as the sum of its interval's hits at those quanta.
        //
        // If that reconstructs the lumps, the remaining gauge is recoverable
        // without any new hook: the log already contains what it costs. If it
        // does not, the rise is not a sum of per-hit grants and no splitting
        // rule can be right.
        let interval_hits = |at: i64| -> Vec<ActionType> {
            let previous = evidence
                .rises
                .iter()
                .map(|(rise_at, _)| *rise_at)
                .filter(|rise_at| *rise_at < at)
                .next_back()
                .unwrap_or(i64::MIN);
            evidence
                .hits
                .iter()
                .filter(|(hit_at, _)| *hit_at > previous && *hit_at <= at)
                .map(|(_, action)| *action)
                .collect()
        };

        let mut learned: HashMap<ActionType, Vec<f64>> = HashMap::new();
        for (at, residual) in &scored {
            // A tick the pipeline read as a chain grant is a flat award, not a
            // per-hit quantum to learn from.
            if chain_ticks.contains(&(index, *at)) {
                continue;
            }
            let hits = interval_hits(*at);
            let distinct: HashSet<ActionType> = hits.iter().map(|a| folded(*a)).collect();
            if distinct.len() == 1 && !hits.is_empty() {
                let action = *distinct.iter().next().unwrap();
                learned
                    .entry(action)
                    .or_default()
                    .push(residual / hits.len() as f64);
            }
        }
        // Only trust a quantum the samples agree on.
        let quanta: HashMap<ActionType, f64> = learned
            .iter()
            .filter_map(|(action, samples)| {
                let min = samples.iter().cloned().fold(f64::INFINITY, f64::min);
                let max = samples.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
                let mean = samples.iter().sum::<f64>() / samples.len() as f64;
                (max - min <= mean.abs() * 0.05).then_some((*action, mean))
            })
            .collect();

        let (mut rebuilt, mut rebuilt_gauge, mut short, mut uncovered) =
            (0usize, 0.0, 0usize, 0usize);
        for (at, amount) in &leftover {
            let hits = interval_hits(*at);
            if hits.is_empty() {
                uncovered += 1;
                continue;
            }
            if hits.iter().any(|a| !quanta.contains_key(&folded(*a))) {
                short += 1;
                continue;
            }
            let predicted: f64 = hits.iter().map(|a| quanta[&folded(*a)]).sum();
            if (predicted - amount).abs() <= amount * 0.05 {
                rebuilt += 1;
                rebuilt_gauge += amount;
            }
        }
        println!(
            "    reconstruction: learned {} quanta from own rises; {rebuilt} of {} leftovers \
             rebuilt to ±5% ({rebuilt_gauge:.1} gauge); {short} had an unlearned action; \
             {uncovered} had no hit in their interval",
            quanta.len(),
            leftover.len(),
        );

        // A control for the coincidence figure above. The local slot gains
        // almost continuously, so "a captioned gain was within 50 ms" may be
        // nothing but the base rate — shifting the same rises 5 s later measures
        // exactly that, and only the gap between the two numbers is signal.
        let mut control = 0usize;
        for (at, _) in &leftover {
            if captioned.iter().any(|(gain_at, gain_index, _, _)| {
                *gain_index != index && (gain_at - (at + 5_000)).abs() <= 50
            }) {
                control += 1;
            }
        }
        println!("    control (same rises shifted +5s): {control} coincide");

        // The biggest individual leftovers, with their context. An aggregate
        // cannot say what a single 30%-of-the-bar rise WAS, and that is the
        // question a per-move model has to answer first.
        let mut biggest = leftover.clone();
        biggest.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
        for (at, amount) in biggest.iter().take(4) {
            let offset = at - start;
            let mut near: Vec<String> = evidence
                .hits
                .iter()
                .filter(|(hit_at, _)| (hit_at - at).abs() <= 1_000)
                .map(|(hit_at, action)| format!("{:?}@{:+}ms", action, hit_at - at))
                .collect();
            near.truncate(6);
            let taken_near = evidence
                .taken
                .iter()
                .filter(|taken_at| (*taken_at - at).abs() <= 1_000)
                .count();
            let previous_rise = evidence
                .rises
                .iter()
                .filter(|(rise_at, _)| rise_at < at)
                .next_back()
                .map(|(rise_at, _)| at - rise_at)
                .unwrap_or(-1);
            println!(
                "    leftover {amount:8.2} at t={:.1}s (since prev rise {previous_rise}ms, \
                 taken±1s {taken_near}): {}",
                offset as f64 / 1000.0,
                if near.is_empty() {
                    "no own hit within 1s".to_string()
                } else {
                    near.join(" ")
                }
            );
        }

        // How far the leftovers sit from ANY hit of their own — separating "the
        // window is too tight" from "no action of theirs is anywhere near".
        let mut leftover_gaps: Vec<i64> = leftover
            .iter()
            .filter_map(|(at, _)| nearest_hit_gap(&evidence.hits, *at))
            .collect();
        leftover_gaps.sort_unstable();
        if !leftover_gaps.is_empty() {
            let at = |q: f64| leftover_gaps[((leftover_gaps.len() - 1) as f64 * q) as usize];
            println!(
                "    leftover nearest own-hit gap: p25={}ms p50={}ms p75={}ms p90={}ms max={}ms",
                at(0.25),
                at(0.50),
                at(0.75),
                at(0.90),
                leftover_gaps[leftover_gaps.len() - 1],
            );
        }

        // The sweep — the RETIRED sole-action rule, kept only to compare the
        // shipped share formula against its predecessor. Named = exactly one
        // distinct action in the window; ambiguous = two or more (evidence
        // exists but does not decide); empty = no hit at all in reach. What
        // the SHIPPED pipeline leaves unnamed is the leftover figure above,
        // not any row of this table.
        for (window, fold) in SWEEP.into_iter().flat_map(|w| [(w, false), (w, true)]) {
            let (mut named, mut named_gauge) = (0usize, 0.0);
            let (mut ambiguous, mut ambiguous_gauge) = (0usize, 0.0);
            let (mut empty, mut empty_gauge) = (0usize, 0.0);
            for (at, residual) in &scored {
                match actions_near(&evidence.hits, *at, window, fold) {
                    0 => {
                        empty += 1;
                        empty_gauge += residual;
                    }
                    1 => {
                        named += 1;
                        named_gauge += residual;
                    }
                    _ => {
                        ambiguous += 1;
                        ambiguous_gauge += residual;
                    }
                }
            }
            let share = if unexplained > 0.0 {
                100.0 * named_gauge / unexplained
            } else {
                0.0
            };
            let marker = match (window, fold) {
                (64, false) => " <- retired rule @ shipped window",
                _ => "",
            };
            let echoes = if fold { "echo-folded" } else { "raw        " };
            println!(
                "  move={window:>4}ms {echoes}  named={named:>3} ({named_gauge:>7.1}, {share:>4.0}% of residual)  \
                 ambiguous={ambiguous:>3} ({ambiguous_gauge:>7.1})  no-hit={empty:>3} ({empty_gauge:>7.1}){marker}"
            );
        }
        println!();
    }

    Ok(())
}
