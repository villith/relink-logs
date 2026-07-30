//! Master-trait (skillboard) legality: the unlocked-node count cap.
//!
//! One rule: a player cannot have more than 50 master traits unlocked. The cap
//! is corroborated by two independent game structures (the network profile
//! blob's skillboard is exactly 50 u32 node ids, and the loadout preset store
//! holds 50 node keys — both documented in `src-hook/src/hooks/player.rs`),
//! while boards themselves hold 90+ nodes, so 50 is a real constraint rather
//! than the board size restated.
//!
//! The board-membership rule (`MasterTraitUnknownNode`) stays removed: it
//! judged ids against a baked `skillboard-layout.json` snapshot whose drift is
//! one-directional — every node a game patch adds becomes a false accusation
//! until the asset is regenerated.
//!
//! Known caveat, accepted by design: the hook's solo skillboard read
//! (`read_record_skillboard`) derives unlocks from the record's 400-entry
//! unlock-bit array and is capped at 128, not 50 — the 50 cap is a property of
//! the game's own storage, not of the read path. If a game patch ever lets a
//! legitimate build exceed 50 unlocked nodes, this rule misfires and must be
//! recalibrated.

use super::{Finding, Rule, Severity, Subject, Value};

/// The most master traits a player can unlock, confirmed by the user and by
/// the game's own 50-slot skillboard storage.
pub const MAX_MASTER_TRAITS: usize = 50;

/// The count cap. Silent on an empty read — absence of evidence is never
/// evidence.
pub fn audit_master_traits(skillboard: &[u32]) -> Vec<Finding> {
    if skillboard.len() <= MAX_MASTER_TRAITS {
        return Vec::new();
    }

    vec![Finding {
        rule: Rule::MasterTraitCount,
        severity: Severity::Impossible,
        subject: Subject::MasterTraits,
        observed: Value::Count(skillboard.len()),
        allowed: Value::Count(MAX_MASTER_TRAITS),
        odds: None,
    }]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stays_silent_on_an_empty_skillboard() {
        assert_eq!(audit_master_traits(&[]), vec![]);
    }

    #[test]
    fn accepts_exactly_fifty_unlocked() {
        let equipped: Vec<u32> = (0..MAX_MASTER_TRAITS as u32).collect();
        assert_eq!(audit_master_traits(&equipped), vec![]);
    }

    #[test]
    fn flags_more_than_fifty_unlocked() {
        let equipped: Vec<u32> = (0..=MAX_MASTER_TRAITS as u32).collect();
        let findings = audit_master_traits(&equipped);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, Rule::MasterTraitCount);
        assert_eq!(findings[0].severity, Severity::Impossible);
        assert_eq!(findings[0].subject, Subject::MasterTraits);
        assert_eq!(findings[0].observed, Value::Count(MAX_MASTER_TRAITS + 1));
        assert_eq!(findings[0].allowed, Value::Count(MAX_MASTER_TRAITS));
    }

    /// Node ids are deliberately NOT judged — only the count is. A build with
    /// ids no board names but a legal count must be silent (the membership
    /// rule was removed for its staleness-driven false accusations).
    #[test]
    fn node_ids_are_never_judged() {
        let equipped: Vec<u32> = (0..MAX_MASTER_TRAITS as u32)
            .map(|i| 0xDEAD_0000 + i)
            .collect();
        assert_eq!(audit_master_traits(&equipped), vec![]);
    }
}
