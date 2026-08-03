//! TEMPORARY diagnostic (delete after use): the shape of every equipped-summon
//! reading in a real logs.db, judged against the summon's NAME-union pools —
//! the same pools `legality::summons` accuses with.
//!
//! Answers three questions the bonus probe leaves open:
//!   1. Which readings would the SHIPPED rules flag, and how many distinct
//!      players do they belong to?
//!   2. Do in-lot bonuses sit BELOW their candidate's level window on builds
//!      nobody suspects — i.e. does the table's window describe reality?
//!   3. Do main traits land on summons whose name-union cannot grant them?
//!
//! Run: cargo run -p gbfr-logs --example legality_summon_shape -- --db <logs.db>

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use anyhow::{Context, Result};
use rusqlite::{Connection, OpenFlags};

use gbfr_logs::legality::summons::stock_summons;
use gbfr_logs::legality::{audit, is_empty, Rule, Subject};

fn main() -> Result<()> {
    let mut db_path = PathBuf::from("src-tauri/logs.db");
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => db_path = args.next().context("--db needs a path")?.into(),
            other => anyhow::bail!("unknown arg: {other}"),
        }
    }

    let conn = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mut stmt = conn.prepare("SELECT id, version, data FROM logs ORDER BY id")?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, u64>(0)?,
            row.get::<_, u8>(1)?,
            row.get::<_, Vec<u8>>(2)?,
        ))
    })?;

    let table = stock_summons();

    // What the SHIPPED rules say, by rule, keyed on the config that provoked it.
    let mut fired: BTreeMap<String, (usize, BTreeSet<String>, Vec<u64>)> = BTreeMap::new();
    // In-lot bonuses sitting below their candidate's window: the honest-noise
    // case the module docs cite as the reason levels are never judged.
    let mut below: BTreeMap<String, (usize, BTreeSet<String>, Vec<u64>)> = BTreeMap::new();
    // Level histogram per (summon, bonus) for the two Stout Heart summons.
    let mut behemoth_levels: BTreeMap<String, BTreeMap<u32, usize>> = BTreeMap::new();
    let mut readings = 0usize;

    for row in rows {
        let (log_id, version, blob) = row?;
        let Ok(parser) = gbfr_logs::parser::deserialize_version(&blob, version) else {
            continue;
        };

        for player in parser.encounter.player_data.iter().flatten() {
            let name = player.display_name().to_string();
            let inputs = player.legality_inputs();

            for finding in audit(&inputs) {
                let Subject::Summon(index) = finding.subject else {
                    continue;
                };
                if !matches!(
                    finding.rule,
                    Rule::SummonTrait | Rule::SummonBonusSource | Rule::SummonBonusMagnitude
                ) {
                    continue;
                }
                let summon = &inputs.summons[index];
                let key = format!(
                    "{:?} | summon {:08x} main {:08x} lvl {} | bonus {:08x} lvl {}",
                    finding.rule,
                    summon.summon_id,
                    summon.main_trait_id,
                    summon.main_trait_level,
                    summon.bonus_id,
                    summon.bonus_level
                );
                let slot = fired.entry(key).or_default();
                slot.0 += 1;
                slot.1.insert(name.clone());
                if slot.2.len() < 4 {
                    slot.2.push(log_id);
                }
            }

            for summon in &inputs.summons {
                if is_empty(summon.bonus_id) {
                    continue;
                }
                readings += 1;
                let Some(entry) = table.get(&summon.summon_id) else {
                    continue;
                };
                // Behemoth III / Vrazarek Firewyrm III, the two Stout Heart
                // summons — the reported case's family.
                if matches!(summon.summon_id, 0xe4b7_dcf9 | 0xf2be_819e) {
                    *behemoth_levels
                        .entry(format!(
                            "{:08x} bonus {:08x}",
                            summon.summon_id, summon.bonus_id
                        ))
                        .or_default()
                        .entry(summon.bonus_level)
                        .or_default() += 1;
                }
                if entry
                    .bonuses
                    .level_weight(summon.bonus_id, summon.bonus_level)
                    == Some(0)
                    && entry
                        .bonuses
                        .top_level(summon.bonus_id)
                        .is_some_and(|top| summon.bonus_level < top)
                {
                    let key = format!(
                        "summon {:08x} bonus {:08x} lvl {}",
                        summon.summon_id, summon.bonus_id, summon.bonus_level
                    );
                    let slot = below.entry(key).or_default();
                    slot.0 += 1;
                    slot.1.insert(name.clone());
                    if slot.2.len() < 4 {
                        slot.2.push(log_id);
                    }
                }
            }
        }
    }

    println!("summon readings with a bonus: {readings}\n");
    println!(
        "SHIPPED summon rules firing ({} distinct configs):",
        fired.len()
    );
    for (key, (count, players, logs)) in &fired {
        println!("  {count:4}x  {key}\n         players {players:?} logs {logs:?}");
    }

    println!(
        "\nin-lot bonuses BELOW their window ({} distinct):",
        below.len()
    );
    for (key, (count, players, logs)) in &below {
        println!("  {count:4}x  {key}  players {players:?} logs {logs:?}");
    }

    println!("\nStout Heart summons — bonus level histogram (own window is 6-9):");
    for (key, levels) in &behemoth_levels {
        println!("  {key}  {levels:?}");
    }

    Ok(())
}
