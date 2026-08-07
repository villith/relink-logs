//! Diagnostic: dump every breakdown row of a stored log after a fresh reparse,
//! flagging the ones that carry NO hits — the shape an SBA-gain-created orphan
//! row takes (gauge, no damage, no hits).
//!
//! `--coverage` prints, per player, how much of their generated gauge the
//! skill rows and cause sources explain — the accounting the SBA cause
//! attribution work is judged by (baseline before it: 58-69% explained).
//!
//! Run: cargo run -p gbfr-logs --example sba_rows -- [--db <path>] [--log <id>] [--coverage]

use std::path::PathBuf;

use anyhow::{Context, Result};
use gbfr_logs::parser::v1::Parser;
use rusqlite::{Connection, OpenFlags};

fn main() -> Result<()> {
    let mut db_path = PathBuf::from("src-tauri/logs.db");
    let mut log_id: Option<i64> = None;
    let mut coverage = false;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => db_path = args.next().context("--db needs a path")?.into(),
            "--log" => log_id = Some(args.next().context("--log needs an id")?.parse()?),
            "--coverage" => coverage = true,
            other => anyhow::bail!("unknown arg: {other}"),
        }
    }

    let conn = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let id: i64 = match log_id {
        Some(id) => id,
        None => conn.query_row("SELECT MAX(id) FROM logs", [], |row| row.get(0))?,
    };

    let (when, blob): (String, Vec<u8>) = conn.query_row(
        "SELECT datetime(time/1000,'unixepoch','localtime'), data FROM logs WHERE id = ?",
        [id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;

    let mut parser = Parser::from_encounter_blob(&blob)?;
    parser.reparse();

    println!("log {id} ({when})\n");

    if coverage {
        for (index, player) in &parser.derived_state.party {
            let by_skill: f64 = player
                .skill_breakdown
                .iter()
                .map(|skill| skill.sba_generated)
                .sum();
            let by_cause: f64 = player.sba_sources.iter().map(|s| s.generated).sum();
            let total = player.sba_generated;
            let residual = (total - by_skill - by_cause).max(0.0);
            println!(
                "player {index:#010x} {:?} generated={total:.1} skill={by_skill:.1} \
                 cause={by_cause:.1} residual={residual:.1} ({:.0}% explained)",
                player.character_type,
                if total > 0.0 {
                    100.0 * (by_skill + by_cause) / total
                } else {
                    0.0
                }
            );
            for source in &player.sba_sources {
                println!(
                    "    {:?} id={:?} {:.1}",
                    source.kind, source.id, source.generated
                );
            }
        }
        return Ok(());
    }

    for (index, player) in &parser.derived_state.party {
        println!(
            "player {index:#010x} {:?}  damage={} sba_generated={:.1} rows={}",
            player.character_type,
            player.total_damage,
            player.sba_generated,
            player.skill_breakdown.len()
        );

        let mut rows: Vec<_> = player.skill_breakdown.iter().collect();
        rows.sort_by_key(|row| std::cmp::Reverse(row.total_damage));
        for row in rows {
            let flag = if row.hits == 0 { "  <-- NO HITS" } else { "" };
            println!(
                "    {:?} {:?}  hits={} dmg={} sba={:.1}{flag}",
                row.child_character_type,
                row.action_type,
                row.hits,
                row.total_damage,
                row.sba_generated,
            );
        }
        println!();
    }

    Ok(())
}
