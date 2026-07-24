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

/// Gran/Djeeta and Katalina — real hashes from `parser::constants::CharacterType`.
const PL0000: u32 = 0x26A4848A;
const PL0100: u32 = 0x9498420D;

/// An arbitrary non-player target. Any hash works except Eugen's grenade
/// (0x022a350f), which the parser ignores outright.
const TARGET_TYPE: u32 = 0xDEAD_BEEF;
const TARGET_INDEX: u32 = 0x1000;

#[derive(Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Scenario {
    /// Load a two-player party, then land the first hits.
    Start,
    /// More damage on the existing party. Click repeatedly to advance DPS.
    Tick,
    /// Result screen: stops the encounter and saves it.
    End,
    /// Area change: clears parser state.
    Reset,
}

fn identity(slot: u8, character_type: u32, name: &str) -> Message {
    let name = CString::new(name).expect("debug names carry no interior nul");
    Message::PlayerIdentityEvent(PlayerIdentityEvent {
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
    })
}

fn damage(slot: u8, character_type: u32, amount: i32, skill_id: u32) -> Message {
    let key = protocol::player_slot_key(slot);
    Message::DamageEvent(DamageEvent {
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
        flags: 0,
        action_id: ActionType::Normal(skill_id),
        attack_rate: None,
        stun_value: None,
        damage_cap: None,
        base_damage: None,
        target_current_hp: None,
        target_max_hp: None,
    })
}

/// The message script for one Debug button. One press sends one batch — pacing
/// is manual so the operator controls the shape of the encounter.
pub fn scenario(kind: Scenario) -> Vec<Message> {
    match kind {
        Scenario::Start => vec![
            identity(0, PL0000, "Debug Gran"),
            identity(1, PL0100, "Debug Katalina"),
            damage(0, PL0000, 125_000, 100),
            damage(1, PL0100, 98_000, 200),
        ],
        Scenario::Tick => vec![
            damage(0, PL0000, 240_000, 101),
            damage(0, PL0000, 55_000, 102),
            damage(1, PL0100, 180_000, 201),
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
    use crate::parser::constants::CharacterType;
    use protocol::Message;

    /// The parser silently drops damage from an unknown parent actor type or
    /// with non-positive damage, so a scenario built that way would do nothing.
    #[test]
    fn every_damage_event_survives_the_parser_filter() {
        for kind in [Scenario::Start, Scenario::Tick] {
            let msgs = scenario(kind);
            let damages: Vec<_> = msgs
                .iter()
                .filter_map(|m| match m {
                    Message::DamageEvent(e) => Some(e),
                    _ => None,
                })
                .collect();
            assert!(!damages.is_empty(), "{kind:?} should carry damage");
            for e in damages {
                assert!(e.damage > 0, "{kind:?}: damage must be positive");
                assert!(
                    !matches!(
                        CharacterType::from_hash(e.source.parent_actor_type),
                        CharacterType::Unknown(_)
                    ),
                    "{kind:?}: parent_actor_type must be a known character"
                );
                assert_ne!(
                    e.target.actor_type, 0x022a350f,
                    "{kind:?}: that hash is Eugen's grenade, which the parser ignores"
                );
            }
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
