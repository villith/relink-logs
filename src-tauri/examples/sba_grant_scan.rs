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

use std::collections::HashMap;
use std::path::PathBuf;

use anyhow::{Context, Result};
use gbfr_logs::parser::constants::CharacterType;
use gbfr_logs::parser::v1::sba_inference::{self, authored_hit_weight};
use gbfr_logs::parser::v1::Encounter;
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

fn main() -> Result<()> {
    let mut db_path = PathBuf::from("src-tauri/logs.db");
    let mut targets: Vec<u32> = vec![9995, 9999, 80000, 175, u32::MAX];
    let mut verbose = false;
    let mut dump_log: Option<i64> = None;

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
            other => anyhow::bail!("unknown arg: {other}"),
        }
    }

    if let Some(id) = dump_log {
        return dump_one_log(&db_path, id);
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
