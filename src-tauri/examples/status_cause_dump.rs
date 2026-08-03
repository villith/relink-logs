//! TEMPORARY diagnostic (not for commit): per-log status-cause table from
//! logs.db — who held which effect from which cause, who cast it, and which
//! action ids each player's damage actually used — to root-cause the
//! cross-character cause mislabels on the Buffs tab.
//!
//! Run: cargo run -p gbfr-logs --example status_cause_dump [-- --db <path>] [--last <n>]

use std::collections::BTreeMap;
use std::path::PathBuf;

use anyhow::{Context, Result};
use gbfr_logs::parser::v1::Encounter;
use protocol::{ActionType, Message};

fn main() -> Result<()> {
    let mut db_path = PathBuf::from("src-tauri/logs.db");
    let mut last = 3usize;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => db_path = args.next().context("--db needs a path")?.into(),
            "--last" => last = args.next().context("--last needs a count")?.parse()?,
            other => anyhow::bail!("unknown arg: {other}"),
        }
    }

    let conn = rusqlite::Connection::open(&db_path)
        .with_context(|| format!("opening {}", db_path.display()))?;
    let mut stmt = conn.prepare(
        "SELECT id, datetime(time/1000,'unixepoch','localtime'), data \
         FROM logs ORDER BY id DESC LIMIT ?",
    )?;
    let rows = stmt.query_map([last], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Vec<u8>>(2)?,
        ))
    })?;

    for row in rows {
        let (id, time, blob) = row?;
        let mut encounter = match Encounter::from_blob(&blob) {
            Ok(e) => e,
            Err(e) => {
                eprintln!("warn: skipping log {id}: blob decode failed: {e}");
                continue;
            }
        };
        encounter.repopulate_event_log();

        println!("=== log {id} {time}");

        // actor slot key -> character type, from the encounter's own party.
        let mut who: BTreeMap<u32, String> = BTreeMap::new();
        for (slot, player) in encounter.player_data.iter().enumerate() {
            if let Some(player) = player {
                who.insert(
                    protocol::player_slot_key(slot as u8),
                    format!("{:?}", player.character_type()),
                );
            }
        }
        println!("  party: {who:?}");

        let name_of = |idx: u32| who.get(&idx).cloned().unwrap_or_else(|| format!("{idx}"));

        // (holder, caster, status, cause) -> applies
        let mut statuses: BTreeMap<(String, String, u32, Option<u32>), u64> = BTreeMap::new();
        // (player, action id) -> hits, players only
        let mut actions: BTreeMap<(String, u32), u64> = BTreeMap::new();

        for (_, event) in encounter.event_log() {
            match event {
                Message::StatusApply(e) => {
                    let caster = e.caster_index.map_or("-".into(), name_of);
                    *statuses
                        .entry((name_of(e.actor_index), caster, e.status_id, e.ability_id))
                        .or_default() += 1;
                }
                Message::DamageEvent(e) => {
                    if let Some(player) = who.get(&e.source.parent_index) {
                        if let ActionType::Normal(action) = e.action_id {
                            *actions.entry((player.clone(), action)).or_default() += 1;
                        }
                    }
                }
                _ => {}
            }
        }

        for ((holder, caster, status, cause), count) in &statuses {
            // Player-held only: the reported mislabels are all on the Buffs tab.
            if holder.starts_with("Pl") {
                println!(
                    "  status holder={holder} caster={caster} effect={status} cause={cause:?} applies={count}"
                );
            }
        }
        println!("  --- damage action ids per player:");
        for ((player, action), hits) in &actions {
            println!("  dmg {player} action={action} hits={hits}");
        }
    }

    Ok(())
}
