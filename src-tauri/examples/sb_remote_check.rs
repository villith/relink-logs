//! TEMPORARY diagnostic (not for commit): for one stored encounter, print every
//! PlayerIdentityEvent's loadout completeness per party slot — specifically
//! whether `skillboard` is populated for REMOTE players, which decides whether a
//! reproduced damage-cap breakdown can cover them.
//!
//! Run: cargo run -p gbfr-logs --example sb_remote_check -- [--db path] --log 2417

use std::collections::BTreeMap;
use std::path::PathBuf;

use anyhow::{Context, Result};
use gbfr_logs::parser::v1::Encounter;
use protocol::Message;
use rusqlite::Connection;

#[derive(Default)]
struct Slot {
    name: String,
    is_online: bool,
    char_type: u32,
    events: usize,
    sigils: usize,
    summons: usize,
    overmasteries: usize,
    abilities: usize,
    skillboard: usize,
    weapon_key: String,
    master_level: u32,
    player_level: u32,
}

fn main() -> Result<()> {
    let mut db_path = PathBuf::from("src-tauri/logs.db");
    let mut want: Option<i64> = None;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => db_path = args.next().context("--db needs a path")?.into(),
            "--log" => want = Some(args.next().context("--log needs an id")?.parse()?),
            other => anyhow::bail!("unknown arg: {other}"),
        }
    }
    let want = want.context("--log <id> is required")?;

    let conn = Connection::open(db_path)?;
    let blob: Vec<u8> = conn.query_row(
        "SELECT data FROM logs WHERE id = ? AND version = 1",
        [want],
        |row| row.get(0),
    )?;
    let encounter = Encounter::from_blob(&blob)?;

    // Last write wins per slot: identity is republished as the quest runs, and
    // the LATEST publish is what the meter shows.
    let mut slots: BTreeMap<u8, Slot> = BTreeMap::new();
    for (_, msg) in encounter.event_log() {
        let Message::PlayerIdentityEvent(e) = msg else {
            continue;
        };
        let slot = slots.entry(e.party_index).or_default();
        slot.events += 1;
        slot.name = e.display_name.to_string_lossy().into_owned();
        slot.is_online = e.is_online;
        slot.char_type = e.character_type;
        // Take the RICHEST publish seen, not the last: a later thin publish
        // would otherwise erase a fuller earlier one and misreport coverage.
        slot.sigils = slot.sigils.max(e.sigils.len());
        slot.summons = slot.summons.max(e.summons.len());
        slot.overmasteries = slot.overmasteries.max(e.overmasteries.len());
        slot.abilities = slot.abilities.max(e.abilities.len());
        slot.skillboard = slot.skillboard.max(e.skillboard.len());
        slot.master_level = slot.master_level.max(e.master_level);
        slot.player_level = slot.player_level.max(e.player_level);
        if !e.weapon_key.is_empty() {
            slot.weapon_key = e.weapon_key.clone();
        }
    }

    // What the log actually contains, so an empty identity table can be told
    // apart from "this log stores identity some other way".
    let mut census: BTreeMap<&'static str, usize> = BTreeMap::new();
    for (_, msg) in encounter.event_log() {
        let name = match msg {
            Message::DamageEvent(_) => "DamageEvent",
            Message::PlayerIdentityEvent(_) => "PlayerIdentityEvent",
            Message::PlayerLoadEvent(_) => "PlayerLoadEvent",
            Message::OnAreaEnter(_) => "OnAreaEnter",
            Message::StatusApply(_) => "StatusApply",
            Message::StatusRemove(_) => "StatusRemove",
            Message::SbaGain(_) => "SbaGain",
            Message::OnUpdateSBA(_) => "OnUpdateSBA",
            _ => "other",
        };
        *census.entry(name).or_default() += 1;
    }
    println!("log {want}: quest {:?}", encounter.quest_id);
    println!("variant census: {census:?}");
    println!(
        "{} identity publishes across {} slots",
        slots.values().map(|s| s.events).sum::<usize>(),
        slots.len()
    );
    // The REAL store: identity is folded into the encounter's derived
    // `player_data`, not replayed from the raw event log. Read it through serde
    // because `PlayerData`'s fields are private to the parser module.
    let json = serde_json::to_value(&encounter.player_data)?;
    println!(
        "\n{:<5} {:<18} {:<7} {:>6} {:>7} {:>4} {:>4} {:>10} {:>6}  {}",
        "slot",
        "name",
        "online",
        "sigils",
        "summons",
        "om",
        "abil",
        "skillboard",
        "mLvl",
        "weapon_key"
    );
    let len =
        |v: &serde_json::Value, k: &str| v.get(k).and_then(|a| a.as_array()).map_or(0, Vec::len);
    for (idx, slot) in json.as_array().into_iter().flatten().enumerate() {
        if slot.is_null() {
            println!("{idx:<5} (empty)");
            continue;
        }
        let om = slot
            .get("overmasteryInfo")
            .and_then(|o| o.get("overmasteries"))
            .and_then(|a| a.as_array())
            .map_or(0, Vec::len);
        println!(
            "{:<5} {:<18} {:<7} {:>6} {:>7} {:>4} {:>4} {:>10} {:>6}  {}",
            idx,
            slot.get("displayName")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .chars()
                .take(18)
                .collect::<String>(),
            slot.get("isOnline")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
            len(slot, "sigils"),
            len(slot, "summons"),
            om,
            len(slot, "abilities"),
            len(slot, "skillboard"),
            slot.get("masterLevel")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0),
            slot.get("weaponKey").and_then(|v| v.as_str()).unwrap_or(""),
        );
    }

    let _ = &slots;
    Ok(())
}
