//! The analysis view's generic aggregation: one (filters × groupBy) request
//! answering both the table rows and the chart bands from a single grouping,
//! so the two can never disagree. See
//! docs/superpowers/specs/2026-08-04-analysis-view-state-machine-design.md.

use protocol::ActionType;
use serde::{Deserialize, Serialize};

use crate::parser::constants::{CharacterType, EnemyType};

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
#[derive(Debug, Clone, PartialEq, Serialize)]
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupAggregate {
    pub key: GroupKey,
    pub measure: GroupMeasure,
    /// Whole-fight per-bucket band (same buckets as dps_chart) — the view
    /// slices client-side, exactly like the drill charts it replaces.
    pub series: Vec<i64>,
}

/// Errors a `GroupQuery` can fail validation with before an aggregator (Task
/// 8) ever walks the event log.
#[derive(Debug, PartialEq)]
pub enum GroupQueryError {
    /// A ref from the wrong universe for the query's hostility role-mapping.
    WrongUniverse { field: &'static str },
    /// A grouping the metric does not declare (should be unreachable from the
    /// resolver; rejected rather than guessed).
    UnsupportedGrouping,
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
}
