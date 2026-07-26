//! Diagnostic: count every stored message variant across a logs.db, overall and
//! for the newest N logs, so a hook that stopped firing is visible.
//!
//!   cargo run -p gbfr-logs --example msg_census -- [--db <path>] [--recent <n>]

use std::collections::BTreeMap;
use std::path::PathBuf;

use anyhow::{Context, Result};
use gbfr_logs::parser::v1::Encounter;
use protocol::Message;
use rusqlite::Connection;

fn main() -> Result<()> {
    let mut db_path = PathBuf::from("src-tauri/logs.db");
    let mut recent: usize = 40;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => db_path = args.next().context("--db needs a path")?.into(),
            "--recent" => recent = args.next().context("--recent needs a count")?.parse()?,
            other => anyhow::bail!("unknown arg: {other}"),
        }
    }

    let conn = Connection::open(&db_path)?;
    let mut stmt = conn.prepare("SELECT id, data FROM logs ORDER BY id")?;
    let rows: Vec<(i64, Vec<u8>)> = stmt
        .query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
        })?
        .collect::<Result<_, _>>()?;

    let cutoff = rows.len().saturating_sub(recent);
    let mut all: BTreeMap<&'static str, usize> = BTreeMap::new();
    let mut newest: BTreeMap<&'static str, usize> = BTreeMap::new();

    for (i, (_, blob)) in rows.iter().enumerate() {
        let mut encounter = match Encounter::from_blob(blob) {
            Ok(e) => e,
            Err(_) => continue,
        };
        encounter.repopulate_event_log();
        for (_, event) in encounter.event_log() {
            let name = variant(event);
            *all.entry(name).or_default() += 1;
            if i >= cutoff {
                *newest.entry(name).or_default() += 1;
            }
        }
    }

    println!("logs: {} (newest {recent} counted separately)\n", rows.len());
    println!("{:<28} {:>12} {:>12}", "message", "all logs", "newest");
    for (name, count) in &all {
        println!(
            "{name:<28} {count:>12} {:>12}",
            newest.get(name).copied().unwrap_or(0)
        );
    }
    Ok(())
}

fn variant(event: &Message) -> &'static str {
    match event {
        Message::OnAreaEnter(_) => "OnAreaEnter",
        Message::OnQuestComplete(_) => "OnQuestComplete",
        Message::DamageEvent(_) => "DamageEvent",
        Message::OnUpdateSBA(_) => "OnUpdateSBA",
        Message::OnAttemptSBA(_) => "OnAttemptSBA",
        Message::OnPerformSBA(_) => "OnPerformSBA",
        Message::OnContinueSBAChain(_) => "OnContinueSBAChain",
        Message::PlayerLoadEvent(_) => "PlayerLoadEvent",
        Message::OnDeathEvent(_) => "OnDeathEvent",
        Message::PlayerIdentityEvent(_) => "PlayerIdentityEvent",
        Message::ConfluxRoomEnter(_) => "ConfluxRoomEnter",
        Message::ConfluxBuffAcquired(_) => "ConfluxBuffAcquired",
        Message::ConfluxRunEnd(_) => "ConfluxRunEnd",
        Message::OnPlayerStun(_) => "OnPlayerStun",
        Message::OnQuestFail(_) => "OnQuestFail",
        Message::OnPerfectGuardStun(_) => "OnPerfectGuardStun",
        Message::OnPerfectGuardQuickening(_) => "OnPerfectGuardQuickening",
        Message::OnStunEffect(_) => "OnStunEffect",
        Message::OnTrialStart(_) => "OnTrialStart",
        Message::OnTrialEnd(_) => "OnTrialEnd",
        Message::OnQuestElapsedTime(_) => "OnQuestElapsedTime",
    }
}
