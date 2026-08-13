//! The per-action SBA gauge weights the game itself is authored with.
//!
//! Every damaging hit grants `spArtsRate × K` gauge, where `spArtsRate` is a
//! per-action constant in the game's data files (attack-seq hitboxes, FSM shot
//! nodes, per-object parameter lists) and `K` is a per-fight scale the share
//! formula in `sba_inference` cancels out. `assets/sba-weights.json` is the
//! extracted table — regenerated from the game files by the pipeline in
//! `docs/superpowers/sba-weights/` (local tooling; re-run it after a game
//! patch) and verified against 68/68 hook-measured (character, action) values.
//!
//! The per-VARIANT policy is corpus-measured, not assumed: across 1,855 logs,
//! supplementary damage (1.34M hits), damage-over-time ticks (80K) and SBA
//! hits (58K) produced ZERO captioned gauge grants, so those variants weigh
//! nothing. Link attacks grant at weight 5.0 for every character.

use std::collections::HashMap;
use std::sync::OnceLock;

use protocol::ActionType;
use serde::Deserialize;

use crate::parser::constants::CharacterType;

/// The game's own default `spArtsRate` — what a hit whose action the table
/// does not cover is assumed to grant at.
pub(super) const DEFAULT_ACTION_WEIGHT: f64 = 1.0;

/// Link attack weight, identical for every character in the shipped table;
/// the fallback when a character is not in the table at all.
pub(super) const LINK_ATTACK_WEIGHT: f64 = 5.0;

#[derive(Deserialize)]
struct RawAction {
    w: f64,
}

#[derive(Deserialize)]
struct RawCharacter {
    link_attack: f64,
    actions: HashMap<String, RawAction>,
}

/// One character's authored weights, resolved once per player per pass.
pub(super) struct CharacterWeights {
    link_attack: f64,
    actions: HashMap<u32, f64>,
}

fn table() -> &'static HashMap<String, CharacterWeights> {
    static TABLE: OnceLock<HashMap<String, CharacterWeights>> = OnceLock::new();
    TABLE.get_or_init(|| {
        let raw: HashMap<String, RawCharacter> =
            serde_json::from_str(include_str!("../../../assets/sba-weights.json"))
                .expect("sba-weights.json matches the RawCharacter shape");
        raw.into_iter()
            .map(|(character, entry)| {
                let actions = entry
                    .actions
                    .into_iter()
                    .map(|(id, action)| {
                        let id = id
                            .parse::<u32>()
                            .expect("sba-weights.json action keys are numeric");
                        (id, action.w)
                    })
                    .collect();
                (
                    character,
                    CharacterWeights {
                        link_attack: entry.link_attack,
                        actions,
                    },
                )
            })
            .collect()
    })
}

/// The weight table for a character, or `None` for one the table does not
/// cover (an unrecognised hash, or the Ferry-ghost pseudo-characters).
pub(super) fn for_character(character: CharacterType) -> Option<&'static CharacterWeights> {
    table().get(&character.to_string())
}

/// The authored gauge weight of one hit, or `None` when the action is simply
/// not in the table — the caller decides what an unknown action is worth
/// ([`DEFAULT_ACTION_WEIGHT`]), so that the fallback is visible where it is
/// applied. `Some(0.0)` is a real answer: the SBA gate refuses those hits.
pub(super) fn hit_weight(weights: Option<&CharacterWeights>, action: ActionType) -> Option<f64> {
    match action {
        ActionType::LinkAttack => {
            Some(weights.map_or(LINK_ATTACK_WEIGHT, |weights| weights.link_attack))
        }
        ActionType::Normal(id) => weights.and_then(|weights| weights.actions.get(&id).copied()),
        // Everything else — supplementary damage, DoT ticks, SBA hits, and the
        // parser-synthesized zero-damage variants — grants no gauge (see the
        // module doc for the corpus measurement behind this).
        _ => Some(0.0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_table_covers_all_thirty_playable_characters() {
        assert_eq!(table().len(), 30);
    }

    #[test]
    fn a_verified_action_weight_is_served() {
        // Pl0000 (Gran) action 100, the first square swing: authored 0.5.
        let gran = for_character(CharacterType::Pl0000).expect("Gran is in the table");
        assert_eq!(hit_weight(Some(gran), ActionType::Normal(100)), Some(0.5));
    }

    #[test]
    fn a_zero_weight_action_is_zero_not_missing() {
        // Pl0200 (Katalina) action 4 is authored 0.0 — the SBA gate refuses it.
        let katalina = for_character(CharacterType::Pl0200).expect("Katalina is in the table");
        assert_eq!(hit_weight(Some(katalina), ActionType::Normal(4)), Some(0.0));
    }

    #[test]
    fn an_action_the_table_does_not_cover_is_none() {
        let gran = for_character(CharacterType::Pl0000).unwrap();
        assert_eq!(hit_weight(Some(gran), ActionType::Normal(999_999)), None);
    }

    #[test]
    fn link_attacks_weigh_five_with_or_without_a_character() {
        let gran = for_character(CharacterType::Pl0000).unwrap();
        assert_eq!(hit_weight(Some(gran), ActionType::LinkAttack), Some(5.0));
        assert_eq!(hit_weight(None, ActionType::LinkAttack), Some(5.0));
    }

    /// Corpus-verified: 1.34M supplementary hits, 80K DoT ticks and 58K SBA
    /// hits across 1,855 logs produced zero captioned gauge grants.
    #[test]
    fn non_granting_variants_weigh_zero() {
        let gran = for_character(CharacterType::Pl0000).unwrap();
        for action in [
            ActionType::SupplementaryDamage(100),
            ActionType::DamageOverTime(0),
            ActionType::SBA,
        ] {
            assert_eq!(hit_weight(Some(gran), action), Some(0.0));
            assert_eq!(hit_weight(None, action), Some(0.0));
        }
    }

    #[test]
    fn an_uncovered_character_has_no_table() {
        assert!(for_character(CharacterType::Unknown(0xDEAD_BEEF)).is_none());
        assert!(for_character(CharacterType::Pl0700Ghost).is_none());
    }

    #[test]
    fn every_character_carries_a_five_point_link_attack() {
        for weights in table().values() {
            assert_eq!(weights.link_attack, 5.0);
        }
    }
}
