//! Diagnostic: validate per-skill stun-message
//! attribution against stored logs.
//!
//! Two oracles, both per skill row after a fresh reparse:
//!   1. Loopback agreement — wherever BOTH capture paths fired (solo loopback),
//!      `stun_delta_sum` (exact: rides the damage event) and `stun_message_sum`
//!      (correlated) must agree per row. Misattribution moves message stun
//!      between rows while deltas stay put.
//!   2. Per-hit constancy — a skill's stun per hit is a build-determined
//!      constant, so `stun_message_sum / hits` should be tight per row and
//!      match the same skill's offline delta per hit.
//!
//! Run: cargo run -p gbfr-logs --example stun_attrib -- [--since <id>] [--log <id>]
//!
//! `--compare` mode is the cross-mode oracle: per (character, action) it puts
//! the LOCAL player's offline delta/hit (exact attribution by construction)
//! next to their online msg/hit (correlated attribution). Same build ⇒ the
//! per-hit constants must match; misattribution smears stun across rows and
//! breaks the agreement. Mixed-mode logs (offline-conversion tails: BOTH sums
//! nonzero over different time segments) are excluded — their per-hit ratios
//! are diluted by the other segment's hits, not evidence of misattribution.

use std::collections::BTreeMap;
use std::path::PathBuf;

use anyhow::{Context, Result};
use gbfr_logs::parser::v1::Parser;
use protocol::{ActionType, Message};
use rusqlite::Connection;

#[derive(Default)]
struct ModeAgg {
    stun: f64,
    hits: u64,
    logs: u64,
}

/// Sort values and group into clusters growing by at most 2% per step (ramp
/// drift within a cluster is continuous; a different constant sits far away).
/// Returns (min, max, count) per cluster.
fn cluster(mut vals: Vec<f32>) -> Vec<(f32, f32, u32)> {
    vals.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let mut clusters: Vec<(f32, f32, u32)> = Vec::new();
    for v in vals {
        match clusters.last_mut() {
            Some((_, max, n)) if v <= *max * 1.02 => {
                *max = v.max(*max);
                *n += 1;
            }
            _ => clusters.push((v, v, 1)),
        }
    }
    clusters
}

fn fmt_clusters(clusters: &[(f32, f32, u32)]) -> String {
    clusters
        .iter()
        .map(|(min, max, n)| {
            if (max - min) < 0.001 {
                format!("{min:.3}x{n}")
            } else {
                format!("{min:.3}..{max:.3}x{n}")
            }
        })
        .collect::<Vec<_>>()
        .join("  ")
}

/// The non-circular back-to-back attribution auditor.
///
/// Baseline: every pure-OFFLINE log since `baseline_since` gives the local
/// player's exact per-skill stun constants (the delta path rides the damage
/// event — attribution there is exact by construction). Audit: replay the
/// online log's temporal attribution and check each message amount against the
/// attributed skill's baseline constant. An amount that instead fits a
/// DIFFERENT skill's constant is precisely a back-to-back misattribution.
fn audit(db_path: &PathBuf, online_id: i64, baseline_since: i64) -> Result<()> {
    const LOCAL_KEY: u32 = 0xF000_0000;

    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare("SELECT id, data FROM logs WHERE id >= ? ORDER BY id")?;
    let rows = stmt.query_map([baseline_since.min(online_id)], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
    })?;

    // (char_hash, action) -> offline nonzero per-hit deltas
    let mut baseline: BTreeMap<(u32, String), Vec<f32>> = BTreeMap::new();
    let mut online_blob: Option<Vec<u8>> = None;

    for row in rows {
        let (id, blob) = row?;
        if id == online_id {
            online_blob = Some(blob);
            continue;
        }
        if id < baseline_since {
            continue;
        }
        let Ok(parser) = Parser::from_encounter_blob(&blob) else {
            continue;
        };
        // Pure-offline check: no stun messages anywhere in the log.
        let has_messages = parser
            .encounter
            .event_log()
            .any(|(_, e)| matches!(e, Message::OnPlayerStun(_)));
        if has_messages {
            continue;
        }
        for (_, event) in parser.encounter.event_log() {
            if let Message::DamageEvent(e) = event {
                if e.source.parent_index != LOCAL_KEY {
                    continue;
                }
                if let Some(stun) = e.stun_value {
                    if stun > 0.0 {
                        baseline
                            .entry((e.source.parent_actor_type, format!("{:?}", e.action_id)))
                            .or_default()
                            .push(stun);
                    }
                }
            }
        }
    }

    // Skills can be MULTI-PART (several per-part weights, e.g. Normal(1310)
    // offline: 14.64/17.08/24.4/109.8/164.7) and offline samples also carry
    // ramp states. Keep every cluster with >=2 samples as a candidate weight;
    // the primary (largest) cluster anchors the ramp-ladder measurement.
    let mut weights: BTreeMap<(u32, String), Vec<f32>> = BTreeMap::new();
    let mut primary: BTreeMap<(u32, String), f32> = BTreeMap::new();
    println!("=== OFFLINE baseline constants (local player, exact attribution) ===");
    for ((char_hash, action), vals) in &baseline {
        let n = vals.len();
        let clusters = cluster(vals.clone());
        let ws: Vec<f32> = clusters
            .iter()
            .filter(|(_, _, cn)| *cn >= 2)
            .map(|(min, _, _)| *min)
            .collect();
        if let Some((min, _, _)) = clusters.iter().max_by_key(|(_, _, cn)| *cn) {
            primary.insert((*char_hash, action.clone()), *min);
        }
        if !ws.is_empty() {
            weights.insert((*char_hash, action.clone()), ws);
        }
        println!(
            "  {char_hash:#010x} {action:<24} n={n:<5} clusters: {}",
            fmt_clusters(&clusters)
        );
    }

    // Replay the online log's temporal attribution and audit each message.
    let blob = online_blob.context("online log id not found")?;
    let parser = Parser::from_encounter_blob(&blob)?;
    let mut last_action: Option<(u32, String)> = None;
    let mut verdicts: BTreeMap<&'static str, u32> = BTreeMap::new();
    let mut details: Vec<String> = Vec::new();
    let mut messages: Vec<(u32, String, f32)> = Vec::new();
    for (_, event) in parser.encounter.event_log() {
        match event {
            Message::DamageEvent(e) if e.source.parent_index == LOCAL_KEY => {
                if !matches!(
                    e.action_id,
                    protocol::ActionType::SupplementaryDamage(_)
                        | protocol::ActionType::DamageOverTime(_)
                ) {
                    last_action = Some((e.source.parent_actor_type, format!("{:?}", e.action_id)));
                }
            }
            Message::OnPlayerStun(e) if e.actor_index == LOCAL_KEY => {
                let Some((char_hash, action)) = &last_action else {
                    *verdicts.entry("no-prior-action").or_default() += 1;
                    continue;
                };
                messages.push((char_hash.to_owned(), action.clone(), e.stun_amount));
            }
            _ => {}
        }
    }

    // Pass 1: the ramp ladder. m = amount / base(attributed skill); the ramp is
    // TARGET-side state shared by every skill and player, so real multipliers
    // form a small discrete set. Clusters of m with >=3 samples are the ladder;
    // an m off the ladder means the amount doesn't belong to the attributed
    // skill (a misattribution can also FAKE an on-ladder m when two skills'
    // constants happen to sit a ladder-step apart — this audit is a lower
    // bound, the burst test remains the definitive check).
    let ratios: Vec<f32> = messages
        .iter()
        .filter_map(|(ch, a, amount)| {
            primary
                .get(&(*ch, a.clone()))
                .map(|base| amount / base)
        })
        .filter(|m| (0.5..=4.0).contains(m))
        .collect();
    let ladder: Vec<(f32, f32, u32)> = cluster(ratios)
        .into_iter()
        .filter(|(_, _, n)| *n >= 3)
        .collect();
    println!("=== ONLINE log {online_id} — measured ramp ladder (m clusters, n>=3) ===");
    println!("  {}", fmt_clusters(&ladder));
    let on_ladder =
        |m: f32| -> bool { ladder.iter().any(|(min, max, _)| m >= min * 0.98 && m <= max * 1.02) };

    // Pass 2: verdict per message. A skill fits when ANY of its offline
    // weights w gives an on-ladder multiplier amount/w.
    let fits_skill = |ws: &[f32], amount: f32| -> Option<f32> {
        ws.iter().map(|w| amount / w).find(|m| on_ladder(*m))
    };
    for (char_hash, action, amount) in &messages {
        let attributed_ws = weights.get(&(*char_hash, action.clone()));
        let attributed_fit = attributed_ws.and_then(|ws| fits_skill(ws, *amount));
        let alternatives: Vec<(String, f32)> = weights
            .iter()
            .filter(|((ch, a), _)| ch == char_hash && a != action)
            .filter_map(|((_, a), ws)| fits_skill(ws, *amount).map(|m| (a.clone(), m)))
            .collect();
        match (attributed_ws, attributed_fit, alternatives.is_empty()) {
            (None, _, _) => *verdicts.entry("no baseline for attributed skill").or_default() += 1,
            (Some(_), Some(_), _) => *verdicts.entry("consistent").or_default() += 1,
            (Some(_), None, false) => {
                *verdicts.entry("MISATTRIBUTED-likely").or_default() += 1;
                details.push(format!(
                    "  amount={amount:.3} attributed={action} (fits no weight); fits: {}",
                    alternatives
                        .iter()
                        .map(|(a, m)| format!("{a}@x{m:.2}"))
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
            }
            (Some(_), None, true) => {
                *verdicts.entry("unknown (fits nothing)").or_default() += 1;
                details.push(format!(
                    "  amount={amount:.3} attributed={action} (fits nothing baselined)"
                ));
            }
        }
    }

    println!("=== verdicts ===");
    for (verdict, n) in &verdicts {
        println!("  {verdict}: {n}");
    }
    for d in &details {
        println!("{d}");
    }
    Ok(())
}

fn main() -> Result<()> {
    let mut db_path = PathBuf::from("src-tauri/logs.db");
    let mut since_id = 0i64;
    let mut only_log: Option<i64> = None;
    let mut compare = false;
    let mut amounts = false;
    let mut audit_log: Option<i64> = None;
    let mut baseline_since = 470i64;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => db_path = args.next().context("--db needs a path")?.into(),
            "--since" => since_id = args.next().context("--since needs an id")?.parse()?,
            "--log" => only_log = Some(args.next().context("--log needs an id")?.parse()?),
            "--compare" => compare = true,
            "--amounts" => amounts = true,
            "--audit" => audit_log = Some(args.next().context("--audit needs a log id")?.parse()?),
            "--baseline-since" => {
                baseline_since = args.next().context("--baseline-since needs an id")?.parse()?
            }
            other => anyhow::bail!("unknown arg: {other}"),
        }
    }

    if let Some(online_id) = audit_log {
        return audit(&db_path, online_id, baseline_since);
    }

    // (character, action-json) -> [offline agg, online agg], local player only.
    let mut cross: BTreeMap<(String, String), [ModeAgg; 2]> = BTreeMap::new();
    const LOCAL_SLOT_KEY: &str = "4026531840"; // 0xF0000000 = party slot 0

    let conn = Connection::open(&db_path)?;
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

    for row in rows {
        let (id, time, blob) = row?;
        if only_log.is_some_and(|only| only != id) {
            continue;
        }
        let mut parser = match Parser::from_encounter_blob(&blob) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("warn: log {id}: {e}");
                continue;
            }
        };
        parser.reparse();

        if amounts {
            // Replay the raw event log with the SAME attribution rule the parser
            // uses and collect per-row raw message amounts. A correct row shows
            // ONE base constant (plus slow upward ramp drift); a foreign cluster
            // (another skill's constant) = quantified misattribution.
            let mut last_action: BTreeMap<u32, ActionType> = BTreeMap::new();
            let mut row_amounts: BTreeMap<(u32, String), Vec<f32>> = BTreeMap::new();
            let mut unattributed: BTreeMap<u32, u32> = BTreeMap::new();
            for (_, event) in parser.encounter.event_log() {
                match event {
                    Message::DamageEvent(e) => {
                        if !matches!(
                            e.action_id,
                            ActionType::SupplementaryDamage(_) | ActionType::DamageOverTime(_)
                        ) {
                            last_action.insert(e.source.parent_index, e.action_id);
                        }
                    }
                    Message::OnPlayerStun(e) => match last_action.get(&e.actor_index) {
                        Some(action) => row_amounts
                            .entry((e.actor_index, format!("{action:?}")))
                            .or_default()
                            .push(e.stun_amount),
                        None => *unattributed.entry(e.actor_index).or_default() += 1,
                    },
                    _ => {}
                }
            }
            if row_amounts.is_empty() {
                continue;
            }
            println!("=== log {id} ({time}) — per-row raw message amounts");
            // Equipped Stun Power per slot: predicts each player's base unit —
            // every raw message amount should be a multiple of
            // base_stun(ability) × (1 + stun_power).
            for (i, slot) in parser.encounter.player_data.iter().enumerate() {
                if let Some(p) = slot {
                    let v = serde_json::to_value(p)?;
                    println!(
                        "  slot{i} actor_index={} char={} stats={} playerStats={}",
                        v["actorIndex"],
                        v["characterType"],
                        v["stats"],
                        v["playerStats"],
                    );
                }
            }
            for ((player, action), mut vals) in row_amounts {
                vals.sort_by(|a, b| a.partial_cmp(b).unwrap());
                // Cluster: group values within 2% of the cluster's start value
                // (ramp drift within a cluster is continuous; a foreign skill's
                // constant sits far away).
                let mut clusters: Vec<(f32, f32, u32)> = Vec::new(); // (min, max, n)
                for v in &vals {
                    match clusters.last_mut() {
                        Some((min, max, n)) if *v <= *max * 1.02 => {
                            *max = v.max(*max);
                            *n += 1;
                            let _ = min;
                        }
                        _ => clusters.push((*v, *v, 1)),
                    }
                }
                let cluster_str: Vec<String> = clusters
                    .iter()
                    .map(|(min, max, n)| {
                        if (max - min) < 0.001 {
                            format!("{min:.3}x{n}")
                        } else {
                            format!("{min:.3}..{max:.3}x{n}")
                        }
                    })
                    .collect();
                println!(
                    "  {player} {action:<28} n={:<4} clusters: {}",
                    vals.len(),
                    cluster_str.join("  ")
                );
            }
            for (player, n) in unattributed {
                println!("  {player} <no prior action> n={n}");
            }
            continue;
        }

        let state = serde_json::to_value(&parser.derived_state)?;
        let enc_delta = state["stunDeltaSum"].as_f64().unwrap_or(0.0);
        let enc_msg = state["stunMessageSum"].as_f64().unwrap_or(0.0);
        if enc_delta == 0.0 && enc_msg == 0.0 {
            continue; // no stun data at all — nothing to validate
        }
        let mode = match (enc_delta > 0.0, enc_msg > 0.0) {
            (true, true) => "MIXED (offline-conversion tail; per-hit ratios diluted, excluded from compare)",
            (true, false) => "delta-only (offline)",
            (false, true) => "message-only (online shape)",
            _ => unreachable!(),
        };

        if compare {
            // Pure-mode logs only; local player only (same build across sessions).
            let mode_idx = match (enc_delta > 0.0, enc_msg > 0.0) {
                (true, false) => 0usize,
                (false, true) => 1usize,
                _ => continue,
            };
            let Some(player) = state["party"].get(LOCAL_SLOT_KEY) else {
                continue;
            };
            let char_type = player["characterType"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| player["characterType"].to_string());
            let Some(skills) = player["skillBreakdown"].as_array() else {
                continue;
            };
            for skill in skills {
                let stun = if mode_idx == 0 {
                    skill["stunDeltaSum"].as_f64().unwrap_or(0.0)
                } else {
                    skill["stunMessageSum"].as_f64().unwrap_or(0.0)
                };
                let hits = skill["hits"].as_u64().unwrap_or(0);
                if hits == 0 {
                    continue;
                }
                let agg = &mut cross
                    .entry((char_type.clone(), skill["actionType"].to_string()))
                    .or_insert_with(Default::default)[mode_idx];
                agg.stun += stun;
                agg.hits += hits;
                agg.logs += 1;
            }
            continue;
        }

        println!("=== log {id} ({time}) — {mode}: enc delta={enc_delta:.1} msg={enc_msg:.1}");

        let Some(party) = state["party"].as_object() else {
            continue;
        };
        for (slot_key, player) in party {
            let char_type = player["characterType"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| player["characterType"].to_string());
            let p_delta = player["stunDeltaSum"].as_f64().unwrap_or(0.0);
            let p_msg = player["stunMessageSum"].as_f64().unwrap_or(0.0);
            if p_delta == 0.0 && p_msg == 0.0 {
                continue;
            }
            println!("  player {slot_key} ({char_type}): delta={p_delta:.1} msg={p_msg:.1}");

            let Some(skills) = player["skillBreakdown"].as_array() else {
                continue;
            };
            for skill in skills {
                let delta = skill["stunDeltaSum"].as_f64().unwrap_or(0.0);
                let msg = skill["stunMessageSum"].as_f64().unwrap_or(0.0);
                if delta == 0.0 && msg == 0.0 {
                    continue;
                }
                let hits = skill["hits"].as_u64().unwrap_or(0).max(1);
                let action = skill["actionType"].to_string();
                let verdict = if delta > 0.0 && msg > 0.0 {
                    let ratio = msg / delta;
                    if (0.95..=1.05).contains(&ratio) {
                        "OK (paths agree)"
                    } else {
                        "MISMATCH <-- attribution suspect"
                    }
                } else {
                    "single-path"
                };
                println!(
                    "    {action:<40} hits={hits:<4} delta={delta:>9.2} msg={msg:>9.2} \
                     delta/hit={:>7.3} msg/hit={:>7.3}  {verdict}",
                    delta / hits as f64,
                    msg / hits as f64,
                );
            }
        }
    }

    if compare {
        println!(
            "=== cross-mode per-hit stun, LOCAL player (slot 0) — offline delta (exact) vs \
             online attributed messages ==="
        );
        println!(
            "{:<10} {:<24} {:>14} {:>14} {:>7}",
            "char", "action", "off/hit(n)", "on/hit(n)", "ratio"
        );
        for ((char_type, action), [off, on]) in &cross {
            if off.hits == 0 || on.hits == 0 {
                continue;
            }
            let off_per_hit = off.stun / off.hits as f64;
            let on_per_hit = on.stun / on.hits as f64;
            if off_per_hit == 0.0 && on_per_hit == 0.0 {
                continue;
            }
            let ratio = if off_per_hit > 0.0 {
                on_per_hit / off_per_hit
            } else {
                f64::INFINITY
            };
            println!(
                "{:<10} {:<24} {:>9.3}({:<4}) {:>9.3}({:<4}) {:>7.2}",
                char_type, action, off_per_hit, off.hits, on_per_hit, on.hits, ratio
            );
        }
    }

    Ok(())
}
