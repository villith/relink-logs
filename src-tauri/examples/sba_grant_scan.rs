//! Diagnostic: corpus-measure the authored gauge weight of specific action ids
//! from captioned LOCAL slots — the curation tool for the weight table's
//! synthetic/system ids (summon 80000, ghost 9995, "no action" u32::MAX, and
//! system-spawned skills like Maglielle's 9999) that no game data file prices
//! per character.
//!
//! For every stored log, every slot whose polled gauge is mostly explained by
//! hook-read gains is a captioned local. Within such a slot the fight's K is
//! measured directly (median captioned LinkAttack gain / 5.0, the universal
//! anchor; fallback: median gain/weight over table-priced actions), and every
//! captioned `Skill(Normal(id))` gain on a target id becomes one implied
//! weight sample `gain / K`. Hits on a target id that produced NO captioned
//! grant are counted too — an id whose hits never grant is authored 0.
//!
//! Run: cargo run -p gbfr-logs --release --example sba_grant_scan --
//!      [--db <path>] [--actions <id,id,..>] [--verbose]
//!
//! `--dump-log <id>` instead prints, per slot of that one log, every action's
//! hit count and damage distribution — for identifying WHAT an unknown id
//! physically is (a ghost auto-attack, a proc, a marker) from its damage
//! signature and company.
//!
//! `--taken-lag` instead measures, corpus-wide, how long after a hit the
//! player RECEIVED the hook reads the damage-taken gauge grant — the window
//! the share pipeline's taken-contamination exclusion has to cover.

use std::collections::HashMap;
use std::path::PathBuf;

use anyhow::{Context, Result};
use gbfr_logs::parser::constants::CharacterType;
use gbfr_logs::parser::v1::sba_inference::{self, authored_hit_weight};
use gbfr_logs::parser::v1::{is_damage_taken_event, Encounter};
use protocol::{ActionType, Message, SbaGainCause};
use rusqlite::{Connection, OpenFlags};

/// A slot with at least this much polled gauge is worth classifying at all.
const MIN_POLLED: f64 = 20.0;
/// Read gains explaining at least this fraction of the polled total marks a
/// captioned local slot (matches `sba_share_check`'s LOCAL_READ_FRACTION).
const LOCAL_READ_FRACTION: f64 = 0.5;

#[derive(Default)]
struct Evidence {
    polled: f64,
    read: f64,
    /// Captioned skill gains: (classified action, amount).
    captioned: Vec<(ActionType, f64)>,
    /// Gauge-eligible hits (Normal / LinkAttack) this player dealt.
    hits: Vec<ActionType>,
}

fn median(samples: &mut [f64]) -> Option<f64> {
    if samples.is_empty() {
        return None;
    }
    samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
    Some(samples[samples.len() / 2])
}

/// The fight's K for one captioned slot. LinkAttack is weight 5.0 for every
/// character, so its captioned gains anchor K without touching the table under
/// test; a slot with no link attack falls back to the table-priced actions.
fn slot_k(evidence: &Evidence, character: Option<CharacterType>) -> Option<(f64, &'static str)> {
    let mut link: Vec<f64> = evidence
        .captioned
        .iter()
        .filter(|(action, _)| matches!(action, ActionType::LinkAttack))
        .map(|(_, amount)| amount / 5.0)
        .collect();
    if let Some(k) = median(&mut link) {
        return Some((k, "link"));
    }
    let mut priced: Vec<f64> = evidence
        .captioned
        .iter()
        .filter_map(|(action, amount)| {
            let weight = authored_hit_weight(character, *action)?;
            (weight > 0.0).then(|| amount / weight)
        })
        .collect();
    median(&mut priced).map(|k| (k, "table"))
}

struct Sample {
    log: i64,
    k: f64,
    k_source: &'static str,
    /// Implied weights, one per captioned grant on the target action.
    implied: Vec<f64>,
    /// Hits on the target action in this slot (captioned or not).
    hits: usize,
    grants: usize,
}

/// Per slot of one log: every action's hit count and damage distribution.
fn dump_one_log(db_path: &PathBuf, id: i64) -> Result<()> {
    let conn = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let blob: Vec<u8> = conn.query_row("SELECT data FROM logs WHERE id = ?1", [id], |row| {
        row.get(0)
    })?;
    let mut encounter = Encounter::from_blob(&blob).context("unreadable log")?;
    encounter.repopulate_event_log();
    let aliases = sba_inference::character_aliases(&encounter.player_data);

    // slot → action → damage samples.
    let mut slots: HashMap<u32, HashMap<ActionType, Vec<i64>>> = HashMap::new();
    for (_, event) in encounter.event_log() {
        if let Message::DamageEvent(damage) = event {
            if matches!(
                damage.action_id,
                ActionType::Normal(_) | ActionType::LinkAttack
            ) {
                slots
                    .entry(damage.source.parent_index)
                    .or_default()
                    .entry(damage.action_id)
                    .or_default()
                    .push(i64::from(damage.damage));
            }
        }
    }
    let mut indices: Vec<u32> = slots.keys().copied().collect();
    indices.sort();
    for index in indices {
        let name = aliases
            .get(&index)
            .map_or_else(|| "unknown".into(), |c| c.to_string());
        println!("slot {index:#010x} ({name}):");
        let mut actions: Vec<(&ActionType, &Vec<i64>)> = slots[&index].iter().collect();
        actions.sort_by_key(|(action, _)| format!("{action:?}"));
        for (action, samples) in actions {
            let mut sorted = samples.clone();
            sorted.sort_unstable();
            let total: i64 = sorted.iter().sum();
            println!(
                "  {action:?}: n={} dmg total={total} median={} range=[{}, {}]",
                sorted.len(),
                sorted[sorted.len() / 2],
                sorted.first().unwrap(),
                sorted.last().unwrap(),
            );
        }
    }
    Ok(())
}

/// Corpus-wide: how long after a received hit does the hook read the
/// damage-taken gauge grant? Each `DamageTaken`-captioned gain is matched to
/// the most recent received hit at or before it.
fn scan_taken_lag(db_path: &PathBuf) -> Result<()> {
    let conn = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mut stmt = conn.prepare("SELECT id, data FROM logs ORDER BY id")?;
    let rows: Vec<(i64, Vec<u8>)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<std::result::Result<_, _>>()?;

    let mut deltas: Vec<i64> = Vec::new();
    // Gauge amounts: grants a taken event explains (within the pipeline's
    // 500 ms lookback) vs grants with no visible received hit — the taken
    // contamination the share pipeline cannot exclude.
    let (mut covered_gauge, mut invisible_gauge) = (0.0f64, 0.0f64);
    let mut orphans = 0usize;
    for (_, blob) in rows {
        let Ok(mut encounter) = Encounter::from_blob(&blob) else {
            continue;
        };
        encounter.repopulate_event_log();
        let mut taken: HashMap<u32, Vec<i64>> = HashMap::new();
        let mut gains: HashMap<u32, Vec<(i64, f64)>> = HashMap::new();
        for (timestamp, event) in encounter.event_log() {
            match event {
                Message::DamageEvent(damage) if is_damage_taken_event(damage) => {
                    taken
                        .entry(damage.target.parent_index)
                        .or_default()
                        .push(*timestamp);
                }
                Message::SbaGain(gain) if gain.cause == Some(SbaGainCause::DamageTaken) => {
                    gains
                        .entry(gain.actor_index)
                        .or_default()
                        .push((*timestamp, gain.amount as f64));
                }
                _ => {}
            }
        }
        for (index, gain_samples) in &gains {
            let taken_times = taken.get(index);
            for (gain_at, amount) in gain_samples {
                let delta = taken_times.and_then(|times| {
                    let before = times.partition_point(|at| at <= gain_at);
                    (before > 0).then(|| gain_at - times[before - 1])
                });
                match delta {
                    Some(delta) => {
                        deltas.push(delta);
                        if delta <= 500 {
                            covered_gauge += amount;
                        } else {
                            invisible_gauge += amount;
                        }
                    }
                    None => {
                        orphans += 1;
                        invisible_gauge += amount;
                    }
                }
            }
        }
    }

    deltas.sort_unstable();
    println!(
        "{} damage-taken captioned gains matched to a received hit, {} orphans \
         (no received hit before the gain)",
        deltas.len(),
        orphans
    );
    println!(
        "gauge amounts: {covered_gauge:.1} within 500 ms of a visible received hit, \
         {invisible_gauge:.1} with none ({:.1}% invisible to the taken exclusion)",
        invisible_gauge / (covered_gauge + invisible_gauge).max(f64::MIN_POSITIVE) * 100.0
    );
    if deltas.is_empty() {
        return Ok(());
    }
    for quantile in [0.5, 0.9, 0.95, 0.99, 0.999, 1.0] {
        let idx = ((deltas.len() - 1) as f64 * quantile) as usize;
        println!("  p{:<5} {} ms", quantile * 100.0, deltas[idx]);
    }
    let buckets: [i64; 8] = [0, 16, 32, 64, 128, 250, 500, 1000];
    for window in buckets {
        let within = deltas.partition_point(|delta| *delta <= window);
        println!(
            "  <= {window:>4} ms: {:.2}%",
            within as f64 / deltas.len() as f64 * 100.0
        );
    }
    Ok(())
}

fn main() -> Result<()> {
    let mut db_path = PathBuf::from("src-tauri/logs.db");
    let mut targets: Vec<u32> = vec![9995, 9999, 80000, 175, u32::MAX];
    let mut verbose = false;
    let mut dump_log: Option<i64> = None;
    let mut taken_lag = false;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => db_path = args.next().context("--db needs a path")?.into(),
            "--actions" => {
                targets = args
                    .next()
                    .context("--actions needs a comma-separated id list")?
                    .split(',')
                    .map(|id| id.trim().parse().context("action ids are u32"))
                    .collect::<Result<_>>()?;
            }
            "--verbose" => verbose = true,
            "--dump-log" => {
                dump_log = Some(args.next().context("--dump-log needs an id")?.parse()?)
            }
            "--taken-lag" => taken_lag = true,
            other => anyhow::bail!("unknown arg: {other}"),
        }
    }

    if let Some(id) = dump_log {
        return dump_one_log(&db_path, id);
    }
    if taken_lag {
        return scan_taken_lag(&db_path);
    }

    let conn = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mut stmt = conn.prepare("SELECT id, data FROM logs ORDER BY id")?;
    let rows: Vec<(i64, Vec<u8>)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<std::result::Result<_, _>>()?;

    let mut scanned = 0usize;
    let mut captioned_slots = 0usize;
    // (character, action id) → samples across the corpus.
    let mut by_key: HashMap<(String, u32), Vec<Sample>> = HashMap::new();

    for (id, blob) in rows {
        scanned += 1;
        let Ok(mut encounter) = Encounter::from_blob(&blob) else {
            continue;
        };
        encounter.repopulate_event_log();

        let mut by_player: HashMap<u32, Evidence> = HashMap::new();
        for (_, event) in encounter.event_log() {
            match event {
                Message::OnUpdateSBA(update) if update.sba_added > 0.0 => {
                    by_player.entry(update.actor_index).or_default().polled +=
                        update.sba_added as f64;
                }
                Message::SbaGain(gain) => {
                    let evidence = by_player.entry(gain.actor_index).or_default();
                    evidence.read += gain.amount as f64;
                    if let Some(SbaGainCause::Skill(action)) = gain.cause {
                        evidence.captioned.push((action, gain.amount as f64));
                    }
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
                        .push(damage.action_id);
                }
                _ => {}
            }
        }

        let aliases = sba_inference::character_aliases(&encounter.player_data);
        for (index, evidence) in &by_player {
            if evidence.polled < MIN_POLLED || evidence.read < evidence.polled * LOCAL_READ_FRACTION
            {
                continue;
            }
            captioned_slots += 1;
            let character = aliases.get(index).copied();
            let name = character.map_or_else(|| "unknown".into(), |c| c.to_string());
            let k = slot_k(evidence, character);
            for target in &targets {
                let action = ActionType::Normal(*target);
                let hits = evidence.hits.iter().filter(|hit| **hit == action).count();
                let grants: Vec<f64> = evidence
                    .captioned
                    .iter()
                    .filter_map(|(cause, amount)| (*cause == action).then_some(*amount))
                    .collect();
                if hits == 0 && grants.is_empty() {
                    continue;
                }
                let Some((k, k_source)) = k else {
                    continue;
                };
                by_key
                    .entry((name.clone(), *target))
                    .or_default()
                    .push(Sample {
                        log: id,
                        k,
                        k_source,
                        implied: grants.iter().map(|gain| gain / k).collect(),
                        hits,
                        grants: grants.len(),
                    });
            }
        }
    }

    println!("scanned {scanned} logs, {captioned_slots} captioned local slots");
    let mut keys: Vec<_> = by_key.keys().cloned().collect();
    keys.sort();
    for key in keys {
        let samples = &by_key[&key];
        let (character, action) = &key;
        let hits: usize = samples.iter().map(|sample| sample.hits).sum();
        let grants: usize = samples.iter().map(|sample| sample.grants).sum();
        let mut implied: Vec<f64> = samples
            .iter()
            .flat_map(|sample| sample.implied.iter().copied())
            .collect();
        let med = median(&mut implied);
        println!(
            "{character} action {action}: logs={} hits={hits} grants={grants} implied-w median={} \
             span=[{}, {}]",
            samples.len(),
            med.map_or("-".into(), |w| format!("{w:.4}")),
            implied.first().map_or("-".into(), |w| format!("{w:.4}")),
            implied.last().map_or("-".into(), |w| format!("{w:.4}")),
        );
        if verbose {
            for sample in samples {
                let implied: Vec<String> =
                    sample.implied.iter().map(|w| format!("{w:.4}")).collect();
                println!(
                    "    log {} K={:.4} ({}) hits={} grants={} implied=[{}]",
                    sample.log,
                    sample.k,
                    sample.k_source,
                    sample.hits,
                    sample.grants,
                    implied.join(", ")
                );
            }
        }
    }
    Ok(())
}
