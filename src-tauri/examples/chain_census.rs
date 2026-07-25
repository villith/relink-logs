//! Diagnostic: per-log counts of the SBA-chain lifecycle messages, so it is
//! visible whether `OnContinueSBAChain` (the game's "your SBA joined an active
//! chain" callback — the chain-burst signal) still fires after a game patch.
//!
//!   cargo run -p gbfr-logs --example chain_census -- [--db <path>]

use std::path::PathBuf;

use anyhow::{Context, Result};
use gbfr_logs::parser::v1::Encounter;
use protocol::Message;
use rusqlite::Connection;

fn main() -> Result<()> {
    let mut db_path = PathBuf::from("src-tauri/logs.db");
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => db_path = args.next().context("--db needs a path")?.into(),
            other => anyhow::bail!("unknown arg: {other}"),
        }
    }

    let conn = Connection::open(&db_path)?;
    let mut stmt = conn.prepare("SELECT id, time, data FROM logs ORDER BY id")?;
    let rows: Vec<(i64, i64, Vec<u8>)> = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Vec<u8>>(2)?,
            ))
        })?
        .collect::<Result<_, _>>()?;

    println!(
        "{:>6} {:>14} {:>8} {:>8} {:>8} {:>8}",
        "log", "time", "attempt", "perform", "continue", "summon"
    );
    for (id, time, blob) in &rows {
        let mut encounter = match Encounter::from_blob(blob) {
            Ok(e) => e,
            Err(_) => continue,
        };
        encounter.repopulate_event_log();
        let (mut attempt, mut perform, mut cont, mut summon) = (0, 0, 0, 0);
        for (_, event) in encounter.event_log() {
            match event {
                Message::OnAttemptSBA(_) => attempt += 1,
                Message::OnPerformSBA(_) => perform += 1,
                Message::OnContinueSBAChain(_) => cont += 1,
                Message::DamageEvent(d)
                    if d.action_id == protocol::ActionType::Normal(80000) =>
                {
                    summon += 1
                }
                _ => {}
            }
        }
        if attempt + perform + cont + summon == 0 {
            continue;
        }
        println!("{id:>6} {time:>14} {attempt:>8} {perform:>8} {cont:>8} {summon:>8}");
    }
    Ok(())
}
