//! Per-action damage-cap multiplier census: for each (player, attack class,
//! action id), the integer K in `cap = trunc(base * K/100)` across a stored
//! log's capped hits.
//!
//! ## The question this answers
//!
//! Move-scoped board nodes ("Heaven Comes Down: DMG Cap +45%") could enter the
//! formula two ways: fused STATICALLY into the record's per-class cap-up (K is
//! then flat across every action of the class), or applied PER HIT through a
//! condition on the hit's action id (K then steps by the node's percent on
//! exactly that move's hits). The stored log decides: same player, same class,
//! group K by action and read whether it moves.
//!
//! Run: cargo run -p gbfr-logs --example cap_k_by_action -- [--db path] [--log N]

use std::collections::BTreeMap;
use std::path::PathBuf;

use anyhow::{Context, Result};
use gbfr_logs::parser::constants::CharacterType;
use protocol::Message;
use rusqlite::{Connection, OpenFlags};
use serde::Deserialize;

#[derive(Deserialize)]
struct Point {
    x: f32,
    y: f32,
}

#[derive(Deserialize)]
struct Tables {
    curves: BTreeMap<String, BTreeMap<String, Vec<Point>>>,
}

const SUMMON_CURVE_KEY: &str = "58f4dbd4";

/// The builder's own f32 walk (see cap_curve_check.rs — kept identical).
fn game_base(points: &[Point], rate: f32) -> i64 {
    let Some(last) = points.last() else {
        return 0;
    };
    let mut lo: Option<&Point> = None;
    for p in points {
        if rate < p.x {
            let Some(lo) = lo else {
                return p.y.trunc() as i64;
            };
            let span = p.x - lo.x;
            if span <= 0.0 {
                return lo.y.trunc() as i64;
            }
            return (((p.y - lo.y) * (rate - lo.x)) / span + lo.y).trunc() as i64;
        }
        lo = Some(p);
    }
    last.y.trunc() as i64
}

fn character_hash(character: CharacterType) -> Option<String> {
    let name = format!("{character:?}");
    let map: BTreeMap<String, String> =
        serde_json::from_str(include_str!("../../src/assets/character-id-hashes.json")).ok()?;
    map.into_iter()
        .find(|(_, value)| *value == name)
        .map(|(hash, _)| hash)
}

fn main() -> Result<()> {
    let mut db = PathBuf::from("src-tauri/logs.db");
    let mut log_id: Option<i64> = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => db = PathBuf::from(args.next().context("--db needs a path")?),
            "--log" => log_id = Some(args.next().context("--log needs an id")?.parse()?),
            other => anyhow::bail!("unknown argument {other}"),
        }
    }

    let tables: Tables = serde_json::from_str(include_str!("../assets/damage-cap-tables.json"))?;
    let normal = tables.curves.get("normal").context("no normal curves")?;
    let arts = tables.curves.get("arts").context("no arts curves")?;

    let conn = Connection::open_with_flags(
        &db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let (id, blob, version): (i64, Vec<u8>, u8) = match log_id {
        Some(id) => conn.query_row(
            "SELECT id, data, version FROM logs WHERE id = ?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?,
        None => conn.query_row(
            "SELECT id, data, version FROM logs ORDER BY id DESC LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?,
    };
    let parsed = gbfr_logs::parser::deserialize_version(&blob, version)
        .map_err(|e| anyhow::anyhow!("log {id}: {e}"))?;
    println!("log {id}");

    // (actor, class, action) -> K -> count. Grouped so a K that steps on one
    // action while its class-mates hold still is visible at a glance.
    let mut census: BTreeMap<(u32, &'static str, String), BTreeMap<i64, usize>> = BTreeMap::new();
    for (_, event) in parsed.encounter.raw_event_log.iter() {
        let Message::DamageEvent(hit) = event else {
            continue;
        };
        let (Some(cap), Some(rate), Some(flags)) =
            (hit.damage_cap, hit.attack_rate, hit.class_flags)
        else {
            continue;
        };
        if cap <= 0 || !rate.is_finite() {
            continue;
        }
        let points = if flags & 0x80 != 0 {
            normal.get(SUMMON_CURVE_KEY)
        } else {
            let Some(player) = parsed.derived_state.party.get(&hit.source.parent_index) else {
                continue;
            };
            let Some(key) = character_hash(player.character_type) else {
                continue;
            };
            (if flags & 0x40000 != 0 { arts } else { normal }).get(&key)
        };
        let Some(points) = points else { continue };
        let base = game_base(points, rate);
        if base <= 0 {
            continue;
        }
        let class = if flags & 0x40000 != 0 {
            "sba"
        } else if flags & 0x10000 != 0 {
            "skill"
        } else {
            "normal"
        };
        let k = ((100 * cap as i64) as f64 / base as f64).round() as i64;
        *census
            .entry((
                hit.source.parent_index,
                class,
                format!("{:?}", hit.action_id),
            ))
            .or_default()
            .entry(k)
            .or_default() += 1;
    }

    let mut current_actor = None;
    for ((actor, class, action), ks) in &census {
        if current_actor != Some(*actor) {
            let character = parsed
                .derived_state
                .party
                .get(actor)
                .map(|p| format!("{:?}", p.character_type))
                .unwrap_or_else(|| "?".into());
            println!("\nactor {actor:#x} {character}");
            current_actor = Some(*actor);
        }
        let spread: Vec<String> = ks.iter().map(|(k, n)| format!("{k}x{n}")).collect();
        println!("  {class:>6} {action:<32} K: {}", spread.join(" "));
    }
    Ok(())
}
