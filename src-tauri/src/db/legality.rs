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

use crate::legality::Finding;

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
            // Severity is gone as a concept, but the column is NOT NULL and the
            // migrations here are append-only — so it stays and takes a
            // constant. Nothing reads it; a finding is a finding.
            "finding",
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
    // `prepare_cached`: the startup sweep calls this once per stale log.
    conn.prepare_cached("DELETE FROM legality_findings WHERE log_id = ?")?
        .execute(params![log_id])?;
    Ok(())
}

/// Every stored finding for one log, in insertion order.
///
/// The one-log case of [`findings_for_logs`]; both order by rowid, and a log
/// with nothing stored reads back as an empty list either way.
pub fn findings_for_log(conn: &Connection, log_id: i64) -> Result<Vec<StoredFinding>> {
    Ok(findings_for_logs(conn, &[log_id])?
        .remove(&log_id)
        .unwrap_or_default())
}

/// Every stored finding for one page of logs, keyed by the log it belongs to.
///
/// The quest list draws ten rows and needs each one's verdicts to colour the
/// names in it. Per-row would be ten round trips for ten rows; the whole table
/// — what [`flagged_players`] reads — is every finding ever stored, to
/// decorate ten. This is the middle: one query, bounded by the page.
///
/// A log nobody was flagged in is absent from the map rather than present with
/// an empty list. Callers look up by id and read a miss as clean.
pub fn findings_for_logs(
    conn: &Connection,
    log_ids: &[i64],
) -> Result<std::collections::HashMap<i64, Vec<StoredFinding>>> {
    let mut grouped: std::collections::HashMap<i64, Vec<StoredFinding>> =
        std::collections::HashMap::new();

    // `IN ()` is a syntax error in SQLite, and an empty page has nothing to ask
    // about anyway.
    if log_ids.is_empty() {
        return Ok(grouped);
    }

    // Built rather than `prepare_cached`: the placeholder count follows the
    // page size, so a half-full last page would miss the cache regardless.
    let placeholders = vec!["?"; log_ids.len()].join(", ");
    let mut stmt = conn.prepare(&format!(
        r#"SELECT log_id, player_index, display_name, character_type, payload
             FROM legality_findings
            WHERE log_id IN ({placeholders})
            ORDER BY rowid"#
    ))?;

    let rows = stmt.query_map(rusqlite::params_from_iter(log_ids), |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
        ))
    })?;

    for row in rows {
        let (log_id, player_index, display_name, character_type, payload) = row?;
        grouped.entry(log_id).or_default().push(StoredFinding {
            player_index: player_index as usize,
            display_name,
            character_type,
            finding: serde_json::from_str(&payload)?,
        });
    }

    Ok(grouped)
}

/// One finding as the audit page reads it: the finding itself plus which
/// encounter it came from.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerFinding {
    pub log_id: i64,
    /// Encounter start, epoch millis — what the page sorts and dates by.
    pub time: i64,
    /// The quest the encounter was, so the audit page can name each flagged
    /// fight without loading it. `None` for a log recorded before the column
    /// existed, or one whose quest was never identified.
    pub quest_id: Option<u32>,
    pub finding: Finding,
}

/// Everything the audit page shows for one person: who they are, and every
/// finding across every encounter they appear in.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlaggedPlayer {
    pub display_name: String,
    pub character_type: String,
    /// Distinct encounters this person was flagged in. Kept as a tiebreaker on
    /// the page's ordering; the page does not draw it as a badge.
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
        r#"SELECT f.display_name, f.character_type, f.log_id, l.time, l.quest_id, f.payload
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
            row.get::<_, Option<u32>>(4)?,
            row.get::<_, String>(5)?,
        ))
    })?;

    let mut grouped: std::collections::HashMap<(String, String), FlaggedPlayer> =
        std::collections::HashMap::new();

    for row in rows {
        let (display_name, character_type, log_id, time, quest_id, payload) = row?;
        let finding: Finding = serde_json::from_str(&payload)?;

        let player = grouped
            .entry((display_name.clone(), character_type.clone()))
            .or_insert_with(|| FlaggedPlayer {
                display_name,
                character_type,
                encounters: 0,
                last_seen: time,
                findings: Vec::new(),
            });

        player.last_seen = player.last_seen.max(time);
        player.findings.push(PlayerFinding {
            log_id,
            time,
            quest_id,
            finding,
        });
    }

    let mut players: Vec<FlaggedPlayer> = grouped.into_values().collect();
    for player in &mut players {
        let distinct: std::collections::HashSet<i64> =
            player.findings.iter().map(|row| row.log_id).collect();
        player.encounters = distinct.len();
        // Newest first. With severity gone there is no "worst" finding to lift
        // to the top, and the page deduplicates these into one case anyway —
        // so recency is the only ordering that still means something.
        player.findings.sort_by(|a, b| b.time.cmp(&a.time));
    }

    players.sort_by(|a, b| {
        b.last_seen
            .cmp(&a.last_seen)
            .then(b.encounters.cmp(&a.encounters))
    });

    Ok(players)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::legality::{Rule, Subject, Value};

    /// The real migrations rather than a copy of the DDL: a copy can drift away
    /// from the migration that actually ships, and a migration is append-only,
    /// so a divergence could never be fixed by editing it.
    fn memory_db() -> Connection {
        let mut conn = Connection::open_in_memory().expect("in-memory db");
        crate::db::migrations()
            .to_latest(&mut conn)
            .expect("migrations apply");
        conn
    }

    /// `flagged_players` joins `logs` for the timestamp, so its fixtures need
    /// log rows on top of the migrated schema.
    fn migrated_db_with_logs(logs: &[(i64, i64)]) -> Connection {
        let conn = memory_db();
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
            subject: Subject::Summon(3),
            observed: Value::Amount(75.0),
            allowed: Value::Amount(50.0),
            odds: None,
            evidence: None,
        }
    }

    fn perfect_finding() -> Finding {
        Finding {
            rule: Rule::SummonPerfectCount,
            subject: Subject::Summons,
            observed: Value::Count(3),
            allowed: Value::None,
            odds: Some(4.7e-7),
            evidence: None,
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

    /// The quest list's shape: one query for a whole page of logs, keyed by
    /// the log each verdict belongs to. Keying is the point — the page colours
    /// a name in one row, so a finding landing under the wrong log id would
    /// accuse the wrong fight.
    #[test]
    fn findings_for_logs_keys_each_logs_verdicts_by_its_id() {
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
        write_findings(&conn, 549, 1, "Manmoth", "Pl1300", &[perfect_finding()]).expect("write");

        let grouped = findings_for_logs(&conn, &[537, 549]).expect("read");

        assert_eq!(grouped.len(), 2);
        assert_eq!(grouped[&537].len(), 2);
        assert_eq!(grouped[&537][0].player_index, 2);
        assert_eq!(grouped[&537][0].finding, magnitude_finding());
        assert_eq!(grouped[&549].len(), 1);
        assert_eq!(grouped[&549][0].display_name, "Manmoth");
    }

    /// A log nobody was flagged in is absent, not empty — the page treats a
    /// miss as clean, and an empty entry would mean the same thing twice.
    /// Findings belonging to logs outside the page stay out of it.
    #[test]
    fn findings_for_logs_omits_clean_logs_and_logs_off_the_page() {
        let conn = memory_db();
        write_findings(&conn, 537, 2, "炎顺帝", "Pl1600", &[magnitude_finding()]).expect("write");
        write_findings(&conn, 999, 0, "Kahs", "Pl1400", &[magnitude_finding()]).expect("write");

        let grouped = findings_for_logs(&conn, &[537, 549]).expect("read");

        assert_eq!(grouped.len(), 1);
        assert!(grouped.contains_key(&537));
        assert!(!grouped.contains_key(&549), "clean log is absent");
        assert!(!grouped.contains_key(&999), "off-page log is absent");
    }

    /// An empty page asks for nothing rather than building `IN ()`, which is a
    /// syntax error in SQLite.
    #[test]
    fn findings_for_logs_handles_an_empty_page() {
        let conn = memory_db();
        assert!(findings_for_logs(&conn, &[]).expect("read").is_empty());
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

        // Both were last flagged in log 549, so the encounter count breaks the
        // tie — the person seen across two fights sorts first.
        assert_eq!(players[0].display_name, "炎顺帝");
        assert_eq!(
            players[0].encounters, 2,
            "two distinct logs, three findings"
        );
        assert_eq!(players[0].findings.len(), 3);
        assert_eq!(players[0].last_seen, 2_000);

        assert_eq!(players[1].display_name, "Manmoth");
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

    /// A player's findings come back newest first. There is no "worst" finding
    /// to lift any more — the page deduplicates them into one case, and what a
    /// reader wants first is the build they are wearing now.
    #[test]
    fn a_players_findings_come_back_newest_first() {
        let conn = migrated_db_with_logs(&[(1, 1_000), (2, 5_000)]);
        write_findings(&conn, 1, 0, "炎顺帝", "Pl1600", &[magnitude_finding()]).expect("write");
        write_findings(&conn, 2, 0, "炎顺帝", "Pl1600", &[perfect_finding()]).expect("write");

        let players = flagged_players(&conn).expect("group");
        assert_eq!(
            players[0]
                .findings
                .iter()
                .map(|row| row.log_id)
                .collect::<Vec<_>>(),
            vec![2, 1]
        );
    }

    /// An empty database is an empty list, not an error.
    #[test]
    fn flagged_players_is_empty_when_nothing_is_flagged() {
        let conn = migrated_db_with_logs(&[(1, 1_000)]);
        assert_eq!(flagged_players(&conn).expect("group"), vec![]);
    }

    /// The rule column carries the same spelling the frontend sees, so a query
    /// can filter without parsing 9000 payloads.
    #[test]
    fn the_rule_column_is_queryable() {
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

        let rule: String = conn
            .query_row(
                "SELECT rule FROM legality_findings WHERE rule = 'summonPerfectCount'",
                [],
                |row| row.get(0),
            )
            .expect("rule");
        assert_eq!(rule, "summonPerfectCount");
    }

    /// The `severity` column outlived the concept: it is NOT NULL and the
    /// migrations are append-only, so the writer fills it with a constant
    /// rather than a new migration dropping it.
    #[test]
    fn the_dead_severity_column_still_gets_a_value() {
        let conn = memory_db();
        write_findings(&conn, 537, 2, "炎顺帝", "Pl1600", &[magnitude_finding()]).expect("write");

        let stored: String = conn
            .query_row("SELECT severity FROM legality_findings", [], |row| {
                row.get(0)
            })
            .expect("severity");
        assert_eq!(stored, "finding");
    }
}
