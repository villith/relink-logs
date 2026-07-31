//! Re-auditing stored logs whose verdicts were produced by older rules.
//!
//! Findings are written when an encounter is saved, so a rule change strands
//! every log already in the database — the Behemoth III fix would never reach
//! the 692 logs recorded before it. Each log carries the
//! [`RULES_VERSION`](super::RULES_VERSION) that judged it, and this sweep
//! re-audits the ones that do not match (including every pre-legality log,
//! whose stamp is NULL).
//!
//! A full pass over a real 692-log database measures about 10s in release —
//! 1.4s of that is reading and auditing, the rest is writing the verdicts — so
//! this is a background startup sweep rather than a migration the user has to
//! sit through. It only happens once per rules version.

use anyhow::Result;
use log::warn;
use rusqlite::{params, Connection};

use crate::db::legality::clear_findings;

/// How far the sweep has got, for a UI that wants to say so.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SweepProgress {
    pub done: usize,
    pub total: usize,
}

/// What a sweep did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SweepOutcome {
    /// Logs re-audited and re-stamped.
    pub rescanned: usize,
    /// Logs whose blob would not deserialize. Stamped anyway — see
    /// [`sweep_stale_logs`].
    pub unreadable: usize,
    /// Logs older than [`AUDIT_CUTOFF_MS`](super::AUDIT_CUTOFF_MS). Stamped and
    /// stripped of any verdicts an earlier rules version left on them, but
    /// never judged.
    pub skipped: usize,
}

/// Re-audits every log not stamped with the current [`RULES_VERSION`].
///
/// One transaction, so a crash mid-sweep leaves the database as it was rather
/// than half-judged by two generations of rules.
///
/// A blob that will not deserialize is stamped current regardless and counted
/// as unreadable. That is deliberate: a permanently broken row would otherwise
/// be retried on every launch forever, and a log nobody can read is not a log
/// anybody can judge.
pub fn sweep_stale_logs(
    conn: &mut Connection,
    mut progress: impl FnMut(SweepProgress),
) -> Result<SweepOutcome> {
    // The stale ids are collected up front rather than streamed: the sweep
    // writes to `logs`, which is the table it would otherwise be scanning.
    //
    // Pre-cutoff logs are selected too rather than filtered out in SQL. They
    // still need clearing and stamping — see the loop — and a `WHERE time >=`
    // here would leave both undone, so every launch would walk them again and
    // whatever an older rules version accused them of would stand forever.
    let stale: Vec<(i64, i64)> = conn
        .prepare(
            "SELECT id, time FROM logs
              WHERE legality_rules_version IS NULL OR legality_rules_version != ?
              ORDER BY id",
        )?
        .query_map(params![super::RULES_VERSION], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?
        .collect::<Result<Vec<(i64, i64)>, _>>()?;

    let total = stale.len();
    if total == 0 {
        return Ok(SweepOutcome::default());
    }

    let mut outcome = SweepOutcome::default();
    let transaction = conn.transaction()?;

    for (done, (log_id, time)) in stale.into_iter().enumerate() {
        clear_findings(&transaction, log_id)?;

        if !super::should_audit(time) {
            // Not even decompressed: an encounter older than the cutoff cannot
            // be judged by tables baked from a later game version, so the blob
            // has nothing to tell us. The `clear_findings` above is what
            // withdraws any accusation an earlier rules version made against
            // it, and the stamp below keeps it out of every future sweep.
            outcome.skipped += 1;
        } else {
            // `prepare_cached` rather than a fresh prepare: this loop runs once
            // per stale log (692 on a first sweep), and the statement text
            // never varies.
            let (blob, version): (Vec<u8>, u8) = transaction
                .prepare_cached("SELECT data, version FROM logs WHERE id = ?")?
                .query_row(params![log_id], |row| Ok((row.get(0)?, row.get(1)?)))?;

            match crate::parser::deserialize_version(&blob, version) {
                Ok(parser) => {
                    parser
                        .encounter
                        .write_legality_findings(&transaction, log_id)?;
                    outcome.rescanned += 1;
                }
                Err(error) => {
                    warn!("legality sweep: log {log_id} will not deserialize: {error:#}");
                    outcome.unreadable += 1;
                }
            }
        }

        transaction
            .prepare_cached("UPDATE logs SET legality_rules_version = ? WHERE id = ?")?
            .execute(params![super::RULES_VERSION, log_id])?;

        progress(SweepProgress {
            done: done + 1,
            total,
        });
    }

    transaction.commit()?;
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;

    use serde::Serialize;

    use crate::db::legality::findings_for_log;
    use crate::parser::constants::CharacterType;
    use crate::parser::v1::EquippedSummon;

    /// A stand-in for the stored `PlayerData`, carrying only the fields that
    /// have no serde default. The blob format is NAME-keyed CBOR, so writing a
    /// fixture through a mirror struct is how this crate's other stored-log
    /// tests build one without reaching into private fields.
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct FixturePlayer {
        actor_index: u32,
        display_name: String,
        character_name: String,
        character_type: CharacterType,
        /// Empty; typed loosely because the real element type is private and
        /// an empty CBOR array reads back into any `Vec`.
        sigils: Vec<u8>,
        summons: Vec<EquippedSummon>,
        is_online: bool,
    }

    /// The same stand-in for `Encounter`.
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct FixtureEncounter {
        player_data: [Option<FixturePlayer>; 4],
        quest_id: Option<u32>,
        quest_timer: Option<u32>,
        event_log: Vec<u8>,
    }

    /// Behemoth III carrying the boss-set Healing Cap Up at its top: +75%
    /// against a +50% ceiling, so both summon-bonus rules fire.
    fn illegal_encounter_blob() -> Vec<u8> {
        let encounter = FixtureEncounter {
            player_data: [
                Some(FixturePlayer {
                    actor_index: 0,
                    display_name: "炎顺帝".to_string(),
                    character_name: "炎顺帝".to_string(),
                    character_type: CharacterType::Unknown(0),
                    sigils: Vec::new(),
                    summons: vec![EquippedSummon {
                        summon_id: 0xe4b7_dcf9,
                        main_trait_id: 0xb5ff_9fd3,
                        main_trait_level: 15,
                        bonus_id: 0x2ea9_ca80,
                        bonus_level: 9,
                    }],
                    is_online: true,
                }),
                None,
                None,
                None,
            ],
            quest_id: None,
            quest_timer: None,
            event_log: Vec::new(),
        };

        let cbor = cbor4ii::serde::to_vec(Vec::new(), &encounter).expect("fixture serializes");
        zstd::encode_all(cbor.as_slice(), 3).expect("fixture compresses")
    }

    /// A time comfortably inside the audited window, for the cases that are
    /// about staleness rather than about the cutoff.
    const AUDITED: i64 = super::super::AUDIT_CUTOFF_MS + 86_400_000;

    fn db_with(logs: &[(i64, i64, Option<u32>, Vec<u8>)]) -> Connection {
        let mut conn = Connection::open_in_memory().expect("in-memory db");
        crate::db::migrations()
            .to_latest(&mut conn)
            .expect("migrations apply");

        for (id, time, stamp, blob) in logs {
            conn.execute(
                "INSERT INTO logs (id, name, time, duration, data, version, legality_rules_version)
                 VALUES (?, '', ?, 1, ?, 1, ?)",
                params![id, time, blob, stamp],
            )
            .expect("insert log");
        }

        conn
    }

    /// The point of the whole mechanism: a log stamped with an older version
    /// (or never stamped at all) is re-audited; one already current is left
    /// alone. This is what carries a rule fix back to logs already recorded.
    #[test]
    fn the_sweep_reaudits_only_logs_the_current_rules_have_not_judged() {
        let mut conn = db_with(&[
            (1, AUDITED, None, illegal_encounter_blob()),
            (
                2,
                AUDITED,
                Some(super::super::RULES_VERSION),
                illegal_encounter_blob(),
            ),
        ]);

        let outcome = sweep_stale_logs(&mut conn, |_| ()).expect("sweep");
        assert_eq!(outcome.rescanned, 1);
        assert_eq!(outcome.unreadable, 0);

        // The stale log now carries findings; the current one was not touched.
        assert_eq!(findings_for_log(&conn, 1).expect("read").len(), 2);
        assert!(findings_for_log(&conn, 2).expect("read").is_empty());
    }

    /// A second sweep has nothing to do — the first stamped everything. If it
    /// did, every launch would re-audit the whole database.
    #[test]
    fn a_second_sweep_is_a_no_op() {
        let mut conn = db_with(&[(1, AUDITED, None, illegal_encounter_blob())]);

        sweep_stale_logs(&mut conn, |_| ()).expect("first sweep");
        let second = sweep_stale_logs(&mut conn, |_| ()).expect("second sweep");

        assert_eq!(second, SweepOutcome::default());
        assert_eq!(findings_for_log(&conn, 1).expect("read").len(), 2);
    }

    /// Re-sweeping after a version bump replaces a log's verdicts rather than
    /// appending a second copy of them.
    #[test]
    fn a_rescan_replaces_findings_instead_of_doubling_them() {
        let mut conn = db_with(&[(1, AUDITED, Some(0), illegal_encounter_blob())]);

        sweep_stale_logs(&mut conn, |_| ()).expect("first sweep");
        let before = findings_for_log(&conn, 1).expect("read").len();

        // Pretend the rules moved on again.
        conn.execute("UPDATE logs SET legality_rules_version = 0", [])
            .expect("unstamp");
        sweep_stale_logs(&mut conn, |_| ()).expect("second sweep");

        assert_eq!(findings_for_log(&conn, 1).expect("read").len(), before);
    }

    /// An unreadable blob is stamped anyway, so it cannot make every launch
    /// retry it forever.
    #[test]
    fn an_unreadable_log_is_counted_and_stamped_rather_than_retried() {
        let mut conn = db_with(&[(1, AUDITED, None, vec![0x00, 0x01, 0x02])]);

        let outcome = sweep_stale_logs(&mut conn, |_| ()).expect("sweep");
        assert_eq!(outcome.unreadable, 1);
        assert_eq!(outcome.rescanned, 0);

        let second = sweep_stale_logs(&mut conn, |_| ()).expect("second sweep");
        assert_eq!(second, SweepOutcome::default());
    }

    /// THE CUTOFF. A log recorded before it is stamped current — so it is
    /// never revisited — but its blob is never judged. The fixture is the same
    /// two-finding illegal build every other case here uses, so the only thing
    /// separating this from `the_sweep_reaudits_only_logs_...` is the clock.
    #[test]
    fn a_log_recorded_before_the_cutoff_is_stamped_but_never_audited() {
        let mut conn = db_with(&[(
            1,
            super::super::AUDIT_CUTOFF_MS - 1,
            None,
            illegal_encounter_blob(),
        )]);

        let outcome = sweep_stale_logs(&mut conn, |_| ()).expect("sweep");
        assert_eq!(outcome.skipped, 1);
        assert_eq!(outcome.rescanned, 0);
        assert!(findings_for_log(&conn, 1).expect("read").is_empty());

        // Stamped, so the next launch does not walk it again.
        let second = sweep_stale_logs(&mut conn, |_| ()).expect("second sweep");
        assert_eq!(second, SweepOutcome::default());
    }

    /// The cutoff is inclusive: a log recorded exactly at it is audited. An
    /// off-by-one here silently drops a day of real logs.
    #[test]
    fn a_log_recorded_exactly_at_the_cutoff_is_audited() {
        let mut conn = db_with(&[(
            1,
            super::super::AUDIT_CUTOFF_MS,
            None,
            illegal_encounter_blob(),
        )]);

        let outcome = sweep_stale_logs(&mut conn, |_| ()).expect("sweep");
        assert_eq!(outcome.rescanned, 1);
        assert_eq!(outcome.skipped, 0);
        assert_eq!(findings_for_log(&conn, 1).expect("read").len(), 2);
    }

    /// Verdicts an EARLIER rules version stored against a pre-cutoff log are
    /// cleared rather than left standing. Without this the cutoff would only
    /// govern logs nobody had judged yet, and every accusation already on the
    /// audit page would survive the change that was meant to withdraw it.
    #[test]
    fn the_sweep_purges_findings_already_stored_against_a_pre_cutoff_log() {
        // A REAL illegal blob, not an empty one: an unreadable blob would leave
        // this green through the `clear_findings` the sweep already does,
        // proving nothing about the cutoff. This log's build is genuinely
        // illegal under today's rules, so only the date can keep it clean.
        let conn = db_with(&[(
            1,
            super::super::AUDIT_CUTOFF_MS - 1,
            Some(0),
            illegal_encounter_blob(),
        )]);
        crate::db::legality::write_findings(
            &conn,
            1,
            0,
            "炎顺帝",
            "Pl1600",
            &[super::super::Finding {
                rule: super::super::Rule::SummonBonusMagnitude,
                subject: super::super::Subject::Summon(0),
                observed: super::super::Value::Amount(75.0),
                allowed: super::super::Value::Amount(50.0),
                odds: None,
                evidence: None,
            }],
        )
        .expect("seed a stale verdict");

        let mut conn = conn;
        sweep_stale_logs(&mut conn, |_| ()).expect("sweep");

        assert!(findings_for_log(&conn, 1).expect("read").is_empty());
    }

    /// Progress is reported once per log, counting up to the total, so a UI
    /// can show it honestly rather than guessing.
    #[test]
    fn progress_counts_every_log_exactly_once() {
        let mut conn = db_with(&[
            (1, AUDITED, None, illegal_encounter_blob()),
            (2, AUDITED, None, illegal_encounter_blob()),
            (3, AUDITED, None, illegal_encounter_blob()),
        ]);

        let mut seen = Vec::new();
        sweep_stale_logs(&mut conn, |progress| seen.push(progress)).expect("sweep");

        assert_eq!(
            seen,
            vec![
                SweepProgress { done: 1, total: 3 },
                SweepProgress { done: 2, total: 3 },
                SweepProgress { done: 3, total: 3 },
            ]
        );
    }
}
