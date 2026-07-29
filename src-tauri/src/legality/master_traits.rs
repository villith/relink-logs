//! Master-trait (skillboard) legality, rules 6 and 7.

use std::collections::{HashMap, HashSet};

use super::{Finding, Rule, Severity, Subject, Value};
use crate::parser::constants::CharacterType;

/// The most master traits a player can unlock, confirmed by the user.
pub const MAX_MASTER_TRAITS: usize = 50;

/// `pl####` -> tier key -> node effect ids, from skillboard_layout.tbl.
type Layout = HashMap<String, HashMap<String, Vec<u32>>>;

fn layout() -> &'static Layout {
    static LAYOUT: std::sync::OnceLock<Layout> = std::sync::OnceLock::new();
    LAYOUT.get_or_init(|| {
        serde_json::from_str(include_str!("../../assets/skillboard-layout.json"))
            .expect("skillboard-layout.json matches the layout shape")
    })
}

/// Every node id on a character's board, across all tiers. Empty for a
/// character the table does not know.
pub fn board_nodes(character: CharacterType) -> HashSet<u32> {
    layout()
        .get(&character.to_string().to_lowercase())
        .map(|tiers| tiers.values().flatten().copied().collect())
        .unwrap_or_default()
}

/// Rules 6 and 7. Silent without a character, without a known board, or
/// without any unlocked nodes.
pub fn audit_master_traits(character: Option<CharacterType>, skillboard: &[u32]) -> Vec<Finding> {
    let Some(character) = character else {
        return Vec::new();
    };
    if skillboard.is_empty() {
        return Vec::new();
    }

    let nodes = board_nodes(character);
    if nodes.is_empty() {
        return Vec::new();
    }

    let mut findings = Vec::new();

    for &unlocked in skillboard {
        if !nodes.contains(&unlocked) {
            findings.push(Finding {
                rule: Rule::MasterTraitUnknownNode,
                severity: Severity::Impossible,
                subject: Subject::MasterTraits,
                observed: Value::TraitId(unlocked),
                allowed: Value::Count(nodes.len()),
                odds: None,
            });
        }
    }

    if skillboard.len() > MAX_MASTER_TRAITS {
        findings.push(Finding {
            rule: Rule::MasterTraitCount,
            severity: Severity::Impossible,
            subject: Subject::MasterTraits,
            observed: Value::Count(skillboard.len()),
            allowed: Value::Count(MAX_MASTER_TRAITS),
            odds: None,
        });
    }

    findings
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::constants::CharacterType;

    /// Node 10 sits in Gran's tier 1; 999999 sits on no board at all.
    #[test]
    fn flags_a_node_absent_from_the_board() {
        let findings = audit_master_traits(Some(CharacterType::Pl0000), &[10, 999999]);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, Rule::MasterTraitUnknownNode);
        assert_eq!(findings[0].severity, Severity::Impossible);
        assert_eq!(findings[0].observed, Value::TraitId(999999));
    }

    #[test]
    fn accepts_a_board_of_fifty_real_nodes() {
        let nodes = board_nodes(CharacterType::Pl0000);
        let equipped: Vec<u32> = nodes.iter().copied().take(MAX_MASTER_TRAITS).collect();
        assert_eq!(equipped.len(), MAX_MASTER_TRAITS);
        assert_eq!(
            audit_master_traits(Some(CharacterType::Pl0000), &equipped),
            vec![]
        );
    }

    #[test]
    fn flags_more_than_fifty_unlocked() {
        let nodes = board_nodes(CharacterType::Pl0000);
        let equipped: Vec<u32> = nodes.iter().copied().take(MAX_MASTER_TRAITS + 1).collect();
        let findings = audit_master_traits(Some(CharacterType::Pl0000), &equipped);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, Rule::MasterTraitCount);
        assert_eq!(findings[0].observed, Value::Count(MAX_MASTER_TRAITS + 1));
        assert_eq!(findings[0].allowed, Value::Count(MAX_MASTER_TRAITS));
    }

    #[test]
    fn stays_silent_without_a_character() {
        assert_eq!(audit_master_traits(None, &[999999]), vec![]);
    }

    #[test]
    fn stays_silent_on_an_empty_skillboard() {
        assert_eq!(
            audit_master_traits(Some(CharacterType::Pl0000), &[]),
            vec![]
        );
    }

    /// An unrecognised character has no board to check against, so the
    /// unknown-node rule must stay silent rather than flag every node.
    #[test]
    fn stays_silent_for_an_unknown_character() {
        assert_eq!(
            audit_master_traits(Some(CharacterType::Unknown(7)), &[10]),
            vec![]
        );
    }
}
