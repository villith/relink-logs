//! Diagnostic companion to `legality_bonus_probe`: dumps every player's whole
//! equipped summon set for a chosen log, so an off-lot bonus sighting can be
//! checked against the rival explanation — a cross-slot read that copied a
//! LOBBY-MATE's bonus id onto the wrong summon.
//!
//! Run: cargo run -p gbfr-logs --example legality_bonus_context -- --db <logs.db> --log 537

use std::path::PathBuf;

use anyhow::{Context, Result};
use rusqlite::{Connection, OpenFlags};

use gbfr_logs::legality::summons::stock_summons;

fn main() -> Result<()> {
    let mut db_path = PathBuf::from("src-tauri/logs.db");
    let mut log_ids: Vec<u64> = Vec::new();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => db_path = args.next().context("--db needs a path")?.into(),
            "--log" => log_ids.push(args.next().context("--log needs an id")?.parse()?),
            other => anyhow::bail!("unknown arg: {other}"),
        }
    }

    let conn = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let table = stock_summons();

    for log_id in log_ids {
        let (blob, version): (Vec<u8>, u8) = conn
            .prepare("SELECT data, version FROM logs WHERE id = ?")?
            .query_row([log_id], |row| Ok((row.get(0)?, row.get(1)?)))?;
        let parser = gbfr_logs::parser::deserialize_version(&blob, version)?;

        println!("=== log {log_id} ===");
        for player in parser.encounter.player_data.iter().flatten() {
            println!("  player {:?}", player.display_name());
            for summon in &player.legality_inputs().summons {
                let own = table
                    .get(&summon.summon_id)
                    .map(|entry| entry.bonuses.top_level(summon.bonus_id).is_some());
                let mark = match own {
                    Some(true) => "   ",
                    Some(false) => "OFF",
                    None => " ? ",
                };
                println!(
                    "    {mark} summon {:08x}  main {:08x} lvl {:<3}  bonus {:08x} lvl {}",
                    summon.summon_id,
                    summon.main_trait_id,
                    summon.main_trait_level,
                    summon.bonus_id,
                    summon.bonus_level
                );
            }
        }
    }

    Ok(())
}

