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

use gbfr_logs::legality::{self, Severity};

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
                let key = format!("{:?}/{:?}", finding.rule, finding.severity);
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

    // How many DISTINCT people any colour would reach — the number that
    // decides whether a meter tint reads as a signal or as wallpaper.
    let impossible_players = by_player
        .values()
        .filter(|rules| {
            rules
                .keys()
                .any(|rule| rule.contains(&format!("{:?}", Severity::Impossible)))
        })
        .count();
    let improbable_only = by_player
        .values()
        .filter(|rules| {
            !rules
                .keys()
                .any(|rule| rule.contains(&format!("{:?}", Severity::Impossible)))
        })
        .count();
    println!(
        "\nplayers: {} flagged of {} seen ({impossible_players} impossible, {improbable_only} improbable only)",
        by_player.len(),
        total_players
    );

    println!("\nplayers carrying an Impossible finding:");
    for (name, rules) in &by_player {
        let impossible: Vec<_> = rules
            .iter()
            .filter(|(rule, _)| rule.contains(&format!("{:?}", Severity::Impossible)))
            .collect();
        if impossible.is_empty() {
            continue;
        }
        println!("  {name}");
        for (rule, (count, logs)) in impossible {
            let sample: Vec<_> = logs.iter().take(4).collect();
            println!("      {count:4}x  {rule}  (logs {sample:?})");
        }
    }

    Ok(())
}
