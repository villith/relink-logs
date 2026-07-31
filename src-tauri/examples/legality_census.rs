//! Legality-rule calibration census over a real `logs.db`.
//!
//! Diagnostic for tuning the legality rules against production data: runs the
//! CURRENT rules per player and, independently, probes the raw equipment data
//! for each candidate rule so a threshold or whitelist can be chosen from
//! evidence rather than assumption.
//!
//! Run: cargo run -p gbfr-logs --example legality_census -- --db <path-to-logs.db>

use std::collections::BTreeMap;
use std::path::PathBuf;

use anyhow::{Context, Result};
use rusqlite::{Connection, OpenFlags};

// The rule data is imported, never restated: this tool exists to calibrate
// those rules against production data, so a local copy that drifted would
// report a clean census for a list nobody is enforcing.
use gbfr_logs::legality::sigils::{QUEST_LOCKED_TRAITS, SINGLE_TRAIT_SIGILS};
use gbfr_logs::legality::{self, is_empty};

fn main() -> Result<()> {
    let mut db_path = PathBuf::from("src-tauri/logs.db");
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => db_path = args.next().context("--db needs a path")?.into(),
            other => anyhow::bail!("unknown arg: {other}"),
        }
    }

    let locked_pairs = legality::sigils::locked_pairs();
    println!("locked-pair table: {} sigils", locked_pairs.len());

    let conn = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mut stmt = conn.prepare("SELECT id, version, data FROM logs ORDER BY id")?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, u64>(0)?,
            row.get::<_, u8>(1)?,
            row.get::<_, Vec<u8>>(2)?,
        ))
    })?;

    let mut logs = 0usize;
    let mut skipped = 0usize;
    let mut player_encounters = 0usize;

    // Current rules: per player-name, per rule, finding count.
    let mut current: BTreeMap<String, BTreeMap<String, usize>> = BTreeMap::new();

    // Probe A: crab traits per (trait, sigil, slot) with counts.
    let mut crab_seen: BTreeMap<String, usize> = BTreeMap::new();
    // Probe B: locked-pair sigils with a mismatched trait, per player.
    let mut pair_mismatch: BTreeMap<String, usize> = BTreeMap::new();
    let mut pair_ok = 0usize;
    // Probe C: stout heart with a second trait.
    let mut stout_second: BTreeMap<String, usize> = BTreeMap::new();
    let mut stout_ok = 0usize;
    // Probe D: two-trait sigils with a level above the per-sigil ceiling.
    let mut two_trait_over: BTreeMap<String, usize> = BTreeMap::new();
    // Probe F: zero-probability summon configs (off-lot trait, off-window
    // level). Only the off-lot half is a rule; the level half measures the
    // noise that keeps levels unjudged.
    let mut summon_zero: BTreeMap<String, usize> = BTreeMap::new();
    let mut summon_checked = 0usize;
    // Probe G: "perfect" summons per player — main trait AND bonus both at
    // the TOP of their level windows in the summon's own lots. Records each
    // player's maximum count in any single encounter, to measure how common
    // multi-perfect equipped sets are among real players (the question the
    // removed SummonPerfect/Count odds rules hinged on). Conservative: a
    // bonus from the parallel id set (not in this summon's own lot) does not
    // count as perfect.
    let mut perfect_max: BTreeMap<String, usize> = BTreeMap::new();

    let sigil_table = legality::sigils::stock_sigils();

    for row in rows {
        let (_id, version, blob) = row?;
        logs += 1;
        let parser = match gbfr_logs::parser::deserialize_version(&blob, version) {
            Ok(parser) => parser,
            Err(_) => {
                skipped += 1;
                continue;
            }
        };

        for player in parser.encounter.player_data.iter().flatten() {
            player_encounters += 1;
            let name = player.display_name().to_string();
            let inputs = player.legality_inputs();

            // Current rules, over the inputs already built above.
            for finding in legality::audit(&inputs) {
                *current
                    .entry(name.clone())
                    .or_default()
                    .entry(format!("{:?}", finding.rule))
                    .or_default() += 1;
            }

            for sigil in &inputs.sigils {
                if is_empty(sigil.sigil_id) {
                    continue;
                }
                // Probe A.
                for (slot, trait_id) in [(1, sigil.first_trait_id), (2, sigil.second_trait_id)] {
                    if QUEST_LOCKED_TRAITS.contains(&trait_id) {
                        *crab_seen
                            .entry(format!(
                                "trait {trait_id:08x} on sigil {:08x} slot {slot} ({name})",
                                sigil.sigil_id
                            ))
                            .or_default() += 1;
                    }
                }
                // Probe B.
                if let Some(&(t1, t2)) = locked_pairs.get(&sigil.sigil_id) {
                    let bad_first = !is_empty(sigil.first_trait_id) && sigil.first_trait_id != t1;
                    let bad_second =
                        !is_empty(sigil.second_trait_id) && sigil.second_trait_id != t2;
                    if bad_first || bad_second {
                        *pair_mismatch
                            .entry(format!(
                                "sigil {:08x} t1 {:08x} t2 {:08x} (expect {t1:08x}/{t2:08x}) ({name})",
                                sigil.sigil_id, sigil.first_trait_id, sigil.second_trait_id
                            ))
                            .or_default() += 1;
                    } else {
                        pair_ok += 1;
                    }
                }
                // Probe C.
                if SINGLE_TRAIT_SIGILS.contains(&sigil.sigil_id) {
                    if is_empty(sigil.second_trait_id) {
                        stout_ok += 1;
                    } else {
                        *stout_second
                            .entry(format!(
                                "sigil {:08x} t2 {:08x} ({name})",
                                sigil.sigil_id, sigil.second_trait_id
                            ))
                            .or_default() += 1;
                    }
                }
                // Probe D.
                if !is_empty(sigil.first_trait_id) && !is_empty(sigil.second_trait_id) {
                    let ceiling = sigil_table
                        .get(&sigil.sigil_id)
                        .map_or(15, |entry| entry.max_level);
                    for level in [sigil.first_trait_level, sigil.second_trait_level] {
                        if level > ceiling {
                            *two_trait_over
                                .entry(format!(
                                    "sigil {:08x} lvl {level} > {ceiling} ({name})",
                                    sigil.sigil_id
                                ))
                                .or_default() += 1;
                        }
                    }
                }
            }

            // Probe G: top-of-window on BOTH sides of every known summon.
            // `top_level` is the same primitive `perfect_config_odds` judges
            // with, so this probe measures the shipped rule rather than a
            // look-alike of it (an off-lot id is not a candidate, so it is
            // never `Some`).
            let is_top = |lot: &legality::summons::Lot, id: u32, level: u32| {
                lot.top_level(id) == Some(level)
            };
            let perfect = inputs
                .summons
                .iter()
                .filter(|summon| {
                    legality::summons::stock_summons()
                        .get(&summon.summon_id)
                        .is_some_and(|entry| {
                            is_top(
                                &entry.main_traits,
                                summon.main_trait_id,
                                summon.main_trait_level,
                            ) && is_top(&entry.bonuses, summon.bonus_id, summon.bonus_level)
                        })
                })
                .count();
            let max = perfect_max.entry(name.clone()).or_default();
            *max = (*max).max(perfect);

            // Probe F: for every known summon, is the carried (trait, level)
            // a zero-probability outcome per the chances table?
            for summon in &inputs.summons {
                let Some(entry) = legality::summons::stock_summons().get(&summon.summon_id) else {
                    continue;
                };
                summon_checked += 1;
                for (side, id, level) in [
                    ("main", summon.main_trait_id, summon.main_trait_level),
                    ("bonus", summon.bonus_id, summon.bonus_level),
                ] {
                    if is_empty(id) {
                        *summon_zero
                            .entry(format!(
                                "summon {:08x} {side} EMPTY id {id:08x} ({name})",
                                summon.summon_id
                            ))
                            .or_default() += 1;
                        continue;
                    }
                    let lot = if side == "main" {
                        &entry.main_traits
                    } else {
                        &entry.bonuses
                    };
                    match lot.level_weight(id, level) {
                        None => {
                            *summon_zero
                                .entry(format!(
                                    "summon {:08x} {side} trait {id:08x} NOT A CANDIDATE ({name})",
                                    summon.summon_id
                                ))
                                .or_default() += 1;
                        }
                        Some(0) => {
                            *summon_zero
                                .entry(format!(
                                    "summon {:08x} {side} trait {id:08x} lvl {level} ZERO WEIGHT ({name})",
                                    summon.summon_id
                                ))
                                .or_default() += 1;
                        }
                        Some(_) => {}
                    }
                }
            }
        }
    }

    println!("logs {logs}, skipped {skipped}, player-encounters {player_encounters}");

    println!("\n== current rules, findings per player (rule: count) ==");
    for (name, rules) in &current {
        let total: usize = rules.values().sum();
        println!("{name}: {total}");
        for (rule, count) in rules {
            println!("    {rule}: {count}");
        }
    }

    println!("\n== probe A: crab traits observed ==");
    for (line, count) in &crab_seen {
        println!("{count}x {line}");
    }
    println!("\n== probe B: locked-pair mismatches (ok: {pair_ok}) ==");
    for (line, count) in &pair_mismatch {
        println!("{count}x {line}");
    }
    println!("\n== probe C: stout heart second traits (ok: {stout_ok}) ==");
    for (line, count) in &stout_second {
        println!("{count}x {line}");
    }
    println!("\n== probe D: two-trait sigils above per-sigil ceiling ==");
    for (line, count) in &two_trait_over {
        println!("{count}x {line}");
    }
    println!("\n== probe F: zero-probability summon configs (checked: {summon_checked}) ==");
    for (line, count) in &summon_zero {
        println!("{count}x {line}");
    }

    println!("\n== probe G: perfect (top-of-window both sides) summons per player ==");
    let players = perfect_max.len();
    for threshold in 1..=4 {
        let at_least = perfect_max.values().filter(|&&n| n >= threshold).count();
        println!("players with >= {threshold} perfect summons equipped: {at_least} of {players}");
    }
    for (name, count) in perfect_max.iter().filter(|(_, &n)| n >= 2) {
        println!("    {name}: {count}");
    }

    Ok(())
}
