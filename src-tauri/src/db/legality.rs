//! Stored build-legality findings, one row per finding.
//!
//! The rules are cheap to run but the logs are not cheap to open — a full
//! re-audit of the database means decompressing and reparsing every blob. So
//! the verdicts are computed once, when an encounter is saved, and read back
//! from here by the log view and the Toolbox audit page.
//!
//! Stored verdicts can go stale when a rule changes, which is what
//! [`crate::legality::RULES_VERSION`] and the startup sweep exist to prevent.
//! Nothing here is the source of truth: the encounter blob is, and any row in
//! this table can be thrown away and rebuilt from it.

use anyhow::Result;
use rusqlite::{params, Connection};
use serde::Serialize;

use crate::legality::{Finding, Severity};

/// The table this module owns, in the shape the migration creates it. Kept
/// here so the tests exercise the real schema rather than a copy that could
/// drift away from the migration.
pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS legality_findings (
    log_id INTEGER NOT NULL,
    player_index INTEGER NOT NULL,
    display_name TEXT NOT NULL,
    character_type TEXT NOT NULL,
    severity TEXT NOT NULL,
    rule TEXT NOT NULL,
    payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS legality_findings_log ON legality_findings (log_id);
"#;

/// One stored finding, with the player it belongs to.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredFinding {
    /// Party slot 0-3 — the index into the encounter's `player_data`, so a
    /// caller holding the parsed encounter can line the two up.
    pub player_index: usize,
    pub display_name: String,
    pub character_type: String,
    pub finding: Finding,
}

/// The `severity` column's spelling. Stored as text rather than the serde
/// tag so a query can filter on it without parsing every payload.
fn severity_column(severity: Severity) -> &'static str {
    match severity {
        Severity::Impossible => "impossible",
        Severity::Improbable => "improbable",
    }
}

/// Writes one player's findings. Callers clear the log first — see
/// [`clear_findings`] — so this only ever appends.
pub fn write_findings(
    conn: &Connection,
    log_id: i64,
    player_index: usize,
    display_name: &str,
    character_type: &str,
    findings: &[Finding],
) -> Result<()> {
    let mut stmt = conn.prepare_cached(
        r#"INSERT INTO legality_findings (
                log_id, player_index, display_name, character_type, severity, rule, payload
            ) VALUES (?, ?, ?, ?, ?, ?, ?)"#,
    )?;

    for finding in findings {
        stmt.execute(params![
            log_id,
            player_index as i64,
            display_name,
            character_type,
            severity_column(finding.severity),
            // The rule's own serde spelling, so a query and the frontend agree
            // on one name per rule without a second mapping to keep in step.
            serde_json::to_value(finding.rule)?
                .as_str()
                .unwrap_or_default(),
            serde_json::to_string(finding)?,
        ])?;
    }

    Ok(())
}

/// Drops every finding stored for a log. Re-auditing calls this first, so a
/// rescan replaces a log's verdicts instead of doubling them.
pub fn clear_findings(conn: &Connection, log_id: i64) -> Result<()> {
    conn.execute(
        "DELETE FROM legality_findings WHERE log_id = ?",
        params![log_id],
    )?;
    Ok(())
}

/// Every stored finding for one log, in insertion order.
pub fn findings_for_log(conn: &Connection, log_id: i64) -> Result<Vec<StoredFinding>> {
    let mut stmt = conn.prepare_cached(
        r#"SELECT player_index, display_name, character_type, payload
             FROM legality_findings
            WHERE log_id = ?
            ORDER BY rowid"#,
    )?;

    let rows = stmt.query_map(params![log_id], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
        ))
    })?;

    let mut stored = Vec::new();
    for row in rows {
        let (player_index, display_name, character_type, payload) = row?;
        stored.push(StoredFinding {
            player_index: player_index as usize,
            display_name,
            character_type,
            finding: serde_json::from_str(&payload)?,
        });
    }

    Ok(stored)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::legality::{Rule, Subject, Value};

    fn memory_db() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory db");
        conn.execute_batch(SCHEMA).expect("schema applies");
        conn
    }

    fn magnitude_finding() -> Finding {
        Finding {
            rule: Rule::SummonBonusMagnitude,
            severity: Severity::Impossible,
            subject: Subject::Summon(3),
            observed: Value::Amount(75.0),
            allowed: Value::Amount(50.0),
            odds: None,
        }
    }

    fn perfect_finding() -> Finding {
        Finding {
            rule: Rule::SummonPerfectCount,
            severity: Severity::Improbable,
            subject: Subject::Summons,
            observed: Value::Count(3),
            allowed: Value::None,
            odds: Some(4.7e-7),
        }
    }

    /// A finding survives the round trip carrying every field a tooltip needs
    /// — including the odds, which are the whole payload of an Improbable row.
    #[test]
    fn findings_round_trip_with_every_field_a_tooltip_reads() {
        let conn = memory_db();
        write_findings(
            &conn,
            537,
            2,
            "炎顺帝",
            "Pl1600",
            &[magnitude_finding(), perfect_finding()],
        )
        .expect("write");

        let stored = findings_for_log(&conn, 537).expect("read");
        assert_eq!(stored.len(), 2);
        assert_eq!(stored[0].player_index, 2);
        assert_eq!(stored[0].display_name, "炎顺帝");
        assert_eq!(stored[0].character_type, "Pl1600");
        assert_eq!(stored[0].finding, magnitude_finding());
        assert_eq!(stored[1].finding, perfect_finding());
    }

    /// Re-auditing a log replaces its rows rather than appending to them. A
    /// rescan runs over logs that already have verdicts, so without this every
    /// sweep would double every finding.
    #[test]
    fn clearing_then_rewriting_a_log_leaves_one_copy() {
        let conn = memory_db();
        write_findings(&conn, 537, 2, "炎顺帝", "Pl1600", &[magnitude_finding()]).expect("write");
        clear_findings(&conn, 537).expect("clear");
        write_findings(&conn, 537, 2, "炎顺帝", "Pl1600", &[magnitude_finding()]).expect("rewrite");

        assert_eq!(findings_for_log(&conn, 537).expect("read").len(), 1);
    }

    /// Clearing one log leaves its neighbours alone.
    #[test]
    fn clearing_a_log_leaves_other_logs_untouched() {
        let conn = memory_db();
        write_findings(&conn, 537, 2, "炎顺帝", "Pl1600", &[magnitude_finding()]).expect("write");
        write_findings(&conn, 549, 1, "Kahs", "Pl1400", &[magnitude_finding()]).expect("write");

        clear_findings(&conn, 537).expect("clear");

        assert!(findings_for_log(&conn, 537).expect("read").is_empty());
        assert_eq!(findings_for_log(&conn, 549).expect("read").len(), 1);
    }

    /// The severity and rule columns carry the same spellings the frontend
    /// sees, so a query can filter without parsing 9000 payloads.
    #[test]
    fn the_severity_and_rule_columns_are_queryable() {
        let conn = memory_db();
        write_findings(
            &conn,
            537,
            2,
            "炎顺帝",
            "Pl1600",
            &[magnitude_finding(), perfect_finding()],
        )
        .expect("write");

        let impossible: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM legality_findings WHERE severity = 'impossible'",
                [],
                |row| row.get(0),
            )
            .expect("count");
        assert_eq!(impossible, 1);

        let rule: String = conn
            .query_row(
                "SELECT rule FROM legality_findings WHERE severity = 'improbable'",
                [],
                |row| row.get(0),
            )
            .expect("rule");
        assert_eq!(rule, "summonPerfectCount");
    }
}
