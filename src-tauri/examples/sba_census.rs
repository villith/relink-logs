//! Diagnostic: per-log timeline of every SBA-related event (attempt, perform,
//! chain-continue, SBA-typed damage), so the derived SBA windows' open/close
//! rule can be checked against what real fights actually record.
//!
//!   cargo run -p gbfr-logs --example sba_census -- [--db <path>] [--recent <n>] [--id <logId>]

use std::path::PathBuf;

use anyhow::{Context, Result};
use gbfr_logs::parser::v1::{assemble_chart_windows, ChartWindowKind, Encounter};
use protocol::{ActionType, Message};
use rusqlite::{Connection, OpenFlags};

fn main() -> Result<()> {
    let mut db_path = PathBuf::from("src-tauri/logs.db");
    let mut recent: usize = 10;
    let mut only_id: Option<i64> = None;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => db_path = args.next().context("--db needs a path")?.into(),
            "--recent" => recent = args.next().context("--recent needs a count")?.parse()?,
            "--id" => only_id = Some(args.next().context("--id needs a log id")?.parse()?),
            other => anyhow::bail!("unknown arg: {other}"),
        }
    }

    let conn = Connection::open_with_flags(&db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mut stmt = conn.prepare(
        "SELECT id, datetime(time/1000,'unixepoch','localtime'), data \
         FROM logs WHERE (?1 IS NULL OR id = ?1) ORDER BY id DESC LIMIT ?2",
    )?;
    let rows = stmt.query_map(rusqlite::params![only_id, recent as i64], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Vec<u8>>(2)?,
        ))
    })?;

    for row in rows {
        let (id, when, blob) = row?;
        let mut encounter = match Encounter::from_blob(&blob) {
            Ok(encounter) => encounter,
            Err(e) => {
                println!("log {id} ({when}): unreadable: {e}");
                continue;
            }
        };
        encounter.repopulate_event_log();
        let events: Vec<_> = encounter.event_log().collect();
        let Some((start, _)) = events.first() else {
            println!("log {id} ({when}): empty");
            continue;
        };
        let start = *start;
        let end = events.last().map(|(ts, _)| ts - start).unwrap_or(0);
        println!(
            "== log {id} ({when}) duration={:.1}s events={}",
            end as f64 / 1000.0,
            events.len()
        );

        // The first damage event anchors "the fight actually started".
        let first_damage = events
            .iter()
            .find(|(_, m)| matches!(m, Message::DamageEvent(_)))
            .map(|(ts, _)| ts - start);
        println!("   first_damage_at={first_damage:?}ms");

        // What the analysis chart will actually shade.
        let owned: Vec<(i64, Message)> = events.iter().map(|(ts, m)| (*ts, (*m).clone())).collect();
        for w in assemble_chart_windows(&owned, start, end) {
            if w.kind == ChartWindowKind::Sba {
                println!(
                    "   WINDOW  {:>8}ms -> {:>8}ms  ({:.1}s)",
                    w.start_ms,
                    w.end_ms,
                    (w.end_ms - w.start_ms) as f64 / 1000.0
                );
            }
        }

        for (ts, message) in &events {
            let at = ts - start;
            match message {
                Message::OnAttemptSBA(e) => {
                    println!("   {at:>8}ms  attempt   actor={:#x}", e.actor_index);
                }
                Message::OnPerformSBA(e) => {
                    println!("   {at:>8}ms  PERFORM   actor={:#x}", e.actor_index);
                }
                Message::OnContinueSBAChain(e) => {
                    println!("   {at:>8}ms  CHAIN     actor={:#x}", e.actor_index);
                }
                Message::DamageEvent(e) if e.action_id == ActionType::SBA => {
                    println!(
                        "   {at:>8}ms  SBA-DMG   actor={:#x} dmg={}",
                        e.source.parent_index, e.damage
                    );
                }
                _ => {}
            }
        }
    }

    Ok(())
}
