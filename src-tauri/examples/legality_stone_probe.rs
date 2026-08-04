//! Diagnostic: would a wrightstone TRAIT-MEMBERSHIP rule accuse honest players?
//!
//! `legality::wrightstone` judges only levels today, on the explicit reasoning
//! that the transmarvel gacha configs "say nothing about stones from other
//! sources". The user has asked for a membership rule, so the question this
//! answers is the calibration one: how many traits on real, stored stones fall
//! outside the pool the gacha configs can produce, and are they concentrated in
//! a few builds (signal) or spread across the whole database (a table that does
//! not cover every stone)?
//!
//! Run: cargo run -p gbfr-logs --example legality_stone_probe -- --db <logs.db>

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::PathBuf;

use anyhow::{Context, Result};
use rusqlite::{Connection, OpenFlags};

use gbfr_logs::legality::is_empty;
use gbfr_logs::transmarvel;

/// Every trait the gacha configs can put on a stone: the four family primaries
/// plus everything reachable through each config's `type_row`, plus any slot
/// the config fixes outright.
fn gacha_pool() -> HashSet<u32> {
    let tables = transmarvel::stock_tables();
    let mut pool = HashSet::new();

    for config in tables.stone_configs.values() {
        pool.insert(config.trait1);

        if let Some(options) = tables.skill_type_rows.get(&config.type_row) {
            for &(lot_hash, _weight) in options {
                if let Some(traits) = tables.skill_lots.get(&lot_hash) {
                    pool.extend(traits.iter().copied());
                }
            }
        }

        for slot in &config.slots {
            if slot.skill != 0 {
                pool.insert(slot.skill);
            }
        }
    }

    pool
}

fn main() -> Result<()> {
    let mut db_path = PathBuf::from("src-tauri/logs.db");
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => db_path = args.next().context("--db needs a path")?.into(),
            other => anyhow::bail!("unknown arg: {other}"),
        }
    }

    let pool = gacha_pool();
    println!("gacha pool: {} traits", pool.len());

    let conn = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mut stmt = conn.prepare("SELECT id, version, data FROM logs ORDER BY id")?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, u64>(0)?,
            row.get::<_, u8>(1)?,
            row.get::<_, Vec<u8>>(2)?,
        ))
    })?;

    // Off-pool trait -> (sightings, the players carrying it).
    let mut off_pool: BTreeMap<u32, (usize, BTreeSet<String>)> = BTreeMap::new();
    let mut off_pool_players: BTreeSet<String> = BTreeSet::new();
    let mut all_players: BTreeSet<String> = BTreeSet::new();
    let mut readings = 0usize;
    let mut in_pool = 0usize;
    let mut logs = 0usize;
    let mut skipped = 0usize;
    let mut partial = 0usize;

    for row in rows {
        let (_log_id, version, blob) = row?;
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
            all_players.insert(name.clone());

            let Some(state) = player.legality_inputs().weapon_state else {
                continue;
            };
            // The level rule's own guard: fewer than three pairs is a partial
            // remote read, never a shorter stone.
            if state.wrightstone_traits.len() != 3 {
                partial += 1;
                continue;
            }

            for pair in &state.wrightstone_traits {
                if is_empty(pair.id) {
                    continue;
                }
                readings += 1;
                if pool.contains(&pair.id) {
                    in_pool += 1;
                } else {
                    let entry = off_pool.entry(pair.id).or_default();
                    entry.0 += 1;
                    entry.1.insert(name.clone());
                    off_pool_players.insert(name.clone());
                }
            }
        }
    }

    println!("logs: {logs} (skipped {skipped}), partial stone reads: {partial}");
    println!(
        "trait readings: {readings} — {in_pool} in pool, {} off",
        readings - in_pool
    );
    println!(
        "players: {} total, {} carrying an off-pool trait",
        all_players.len(),
        off_pool_players.len()
    );
    println!("\noff-pool traits, most-seen first:");

    let mut ranked: Vec<_> = off_pool.into_iter().collect();
    ranked.sort_by_key(|(_, (count, _))| std::cmp::Reverse(*count));
    for (trait_id, (count, players)) in ranked {
        let names: Vec<&str> = players.iter().map(String::as_str).take(6).collect();
        println!(
            "  {trait_id:08x}  {count:>5} sightings  {:>3} players  {}",
            players.len(),
            names.join(", ")
        );
    }

    Ok(())
}
