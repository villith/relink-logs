//! Roster census: which logs contain TRUE co-op remotes, and what data each
//! player slot actually captured.
//!
//! ## Why
//!
//! An enlisted character (another player's character running as a local AI)
//! carries a full locally-simulated record — sigils, overmasteries, the
//! resolved limit-bonus store — so it proves nothing about what a live co-op
//! remote provides. The two are told apart by the LOCAL player's own online
//! flag: in a real lobby the local player is flagged online too, while a
//! solo-with-enlist log flags only the enlisted slot. This census sweeps the
//! corpus, classifies each log (solo / enlist / lobby), and reports per-slot
//! data completeness so "what do remotes not provide" is answered from
//! storage instead of assumption.
//!
//! Run: cargo run --release -p gbfr-logs --example roster_census -- [--db path] [--last N] [--dump]
//!   --dump prints every player row; default prints only lobby logs plus the
//!   corpus summary.

use std::collections::BTreeMap;
use std::path::PathBuf;

use anyhow::{Context, Result};
use rusqlite::{Connection, OpenFlags};

fn main() -> Result<()> {
    let mut db = PathBuf::from("src-tauri/logs.db");
    let mut last = usize::MAX;
    let mut dump = false;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => db = PathBuf::from(args.next().context("--db needs a path")?),
            "--last" => last = args.next().context("--last needs N")?.parse()?,
            "--dump" => dump = true,
            other => anyhow::bail!("unknown argument {other}"),
        }
    }

    let conn = Connection::open_with_flags(
        db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let log_ids: Vec<i64> = conn
        .prepare("SELECT id FROM logs ORDER BY id DESC LIMIT ?1")?
        .query_map([last as i64], |row| row.get(0))?
        .collect::<std::result::Result<Vec<i64>, _>>()?;

    // completeness signature -> count, across every online slot
    let mut online_signatures: BTreeMap<String, usize> = BTreeMap::new();
    let (mut n_solo, mut n_enlist, mut n_lobby) = (0usize, 0usize, 0usize);
    let mut lobby_ids: Vec<i64> = Vec::new();

    for id in log_ids {
        let Ok((blob, version)) = conn.query_row(
            "SELECT data, version FROM logs WHERE id = ?1",
            [id],
            |row| Ok((row.get::<_, Vec<u8>>(0)?, row.get::<_, u8>(1)?)),
        ) else {
            continue;
        };
        let Ok(parsed) = gbfr_logs::parser::deserialize_version(&blob, version) else {
            continue;
        };

        let players: Vec<serde_json::Value> = parsed
            .encounter
            .player_data
            .iter()
            .map(|slot| serde_json::to_value(slot).unwrap_or(serde_json::Value::Null))
            .filter(|v| v["actorIndex"].as_u64().is_some())
            .collect();
        if players.is_empty() {
            continue;
        }

        // The local player owns the first party slot; a lobby flags them
        // online alongside the actual remotes.
        let local_online = players
            .iter()
            .find(|p| p["actorIndex"].as_u64() == Some(0xF000_0000))
            .is_some_and(|p| p["isOnline"].as_bool() == Some(true));
        let online_others = players
            .iter()
            .filter(|p| {
                p["actorIndex"].as_u64() != Some(0xF000_0000)
                    && p["isOnline"].as_bool() == Some(true)
            })
            .count();
        let kind = if local_online && online_others > 0 {
            n_lobby += 1;
            lobby_ids.push(id);
            "lobby"
        } else if online_others > 0 {
            n_enlist += 1;
            "enlist"
        } else {
            n_solo += 1;
            "solo"
        };

        for player in &players {
            let online = player["isOnline"].as_bool() == Some(true);
            if !online && !dump {
                continue;
            }
            let signature = format!(
                "master={} lbcap={} capup={} sigils={} om={} board={} stats={} wstate={}",
                player["masterLevel"]
                    .as_u64()
                    .map(|v| v > 0)
                    .unwrap_or(false),
                !player["limitBonusCapNormal"].is_null(),
                !player["capUpNormal"].is_null(),
                player["sigils"]
                    .as_array()
                    .map(|a| !a.is_empty())
                    .unwrap_or(false),
                player["overmasteryInfo"]["overmasteries"]
                    .as_array()
                    .map(|a| !a.is_empty())
                    .unwrap_or(false),
                player["skillboard"]
                    .as_array()
                    .map(|a| !a.is_empty())
                    .unwrap_or(false),
                !player["playerStats"].is_null(),
                !player["weaponState"].is_null(),
            );
            if online {
                *online_signatures
                    .entry(format!("[{kind}] {signature}"))
                    .or_default() += 1;
            }
            if dump || kind == "lobby" {
                println!(
                    "log {id} [{kind}] actor {:#x} {} \"{}\"{}: {signature}",
                    player["actorIndex"].as_u64().unwrap_or(0),
                    player["characterType"].as_str().unwrap_or("?"),
                    player["displayName"].as_str().unwrap_or(""),
                    if online { " ONLINE" } else { "" },
                );
            }
        }
    }

    println!("\nlogs: {n_solo} solo, {n_enlist} with enlisted characters, {n_lobby} true lobbies");
    if !lobby_ids.is_empty() {
        println!("lobby log ids: {lobby_ids:?}");
    }
    println!("\nonline-slot completeness signatures:");
    for (signature, count) in &online_signatures {
        println!("  {count:>5}x {signature}");
    }
    Ok(())
}
