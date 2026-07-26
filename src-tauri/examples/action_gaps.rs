//! Diagnostic (scratch): every (character, Normal action id) pair that actually
//! appears in the stored logs, with hit counts — the empirical answer to "which
//! action ids do players really see?", to be crossed against ui.json/skill
//! groups to find the ones that render as a bare "Skill N".
//!
//!   cargo run -p gbfr-logs --example action_gaps -- [--db <path>]
//!
//! Output is TSV on stdout: character<TAB>action_id<TAB>hits<TAB>logs<TAB>total_damage

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use anyhow::{Context, Result};
use gbfr_logs::parser::constants::CharacterType;
use gbfr_logs::parser::v1::Encounter;
use protocol::{ActionType, Message};
use rusqlite::Connection;

#[derive(Default)]
struct Stats {
    hits: usize,
    total: i64,
    logs: BTreeSet<i64>,
}

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
    let mut stmt = conn.prepare("SELECT id, data FROM logs ORDER BY id")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
    })?;

    let mut seen: BTreeMap<(String, u32), Stats> = BTreeMap::new();
    let mut scanned = 0usize;

    for row in rows {
        let (log_id, blob) = row?;
        let mut encounter = match Encounter::from_blob(&blob) {
            Ok(e) => e,
            Err(_) => continue,
        };
        encounter.repopulate_event_log();
        scanned += 1;

        for (_, event) in encounter.event_log() {
            let Message::DamageEvent(dmg) = event else {
                continue;
            };
            let ActionType::Normal(id) = dmg.action_id else {
                continue;
            };
            // Attribute to the SOURCE's parent (the player), matching how the
            // meter groups rows; child actors (summons) keep their own type.
            let who = CharacterType::from_hash(dmg.source.parent_actor_type).to_string();
            let s = seen.entry((who, id)).or_default();
            s.hits += 1;
            s.total += dmg.damage as i64;
            s.logs.insert(log_id);
        }
    }

    eprintln!("scanned {scanned} logs, {} distinct (character, action) pairs", seen.len());
    for ((who, id), s) in &seen {
        println!("{who}\t{id}\t{}\t{}\t{}", s.hits, s.logs.len(), s.total);
    }
    Ok(())
}
