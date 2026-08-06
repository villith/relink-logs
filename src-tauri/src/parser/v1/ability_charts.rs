//! Per-ability bucketed series for the Stun and SBA analysis drill charts.
//!
//! Separate from the per-player charts in [`super`] because a band here must
//! correspond to a breakdown ROW: both builders key through
//! [`BreakdownKeying`], the same struct [`super::PlayerState`] routes damage
//! events through, so a band and the row it decomposes cannot drift.
//!
//! The Stun and SBA tabs are the derived path — their rows come from the
//! reconciled meter state, not from a re-derivable event walk — so the generic
//! group aggregation in [`super::groups`] cannot produce these bands: it is
//! built around a two-sided damage stream, and neither `OnPlayerStun` nor
//! `SbaGain` is one.

use std::collections::{HashMap, HashSet};

use protocol::{ActionType, Message, SbaGainCause};
use serde::Serialize;

use super::player_state::BreakdownKeying;
use super::{
    is_excluded, is_remote_slot, remap_dragon_form, target_selected, CharacterType, MeterFilters,
    PhantomTargets, PlayerData, TargetSpan,
};

/// A guard that just landed claims the stun message trailing it. Mirrors
/// `GUARD_STUN_WINDOW_MS` in `player_state.rs`, which owns the live-path rule.
const GUARD_STUN_WINDOW_MS: i64 = 150;

/// One chart band, in the two shapes a band can take.
///
/// A `Skill` band carries `(action_type, child_character_type)` rather than a
/// pre-folded display key, because the display grouping lives in the frontend
/// (`skillGroupFor`) and the parser is deliberately free of it — see the note on
/// `actionsForPin`. Serialized, that variant satisfies the frontend's `SkillRow`
/// structurally, so it feeds `abilityRowKey` with no cast.
///
/// A `Cause` band carries a row key instead, because it has no action at all:
/// [`ActionType`] has no `Group` variant in the protocol (the frontend's
/// `{ Group: string }` is a display-only synthetic), so gauge granted by a party
/// award — or left unattributed — cannot borrow one. Its `key` uses the same
/// `source:{kind}[:{id}]` / `skill:unattributed` grammar `metrics/sba.ts` builds
/// its rows with, so a band and its row share one identity.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AbilitySeries {
    #[serde(rename_all = "camelCase")]
    Skill {
        action_type: ActionType,
        child_character_type: CharacterType,
        values: Vec<f64>,
    },
    #[serde(rename_all = "camelCase")]
    Cause { key: String, values: Vec<f64> },
}

impl AbilitySeries {
    pub fn values(&self) -> &[f64] {
        match self {
            Self::Skill { values, .. } | Self::Cause { values, .. } => values,
        }
    }
}

/// The character a synthesized row (Perfect Guard, Stun Effect) is filed under.
/// Mirrors `PlayerState::character_type`, which the live path uses for exactly
/// these rows. An unresolved slot falls back to `Unknown(0)` rather than being
/// dropped: the band is still real, only its character is not yet known.
fn character_of(player_data: &[Option<PlayerData>; 4], slot_key: u32) -> CharacterType {
    protocol::party_slot_of(slot_key)
        .and_then(|slot| player_data[slot].as_ref())
        .map(|player| player.character_type)
        .unwrap_or(CharacterType::Unknown(0))
}

/// Whether an action can own a stun message. Echoes and DoT ticks never do —
/// mirrors the `note_excluded_damage` rule and `last_stun_attribution`.
fn stun_capable(action: ActionType) -> bool {
    !matches!(
        action,
        ActionType::SupplementaryDamage(_) | ActionType::DamageOverTime(_)
    )
}

type RowKey = (ActionType, CharacterType);

/// The two capture paths' accumulators for one player, keyed by breakdown row.
#[derive(Default)]
struct StunPaths {
    delta: HashMap<RowKey, Vec<f64>>,
    message: HashMap<RowKey, Vec<f64>>,
}

fn add_at(
    map: &mut HashMap<RowKey, Vec<f64>>,
    key: RowKey,
    bucket: usize,
    chart_len: usize,
    amount: f64,
) {
    map.entry(key).or_insert_with(|| vec![0.0; chart_len])[bucket] += amount;
}

/// Per-ability stun applied per bucket, keyed by player then by breakdown row.
///
/// The per-ability mirror of [`super::build_player_stun_chart`], and every gate
/// that one applies is applied here: phantom exclusion, filter exclusion, the
/// excluded-hit stun suppression, the dragon-form remap, target spans, and
/// Perfect Guard's local-versus-remote zero rule.
///
/// `max(delta, message)` is resolved PER BREAKDOWN ROW, not per player. `max` of
/// sums is not the sum of `max`es, so the walk records both paths in full and
/// only then keeps the larger-summing one for each row — the same trick
/// `build_player_stun_chart` uses one level up. Each band therefore sums to the
/// `total_stun_value` its skill row reports, so the stack's height cannot
/// disagree with the table underneath it.
#[allow(clippy::too_many_arguments)]
pub fn build_ability_stun_chart(
    events: &[(i64, Message)],
    player_data: &[Option<PlayerData>; 4],
    player_indices: &[u32],
    start_time: i64,
    interval: i64,
    chart_len: usize,
    target_spans: &[TargetSpan],
    filters: MeterFilters,
) -> HashMap<u32, Vec<AbilitySeries>> {
    let mut paths: HashMap<u32, StunPaths> = player_indices
        .iter()
        .map(|index| (*index, StunPaths::default()))
        .collect();
    // One keying per player, fed that player's damage events in log order —
    // the contract `BreakdownKeying` documents.
    let mut keying: HashMap<u32, BreakdownKeying> = HashMap::new();
    // The message path's attribution target, mirroring
    // `PlayerState::last_stun_attribution`: the last stun-capable row opened.
    let mut last_stun_attribution: HashMap<u32, RowKey> = HashMap::new();
    // A guard that just landed claims the message trailing it, mirroring
    // `PlayerState::add_stun_message`; one message per guard, so it is consumed.
    let mut last_guard_at: HashMap<u32, i64> = HashMap::new();
    let phantoms = PhantomTargets::learned_from(events.iter());
    // Mirrors `DerivedEncounterState::stun_suppressed_players`: an excluded hit
    // claims the message trailing it so it is dropped, and the next counted
    // stun-capable hit takes that claim back.
    let mut suppressed: HashSet<u32> = HashSet::new();

    for (timestamp, event) in events {
        let bucket = ((timestamp - start_time) / interval) as usize;
        if bucket >= chart_len {
            continue;
        }

        match event {
            Message::DamageEvent(damage_event) => {
                if phantoms.is_phantom(damage_event) {
                    continue;
                }
                if is_excluded(damage_event, &filters) {
                    if stun_capable(damage_event.action_id) {
                        suppressed.insert(damage_event.source.parent_index);
                    }
                    continue;
                }

                let damage_event = remap_dragon_form(player_data, damage_event);
                let player = damage_event.source.parent_index;

                if stun_capable(damage_event.action_id) {
                    suppressed.remove(&player);
                }

                let Some(paths) = paths.get_mut(&player) else {
                    continue;
                };
                let key = keying.entry(player).or_default().key_for(&damage_event);

                if stun_capable(damage_event.action_id) {
                    last_stun_attribution.insert(player, key);
                }

                if target_selected(timestamp - start_time, &damage_event, target_spans) {
                    add_at(
                        &mut paths.delta,
                        key,
                        bucket,
                        chart_len,
                        damage_event.stun_value.unwrap_or(0.0) as f64,
                    );
                }
            }
            Message::OnPlayerStun(stun) => {
                if suppressed.contains(&stun.actor_index) {
                    continue;
                }
                let claims_guard = last_guard_at.get(&stun.actor_index).is_some_and(|at| {
                    *at <= *timestamp && timestamp.saturating_sub(*at) <= GUARD_STUN_WINDOW_MS
                });
                let key = if claims_guard {
                    last_guard_at.remove(&stun.actor_index);
                    (
                        ActionType::PerfectGuard,
                        character_of(player_data, stun.actor_index),
                    )
                } else {
                    match last_stun_attribution.get(&stun.actor_index).copied() {
                        Some(key) => key,
                        // No stun-capable hit yet: the live path files this
                        // against no row either, so there is no band for it.
                        None => continue,
                    }
                };
                let Some(paths) = paths.get_mut(&stun.actor_index) else {
                    continue;
                };
                add_at(
                    &mut paths.message,
                    key,
                    bucket,
                    chart_len,
                    stun.stun_amount as f64,
                );
            }
            Message::OnPerfectGuardStun(guard) => {
                last_guard_at.insert(guard.actor_index, *timestamp);
                // A local guard always registers its stun in-call, so 0 means it
                // applied none. Remote guards are host-authoritative and read 0
                // regardless, so 0 carries no information there.
                if guard.stun_amount <= 0.0
                    && is_remote_slot(player_data, guard.actor_index) == Some(false)
                {
                    continue;
                }
                let key = (
                    ActionType::PerfectGuard,
                    character_of(player_data, guard.actor_index),
                );
                let Some(paths) = paths.get_mut(&guard.actor_index) else {
                    continue;
                };
                add_at(
                    &mut paths.delta,
                    key,
                    bucket,
                    chart_len,
                    guard.stun_amount as f64,
                );
            }
            Message::OnStunEffect(effect) => {
                let key = (
                    ActionType::StunEffect(0),
                    character_of(player_data, effect.actor_index),
                );
                let Some(paths) = paths.get_mut(&effect.actor_index) else {
                    continue;
                };
                add_at(
                    &mut paths.delta,
                    key,
                    bucket,
                    chart_len,
                    effect.stun_amount as f64,
                );
            }
            _ => {}
        }
    }

    paths
        .into_iter()
        .map(|(player, paths)| (player, resolve_paths(paths)))
        .collect()
}

/// Keep whichever path saw the accrual, PER ROW (see the `max` note on
/// [`build_ability_stun_chart`]). Bands that accrued nothing at all are dropped:
/// an all-zero band is one the legend would name and colour for nothing.
fn resolve_paths(mut paths: StunPaths) -> Vec<AbilitySeries> {
    // `CharacterType` is not `Ord`, so the union is deduped by hash and the
    // ordering is imposed below instead.
    let keys: HashSet<RowKey> = paths
        .delta
        .keys()
        .chain(paths.message.keys())
        .copied()
        .collect();

    let mut bands: Vec<AbilitySeries> = keys
        .into_iter()
        .filter_map(|key| {
            let deltas = paths.delta.remove(&key).unwrap_or_default();
            let messages = paths.message.remove(&key).unwrap_or_default();
            let values = if deltas.iter().sum::<f64>() >= messages.iter().sum::<f64>() {
                deltas
            } else {
                messages
            };
            if values.iter().all(|value| *value == 0.0) {
                return None;
            }
            Some(AbilitySeries::Skill {
                action_type: key.0,
                child_character_type: key.1,
                values,
            })
        })
        .collect();

    sort_bands(&mut bands);
    bands
}

/// Largest first, so the frontend's top-N slice keeps the bands that matter even
/// before it re-ranks them by display group. Ties break on the band's own debug
/// spelling rather than being left to `HashMap` iteration order, which would
/// make the wire output — and any test asserting on it — nondeterministic.
fn sort_bands(bands: &mut [AbilitySeries]) {
    let total = |band: &AbilitySeries| band.values().iter().sum::<f64>();
    bands.sort_by(|a, b| {
        total(b)
            .partial_cmp(&total(a))
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| format!("{a:?}").cmp(&format!("{b:?}")))
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::{Actor, DamageEvent, OnPlayerStunEvent};

    fn a_damage_event(player: u32, action: ActionType, stun: Option<f32>) -> DamageEvent {
        DamageEvent {
            source: Actor {
                index: player,
                actor_type: 0x2AF6_78E8,
                parent_actor_type: 0x2AF6_78E8,
                parent_index: player,
            },
            target: Actor {
                index: 1,
                actor_type: 0,
                parent_actor_type: 0,
                parent_index: 1,
            },
            damage: 500,
            flags: 0,
            action_id: action,
            attack_rate: None,
            stun_value: stun,
            damage_cap: None,
            base_damage: None,
            target_current_hp: None,
            target_max_hp: None,
        }
    }

    fn stun_hit(player: u32, action: ActionType, stun: f32) -> Message {
        Message::DamageEvent(a_damage_event(player, action, Some(stun)))
    }

    fn stun_message(player: u32, amount: f32) -> Message {
        Message::OnPlayerStun(OnPlayerStunEvent {
            actor_index: player,
            stun_amount: amount,
        })
    }

    fn no_players() -> [Option<PlayerData>; 4] {
        [None, None, None, None]
    }

    fn stun_bands(events: &[(i64, Message)], chart_len: usize) -> Vec<AbilitySeries> {
        build_ability_stun_chart(
            events,
            &no_players(),
            &[0],
            0,
            1_000,
            chart_len,
            &[],
            MeterFilters::default(),
        )
        .remove(&0)
        .expect("the requested player always has a row")
    }

    fn values_for(bands: &[AbilitySeries], action: ActionType) -> Vec<f64> {
        bands
            .iter()
            .find(|band| matches!(band, AbilitySeries::Skill { action_type, .. } if *action_type == action))
            .unwrap_or_else(|| panic!("a band for {action:?}"))
            .values()
            .to_vec()
    }

    #[test]
    fn the_delta_path_buckets_per_action() {
        let events = vec![
            (0, stun_hit(0, ActionType::Normal(1), 10.0)),
            (1_500, stun_hit(0, ActionType::Normal(2), 4.0)),
            (1_800, stun_hit(0, ActionType::Normal(1), 6.0)),
        ];
        let bands = stun_bands(&events, 3);

        assert_eq!(
            values_for(&bands, ActionType::Normal(1)),
            vec![10.0, 6.0, 0.0]
        );
        assert_eq!(
            values_for(&bands, ActionType::Normal(2)),
            vec![0.0, 4.0, 0.0]
        );
    }

    #[test]
    fn the_message_path_attributes_to_the_last_stun_capable_action() {
        // Online, the delta method structurally reads 0 and the message carries
        // no action id — it belongs to the last stun-capable hit.
        let events = vec![
            (0, stun_hit(0, ActionType::Normal(1), 0.0)),
            (10, stun_message(0, 25.0)),
        ];
        let bands = stun_bands(&events, 2);

        assert_eq!(values_for(&bands, ActionType::Normal(1)), vec![25.0, 0.0]);
    }

    #[test]
    fn an_echo_never_steals_a_messages_attribution() {
        // Mirrors `stun_messages_attribute_to_the_players_last_stun_capable_action`:
        // echoes and DoT ticks land after a hit but cannot own its stun message.
        let events = vec![
            (0, stun_hit(0, ActionType::Normal(1), 0.0)),
            (100, stun_hit(0, ActionType::SupplementaryDamage(1), 0.0)),
            (200, stun_hit(0, ActionType::DamageOverTime(0), 0.0)),
            (300, stun_message(0, 12.0)),
        ];
        let bands = stun_bands(&events, 1);

        assert_eq!(values_for(&bands, ActionType::Normal(1)), vec![12.0]);
    }

    #[test]
    fn each_row_keeps_its_own_winning_path() {
        // Action 1 accrues only on the delta path, action 2 only via messages.
        // Deciding the winner per PLAYER would drop one of them; per ROW keeps
        // both, which is what makes each band match its table row.
        let events = vec![
            (0, stun_hit(0, ActionType::Normal(1), 30.0)),
            (10, stun_hit(0, ActionType::Normal(2), 0.0)),
            (20, stun_message(0, 40.0)),
        ];
        let bands = stun_bands(&events, 1);

        assert_eq!(
            values_for(&bands, ActionType::Normal(1)),
            vec![30.0],
            "delta won for action 1"
        );
        assert_eq!(
            values_for(&bands, ActionType::Normal(2)),
            vec![40.0],
            "message won for action 2"
        );
    }

    #[test]
    fn the_two_paths_never_double_count_one_row() {
        // Solo loopback fires both paths for one accrual. max(), not a sum.
        let events = vec![
            (0, stun_hit(0, ActionType::Normal(1), 20.0)),
            (10, stun_message(0, 20.0)),
        ];
        let bands = stun_bands(&events, 1);

        assert_eq!(values_for(&bands, ActionType::Normal(1)), vec![20.0]);
    }

    #[test]
    fn an_excluded_hit_suppresses_the_message_trailing_it() {
        // Mirrors `stun_chart_drops_a_message_trailing_an_excluded_hit`: a hit
        // the meters do not count claims the message after it so it is dropped,
        // rather than being credited to the skill before it.
        let mut burst = a_damage_event(
            0,
            ActionType::Normal(protocol::SUMMON_ATTACK_ACTION_ID),
            Some(50.0),
        );
        burst.source.actor_type = protocol::PRIMAL_BURST_BODY_HASHES[0];

        let events = vec![
            (0, stun_hit(0, ActionType::Normal(1), 5.0)),
            (10, Message::DamageEvent(burst)),
            (20, stun_message(0, 99.0)),
        ];
        let bands = stun_bands(&events, 1);

        assert_eq!(
            values_for(&bands, ActionType::Normal(1)),
            vec![5.0],
            "the suppressed message never reaches action 1"
        );
    }

    #[test]
    fn a_guard_claims_the_message_trailing_it() {
        let events = vec![
            (0, stun_hit(0, ActionType::Normal(1), 0.0)),
            (
                100,
                Message::OnPerfectGuardStun(OnPlayerStunEvent {
                    actor_index: 0,
                    stun_amount: 0.0,
                }),
            ),
            (200, stun_message(0, 30.0)),
        ];
        let bands = stun_bands(&events, 1);

        assert_eq!(
            values_for(&bands, ActionType::PerfectGuard),
            vec![30.0],
            "inside GUARD_STUN_WINDOW_MS the guard owns it, not action 1"
        );
    }

    #[test]
    fn a_stale_guard_does_not_claim_a_later_message() {
        let events = vec![
            (0, stun_hit(0, ActionType::Normal(1), 0.0)),
            (
                100,
                Message::OnPerfectGuardStun(OnPlayerStunEvent {
                    actor_index: 0,
                    stun_amount: 0.0,
                }),
            ),
            // 151 ms later: past GUARD_STUN_WINDOW_MS.
            (251, stun_message(0, 30.0)),
        ];
        let bands = stun_bands(&events, 1);

        assert_eq!(values_for(&bands, ActionType::Normal(1)), vec![30.0]);
    }

    #[test]
    fn a_stun_effect_gets_its_own_band() {
        let events = vec![
            (0, stun_hit(0, ActionType::Normal(1), 5.0)),
            (
                100,
                Message::OnStunEffect(OnPlayerStunEvent {
                    actor_index: 0,
                    stun_amount: 25.0,
                }),
            ),
        ];
        let bands = stun_bands(&events, 1);

        assert_eq!(values_for(&bands, ActionType::StunEffect(0)), vec![25.0]);
    }

    #[test]
    fn bands_that_accrued_nothing_are_dropped() {
        let events = vec![(0, stun_hit(0, ActionType::Normal(1), 0.0))];
        let bands = stun_bands(&events, 1);

        assert!(bands.is_empty(), "an all-zero band is not drawn");
    }

    #[test]
    fn events_past_the_chart_are_ignored() {
        let events = vec![
            (0, stun_hit(0, ActionType::Normal(1), 5.0)),
            (9_000, stun_hit(0, ActionType::Normal(1), 100.0)),
        ];
        let bands = stun_bands(&events, 2);

        assert_eq!(values_for(&bands, ActionType::Normal(1)), vec![5.0, 0.0]);
    }

    #[test]
    fn a_skill_band_serializes_as_a_skill_row() {
        let band = AbilitySeries::Skill {
            action_type: ActionType::Normal(1),
            child_character_type: CharacterType::Pl0000,
            values: vec![1.0, 2.0],
        };
        let json = serde_json::to_value(&band).expect("serializes");

        assert_eq!(json["kind"], "skill");
        // The two fields the frontend's `SkillRow` is made of — a band satisfies
        // it structurally, which is what lets `abilityRowKey` fold these.
        assert!(json.get("actionType").is_some(), "actionType present");
        assert!(
            json.get("childCharacterType").is_some(),
            "childCharacterType present"
        );
        assert_eq!(json["values"], serde_json::json!([1.0, 2.0]));
    }

    #[test]
    fn a_cause_band_serializes_with_its_row_key() {
        let band = AbilitySeries::Cause {
            key: "source:partyAward".to_string(),
            values: vec![3.0],
        };
        let json = serde_json::to_value(&band).expect("serializes");

        assert_eq!(json["kind"], "cause");
        assert_eq!(json["key"], "source:partyAward");
        assert!(
            json.get("actionType").is_none(),
            "a cause has no action to carry"
        );
    }
}
