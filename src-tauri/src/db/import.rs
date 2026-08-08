//! Merging another installation's `logs.db` into this one.
//!
//! The source is any database with a `logs` table from this app's schema
//! lineage — column differences are expected (an older install lacks the
//! newer columns) and handled by copying only the columns the source has.
//! Every blob is deserialized with the current parser before it is inserted,
//! so a source whose stored-log format has diverged cannot plant encounters
//! the log viewer will fail to open.

use std::{collections::HashSet, path::Path};

use anyhow::{bail, Context, Result};
use rusqlite::{params, params_from_iter, types::Value, Connection, OpenFlags};
use serde::Serialize;

use crate::parser::v1::DataCoverage;

/// Columns a log row cannot be imported without. Their order here fixes their
/// positions in the SELECT below.
const REQUIRED_COLUMNS: &[&str] = &["name", "time", "duration", "data", "version"];

/// Metadata columns copied verbatim when the source has them. Everything not
/// listed (id, run_id, room_index, total_damage, legality_rules_version) is
/// deliberately left to its default: ids must not collide, Conflux run linkage
/// is meaningless without the source's `runs` table, and a NULL legality stamp
/// marks the row for the next startup sweep to audit.
const OPTIONAL_COLUMNS: &[&str] = &[
    "primary_target",
    "p1_name",
    "p1_type",
    "p2_name",
    "p2_type",
    "p3_name",
    "p3_type",
    "p4_name",
    "p4_type",
    "quest_id",
    "quest_elapsed_time",
    "quest_completed",
];

/// Sub-second "encounters" are stray hits, not fights: the reference corpus's
/// junk rows each hold 1-3 damage events spanning under half a second, stored
/// with 1ms durations that the quest list draws as 0:00. Imports drop them.
const MIN_IMPORT_DURATION_MS: i64 = 1_000;

/// How many example rows each classification keeps for the import dialog's
/// tooltips.
const MAX_EXAMPLES: usize = 5;

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    /// Rows copied into this database.
    pub imported: u32,
    /// Rows skipped because an encounter with the same timestamp and duration
    /// is already here.
    pub duplicates: u32,
    /// Rows skipped because the current parser could not deserialize their
    /// blob.
    pub unreadable: u32,
    /// Rows skipped as junk (shorter than [`MIN_IMPORT_DURATION_MS`]).
    pub filtered: u32,
}

/// One source row, as the import dialog's example tooltips draw it.
#[derive(Debug, Serialize, PartialEq, Eq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LogExample {
    pub time: i64,
    pub duration: i64,
    pub quest_id: Option<u32>,
}

/// Up to [`MAX_EXAMPLES`] rows per classification, so each line of the import
/// dialog's summary can show what it is talking about.
#[derive(Debug, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportExamples {
    pub total: Vec<LogExample>,
    pub duplicates: Vec<LogExample>,
    pub unreadable: Vec<LogExample>,
    pub filtered: Vec<LogExample>,
    pub importable: Vec<LogExample>,
}

impl ImportExamples {
    fn push(bucket: &mut Vec<LogExample>, example: &LogExample) {
        if bucket.len() < MAX_EXAMPLES {
            bucket.push(example.clone());
        }
    }
}

/// What an import of a given source would carry across, gathered by decoding
/// every blob the way the log viewer would. The per-category counts cover only
/// the logs that would actually be imported (readable and not already here).
#[derive(Debug, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportAnalysis {
    /// Rows in the source's `logs` table.
    pub total: u32,
    /// Rows an import would copy: readable, not junk, not already here.
    pub importable: u32,
    /// Rows skipped as already present (same timestamp and duration).
    pub duplicates: u32,
    /// Rows the current parser cannot deserialize.
    pub unreadable: u32,
    /// Rows skipped as junk (shorter than [`MIN_IMPORT_DURATION_MS`]).
    pub filtered: u32,
    /// Example rows per classification, for the dialog's tooltips.
    pub examples: ImportExamples,
    /// Of the importable logs, how many carry each kind of data.
    pub with_party_names: u32,
    pub with_equipment: u32,
    pub with_enemy_hp: u32,
    pub with_overcap: u32,
    pub with_deaths: u32,
    pub with_stun_events: u32,
    pub with_sba_events: u32,
    pub with_quest: u32,
    pub with_quest_time: u32,
}

/// Open the `logs.db` at `path` and run `work` against it.
///
/// Opened read-only first; if anything fails (a WAL database left needing
/// recovery cannot even be queried without write access to its sidecars) the
/// whole run is retried on a writable connection, which lets SQLite recover.
pub(crate) fn with_source<T>(
    path: &Path,
    mut work: impl FnMut(&Connection) -> Result<T>,
) -> Result<T> {
    let read_only = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(anyhow::Error::from)
        .and_then(|source| work(&source));

    match read_only {
        Ok(value) => Ok(value),
        Err(_) => {
            let source = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)
                .with_context(|| format!("could not open {}", path.display()))?;
            work(&source)
        }
    }
}

/// Import every encounter from the `logs.db` at `path` into `dest`.
/// `on_progress` is called as `(rows examined so far, total rows)` — the same
/// shape the analysis pass reports, so one progress bar serves both.
pub fn import_logs_from_file(
    dest: &Connection,
    path: &Path,
    mut on_progress: impl FnMut(u32, u32),
) -> Result<ImportSummary> {
    with_source(path, |source| {
        import_logs_with_progress(dest, source, &mut on_progress)
    })
}

/// Analyze the `logs.db` at `path` without changing anything: what would an
/// import copy, and what data do those logs actually carry? `on_progress` is
/// called as `(rows classified so far, total rows)`.
pub fn analyze_logs_db_file(
    dest: &Connection,
    path: &Path,
    mut on_progress: impl FnMut(u32, u32),
) -> Result<ImportAnalysis> {
    with_source(path, |source| {
        analyze_logs_with_progress(dest, source, &mut on_progress)
    })
}

/// One source row, classified. The single definition of the import's rules —
/// the dry run and the import both route through [`classify`], so the
/// dialog's forecast and the import's outcome agree by construction.
enum Classification {
    /// Junk (shorter than [`MIN_IMPORT_DURATION_MS`]).
    Filtered,
    /// An encounter with this timestamp and duration is already accounted for.
    Duplicate,
    /// The current parser cannot deserialize the blob.
    Unreadable,
    /// Would import; carries the decoded encounter for coverage and the
    /// identity backfill.
    Importable(crate::parser::v1::Encounter),
}

/// `seen` holds every `(time, duration)` already claimed — the destination's
/// rows (see [`existing_log_keys`]) plus every source row classified here
/// before — so re-imports, source-internal duplicates, and rows imported
/// earlier in the same pass all land as `Duplicate`. `blob` is only called
/// for rows that pass the cheap checks: `data` is by far the widest column,
/// and copying it out of SQLite for a row the duration filter drops is the
/// bulk of what a full re-import of an unchanged file would cost.
fn classify(
    seen: &mut HashSet<(i64, i64)>,
    time: i64,
    duration: i64,
    blob: impl FnOnce() -> rusqlite::Result<(Vec<u8>, u8)>,
) -> Result<Classification> {
    if duration < MIN_IMPORT_DURATION_MS {
        return Ok(Classification::Filtered);
    }
    if !seen.insert((time, duration)) {
        return Ok(Classification::Duplicate);
    }
    let (data, version) = blob()?;
    Ok(match crate::parser::deserialize_encounter(&data, version) {
        Ok(encounter) => Classification::Importable(encounter),
        Err(_) => Classification::Unreadable,
    })
}

/// Every `(time, duration)` already in the destination, in one query. Probing
/// the destination per source row instead means a full scan of its `logs`
/// table per probe — nothing indexes these columns.
fn existing_log_keys(dest: &Connection) -> Result<HashSet<(i64, i64)>> {
    let mut stmt = dest.prepare("SELECT time, duration FROM logs")?;
    let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// The read-only dry run behind [`analyze_logs_db_file`]. Classifies every
/// source row the exact way [`import_logs_with_progress`] will (both call
/// [`classify`]), and aggregates [`DataCoverage`] over the rows an import
/// would copy.
pub fn analyze_logs_with_progress(
    dest: &Connection,
    source: &Connection,
    mut on_progress: impl FnMut(u32, u32),
) -> Result<ImportAnalysis> {
    let source_columns = require_log_columns(source)?;
    let source_rows: u32 = source.query_row("SELECT COUNT(*) FROM logs", [], |r| r.get(0))?;

    // Old schemas have no quest_id column; the example rows show a dash there.
    let quest_id_expr = if source_columns.iter().any(|c| c == "quest_id") {
        "quest_id"
    } else {
        "NULL"
    };
    let mut select = source.prepare(&format!(
        "SELECT time, duration, data, version, {quest_id_expr} FROM logs"
    ))?;

    let mut analysis = ImportAnalysis::default();
    let mut seen = existing_log_keys(dest)?;

    let mut rows = select.query([])?;
    while let Some(row) = rows.next()? {
        let time: i64 = row.get(0)?;
        let duration: i64 = row.get(1)?;
        let example = LogExample {
            time,
            duration,
            quest_id: row.get(4)?,
        };
        analysis.total += 1;
        on_progress(analysis.total, source_rows);
        ImportExamples::push(&mut analysis.examples.total, &example);

        let encounter =
            match classify(&mut seen, time, duration, || Ok((row.get(2)?, row.get(3)?)))? {
                Classification::Filtered => {
                    analysis.filtered += 1;
                    ImportExamples::push(&mut analysis.examples.filtered, &example);
                    continue;
                }
                Classification::Duplicate => {
                    analysis.duplicates += 1;
                    ImportExamples::push(&mut analysis.examples.duplicates, &example);
                    continue;
                }
                Classification::Unreadable => {
                    analysis.unreadable += 1;
                    ImportExamples::push(&mut analysis.examples.unreadable, &example);
                    continue;
                }
                Classification::Importable(encounter) => encounter,
            };
        analysis.importable += 1;
        ImportExamples::push(&mut analysis.examples.importable, &example);

        let DataCoverage {
            party_names,
            equipment,
            enemy_hp,
            overcap,
            deaths,
            stun_events,
            sba_events,
            quest,
            quest_time,
        } = encounter.data_coverage();
        analysis.with_party_names += u32::from(party_names);
        analysis.with_equipment += u32::from(equipment);
        analysis.with_enemy_hp += u32::from(enemy_hp);
        analysis.with_overcap += u32::from(overcap);
        analysis.with_deaths += u32::from(deaths);
        analysis.with_stun_events += u32::from(stun_events);
        analysis.with_sba_events += u32::from(sba_events);
        analysis.with_quest += u32::from(quest);
        analysis.with_quest_time += u32::from(quest_time);
    }

    Ok(analysis)
}

/// The source's `logs` columns, after checking every required one is there.
fn require_log_columns(source: &Connection) -> Result<Vec<String>> {
    let source_columns: Vec<String> = source
        .prepare("SELECT name FROM pragma_table_info('logs')")?
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;

    for required in REQUIRED_COLUMNS {
        if !source_columns.iter().any(|c| c == required) {
            bail!("not a logs database: no `logs.{required}` column");
        }
    }

    Ok(source_columns)
}

/// Copy every log row from `source` into `dest`, skipping duplicates and
/// blobs the current parser rejects. All inserts land in one transaction.
/// `on_progress` is called as `(rows examined so far, total rows)` — the same
/// shape the analysis pass reports.
pub fn import_logs_with_progress(
    dest: &Connection,
    source: &Connection,
    mut on_progress: impl FnMut(u32, u32),
) -> Result<ImportSummary> {
    let source_columns = require_log_columns(source)?;
    let source_rows: u32 = source.query_row("SELECT COUNT(*) FROM logs", [], |r| r.get(0))?;

    let copied: Vec<&str> = REQUIRED_COLUMNS
        .iter()
        .copied()
        .chain(
            OPTIONAL_COLUMNS
                .iter()
                .copied()
                .filter(|c| source_columns.iter().any(|s| s == c)),
        )
        .collect();

    let mut select = source.prepare(&format!("SELECT {} FROM logs", copied.join(", ")))?;
    // Every copied row is stamped `imported` so the UI can mark it as possibly
    // missing data its source never recorded.
    let insert_sql = format!(
        "INSERT INTO logs ({}, imported) VALUES ({}, 1)",
        copied.join(", "),
        vec!["?"; copied.len()].join(", ")
    );

    // Where the identity columns landed in `copied` (absent on old schemas):
    // a row with no value in any of them gets its character types backfilled
    // from the blob's damage events.
    let identity_positions: Vec<usize> = [
        "p1_name", "p1_type", "p2_name", "p2_type", "p3_name", "p3_type", "p4_name", "p4_type",
    ]
    .iter()
    .filter_map(|column| copied.iter().position(|c| c == column))
    .collect();

    let tx = dest.unchecked_transaction()?;
    let mut summary = ImportSummary {
        imported: 0,
        duplicates: 0,
        unreadable: 0,
        filtered: 0,
    };
    {
        let mut insert = tx.prepare(&insert_sql)?;
        let mut backfill = tx.prepare(
            "UPDATE logs SET p1_type = ?, p2_type = ?, p3_type = ?, p4_type = ? WHERE id = ?",
        )?;
        let mut seen = existing_log_keys(&tx)?;
        let mut examined: u32 = 0;

        let mut rows = select.query([])?;
        while let Some(row) = rows.next()? {
            // Positions fixed by REQUIRED_COLUMNS leading the SELECT.
            let time: i64 = row.get(1)?;
            let duration: i64 = row.get(2)?;
            examined += 1;
            on_progress(examined, source_rows);

            let encounter =
                match classify(&mut seen, time, duration, || Ok((row.get(3)?, row.get(4)?)))? {
                    Classification::Filtered => {
                        summary.filtered += 1;
                        continue;
                    }
                    Classification::Duplicate => {
                        summary.duplicates += 1;
                        continue;
                    }
                    Classification::Unreadable => {
                        summary.unreadable += 1;
                        continue;
                    }
                    Classification::Importable(encounter) => encounter,
                };

            let values: Vec<Value> = (0..copied.len())
                .map(|i| row.get(i))
                .collect::<rusqlite::Result<_>>()?;

            // Sources that never recorded player identity leave every party
            // column empty. The characters (not the names — those are truly
            // gone) can still be read off the damage events, the same way the
            // meter derives its rows.
            let identity_absent = identity_positions
                .iter()
                .all(|&i| matches!(values[i], Value::Null));

            insert.execute(params_from_iter(values))?;
            summary.imported += 1;

            if identity_absent {
                let characters = encounter.derive_party_characters();
                if !characters.is_empty() {
                    let slot = |i: usize| characters.get(i).map(|character| character.to_string());
                    backfill.execute(params![
                        slot(0),
                        slot(1),
                        slot(2),
                        slot(3),
                        tx.last_insert_rowid()
                    ])?;
                }
            }
        }
    }
    tx.commit()?;

    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// [`analyze_logs_with_progress`] without the progress reporting — only
    /// the tests want that; production always reports.
    fn analyze_logs(dest: &Connection, source: &Connection) -> Result<ImportAnalysis> {
        analyze_logs_with_progress(dest, source, |_, _| {})
    }

    /// [`import_logs_with_progress`] without the progress reporting.
    fn import_logs(dest: &Connection, source: &Connection) -> Result<ImportSummary> {
        import_logs_with_progress(dest, source, |_, _| {})
    }

    fn migrated() -> Connection {
        let mut conn = Connection::open_in_memory().expect("in-memory db");
        crate::db::migrations()
            .to_latest(&mut conn)
            .expect("migrations apply");
        conn
    }

    /// A blob the current parser accepts as a v1 encounter.
    fn valid_blob() -> Vec<u8> {
        crate::parser::v1::Encounter::default()
            .to_blob()
            .expect("serialize an empty encounter")
    }

    /// A source with the schema an install from before the Conflux and
    /// legality columns would have.
    fn older_schema_source() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory db");
        conn.execute_batch(
            r#"CREATE TABLE logs (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                time INTEGER NOT NULL,
                duration INTEGER NOT NULL,
                data BLOB NOT NULL,
                version INTEGER NOT NULL DEFAULT 0,
                primary_target INTEGER,
                p1_name TEXT, p1_type TEXT,
                p2_name TEXT, p2_type TEXT,
                p3_name TEXT, p3_type TEXT,
                p4_name TEXT, p4_type TEXT,
                quest_id INTEGER,
                quest_elapsed_time INTEGER,
                quest_completed BOOLEAN
            )"#,
        )
        .expect("create source schema");
        conn
    }

    #[test]
    fn copies_rows_and_metadata_from_an_older_schema() {
        let dest = migrated();
        let source = older_schema_source();
        source
            .execute(
                "INSERT INTO logs (name, time, duration, data, version, primary_target,
                                   p1_name, p1_type, quest_id, quest_completed)
                 VALUES ('', 1000, 60000, ?, 1, 123, 'Kahs', 'Pl1400', 77, 1)",
                params![valid_blob()],
            )
            .expect("insert source row");

        let summary = import_logs(&dest, &source).expect("import");

        assert_eq!(
            summary,
            ImportSummary {
                imported: 1,
                duplicates: 0,
                unreadable: 0,
                filtered: 0
            }
        );
        let (time, p1_name, quest_id, run_id, stamp, imported) = dest
            .query_row(
                "SELECT time, p1_name, quest_id, run_id, legality_rules_version, imported FROM logs",
                [],
                |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, u32>(2)?,
                        r.get::<_, Option<i64>>(3)?,
                        r.get::<_, Option<u32>>(4)?,
                        r.get::<_, bool>(5)?,
                    ))
                },
            )
            .expect("read imported row");
        assert_eq!((time, p1_name.as_str(), quest_id), (1000, "Kahs", 77));
        assert_eq!(run_id, None, "no Conflux linkage without the source's runs");
        assert_eq!(stamp, None, "left unstamped so the startup sweep audits it");
        assert!(imported, "stamped imported so the UI can mark it");
    }

    /// Same (time, duration) means the same encounter, wherever it came from —
    /// so re-importing the same database is a no-op.
    #[test]
    fn skips_encounters_already_present_making_reimport_idempotent() {
        let dest = migrated();
        let source = older_schema_source();
        for time in [1000, 2000] {
            source
                .execute(
                    "INSERT INTO logs (name, time, duration, data, version) VALUES ('', ?, 60000, ?, 1)",
                    params![time, valid_blob()],
                )
                .expect("insert source row");
        }

        let first = import_logs(&dest, &source).expect("first import");
        assert_eq!(first.imported, 2);

        let second = import_logs(&dest, &source).expect("second import");
        assert_eq!(
            second,
            ImportSummary {
                imported: 0,
                duplicates: 2,
                unreadable: 0,
                filtered: 0
            }
        );
        let count: u32 = dest
            .query_row("SELECT COUNT(*) FROM logs", [], |r| r.get(0))
            .expect("count");
        assert_eq!(count, 2);
    }

    /// A blob our parser rejects is left behind, not imported as a row the log
    /// viewer would then fail to open. The readable rows still come across.
    #[test]
    fn unreadable_blobs_are_counted_and_the_rest_import() {
        let dest = migrated();
        let source = older_schema_source();
        source
            .execute(
                "INSERT INTO logs (name, time, duration, data, version) VALUES ('', 1000, 60000, x'00', 1)",
                [],
            )
            .expect("insert junk row");
        source
            .execute(
                "INSERT INTO logs (name, time, duration, data, version) VALUES ('', 2000, 60000, ?, 1)",
                params![valid_blob()],
            )
            .expect("insert good row");

        let summary = import_logs(&dest, &source).expect("import");

        assert_eq!(
            summary,
            ImportSummary {
                imported: 1,
                duplicates: 0,
                unreadable: 1,
                filtered: 0
            }
        );
    }

    /// The oldest schema this lineage ever shipped — nothing but the base
    /// columns — still imports.
    #[test]
    fn a_source_with_only_the_base_columns_imports() {
        let dest = migrated();
        let source = Connection::open_in_memory().expect("in-memory db");
        source
            .execute_batch(
                "CREATE TABLE logs (
                    id INTEGER PRIMARY KEY, name TEXT NOT NULL, time INTEGER NOT NULL,
                    duration INTEGER NOT NULL, data BLOB NOT NULL,
                    version INTEGER NOT NULL DEFAULT 0
                )",
            )
            .expect("create bare schema");
        source
            .execute(
                "INSERT INTO logs (name, time, duration, data, version) VALUES ('', 1000, 60000, ?, 1)",
                params![valid_blob()],
            )
            .expect("insert source row");

        let summary = import_logs(&dest, &source).expect("import");

        assert_eq!(summary.imported, 1);
    }

    /// Picking a database that is not a logs.db reports an error instead of
    /// silently importing nothing.
    #[test]
    fn a_database_without_a_logs_table_is_rejected() {
        let dest = migrated();
        let source = Connection::open_in_memory().expect("in-memory db");

        let err = import_logs(&dest, &source).expect_err("reject");

        assert!(err.to_string().contains("not a logs database"));
    }

    /// A blob whose encounter carries HP samples, SBA events, and a quest
    /// timer — the parts of [`DataCoverage`] constructible outside the parser
    /// module (player slots have private fields and are covered by the
    /// coverage tests in `parser::v1`).
    fn rich_blob() -> Vec<u8> {
        let actor = protocol::Actor {
            index: 0,
            actor_type: 0,
            parent_index: 0,
            parent_actor_type: 0,
        };
        crate::parser::v1::Encounter {
            quest_id: Some(77),
            quest_timer: Some(120),
            raw_event_log: vec![
                (
                    0,
                    protocol::Message::DamageEvent(protocol::DamageEvent {
                        source: actor.clone(),
                        target: actor,
                        damage: 100,
                        flags: 0,
                        action_id: protocol::ActionType::Normal(1),
                        attack_rate: None,
                        stun_value: None,
                        damage_cap: None,
                        base_damage: None,
                        target_current_hp: Some(1_000_000),
                        target_max_hp: Some(1_000_000),
                        class_flags: None,
                    }),
                ),
                (
                    1,
                    protocol::Message::OnUpdateSBA(protocol::OnUpdateSBAEvent {
                        actor_index: 0,
                        sba_value: 10.0,
                        sba_added: 1.0,
                    }),
                ),
            ],
            ..Default::default()
        }
        .to_blob()
        .expect("serialize the rich encounter")
    }

    /// The analysis classifies rows exactly as an import would — duplicate,
    /// unreadable, importable — and counts data categories over the importable
    /// rows only.
    #[test]
    fn analysis_classifies_rows_and_counts_coverage() {
        let dest = migrated();
        let source = older_schema_source();
        // Already in dest → duplicate.
        source
            .execute(
                "INSERT INTO logs (name, time, duration, data, version) VALUES ('', 1000, 60000, ?, 1)",
                params![valid_blob()],
            )
            .expect("insert dup row");
        dest.execute(
            "INSERT INTO logs (name, time, duration, data, version) VALUES ('', 1000, 60000, x'00', 1)",
            [],
        )
        .expect("pre-existing dest row");
        // Junk blob → unreadable.
        source
            .execute(
                "INSERT INTO logs (name, time, duration, data, version) VALUES ('', 2000, 60000, x'00', 1)",
                [],
            )
            .expect("insert junk row");
        // Fresh, with HP + SBA + quest-timer data.
        source
            .execute(
                "INSERT INTO logs (name, time, duration, data, version) VALUES ('', 3000, 60000, ?, 1)",
                params![rich_blob()],
            )
            .expect("insert rich row");

        let analysis = analyze_logs(&dest, &source).expect("analyze");

        assert_eq!(
            (
                analysis.total,
                analysis.importable,
                analysis.duplicates,
                analysis.unreadable,
                analysis.filtered,
            ),
            (3, 1, 1, 1, 0)
        );
        assert_eq!(
            (
                analysis.with_enemy_hp,
                analysis.with_sba_events,
                analysis.with_quest,
                analysis.with_quest_time,
                analysis.with_party_names,
            ),
            (1, 1, 1, 1, 0)
        );
        // Each classification's tooltip examples show the rows it counted.
        assert_eq!(analysis.examples.total.len(), 3);
        assert_eq!(analysis.examples.duplicates[0].time, 1000);
        assert_eq!(analysis.examples.unreadable[0].time, 2000);
        assert_eq!(analysis.examples.importable[0].time, 3000);
        assert!(analysis.examples.filtered.is_empty());
    }

    /// Sub-second rows are stray single hits, not fights; the analysis
    /// reports them as filtered and the import leaves them behind — and the
    /// two agree, whatever else the row would have classified as.
    #[test]
    fn sub_second_junk_is_filtered_by_analysis_and_import_alike() {
        let dest = migrated();
        let source = older_schema_source();
        source
            .execute(
                "INSERT INTO logs (name, time, duration, data, version) VALUES ('', 1000, 1, ?, 1)",
                params![valid_blob()],
            )
            .expect("insert junk row");
        source
            .execute(
                "INSERT INTO logs (name, time, duration, data, version) VALUES ('', 2000, 60000, ?, 1)",
                params![valid_blob()],
            )
            .expect("insert real row");

        let analysis = analyze_logs(&dest, &source).expect("analyze");
        assert_eq!(
            (analysis.total, analysis.importable, analysis.filtered),
            (2, 1, 1)
        );
        assert_eq!(analysis.examples.filtered[0].duration, 1);

        let summary = import_logs(&dest, &source).expect("import");
        assert_eq!((summary.imported, summary.filtered), (1, 1));

        let durations: Vec<i64> = dest
            .prepare("SELECT duration FROM logs")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(durations, vec![60000], "only the real fight landed");
    }

    /// Example lists are tooltips, not dumps: five per classification, however
    /// many rows the classification counted.
    #[test]
    fn example_lists_cap_at_five() {
        let dest = migrated();
        let source = older_schema_source();
        for time in 0..7 {
            source
                .execute(
                    "INSERT INTO logs (name, time, duration, data, version) VALUES ('', ?, 60000, ?, 1)",
                    params![time * 1000, valid_blob()],
                )
                .expect("insert row");
        }

        let analysis = analyze_logs(&dest, &source).expect("analyze");

        assert_eq!(analysis.importable, 7);
        assert_eq!(analysis.examples.total.len(), 5);
        assert_eq!(analysis.examples.importable.len(), 5);
    }

    /// Two identical rows inside the source: an import copies the first and
    /// skips the second, so the analysis must promise the same.
    #[test]
    fn analysis_counts_a_source_internal_duplicate_once() {
        let dest = migrated();
        let source = older_schema_source();
        for _ in 0..2 {
            source
                .execute(
                    "INSERT INTO logs (name, time, duration, data, version) VALUES ('', 1000, 60000, ?, 1)",
                    params![valid_blob()],
                )
                .expect("insert row");
        }

        let analysis = analyze_logs(&dest, &source).expect("analyze");

        assert_eq!((analysis.importable, analysis.duplicates), (1, 1));

        let summary = import_logs(&dest, &source).expect("import");
        assert_eq!(
            (summary.imported, summary.duplicates),
            (analysis.importable, analysis.duplicates),
            "the analysis and the import must agree"
        );
    }

    /// A blob whose only identity signal is its damage events' source hashes.
    fn player_damage_blob(hashes: &[u32]) -> Vec<u8> {
        let events = hashes
            .iter()
            .enumerate()
            .map(|(i, &hash)| {
                let actor = |actor_type: u32, index: u32| protocol::Actor {
                    index,
                    actor_type,
                    parent_index: index,
                    parent_actor_type: actor_type,
                };
                (
                    i as i64,
                    protocol::Message::DamageEvent(protocol::DamageEvent {
                        source: actor(hash, i as u32),
                        target: actor(0, 100),
                        damage: 100,
                        flags: 0,
                        action_id: protocol::ActionType::Normal(1),
                        attack_rate: None,
                        stun_value: None,
                        damage_cap: None,
                        base_damage: None,
                        target_current_hp: None,
                        target_max_hp: None,
                        class_flags: None,
                    }),
                )
            })
            .collect();
        crate::parser::v1::Encounter {
            raw_event_log: events,
            ..Default::default()
        }
        .to_blob()
        .expect("serialize the player-damage encounter")
    }

    /// A source that recorded no identity at all still gets its character
    /// columns backfilled from the damage events — names stay NULL, because
    /// nothing in the file carries them.
    #[test]
    fn identityless_rows_get_character_types_backfilled_from_damage() {
        let dest = migrated();
        let source = older_schema_source();
        source
            .execute(
                "INSERT INTO logs (name, time, duration, data, version) VALUES ('', 1000, 60000, ?, 1)",
                params![player_damage_blob(&[0x601AA977, 0x28AC1108])], // Pl1400, Pl1000
            )
            .expect("insert identityless row");

        import_logs(&dest, &source).expect("import");

        let (p1_name, p1_type, p2_type, p3_type) = dest
            .query_row(
                "SELECT p1_name, p1_type, p2_type, p3_type FROM logs",
                [],
                |r| {
                    Ok((
                        r.get::<_, Option<String>>(0)?,
                        r.get::<_, Option<String>>(1)?,
                        r.get::<_, Option<String>>(2)?,
                        r.get::<_, Option<String>>(3)?,
                    ))
                },
            )
            .expect("read imported row");
        assert_eq!(p1_name, None, "display names are not derivable");
        assert_eq!(p1_type.as_deref(), Some("Pl1400"));
        assert_eq!(p2_type.as_deref(), Some("Pl1000"));
        assert_eq!(p3_type, None);
    }

    /// A source that DID record identity is copied verbatim — the backfill
    /// never second-guesses recorded party columns.
    #[test]
    fn recorded_identity_is_never_overwritten_by_the_backfill() {
        let dest = migrated();
        let source = older_schema_source();
        source
            .execute(
                "INSERT INTO logs (name, time, duration, data, version, p1_name, p1_type)
                 VALUES ('', 1000, 60000, ?, 1, 'Kahs', 'Pl1600')",
                params![player_damage_blob(&[0x601AA977])], // derives Pl1400
            )
            .expect("insert row with identity");

        import_logs(&dest, &source).expect("import");

        let (p1_name, p1_type): (Option<String>, Option<String>) = dest
            .query_row("SELECT p1_name, p1_type FROM logs", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .expect("read imported row");
        assert_eq!(p1_name.as_deref(), Some("Kahs"));
        assert_eq!(p1_type.as_deref(), Some("Pl1600"));
    }

    /// Analysis is a dry run: nothing lands in the destination.
    #[test]
    fn analysis_writes_nothing() {
        let dest = migrated();
        let source = older_schema_source();
        source
            .execute(
                "INSERT INTO logs (name, time, duration, data, version) VALUES ('', 1000, 60000, ?, 1)",
                params![valid_blob()],
            )
            .expect("insert row");

        analyze_logs(&dest, &source).expect("analyze");

        let count: u32 = dest
            .query_row("SELECT COUNT(*) FROM logs", [], |r| r.get(0))
            .expect("count");
        assert_eq!(count, 0);
    }
}
