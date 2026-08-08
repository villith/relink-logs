//! Dev-only synthetic event scripts for the Debug tab.
//!
//! The app authors these and the hook rebroadcasts them verbatim onto the real
//! event stream, so they travel the real connect loop and the real parser. Only
//! the numbers are invented — but NOT the character hash: the parser drops
//! damage whose source parent is not a known character, so a scenario with a
//! made-up hash would silently do nothing.

use std::ffi::CString;

use protocol::{
    ActionType, Actor, AreaEnterEvent, DamageEvent, Message, PlayerIdentityEvent,
    QuestCompleteEvent,
};
use serde::Deserialize;

/// Gran — a real hash from `parser::constants::CharacterType`.
pub const PL0000: u32 = 0x26A4848A;
/// Katalina — likewise real, so the parser's character lookup resolves.
pub const PL0200: u32 = 0x34D4FD8F;

/// The non-player target. Deliberately a hash outside the game's tables: a real
/// enemy hash would render as that enemy's name in the UI, Eugen's grenade
/// (0x022a350f) is dropped by the damage filter, and Sir Barrold (0xA379AC65)
/// makes the save path discard the encounter's quest id.
pub const TARGET_TYPE: u32 = 0xDEAD_BEEF;
/// The target's actor index; any value works, it is never joined against.
pub const TARGET_INDEX: u32 = 0x1000;

#[derive(Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Scenario {
    /// Load a two-player party, then land the first hits.
    Start,
    /// More damage on the existing party. Click repeatedly to advance DPS.
    Tick,
    /// Result screen: stops the encounter and writes it to logs.db as a real
    /// log row. Fired during a genuine fight, it ends and saves that fight.
    End,
    /// Area change: saves any in-progress encounter to logs.db first, then
    /// resets. Fired during a genuine fight, it ends and saves that fight too.
    Reset,
}

/// An identity event carrying nothing but who the player is. `pub` because the
/// `legality_seed` example builds synthetic players from the same shape and
/// then fills in the one field its scenario is about — a second copy would
/// have to be updated in lockstep every time `PlayerIdentityEvent` grows.
pub fn identity_event(slot: u8, character_type: u32, name: &str) -> PlayerIdentityEvent {
    let name = CString::new(name).expect("debug names carry no interior nul");
    PlayerIdentityEvent {
        character_name: name.clone(),
        display_name: name,
        character_type,
        party_index: slot,
        actor_index: protocol::player_slot_key(slot),
        is_online: false,
        sigils: Vec::new(),
        summons: Vec::new(),
        overmasteries: Vec::new(),
        player_level: 100,
        abilities: Vec::new(),
        weapon_key: String::new(),
        master_level: 0,
        skillboard: Vec::new(),
        stats: None,
        weapon_state: None,
        cap_up_normal: None,
        cap_up_skill: None,
        cap_up_sba: None,
    }
}

/// A plain attributed hit against [`TARGET_TYPE`]. `pub` for the same reason
/// [`identity_event`] is.
pub fn damage_event(slot: u8, character_type: u32, amount: i32, skill_id: u32) -> DamageEvent {
    let key = protocol::player_slot_key(slot);
    DamageEvent {
        source: Actor {
            index: key,
            actor_type: character_type,
            parent_index: key,
            parent_actor_type: character_type,
        },
        target: Actor {
            index: TARGET_INDEX,
            actor_type: TARGET_TYPE,
            parent_index: TARGET_INDEX,
            parent_actor_type: TARGET_TYPE,
        },
        damage: amount,
        // 0 = none of the game's per-hit classification bits (echo, guard, SBA,
        // Ferry's pet-skill bit), so this lands as a plain attributed hit. The
        // Nones below leave cap%, stun and the enemy HP chart unpopulated
        // rather than fabricating numbers for them.
        flags: 0,
        action_id: ActionType::Normal(skill_id),
        attack_rate: None,
        stun_value: None,
        damage_cap: None,
        base_damage: None,
        target_current_hp: None,
        target_max_hp: None,
    }
}

fn identity(slot: u8, character_type: u32, name: &str) -> Message {
    Message::PlayerIdentityEvent(identity_event(slot, character_type, name))
}

fn damage(slot: u8, character_type: u32, amount: i32, skill_id: u32) -> Message {
    Message::DamageEvent(damage_event(slot, character_type, amount, skill_id))
}

/// The message script for one Debug button. One press sends one batch — pacing
/// is manual so the operator controls the shape of the encounter.
pub fn scenario(kind: Scenario) -> Vec<Message> {
    match kind {
        Scenario::Start => vec![
            identity(0, PL0000, "Debug Gran"),
            identity(1, PL0200, "Debug Katalina"),
            damage(0, PL0000, 125_000, 100),
            damage(1, PL0200, 98_000, 200),
        ],
        Scenario::Tick => vec![
            damage(0, PL0000, 240_000, 101),
            damage(0, PL0000, 55_000, 102),
            damage(1, PL0200, 180_000, 201),
        ],
        Scenario::End => vec![Message::OnQuestComplete(QuestCompleteEvent {
            quest_id: 0x1234_5678,
            elapsed_time_in_secs: 92,
        })],
        Scenario::Reset => vec![Message::OnAreaEnter(AreaEnterEvent {
            last_known_quest_id: 0,
            last_known_elapsed_time_in_secs: 0,
        })],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::v1::Parser;
    use protocol::Message;

    fn damage_events(kind: Scenario) -> Vec<DamageEvent> {
        scenario(kind)
            .into_iter()
            .filter_map(|m| match m {
                Message::DamageEvent(e) => Some(e),
                _ => None,
            })
            .collect()
    }

    /// Calls the real filter rather than restating its conditions, so a new
    /// condition added to the parser is caught here instead of silently
    /// reducing every scenario to nothing.
    #[test]
    fn every_damage_event_survives_the_parser_filter() {
        for kind in [Scenario::Start, Scenario::Tick] {
            let damages = damage_events(kind);
            assert!(!damages.is_empty(), "{kind:?} should carry damage");
            for e in &damages {
                assert!(
                    !Parser::should_ignore_damage_event(e),
                    "{kind:?}: the parser would drop {e:?}"
                );
            }
        }
    }

    /// `on_damage_event` attaches a player's name by matching the identity's
    /// `actor_index` against the damage's `source.parent_index`. If the two
    /// drift apart the scenario still parses, but every row shows up unnamed.
    #[test]
    fn identity_and_damage_share_the_slot_key() {
        let msgs = scenario(Scenario::Start);
        let identities: Vec<_> = msgs
            .iter()
            .filter_map(|m| match m {
                Message::PlayerIdentityEvent(e) => Some(e),
                _ => None,
            })
            .collect();
        assert_eq!(identities.len(), 2, "start should load two players");

        let damages = damage_events(Scenario::Start);
        for identity in &identities {
            // `is_player_slot_key` and not a bare mask test: pointer-like enemy
            // indexes satisfy the mask (see its doc comment).
            assert!(
                protocol::is_player_slot_key(identity.actor_index),
                "slot {} identity key {:#x} is not a real slot key",
                identity.party_index,
                identity.actor_index
            );
            let joined = damages
                .iter()
                .filter(|e| e.source.parent_index == identity.actor_index)
                .count();
            assert!(
                joined > 0,
                "no damage joins slot {} (identity key {:#x})",
                identity.party_index,
                identity.actor_index
            );
        }

        // ...and no damage is orphaned, which would show as an unnamed row.
        for e in &damages {
            assert!(
                identities
                    .iter()
                    .any(|i| i.actor_index == e.source.parent_index),
                "damage key {:#x} matches no identity",
                e.source.parent_index
            );
        }
    }

    #[test]
    fn start_establishes_the_party_before_dealing_damage() {
        let msgs = scenario(Scenario::Start);
        let first_damage = msgs
            .iter()
            .position(|m| matches!(m, Message::DamageEvent(_)))
            .expect("start should deal damage");
        let identities = msgs[..first_damage]
            .iter()
            .filter(|m| matches!(m, Message::PlayerIdentityEvent(_)))
            .count();
        assert_eq!(identities, 2, "both players should load before damage");
    }

    #[test]
    fn end_completes_the_quest_and_reset_enters_an_area() {
        assert!(matches!(
            scenario(Scenario::End).as_slice(),
            [Message::OnQuestComplete(_)]
        ));
        assert!(matches!(
            scenario(Scenario::Reset).as_slice(),
            [Message::OnAreaEnter(_)]
        ));
    }
}
