//! Verify that the damage meter logs every hit the game applies, by reconciling
//! logged damage against the enemy HP recorded alongside it.
//!
//! Every damage event since 2026-07-20 carries the target's post-hit
//! `(current, max)` HP pair. Damage we logged should equal HP the enemy lost.
//! Killing blows overflow past zero and some enemies regenerate, so this sweeps
//! the whole corpus, lets the data say which enemies regenerate, and reports
//! what share of HP loss remains unexplained.
//!
//! Run: cargo run -p gbfr-logs --example damage_audit -- --db "<logs.db>"
//!
//! Flags:
//!   --db <path>          logs.db to audit (default src-tauri/logs.db)
//!   --log <id>           audit one log instead of the whole corpus
//!   --threshold <pct>    unexplained share that fails the run (default 1.0)
//!   --csv <path>         write one row per reconciled interval
//!   --no-anchor          don't assume a target spawn starts at full HP
//!   --no-auto-outliers   count every heal as unexplained
//!
//! The DB is WAL-mode, so when copying one out of the install dir take its
//! `-wal` sidecar too — without it the newest encounters are silently missing.

use std::{
    collections::BTreeMap,
    fs::File,
    io::{BufWriter, Write},
    path::{Path, PathBuf},
};

use anyhow::{Context, Result};
use gbfr_logs::parser::constants::EnemyType;
use gbfr_logs::parser::v1::Encounter;
use gbfr_logs::parser::v1::audit::{
    audit_encounter, classify_regen_outliers, per_enemy_stats, AuditOptions, AuditTotals,
    EnemyStats, REGEN_MIN_INTERVAL_SHARE, REGEN_MIN_LOGS,
};
use rusqlite::{Connection, OpenFlags};

/// Per-log roll-up, kept so the report can name the worst offenders.
struct LogSummary {
    id: u64,
    quest_id: Option<u32>,
    logged: i64,
    hp_removed: i64,
    under_logged: i64,
    /// Heals per enemy type, split into explained/unexplained only once the
    /// corpus has said which enemies regenerate.
    healed_by_enemy: Vec<(EnemyType, i64)>,
    unmeasured: i64,
}

impl LogSummary {
    fn healed_unclassified(&self, outliers: &[EnemyType]) -> i64 {
        self.healed_by_enemy
            .iter()
            .filter(|(enemy_type, _)| !outliers.contains(enemy_type))
            .map(|(_, healed)| healed)
            .sum()
    }

    fn unexplained(&self, outliers: &[EnemyType]) -> i64 {
        self.under_logged + self.healed_unclassified(outliers)
    }
}

#[derive(Default)]
struct Corpus {
    /// Every per-log [`AuditTotals`] summed. Held whole rather than mirrored
    /// field by field, so a total added to the audit module reaches this report
    /// instead of quietly reading zero.
    totals: AuditTotals,
    logs_scanned: usize,
    logs_with_hp: usize,
    /// (stats, count of distinct logs where this enemy healed)
    per_enemy: Vec<(EnemyType, EnemyStats, usize)>,
    shared_pools: BTreeMap<(u32, u64), (Vec<u32>, usize)>,
}

fn main() -> Result<()> {
    let mut db_path = PathBuf::from("src-tauri/logs.db");
    let mut only_log: Option<u64> = None;
    let mut threshold_pct = 1.0_f64;
    let mut csv_path: Option<PathBuf> = None;
    let mut options = AuditOptions::default();
    let mut auto_outliers = true;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => db_path = args.next().context("--db needs a path")?.into(),
            "--log" => only_log = Some(args.next().context("--log needs an id")?.parse()?),
            "--threshold" => {
                threshold_pct = args.next().context("--threshold needs a percent")?.parse()?
            }
            "--csv" => csv_path = Some(args.next().context("--csv needs a path")?.into()),
            "--no-anchor" => options.anchor_at_max_hp = false,
            "--no-auto-outliers" => auto_outliers = false,
            other => anyhow::bail!("unknown arg: {other}"),
        }
    }

    let conn = Connection::open_with_flags(&db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .with_context(|| format!("opening {}", db_path.display()))?;

    let mut csv = csv_path
        .as_ref()
        .map(|path| -> Result<BufWriter<File>> {
            let mut writer = BufWriter::new(File::create(path)?);
            writeln!(
                writer,
                "log_id,target_index,enemy,instance,start_ms,end_ms,logged,hp_before,hp_after,residual,bucket,is_anchor"
            )?;
            Ok(writer)
        })
        .transpose()?;

    let sql = match only_log {
        Some(_) => "SELECT id, version, data FROM logs WHERE id = ?1",
        None => "SELECT id, version, data FROM logs ORDER BY id",
    };
    let mut stmt = conn.prepare(sql)?;
    let params: Vec<&dyn rusqlite::ToSql> = match &only_log {
        Some(id) => vec![id],
        None => vec![],
    };
    let rows = stmt.query_map(params.as_slice(), |row| {
        Ok((
            row.get::<_, u64>(0)?,
            row.get::<_, u8>(1)?,
            row.get::<_, Vec<u8>>(2)?,
        ))
    })?;

    let mut corpus = Corpus::default();
    let mut summaries: Vec<LogSummary> = Vec::new();
    let mut unreadable: Vec<(u64, String)> = Vec::new();

    for row in rows {
        let (id, version, blob) = row?;
        corpus.logs_scanned += 1;

        // Only the raw event log is audited, so the v1 path decodes the blob
        // directly: `deserialize_version` would run a full derived-state
        // reparse per log and this throws all of it away. v0 still goes through
        // it, because there the upgrade is what produces the events.
        let encounter = match decode_encounter(&blob, version) {
            Ok(encounter) => encounter,
            Err(e) => {
                unreadable.push((id, e.to_string()));
                continue;
            }
        };

        let events = &encounter.raw_event_log;
        let Some((start_time, _)) = events.first() else {
            continue;
        };

        let audit = audit_encounter(events, *start_time, options);
        if audit.totals.hp_removed > 0 {
            corpus.logs_with_hp += 1;
        }

        if let Some(writer) = csv.as_mut() {
            for interval in &audit.intervals {
                writeln!(
                    writer,
                    "{id},{},{},{},{},{},{},{},{},{},{:?},{}",
                    interval.target_index,
                    enemy_label(interval.enemy_type),
                    interval.instance,
                    interval.start_ms,
                    interval.end_ms,
                    interval.logged,
                    interval.hp_before.map_or(String::new(), |v| v.to_string()),
                    interval.hp_after.map_or(String::new(), |v| v.to_string()),
                    interval.residual,
                    interval.bucket,
                    interval.is_anchor,
                )?;
            }
        }

        let totals = audit.totals;
        corpus.totals += totals;

        let mut healed_by_enemy: Vec<(EnemyType, i64)> = Vec::new();
        for (enemy_type, stats) in per_enemy_stats(&audit) {
            if stats.healed_damage > 0 {
                healed_by_enemy.push((enemy_type, stats.healed_damage));
            }
            merge_enemy(&mut corpus.per_enemy, enemy_type, stats);
        }

        for suspect in &audit.shared_pool_suspects {
            let entry = corpus
                .shared_pools
                .entry((suspect.parent_index, suspect.max_hp))
                .or_insert_with(|| (suspect.target_indices.clone(), 0));
            entry.1 += 1;
        }

        summaries.push(LogSummary {
            id,
            quest_id: encounter.quest_id,
            logged: totals.logged_damage,
            // Ranked on the same population as the verdict, so the worst-offender
            // list points at logs worth opening.
            hp_removed: totals.hp_removed,
            under_logged: totals.under_logged,
            healed_by_enemy,
            unmeasured: totals.unmeasured_damage,
        });
    }

    if let Some(writer) = csv.as_mut() {
        writer.flush()?;
    }

    // Only now, with the whole corpus in hand, can systematic regeneration be
    // told apart from a one-off discrepancy.
    let outliers = if auto_outliers {
        classify_regen_outliers(&corpus.per_enemy)
    } else {
        Vec::new()
    };
    let healed_known: i64 = corpus
        .per_enemy
        .iter()
        .filter(|(enemy_type, _, _)| outliers.contains(enemy_type))
        .map(|(_, stats, _)| stats.healed_damage)
        .sum();
    let healed_unclassified = corpus.totals.healed - healed_known;

    report(
        &db_path,
        &corpus,
        &summaries,
        &outliers,
        healed_known,
        healed_unclassified,
        &unreadable,
        options,
        auto_outliers,
    );

    let unexplained = corpus.totals.under_logged + healed_unclassified;
    let Some(share) = fraction(unexplained, corpus.totals.hp_removed) else {
        println!("\nVERDICT: nothing measurable — no HP data in this corpus.");
        std::process::exit(2);
    };

    let pct = share * 100.0;
    println!();
    println!("VERDICT");
    println!(
        "  measured against {} HP observed lost across {} intervals:",
        commas(corpus.totals.hp_removed),
        corpus.totals.intervals
    );
    if pct <= threshold_pct {
        println!(
            "  damage logging is correct within {pct:.4}%  (threshold {threshold_pct:.4}% — PASS)"
        );
    } else {
        println!(
            "  damage logging is correct only within {pct:.4}%  (threshold {threshold_pct:.4}% — FAIL)"
        );
    }
    if pct <= threshold_pct {
        Ok(())
    } else {
        std::process::exit(1);
    }
}

#[allow(clippy::too_many_arguments)]
fn report(
    db_path: &Path,
    corpus: &Corpus,
    summaries: &[LogSummary],
    outliers: &[EnemyType],
    healed_known: i64,
    healed_unclassified: i64,
    unreadable: &[(u64, String)],
    options: AuditOptions,
    auto_outliers: bool,
) {
    println!("DAMAGE AUDIT — {}", db_path.display());
    println!(
        "logs: {} scanned, {} carrying HP data, {} unreadable",
        corpus.logs_scanned,
        corpus.logs_with_hp,
        unreadable.len()
    );
    if !options.anchor_at_max_hp {
        println!("(--no-anchor: spawns are not assumed to start at full HP)");
    }
    if !auto_outliers {
        println!("(--no-auto-outliers: every heal counts as unexplained)");
    }

    println!();
    println!("CORPUS TOTALS");
    println!("  logged damage ............ {}", commas(corpus.totals.logged_damage));
    println!("  HP removed (measured) .... {}", commas(corpus.totals.hp_removed));
    println!(
        "  overkill (explained) ..... {}{}",
        commas(corpus.totals.overkill),
        share_of(corpus.totals.overkill, corpus.totals.logged_damage)
    );
    println!(
        "  regen, known enemies ..... {}{}",
        commas(healed_known),
        share_of(healed_known, corpus.totals.hp_removed)
    );
    println!(
        "  regen, unclassified ...... {}{}",
        commas(healed_unclassified),
        share_of(healed_unclassified, corpus.totals.hp_removed)
    );
    println!(
        "  UNDER-LOGGED ............. {}{}",
        commas(corpus.totals.under_logged),
        share_of(corpus.totals.under_logged, corpus.totals.hp_removed)
    );
    println!(
        "  unmeasured damage ........ {}{}",
        commas(corpus.totals.unmeasured_damage),
        share_of(corpus.totals.unmeasured_damage, corpus.totals.logged_damage)
    );
    println!(
        "  unverifiable anchors ..... {}{}",
        commas(corpus.totals.anchor_unverified_damage),
        share_of(corpus.totals.anchor_unverified_damage, corpus.totals.logged_damage)
    );
    println!(
        "  intervals ................ {} ({} exact)",
        corpus.totals.intervals, corpus.totals.matched_intervals
    );

    println!();
    if outliers.is_empty() {
        println!("KNOWN-REGEN ENEMIES: none met the bar");
    } else {
        println!(
            "KNOWN-REGEN ENEMIES (derived: heals in ≥{REGEN_MIN_LOGS} logs and ≥{:.0}% of intervals)",
            REGEN_MIN_INTERVAL_SHARE * 100.0
        );
        for (enemy_type, stats, logs) in &corpus.per_enemy {
            if !outliers.contains(enemy_type) {
                continue;
            }
            println!(
                "  {}  {} logs, {:.1}% of intervals, {} HP",
                enemy_label(*enemy_type),
                logs,
                stats.healed_intervals as f64 / stats.intervals.max(1) as f64 * 100.0,
                commas(stats.healed_damage),
            );
        }
    }

    let mut worst: Vec<&LogSummary> = summaries
        .iter()
        .filter(|summary| summary.hp_removed > 0 && summary.unexplained(outliers) > 0)
        .collect();
    worst.sort_by(|a, b| {
        fraction(b.unexplained(outliers), b.hp_removed)
            .partial_cmp(&fraction(a.unexplained(outliers), a.hp_removed))
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    println!();
    if worst.is_empty() {
        // Distinguish "nothing left unexplained" from "nothing was measurable" —
        // an empty list read as a clean bill of health once already, while the
        // verdict on the same run said FAIL.
        if corpus.totals.hp_removed > 0 {
            println!("WORST LOGS: none — every measurable log reconciled exactly");
        } else {
            println!("WORST LOGS: none measurable — no log in this corpus carried HP data");
        }
    } else {
        println!("WORST LOGS BY UNEXPLAINED SHARE");
        for summary in worst.iter().take(15) {
            println!(
                "  log {:<6} quest {:<12} {:>9}  under-logged {}, regen {}, unmeasured {} of {}",
                summary.id,
                summary
                    .quest_id
                    .map_or("—".to_string(), |id| format!("0x{id:08X}")),
                percent(summary.unexplained(outliers), summary.hp_removed),
                commas(summary.under_logged),
                commas(summary.healed_unclassified(outliers)),
                percent(summary.unmeasured, summary.logged),
                commas(summary.logged),
            );
        }
    }

    let mut by_enemy: Vec<&(EnemyType, EnemyStats, usize)> = corpus
        .per_enemy
        .iter()
        .filter(|(_, stats, _)| stats.hp_removed > 0 && stats.under_logged > 0)
        .collect();
    by_enemy.sort_by(|a, b| {
        fraction(b.1.under_logged, b.1.hp_removed)
            .partial_cmp(&fraction(a.1.under_logged, a.1.hp_removed))
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    println!();
    if by_enemy.is_empty() {
        println!("WORST ENEMIES: none under-logged");
    } else {
        println!("WORST ENEMIES BY UNDER-LOGGED SHARE");
        for (enemy_type, stats, _) in by_enemy.iter().take(15) {
            println!(
                "  {}  {:>8}  {} of {} HP over {} intervals",
                enemy_label(*enemy_type),
                percent(stats.under_logged, stats.hp_removed),
                commas(stats.under_logged),
                commas(stats.hp_removed),
                stats.intervals,
            );
        }
    }

    if !corpus.shared_pools.is_empty() {
        println!();
        println!("SHARED-POOL SUSPECTS (sibling parts reporting one max HP — ExEmGroupHp is unverified)");
        for ((parent, max), (indices, logs)) in corpus.shared_pools.iter().take(10) {
            println!(
                "  parent {parent}  max {}  parts {:?}  in {logs} logs",
                commas(*max as i64),
                indices
            );
        }
    }

    if !unreadable.is_empty() {
        println!();
        println!("UNREADABLE LOGS");
        for (id, err) in unreadable.iter().take(10) {
            println!("  log {id}: {err}");
        }
    }

    println!();
    println!("CAVEATS");
    println!("  - When the game's damage field reads <= 0 the hook substitutes the observed");
    println!("    HP drop, so those events match by construction and flatter the exact count.");
    println!("  - DoT ticks carry no HP pair; their damage is credited to the interval that");
    println!("    encloses them, not measured on its own.");
    println!("  - Unmeasured damage is excluded from the denominator, never scored as correct.");
    println!("  - Some bosses report a max HP that does not describe the pool their current HP");
    println!("    drains. Opening intervals the data contradicts are counted as unverifiable");
    println!("    anchors, not as missed damage; --no-anchor drops them entirely.");
}

/// Decode a stored log down to its raw event log, skipping the derived-state
/// reparse the app needs and this tool does not.
fn decode_encounter(blob: &[u8], version: u8) -> Result<Encounter> {
    let mut encounter = if version == 0 {
        gbfr_logs::parser::deserialize_version(blob, version)?.encounter
    } else {
        Encounter::from_blob(blob)?
    };
    encounter.repopulate_event_log();
    Ok(encounter)
}

fn merge_enemy(
    per_enemy: &mut Vec<(EnemyType, EnemyStats, usize)>,
    enemy_type: EnemyType,
    stats: EnemyStats,
) {
    let healed_here = stats.healed_intervals > 0;
    match per_enemy
        .iter_mut()
        .find(|(known, _, _)| *known == enemy_type)
    {
        Some((_, total, logs)) => {
            *total += stats;
            if healed_here {
                *logs += 1;
            }
        }
        None => per_enemy.push((enemy_type, stats, usize::from(healed_here))),
    }
}

fn enemy_label(enemy_type: EnemyType) -> String {
    match enemy_type {
        EnemyType::Unknown(hash) => format!("0x{hash:08X}"),
    }
}

fn fraction(numerator: i64, denominator: i64) -> Option<f64> {
    (denominator > 0).then(|| numerator as f64 / denominator as f64)
}

fn percent(numerator: i64, denominator: i64) -> String {
    fraction(numerator, denominator)
        .map_or("—".to_string(), |share| format!("{:.4}%", share * 100.0))
}

fn share_of(numerator: i64, denominator: i64) -> String {
    fraction(numerator, denominator)
        .map_or(String::new(), |share| format!("  ({:.4}%)", share * 100.0))
}

/// Thousands separators: these numbers run to twelve digits and are unreadable
/// without them.
fn commas(value: i64) -> String {
    let negative = value < 0;
    let digits = value.unsigned_abs().to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3 + 1);

    for (position, digit) in digits.chars().enumerate() {
        if position > 0 && (digits.len() - position) % 3 == 0 {
            out.push(',');
        }
        out.push(digit);
    }

    if negative {
        format!("-{out}")
    } else {
        out
    }
}
