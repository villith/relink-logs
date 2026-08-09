//! The analysis view's generic aggregation: one (filters × groupBy) request
//! answering both the table rows and the chart bands from a single grouping,
//! so the two can never disagree. See
//! docs/superpowers/specs/2026-08-04-analysis-view-state-machine-design.md.

use protocol::{ActionType, Message};
use serde::{Deserialize, Serialize};

use crate::parser::constants::{CharacterType, EnemyType};

use super::{
    bucket_for, is_damage_taken_event, player_state, remap_dragon_form, survives_shared_gates,
    MeterFilters, PhantomTargets, PlayerData, TargetSegment, TargetSpan,
};

/// Which universe an index names — the hostility role-mapping decides which
/// universe each dimension draws from, and a ref from the wrong universe is a
/// validation error, never a guess.
///
/// `rename_all_fields` alongside `rename_all`: on an enum the latter renames
/// only the VARIANTS (the `kind` tag values here), so without it a struct
/// variant's fields would ship snake_case under a correctly camelCased tag
/// (see `legality::Evidence` for the same fix on the same class of bug).
#[derive(Debug, Clone, Copy, PartialEq, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ActorRef {
    Player { index: u32 },
    EnemySpawn { segment: usize },
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Dimension {
    Source,
    Ability,
    Target,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GroupMetric {
    Damage,
    Taken,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GroupHostility {
    Friendly,
    Enemy,
}

/// The ability filter's two grammars (spec §3): a friendly pin arrives as the
/// expanded action-id list (the frontend's `actionsForPin` owns skill-group
/// knowledge and expands a pin to every sibling `ActionType` before it is
/// sent); an enemy attack is one (type, action) pair.
///
/// Both ids are `ActionType`, not a raw `u32`: it is the exact type
/// `DamageEvent::action_id` carries (mirrors `SelectionFilter::abilities:
/// Vec<ActionType>` and `AbilityChartSeries`/`TakenChartSeries`'s own action
/// fields), and several of its variants (`SupplementaryDamage`,
/// `DamageOverTime`, ...) wrap the numeric skill id with a discriminant a
/// bare integer would lose — `actionsForPin`'s own contract
/// (`src/pages/logs/view/abilitySkills.ts`) returns `ActionType[]`, e.g.
/// `[{ Normal: 100 }, { Normal: 110 }]`, confirming the tagged shape.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AbilityFilter {
    Friendly {
        actions: Vec<ActionType>,
    },
    EnemyAttack {
        enemy_type: EnemyType,
        action_id: ActionType,
    },
}

/// One admitted span of the analysis view's aura filter, in ms relative to
/// the fight's start (the same base as `rel_ts`). Start-inclusive,
/// END-EXCLUSIVE — the status pipeline's own interval convention (the
/// frontend's `clipToWindow` overlaps `[startMs, endMs)`), which is what
/// these are clipped from.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeWindow {
    pub from_ms: i64,
    pub up_to_ms: i64,
}

impl TimeWindow {
    /// Half-open, the wire windows' convention: `from_ms <= rel_ts < up_to_ms`.
    pub fn admits(&self, rel_ts: i64) -> bool {
        self.from_ms <= rel_ts && rel_ts < self.up_to_ms
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupQuery {
    pub metric: GroupMetric,
    pub hostility: GroupHostility,
    pub group_by: Dimension,
    #[serde(default)]
    pub source: Option<ActorRef>,
    #[serde(default)]
    pub target: Option<ActorRef>,
    #[serde(default)]
    pub ability: Option<AbilityFilter>,
    #[serde(default)]
    pub top_n: Option<usize>,
    /// The committed scrub window, in ms relative to the fight's start — the
    /// same span `ParseOptions::from_ms`/`up_to_ms` narrow the derived state
    /// to, so a scrubbed table's group rows report the window the chart
    /// shows. Events outside it are skipped; buckets stay whole-fight (the
    /// view slices its chart client-side).
    #[serde(default)]
    pub from_ms: Option<i64>,
    #[serde(default)]
    pub up_to_ms: Option<i64>,
    /// The aura filter's admitted windows. `None` = no mask; `Some` keeps
    /// only events whose timestamp falls inside the UNION of the windows
    /// (`from_ms <= t < up_to_ms`). `Some(vec![])` therefore matches NOTHING —
    /// the effect was never up inside the chart window — following the same
    /// "a stale filter narrows to nothing, never widens" convention as an
    /// empty `Friendly::actions` list, NOT treated as "no mask".
    #[serde(default)]
    pub windows: Option<Vec<TimeWindow>>,
}

/// What one row/band is. Universe-typed like the filters; `Other` is the
/// top-N rollup so a capped chart still sums to the table.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum GroupKey {
    /// The hook's player slot key (`target.parent_index`) on the taken
    /// stream, the event's source parent index on the dealt stream — always
    /// the same value `ActorRef::Player { index }` filters against for the
    /// query that produced this row, so the two never disagree.
    Player {
        index: u32,
    },
    EnemySpawn {
        segment: usize,
        enemy_type: EnemyType,
        instance: u32,
    },
    FriendlyAbility {
        action_type: ActionType,
        child_character_type: CharacterType,
    },
    EnemyAttack {
        enemy_type: EnemyType,
        action_id: ActionType,
    },
    /// An enemy attacker's TYPE, standing in for [`GroupKey::EnemySpawn`] on
    /// the taken stream: `segment_targets_indexed`'s assignment only ever
    /// covers dealt (player→enemy) events (see `segment_targets_inner`,
    /// which skips every `is_damage_taken_event` hit before assigning one),
    /// so an attacker on the taken stream has no segment to key by — only
    /// its type.
    EnemyType {
        enemy_type: EnemyType,
    },
    Other,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupMeasure {
    pub amount: i64,
    pub hits: u32,
    pub min: Option<i64>,
    pub max: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupAggregate {
    pub key: GroupKey,
    pub measure: GroupMeasure,
    /// Whole-fight per-bucket band (same buckets as dps_chart) — the view
    /// slices client-side, exactly like the drill charts it replaces.
    pub series: Vec<i64>,
}

/// One key's WHOLE-FIGHT total, ignoring everything the query narrows in time.
///
/// The chart colours a band by its rank here rather than by its rank in the
/// filtered aggregation. Ranking by the filtered one repainted the plot
/// whenever a filter reordered it — the same fault `actorColor` already refuses
/// for enemies, whose colour is deliberately "NOT the row's position".
///
/// An AMOUNT rather than a rank, because the band fold is a display concern
/// this crate does not have: `groupBandsFor` folds several `FriendlyAbility`
/// keys into one band through the skill-group table, so a rank over raw keys is
/// not a rank over drawn bands. The view folds these the same way it folds the
/// aggregates, then ranks.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupReference {
    pub key: GroupKey,
    pub amount: i64,
}

/// The whole-fight ranking behind the chart's band colours.
///
/// EMPTY when the query narrows no time: the response's own aggregates already
/// are that ranking, and walking twice for one answer is waste. The view reads
/// an empty list as "rank by what you were sent".
///
/// Otherwise the same query with its three time-narrowing fields removed, run
/// through [`aggregate_groups`] itself rather than through a second walk of its
/// own — a reference that counted hits by a different rule than the aggregates
/// it colours would be worse than no reference at all. The cost is one more
/// linear pass over an event slice this request has already decompressed and
/// reparsed, and only when a filter is actually active.
///
/// Keys the mask excludes ENTIRELY are the point of this: they never appear as
/// aggregates, and without them the surviving bands' ranks compact and the
/// colours shift anyway — which is the bug.
pub fn aggregate_group_reference(
    events: &[(i64, Message)],
    player_data: &[Option<PlayerData>; 4],
    segments: &[TargetSegment],
    assignment: &[Option<usize>],
    query: &GroupQuery,
    start_time: i64,
    interval: i64,
    chart_len: usize,
    filters: MeterFilters,
) -> Result<Vec<GroupReference>, GroupQueryError> {
    if query.windows.is_none() && query.from_ms.is_none() && query.up_to_ms.is_none() {
        return Ok(Vec::new());
    }

    let mut whole = query.clone();
    whole.windows = None;
    whole.from_ms = None;
    whole.up_to_ms = None;
    // No cap: `Other` is a chart rollup rather than a band anyone draws, and a
    // rank it occupied would be a colour no band could claim.
    whole.top_n = None;

    Ok(aggregate_groups(
        events,
        player_data,
        segments,
        assignment,
        &whole,
        start_time,
        interval,
        chart_len,
        filters,
    )?
    .into_iter()
    .filter(|aggregate| aggregate.key != GroupKey::Other)
    .map(|aggregate| GroupReference {
        key: aggregate.key,
        amount: aggregate.measure.amount,
    })
    .collect())
}

/// Errors a `GroupQuery` can fail validation with before [`aggregate_groups`]
/// ever walks the event log.
///
/// `GroupMetric` and `GroupHostility` are both two-variant enums, and the
/// role-mapping table in [`aggregate_groups`] gives every one of the four
/// combinations a meaning — there is no "unsupported (metric, hostility)"
/// left to reject, only a ref or ability filter drawn from the wrong universe
/// for the combination requested.
#[derive(Debug, PartialEq)]
pub enum GroupQueryError {
    /// A ref from the wrong universe for the query's hostility role-mapping.
    WrongUniverse { field: &'static str },
}

// main.rs stringifies every `#[tauri::command]` error with `.to_string()`
// (see e.g. `settings_db::read_all().map_err(|e| e.to_string())`), so this
// keeps that pattern viable for the query command Task 9 wires up rather than
// forcing a bespoke match at the call site.
impl std::fmt::Display for GroupQueryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            // The ability grammar is STREAM-determined (dealt vs. taken), not
            // hostility-determined like `source`/`target`'s universe — see
            // `aggregate_groups`'s `friendly_action_filter`/
            // `enemy_action_filter` — so it gets its own wording rather than
            // the shared "hostility universe" phrasing below.
            GroupQueryError::WrongUniverse { field: "ability" } => {
                write!(
                    f,
                    "ability filter grammar does not match the event stream this query walks"
                )
            }
            GroupQueryError::WrongUniverse { field } => {
                write!(f, "'{field}' is not in this query's hostility universe")
            }
        }
    }
}

impl std::error::Error for GroupQueryError {}

/// Aggregates the analysis view's generic group query into rows and bands
/// that can never disagree: the table (`key` + `measure`) and the chart
/// (`key` + `series`) come from the SAME grouping over the SAME walk of the
/// event log, so a caller cannot ask for a table and a chart that tell
/// different stories about the same query.
///
/// The hostility role-mapping (spec §3) decides which events are walked and
/// what `Dimension::Source`/`Dimension::Target` mean:
///
/// ```text
/// (metric, hostility) → which events are walked and what the dims mean
/// damage + friendly:  dealt stream,  source = Player,     target = EnemySpawn   (already implemented)
/// damage + enemy:     taken stream,  source = EnemySpawn, target = Player       (WCL's hostility=1: rows = attacker enemies)
/// taken  + friendly:  taken stream,  source = Player (victim), target = EnemySpawn (attacker)
/// taken  + enemy:     dealt stream,  source = EnemySpawn (victim), target = Player (attacker)
/// ```
///
/// Two independent facts drive the walk below:
///
/// * `dealt_stream` — which events are walked. True for the player→enemy
///   stream Task 8 already implemented (full gate chain: phantoms, the
///   contested-source filter, the friendly ability grammar, the dragon-form
///   remap, target spans); false for the enemy→player stream
///   [`super::build_taken_ability_chart`] walks (a single ungated pass, the
///   enemy-attack ability grammar, no remap — none of the dealt gates mean
///   anything for a hit a PLAYER never dealt). On EITHER stream the attacker
///   is always the physical `event.source` and the victim always the
///   physical `event.target` — `dealt_stream` alone decides which universe
///   (Player vs. EnemySpawn/EnemyType) the attacker and the victim belong
///   to: attacker = Player, victim = Enemy when true; the reverse when false.
/// * `source_is_player` — whether the query's `source` role names the Player
///   universe or the Enemy one (`hostility: Friendly`/`Enemy`, independent of
///   which stream is walked). Combined with `dealt_stream` above, this says
///   which physical actor field (and which `Dimension`) backs each
///   `GroupKey`: e.g. `taken`+`enemy` walks the dealt stream like
///   `damage`+`friendly` (`dealt_stream` true both ways) but flips which
///   dimension is the Player one (`source_is_player` false vs. true).
///
/// On the taken stream, an enemy attacker is `GroupKey::EnemyType`, never
/// `GroupKey::EnemySpawn`: `segment_targets_indexed`'s assignment only ever
/// covers dealt events (`segment_targets_inner` drops every
/// `is_damage_taken_event` hit before assigning one a segment), so an
/// attacker there has no segment to key by. An `ActorRef::EnemySpawn{segment}`
/// FILTER on the taken stream still works — it resolves to that segment's
/// `enemy_type` and time span from `segments`, then keeps only taken events
/// whose source enemy TYPE matches and whose timestamp falls in the span.
/// This is the same honest approximation the old takenCardSections used:
/// same-type simultaneous spawns merge, which is also why the taken ability
/// table's own rows are keyed per (attacker TYPE, attack) rather than per
/// spawn.
///
/// `segments`/`assignment` MUST come from `segment_targets_indexed` over the
/// same `events`, exactly as [`super::build_target_damage_chart`] requires:
/// sharing the segmentation is what guarantees an `EnemySpawn` band means the
/// same enemy the target dropdown does.
#[allow(clippy::too_many_arguments)]
pub fn aggregate_groups(
    events: &[(i64, Message)],
    player_data: &[Option<PlayerData>; 4],
    segments: &[TargetSegment],
    assignment: &[Option<usize>],
    query: &GroupQuery,
    start_time: i64,
    interval: i64,
    chart_len: usize,
    filters: MeterFilters,
) -> Result<Vec<GroupAggregate>, GroupQueryError> {
    // One exhaustive match rather than two independently-derived booleans: a
    // future fifth (metric, hostility) combination is a compile error here
    // (`GroupMetric`/`GroupHostility` would grow a variant, and this match
    // stops being exhaustive), not a silently-wrong taken-stream default
    // falling out of an `if`/`else` that quietly covers "anything else".
    let (dealt_stream, source_is_player) = match (query.metric, query.hostility) {
        // dealt stream, source = Player (attacker) — Task 8's original.
        (GroupMetric::Damage, GroupHostility::Friendly) => (true, true),
        // taken stream, source = EnemySpawn/EnemyType (attacker).
        (GroupMetric::Damage, GroupHostility::Enemy) => (false, false),
        // taken stream, source = Player (victim).
        (GroupMetric::Taken, GroupHostility::Friendly) => (false, true),
        // dealt stream, source = EnemySpawn (victim).
        (GroupMetric::Taken, GroupHostility::Enemy) => (true, false),
    };

    if let Some(source) = query.source {
        let in_universe = if source_is_player {
            matches!(source, ActorRef::Player { .. })
        } else {
            matches!(source, ActorRef::EnemySpawn { .. })
        };
        if !in_universe {
            return Err(GroupQueryError::WrongUniverse { field: "source" });
        }
    }
    if let Some(target) = query.target {
        let in_universe = if source_is_player {
            matches!(target, ActorRef::EnemySpawn { .. })
        } else {
            matches!(target, ActorRef::Player { .. })
        };
        if !in_universe {
            return Err(GroupQueryError::WrongUniverse { field: "target" });
        }
    }
    // Each stream has exactly one valid ability grammar: the dealt stream's
    // events carry a friendly action id, the taken stream's carry an enemy
    // attack — see `AbilityFilter`'s own doc for why the two shapes differ.
    let friendly_action_filter = match &query.ability {
        Some(AbilityFilter::Friendly { actions }) if dealt_stream => Some(actions.as_slice()),
        Some(AbilityFilter::Friendly { .. }) => {
            return Err(GroupQueryError::WrongUniverse { field: "ability" })
        }
        _ => None,
    };
    let enemy_action_filter = match &query.ability {
        Some(AbilityFilter::EnemyAttack {
            enemy_type,
            action_id,
        }) if !dealt_stream => Some((*enemy_type, *action_id)),
        Some(AbilityFilter::EnemyAttack { .. }) => {
            return Err(GroupQueryError::WrongUniverse { field: "ability" })
        }
        _ => None,
    };

    // Whichever ref names the Player universe always narrows the ATTACKER on
    // the dealt stream and the VICTIM on the taken stream (see the doc
    // comment above); whichever names the Enemy universe narrows the
    // opposite actor.
    let player_ref = if source_is_player {
        query.source
    } else {
        query.target
    };
    let enemy_ref = if source_is_player {
        query.target
    } else {
        query.source
    };

    let player_index_filter = match player_ref {
        Some(ActorRef::Player { index }) => Some(index),
        _ => None,
    };

    // Out-of-range segment: matches nothing rather than falling back to
    // "everything" (an empty `target_spans` would mean the latter — see
    // `target_selected`). Same convention as `AnalysisView`'s own target-span
    // memo: a stale reference narrows to nothing, it never widens.
    let target_spans: Vec<TargetSpan> = if dealt_stream {
        match enemy_ref {
            Some(ActorRef::EnemySpawn { segment }) => match segments.get(segment) {
                Some(entry) => vec![TargetSpan {
                    id: entry.id,
                    start_ms: entry.start_ms,
                    end_ms: entry.end_ms,
                }],
                None => return Ok(Vec::new()),
            },
            _ => Vec::new(),
        }
    } else {
        Vec::new()
    };
    // The taken stream's own version of the same filter — no per-spawn
    // segment to match against (see the doc comment above), so this matches
    // by (attacker enemy TYPE, timestamp within the segment's span) instead.
    let taken_enemy_filter: Option<(EnemyType, i64, i64)> = if dealt_stream {
        None
    } else {
        match enemy_ref {
            Some(ActorRef::EnemySpawn { segment }) => match segments.get(segment) {
                Some(entry) => Some((entry.enemy_type, entry.start_ms, entry.end_ms)),
                None => return Ok(Vec::new()),
            },
            _ => None,
        }
    };

    let phantoms = PhantomTargets::learned_from(events.iter());
    let mut aggregates: Vec<GroupAggregate> = Vec::new();
    // One `BreakdownKeying` per (remapped) source index, fed that source's
    // hits in log order — it is stateful (Ferry's pet remap, the
    // supplementary echo family) and must see one player's own hits in the
    // order they happened, exactly like `build_ability_damage_chart` requires.
    // Interleaving with other sources' events is harmless: only the events
    // routed to THIS keying (below) ever touch it, so its own subsequence
    // stays in order regardless of what else is between them.
    //
    // It only ever sees hits that survive every gate above, so a narrow
    // ability/target-span filter can starve `last_known_pet_skill` or the
    // first-supplementary memo of the very hit that would have set them —
    // `build_ability_damage_chart` has the identical gap under a target span,
    // and the two are left to share it deliberately rather than diverge: a
    // chart and this aggregation must key a hit the same way, and inventing a
    // fix here that chart doesn't have would do the opposite. Only ever
    // touched on the dealt stream — the taken stream has no such state.
    let mut keyings: Vec<(u32, player_state::BreakdownKeying)> = Vec::new();

    for (position, (timestamp, message)) in events.iter().enumerate() {
        let Message::DamageEvent(damage_event) = message else {
            continue;
        };
        let rel_ts = timestamp - start_time;

        // `dealt_stream` wants dealt hits; the taken stream wants the
        // opposite. A mismatch skips the event entirely rather than opening
        // a bogus row for it — e.g. an unfiltered damage-taken event must
        // never mint a `GroupKey::Player` from its enemy source pointer.
        if is_damage_taken_event(damage_event) == dealt_stream {
            continue;
        }

        // The scrub window gates BOTH streams, before any per-stream logic:
        // it is a property of the query, not of either walk.
        if query.from_ms.is_some_and(|from| rel_ts < from)
            || query.up_to_ms.is_some_and(|up_to| rel_ts > up_to)
        {
            continue;
        }

        // The aura filter's window union gates BOTH streams too — like the
        // scrub window, it is a property of the query, not of either walk.
        // Start-inclusive, end-exclusive (the status intervals' own edge
        // convention — unlike the scrub window above, which is inclusive at
        // both ends because buckets are).
        if let Some(windows) = &query.windows {
            if !windows.iter().any(|window| window.admits(rel_ts)) {
                continue;
            }
        }

        let (key, damage, bucket) = if dealt_stream {
            if !survives_shared_gates(damage_event, &phantoms, filters) {
                continue;
            }
            // `Some(&[])` (every sibling action was expanded away — a stale
            // pin) narrows to nothing, matching the out-of-range convention
            // above; `None` means no ability filter was requested at all.
            if let Some(actions) = friendly_action_filter {
                if actions.is_empty() || !actions.contains(&damage_event.action_id) {
                    continue;
                }
            }

            let damage_event = remap_dragon_form(player_data, damage_event);

            if let Some(wanted) = player_index_filter {
                if damage_event.source.parent_index != wanted {
                    continue;
                }
            }

            let Some(bucket) =
                bucket_for(rel_ts, &damage_event, &target_spans, interval, chart_len)
            else {
                continue;
            };

            let key = match query.group_by {
                Dimension::Source if source_is_player => GroupKey::Player {
                    index: damage_event.source.parent_index,
                },
                Dimension::Target if !source_is_player => GroupKey::Player {
                    index: damage_event.source.parent_index,
                },
                // The remaining `Source`/`Target` case is always the enemy
                // universe (the one not matched above).
                //
                // Believed unreachable for real enemy-target damage:
                // `assignment` is total over every target-bearing damage
                // event by construction (`segment_targets_indexed` assigns a
                // segment to each one it doesn't itself drop as a taken/
                // phantom hit, both of which this walk has already excluded
                // above). If it ever DID fire, this row's damage would be
                // dropped here while the Player dimension still counts it —
                // the two dimensions' totals could diverge.
                Dimension::Source | Dimension::Target => {
                    let Some(Some(segment_index)) = assignment.get(position).copied() else {
                        continue;
                    };
                    let segment = &segments[segment_index];
                    GroupKey::EnemySpawn {
                        segment: segment_index,
                        enemy_type: segment.enemy_type,
                        instance: segment.instance,
                    }
                }
                Dimension::Ability => {
                    let keying = match keyings
                        .iter()
                        .position(|(index, _)| *index == damage_event.source.parent_index)
                    {
                        Some(position) => &mut keyings[position].1,
                        None => {
                            keyings.push((
                                damage_event.source.parent_index,
                                player_state::BreakdownKeying::default(),
                            ));
                            &mut keyings.last_mut().expect("just pushed").1
                        }
                    };
                    let (action_type, child_character_type) = keying.key_for(&damage_event);
                    GroupKey::FriendlyAbility {
                        action_type,
                        child_character_type,
                    }
                }
            };

            (key, damage_event.damage.max(0) as i64, bucket)
        } else {
            // The taken stream: a single ungated pass, exactly as
            // `build_taken_ability_chart` documents — none of the dealt
            // gates (phantoms, contested-source exclusion, dragon-form
            // remap, target spans) apply to a hit a player never dealt. The
            // victim is `target.parent_index` (a player slot key); the
            // attacker is the enemy in `source`.
            let attacker_type = EnemyType::from_hash(damage_event.source.parent_actor_type);

            if let Some((enemy_type, action_id)) = enemy_action_filter {
                if attacker_type != enemy_type || damage_event.action_id != action_id {
                    continue;
                }
            }
            if let Some(wanted) = player_index_filter {
                if damage_event.target.parent_index != wanted {
                    continue;
                }
            }
            if let Some((enemy_type, start_ms, end_ms)) = taken_enemy_filter {
                if attacker_type != enemy_type || rel_ts < start_ms || rel_ts > end_ms {
                    continue;
                }
            }

            let bucket = (rel_ts / interval) as usize;
            if bucket >= chart_len {
                continue;
            }

            let key = match query.group_by {
                Dimension::Source if source_is_player => GroupKey::Player {
                    index: damage_event.target.parent_index,
                },
                Dimension::Target if !source_is_player => GroupKey::Player {
                    index: damage_event.target.parent_index,
                },
                // The remaining `Source`/`Target` case is always the enemy
                // universe (the one not matched above) — same rule as the
                // dealt branch's own catch-all, just with no segment to
                // resolve on this stream (see the doc comment above).
                Dimension::Source | Dimension::Target => GroupKey::EnemyType {
                    enemy_type: attacker_type,
                },
                Dimension::Ability => GroupKey::EnemyAttack {
                    enemy_type: attacker_type,
                    action_id: damage_event.action_id,
                },
            };

            (key, damage_event.damage.max(0) as i64, bucket)
        };

        let entry = match aggregates.iter().position(|aggregate| aggregate.key == key) {
            Some(position) => &mut aggregates[position],
            None => {
                aggregates.push(GroupAggregate {
                    key,
                    measure: GroupMeasure::default(),
                    series: vec![0; chart_len],
                });
                aggregates.last_mut().expect("just pushed")
            }
        };

        entry.measure.amount += damage;
        entry.measure.hits += 1;
        entry.measure.min = Some(entry.measure.min.map_or(damage, |min| min.min(damage)));
        entry.measure.max = Some(entry.measure.max.map_or(damage, |max| max.max(damage)));
        entry.series[bucket] += damage;
    }

    // Largest first: the table's own order, and what a chart's legend expects.
    aggregates.sort_by_key(|aggregate| std::cmp::Reverse(aggregate.measure.amount));

    // `top_n` never removes a row — the table wants all of them. It only
    // APPENDS one `Other` band summing whatever sits past the cap, so a chart
    // that slices to the first N bands plus this one still sums to the total
    // the table (unsliced) reports.
    if let Some(top_n) = query.top_n {
        if aggregates.len() > top_n {
            let mut other_measure = GroupMeasure::default();
            let mut other_series = vec![0i64; chart_len];
            for aggregate in &aggregates[top_n..] {
                other_measure.amount += aggregate.measure.amount;
                other_measure.hits += aggregate.measure.hits;
                if let Some(min) = aggregate.measure.min {
                    other_measure.min = Some(other_measure.min.map_or(min, |other| other.min(min)));
                }
                if let Some(max) = aggregate.measure.max {
                    other_measure.max = Some(other_measure.max.map_or(max, |other| other.max(max)));
                }
                for (bucket, value) in aggregate.series.iter().enumerate() {
                    other_series[bucket] += value;
                }
            }
            aggregates.push(GroupAggregate {
                key: GroupKey::Other,
                measure: other_measure,
                series: other_series,
            });
        }
    }

    Ok(aggregates)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn deserializes_a_full_group_query() {
        let value = json!({
            "metric": "damage",
            "hostility": "friendly",
            "groupBy": "source",
            "source": { "kind": "player", "index": 3 },
            "target": { "kind": "enemySpawn", "segment": 5 },
            "ability": { "kind": "friendly", "actions": [{ "Normal": 1 }, { "Normal": 2 }] },
            "topN": 8
        });
        let query: GroupQuery = serde_json::from_value(value).expect("valid GroupQuery JSON");

        assert_eq!(query.metric, GroupMetric::Damage);
        assert_eq!(query.hostility, GroupHostility::Friendly);
        assert_eq!(query.group_by, Dimension::Source);
        assert_eq!(query.source, Some(ActorRef::Player { index: 3 }));
        assert_eq!(query.target, Some(ActorRef::EnemySpawn { segment: 5 }));
        assert_eq!(
            query.ability,
            Some(AbilityFilter::Friendly {
                actions: vec![ActionType::Normal(1), ActionType::Normal(2)]
            })
        );
        assert_eq!(query.top_n, Some(8));
    }

    #[test]
    fn deserializes_a_minimal_group_query_with_defaults() {
        let value = json!({
            "metric": "taken",
            "hostility": "enemy",
            "groupBy": "ability"
        });
        let query: GroupQuery =
            serde_json::from_value(value).expect("valid minimal GroupQuery JSON");

        assert_eq!(query.metric, GroupMetric::Taken);
        assert_eq!(query.hostility, GroupHostility::Enemy);
        assert_eq!(query.group_by, Dimension::Ability);
        assert_eq!(query.source, None);
        assert_eq!(query.target, None);
        assert_eq!(query.ability, None);
        assert_eq!(query.top_n, None);
    }

    #[test]
    fn deserializes_an_enemy_attack_ability_filter() {
        let value = json!({ "kind": "enemyAttack", "enemyType": { "Unknown": 999 }, "actionId": { "Normal": 42 } });
        let filter: AbilityFilter =
            serde_json::from_value(value).expect("valid enemy AbilityFilter JSON");

        assert_eq!(
            filter,
            AbilityFilter::EnemyAttack {
                enemy_type: EnemyType::Unknown(999),
                action_id: ActionType::Normal(42),
            }
        );
    }

    #[test]
    fn serializes_a_player_group_aggregate() {
        let aggregate = GroupAggregate {
            key: GroupKey::Player { index: 3 },
            measure: GroupMeasure {
                amount: 10,
                hits: 2,
                min: None,
                max: None,
            },
            series: vec![1, 2],
        };

        assert_eq!(
            serde_json::to_value(&aggregate).expect("GroupAggregate serializes"),
            json!({
                "key": { "kind": "player", "index": 3 },
                "measure": { "amount": 10, "hits": 2, "min": null, "max": null },
                "series": [1, 2]
            })
        );
    }

    #[test]
    fn serializes_the_enemy_spawn_group_key() {
        let key = GroupKey::EnemySpawn {
            segment: 2,
            enemy_type: EnemyType::Unknown(0xDEAD_BEEF),
            instance: 1,
        };

        assert_eq!(
            serde_json::to_value(&key).expect("GroupKey serializes"),
            json!({
                "kind": "enemySpawn",
                "segment": 2,
                "enemyType": { "Unknown": 0xDEAD_BEEFu32 },
                "instance": 1
            })
        );
    }

    #[test]
    fn serializes_the_friendly_ability_group_key() {
        let key = GroupKey::FriendlyAbility {
            action_type: ActionType::Normal(1100),
            child_character_type: CharacterType::Pl2700,
        };

        assert_eq!(
            serde_json::to_value(&key).expect("GroupKey serializes"),
            json!({
                "kind": "friendlyAbility",
                "actionType": { "Normal": 1100 },
                "childCharacterType": "Pl2700"
            })
        );
    }

    #[test]
    fn serializes_the_enemy_attack_group_key() {
        let key = GroupKey::EnemyAttack {
            enemy_type: EnemyType::Unknown(0x1234),
            action_id: ActionType::Normal(200),
        };

        assert_eq!(
            serde_json::to_value(&key).expect("GroupKey serializes"),
            json!({
                "kind": "enemyAttack",
                "enemyType": { "Unknown": 0x1234u32 },
                "actionId": { "Normal": 200 }
            })
        );
    }

    #[test]
    fn serializes_the_enemy_type_group_key() {
        let key = GroupKey::EnemyType {
            enemy_type: EnemyType::Unknown(0x5678),
        };

        assert_eq!(
            serde_json::to_value(&key).expect("GroupKey serializes"),
            json!({
                "kind": "enemyType",
                "enemyType": { "Unknown": 0x5678u32 }
            })
        );
    }

    #[test]
    fn serializes_the_other_group_key() {
        assert_eq!(
            serde_json::to_value(GroupKey::Other).expect("GroupKey serializes"),
            json!({ "kind": "other" })
        );
    }

    #[test]
    fn deserializes_a_group_query_grouped_by_target() {
        let value = json!({
            "metric": "damage",
            "hostility": "friendly",
            "groupBy": "target"
        });
        let query: GroupQuery =
            serde_json::from_value(value).expect("valid GroupQuery JSON grouped by target");

        assert_eq!(query.group_by, Dimension::Target);
    }

    #[test]
    fn serializes_the_enemy_spawn_actor_ref() {
        assert_eq!(
            serde_json::to_value(ActorRef::EnemySpawn { segment: 5 }).expect("ActorRef serializes"),
            json!({ "kind": "enemySpawn", "segment": 5 })
        );
    }

    // --- aggregate_groups -------------------------------------------------
    //
    // Synthetic events built the same shape `mod.rs`'s drill-chart tests use
    // (`damage_from`/`damage_onto`), not imported — those helpers are private
    // to that test module — but replicated minimally here.

    use crate::parser::v1::segment_targets_indexed;
    use protocol::{Actor, DamageEvent};

    /// Zeta's character hash, matching `mod.rs`'s own test constant — any
    /// real player hash works; an `Unknown` parent is dropped at ingest by
    /// `should_ignore_damage_event`, and `aggregate_groups` relies on that
    /// same guarantee (see the `is_damage_taken_event` gate below it).
    const PLAYER_HASH: u32 = 0x28AC1108;

    /// A hit from party slot `player_index` onto `target_index` (an enemy
    /// actor whose own index and parent index are the same, i.e. not a
    /// summon/pet body) for `action`/`damage`.
    fn player_hit(player_index: u32, target_index: u32, action: u32, damage: i32) -> DamageEvent {
        DamageEvent {
            source: Actor {
                index: player_index,
                actor_type: PLAYER_HASH,
                parent_index: player_index,
                parent_actor_type: PLAYER_HASH,
            },
            target: Actor {
                index: target_index,
                actor_type: 0xE000_0000 | target_index,
                parent_index: target_index,
                parent_actor_type: 0xE000_0000 | target_index,
            },
            damage,
            flags: 0,
            action_id: ActionType::Normal(action),
            attack_rate: None,
            stun_value: Some(50.0),
            damage_cap: None,
            base_damage: None,
            target_current_hp: None,
            target_max_hp: None,
            class_flags: None,
            source_current_hp: None,
            source_max_hp: None,
            source_statuses: None,
        }
    }

    /// A hit landing on party slot `victim_slot` (0..=3) from an enemy of
    /// `attacker_hash`, for `action`/`damage` — same shape as `mod.rs`'s own
    /// `damage_taken_by_slot0`, generalized so tests can distinguish
    /// multiple attacker types and victims. `is_damage_taken_event` needs
    /// the target's PARENT to carry a real player slot key and the source's
    /// parent hash to resolve to `CharacterType::Unknown`; any non-player
    /// hash satisfies the latter, so `attacker_hash` doubles as the enemy's
    /// identity (`EnemyType::from_hash` is a bare wrap of the hash — see
    /// `constants::EnemyType`).
    fn enemy_hit(attacker_hash: u32, victim_slot: u8, action: u32, damage: i32) -> DamageEvent {
        DamageEvent {
            source: Actor {
                index: 0xF1EB_0000 | (attacker_hash & 0xFFFF),
                actor_type: attacker_hash,
                parent_index: 0xF1EB_0000 | (attacker_hash & 0xFFFF),
                parent_actor_type: attacker_hash,
            },
            target: Actor {
                index: 77,
                actor_type: PLAYER_HASH,
                parent_index: protocol::player_slot_key(victim_slot),
                parent_actor_type: PLAYER_HASH,
            },
            damage,
            flags: 0,
            action_id: ActionType::Normal(action),
            attack_rate: None,
            stun_value: None,
            damage_cap: None,
            base_damage: None,
            target_current_hp: None,
            target_max_hp: None,
            class_flags: None,
            source_current_hp: None,
            source_max_hp: None,
            source_statuses: None,
        }
    }

    fn friendly_damage_query(group_by: Dimension) -> GroupQuery {
        GroupQuery {
            metric: GroupMetric::Damage,
            hostility: GroupHostility::Friendly,
            group_by,
            source: None,
            target: None,
            ability: None,
            top_n: None,
            from_ms: None,
            up_to_ms: None,
            windows: None,
        }
    }

    fn taken_friendly_query(group_by: Dimension) -> GroupQuery {
        GroupQuery {
            metric: GroupMetric::Taken,
            hostility: GroupHostility::Friendly,
            group_by,
            source: None,
            target: None,
            ability: None,
            top_n: None,
            from_ms: None,
            up_to_ms: None,
            windows: None,
        }
    }

    fn damage_enemy_query(group_by: Dimension) -> GroupQuery {
        GroupQuery {
            metric: GroupMetric::Damage,
            hostility: GroupHostility::Enemy,
            group_by,
            source: None,
            target: None,
            ability: None,
            top_n: None,
            from_ms: None,
            up_to_ms: None,
            windows: None,
        }
    }

    fn taken_enemy_query(group_by: Dimension) -> GroupQuery {
        GroupQuery {
            metric: GroupMetric::Taken,
            hostility: GroupHostility::Enemy,
            group_by,
            source: None,
            target: None,
            ability: None,
            top_n: None,
            from_ms: None,
            up_to_ms: None,
            windows: None,
        }
    }

    /// Folds a set of enemy-side aggregates (`EnemySpawn` or `EnemyType`
    /// rows — whichever the query produced) down to one total per enemy
    /// TYPE, so a per-spawn grouping and a type-only grouping over the same
    /// events can be compared directly.
    fn amount_by_enemy_type(aggregates: &[GroupAggregate]) -> std::collections::BTreeMap<u32, i64> {
        let mut totals = std::collections::BTreeMap::new();
        for aggregate in aggregates {
            let EnemyType::Unknown(hash) = match &aggregate.key {
                GroupKey::EnemySpawn { enemy_type, .. } => *enemy_type,
                GroupKey::EnemyType { enemy_type } => *enemy_type,
                other => panic!("unexpected key in an enemy-side fold: {other:?}"),
            };
            *totals.entry(hash).or_insert(0) += aggregate.measure.amount;
        }
        totals
    }

    /// Every aggregate's series must sum to its own measure, and the whole
    /// set must sum to the total the caller expects the filter to admit —
    /// the invariant that makes a table and a chart drawn from the same
    /// aggregation unable to disagree.
    fn assert_invariants(aggregates: &[GroupAggregate], expected_total: i64) {
        for aggregate in aggregates {
            let series_sum: i64 = aggregate.series.iter().sum();
            assert_eq!(
                series_sum, aggregate.measure.amount,
                "series must sum to the measure for {:?}",
                aggregate.key
            );
        }
        let total: i64 = aggregates.iter().map(|a| a.measure.amount).sum();
        assert_eq!(
            total, expected_total,
            "aggregates must sum to the filtered total"
        );
    }

    #[test]
    fn source_dimension_groups_every_player_and_sorts_descending() {
        let events = vec![
            (1_000, Message::DamageEvent(player_hit(0, 9, 100, 1_000))),
            (2_000, Message::DamageEvent(player_hit(1, 9, 100, 500))),
            (3_000, Message::DamageEvent(player_hit(0, 9, 200, 300))),
        ];
        let query = friendly_damage_query(Dimension::Source);

        let aggregates = aggregate_groups(
            &events,
            &Default::default(),
            &[],
            &[],
            &query,
            1_000,
            1_000,
            3,
            MeterFilters::default(),
        )
        .expect("friendly damage grouped by source is supported");

        assert_eq!(aggregates.len(), 2, "one aggregate per player");
        assert_eq!(aggregates[0].key, GroupKey::Player { index: 0 });
        assert_eq!(aggregates[0].measure.amount, 1_300);
        assert_eq!(aggregates[0].measure.hits, 2);
        assert_eq!(aggregates[0].series, vec![1_000, 0, 300]);
        assert_eq!(aggregates[1].key, GroupKey::Player { index: 1 });
        assert_eq!(aggregates[1].measure.amount, 500);
        assert_eq!(aggregates[1].series, vec![0, 500, 0]);

        assert_invariants(&aggregates, 1_800);
    }

    #[test]
    fn ability_dimension_with_source_filter_keys_by_action_and_child_character() {
        let events = vec![
            (1_000, Message::DamageEvent(player_hit(0, 9, 100, 500))),
            (1_500, Message::DamageEvent(player_hit(0, 9, 200, 700))),
            (2_000, Message::DamageEvent(player_hit(0, 9, 100, 300))),
            // A different player's hit on the same ability must not leak in.
            (2_500, Message::DamageEvent(player_hit(1, 9, 100, 9_999))),
        ];
        let mut query = friendly_damage_query(Dimension::Ability);
        query.source = Some(ActorRef::Player { index: 0 });

        let aggregates = aggregate_groups(
            &events,
            &Default::default(),
            &[],
            &[],
            &query,
            1_000,
            1_000,
            2,
            MeterFilters::default(),
        )
        .expect("friendly damage grouped by ability is supported");

        assert_eq!(
            aggregates.len(),
            2,
            "one aggregate per (action, child) pair"
        );
        let child = CharacterType::from_hash(PLAYER_HASH);
        assert_eq!(
            aggregates[0].key,
            GroupKey::FriendlyAbility {
                action_type: ActionType::Normal(100),
                child_character_type: child,
            }
        );
        assert_eq!(aggregates[0].measure.amount, 800);
        assert_eq!(
            aggregates[1].key,
            GroupKey::FriendlyAbility {
                action_type: ActionType::Normal(200),
                child_character_type: child,
            }
        );
        assert_eq!(aggregates[1].measure.amount, 700);

        assert_invariants(&aggregates, 1_500);
    }

    #[test]
    fn target_dimension_with_source_and_ability_filter_keys_by_spawn_segment() {
        let events = vec![
            (1_000, Message::DamageEvent(player_hit(0, 9, 77, 400))),
            // Wrong source: dropped by the source filter.
            (1_500, Message::DamageEvent(player_hit(1, 9, 77, 9_999))),
            // Wrong ability: dropped by the ability filter.
            (1_800, Message::DamageEvent(player_hit(0, 9, 88, 12_345))),
            (2_000, Message::DamageEvent(player_hit(0, 10, 77, 600))),
            (2_500, Message::DamageEvent(player_hit(0, 9, 77, 100))),
        ];
        let (segments, assignment) = segment_targets_indexed(&events, 1_000);

        let mut query = friendly_damage_query(Dimension::Target);
        query.source = Some(ActorRef::Player { index: 0 });
        query.ability = Some(AbilityFilter::Friendly {
            actions: vec![ActionType::Normal(77)],
        });

        let aggregates = aggregate_groups(
            &events,
            &Default::default(),
            &segments,
            &assignment,
            &query,
            1_000,
            1_000,
            2,
            MeterFilters::default(),
        )
        .expect("friendly damage grouped by target is supported");

        assert_eq!(aggregates.len(), 2, "one aggregate per spawn segment hit");
        assert_eq!(
            aggregates[0].key,
            GroupKey::EnemySpawn {
                segment: 1,
                enemy_type: EnemyType::from_hash(0xE000_0000 | 10),
                instance: 1,
            }
        );
        assert_eq!(aggregates[0].measure.amount, 600);
        assert_eq!(
            aggregates[1].key,
            GroupKey::EnemySpawn {
                segment: 0,
                enemy_type: EnemyType::from_hash(0xE000_0000 | 9),
                instance: 1,
            }
        );
        assert_eq!(aggregates[1].measure.amount, 500);
        assert_eq!(aggregates[1].measure.hits, 2);
        assert_eq!(aggregates[1].series, vec![400, 100]);

        assert_invariants(&aggregates, 1_100);
    }

    #[test]
    fn a_source_filter_matching_no_hits_returns_an_empty_vec_not_an_error() {
        let events = vec![(1_000, Message::DamageEvent(player_hit(0, 9, 100, 500)))];
        let mut query = friendly_damage_query(Dimension::Source);
        query.source = Some(ActorRef::Player { index: 7 });

        let aggregates = aggregate_groups(
            &events,
            &Default::default(),
            &[],
            &[],
            &query,
            1_000,
            1_000,
            1,
            MeterFilters::default(),
        )
        .expect("an unmatched filter is not a validation error");

        assert_eq!(aggregates, Vec::new());
    }

    #[test]
    fn an_empty_friendly_actions_list_matches_nothing() {
        // The frontend expands a pin into its sibling actions; an empty
        // expansion means the pin is stale. `AnalysisView`'s own target-span
        // memo narrows a stale reference to nothing rather than widening it
        // back to "no filter" — this mirrors that convention for abilities.
        let events = vec![(1_000, Message::DamageEvent(player_hit(0, 9, 100, 500)))];
        let mut query = friendly_damage_query(Dimension::Source);
        query.ability = Some(AbilityFilter::Friendly { actions: vec![] });

        let aggregates = aggregate_groups(
            &events,
            &Default::default(),
            &[],
            &[],
            &query,
            1_000,
            1_000,
            1,
            MeterFilters::default(),
        )
        .expect("an empty actions list is not a validation error");

        assert_eq!(aggregates, Vec::new());
    }

    #[test]
    fn top_n_keeps_every_row_and_appends_one_other_summing_the_tail() {
        let events = vec![
            (1_000, Message::DamageEvent(player_hit(0, 9, 100, 1_000))),
            (1_000, Message::DamageEvent(player_hit(1, 9, 100, 700))),
            (1_000, Message::DamageEvent(player_hit(2, 9, 100, 300))),
        ];
        let mut query = friendly_damage_query(Dimension::Source);
        query.top_n = Some(1);

        let aggregates = aggregate_groups(
            &events,
            &Default::default(),
            &[],
            &[],
            &query,
            1_000,
            1_000,
            1,
            MeterFilters::default(),
        )
        .expect("friendly damage grouped by source is supported");

        assert_eq!(
            aggregates.len(),
            4,
            "all 3 rows survive, plus one trailing Other"
        );
        assert_eq!(aggregates[0].key, GroupKey::Player { index: 0 });
        assert_eq!(aggregates[1].key, GroupKey::Player { index: 1 });
        assert_eq!(aggregates[2].key, GroupKey::Player { index: 2 });
        assert_eq!(aggregates[3].key, GroupKey::Other);
        assert_eq!(aggregates[3].measure.amount, 1_000, "700 + 300");
        assert_eq!(aggregates[3].measure.hits, 2);
        assert_eq!(aggregates[3].series, vec![1_000]);

        // The table (all 4 rows, Other included) intentionally does NOT sum
        // to the fight total here — Other duplicates rows 1 and 2, which is
        // the point: a chart can slice to [row 0, Other] and still show the
        // whole fight in `top_n` bands.
        let charted_amount: i64 = aggregates[..3].iter().map(|a| a.measure.amount).sum();
        assert_eq!(
            charted_amount, 2_000,
            "the 3 real rows still sum to the fight total"
        );
    }

    /// The three gates a source-less, filter-less query relies on entirely by
    /// itself — nothing upstream has already narrowed the log for it:
    ///
    /// * a damage-TAKEN event (enemy source, player target) must not mint a
    ///   `GroupKey::Player` for the enemy's pointer-like index — shaped
    ///   exactly like `damage_taken_by_slot0` in `mod.rs`'s own tests;
    /// * a dragon-form (Pl2000) hit must remap onto its Pl1900 owner's row
    ///   BEFORE any source narrowing runs — shaped like
    ///   `dragon_form_damage_attributes_to_the_id_player`;
    /// * a phantom-target hit (Eugen's Grenade, hand-excluded) must not
    ///   inflate the row of the player who "dealt" it.
    ///
    /// This is the only aggregator test that exercises any of the three —
    /// every other test's synthetic log is clean, deliberately, so a
    /// dropped gate here would ship silently.
    #[test]
    fn source_dimension_drops_taken_and_phantom_hits_and_remaps_dragon_form_before_the_source_filter(
    ) {
        let mut player_data: [Option<PlayerData>; 4] = Default::default();
        player_data[0] = Some(PlayerData {
            actor_index: 5,
            character_type: CharacterType::Pl1900,
            ..Default::default()
        });

        // Enemy source (pointer-like index), player target — `mod.rs`'s own
        // `damage_taken_by_slot0`, inlined rather than imported (private to
        // that test module).
        let taken = DamageEvent {
            source: Actor {
                index: 0xF1EB_1234,
                actor_type: 0xDEAD_BEEF,
                parent_index: 0xF1EB_1234,
                parent_actor_type: 0xDEAD_BEEF,
            },
            target: Actor {
                index: 77,
                actor_type: PLAYER_HASH,
                parent_index: protocol::player_slot_key(0),
                parent_actor_type: PLAYER_HASH,
            },
            damage: 750,
            flags: 0,
            action_id: ActionType::Normal(9001),
            attack_rate: None,
            stun_value: None,
            damage_cap: None,
            base_damage: None,
            target_current_hp: Some(9_500),
            target_max_hp: Some(10_000),
            class_flags: None,
            source_current_hp: None,
            source_max_hp: None,
            source_statuses: None,
        };

        // Self-parented Pl2000, matching `dragon_form_damage_attributes_to_the_id_player`.
        // The remap must rewrite this onto the Pl1900 owner above (actor_index 5).
        let mut dragon = player_hit(200, 9, 100, 700);
        dragon.source = Actor {
            index: 200,
            actor_type: 0xF5755C0E,
            parent_actor_type: 0xF5755C0E,
            parent_index: 200,
        };

        // Eugen's Grenade — hand-excluded, no HP read needed, cheaper than the
        // learned (HP-history) phantom rule.
        let mut phantom = player_hit(0, 999, 100, 99_999);
        phantom.target.actor_type = 0x022a350f;
        phantom.target.parent_actor_type = 0x022a350f;

        let events = vec![
            (1_000, Message::DamageEvent(player_hit(0, 9, 100, 500))),
            (1_000, Message::DamageEvent(player_hit(1, 9, 100, 300))),
            (1_000, Message::DamageEvent(taken)),
            (1_000, Message::DamageEvent(dragon)),
            (1_000, Message::DamageEvent(phantom)),
        ];
        let query = friendly_damage_query(Dimension::Source);

        let aggregates = aggregate_groups(
            &events,
            &player_data,
            &[],
            &[],
            &query,
            1_000,
            1_000,
            1,
            MeterFilters::default(),
        )
        .expect("friendly damage grouped by source is supported");

        assert_eq!(
            aggregates.len(),
            3,
            "the taken and phantom hits open no row of their own"
        );
        assert!(
            aggregates
                .iter()
                .all(|a| a.key != GroupKey::Player { index: 0xF1EB_1234 }),
            "the enemy's pointer index must never become a Player row"
        );
        let player0 = aggregates
            .iter()
            .find(|a| a.key == GroupKey::Player { index: 0 })
            .expect("player 0's row");
        assert_eq!(
            player0.measure.amount, 500,
            "the phantom hit must not inflate player 0's total"
        );
        let player1 = aggregates
            .iter()
            .find(|a| a.key == GroupKey::Player { index: 1 })
            .expect("player 1's row");
        assert_eq!(player1.measure.amount, 300);
        let dragon_owner = aggregates
            .iter()
            .find(|a| a.key == GroupKey::Player { index: 5 })
            .expect("the dragon hit lands on its Pl1900 owner's row");
        assert_eq!(dragon_owner.measure.amount, 700);

        // The reviewer's deferred nit on Task 8: the remap must run BEFORE
        // the source filter is applied, not just before the key is built —
        // otherwise a source-pinned query for the Pl1900 owner (actor_index
        // 5, who never appears as a raw `.source` in the log above) would
        // wrongly see zero hits.
        let mut pinned_query = query.clone();
        pinned_query.source = Some(ActorRef::Player { index: 5 });
        let pinned = aggregate_groups(
            &events,
            &player_data,
            &[],
            &[],
            &pinned_query,
            1_000,
            1_000,
            1,
            MeterFilters::default(),
        )
        .expect("friendly damage grouped by source is supported");

        assert_eq!(
            pinned.len(),
            1,
            "only the remapped dragon hit matches actor_index 5"
        );
        assert_eq!(pinned[0].key, GroupKey::Player { index: 5 });
        assert_eq!(pinned[0].measure.amount, 700);
    }

    #[test]
    fn friendly_damage_rejects_a_source_from_the_enemy_universe() {
        let query = GroupQuery {
            source: Some(ActorRef::EnemySpawn { segment: 0 }),
            ..friendly_damage_query(Dimension::Source)
        };

        let result = aggregate_groups(
            &[],
            &Default::default(),
            &[],
            &[],
            &query,
            0,
            1_000,
            1,
            MeterFilters::default(),
        );

        assert_eq!(
            result,
            Err(GroupQueryError::WrongUniverse { field: "source" })
        );
    }

    #[test]
    fn friendly_damage_rejects_a_target_from_the_player_universe() {
        let query = GroupQuery {
            target: Some(ActorRef::Player { index: 0 }),
            ..friendly_damage_query(Dimension::Target)
        };

        let result = aggregate_groups(
            &[],
            &Default::default(),
            &[],
            &[],
            &query,
            0,
            1_000,
            1,
            MeterFilters::default(),
        );

        assert_eq!(
            result,
            Err(GroupQueryError::WrongUniverse { field: "target" })
        );
    }

    #[test]
    fn friendly_damage_rejects_an_enemy_attack_ability_filter() {
        let query = GroupQuery {
            ability: Some(AbilityFilter::EnemyAttack {
                enemy_type: EnemyType::Unknown(1),
                action_id: ActionType::Normal(1),
            }),
            ..friendly_damage_query(Dimension::Source)
        };

        let result = aggregate_groups(
            &[],
            &Default::default(),
            &[],
            &[],
            &query,
            0,
            1_000,
            1,
            MeterFilters::default(),
        );

        assert_eq!(
            result,
            Err(GroupQueryError::WrongUniverse { field: "ability" })
        );
    }

    // --- taken + enemy-side aggregation ------------------------------------
    //
    // The role-mapping table's other three rows (spec §3, and the table in
    // `aggregate_groups`'s own doc comment): `taken`+`friendly` and
    // `damage`+`enemy` both walk the enemy→player TAKEN stream;
    // `taken`+`enemy` walks the same player→enemy DEALT stream
    // `damage`+`friendly` does, just flipping which dimension is the Player
    // one.

    #[test]
    fn taken_friendly_grouped_by_source_keys_by_victim_player() {
        const GOBLIN: u32 = 0xAAAA_0001;
        const WOLF: u32 = 0xAAAA_0002;
        let events = vec![
            (1_000, Message::DamageEvent(enemy_hit(GOBLIN, 0, 9001, 400))),
            (2_000, Message::DamageEvent(enemy_hit(WOLF, 1, 9002, 250))),
            (3_000, Message::DamageEvent(enemy_hit(GOBLIN, 0, 9001, 100))),
        ];
        let query = taken_friendly_query(Dimension::Source);

        let aggregates = aggregate_groups(
            &events,
            &Default::default(),
            &[],
            &[],
            &query,
            1_000,
            1_000,
            3,
            MeterFilters::default(),
        )
        .expect("taken grouped by source is supported");

        assert_eq!(aggregates.len(), 2, "one row per victim player");
        assert_eq!(
            aggregates[0].key,
            GroupKey::Player {
                index: protocol::player_slot_key(0)
            }
        );
        assert_eq!(aggregates[0].measure.amount, 500, "400 + 100");
        assert_eq!(
            aggregates[1].key,
            GroupKey::Player {
                index: protocol::player_slot_key(1)
            }
        );
        assert_eq!(aggregates[1].measure.amount, 250);

        assert_invariants(&aggregates, 750);
    }

    #[test]
    fn taken_friendly_grouped_by_ability_keys_by_enemy_attack() {
        const GOBLIN: u32 = 0xAAAA_0001;
        let events = vec![
            (1_000, Message::DamageEvent(enemy_hit(GOBLIN, 0, 9001, 400))),
            (2_000, Message::DamageEvent(enemy_hit(GOBLIN, 0, 9002, 100))),
            (3_000, Message::DamageEvent(enemy_hit(GOBLIN, 1, 9001, 50))),
        ];
        let query = taken_friendly_query(Dimension::Ability);

        let aggregates = aggregate_groups(
            &events,
            &Default::default(),
            &[],
            &[],
            &query,
            1_000,
            1_000,
            3,
            MeterFilters::default(),
        )
        .expect("taken grouped by ability is supported");

        assert_eq!(aggregates.len(), 2, "one row per (enemy type, action)");
        assert_eq!(
            aggregates[0].key,
            GroupKey::EnemyAttack {
                enemy_type: EnemyType::Unknown(GOBLIN),
                action_id: ActionType::Normal(9001),
            }
        );
        assert_eq!(aggregates[0].measure.amount, 450, "400 + 50, two victims");
        assert_eq!(
            aggregates[1].key,
            GroupKey::EnemyAttack {
                enemy_type: EnemyType::Unknown(GOBLIN),
                action_id: ActionType::Normal(9002),
            }
        );
        assert_eq!(aggregates[1].measure.amount, 100);

        assert_invariants(&aggregates, 550);
    }

    #[test]
    fn taken_friendly_grouped_by_target_keys_by_attacker_enemy_type() {
        const GOBLIN: u32 = 0xAAAA_0001;
        const WOLF: u32 = 0xAAAA_0002;
        let events = vec![
            (1_000, Message::DamageEvent(enemy_hit(GOBLIN, 0, 9001, 400))),
            (2_000, Message::DamageEvent(enemy_hit(WOLF, 1, 9002, 250))),
            (3_000, Message::DamageEvent(enemy_hit(GOBLIN, 2, 9001, 100))),
        ];
        let query = taken_friendly_query(Dimension::Target);

        let aggregates = aggregate_groups(
            &events,
            &Default::default(),
            &[],
            &[],
            &query,
            1_000,
            1_000,
            3,
            MeterFilters::default(),
        )
        .expect("taken grouped by target is supported");

        assert_eq!(aggregates.len(), 2, "one row per attacker enemy type");
        assert_eq!(
            aggregates[0].key,
            GroupKey::EnemyType {
                enemy_type: EnemyType::Unknown(GOBLIN)
            }
        );
        assert_eq!(aggregates[0].measure.amount, 500, "400 + 100");
        assert_eq!(
            aggregates[1].key,
            GroupKey::EnemyType {
                enemy_type: EnemyType::Unknown(WOLF)
            }
        );
        assert_eq!(aggregates[1].measure.amount, 250);

        assert_invariants(&aggregates, 750);
    }

    /// `damage`+`enemy` walks the same taken stream as `taken`+`friendly`
    /// above, over the exact same events — just naming the attacker
    /// `Source` instead of `Target` — so this is that same test's fixture
    /// with the query flipped, expecting the same rows.
    #[test]
    fn damage_enemy_grouped_by_source_matches_taken_friendly_grouped_by_target() {
        const GOBLIN: u32 = 0xAAAA_0001;
        const WOLF: u32 = 0xAAAA_0002;
        let events = vec![
            (1_000, Message::DamageEvent(enemy_hit(GOBLIN, 0, 9001, 400))),
            (2_000, Message::DamageEvent(enemy_hit(WOLF, 1, 9002, 250))),
            (3_000, Message::DamageEvent(enemy_hit(GOBLIN, 2, 9001, 100))),
        ];
        let query = damage_enemy_query(Dimension::Source);

        let aggregates = aggregate_groups(
            &events,
            &Default::default(),
            &[],
            &[],
            &query,
            1_000,
            1_000,
            3,
            MeterFilters::default(),
        )
        .expect("damage+enemy grouped by source is supported");

        assert_eq!(aggregates.len(), 2);
        assert_eq!(
            aggregates[0].key,
            GroupKey::EnemyType {
                enemy_type: EnemyType::Unknown(GOBLIN)
            }
        );
        assert_eq!(aggregates[0].measure.amount, 500);
        assert_eq!(
            aggregates[1].key,
            GroupKey::EnemyType {
                enemy_type: EnemyType::Unknown(WOLF)
            }
        );
        assert_eq!(aggregates[1].measure.amount, 250);

        assert_invariants(&aggregates, 750);
    }

    #[test]
    fn damage_enemy_rejects_a_source_from_the_player_universe() {
        let query = GroupQuery {
            source: Some(ActorRef::Player { index: 0 }),
            ..damage_enemy_query(Dimension::Source)
        };

        let result = aggregate_groups(
            &[],
            &Default::default(),
            &[],
            &[],
            &query,
            0,
            1_000,
            1,
            MeterFilters::default(),
        );

        assert_eq!(
            result,
            Err(GroupQueryError::WrongUniverse { field: "source" })
        );
    }

    #[test]
    fn taken_friendly_rejects_a_friendly_ability_filter() {
        let query = GroupQuery {
            ability: Some(AbilityFilter::Friendly {
                actions: vec![ActionType::Normal(1)],
            }),
            ..taken_friendly_query(Dimension::Source)
        };

        let result = aggregate_groups(
            &[],
            &Default::default(),
            &[],
            &[],
            &query,
            0,
            1_000,
            1,
            MeterFilters::default(),
        );

        assert_eq!(
            result,
            Err(GroupQueryError::WrongUniverse { field: "ability" })
        );
    }

    /// The one (metric, hostility) × ability-grammar corner none of the
    /// earlier tests touch: `taken`+`enemy` walks the DEALT stream (same row
    /// as `damage`+`friendly` in the role-mapping table), so it is the
    /// dealt stream's `Friendly` grammar that is valid here, and the taken
    /// stream's `EnemyAttack` grammar that is wrong-universe — the mirror
    /// image of `taken_friendly_rejects_a_friendly_ability_filter` above.
    #[test]
    fn taken_enemy_accepts_friendly_ability_filters_and_rejects_enemy_attack_ones() {
        let events = vec![
            (1_000, Message::DamageEvent(player_hit(0, 9, 100, 500))),
            // Different action, same attacker: must be narrowed away below.
            (1_500, Message::DamageEvent(player_hit(0, 9, 200, 300))),
            (2_000, Message::DamageEvent(player_hit(1, 9, 100, 250))),
        ];
        let mut narrowed = taken_enemy_query(Dimension::Target);
        narrowed.ability = Some(AbilityFilter::Friendly {
            actions: vec![ActionType::Normal(100)],
        });

        let aggregates = aggregate_groups(
            &events,
            &Default::default(),
            &[],
            &[],
            &narrowed,
            1_000,
            1_000,
            2,
            MeterFilters::default(),
        )
        .expect("taken+enemy accepts the dealt stream's own (friendly) ability grammar");

        assert_eq!(
            aggregates.len(),
            2,
            "one row per attacker; the action-200 hit is narrowed away"
        );
        assert_eq!(aggregates[0].key, GroupKey::Player { index: 0 });
        assert_eq!(
            aggregates[0].measure.amount, 500,
            "only the action-100 hit, not the 300-damage action-200 one"
        );
        assert_eq!(aggregates[1].key, GroupKey::Player { index: 1 });
        assert_eq!(aggregates[1].measure.amount, 250);
        assert_invariants(&aggregates, 750);

        let rejected = GroupQuery {
            ability: Some(AbilityFilter::EnemyAttack {
                enemy_type: EnemyType::Unknown(1),
                action_id: ActionType::Normal(1),
            }),
            ..taken_enemy_query(Dimension::Target)
        };
        let result = aggregate_groups(
            &[],
            &Default::default(),
            &[],
            &[],
            &rejected,
            0,
            1_000,
            1,
            MeterFilters::default(),
        );

        assert_eq!(
            result,
            Err(GroupQueryError::WrongUniverse { field: "ability" }),
            "the taken stream's grammar cannot pin a dealt-stream (taken+enemy) query"
        );
    }

    /// The symmetry invariant (spec §3): friendly `Damage` grouped by
    /// `Target` (per spawn, folded here by type since two goblin hits land
    /// on the same spawn) and enemy-side `Taken` (`taken`+`enemy`) grouped
    /// by `Source` walk the SAME dealt-stream events — the role-mapping
    /// table's two rows for the dealt stream — so their totals per enemy
    /// type must agree.
    #[test]
    fn friendly_damage_by_target_and_taken_enemy_by_source_agree_per_enemy_type() {
        const GOBLIN_TARGET: u32 = 9;
        const WOLF_TARGET: u32 = 10;
        let events = vec![
            (
                1_000,
                Message::DamageEvent(player_hit(0, GOBLIN_TARGET, 100, 400)),
            ),
            (
                2_000,
                Message::DamageEvent(player_hit(1, GOBLIN_TARGET, 100, 100)),
            ),
            (
                3_000,
                Message::DamageEvent(player_hit(0, WOLF_TARGET, 200, 250)),
            ),
        ];
        let (segments, assignment) = segment_targets_indexed(&events, 1_000);

        let friendly_by_target = friendly_damage_query(Dimension::Target);
        let friendly = aggregate_groups(
            &events,
            &Default::default(),
            &segments,
            &assignment,
            &friendly_by_target,
            1_000,
            1_000,
            3,
            MeterFilters::default(),
        )
        .expect("friendly damage grouped by target is supported");

        let taken_by_source = taken_enemy_query(Dimension::Source);
        let taken = aggregate_groups(
            &events,
            &Default::default(),
            &segments,
            &assignment,
            &taken_by_source,
            1_000,
            1_000,
            3,
            MeterFilters::default(),
        )
        .expect("taken+enemy grouped by source is supported");

        assert_invariants(&friendly, 750);
        assert_invariants(&taken, 750);
        assert_eq!(
            amount_by_enemy_type(&friendly),
            amount_by_enemy_type(&taken),
            "the same dealt hits, viewed from either side, must agree per enemy type"
        );
    }

    /// An `ActorRef::EnemySpawn{segment}` filter on the taken stream, where
    /// there is no per-spawn segment to match against directly (see
    /// `aggregate_groups`'s doc comment) — it narrows by (attacker enemy
    /// TYPE, timestamp within the segment's span) instead.
    #[test]
    fn an_enemy_spawn_filter_on_the_taken_stream_narrows_by_type_and_span() {
        const GOBLIN: u32 = 0xAAAA_0001;

        // A dealt-stream pair that opens and holds one goblin segment
        // spanning rel_ts 0..2_000ms.
        let mut open = player_hit(0, 9, 100, 10);
        open.target.actor_type = GOBLIN;
        open.target.parent_actor_type = GOBLIN;
        open.target_current_hp = Some(900);
        open.target_max_hp = Some(1_000);
        let mut close = player_hit(0, 9, 100, 10);
        close.target.actor_type = GOBLIN;
        close.target.parent_actor_type = GOBLIN;
        close.target_current_hp = Some(800);
        close.target_max_hp = Some(1_000);
        let dealt_events = vec![
            (1_000, Message::DamageEvent(open)),
            (3_000, Message::DamageEvent(close)),
        ];
        let (segments, assignment) = segment_targets_indexed(&dealt_events, 1_000);
        assert_eq!(segments.len(), 1, "one goblin segment");
        assert_eq!(segments[0].start_ms, 0);
        assert_eq!(segments[0].end_ms, 2_000);

        // Taken events: one inside the span (rel_ts 1_000), one outside
        // (rel_ts 5_000).
        let inside = enemy_hit(GOBLIN, 0, 9001, 300);
        let outside = enemy_hit(GOBLIN, 0, 9001, 999);
        let taken_events = vec![
            (2_000, Message::DamageEvent(inside)),
            (6_000, Message::DamageEvent(outside)),
        ];

        let mut query = damage_enemy_query(Dimension::Source);
        query.source = Some(ActorRef::EnemySpawn { segment: 0 });

        let aggregates = aggregate_groups(
            &taken_events,
            &Default::default(),
            &segments,
            &assignment,
            &query,
            1_000,
            1_000,
            6,
            MeterFilters::default(),
        )
        .expect("damage+enemy with an enemy-spawn source filter is supported");

        assert_eq!(aggregates.len(), 1);
        assert_eq!(
            aggregates[0].key,
            GroupKey::EnemyType {
                enemy_type: EnemyType::Unknown(GOBLIN)
            }
        );
        assert_eq!(
            aggregates[0].measure.amount, 300,
            "only the in-span hit counts; the out-of-span hit is dropped"
        );
    }

    /// The committed scrub window narrows the walk exactly as the derived
    /// state narrows under `ParseOptions::from_ms`/`up_to_ms` — the table's
    /// figures follow the scrub. Buckets stay whole-fight (the view slices
    /// its chart client-side), so out-of-window buckets are simply zero and
    /// the series still sums to the windowed measure.
    #[test]
    fn the_scrub_window_narrows_the_walk_on_both_streams() {
        let dealt_events = vec![
            (1_000, Message::DamageEvent(player_hit(0, 9, 100, 1_000))),
            (3_000, Message::DamageEvent(player_hit(0, 9, 100, 500))),
            (5_000, Message::DamageEvent(player_hit(0, 9, 100, 200))),
        ];
        let mut query = friendly_damage_query(Dimension::Source);
        query.from_ms = Some(2_000);
        query.up_to_ms = Some(3_999);

        let aggregates = aggregate_groups(
            &dealt_events,
            &Default::default(),
            &[],
            &[],
            &query,
            1_000,
            1_000,
            5,
            MeterFilters::default(),
        )
        .expect("a windowed friendly damage query is supported");

        assert_eq!(aggregates.len(), 1, "only the in-window player row");
        assert_eq!(aggregates[0].measure.amount, 500);
        assert_eq!(aggregates[0].measure.hits, 1);
        assert_eq!(aggregates[0].series, vec![0, 0, 500, 0, 0]);
        assert_invariants(&aggregates, 500);

        let taken_events = vec![
            (
                1_000,
                Message::DamageEvent(enemy_hit(0xAAAA_0001, 0, 9001, 300)),
            ),
            (
                4_000,
                Message::DamageEvent(enemy_hit(0xAAAA_0001, 0, 9001, 700)),
            ),
        ];
        let mut taken_query = taken_friendly_query(Dimension::Source);
        taken_query.from_ms = Some(2_000);
        taken_query.up_to_ms = None;

        let taken = aggregate_groups(
            &taken_events,
            &Default::default(),
            &[],
            &[],
            &taken_query,
            1_000,
            1_000,
            4,
            MeterFilters::default(),
        )
        .expect("a windowed taken query is supported");

        assert_eq!(taken.len(), 1);
        assert_eq!(
            taken[0].measure.amount, 700,
            "the pre-window hit is outside the scrub"
        );
    }

    #[test]
    fn deserializes_the_window_fields_and_defaults_them_absent() {
        let value = json!({
            "metric": "damage",
            "hostility": "friendly",
            "groupBy": "source",
            "fromMs": 2_000,
            "upToMs": 9_999
        });
        let query: GroupQuery = serde_json::from_value(value).expect("valid windowed GroupQuery");
        assert_eq!(query.from_ms, Some(2_000));
        assert_eq!(query.up_to_ms, Some(9_999));

        let bare = json!({ "metric": "damage", "hostility": "friendly", "groupBy": "source" });
        let query: GroupQuery =
            serde_json::from_value(bare).expect("window fields default to None");
        assert_eq!(query.from_ms, None);
        assert_eq!(query.up_to_ms, None);
    }

    #[test]
    fn an_out_of_range_target_segment_returns_an_empty_vec_not_an_error() {
        let events = vec![(1_000, Message::DamageEvent(player_hit(0, 9, 100, 500)))];
        let mut query = friendly_damage_query(Dimension::Target);
        query.target = Some(ActorRef::EnemySpawn { segment: 5 });

        let aggregates = aggregate_groups(
            &events,
            &Default::default(),
            &[],
            &[],
            &query,
            1_000,
            1_000,
            1,
            MeterFilters::default(),
        )
        .expect("a stale segment reference is not a validation error");

        assert_eq!(aggregates, Vec::new());
    }

    // --- the aura filter's windows mask -------------------------------------

    #[test]
    fn deserializes_aura_windows() {
        let value = json!({
            "metric": "damage",
            "hostility": "friendly",
            "groupBy": "source",
            "windows": [{ "fromMs": 1000, "upToMs": 5000 }]
        });
        let query: GroupQuery = serde_json::from_value(value).expect("valid GroupQuery JSON");

        assert_eq!(
            query.windows,
            Some(vec![TimeWindow {
                from_ms: 1_000,
                up_to_ms: 5_000
            }])
        );
    }

    #[test]
    fn windows_keep_only_events_inside_the_union_with_half_open_edges() {
        // start_time is 1_000, so the events sit at rel_ts 0 / 1000 / 2000 / 3000.
        let events = vec![
            (1_000, Message::DamageEvent(player_hit(0, 9, 100, 1))), // rel 0 - before the window
            (2_000, Message::DamageEvent(player_hit(0, 9, 100, 10))), // rel 1000 - AT from: kept (inclusive)
            (3_000, Message::DamageEvent(player_hit(0, 9, 100, 100))), // rel 2000 - inside: kept
            (4_000, Message::DamageEvent(player_hit(0, 9, 100, 1_000))), // rel 3000 - AT upTo: dropped (exclusive)
        ];
        let mut query = friendly_damage_query(Dimension::Source);
        query.windows = Some(vec![TimeWindow {
            from_ms: 1_000,
            up_to_ms: 3_000,
        }]);

        let aggregates = aggregate_groups(
            &events,
            &Default::default(),
            &[],
            &[],
            &query,
            1_000,
            1_000,
            4,
            MeterFilters::default(),
        )
        .expect("a windows mask is not a validation error");

        assert_eq!(aggregates.len(), 1);
        assert_eq!(aggregates[0].key, GroupKey::Player { index: 0 });
        assert_eq!(
            aggregates[0].measure.amount, 110,
            "10 at the from edge + 100 inside"
        );
        assert_eq!(aggregates[0].measure.hits, 2);
        assert_eq!(aggregates[0].series, vec![0, 10, 100, 0]);
    }

    #[test]
    fn windows_union_admits_an_event_in_any_window() {
        let events = vec![
            (1_000, Message::DamageEvent(player_hit(0, 9, 100, 1))), // rel 0 - first window
            (2_000, Message::DamageEvent(player_hit(0, 9, 100, 10))), // rel 1000 - the gap
            (3_000, Message::DamageEvent(player_hit(0, 9, 100, 100))), // rel 2000 - second window
        ];
        let mut query = friendly_damage_query(Dimension::Source);
        query.windows = Some(vec![
            TimeWindow {
                from_ms: 0,
                up_to_ms: 1_000,
            },
            TimeWindow {
                from_ms: 2_000,
                up_to_ms: 3_000,
            },
        ]);

        let aggregates = aggregate_groups(
            &events,
            &Default::default(),
            &[],
            &[],
            &query,
            1_000,
            1_000,
            3,
            MeterFilters::default(),
        )
        .expect("a windows mask is not a validation error");

        assert_eq!(
            aggregates[0].measure.amount, 101,
            "the gap's 10 is masked out"
        );
    }

    #[test]
    fn absent_windows_is_the_identity_and_empty_windows_matches_nothing() {
        let events = vec![(1_000, Message::DamageEvent(player_hit(0, 9, 100, 500)))];

        let unmasked = friendly_damage_query(Dimension::Source);
        let all = aggregate_groups(
            &events,
            &Default::default(),
            &[],
            &[],
            &unmasked,
            1_000,
            1_000,
            1,
            MeterFilters::default(),
        )
        .expect("no mask is supported");
        assert_eq!(all[0].measure.amount, 500);

        // Some(vec![]) narrows to NOTHING - the same "a stale filter narrows,
        // never widens" convention as an empty Friendly::actions list.
        let mut masked = friendly_damage_query(Dimension::Source);
        masked.windows = Some(Vec::new());
        let none = aggregate_groups(
            &events,
            &Default::default(),
            &[],
            &[],
            &masked,
            1_000,
            1_000,
            1,
            MeterFilters::default(),
        )
        .expect("an empty windows list is not a validation error");
        assert_eq!(none, Vec::new());
    }

    #[test]
    fn windows_mask_the_taken_stream_too() {
        const GOBLIN: u32 = 0xAAAA_0001;
        let events = vec![
            (1_000, Message::DamageEvent(enemy_hit(GOBLIN, 0, 9001, 400))), // rel 0 - masked out
            (2_000, Message::DamageEvent(enemy_hit(GOBLIN, 0, 9001, 100))), // rel 1000 - kept
        ];
        let mut query = taken_friendly_query(Dimension::Source);
        query.windows = Some(vec![TimeWindow {
            from_ms: 1_000,
            up_to_ms: 2_000,
        }]);

        let aggregates = aggregate_groups(
            &events,
            &Default::default(),
            &[],
            &[],
            &query,
            1_000,
            1_000,
            2,
            MeterFilters::default(),
        )
        .expect("a windows mask on the taken stream is supported");

        assert_eq!(aggregates.len(), 1);
        assert_eq!(aggregates[0].measure.amount, 100);
    }

    // --- the colour reference ------------------------------------------------

    #[test]
    fn reference_is_empty_when_the_query_narrows_no_time() {
        // The response's own aggregates already ARE the whole-fight ranking, so
        // walking a second time would buy nothing. Empty is how the view is
        // told to rank by what it was sent.
        let events = vec![(1_000, Message::DamageEvent(player_hit(0, 9, 100, 5)))];
        let query = friendly_damage_query(Dimension::Ability);

        let reference = aggregate_group_reference(
            &events,
            &Default::default(),
            &[],
            &[],
            &query,
            1_000,
            1_000,
            2,
            MeterFilters::default(),
        )
        .expect("no filter is not a validation error");

        assert!(reference.is_empty());
    }

    #[test]
    fn reference_ranks_by_the_whole_fight_while_the_mask_narrows_the_rows() {
        // Action 1 lands one huge hit OUTSIDE the mask; action 2 lands a small
        // one inside it. The aggregates see only action 2 — but the reference
        // must still rank action 1 first, which is exactly what stops a band
        // changing colour when the mask is applied.
        let events = vec![
            (1_000, Message::DamageEvent(player_hit(0, 9, 1, 1_000))), // rel 0 - outside
            (2_000, Message::DamageEvent(player_hit(0, 9, 2, 10))),    // rel 1000 - inside
        ];
        let mut query = friendly_damage_query(Dimension::Ability);
        query.windows = Some(vec![TimeWindow {
            from_ms: 1_000,
            up_to_ms: 2_000,
        }]);

        let aggregates = aggregate_groups(
            &events,
            &Default::default(),
            &[],
            &[],
            &query,
            1_000,
            1_000,
            2,
            MeterFilters::default(),
        )
        .expect("a windows mask is not a validation error");
        assert_eq!(aggregates.len(), 1, "the mask admits one action");

        let reference = aggregate_group_reference(
            &events,
            &Default::default(),
            &[],
            &[],
            &query,
            1_000,
            1_000,
            2,
            MeterFilters::default(),
        )
        .expect("a windows mask is not a validation error");

        // BOTH actions, largest first — including the one the mask excluded
        // entirely. Without it the surviving band's rank would compact from 1
        // to 0 and it would take the first colour instead of the second.
        assert_eq!(reference.len(), 2);
        assert_eq!(reference[0].amount, 1_000);
        assert_eq!(reference[1].amount, 10);
        assert_eq!(
            reference[1].key,
            GroupKey::FriendlyAbility {
                action_type: ActionType::Normal(2),
                child_character_type: CharacterType::Pl1000,
            },
            "the admitted band is ranked SECOND by the whole fight"
        );
    }

    #[test]
    fn reference_keeps_the_scrub_out_too_and_never_carries_the_rollup() {
        // The scrub narrows time exactly as the mask does, so it is stripped by
        // the same rule. `Other` is a chart rollup rather than a band anyone
        // draws, and a rank it occupied would be a colour no band could claim.
        let events = vec![
            (1_000, Message::DamageEvent(player_hit(0, 9, 1, 1_000))),
            (2_000, Message::DamageEvent(player_hit(0, 9, 2, 10))),
            (3_000, Message::DamageEvent(player_hit(0, 9, 3, 5))),
        ];
        let mut query = friendly_damage_query(Dimension::Ability);
        query.from_ms = Some(2_000);
        query.top_n = Some(1);

        let reference = aggregate_group_reference(
            &events,
            &Default::default(),
            &[],
            &[],
            &query,
            1_000,
            1_000,
            4,
            MeterFilters::default(),
        )
        .expect("a scrub is not a validation error");

        assert_eq!(reference.len(), 3, "every action in the whole fight");
        assert!(reference.iter().all(|row| row.key != GroupKey::Other));
    }
}
