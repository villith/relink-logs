//! Master-trait (skillboard) legality, rules 6 and 7.
//!
//! # Staleness risk: this rule drifts toward accusation
//!
//! `skillboard-layout.json` is a baked snapshot of 29 characters' boards, not
//! a live read. For a character the asset knows, ANY node id it lacks becomes
//! [`Severity::Impossible`] — so the drift is one-directional: the asset can
//! only ever get more incomplete than the game, and every gap becomes a false
//! accusation rather than a missed detection. A game patch that adds a node to
//! Gran's EX tier accuses every player who unlocks it, and nothing in this
//! crate would notice.
//!
//! Two ways the asset can be incomplete even against today's game:
//!
//! - `scripts/gen-skillboard-layout.py` SKIPS any `SkillboardGroupId` outside
//!   `{CHAOS1, CHAOS2, CHAOS3, EX}`, recording only a `WARN` on stdout and
//!   continuing to write the file. A patch introducing a new group silently
//!   omits every node in it, and each one then reads as impossible.
//! - The asset has no `pl2000` (Id Transformation) board at all. That is safe
//!   only because an unknown character yields an empty board and
//!   [`audit_master_traits`] returns early — adding a partial `pl2000` entry
//!   would be far worse than having none.
//!
//! The rest of the codebase already treats this drift as expected and benign:
//! `src/pages/logs/View.tsx` places unlocked ids the layout does not know by a
//! legacy id-band heuristic "rather than dropping them". This rule is the only
//! consumer that turns the same drift into an accusation.
//!
//! Empirically clean as of 2026-07-29: across 1087 real player rows in this
//! repo's `logs.db`, zero unknown nodes, no row above 50 unlocked, and every
//! `characterType` resolved to a board. So this is a latent risk to revisit on
//! the next game patch, not a live bug — but a game-version gate on these
//! rules, or regenerating the asset as part of the patch checklist, is the
//! obvious mitigation when one lands.

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
                // The board size is not what this id was measured against;
                // reporting it would state a falsehood ("only N are
                // allowed"). Matches the sibling idiom in
                // `overmastery_rules` for the same not-in-the-catalogue shape.
                allowed: Value::None,
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
        // The board SIZE is not what this node is measured against, and
        // reporting it renders as "you have node 999999, only 102 are
        // allowed" — a false statement. There is no allowed value to name;
        // the id is simply not in the catalogue.
        assert_eq!(findings[0].allowed, Value::None);
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
