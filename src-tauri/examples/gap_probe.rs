//! TEMPORARY diagnostic (not for commit): dump the raw event timeline around
//! the largest under-logged intervals a log contains, so the mechanic behind an
//! unexplained HP drop is visible.
//!
//! The damage audit says "45m HP left this boss and we logged 0.9m of it". This
//! answers the next question — what else the game was doing at that instant.
//!
//! Run: cargo run -p gbfr-logs --example gap_probe --features diag -- \
//!          --db <path> [--log <id>] [--top <n>] [--window <ms>]

use std::path::PathBuf;

use anyhow::{Context, Result};
use gbfr_logs::parser::v1::audit::{audit_encounter, AuditOptions, Bucket};
use gbfr_logs::parser::v1::Encounter;
use protocol::{ActionType, Message};
use rusqlite::{Connection, OpenFlags};

fn main() -> Result<()> {
    let mut db_path = PathBuf::from("src-tauri/logs.db");
    let mut only_log: Option<u64> = None;
    let mut top = 3usize;
    let mut window = 1_500i64;
    let mut summary = false;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => db_path = args.next().context("--db needs a path")?.into(),
            "--log" => only_log = Some(args.next().context("--log needs an id")?.parse()?),
            "--top" => top = args.next().context("--top needs a count")?.parse()?,
            "--window" => window = args.next().context("--window needs ms")?.parse()?,
            "--summary" => summary = true,
            other => anyhow::bail!("unknown arg: {other}"),
        }
    }

    let conn = Connection::open_with_flags(&db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let sql = match only_log {
        Some(_) => "SELECT id, data FROM logs WHERE id = ?1",
        None => "SELECT id, data FROM logs ORDER BY id",
    };
    let mut stmt = conn.prepare(sql)?;
    let params: Vec<&dyn rusqlite::ToSql> = match &only_log {
        Some(id) => vec![id],
        None => vec![],
    };
    let rows = stmt.query_map(params.as_slice(), |row| {
        Ok((row.get::<_, u64>(0)?, row.get::<_, Vec<u8>>(1)?))
    })?;

    // Every gap in the corpus, biggest first, so `--top` spends its budget on
    // the events most worth explaining rather than on whichever log sorts first.
    let mut gaps: Vec<(u64, i64, i64, i64, i64)> = Vec::new();
    let mut logs: Vec<(u64, Encounter)> = Vec::new();

    for row in rows {
        let (id, blob) = row?;
        let Ok(mut encounter) = Encounter::from_blob(&blob) else {
            continue;
        };
        encounter.repopulate_event_log();
        let events = &encounter.raw_event_log;
        let Some(start_time) = events.first().map(|(ts, _)| *ts) else {
            continue;
        };

        let audit = audit_encounter(events, start_time, AuditOptions::default());
        for interval in &audit.intervals {
            if interval.bucket == Bucket::UnderLogged && -interval.residual >= 1_000_000 {
                gaps.push((
                    id,
                    interval.start_ms,
                    interval.end_ms,
                    -interval.residual,
                    interval.logged,
                ));
            }
        }
        logs.push((id, encounter));
    }

    gaps.sort_by_key(|(_, _, _, missing, _)| -missing);

    if summary {
        // How long before each gap the target last took SBA-flagged damage. If
        // an unlogged drop is a Chain Burst, this lands on the burst's animation
        // delay every time rather than scattering.
        println!(
            "{:<5} {:>9} {:>14} {:>12}",
            "log", "gap_at_s", "missing", "since_sba_s"
        );
        let mut with_sba = 0usize;
        let mut total = 0usize;
        let mut missing_after_sba = 0i64;
        let mut missing_total = 0i64;

        for (id, start_ms, _, missing, _) in &gaps {
            let (_, encounter) = logs
                .iter()
                .find(|(log_id, _)| log_id == id)
                .expect("gap came from a decoded log");
            let events = &encounter.raw_event_log;
            let base = events.first().map(|(ts, _)| *ts).unwrap_or(0);

            let last_sba = events
                .iter()
                .filter_map(|(ts, message)| match message {
                    Message::DamageEvent(event)
                        if matches!(event.action_id, ActionType::SBA) && ts - base <= *start_ms =>
                    {
                        Some(ts - base)
                    }
                    _ => None,
                })
                .max();

            total += 1;
            missing_total += missing;
            let gap_s = *start_ms as f64 / 1000.0;
            match last_sba {
                Some(sba_ms) => {
                    let delta = (*start_ms - sba_ms) as f64 / 1000.0;
                    if delta <= 8.0 {
                        with_sba += 1;
                        missing_after_sba += missing;
                    }
                    println!(
                        "{id:<5} {gap_s:>9.1} {:>14} {delta:>12.2}",
                        commas(*missing)
                    );
                }
                None => println!("{id:<5} {gap_s:>9.1} {:>14} {:>12}", commas(*missing), "-"),
            }
        }

        println!();
        println!(
            "{with_sba} of {total} gaps follow an SBA within 8s, carrying {} of {} missing HP",
            commas(missing_after_sba),
            commas(missing_total)
        );
        return Ok(());
    }

    for (id, start_ms, end_ms, missing, logged) in gaps.into_iter().take(top) {
        let (_, encounter) = logs
            .iter()
            .find(|(log_id, _)| *log_id == id)
            .expect("gap came from a decoded log");
        let events = &encounter.raw_event_log;
        let base = events.first().map(|(ts, _)| *ts).unwrap_or(0);

        println!("========================================================");
        println!(
            "log {id}  gap {:.2}s..{:.2}s  missing {}  logged {}",
            start_ms as f64 / 1000.0,
            end_ms as f64 / 1000.0,
            commas(missing),
            commas(logged)
        );
        println!("========================================================");

        for (ts, message) in events {
            let rel = ts - base;
            if rel < start_ms - window || rel > end_ms + window {
                continue;
            }
            let inside = rel >= start_ms && rel <= end_ms;
            let marker = if inside { ">>" } else { "  " };
            println!(
                "{marker} {:9.3}s  {}",
                rel as f64 / 1000.0,
                describe(message)
            );
        }
        println!();
    }

    Ok(())
}

/// One line per message: damage events collapse to their attribution, and every
/// non-damage message prints its variant so an SBA or death landing inside the
/// gap is impossible to miss.
fn describe(message: &Message) -> String {
    match message {
        Message::DamageEvent(event) => format!(
            "DMG   src={:08X}/{:08X} tgt={:08X} action={:?} dmg={} flags={:#x} hp={:?}",
            event.source.index,
            event.source.parent_index,
            event.target.index,
            event.action_id,
            commas(event.damage as i64),
            event.flags,
            event.target_current_hp,
        ),
        Message::OnUpdateSBA(e) => format!(
            "SBA-UPDATE     actor={:08X} sba={}",
            e.actor_index, e.sba_value
        ),
        Message::OnAttemptSBA(e) => format!("SBA-ATTEMPT    actor={:08X}", e.actor_index),
        Message::OnPerformSBA(e) => format!("SBA-PERFORM    actor={:08X}", e.actor_index),
        Message::OnContinueSBAChain(e) => {
            format!("SBA-CHAIN      actor={:08X}", e.actor_index)
        }
        Message::OnDeathEvent(e) => format!("DEATH          actor={:08X}", e.actor_index),
        Message::OnPlayerStun(e) => format!(
            "STUN           actor={:08X} {}",
            e.actor_index, e.stun_amount
        ),
        Message::OnAreaEnter(_) => "AREA-ENTER".to_string(),
        Message::OnQuestComplete(_) => "QUEST-COMPLETE".to_string(),
        other => format!("{other:?}"),
    }
}

fn commas(value: i64) -> String {
    let negative = value < 0;
    let digits = value.unsigned_abs().to_string();
    let mut out = String::new();
    for (position, digit) in digits.chars().enumerate() {
        if position > 0 && (digits.len() - position) % 3 == 0 {
            out.push(',');
        }
        out.push(digit);
    }
    if negative {
        format!("-{out}")
    } else {
        out
    }
}
