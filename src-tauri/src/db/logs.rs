use anyhow::Result;
use rusqlite::Connection;
use sea_query::{Condition, Expr, Iden, Order, Query, SimpleExpr, SqliteQueryBuilder};
use sea_query_rusqlite::RusqliteBinder;
use serde::Serialize;

use crate::parser::constants::EnemyType;

pub enum SortType {
    Time,
    Duration,
    QuestElapsedTime,
}

pub enum SortDirection {
    Ascending,
    Descending,
}

#[derive(Iden)]
enum Logs {
    Table,
    Id,
    Name,
    Time,
    Duration,
    Version,
    PrimaryTarget,
    P1Name,
    P1Type,
    P2Name,
    P2Type,
    P3Name,
    P3Type,
    P4Name,
    P4Type,
    QuestId,
    QuestElapsedTime,
    QuestCompleted,
    RunId,
    Imported,
    RepeatGroup,
}

/// The stored-verdicts table, as much of it as the quest list's filter needs.
/// Owned by [`crate::db::legality`]; named here only to build the subquery.
#[derive(Iden)]
enum LegalityFindings {
    Table,
    LogId,
}

/// "Somebody in this log was flagged", as a condition over `logs`.
///
/// A subquery rather than a join: a log flagging two players has two rows in
/// `legality_findings`, and a join would list that log — and count it — twice.
fn flagged_condition() -> SimpleExpr {
    Expr::col(Logs::Id).in_subquery(
        Query::select()
            .column(LegalityFindings::LogId)
            .from(LegalityFindings::Table)
            .take(),
    )
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    /// The ID of the log entry.
    id: u64,
    /// The name of the log.
    name: String,
    /// Milliseconds since UNIX epoch.
    time: i64,
    /// Duration of the encounter in milliseconds.
    duration: i64,
    /// The version of the parser used
    version: u8,
    /// Primary enemy target
    primary_target: Option<EnemyType>,
    /// Player 1 display name
    p1_name: Option<String>,
    /// Player 1 character type
    p1_type: Option<String>,
    /// Player 2 display name
    p2_name: Option<String>,
    /// Player 2 character type
    p2_type: Option<String>,
    /// Player 3 display name
    p3_name: Option<String>,
    /// Player 3 character type
    p3_type: Option<String>,
    /// Player 4 display name
    p4_name: Option<String>,
    /// Player 4 character type
    p4_type: Option<String>,
    /// Quest ID
    quest_id: Option<u32>,
    /// Quest elapsed time
    quest_elapsed_time: Option<u32>,
    /// Was quest completed?
    quest_completed: Option<bool>,
    /// Copied in from another installation's logs.db, so it may lack data the
    /// source app never recorded.
    imported: bool,
    /// Id of the first run of the Repeat Quest chain this log belongs to; the
    /// chain's first run (and every unchained log) carries NULL. The quest
    /// list uses it to collapse a chain under its parent row.
    repeat_group: Option<i64>,
}

impl LogEntry {
    /// The log's id, for a caller that has to ask a second table about the page
    /// it just fetched — the quest list's stored legality verdicts.
    pub fn id(&self) -> i64 {
        self.id as i64
    }
}

/// One page of the quest list. `flagged_only` keeps just the logs somebody was
/// flagged in; false (the default) does not filter on legality at all.
pub fn get_logs(
    conn: &Connection,
    filter_by_enemy_id: Option<u32>,
    filter_by_quest_id: Option<u32>,
    per_page: u32,
    offset: u32,
    sort_by: &SortType,
    sort_direction: &SortDirection,
    cleared: Option<bool>,
    filter_by_player_id: &Option<String>,
    filter_by_player_character: &Option<String>,
    flagged_only: bool,
) -> anyhow::Result<Vec<LogEntry>> {
    let sort_column = match sort_by {
        SortType::Time => Logs::Time,
        SortType::Duration => Logs::Duration,
        SortType::QuestElapsedTime => Logs::QuestElapsedTime,
    };

    let order = match sort_direction {
        SortDirection::Ascending => Order::Asc,
        SortDirection::Descending => Order::Desc,
    };

    let (sql, values) = Query::select()
        .from(Logs::Table)
        .columns([
            Logs::Id,
            Logs::Name,
            Logs::Time,
            Logs::Duration,
            Logs::Version,
            Logs::PrimaryTarget,
            Logs::P1Name,
            Logs::P1Type,
            Logs::P2Name,
            Logs::P2Type,
            Logs::P3Name,
            Logs::P3Type,
            Logs::P4Name,
            Logs::P4Type,
            Logs::QuestId,
            Logs::QuestElapsedTime,
            Logs::QuestCompleted,
            Logs::Imported,
            Logs::RepeatGroup,
        ])
        // Exclude Conflux rooms: they are `logs` rows tagged with a run_id and belong to the
        // Conflux tab, not the normal quest list.
        .and_where(Expr::col(Logs::RunId).is_null())
        .conditions(
            filter_by_enemy_id.is_some(),
            |q| {
                q.and_where(Expr::col(Logs::PrimaryTarget).eq(filter_by_enemy_id.unwrap()));
            },
            |_| {},
        )
        .conditions(
            filter_by_quest_id.is_some(),
            |q| {
                q.and_where(Expr::col(Logs::QuestId).eq(filter_by_quest_id.unwrap()));
            },
            |_| {},
        )
        .conditions(
            cleared.is_some(),
            |q| {
                q.and_where(Expr::col(Logs::QuestCompleted).eq(cleared.unwrap()));
            },
            |_| {},
        )
        .conditions(
            filter_by_player_id.is_some() && filter_by_player_character.is_some(),
            |q| {
                let player_id = filter_by_player_id.as_ref().unwrap();
                let player_character = filter_by_player_character.as_ref().unwrap();

                q.cond_where(
                    Condition::any()
                        .add(
                            Expr::col(Logs::P1Name)
                                .eq(player_id.clone())
                                .and(Expr::col(Logs::P1Type).eq(player_character.clone())),
                        )
                        .add(
                            Expr::col(Logs::P2Name)
                                .eq(player_id.clone())
                                .and(Expr::col(Logs::P2Type).eq(player_character.clone())),
                        )
                        .add(
                            Expr::col(Logs::P3Name)
                                .eq(player_id.clone())
                                .and(Expr::col(Logs::P3Type).eq(player_character.clone())),
                        )
                        .add(
                            Expr::col(Logs::P4Name)
                                .eq(player_id)
                                .and(Expr::col(Logs::P4Type).eq(player_character)),
                        ),
                );
            },
            |_| {},
        )
        .conditions(
            filter_by_player_id.is_some() && filter_by_player_character.is_none(),
            |q| {
                let player_id = filter_by_player_id.as_ref().unwrap();

                q.cond_where(
                    Condition::any()
                        .add(Expr::col(Logs::P1Name).eq(player_id.clone()))
                        .add(Expr::col(Logs::P2Name).eq(player_id.clone()))
                        .add(Expr::col(Logs::P3Name).eq(player_id.clone()))
                        .add(Expr::col(Logs::P4Name).eq(player_id)),
                );
            },
            |_| {},
        )
        .conditions(
            filter_by_player_id.is_none() && filter_by_player_character.is_some(),
            |q| {
                let player_character = filter_by_player_character.as_ref().unwrap();

                q.cond_where(
                    Condition::any()
                        .add(Expr::col(Logs::P1Type).eq(player_character.clone()))
                        .add(Expr::col(Logs::P2Type).eq(player_character.clone()))
                        .add(Expr::col(Logs::P3Type).eq(player_character.clone()))
                        .add(Expr::col(Logs::P4Type).eq(player_character)),
                );
            },
            |_| {},
        )
        .conditions(
            flagged_only,
            |q| {
                q.and_where(flagged_condition());
            },
            |_| {},
        )
        .order_by_with_nulls(sort_column, order, sea_query::NullOrdering::Last)
        .limit(per_page.into())
        .offset(offset.into())
        .build_rusqlite(SqliteQueryBuilder);

    let mut stmt = conn.prepare(&sql).unwrap();
    let params = values.as_params();

    let rows = stmt
        .query(&*params)?
        .mapped(|row| {
            Ok(LogEntry {
                id: row.get(0)?,
                name: row.get(1)?,
                time: row.get(2)?,
                duration: row.get(3)?,
                version: row.get(4)?,
                primary_target: row.get::<usize, Option<u32>>(5)?.map(EnemyType::from_hash),
                p1_name: row.get(6)?,
                p1_type: row.get(7)?,
                p2_name: row.get(8)?,
                p2_type: row.get(9)?,
                p3_name: row.get(10)?,
                p3_type: row.get(11)?,
                p4_name: row.get(12)?,
                p4_type: row.get(13)?,
                quest_id: row.get(14)?,
                quest_elapsed_time: row.get(15)?,
                quest_completed: row.get(16)?,
                imported: row.get(17)?,
                repeat_group: row.get(18)?,
            })
        })
        .collect::<rusqlite::Result<Vec<LogEntry>>>();

    Ok(rows.unwrap_or(vec![]))
}

/// How many logs the same filters match. Takes `flagged_only` for the same
/// reason it takes every other filter: a count that ignored one would promise
/// pages the list cannot fill.
pub fn get_logs_count(
    conn: &Connection,
    filter_by_enemy_id: Option<u32>,
    filter_by_quest_id: Option<u32>,
    cleared: Option<bool>,
    filter_by_player_id: &Option<String>,
    filter_by_player_character: &Option<String>,
    flagged_only: bool,
) -> Result<i32> {
    let (sql, values) = Query::select()
        .expr(Expr::col(Logs::Id).count())
        .from(Logs::Table)
        // Exclude Conflux rooms (see get_logs) so the count matches the filtered list.
        .and_where(Expr::col(Logs::RunId).is_null())
        .conditions(
            filter_by_enemy_id.is_some(),
            |q| {
                q.and_where(Expr::col(Logs::PrimaryTarget).eq(filter_by_enemy_id.unwrap()));
            },
            |_| {},
        )
        .conditions(
            filter_by_quest_id.is_some(),
            |q| {
                q.and_where(Expr::col(Logs::QuestId).eq(filter_by_quest_id.unwrap()));
            },
            |_| {},
        )
        .conditions(
            cleared.is_some(),
            |q| {
                q.and_where(Expr::col(Logs::QuestCompleted).eq(cleared.unwrap()));
            },
            |_| {},
        )
        .conditions(
            filter_by_player_id.is_some() && filter_by_player_character.is_some(),
            |q| {
                let player_id = filter_by_player_id.as_ref().unwrap();
                let player_character = filter_by_player_character.as_ref().unwrap();

                q.cond_where(
                    Condition::any()
                        .add(
                            Expr::col(Logs::P1Name)
                                .eq(player_id.clone())
                                .and(Expr::col(Logs::P1Type).eq(player_character.clone())),
                        )
                        .add(
                            Expr::col(Logs::P2Name)
                                .eq(player_id.clone())
                                .and(Expr::col(Logs::P2Type).eq(player_character.clone())),
                        )
                        .add(
                            Expr::col(Logs::P3Name)
                                .eq(player_id.clone())
                                .and(Expr::col(Logs::P3Type).eq(player_character.clone())),
                        )
                        .add(
                            Expr::col(Logs::P4Name)
                                .eq(player_id)
                                .and(Expr::col(Logs::P4Type).eq(player_character)),
                        ),
                );
            },
            |_| {},
        )
        .conditions(
            filter_by_player_id.is_some() && filter_by_player_character.is_none(),
            |q| {
                let player_id = filter_by_player_id.as_ref().unwrap();

                q.cond_where(
                    Condition::any()
                        .add(Expr::col(Logs::P1Name).eq(player_id.clone()))
                        .add(Expr::col(Logs::P2Name).eq(player_id.clone()))
                        .add(Expr::col(Logs::P3Name).eq(player_id.clone()))
                        .add(Expr::col(Logs::P4Name).eq(player_id)),
                );
            },
            |_| {},
        )
        .conditions(
            filter_by_player_id.is_none() && filter_by_player_character.is_some(),
            |q| {
                let player_character = filter_by_player_character.as_ref().unwrap();

                q.cond_where(
                    Condition::any()
                        .add(Expr::col(Logs::P1Type).eq(player_character.clone()))
                        .add(Expr::col(Logs::P2Type).eq(player_character.clone()))
                        .add(Expr::col(Logs::P3Type).eq(player_character.clone()))
                        .add(Expr::col(Logs::P4Type).eq(player_character)),
                );
            },
            |_| {},
        )
        .conditions(
            flagged_only,
            |q| {
                q.and_where(flagged_condition());
            },
            |_| {},
        )
        .build_rusqlite(SqliteQueryBuilder);

    let mut stmt = conn.prepare(&sql).unwrap();
    let params = values.as_params();

    let row: i32 = stmt.query_row(&*params, |r| r.get(0))?;

    Ok(row)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    /// A database with the real schema and a handful of logs, some of which
    /// somebody was flagged in.
    fn db_with(logs: &[(i64, bool)]) -> Connection {
        let mut conn = Connection::open_in_memory().expect("in-memory db");
        crate::db::migrations()
            .to_latest(&mut conn)
            .expect("migrations apply");

        for (id, flagged) in logs {
            conn.execute(
                "INSERT INTO logs (id, name, time, duration, data, version)
                 VALUES (?, '', ?, 1, x'00', 1)",
                params![id, id],
            )
            .expect("insert log");

            if *flagged {
                conn.execute(
                    "INSERT INTO legality_findings (
                        log_id, player_index, display_name, character_type, severity, rule, payload
                     ) VALUES (?, 0, 'Kahs', 'Pl1400', 'finding', 'sigilTraitLevel', '{}')",
                    params![id],
                )
                .expect("insert finding");
            }
        }

        conn
    }

    fn ids(logs: &[LogEntry]) -> Vec<u64> {
        logs.iter().map(|log| log.id).collect()
    }

    fn fetch(conn: &Connection, flagged_only: bool) -> Vec<LogEntry> {
        get_logs(
            conn,
            None,
            None,
            10,
            0,
            &SortType::Time,
            &SortDirection::Ascending,
            None,
            &None,
            &None,
            flagged_only,
        )
        .expect("query")
    }

    fn count(conn: &Connection, flagged_only: bool) -> i32 {
        get_logs_count(conn, None, None, None, &None, &None, flagged_only).expect("count")
    }

    /// Every listed log has somebody flagged in it — and one flagged player is
    /// enough, however many findings they carry.
    #[test]
    fn flagged_filter_keeps_only_logs_with_findings() {
        let conn = db_with(&[(1, false), (2, true), (3, false), (4, true)]);

        assert_eq!(ids(&fetch(&conn, true)), vec![2, 4]);
    }

    /// Off, the filter is not a filter: every log comes back, flagged or not.
    #[test]
    fn the_unfiltered_list_holds_every_log() {
        let conn = db_with(&[(1, false), (2, true), (3, false), (4, true)]);

        assert_eq!(ids(&fetch(&conn, false)), vec![1, 2, 3, 4]);
    }

    /// A log flagging two players is still one log. Without a subquery — a
    /// join would do it — it would appear twice in the list and twice in the
    /// count.
    #[test]
    fn a_log_with_two_flagged_players_is_listed_once() {
        let conn = db_with(&[(1, true)]);
        conn.execute(
            "INSERT INTO legality_findings (
                log_id, player_index, display_name, character_type, severity, rule, payload
             ) VALUES (1, 2, 'Manmoth', 'Pl1300', 'finding', 'summonPerfectCount', '{}')",
            [],
        )
        .expect("second finding");

        assert_eq!(ids(&fetch(&conn, true)), vec![1]);
        assert_eq!(count(&conn, true), 1);
    }

    /// The count follows the same filter as the list; otherwise the pager
    /// promises pages the list cannot fill.
    #[test]
    fn the_count_matches_the_filtered_list() {
        let conn = db_with(&[(1, false), (2, true), (3, false), (4, true)]);

        assert_eq!(count(&conn, true), 2);
        assert_eq!(count(&conn, false), 4);
    }
}
