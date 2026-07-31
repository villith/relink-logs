//! Diagnostic: what do the CURRENT legality rules say about a real `logs.db`,
//! per player and per rule?
//!
//! The census tool measures candidate rules against raw equipment; this one
//! just reports the verdicts, so a rule change can be checked against the
//! delta it was predicted to produce before it ships.
//!
//! Run: cargo run -p gbfr-logs --example legality_delta -- --db <logs.db>

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use anyhow::{Context, Result};
use rusqlite::{Connection, OpenFlags};

use gbfr_logs::legality;

/// Migrates a copy of a real database, runs the startup sweep over it, and
/// prints what the Toolbox audit page would show — the whole stored path,
/// against production data.
fn run_sweep(db_path: &std::path::Path) -> Result<()> {
    let mut conn = Connection::open(db_path)?;
    gbfr_logs::db::migrations().to_latest(&mut conn)?;

    let outcome = legality::sweep::sweep_stale_logs(&mut conn, |_| ())?;
    println!(
        "sweep: {} logs re-audited, {} unreadable",
        outcome.rescanned, outcome.unreadable
    );

    let repeat = legality::sweep::sweep_stale_logs(&mut conn, |_| ())?;
    println!(
        "second sweep (should be a no-op): {} re-audited, {} unreadable\n",
        repeat.rescanned, repeat.unreadable
    );

    for player in gbfr_logs::db::legality::flagged_players(&conn)? {
        println!(
            "[{}]  {}  {} encounter(s), {} finding(s)",
            player.character_type,
            player.display_name,
            player.encounters,
            player.findings.len()
        );
        for row in &player.findings {
            println!("      {:?}  log {}", row.finding.rule, row.log_id);
        }
    }

    Ok(())
}

fn main() -> Result<()> {
    let mut db_path = PathBuf::from("src-tauri/logs.db");
    let mut sweep = false;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => db_path = args.next().context("--db needs a path")?.into(),
            // Exercises the STORED path end to end instead of auditing in
            // memory: migrate, sweep, then read back what the audit page would
            // show. Writes to the database, so point it at a copy.
            "--sweep" => sweep = true,
            other => anyhow::bail!("unknown arg: {other}"),
        }
    }

    if sweep {
        return run_sweep(&db_path);
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

    // player -> rule/severity -> (count, the logs it was seen in)
    let mut by_player: BTreeMap<String, BTreeMap<String, (usize, BTreeSet<u64>)>> = BTreeMap::new();
    let mut by_rule: BTreeMap<String, usize> = BTreeMap::new();
    let mut logs = 0usize;
    let mut skipped = 0usize;
    let mut seen_players: BTreeSet<String> = BTreeSet::new();

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
            seen_players.insert(name.clone());
            for finding in legality::audit(&player.legality_inputs()) {
                let key = format!("{:?}", finding.rule);
                *by_rule.entry(key.clone()).or_default() += 1;
                let slot = by_player
                    .entry(name.clone())
                    .or_default()
                    .entry(key)
                    .or_default();
                slot.0 += 1;
                slot.1.insert(log_id);
            }
        }
    }

    let total_players = seen_players.len();
    println!("logs {logs} (skipped {skipped})\n");
    println!("findings per rule:");
    for (rule, count) in &by_rule {
        println!("  {count:6}  {rule}");
    }

    // How many DISTINCT people the meter tint would reach — the number that
    // decides whether it reads as a signal or as wallpaper. Severity is gone,
    // so every flagged person is one tint; the per-rule breakdown below is
    // what tells a calibrator WHICH rule is doing the reaching.
    println!(
        "\nplayers: {} flagged of {} seen",
        by_player.len(),
        total_players
    );

    println!("\nwhat each flagged player carries:");
    for (name, rules) in &by_player {
        println!("  {name}");
        for (rule, (count, logs)) in rules {
            let sample: Vec<_> = logs.iter().take(4).collect();
            println!("      {count:4}x  {rule}  (logs {sample:?})");
        }
    }

    Ok(())
}
