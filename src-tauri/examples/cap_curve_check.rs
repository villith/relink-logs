//! Offline golden check for the damage-cap model: replay stored logs against
//! the shipped base-cap ladder and count how many capped hits the formula can
//! explain.
//!
//! ## Why this is a real check
//!
//! The ladder gives the base INDEPENDENTLY of any cap-up model, and every
//! cap-up source is an integer percent count, so a logged cap must satisfy
//! `cap == trunc(base * K/100)` for some integer K (within the f32 drift of
//! the game's own sum). A hit that misses that grid is one the formula cannot
//! have produced for that character and rate — the per-hit validity verdict
//! the Events card renders. Needs no live capture; works on any stored log
//! that carries `damage_cap`, `attack_rate` and `class_flags`.
//!
//! Mirrors `src/pages/logs/view/events/capLadder.ts` — the walk is the
//! builder's own (`FUN_1409c1cf0`, v2.0.4): strict `<` in f32, f32 lerp, flat
//! holds, truncate. Summon hits (class-flag bit 7) read the shared `SO0000`
//! curve in the normal map; `0x40000` selects the arts map.
//!
//! Run: cargo run -p gbfr-logs --example cap_curve_check -- [--db path] [--last N]

use std::collections::BTreeMap;
use std::path::PathBuf;

use anyhow::{Context, Result};
use gbfr_logs::parser::constants::CharacterType;
use protocol::Message;
use rusqlite::Connection;
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

/// `xxhash32("SO0000")` — the summon curve's key in the normal map.
const SUMMON_CURVE_KEY: &str = "58f4dbd4";

/// The builder's own walk, arithmetic included. Single precision is
/// load-bearing: a double-precision mirror lands one integer LOW at every
/// exact row rate (0.2 -> 1998 instead of 1999).
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

/// Whether `cap` sits on the integer-percent grid the formula produces from
/// `base`. Same tolerance as `capConsistent` in capLadder.ts: the multiplier
/// is a sum of many f32 terms, so at large bases the product drifts off the
/// exact grid by up to ~1e-5 relative.
fn cap_consistent(cap: i64, base: i64) -> bool {
    if cap <= 0 || base <= 0 {
        return false;
    }
    let k = ((100 * cap) as f64 / base as f64).round();
    if k < 100.0 {
        return false;
    }
    let predicted = base as f64 * k / 100.0;
    let tolerance = (predicted * 1e-5).max(1.0);
    cap >= (predicted - tolerance).trunc() as i64 && cap <= (predicted + tolerance).trunc() as i64
}

/// `PL####` under the game's xxhash32 — the key `chara_damage_limit` uses.
/// Inverted from the shipped hash map rather than recomputed: the enum's Debug
/// name (`Pl0200`) is exactly that file's value, so there is nothing to hash.
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
    let mut last = 20usize;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => db = PathBuf::from(args.next().context("--db needs a path")?),
            "--last" => last = args.next().context("--last needs N")?.parse()?,
            other => anyhow::bail!("unknown argument {other}"),
        }
    }

    let tables: Tables = serde_json::from_str(include_str!("../assets/damage-cap-tables.json"))?;
    let normal = tables.curves.get("normal").context("no normal curves")?;
    let arts = tables.curves.get("arts").context("no arts curves")?;
    println!(
        "curves loaded: {} normal, {} arts",
        normal.len(),
        arts.len()
    );

    let conn = Connection::open(&db).with_context(|| format!("open {}", db.display()))?;
    let mut stmt = conn.prepare("SELECT id, data, version FROM logs ORDER BY id DESC LIMIT ?1")?;
    let rows = stmt.query_map([last], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, Vec<u8>>(1)?,
            row.get::<_, u8>(2)?,
        ))
    })?;

    let (mut total_checked, mut total_consistent) = (0usize, 0usize);
    for row in rows {
        let (id, blob, version) = row?;
        let Ok(parsed) = gbfr_logs::parser::deserialize_version(&blob, version) else {
            continue;
        };

        let mut checked = 0usize;
        let mut consistent = 0usize;
        let mut no_curve = 0usize;
        let mut violations: BTreeMap<(u32, i64), usize> = BTreeMap::new();
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
                    no_curve += 1;
                    continue;
                };
                (if flags & 0x40000 != 0 { arts } else { normal }).get(&key)
            };
            let Some(points) = points else {
                no_curve += 1;
                continue;
            };
            let base = game_base(points, rate);
            if base <= 0 {
                continue;
            }
            checked += 1;
            if cap_consistent(cap as i64, base) {
                consistent += 1;
            } else {
                *violations
                    .entry((hit.source.parent_index, cap as i64))
                    .or_default() += 1;
            }
        }
        if checked == 0 {
            continue;
        }
        total_checked += checked;
        total_consistent += consistent;
        let worst: Vec<String> = violations
            .iter()
            .take(3)
            .map(|((actor, cap), n)| format!("actor {actor:#x} cap {cap} x{n}"))
            .collect();
        println!(
            "log {id:>4}: {checked:>6} capped hits, {:>6.2}% consistent, {no_curve} without a curve{}",
            consistent as f64 / checked as f64 * 100.0,
            if worst.is_empty() {
                String::new()
            } else {
                format!("  violations: {}", worst.join(", "))
            }
        );
    }
    if total_checked > 0 {
        println!(
            "\ntotal: {total_checked} hits, {:.2}% consistent",
            total_consistent as f64 / total_checked as f64 * 100.0
        );
    }
    Ok(())
}
