//! Build legality rules: decide whether the game could have produced a
//! player's equipment, and which part of it it could not.
//!
//! Rules read only `protocol` types plus `CharacterType`, never
//! `parser::v1::PlayerData` directly, so they stay unit-testable without a
//! parser or a live game.
//!
//! Governing principle: a rule that cannot see complete data emits NO finding.
//! Remote players report partial equipment (`weapon_state` carries wrightstone
//! traits but never the item id), so a zero is missing data, not a value.

use protocol::{EquippedSummon, OvermasteryInfo, Sigil, WeaponState};
use serde::Serialize;

use crate::parser::constants::CharacterType;

pub mod master_traits;
pub mod overmastery_rules;
pub mod wrightstone;

/// Everything the rules need from a player, borrowed rather than cloned.
#[derive(Debug, Default)]
pub struct BuildSnapshot<'a> {
    pub character_type: Option<CharacterType>,
    pub sigils: &'a [Sigil],
    pub summons: &'a [EquippedSummon],
    /// Unlocked skillboard (master trait) node effect ids.
    pub skillboard: &'a [u32],
    pub weapon_state: Option<&'a WeaponState>,
    pub overmastery_info: Option<&'a OvermasteryInfo>,
}

/// Which rule fired. Serialized so a future UI can translate it; rules never
/// produce human-readable strings themselves.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Rule {
    /// `observed`/`allowed` are `Value::Levels` in true physical slot order
    /// (primary, secondary1, secondary2) — index, not sorted rank, is what
    /// each level is checked against.
    WrightstoneTraitLevel,
    WrightstonePrimaryTrait,
    SigilTraitLevel,
    SigilSecondTrait,
    SigilFirstTrait,
    MasterTraitUnknownNode,
    MasterTraitCount,
    OvermasteryValue,
    OvermasteryAllMaxed,
    SummonPerfect,
    SummonPerfectCount,
}

/// Proof versus suspicion. Never collapse these into one flag.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Severity {
    /// The game's tables cannot produce this value.
    Impossible,
    /// The game can produce it, but rarely enough to report the odds.
    Improbable,
}

/// What the finding points at, so a UI can anchor it later.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "index")]
pub enum Subject {
    Wrightstone,
    Sigil(usize),
    Summon(usize),
    Overmastery(usize),
    MasterTraits,
}

/// Observed and allowed values, kept numeric for the UI to format.
///
/// The paired [`Rule`], not the JSON shape, says how to read the number:
/// `Level`, `Count` and `TraitId` all serialize as bare numbers.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", untagged)]
pub enum Value {
    Level(u32),
    Levels(Vec<u32>),
    Count(usize),
    TraitId(u32),
    TraitIds(Vec<u32>),
    Amount(f32),
    None,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub rule: Rule,
    pub severity: Severity,
    pub subject: Subject,
    pub observed: Value,
    pub allowed: Value,
    /// Probability of this occurring legitimately, for `Improbable` findings.
    pub odds: Option<f64>,
}

/// Every legality finding for one build, in rule order.
pub fn audit(build: &BuildSnapshot) -> Vec<Finding> {
    let mut findings = Vec::new();
    findings.extend(wrightstone::audit_wrightstone(build.weapon_state));
    findings.extend(master_traits::audit_master_traits(
        build.character_type,
        build.skillboard,
    ));
    findings.extend(overmastery_rules::audit_overmastery(build.overmastery_info));
    findings
}

/// Audit a parsed player.
///
/// `PlayerData` stores the parser's own mirrors of the `protocol` types these
/// rules read, so the fields are converted into owned `protocol` values that
/// live for the length of the call and the snapshot borrows from those.
pub fn audit_player(player: &crate::parser::v1::PlayerData) -> Vec<Finding> {
    let inputs = player.legality_inputs();
    audit(&BuildSnapshot {
        character_type: Some(inputs.character_type),
        sigils: &inputs.sigils,
        summons: &inputs.summons,
        skillboard: &inputs.skillboard,
        weapon_state: inputs.weapon_state.as_ref(),
        overmastery_info: inputs.overmastery_info.as_ref(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::parser::v1::PlayerData;

    /// A build with nothing readable must produce no findings at all. This is
    /// the governing principle: absence of evidence is never evidence.
    #[test]
    fn empty_build_yields_no_findings() {
        let build = BuildSnapshot::default();
        assert_eq!(audit(&build), vec![]);
    }

    #[test]
    fn audits_a_player_through_the_snapshot_bridge() {
        let player = PlayerData::default();
        assert_eq!(audit_player(&player), vec![]);
    }
}
