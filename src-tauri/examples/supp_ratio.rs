//! TEMPORARY diagnostic (not for commit): per-player supp vs eligible damage sums
//! straight from the raw event log, to check the meter's Sup % against data truth.
//!
//! Run: cargo run -p gbfr-logs --example supp_ratio [-- --db <path>] [--last <n>]

use std::collections::BTreeMap;
use std::path::PathBuf;

use anyhow::{Context, Result};
use gbfr_logs::parser::v1::Encounter;
use protocol::{ActionType, Message};
use rusqlite::Connection;

fn main() -> Result<()> {
    let mut db_path = PathBuf::from("src-tauri/logs.db");
    let mut last = 3i64;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => db_path = args.next().context("--db needs a path")?.into(),
            "--last" => last = args.next().context("--last needs a count")?.parse()?,
            other => anyhow::bail!("unknown arg: {other}"),
        }
    }

    let conn =
        Connection::open(&db_path).with_context(|| format!("opening {}", db_path.display()))?;
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
                eprintln!("warn: skipping log {id}: {e}");
                continue;
            }
        };
        encounter.repopulate_event_log();
        let events: Vec<&Message> = encounter.event_log().map(|(_, e)| e).collect();

        type Src = (u32, u32);
        #[derive(Default)]
        struct Tally {
            normal: u64,
            la: u64,
            sba: u64,
            dot: u64,
            supp: u64,
            supp_events: u64,
            normal_events: u64,
        }
        let mut tallies: BTreeMap<Src, Tally> = BTreeMap::new();
        // Ratio histogram: each supp event vs the closest-preceding same-source
        // non-supp hit with the same embedded aid (exact trigger pairing).
        let mut ratio_buckets: BTreeMap<&'static str, u64> = BTreeMap::new();
        let mut base_ratio_buckets: BTreeMap<&'static str, u64> = BTreeMap::new();

        for (i, event) in events.iter().enumerate() {
            let Message::DamageEvent(e) = event else { continue };
            if e.damage <= 0 {
                continue;
            }
            let t = tallies
                .entry((e.source.index, e.source.actor_type))
                .or_default();
            match e.action_id {
                ActionType::Normal(_) => {
                    t.normal += e.damage as u64;
                    t.normal_events += 1;
                }
                ActionType::LinkAttack => t.la += e.damage as u64,
                ActionType::SBA => t.sba += e.damage as u64,
                ActionType::DamageOverTime(_) => t.dot += e.damage as u64,
                ActionType::PerfectGuard | ActionType::PerfectGuardQuickening => {}
                ActionType::SupplementaryDamage(aid) => {
                    t.supp += e.damage as u64;
                    t.supp_events += 1;
                    // pair to nearest preceding same-source Normal with same aid
                    let src = (e.source.index, e.source.actor_type);
                    let mut ratio = None;
                    for prev in events[..i].iter().rev().take(300) {
                        let Message::DamageEvent(p) = prev else { continue };
                        if (p.source.index, p.source.actor_type) != src || p.damage <= 0 {
                            continue;
                        }
                        if let ActionType::Normal(paid) = p.action_id {
                            if paid == aid {
                                ratio = Some(e.damage as f64 / p.damage as f64);
                                break;
                            }
                        }
                    }
                    let bucket = match ratio {
                        None => "unpaired",
                        Some(r) if (r - 0.2).abs() < 0.01 => "0.2",
                        Some(r) if (r - 0.4).abs() < 0.01 => "0.4",
                        Some(r) if r < 0.2 => "<0.2",
                        Some(r) if r < 0.4 => "0.2-0.4",
                        Some(r) if r < 1.0 => "0.4-1.0",
                        Some(_) => ">=1.0",
                    };
                    *ratio_buckets.entry(bucket).or_default() += 1;
                    // Same pairing, but ratio vs the trigger's UNCAPPED base damage
                    // (present when the trigger was cappable, hook >= 17:09): if
                    // echoes scale off base, these cluster at 0.2/0.4 even when the
                    // displayed ratio blows past 1.0.
                    let mut base_ratio = None;
                    for prev in events[..i].iter().rev().take(300) {
                        let Message::DamageEvent(p) = prev else { continue };
                        if (p.source.index, p.source.actor_type) != src || p.damage <= 0 {
                            continue;
                        }
                        if let ActionType::Normal(paid) = p.action_id {
                            if paid == aid {
                                // vs min(base, cap): the trigger's post-clamp,
                                // pre-post-multiplier damage.
                                base_ratio = match (p.base_damage, p.damage_cap) {
                                    (Some(b), Some(c)) if c > 0 => {
                                        Some(e.damage as f64 / f64::from(b.min(c as f32)))
                                    }
                                    (Some(b), None) => Some(e.damage as f64 / f64::from(b)),
                                    _ => None,
                                };
                                break;
                            }
                        }
                    }
                    let bucket = match base_ratio {
                        None => "no-base",
                        Some(r) if (r - 0.2).abs() < 0.01 => "0.2",
                        Some(r) if (r - 0.4).abs() < 0.01 => "0.4",
                        Some(r) if r < 0.2 => "<0.2",
                        Some(r) if r < 0.4 => "0.2-0.4",
                        Some(r) if r < 1.0 => "0.4-1.0",
                        Some(_) => ">=1.0",
                    };
                    *base_ratio_buckets.entry(bucket).or_default() += 1;
                }
            }
        }

        println!("=== log {id} {time}");
        for (src, t) in &tallies {
            if t.supp == 0 && t.normal == 0 {
                continue;
            }
            let total = t.normal + t.la + t.sba + t.dot + t.supp;
            println!(
                "  src {:#010x}/{}: normal={} ({} ev) la={} sba={} dot={} supp={} ({} ev) | supp/normal={:.1}% supp/total={:.1}%",
                src.1,
                src.0,
                t.normal,
                t.normal_events,
                t.la,
                t.sba,
                t.dot,
                t.supp,
                t.supp_events,
                if t.normal > 0 { t.supp as f64 / t.normal as f64 * 100.0 } else { 0.0 },
                if total > 0 { t.supp as f64 / total as f64 * 100.0 } else { 0.0 },
            );
        }
        println!("  supp/trigger ratio buckets (aid-paired): {ratio_buckets:?}");
        println!("  supp/trigger-BASE ratio buckets:          {base_ratio_buckets:?}");

        // Flag profile: do the oversized echoes differ in flags from the clean 0.2/0.4 ones?
        let mut flags_clean: BTreeMap<u64, u64> = BTreeMap::new();
        let mut flags_oversize: BTreeMap<u64, u64> = BTreeMap::new();
        let mut supp_with_cap = 0u64;
        for (i, event) in events.iter().enumerate() {
            let Message::DamageEvent(e) = event else { continue };
            let ActionType::SupplementaryDamage(aid) = e.action_id else {
                continue;
            };
            if e.damage <= 0 {
                continue;
            }
            if e.damage_cap.is_some() {
                supp_with_cap += 1;
            }
            let src = (e.source.index, e.source.actor_type);
            let mut ratio = None;
            for prev in events[..i].iter().rev().take(300) {
                let Message::DamageEvent(p) = prev else { continue };
                if (p.source.index, p.source.actor_type) != src || p.damage <= 0 {
                    continue;
                }
                if let ActionType::Normal(paid) = p.action_id {
                    if paid == aid {
                        ratio = Some(e.damage as f64 / p.damage as f64);
                        break;
                    }
                }
            }
            match ratio {
                Some(r) if (r - 0.2).abs() < 0.01 || (r - 0.4).abs() < 0.01 => {
                    *flags_clean.entry(e.flags).or_default() += 1;
                }
                Some(r) if r >= 1.0 => {
                    *flags_oversize.entry(e.flags).or_default() += 1;
                }
                _ => {}
            }
        }
        println!("  supp events with damage_cap set: {supp_with_cap}");
        println!("  flags of CLEAN 0.2/0.4 echoes:  {flags_clean:x?}");
        println!("  flags of OVERSIZED >=1.0 echoes: {flags_oversize:x?}");
    }

    Ok(())
}
