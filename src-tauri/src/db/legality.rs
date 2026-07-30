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

/// One finding as the audit page reads it: the finding itself plus which
/// encounter it came from.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerFinding {
    pub log_id: i64,
    /// Encounter start, epoch millis — what the page sorts and dates by.
    pub time: i64,
    pub finding: Finding,
}

/// Everything the audit page shows for one person: who they are, how bad it
/// is, and every finding across every encounter they appear in.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlaggedPlayer {
    pub display_name: String,
    pub character_type: String,
    /// True when any finding is `Impossible` — the page's red/yellow split.
    pub impossible: bool,
    /// Distinct encounters this person was flagged in. Repetition across
    /// encounters is the signal that separates a real mod from a one-off
    /// misread, so the page shows it rather than a bare finding count.
    pub encounters: usize,
    /// Most recent flagged encounter, epoch millis.
    pub last_seen: i64,
    pub findings: Vec<PlayerFinding>,
}

/// Every flagged person across the whole database, worst first.
///
/// Grouped by name AND character: the same human on the same character is one
/// row however many slots they have occupied, but two people who happen to
/// share a name are not merged into a single accusation.
pub fn flagged_players(conn: &Connection) -> Result<Vec<FlaggedPlayer>> {
    let mut stmt = conn.prepare(
        r#"SELECT f.display_name, f.character_type, f.log_id, l.time, f.payload
             FROM legality_findings f
             JOIN logs l ON l.id = f.log_id
            ORDER BY l.time DESC, f.rowid"#,
    )?;

    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, String>(4)?,
        ))
    })?;

    let mut grouped: std::collections::HashMap<(String, String), FlaggedPlayer> =
        std::collections::HashMap::new();

    for row in rows {
        let (display_name, character_type, log_id, time, payload) = row?;
        let finding: Finding = serde_json::from_str(&payload)?;

        let player = grouped
            .entry((display_name.clone(), character_type.clone()))
            .or_insert_with(|| FlaggedPlayer {
                display_name,
                character_type,
                impossible: false,
                encounters: 0,
                last_seen: time,
                findings: Vec::new(),
            });

        player.impossible |= finding.severity == Severity::Impossible;
        player.last_seen = player.last_seen.max(time);
        player.findings.push(PlayerFinding {
            log_id,
            time,
            finding,
        });
    }

    let mut players: Vec<FlaggedPlayer> = grouped.into_values().collect();
    for player in &mut players {
        let distinct: std::collections::HashSet<i64> =
            player.findings.iter().map(|row| row.log_id).collect();
        player.encounters = distinct.len();
        // Impossible first within a player: proof and suspicion are different
        // claims, and the proof must not be buried under the improbability
        // reports below it.
        player.findings.sort_by(|a, b| {
            b.finding
                .severity
                .eq(&Severity::Impossible)
                .cmp(&a.finding.severity.eq(&Severity::Impossible))
                .then(b.time.cmp(&a.time))
        });
    }

    players.sort_by(|a, b| {
        b.impossible
            .cmp(&a.impossible)
            .then(b.encounters.cmp(&a.encounters))
            .then(b.last_seen.cmp(&a.last_seen))
    });

    Ok(players)
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

    /// `flagged_players` joins `logs` for the timestamp, so its fixtures need
    /// the whole schema rather than this module's table alone.
    fn migrated_db_with_logs(logs: &[(i64, i64)]) -> Connection {
        let mut conn = Connection::open_in_memory().expect("in-memory db");
        crate::db::migrations()
            .to_latest(&mut conn)
            .expect("migrations apply");
        for (id, time) in logs {
            conn.execute(
                "INSERT INTO logs (id, name, time, duration, data, version)
                 VALUES (?, '', ?, 1, x'00', 1)",
                params![id, time],
            )
            .expect("insert log");
        }
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

    /// The audit page's shape: one row per person, worst first, carrying the
    /// count of distinct ENCOUNTERS rather than of findings — repetition
    /// across fights is what separates a real mod from a one-off misread.
    #[test]
    fn flagged_players_groups_by_person_and_counts_encounters() {
        let conn = migrated_db_with_logs(&[(537, 1_000), (549, 2_000)]);

        // One person flagged twice in one encounter and once in another.
        write_findings(
            &conn,
            537,
            2,
            "炎顺帝",
            "Pl1600",
            &[magnitude_finding(), perfect_finding()],
        )
        .expect("write");
        write_findings(&conn, 549, 2, "炎顺帝", "Pl1600", &[magnitude_finding()]).expect("write");
        // And someone else with only a suspicion.
        write_findings(&conn, 549, 1, "Manmoth", "Pl1300", &[perfect_finding()]).expect("write");

        let players = flagged_players(&conn).expect("group");
        assert_eq!(players.len(), 2);

        // Impossible sorts above improbable-only.
        assert_eq!(players[0].display_name, "炎顺帝");
        assert!(players[0].impossible);
        assert_eq!(
            players[0].encounters, 2,
            "two distinct logs, three findings"
        );
        assert_eq!(players[0].findings.len(), 3);
        assert_eq!(players[0].last_seen, 2_000);

        assert_eq!(players[1].display_name, "Manmoth");
        assert!(!players[1].impossible);
        assert_eq!(players[1].encounters, 1);
    }

    /// Two people who share a display name but play different characters are
    /// different people, and must not be merged into one accusation.
    #[test]
    fn flagged_players_does_not_merge_two_characters_sharing_a_name() {
        let conn = migrated_db_with_logs(&[(1, 1_000)]);
        write_findings(&conn, 1, 0, "Ren", "Pl1000", &[magnitude_finding()]).expect("write");
        write_findings(&conn, 1, 1, "Ren", "Pl2000", &[magnitude_finding()]).expect("write");

        assert_eq!(flagged_players(&conn).expect("group").len(), 2);
    }

    /// A player's own findings put proof above suspicion, so an Impossible
    /// row is never buried under improbability reports.
    #[test]
    fn a_players_findings_put_impossible_first() {
        let conn = migrated_db_with_logs(&[(1, 1_000)]);
        write_findings(
            &conn,
            1,
            0,
            "炎顺帝",
            "Pl1600",
            &[perfect_finding(), magnitude_finding()],
        )
        .expect("write");

        let players = flagged_players(&conn).expect("group");
        assert_eq!(players[0].findings[0].finding, magnitude_finding());
        assert_eq!(players[0].findings[1].finding, perfect_finding());
    }

    /// An empty database is an empty list, not an error.
    #[test]
    fn flagged_players_is_empty_when_nothing_is_flagged() {
        let conn = migrated_db_with_logs(&[(1, 1_000)]);
        assert_eq!(flagged_players(&conn).expect("group"), vec![]);
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
