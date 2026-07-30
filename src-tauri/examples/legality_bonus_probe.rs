//! Diagnostic: is a summon equip bonus from OUTSIDE that summon's own lots
//! ever seen on a build nobody suspects?
//!
//! `legality::summons` currently accepts any real bonus id on any summon,
//! citing production sightings of "Behemoth III with the boss-set Healing Cap
//! Up". Eleven of the 22 bonus ids are granted by exactly four summons
//! (Rolan / Lucilius / Beelzebub / Lilith) and carry much higher magnitudes,
//! so if those sightings all belong to one player the relaxation is hiding a
//! real signal rather than protecting honest builds.
//!
//! Run: cargo run -p gbfr-logs --example legality_bonus_probe -- --db <logs.db>

use std::collections::BTreeMap;
use std::path::PathBuf;

use anyhow::{Context, Result};
use rusqlite::{Connection, OpenFlags};

use gbfr_logs::legality::is_empty;
use gbfr_logs::legality::summons::stock_summons;

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

    // Off-lot bonus sightings: (player, summon id, bonus id, level) -> count,
    // plus the logs it was seen in.
    let mut off_lot: BTreeMap<String, (usize, Vec<u64>)> = BTreeMap::new();
    let mut per_player: BTreeMap<String, usize> = BTreeMap::new();
    let mut above_window: BTreeMap<String, (usize, Vec<u64>)> = BTreeMap::new();
    let mut below_window = 0usize;
    let mut in_lot = 0usize;
    let mut logs = 0usize;
    let mut skipped = 0usize;

    for row in rows {
        let (log_id, version, blob) = row?;
        logs += 1;
        let parser = match gbfr_logs::parser::deserialize_version(&blob, version) {
            Ok(parser) => parser,
            Err(_) => {
                skipped += 1;
                continue;
            }
        };

        for player in parser.encounter.player_data.iter().flatten() {
            let name = player.display_name().to_string();
            for summon in &player.legality_inputs().summons {
                if is_empty(summon.bonus_id) {
                    continue;
                }
                let Some(entry) = table.get(&summon.summon_id) else {
                    continue;
                };
                if let Some(top) = entry.bonuses.top_level(summon.bonus_id) {
                    in_lot += 1;
                    // Levels are deliberately unjudged because BELOW-window
                    // reads occur on honest builds. Above-window is the
                    // separate question a magnitude rule would rest on.
                    if summon.bonus_level > top {
                        let key = format!(
                            "{name} | summon {:08x} | bonus {:08x} lvl {} > top {top}",
                            summon.summon_id, summon.bonus_id, summon.bonus_level
                        );
                        let slot = above_window.entry(key).or_insert((0, Vec::new()));
                        slot.0 += 1;
                        if slot.1.len() < 5 {
                            slot.1.push(log_id);
                        }
                    } else if entry
                        .bonuses
                        .level_weight(summon.bonus_id, summon.bonus_level)
                        == Some(0)
                    {
                        below_window += 1;
                    }
                    continue;
                }
                let key = format!(
                    "{name} | summon {:08x} | bonus {:08x} lvl {}",
                    summon.summon_id, summon.bonus_id, summon.bonus_level
                );
                let slot = off_lot.entry(key).or_insert((0, Vec::new()));
                slot.0 += 1;
                if slot.1.len() < 5 {
                    slot.1.push(log_id);
                }
                *per_player.entry(name.clone()).or_default() += 1;
            }
        }
    }

    println!("logs {logs} (skipped {skipped}); bonuses in their summon's own lot: {in_lot}");
    println!("\noff-lot bonus sightings by player:");
    for (name, count) in &per_player {
        println!("  {count:6}  {name}");
    }
    println!("\ndistinct off-lot configs ({}):", off_lot.len());
    for (key, (count, logs)) in &off_lot {
        println!("  {count:6}x  {key}  (logs {logs:?})");
    }

    println!("\nin-lot bonuses read BELOW their window (known-honest noise): {below_window}");
    println!(
        "in-lot bonuses read ABOVE their window ({} distinct):",
        above_window.len()
    );
    for (key, (count, logs)) in &above_window {
        println!("  {count:6}x  {key}  (logs {logs:?})");
    }

    Ok(())
}
