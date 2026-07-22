//! TEMPORARY diagnostic (not for commit): per-target HP-pool dump for one stored
//! encounter. Shows, for every (parent_index, parent_actor_type) target, how many
//! hits landed, how many carried a sanitized (current, max) HP pair, and the
//! distinct max-HP values seen — to explain why an enemy is missing from the
//! quest-details HP chart or loses the "boss" pick in the overlay header.
//!
//! Run: cargo run -p gbfr-logs --example hp_pools -- --db "<logs.db>" [--log <id>]
//! (omit --log for the newest log)

use std::collections::BTreeMap;
use std::path::PathBuf;

use anyhow::{Context, Result};
use gbfr_logs::parser::constants::EnemyType;
use gbfr_logs::parser::v1::{build_target_hp_charts, segment_targets, Encounter};
use protocol::Message;
use rusqlite::Connection;

#[derive(Default)]
struct Pool {
    hits: u64,
    with_hp: u64,
    maxes: BTreeMap<u64, u64>, // max value -> hits reporting it
    first_hp_ts: Option<i64>,
    last_hp_ts: Option<i64>,
    last_current: Option<u64>,
    total_damage: i64,
}

fn main() -> Result<()> {
    let mut db_path = PathBuf::from("src-tauri/logs.db");
    let mut log_id: i64 = -1;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => db_path = args.next().context("--db needs a path")?.into(),
            "--log" => log_id = args.next().context("--log needs an id")?.parse()?,
            other => anyhow::bail!("unknown arg: {other}"),
        }
    }

    let conn =
        Connection::open(&db_path).with_context(|| format!("opening {}", db_path.display()))?;
    if log_id < 0 {
        log_id = conn.query_row("SELECT MAX(id) FROM logs", [], |r| r.get(0))?;
    }
    let (time, blob): (String, Vec<u8>) = conn.query_row(
        "SELECT datetime(time/1000,'unixepoch','localtime'), data FROM logs WHERE id = ?",
        [log_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;

    let mut encounter = Encounter::from_blob(&blob)?;
    encounter.repopulate_event_log();

    let mut pools: BTreeMap<(u32, u32), Pool> = BTreeMap::new();
    let mut start_time = None;

    for (ts, event) in encounter.event_log() {
        let Message::DamageEvent(e) = event else {
            continue;
        };
        start_time.get_or_insert(*ts);
        let pool = pools
            .entry((e.target.parent_index, e.target.parent_actor_type))
            .or_default();
        pool.hits += 1;
        pool.total_damage += e.damage as i64;
        if let (Some(current), Some(max)) = (e.target_current_hp, e.target_max_hp) {
            pool.with_hp += 1;
            *pool.maxes.entry(max).or_default() += 1;
            let rel = ts - start_time.unwrap_or(*ts);
            pool.first_hp_ts.get_or_insert(rel);
            pool.last_hp_ts = Some(rel);
            pool.last_current = Some(current);
        }
    }

    println!("log {log_id} @ {time} — {} target pools", pools.len());
    let mut rows: Vec<_> = pools.iter().collect();
    rows.sort_by_key(|(_, p)| std::cmp::Reverse(p.total_damage));
    for ((index, type_hash), p) in rows {
        let enemy = EnemyType::from_hash(*type_hash);
        println!(
            "  idx={index:<4} type={enemy} ({type_hash:#010x}) hits={:<6} with_hp={:<6} dmg={:<13} hp_span={:?}..{:?} last_current={:?}",
            p.hits, p.with_hp, p.total_damage, p.first_hp_ts, p.last_hp_ts, p.last_current
        );
        for (max, count) in &p.maxes {
            println!("        max={max:<13} ({count} reports)");
        }
    }

    // Preview of what the quest-details chart builder produces (per-second
    // buckets, no target filter): series after per-spawn keying + wave splits.
    let start = encounter
        .raw_event_log
        .first()
        .map(|(ts, _)| *ts)
        .unwrap_or(0);
    let duration = encounter
        .raw_event_log
        .last()
        .map(|(ts, _)| ts - start)
        .unwrap_or(1)
        .max(1);
    let chart_len = (duration / 1_000) as usize + 1;
    let segments = segment_targets(&encounter.raw_event_log, start);
    let charts = build_target_hp_charts(
        &encounter.raw_event_log,
        &segments,
        start,
        1_000,
        chart_len,
        &[],
    );
    println!("chart series ({}):", charts.len());
    for series in &charts {
        let first = series.values.iter().position(|v| v.is_some());
        let last = series
            .values
            .iter()
            .rposition(|v| v.is_some())
            .and_then(|i| series.values[i].map(|v| (i, v)));
        println!(
            "  {} #{:<2} max={:<13} span={:?}..{:?}",
            series.enemy_type, series.instance, series.max_hp, first, last
        );
    }

    Ok(())
}
