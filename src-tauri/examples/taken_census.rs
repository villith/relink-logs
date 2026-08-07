//! Diagnostic: per-log damage-taken census over the newest N logs, so a taken
//! stream that stopped being recorded (hook regression) is visible and
//! distinguishable from a query/display bug downstream.
//!
//!   cargo run -p gbfr-logs --example taken_census -- [--db <path>] [--recent <n>]

use std::path::PathBuf;

use anyhow::{Context, Result};
use gbfr_logs::parser::v1::{is_damage_taken_event, Encounter};
use protocol::Message;
use rusqlite::{Connection, OpenFlags};

fn main() -> Result<()> {
    let mut db_path = PathBuf::from("src-tauri/logs.db");
    let mut recent: usize = 25;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => db_path = args.next().context("--db needs a path")?.into(),
            "--recent" => recent = args.next().context("--recent needs a count")?.parse()?,
            other => anyhow::bail!("unknown arg: {other}"),
        }
    }

    let conn = Connection::open_with_flags(&db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;

    // Formatted in SQL like every other example that prints a log's timestamp,
    // so two diag outputs for the same log agree (and agree on local time).
    let mut stmt = conn.prepare(
        "SELECT id, datetime(time/1000,'unixepoch','localtime'), data \
         FROM logs ORDER BY id DESC LIMIT ?",
    )?;
    let rows = stmt.query_map([recent as i64], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Vec<u8>>(2)?,
        ))
    })?;

    println!(
        "{:>6}  {:<20} {:>10} {:>10} {:>14} {:>10} {:>10}",
        "id", "recorded", "dmg evts", "taken", "taken total", "tgt slots", "src slots"
    );

    for row in rows {
        let (id, when, blob) = row?;
        let mut encounter = match Encounter::from_blob(&blob) {
            Ok(e) => e,
            Err(e) => {
                println!("{id:>6}  <undecodable: {e}>");
                continue;
            }
        };
        encounter.repopulate_event_log();

        let mut damage_events = 0usize;
        let mut taken = 0usize;
        let mut taken_total = 0i64;
        // Taken events whose victim parent_index is a real slot key — should
        // equal `taken`; a mismatch means the keying changed.
        let mut slot_keyed = 0usize;
        let mut source_slot_keyed = 0usize;

        for (_, event) in encounter.event_log() {
            let Message::DamageEvent(e) = event else {
                continue;
            };
            damage_events += 1;
            let target_is_player_slot = protocol::is_player_slot_key(e.target.parent_index);
            // The parser's own classifier, not a copy of it: this tool exists to
            // tell a hook regression from a downstream bug, which it can only do
            // while it counts exactly what the parser accumulates.
            if is_damage_taken_event(e) {
                taken += 1;
                taken_total += e.damage.max(0) as i64;
            }
            if target_is_player_slot {
                slot_keyed += 1;
            }
            if protocol::is_player_slot_key(e.source.parent_index) {
                source_slot_keyed += 1;
            }
        }

        println!(
            "{id:>6}  {when:<20} {damage_events:>10} {taken:>10} {taken_total:>14} {slot_keyed:>10} {source_slot_keyed:>10}"
        );
    }

    Ok(())
}
