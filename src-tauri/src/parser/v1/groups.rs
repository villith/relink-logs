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

/// Errors a `GroupQuery` can fail validation with before [`aggregate_groups`]
/// ever walks the event log.
#[derive(Debug, PartialEq)]
pub enum GroupQueryError {
    /// A ref from the wrong universe for the query's hostility role-mapping.
    WrongUniverse { field: &'static str },
    /// A grouping the metric does not declare (should be unreachable from the
    /// resolver; rejected rather than guessed).
    UnsupportedGrouping,
}

// main.rs stringifies every `#[tauri::command]` error with `.to_string()`
// (see e.g. `settings_db::read_all().map_err(|e| e.to_string())`), so this
// keeps that pattern viable for the query command Task 9 wires up rather than
// forcing a bespoke match at the call site.
impl std::fmt::Display for GroupQueryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GroupQueryError::WrongUniverse { field } => {
                write!(f, "'{field}' is not in this query's hostility universe")
            }
            GroupQueryError::UnsupportedGrouping => {
                write!(f, "this metric/hostility combination is not supported yet")
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
/// Scoped to [`GroupMetric::Damage`] + [`GroupHostility::Friendly`] for now —
/// every other combination is `Err(UnsupportedGrouping)` until the hostility
/// role-mapping (a later task) selects which key-extraction arm below
/// applies; the `match` on `query.group_by` is written so adding that
/// selection is a new arm, not a rewrite of this one.
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
    if query.metric != GroupMetric::Damage || query.hostility != GroupHostility::Friendly {
        return Err(GroupQueryError::UnsupportedGrouping);
    }

    if let Some(source) = query.source {
        if !matches!(source, ActorRef::Player { .. }) {
            return Err(GroupQueryError::WrongUniverse { field: "source" });
        }
    }
    if let Some(target) = query.target {
        if !matches!(target, ActorRef::EnemySpawn { .. }) {
            return Err(GroupQueryError::WrongUniverse { field: "target" });
        }
    }
    let action_filter = match &query.ability {
        None => None,
        Some(AbilityFilter::Friendly { actions }) => Some(actions.as_slice()),
        // Task 9 revisits: an enemy attack cannot pin a friendly-damage query.
        Some(AbilityFilter::EnemyAttack { .. }) => {
            return Err(GroupQueryError::WrongUniverse { field: "ability" })
        }
    };

    let source_index = match query.source {
        Some(ActorRef::Player { index }) => Some(index),
        _ => None,
    };

    // Out-of-range segment: matches nothing rather than falling back to
    // "everything" (an empty `target_spans` would mean the latter — see
    // `target_selected`). Same convention as `AnalysisView`'s own target-span
    // memo: a stale reference narrows to nothing, it never widens.
    let target_spans: Vec<TargetSpan> = match query.target {
        Some(ActorRef::EnemySpawn { segment }) => match segments.get(segment) {
            Some(entry) => vec![TargetSpan {
                id: entry.id,
                start_ms: entry.start_ms,
                end_ms: entry.end_ms,
            }],
            None => return Ok(Vec::new()),
        },
        _ => Vec::new(),
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
    let mut keyings: Vec<(u32, player_state::BreakdownKeying)> = Vec::new();

    for (position, (timestamp, message)) in events.iter().enumerate() {
        let Message::DamageEvent(damage_event) = message else {
            continue;
        };

        // Friendly dealt-damage only. The ingest gate
        // (`should_ignore_damage_event`) guarantees every DEALT hit already
        // has a known player source, but a damage-TAKEN event still carries
        // an enemy pointer in that same field — undropped, it would mint a
        // bogus `GroupKey::Player` for every enemy actor that ever hit the
        // party.
        if is_damage_taken_event(damage_event) {
            continue;
        }
        if !survives_shared_gates(damage_event, &phantoms, filters) {
            continue;
        }
        // `Some(&[])` (every sibling action was expanded away — a stale pin)
        // narrows to nothing, matching the convention above; `None` means no
        // ability filter was requested at all.
        if let Some(actions) = action_filter {
            if actions.is_empty() || !actions.contains(&damage_event.action_id) {
                continue;
            }
        }

        let damage_event = remap_dragon_form(player_data, damage_event);

        if let Some(wanted) = source_index {
            if damage_event.source.parent_index != wanted {
                continue;
            }
        }

        let rel_ts = timestamp - start_time;
        let Some(bucket) = bucket_for(rel_ts, &damage_event, &target_spans, interval, chart_len)
        else {
            continue;
        };

        let key = match query.group_by {
            Dimension::Source => GroupKey::Player {
                index: damage_event.source.parent_index,
            },
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
            Dimension::Target => {
                let Some(Some(segment_index)) = assignment.get(position) else {
                    continue;
                };
                let segment = &segments[*segment_index];
                GroupKey::EnemySpawn {
                    segment: *segment_index,
                    enemy_type: segment.enemy_type,
                    instance: segment.instance,
                }
            }
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

        let damage = damage_event.damage.max(0) as i64;
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
        }
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

    #[test]
    fn unsupported_metric_hostility_combinations_are_rejected() {
        let taken = GroupQuery {
            metric: GroupMetric::Taken,
            ..friendly_damage_query(Dimension::Source)
        };
        let enemy = GroupQuery {
            hostility: GroupHostility::Enemy,
            ..friendly_damage_query(Dimension::Source)
        };

        for query in [taken, enemy] {
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
            assert_eq!(result, Err(GroupQueryError::UnsupportedGrouping));
        }
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
}
