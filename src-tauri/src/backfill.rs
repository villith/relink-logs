//! Offline skill-name backfill logic (pure; driven by `bin/skill_backfill.rs`).
//!
//! `derive_skill_key` reproduces the frontend `getSkillName` character derivation
//! so we can tell, per damage event, which `skills.<char>.<id>` key a name would be
//! looked up under. The ui.json differ then finds ids that resolve nowhere.

use std::collections::BTreeSet;

use protocol::{ActionType, DamageEvent};
use serde_json::{Map, Value};

use crate::parser::constants::CharacterType;

/// The lookup coordinates for one skill occurrence: the character block a name
/// would live under (child, then parent as fallback) and the numeric skill id.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct SkillKey {
    pub child_key: String,
    pub parent_key: String,
    pub id: u32,
}

/// Returns the `SkillKey` for a damage event, or `None` when the event is not a
/// per-character named skill (link/SBA/supplementary) or the character is unknown.
pub fn derive_skill_key(event: &DamageEvent) -> Option<SkillKey> {
    let id = match event.action_id {
        ActionType::Normal(id) => id,
        // DoT is NOT looked up by id: `getSkillName` renders every DamageOverTime event
        // through the fixed `skills.<char>.damage-over-time` key. Its payload is the DoT
        // TYPE (0 poison, 1 burn, 2 darkburn — populated since the 2.0.2 hook fix), which
        // shares a number space with real skill ids, so treating it as one would report
        // e.g. Eugen's poison ticks as unnamed skill 1 ("Sumrak").
        ActionType::DamageOverTime(_) => return None,
        _ => return None,
    };

    let parent = CharacterType::from_hash(event.source.parent_actor_type);
    // Seofon's avatar (Pl2200) collapses into Seofon; otherwise the child is the
    // concrete source actor. Mirrors parser/v1/player_state.rs.
    let child = if parent == CharacterType::Pl2200 {
        parent
    } else {
        CharacterType::from_hash(event.source.actor_type)
    };

    let child_key = character_key(child)?;
    let parent_key = character_key(parent)?;
    Some(SkillKey {
        child_key,
        parent_key,
        id,
    })
}

/// A `PlXXXX` key string for a known character, or `None` for `Unknown(_)`
/// (strum renders the inner hash for the default variant, never a `Pl` key).
fn character_key(character: CharacterType) -> Option<String> {
    if matches!(character, CharacterType::Unknown(_)) {
        return None;
    }
    Some(character.to_string())
}

/// The placeholder written for an unmapped skill. Shows the id so users can
/// see exactly which key needs a real name and submit it in a PR.
pub fn placeholder_for(id: u32) -> String {
    format!("Skill {id}")
}

/// First id of the game's GLOBAL action namespace. Ids from here up are not
/// defined in any character's own action table (`system/player/data/<pl>/
/// <pl>_action.msg` tops out around 1900); they are system-spawned generic
/// attacks executed *through* the player actor — e.g. the Conflux/EndlessMode
/// buff procs (`caos_collateraldamage` = 99999, `caos_chainburst_*_lv3` =
/// 100003, `caos_disruption_burn` = 100008, `caos_umlauf` = 100009, spawned by
/// `ExPlayerEndlessModeBuff` via the generic attack spawner at 0x1409f9e20 in
/// game v2.0.2) and shared procs like `core_pl_buff_counter_hit`. The same id
/// means the same thing for every character, so their names belong in the
/// `skills.default` block, not under a `Pl####` block. (The pre-existing
/// `default` entry 4294967295 "Dodge" is this same namespace's u32::MAX end.)
pub const GENERIC_ACTION_MIN: u32 = 99_999;

/// True if `skills` already resolves a name for `key` via the getSkillName chain:
/// child block, then parent block, then the `default` block.
fn is_resolved(skills: &Map<String, Value>, key: &SkillKey) -> bool {
    let id = key.id.to_string();
    for block in [key.child_key.as_str(), key.parent_key.as_str(), "default"] {
        if let Some(Value::Object(entries)) = skills.get(block) {
            if entries.contains_key(&id) {
                return true;
            }
        }
    }
    false
}

/// Inserts `"Skill <id>"` placeholders into `skills` for every `key` that
/// does not already resolve. Returns the number of placeholders added. Add-only:
/// never overwrites or removes. Idempotent: an already-present placeholder counts
/// as resolved. New entries land under the child block, except ids in the global
/// action namespace ([`GENERIC_ACTION_MIN`]..), which are character-independent
/// and land under `default`.
pub fn insert_missing(skills: &mut Map<String, Value>, keys: &BTreeSet<SkillKey>) -> usize {
    let mut added = 0;
    for key in keys {
        if is_resolved(skills, key) {
            continue;
        }
        let block_key = if key.id >= GENERIC_ACTION_MIN {
            "default"
        } else {
            key.child_key.as_str()
        };
        let block = skills
            .entry(block_key.to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        if let Value::Object(entries) = block {
            entries.insert(key.id.to_string(), Value::String(placeholder_for(key.id)));
            added += 1;
        }
    }
    added
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::Actor;

    fn event(parent_hash: u32, actor_hash: u32, action: ActionType) -> DamageEvent {
        DamageEvent {
            source: Actor {
                index: 0,
                actor_type: actor_hash,
                parent_actor_type: parent_hash,
                parent_index: 0,
            },
            target: Actor {
                index: 1,
                actor_type: 0,
                parent_actor_type: 0,
                parent_index: 1,
            },
            action_id: action,
            damage: 100,
            flags: 0,
            attack_rate: None,
            stun_value: None,
            damage_cap: None,
            base_damage: None,
            target_current_hp: None,
            target_max_hp: None,
        }
    }

    // Character hashes verified against src-tauri/src/parser/constants.rs from_hash().
    const KATALINA_PL0100: u32 = 0x9498_420D;
    const SEOFON_PL2200: u32 = 0x59DB_0CD9;

    #[test]
    fn normal_skill_yields_child_parent_id() {
        let key = derive_skill_key(&event(
            KATALINA_PL0100,
            KATALINA_PL0100,
            ActionType::Normal(200),
        ))
        .unwrap();
        assert_eq!(key.child_key, "Pl0100");
        assert_eq!(key.parent_key, "Pl0100");
        assert_eq!(key.id, 200);
    }

    #[test]
    fn seofon_avatar_collapses_child_to_parent() {
        // parent = Seofon (Pl2200), child actor = something else -> child collapses to Pl2200.
        let key = derive_skill_key(&event(
            SEOFON_PL2200,
            KATALINA_PL0100,
            ActionType::Normal(1),
        ))
        .unwrap();
        assert_eq!(key.child_key, "Pl2200");
        assert_eq!(key.parent_key, "Pl2200");
    }

    #[test]
    fn link_and_sba_and_supplementary_have_no_key() {
        let k = KATALINA_PL0100;
        assert!(derive_skill_key(&event(k, k, ActionType::LinkAttack)).is_none());
        assert!(derive_skill_key(&event(k, k, ActionType::SBA)).is_none());
        assert!(derive_skill_key(&event(k, k, ActionType::SupplementaryDamage(5))).is_none());
    }

    /// DoT is rendered by the fixed `damage-over-time` key, never by id, and its payload is
    /// the DoT type (0 poison / 1 burn / 2 darkburn) — which would otherwise be mistaken for
    /// a skill id in that character's block.
    #[test]
    fn dot_yields_no_key() {
        let k = KATALINA_PL0100;
        assert!(derive_skill_key(&event(k, k, ActionType::DamageOverTime(0))).is_none());
        assert!(derive_skill_key(&event(k, k, ActionType::DamageOverTime(1))).is_none());
    }

    #[test]
    fn unknown_character_has_no_key() {
        // 0xDEADBEEF is not a known character hash -> Unknown -> skip.
        assert!(
            derive_skill_key(&event(0xDEAD_BEEF, 0xDEAD_BEEF, ActionType::Normal(1))).is_none()
        );
    }

    use serde_json::json;

    fn key(child: &str, parent: &str, id: u32) -> SkillKey {
        SkillKey {
            child_key: child.to_string(),
            parent_key: parent.to_string(),
            id,
        }
    }

    #[test]
    fn missing_skill_is_inserted_under_child_block() {
        let mut skills = json!({ "Pl0100": { "100": "Slice" } })
            .as_object()
            .unwrap()
            .clone();
        let mut keys = BTreeSet::new();
        keys.insert(key("Pl0100", "Pl0100", 999));

        let added = insert_missing(&mut skills, &keys);
        assert_eq!(added, 1);
        assert_eq!(skills["Pl0100"]["999"], json!("Skill 999"));
        assert_eq!(
            skills["Pl0100"]["100"],
            json!("Slice"),
            "existing untouched"
        );
    }

    #[test]
    fn resolved_via_child_parent_or_default_is_skipped() {
        let mut skills = json!({
            "Pl0100": { "1": "Child" },
            "Pl2200": { "2": "Parent" },
            "default": { "3": "Default" }
        })
        .as_object()
        .unwrap()
        .clone();
        let mut keys = BTreeSet::new();
        keys.insert(key("Pl0100", "Pl0100", 1)); // in child
        keys.insert(key("PlXXXX", "Pl2200", 2)); // in parent
        keys.insert(key("PlYYYY", "PlZZZZ", 3)); // in default

        let added = insert_missing(&mut skills, &keys);
        assert_eq!(added, 0, "all three already resolve");
    }

    /// Ids in the global action namespace (Conflux buff procs etc.) are the same
    /// attack for every character, so their placeholder lands in `default` — one
    /// entry serves all characters instead of one per character block.
    #[test]
    fn generic_namespace_ids_land_in_default_block() {
        let mut skills = Map::new();
        let mut keys = BTreeSet::new();
        keys.insert(key("Pl2400", "Pl2400", 99_999));
        keys.insert(key("Pl2700", "Pl2700", 100_008));

        let added = insert_missing(&mut skills, &keys);
        assert_eq!(added, 2);
        assert_eq!(skills["default"]["99999"], json!("Skill 99999"));
        assert_eq!(skills["default"]["100008"], json!("Skill 100008"));
        assert!(
            skills.get("Pl2400").is_none() && skills.get("Pl2700").is_none(),
            "no per-character block for generic ids"
        );

        // The same id seen from ANOTHER character now resolves via default.
        let mut more = BTreeSet::new();
        more.insert(key("Pl0600", "Pl0600", 100_008));
        assert_eq!(insert_missing(&mut skills, &more), 0);
    }

    #[test]
    fn is_idempotent_on_rerun() {
        let mut skills = Map::new();
        let mut keys = BTreeSet::new();
        keys.insert(key("Pl0100", "Pl0100", 42));

        assert_eq!(insert_missing(&mut skills, &keys), 1);
        assert_eq!(
            insert_missing(&mut skills, &keys),
            0,
            "second run adds nothing"
        );
        assert_eq!(skills["Pl0100"]["42"], json!("Skill 42"));
    }
}
