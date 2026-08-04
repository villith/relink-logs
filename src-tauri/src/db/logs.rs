use std::collections::HashMap;

use anyhow::Result;
use rusqlite::Connection;
use sea_query::{
    Condition, Expr, Func, Iden, Order, Query, SelectStatement, SimpleExpr, SqliteQueryBuilder,
};
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

    /// The chain this log belongs to — the Rust twin of `chain_key_expr`.
    fn chain_key(&self) -> i64 {
        self.repeat_group.unwrap_or(self.id as i64)
    }
}

/// The chain a log belongs to: its `repeat_group` if it is a later run of a
/// Repeat Quest chain, otherwise its own id.
///
/// This is the unit the quest list pages by. Written the same way the frontend
/// derives it (`chainKey` in `repeatChains.ts`) so a page boundary and a
/// rendered group can never disagree about what a chain is.
fn chain_key_expr() -> SimpleExpr {
    Func::coalesce([
        Expr::col(Logs::RepeatGroup).into(),
        Expr::col(Logs::Id).into(),
    ])
    .into()
}

/// The shortest in-game clear time the game can actually report, in seconds.
/// The Rust twin of `MIN_QUEST_ELAPSED_SECS` in `utils.ts` — logs recorded
/// before the quest timer was read from the right offset stored a constant 1s,
/// and the list renders anything below this as "-".
const MIN_QUEST_ELAPSED_SECS: u32 = 2;

/// The column a sort reads, with the values that are not really values folded
/// to NULL so they sort as the absences they are.
///
/// Only in-game time has any: taken at face value the stored 1s placeholder is
/// the fastest clear in the database, so "fastest first" would open on a page
/// of rows the list draws as "-".
fn sort_value_expr(sort_by: &SortType) -> SimpleExpr {
    match sort_by {
        SortType::Time => Expr::col(Logs::Time).into(),
        SortType::Duration => Expr::col(Logs::Duration).into(),
        // No ELSE, so a placeholder — and a log that never recorded a time —
        // both come out NULL, and one NULL ordering covers the pair.
        SortType::QuestElapsedTime => Expr::case(
            Expr::col(Logs::QuestElapsedTime).gte(MIN_QUEST_ELAPSED_SECS),
            Expr::col(Logs::QuestElapsedTime),
        )
        .into(),
    }
}

/// Which direction the list reads in.
fn sort_order(sort_direction: &SortDirection) -> Order {
    match sort_direction {
        SortDirection::Ascending => Order::Asc,
        SortDirection::Descending => Order::Desc,
    }
}

/// What the user has narrowed the quest list to.
///
/// One value rather than six positional arguments: every query below has to
/// select the same rows, and threaded by hand they were six parameters deep on
/// four signatures — with two `Option<u32>` and an `Option<bool>` adjacent, so a
/// transposed pair compiled silently. A filter added here reaches every reader
/// at once, which is what keeps a count from disagreeing with the list it sizes.
pub struct LogFilters<'a> {
    pub enemy_id: Option<u32>,
    pub quest_id: Option<u32>,
    pub cleared: Option<bool>,
    pub player_id: &'a Option<String>,
    pub player_character: &'a Option<String>,
    pub flagged_only: bool,
}

/// What the filtered list holds, counted two ways — see `get_counts`.
pub struct LogCounts {
    /// Runs: the "N saved" figure beside the pager.
    pub logs: i32,
    /// Chains: what the list pages through.
    pub chains: i32,
}

/// The one spelling of the filters, applied to whichever query is being built:
/// the page query, the chain-key query that decides which chains the page holds,
/// and both counts.
fn apply_log_filters(query: &mut SelectStatement, filters: &LogFilters) {
    let &LogFilters {
        enemy_id: filter_by_enemy_id,
        quest_id: filter_by_quest_id,
        cleared,
        player_id: filter_by_player_id,
        player_character: filter_by_player_character,
        flagged_only,
    } = filters;

    query
        // Exclude Conflux rooms: they are `logs` rows tagged with a run_id and
        // belong to the Conflux tab, not the normal quest list.
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
                                .eq(player_id.clone())
                                .and(Expr::col(Logs::P4Type).eq(player_character.clone())),
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
                        .add(Expr::col(Logs::P4Name).eq(player_id.clone())),
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
                        .add(Expr::col(Logs::P4Type).eq(player_character.clone())),
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
        );
}

/// The chain keys one page of the list holds, in display order.
///
/// A page is a fixed number of CHAINS, not of rows, so a Repeat Quest chain is
/// never cut in half by a page boundary. It used to be: a chain straddling the
/// break rendered as two blocks, each summarising only the runs that landed on
/// its own page — two different averages for one chain, a "fastest run" that
/// was merely the fastest of that half, and a different colour on each side of
/// the break, which is precisely the signal that says the rows are one group.
///
/// A chain is placed by the run that would come FIRST on its own under the
/// chosen sort — its fastest run ascending, its slowest descending. Asked for
/// the quickest clears, the user means to find the chain that holds one, and a
/// chain ranked by its own average or by its date would hide it behind slower
/// standalone runs. The figures the summary row shows are about the whole set;
/// where the block SITS is about its best run, which is also the run the list
/// marks inside it.
fn page_chain_keys(
    conn: &Connection,
    filters: &LogFilters,
    per_page: u32,
    offset: u32,
    sort_by: &SortType,
    sort_direction: &SortDirection,
) -> Result<Vec<i64>> {
    let order = sort_order(sort_direction);

    // Which end of the chain speaks for it follows the direction: the run the
    // sort would put first is the one at the MIN end ascending and at the MAX
    // end descending. Taking the minimum either way would rank a chain by its
    // best run in a list asking which took longest.
    //
    // Time is the exception, and always the latest run. It is the one column
    // whose summary cell shows a single run's value rather than a figure about
    // the set — the chain's most recent date — so placing the band anywhere
    // else would put a visible date out of order against the rows around it.
    let placement: SimpleExpr = match (sort_by, sort_direction) {
        (SortType::Time, _) | (_, SortDirection::Descending) => {
            Func::max(sort_value_expr(sort_by)).into()
        }
        (_, SortDirection::Ascending) => Func::min(sort_value_expr(sort_by)).into(),
    };

    let mut query = Query::select();
    query.from(Logs::Table).expr(chain_key_expr());
    apply_log_filters(&mut query, filters);

    let (sql, values) = query
        .add_group_by([chain_key_expr()])
        // Nothing to rank by sorts last, not first: a chain of rows the list
        // draws as "-" answers neither "fastest" nor "slowest".
        .order_by_expr_with_nulls(placement, order.clone(), sea_query::NullOrdering::Last)
        // Chains the sort column cannot separate — every untimed chain, and any
        // genuine tie — fall back to the list's resting order, so they hold
        // still between pages instead of arriving in whatever order the
        // grouping happened to produce.
        .order_by_expr(Expr::col(Logs::Time).max(), order)
        .limit(per_page.into())
        .offset(offset.into())
        .build_rusqlite(SqliteQueryBuilder);

    let mut stmt = conn.prepare(&sql)?;
    let keys = stmt
        .query(&*values.as_params())?
        .mapped(|row| row.get::<_, i64>(0))
        .collect::<rusqlite::Result<Vec<i64>>>()?;

    Ok(keys)
}

/// One page of the quest list. `flagged_only` keeps just the logs somebody was
/// flagged in; false (the default) does not filter on legality at all.
pub fn get_logs(
    conn: &Connection,
    filters: &LogFilters,
    per_page: u32,
    offset: u32,
    sort_by: &SortType,
    sort_direction: &SortDirection,
) -> anyhow::Result<Vec<LogEntry>> {
    let order = sort_order(sort_direction);

    // Which chains this page holds. Selected first, then every run belonging to
    // them is fetched whole — paging the rows directly is what used to cut a
    // chain across the boundary.
    let chain_keys = page_chain_keys(conn, filters, per_page, offset, sort_by, sort_direction)?;

    if chain_keys.is_empty() {
        return Ok(vec![]);
    }

    let mut query = Query::select();
    query.from(Logs::Table).columns([
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
    ]);
    apply_log_filters(&mut query, filters);

    // The same reading of the column the chains were placed by, so a run cannot
    // lead its own chain on a time the block was not ranked by — and so the
    // rows the list draws as "-" sit at the bottom of the block rather than
    // claiming its record.
    let (sql, values) = query
        .and_where(Expr::expr(chain_key_expr()).is_in(chain_keys.iter().copied()))
        .order_by_expr_with_nulls(
            sort_value_expr(sort_by),
            order,
            sea_query::NullOrdering::Last,
        )
        .build_rusqlite(SqliteQueryBuilder);

    let mut stmt = conn.prepare(&sql)?;
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

    // Raised, not swallowed. An empty page is indistinguishable from a page
    // whose filters matched nothing, so a decode failure here used to read as
    // "no such logs" while the pager — sized by `get_counts`, which does raise
    // — went on offering the pages it drew from.
    let mut rows = rows?;

    // Put the chains back in the order the page query chose — by their most
    // recent run — and keep each chain's runs together. The row query can only
    // sort by the sort column, which interleaves chains whose runs overlap in
    // time, and the list groups CONSECUTIVE runs only: an unrelated row landing
    // mid-chain would split it into two blocks again.
    //
    // A stable sort, so within one chain the runs keep the order the sort
    // column gave them.
    let chain_order: HashMap<i64, usize> = chain_keys
        .iter()
        .enumerate()
        .map(|(position, key)| (*key, position))
        .collect();
    rows.sort_by_key(|log| {
        chain_order
            .get(&log.chain_key())
            .copied()
            .unwrap_or(usize::MAX)
    });

    Ok(rows)
}

/// How many runs and how many chains the same filters match.
///
/// Both in one pass: they differ only in the aggregate, and the list needs each
/// for a different job — the pager is sized in CHAINS, since a Repeat Quest
/// chain occupies one slot however many runs it holds, while the "N saved"
/// figure beside it is about the logs. Counting rows for the pager would promise
/// more pages than the list can fill.
///
/// Answers to `flagged_only` for the same reason it answers to every other
/// filter: a count that ignored one would disagree with the list it sizes.
pub fn get_counts(conn: &Connection, filters: &LogFilters) -> Result<LogCounts> {
    let mut query = Query::select();
    query
        .expr(Expr::col(Logs::Id).count())
        .expr(Expr::expr(chain_key_expr()).count_distinct())
        .from(Logs::Table);
    apply_log_filters(&mut query, filters);

    let (sql, values) = query.build_rusqlite(SqliteQueryBuilder);

    let mut stmt = conn.prepare(&sql)?;
    let counts = stmt.query_row(&*values.as_params(), |row| {
        Ok(LogCounts {
            logs: row.get(0)?,
            chains: row.get(1)?,
        })
    })?;

    Ok(counts)
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

    /// A `LogFilters` borrows its two string filters, so the tests need
    /// somewhere for an absent one to live.
    static NO_FILTER: Option<String> = None;

    /// Everything unfiltered but `flagged_only` — what nearly every case below
    /// wants.
    fn filters(flagged_only: bool) -> LogFilters<'static> {
        LogFilters {
            enemy_id: None,
            quest_id: None,
            cleared: None,
            player_id: &NO_FILTER,
            player_character: &NO_FILTER,
            flagged_only,
        }
    }

    fn fetch(conn: &Connection, flagged_only: bool) -> Vec<LogEntry> {
        get_logs(
            conn,
            &filters(flagged_only),
            10,
            0,
            &SortType::Time,
            &SortDirection::Ascending,
        )
        .expect("query")
    }

    fn count(conn: &Connection, flagged_only: bool) -> i32 {
        get_counts(conn, &filters(flagged_only))
            .expect("count")
            .logs
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

    /// Stamps `ids` as later runs of the chain led by `parent`.
    fn chain(conn: &Connection, parent: i64, ids: &[i64]) {
        for id in ids {
            conn.execute(
                "UPDATE logs SET repeat_group = ? WHERE id = ?",
                params![parent, id],
            )
            .expect("stamp chain");
        }
    }

    fn page(conn: &Connection, per_page: u32, offset: u32) -> Vec<LogEntry> {
        get_logs(
            conn,
            &filters(false),
            per_page,
            offset,
            &SortType::Time,
            &SortDirection::Ascending,
        )
        .expect("query")
    }

    fn chains(conn: &Connection) -> i32 {
        get_counts(conn, &filters(false)).expect("count").chains
    }

    /// A page holds whole chains. Two slots against a 3-run chain and a lone
    /// log used to mean the chain was cut after its second run, and the summary
    /// row then averaged half a chain and marked the wrong run as fastest.
    #[test]
    fn a_page_never_cuts_a_chain_in_half() {
        let conn = db_with(&[(1, false), (2, false), (3, false), (4, false)]);
        chain(&conn, 1, &[2, 3]);

        // Two slots: the chain (runs 1-3) and log 4. The chain arrives whole,
        // so the page carries four rows rather than the two a row-pager would.
        assert_eq!(ids(&page(&conn, 2, 0)), vec![1, 2, 3, 4]);
    }

    /// One slot per chain, so the second page starts at the next chain rather
    /// than partway through the first.
    #[test]
    fn paging_steps_by_chain_not_by_row() {
        let conn = db_with(&[(1, false), (2, false), (3, false), (4, false)]);
        chain(&conn, 1, &[2, 3]);

        assert_eq!(ids(&page(&conn, 1, 0)), vec![1, 2, 3]);
        assert_eq!(ids(&page(&conn, 1, 1)), vec![4]);
    }

    /// The pager is sized in chains. Counting rows here would offer a second
    /// page that the chain-based offset leaves empty.
    #[test]
    fn the_chain_count_counts_chains_not_runs() {
        let conn = db_with(&[(1, false), (2, false), (3, false), (4, false)]);
        chain(&conn, 1, &[2, 3]);

        assert_eq!(chains(&conn), 2);
        assert_eq!(count(&conn, false), 4);
    }

    /// A chain's runs stay together even when another log falls between them in
    /// the sort order — the list groups CONSECUTIVE runs only, so an interloper
    /// would split one chain into two blocks.
    ///
    /// The chain sits where its MOST RECENT run puts it, which is the date its
    /// summary row shows: ascending by time, the lone log 2 precedes a chain
    /// whose latest run is 3, and both of the chain's runs follow together.
    ///
    /// Ascending, that is the LAST of the chain's runs rather than the first —
    /// time does not follow the direction the way duration and in-game time do
    /// (see `page_chain_keys`). The band displays this date, so ranking it by
    /// the chain's earliest run would print 3 above a row printing 2.
    #[test]
    fn a_chain_stays_contiguous_when_another_log_sorts_between_its_runs() {
        let conn = db_with(&[(1, false), (2, false), (3, false)]);
        // Log 2 sits between runs 1 and 3 by time, but belongs to no chain.
        chain(&conn, 1, &[3]);

        assert_eq!(ids(&page(&conn, 10, 0)), vec![2, 1, 3]);
    }

    /// Gives logs an in-game clear time, in the seconds the column stores.
    fn igt(conn: &Connection, times: &[(i64, i64)]) {
        for (id, seconds) in times {
            conn.execute(
                "UPDATE logs SET quest_elapsed_time = ? WHERE id = ?",
                params![seconds, id],
            )
            .expect("set quest elapsed time");
        }
    }

    /// Gives logs a wall-clock duration, in the milliseconds the column stores.
    fn durations(conn: &Connection, values: &[(i64, i64)]) {
        for (id, ms) in values {
            conn.execute("UPDATE logs SET duration = ? WHERE id = ?", params![ms, id])
                .expect("set duration");
        }
    }

    fn sorted(conn: &Connection, sort_by: &SortType, direction: &SortDirection) -> Vec<u64> {
        ids(&get_logs(conn, &filters(false), 10, 0, sort_by, direction).expect("query"))
    }

    /// Sorting by in-game time ranks a chain by its FASTEST run, so asking for
    /// the quickest clears surfaces the chain that holds one. Ranking it by its
    /// most recent run instead — which is all the chain pager knew — left the
    /// list in time order under every sort column.
    #[test]
    fn an_in_game_time_sort_places_a_chain_by_its_fastest_run() {
        let conn = db_with(&[(1, false), (2, false), (3, false), (4, false)]);
        chain(&conn, 1, &[3]);
        igt(&conn, &[(1, 300), (2, 200), (3, 100), (4, 400)]);

        // The chain holds the fastest clear (100s), so it leads — its own runs
        // fastest-first — then the lone logs by their own times.
        assert_eq!(
            sorted(
                &conn,
                &SortType::QuestElapsedTime,
                &SortDirection::Ascending
            ),
            vec![3, 1, 2, 4]
        );
    }

    /// An unchained log is a chain of one, so the sort column has to move it
    /// too. It did not: every log was its own chain, and chains were ordered by
    /// time whatever column the user clicked.
    #[test]
    fn an_in_game_time_sort_orders_unchained_logs_by_their_own_time() {
        let conn = db_with(&[(1, false), (2, false), (3, false)]);
        igt(&conn, &[(1, 300), (2, 100), (3, 200)]);

        assert_eq!(
            sorted(
                &conn,
                &SortType::QuestElapsedTime,
                &SortDirection::Ascending
            ),
            vec![2, 3, 1]
        );
    }

    /// Descending, the question is "which took longest", so a chain is ranked
    /// by its SLOWEST run — the same rule as ascending, read from the other
    /// end. Ranking by the fastest either way would bury a chain holding the
    /// longest clear in the list.
    #[test]
    fn a_descending_sort_places_a_chain_by_its_slowest_run() {
        let conn = db_with(&[(1, false), (2, false), (3, false), (4, false)]);
        chain(&conn, 1, &[3]);
        // The newest log (4) holds neither the longest nor the shortest clear,
        // so time order and in-game order disagree everywhere.
        igt(&conn, &[(1, 300), (2, 400), (3, 100), (4, 200)]);

        assert_eq!(
            sorted(
                &conn,
                &SortType::QuestElapsedTime,
                &SortDirection::Descending
            ),
            vec![2, 1, 3, 4]
        );
    }

    /// The placeholder in-game time is not a clear time, so it cannot win the
    /// sort. Logs recorded before the quest timer was read correctly store a
    /// constant 1s; taken at face value it is the fastest clear in the database
    /// and would pin every chain holding one to the top of an ascending sort.
    #[test]
    fn a_placeholder_in_game_time_does_not_place_a_chain() {
        let conn = db_with(&[(1, false), (2, false), (3, false)]);
        chain(&conn, 1, &[3]);
        // Run 3 stored the placeholder, so the chain's real best is run 1's
        // 300s — behind the lone log's 200s.
        igt(&conn, &[(1, 300), (2, 200), (3, 1)]);

        assert_eq!(
            sorted(
                &conn,
                &SortType::QuestElapsedTime,
                &SortDirection::Ascending
            ),
            vec![2, 1, 3]
        );
    }

    /// A run with no clear time to show sorts last rather than first. The list
    /// renders both the placeholder and a missing time as "-", and a column of
    /// dashes at the top of "fastest first" answers the opposite of what was
    /// asked. Among themselves they fall back to time, the list's resting
    /// order — untimed rows in an arbitrary order would shuffle between pages.
    #[test]
    fn logs_without_a_real_in_game_time_sort_last() {
        let conn = db_with(&[(1, false), (2, false), (3, false)]);
        // Log 1 stored the placeholder; log 2 never recorded a time at all.
        igt(&conn, &[(1, 1), (3, 100)]);

        assert_eq!(
            sorted(
                &conn,
                &SortType::QuestElapsedTime,
                &SortDirection::Ascending
            ),
            vec![3, 1, 2]
        );
    }

    /// Duration ranks a chain the same way: by the run that would come first on
    /// its own. Wall-clock has no placeholder to exclude — every log has one.
    #[test]
    fn a_duration_sort_places_a_chain_by_its_fastest_run() {
        let conn = db_with(&[(1, false), (2, false), (3, false)]);
        chain(&conn, 1, &[3]);
        durations(&conn, &[(1, 300), (2, 200), (3, 100)]);

        assert_eq!(
            sorted(&conn, &SortType::Duration, &SortDirection::Ascending),
            vec![3, 1, 2]
        );
    }
}
