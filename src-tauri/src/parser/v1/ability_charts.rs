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

use super::chart_scope::ChartScope;
use super::player_state::BreakdownKeying;
use super::{is_remote_slot, remap_dragon_form, CharacterType, PhantomTargets, PlayerData};

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
///
/// `abilities` is the selector bar's ability pin, already expanded to actions
/// (empty = all). Applied to the finished BANDS rather than to the events: a
/// band carries the resolved breakdown-row action, which is what the table's
/// rows are keyed by, so filtering here is what keeps the two showing the same
/// abilities. Filtering raw `action_id`s instead would disagree wherever the
/// keying rewrites one (Ferry's pet remap, the supplementary fold).
pub fn build_ability_stun_chart(
    events: &[(i64, Message)],
    player_indices: &[u32],
    start_time: i64,
    interval: i64,
    chart_len: usize,
    scope: &ChartScope,
) -> HashMap<u32, Vec<AbilitySeries>> {
    let player_data = scope.player_data;
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
                if !scope.counted(damage_event) {
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

                if scope.selects_target(timestamp - start_time, &damage_event) {
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
        .map(|(player, paths)| (player, resolve_paths(paths, scope)))
        .collect()
}

/// Keep whichever path saw the accrual, PER ROW (see the `max` note on
/// [`build_ability_stun_chart`]). Bands that accrued nothing at all are dropped:
/// an all-zero band is one the legend would name and colour for nothing.
fn resolve_paths(mut paths: StunPaths, scope: &ChartScope) -> Vec<AbilitySeries> {
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
            if values.iter().all(|value| *value == 0.0) || !scope.selects_ability(key.0) {
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

/// The remainder band's row key. Matches the key `metrics/sba.ts` gives its
/// unattributed row, so the band and the row are one identity.
const UNATTRIBUTED_KEY: &str = "skill:unattributed";

/// A non-skill cause's row key, in the `source:{kind}[:{id}]` grammar
/// `metrics/sba.ts` builds its cause rows with. The kind spellings are
/// `SbaSourceKind`'s own camelCase serde names — one vocabulary, so a band and
/// its row cannot be keyed differently.
fn cause_key(cause: &SbaGainCause) -> Option<String> {
    let (kind, id) = match cause {
        // A skill gain belongs on a breakdown row, not a cause band.
        SbaGainCause::Skill(_) => return None,
        SbaGainCause::DamageTaken => ("damageTaken", None),
        SbaGainCause::PerfectGuard => ("perfectGuard", None),
        SbaGainCause::Effect(id) => ("effect", Some(*id)),
        SbaGainCause::PartyAward => ("partyAward", None),
        SbaGainCause::DirectorAward => ("directorAward", None),
        SbaGainCause::QuestStart => ("questStart", None),
        SbaGainCause::PerfectDodge => ("perfectDodge", None),
        SbaGainCause::Site(tag) => ("site", Some(*tag)),
        SbaGainCause::Unknown => ("unknown", None),
        // Deduced causes (see `sba_inference`). Their own band keys, so a
        // stack never blends a correlation into a measured one.
        SbaGainCause::InferredChainGrant => ("inferredChainGrant", None),
        SbaGainCause::InferredDamageTaken => ("inferredDamageTaken", None),
        // Handled by the caller's skill arm — an inferred move belongs to the
        // ability band its hit opened, not to a cause band.
        SbaGainCause::Inferred(_) => return None,
    };
    Some(match id {
        Some(id) => format!("source:{kind}:{id}"),
        None => format!("source:{kind}"),
    })
}

/// Per-ability SBA gauge GENERATED per bucket, keyed by player then band.
///
/// Note the quantity: the SBA tab's undrilled chart plots the gauge LEVEL, which
/// cannot be decomposed by contributor because it discharges to zero on cast.
/// Drilled in, the chart plots generation instead — a rate, which stacks — and
/// `chartPresentation` switches the axis with the grouping.
///
/// A gain carries a RAW action id, not a row key: the resolved key can differ in
/// BOTH halves (Ferry's pet remap rewrites the action, a child actor changes the
/// character), so it is resolved through [`BreakdownKeying::row_for_raw_action`]
/// — the memo of what the damage path did with that same id. A gain never opens
/// a row, mirroring `PlayerState::add_sba_gain`: keying one independently is
/// what produced the hit-less twin of every dragon-form skill in live log 1681.
///
/// Three kinds of band come out, mirroring the three kinds of row the table
/// shows: attributed skills, named non-hit causes, and the remainder. The
/// remainder exists because attribution comes from `SbaGain` (local player only)
/// while the total comes from the gauge POLL (all four members) — so without it
/// the stack would silently undershoot the player row it sits under, by 31-42%
/// on live log 1681.
///
/// `abilities` is the selector bar's ability pin (empty = all), applied to the
/// finished bands for the same reason as in [`build_ability_stun_chart`]. A pin
/// also drops the CAUSE bands and the remainder: both describe the whole player
/// — the remainder is measured against their polled total — so keeping them
/// beside one ability would make the stack's height mean two different things.
pub fn build_ability_sba_chart(
    events: &[(i64, Message)],
    player_indices: &[u32],
    start_time: i64,
    interval: i64,
    chart_len: usize,
    scope: &ChartScope,
) -> HashMap<u32, Vec<AbilitySeries>> {
    let player_data = scope.player_data;
    let mut skills: HashMap<u32, HashMap<RowKey, Vec<f64>>> = player_indices
        .iter()
        .map(|index| (*index, HashMap::new()))
        .collect();
    let mut causes: HashMap<u32, HashMap<String, Vec<f64>>> = player_indices
        .iter()
        .map(|index| (*index, HashMap::new()))
        .collect();
    // The poll-derived generation, which covers ALL FOUR members where
    // attribution covers only the local one. Their difference is the remainder.
    let mut polled: HashMap<u32, Vec<f64>> = HashMap::new();
    let mut keying: HashMap<u32, BreakdownKeying> = HashMap::new();
    let phantoms = PhantomTargets::learned_from(events.iter());

    for (timestamp, event) in events {
        let bucket = ((timestamp - start_time) / interval) as usize;
        if bucket >= chart_len {
            continue;
        }

        match event {
            // Damage events open no band of their own here; they teach the
            // keying memo which row each raw action id currently belongs to.
            Message::DamageEvent(damage_event) => {
                if phantoms.is_phantom(damage_event) || !scope.counted(damage_event) {
                    continue;
                }
                let damage_event = remap_dragon_form(player_data, damage_event);
                let player = damage_event.source.parent_index;
                if skills.contains_key(&player) {
                    keying.entry(player).or_default().key_for(&damage_event);
                }
            }
            Message::SbaGain(gain) => {
                if !skills.contains_key(&gain.actor_index) {
                    continue;
                }
                // A log stored before causes existed carries its attribution in
                // `action_id`; the parser reads that as `Skill(Normal(id))`.
                let cause = gain
                    .cause
                    .unwrap_or(SbaGainCause::Skill(ActionType::Normal(gain.action_id)));

                match cause {
                    // An inferred move rides in the same band as a read one:
                    // this chart plots WHERE a player's gauge came from, and
                    // both answers name the same ability. The measured/deduced
                    // split is carried per row in the table, which is where a
                    // reader can act on it.
                    SbaGainCause::Skill(raw_action) | SbaGainCause::Inferred(raw_action) => {
                        let Some(key) = keying
                            .get(&gain.actor_index)
                            .and_then(|keying| keying.row_for_raw_action(raw_action))
                        else {
                            // No row has opened for this id yet. The live path
                            // holds it pending; here it simply has no band, and
                            // the remainder absorbs it rather than inventing one.
                            continue;
                        };
                        let rows = skills.get_mut(&gain.actor_index).expect("checked above");
                        add_at(rows, key, bucket, chart_len, gain.amount as f64);
                    }
                    other => {
                        let Some(key) = cause_key(&other) else {
                            continue;
                        };
                        let rows = causes.get_mut(&gain.actor_index).expect("checked above");
                        rows.entry(key).or_insert_with(|| vec![0.0; chart_len])[bucket] +=
                            gain.amount as f64;
                    }
                }
            }
            Message::OnUpdateSBA(update) => {
                if !skills.contains_key(&update.actor_index) {
                    continue;
                }
                // `sba_added` is the poll's own measured rise. Clamped at zero:
                // a discharge reads as a fall, and a negative would subtract
                // from the denominator the remainder is computed against.
                polled
                    .entry(update.actor_index)
                    .or_insert_with(|| vec![0.0; chart_len])[bucket] +=
                    (update.sba_added as f64).max(0.0);
            }
            _ => {}
        }
    }

    // The deduced half, folded in on the same terms as the read half. Without
    // this the chart and the SBA table would disagree about the same fight: the
    // table lists a remote member's inferred ability rows while the chart, which
    // only ever saw `SbaGain` events, would still draw all of it as remainder.
    // Keying goes through the same memo, so an inferred gain lands in the band
    // its own hit opened or in none at all.
    for gain in super::sba_inference::infer(events, &|_| true) {
        if !skills.contains_key(&gain.actor_index) {
            continue;
        }
        let bucket = ((gain.at - start_time) / interval) as usize;
        if bucket >= chart_len {
            continue;
        }
        match gain.cause {
            SbaGainCause::Inferred(raw_action) => {
                let Some(key) = keying
                    .get(&gain.actor_index)
                    .and_then(|keying| keying.row_for_raw_action(raw_action))
                else {
                    continue;
                };
                let rows = skills.get_mut(&gain.actor_index).expect("checked above");
                add_at(rows, key, bucket, chart_len, gain.amount);
            }
            other => {
                let Some(key) = cause_key(&other) else {
                    continue;
                };
                let rows = causes.get_mut(&gain.actor_index).expect("checked above");
                rows.entry(key).or_insert_with(|| vec![0.0; chart_len])[bucket] += gain.amount;
            }
        }
    }

    player_indices
        .iter()
        .map(|player| {
            let skill_rows = skills.remove(player).unwrap_or_default();
            let cause_rows = causes.remove(player).unwrap_or_default();

            let mut bands: Vec<AbilitySeries> = skill_rows
                .into_iter()
                .filter(|(_, values)| values.iter().any(|value| *value != 0.0))
                .map(|(key, values)| AbilitySeries::Skill {
                    action_type: key.0,
                    child_character_type: key.1,
                    values,
                })
                .chain(
                    cause_rows
                        .into_iter()
                        .filter(|(_, values)| values.iter().any(|value| *value != 0.0))
                        .map(|(key, values)| AbilitySeries::Cause { key, values }),
                )
                .collect();

            // A pin narrows to ONE ability; the whole-player bands stop applying.
            if !scope.abilities.is_empty() {
                bands.retain(|band| match band {
                    AbilitySeries::Skill { action_type, .. } => scope.selects_ability(*action_type),
                    AbilitySeries::Cause { .. } => false,
                });
                sort_bands(&mut bands);
                return (*player, bands);
            }

            if let Some(total) = polled.get(player) {
                let remainder: Vec<f64> = (0..chart_len)
                    .map(|bucket| {
                        let named: f64 = bands.iter().map(|band| band.values()[bucket]).sum();
                        // Floored at zero: the poll lags the gains it covers, so
                        // one bucket can attribute more than it polled. A
                        // negative band draws as a notch out of the stack below.
                        (total[bucket] - named).max(0.0)
                    })
                    .collect();
                if remainder.iter().any(|value| *value != 0.0) {
                    bands.push(AbilitySeries::Cause {
                        key: UNATTRIBUTED_KEY.to_string(),
                        values: remainder,
                    });
                }
            }

            sort_bands(&mut bands);
            (*player, bands)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::v1::MeterFilters;
    use protocol::{Actor, DamageEvent, OnPlayerStunEvent, OnUpdateSBAEvent, SbaGainEvent};

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
            class_flags: None,
            source_current_hp: None,
            source_max_hp: None,
            source_statuses: None,
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

    const NO_PLAYERS: [Option<PlayerData>; 4] = [None, None, None, None];

    fn scope(abilities: &[ActionType]) -> ChartScope<'_> {
        ChartScope {
            player_data: &NO_PLAYERS,
            target_spans: &[],
            abilities,
            filters: MeterFilters::default(),
        }
    }

    fn stun_bands(events: &[(i64, Message)], chart_len: usize) -> Vec<AbilitySeries> {
        build_ability_stun_chart(events, &[0], 0, 1_000, chart_len, &scope(&[]))
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

    fn sba_gain(player: u32, cause: SbaGainCause, amount: f32) -> Message {
        Message::SbaGain(SbaGainEvent {
            actor_index: player,
            action_id: match cause {
                SbaGainCause::Skill(ActionType::Normal(id)) => id,
                _ => 0,
            },
            amount,
            cause: Some(cause),
        })
    }

    fn sba_poll(player: u32, value: f32, added: f32) -> Message {
        Message::OnUpdateSBA(OnUpdateSBAEvent {
            actor_index: player,
            sba_value: value,
            sba_added: added,
        })
    }

    fn sba_bands(events: &[(i64, Message)], chart_len: usize) -> Vec<AbilitySeries> {
        build_ability_sba_chart(events, &[0], 0, 1_000, chart_len, &scope(&[]))
            .remove(&0)
            .expect("the requested player always has a row")
    }

    fn cause_values(bands: &[AbilitySeries], wanted: &str) -> Vec<f64> {
        bands
            .iter()
            .find(|band| matches!(band, AbilitySeries::Cause { key, .. } if key == wanted))
            .unwrap_or_else(|| panic!("a band keyed {wanted}"))
            .values()
            .to_vec()
    }

    #[test]
    fn a_skill_gain_lands_on_the_causing_row() {
        let events = vec![
            (0, stun_hit(0, ActionType::Normal(1), 0.0)),
            (
                10,
                sba_gain(0, SbaGainCause::Skill(ActionType::Normal(1)), 12.5),
            ),
            (
                1_200,
                sba_gain(0, SbaGainCause::Skill(ActionType::Normal(1)), 7.5),
            ),
        ];
        let bands = sba_bands(&events, 2);

        assert_eq!(values_for(&bands, ActionType::Normal(1)), vec![12.5, 7.5]);
    }

    #[test]
    fn a_gain_never_opens_a_row_of_its_own() {
        // No damage event has opened a row for action 9, so the gain has no band
        // — mirroring `add_sba_gain`, where keying it independently is what
        // produced the hit-less dragon-form twins in live log 1681.
        let events = vec![(
            10,
            sba_gain(0, SbaGainCause::Skill(ActionType::Normal(9)), 12.5),
        )];
        let bands = sba_bands(&events, 1);

        assert!(
            !bands
                .iter()
                .any(|band| matches!(band, AbilitySeries::Skill { .. })),
            "no skill band without a damage event to open its row"
        );
    }

    #[test]
    fn named_causes_get_their_own_bands_in_the_tables_grammar() {
        let events = vec![
            (0, sba_gain(0, SbaGainCause::PartyAward, 20.0)),
            (10, sba_gain(0, SbaGainCause::DamageTaken, 5.0)),
            (20, sba_gain(0, SbaGainCause::Effect(0xD2C8E10A), 42.0)),
        ];
        let bands = sba_bands(&events, 1);

        assert_eq!(cause_values(&bands, "source:partyAward"), vec![20.0]);
        assert_eq!(cause_values(&bands, "source:damageTaken"), vec![5.0]);
        // An id-carrying cause keeps the id, exactly as metrics/sba.ts does.
        assert_eq!(
            cause_values(&bands, &format!("source:effect:{}", 0xD2C8E10Au32)),
            vec![42.0]
        );
    }

    #[test]
    fn the_remainder_is_the_poll_total_minus_everything_named() {
        // The poll sits 200 ms after the hit so the 70 it leaves over stays
        // genuinely unexplained: inside the inference move window it would be
        // correlated with that hit and there would be no remainder to measure.
        let events = vec![
            (0, stun_hit(0, ActionType::Normal(1), 0.0)),
            (
                10,
                sba_gain(0, SbaGainCause::Skill(ActionType::Normal(1)), 30.0),
            ),
            (200, sba_poll(0, 100.0, 100.0)),
        ];
        let bands = sba_bands(&events, 1);

        assert_eq!(
            cause_values(&bands, UNATTRIBUTED_KEY),
            vec![70.0],
            "100 polled minus 30 attributed"
        );
    }

    #[test]
    fn the_stack_height_equals_the_polled_generation() {
        // The property the remainder exists for: the chart's area matches the
        // player row above it.
        let events = vec![
            (0, stun_hit(0, ActionType::Normal(1), 0.0)),
            (
                10,
                sba_gain(0, SbaGainCause::Skill(ActionType::Normal(1)), 30.0),
            ),
            (20, sba_gain(0, SbaGainCause::PartyAward, 10.0)),
            (30, sba_poll(0, 100.0, 100.0)),
        ];
        let bands = sba_bands(&events, 1);

        let height: f64 = bands.iter().map(|band| band.values()[0]).sum();
        assert_eq!(height, 100.0);
    }

    #[test]
    fn the_remainder_never_goes_negative() {
        // The poll lags the gains it covers, so a bucket can attribute more than
        // it polled. A negative band would draw as a notch out of the stack.
        let events = vec![
            (0, stun_hit(0, ActionType::Normal(1), 0.0)),
            (
                10,
                sba_gain(0, SbaGainCause::Skill(ActionType::Normal(1)), 80.0),
            ),
            (20, sba_poll(0, 50.0, 50.0)),
        ];
        let bands = sba_bands(&events, 1);

        assert!(
            bands
                .iter()
                .all(|band| band.values().iter().all(|value| *value >= 0.0)),
            "no band ever plots a negative"
        );
    }

    #[test]
    fn a_discharge_does_not_lower_the_denominator() {
        // Performing an SBA drops the gauge; `sba_added` must not go negative
        // and eat into the remainder.
        //
        // The rise is 90 rather than a round 100, and sits 200 ms after the only
        // hit rather than 10: both keep SBA INFERENCE out of a test that is not
        // about it. 100.00 is exactly the flat chain-grant value it recognises,
        // and 10 ms is inside its move window — either would name this gauge and
        // leave no remainder to assert on.
        let events = vec![
            (0, stun_hit(0, ActionType::Normal(1), 0.0)),
            (200, sba_poll(0, 90.0, 90.0)),
            (1_210, sba_poll(0, 0.0, -90.0)),
        ];
        let bands = sba_bands(&events, 2);

        assert_eq!(cause_values(&bands, UNATTRIBUTED_KEY), vec![90.0, 0.0]);
    }

    #[test]
    fn a_player_with_no_gauge_activity_draws_nothing() {
        let events = vec![(0, stun_hit(0, ActionType::Normal(1), 5.0))];
        assert!(sba_bands(&events, 1).is_empty());
    }

    #[test]
    fn an_ability_pin_narrows_the_stun_bands_to_that_ability() {
        // The pin narrows the derived state the TABLE reads, so the chart has to
        // narrow with it or the two describe different fights.
        let events = vec![
            (0, stun_hit(0, ActionType::Normal(1), 10.0)),
            (10, stun_hit(0, ActionType::Normal(2), 20.0)),
        ];
        let bands =
            build_ability_stun_chart(&events, &[0], 0, 1_000, 1, &scope(&[ActionType::Normal(1)]))
                .remove(&0)
                .expect("player row");

        assert_eq!(bands.len(), 1);
        assert_eq!(values_for(&bands, ActionType::Normal(1)), vec![10.0]);
    }

    #[test]
    fn no_ability_pin_keeps_every_stun_band() {
        let events = vec![
            (0, stun_hit(0, ActionType::Normal(1), 10.0)),
            (10, stun_hit(0, ActionType::Normal(2), 20.0)),
        ];
        assert_eq!(stun_bands(&events, 1).len(), 2);
    }

    #[test]
    fn an_ability_pin_narrows_the_sba_bands_and_drops_the_causes() {
        // A cause band and the remainder describe the whole PLAYER, not one
        // ability, and the remainder's denominator is the player's polled total
        // — neither survives a narrowing to a single skill without lying about
        // what the stack's height means.
        let events = vec![
            (0, stun_hit(0, ActionType::Normal(1), 0.0)),
            (5, stun_hit(0, ActionType::Normal(2), 0.0)),
            (
                10,
                sba_gain(0, SbaGainCause::Skill(ActionType::Normal(1)), 30.0),
            ),
            (
                15,
                sba_gain(0, SbaGainCause::Skill(ActionType::Normal(2)), 50.0),
            ),
            (20, sba_gain(0, SbaGainCause::PartyAward, 10.0)),
            (25, sba_poll(0, 200.0, 200.0)),
        ];
        let bands =
            build_ability_sba_chart(&events, &[0], 0, 1_000, 1, &scope(&[ActionType::Normal(1)]))
                .remove(&0)
                .expect("player row");

        assert_eq!(bands.len(), 1, "only the pinned ability survives");
        assert_eq!(values_for(&bands, ActionType::Normal(1)), vec![30.0]);
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
