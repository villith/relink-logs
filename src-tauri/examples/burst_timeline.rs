//! Diagnostic: print the raw timeline around every action-80000 (summon /
//! primal burst) hit in a logs.db — SBA lifecycle messages included — so the
//! chain that produced the burst is visible.
//!
//!   cargo run -p gbfr-logs --example burst_timeline -- [--db <path>] [--before <ms>] [--after <ms>]

use std::path::PathBuf;

use anyhow::{Context, Result};
use gbfr_logs::parser::constants::CharacterType;
use gbfr_logs::parser::v1::Encounter;
use protocol::{ActionType, Message};
use rusqlite::Connection;

const SUMMON_ACTION: u32 = 80000;

fn main() -> Result<()> {
    let mut db_path = PathBuf::from("src-tauri/logs.db");
    let mut before: i64 = 25000;
    let mut after: i64 = 6000;
    // What to centre each window on: the summon hits, or the game's own
    // "SBA chain continues" callback (the chain-burst signal).
    let mut anchor = String::from("summon");

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => db_path = args.next().context("--db needs a path")?.into(),
            "--before" => before = args.next().context("--before needs ms")?.parse()?,
            "--after" => after = args.next().context("--after needs ms")?.parse()?,
            "--anchor" => anchor = args.next().context("--anchor needs summon|chain")?,
            other => anyhow::bail!("unknown arg: {other}"),
        }
    }

    let conn = Connection::open(&db_path)?;
    let mut stmt = conn.prepare("SELECT id, data FROM logs ORDER BY id")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
    })?;

    for row in rows {
        let (log_id, blob) = row?;
        let mut encounter = match Encounter::from_blob(&blob) {
            Ok(e) => e,
            Err(_) => continue,
        };
        encounter.repopulate_event_log();
        let events: Vec<(i64, Message)> = encounter.event_log().cloned().collect();

        // Windows: anchor events grouped by 5s idle gaps.
        let mut bursts: Vec<(i64, i64)> = Vec::new();
        for (ts, event) in &events {
            let is_anchor = match (anchor.as_str(), event) {
                ("summon", Message::DamageEvent(dmg)) => {
                    dmg.action_id == ActionType::Normal(SUMMON_ACTION)
                }
                ("chain", Message::OnContinueSBAChain(_)) => true,
                _ => false,
            };
            if !is_anchor {
                continue;
            }
            match bursts.last_mut() {
                Some((_, end)) if *ts - *end <= 5000 => *end = *ts,
                _ => bursts.push((*ts, *ts)),
            }
        }
        if bursts.is_empty() {
            continue;
        }

        for (start, end) in &bursts {
            println!("\n=== log {log_id} burst {start}..{end} ===");
            let mut last_line: Option<(String, i64, usize, i64)> = None;
            for (ts, event) in &events {
                if *ts < start - before || *ts > end + after {
                    continue;
                }
                let line = match event {
                    Message::DamageEvent(dmg) => format!(
                        "{:<28} src={} ({:08x}) parent={} idx={} pidx={}",
                        format!("{:?}", dmg.action_id),
                        CharacterType::from_hash(dmg.source.actor_type),
                        dmg.source.actor_type,
                        CharacterType::from_hash(dmg.source.parent_actor_type),
                        dmg.source.index,
                        dmg.source.parent_index,
                    ),
                    Message::OnPerformSBA(e) => format!(">> OnPerformSBA actor={:#x}", e.actor_index),
                    Message::OnAttemptSBA(e) => format!(">> OnAttemptSBA actor={:#x}", e.actor_index),
                    Message::OnContinueSBAChain(e) => {
                        format!(">> OnContinueSBAChain actor={:#x}", e.actor_index)
                    }
                    Message::OnUpdateSBA(_) => continue,
                    other => format!("-- {other:?}"),
                };
                let damage = match event {
                    Message::DamageEvent(dmg) => dmg.damage as i64,
                    _ => 0,
                };
                // Collapse runs of identical lines into one row with a hit count.
                match &mut last_line {
                    Some((prev, first_ts, count, dmg_total)) if *prev == line => {
                        *count += 1;
                        *dmg_total += damage;
                        let _ = first_ts;
                    }
                    _ => {
                        if let Some((prev, first_ts, count, dmg_total)) = last_line.take() {
                            print_row(*start, first_ts, &prev, count, dmg_total);
                        }
                        last_line = Some((line, *ts, 1, damage));
                    }
                }
            }
            if let Some((prev, first_ts, count, dmg_total)) = last_line.take() {
                print_row(*start, first_ts, &prev, count, dmg_total);
            }
        }
    }

    Ok(())
}

fn print_row(burst_start: i64, ts: i64, line: &str, count: usize, damage: i64) {
    let rel = ts - burst_start;
    if damage == 0 && count == 1 {
        println!("  {rel:>+7}ms  {line}");
    } else {
        println!("  {rel:>+7}ms  {line}  x{count} dmg={damage}");
    }
}
