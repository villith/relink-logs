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
pub mod sigils;
pub mod summons;
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
    findings.extend(sigils::audit_sigils(build.sigils));
    findings.extend(master_traits::audit_master_traits(
        build.character_type,
        build.skillboard,
    ));
    findings.extend(overmastery_rules::audit_overmastery(build.overmastery_info));
    findings.extend(summons::audit_summons(build.summons));
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

    use protocol::{Overmastery, WeaponTraitPair};

    use crate::parser::v1::PlayerData;

    /// A build with nothing readable must produce no findings at all. This is
    /// the governing principle: absence of evidence is never evidence.
    #[test]
    fn empty_build_yields_no_findings() {
        let build = BuildSnapshot::default();
        assert_eq!(audit(&build), vec![]);
    }

    /// HONEST LIMITATION: this pins the empty-input contract through
    /// `audit_player`, NOT that the bridge carries anything. Every rule is
    /// silent on empty input by design, so emptying any field of
    /// `legality_inputs` leaves this green. The test with teeth is
    /// `parser::v1::legality_bridge_tests::the_bridge_carries_every_field_the_rules_read`,
    /// which feeds a populated `PlayerData` and pins one rule per field; it
    /// lives there because `PlayerData`'s fields are private to that module.
    #[test]
    fn an_empty_player_audits_to_silence() {
        let player = PlayerData::default();
        assert_eq!(audit_player(&player), vec![]);
    }

    /// Owned backing store for the legal fixture. [`BuildSnapshot`] borrows
    /// every field, so the values have to outlive the snapshot; keeping them in
    /// one struct also lets a test perturb a single field and re-audit.
    struct LegalBuild {
        sigils: Vec<Sigil>,
        summons: Vec<EquippedSummon>,
        skillboard: Vec<u32>,
        weapon_state: WeaponState,
        overmastery_info: OvermasteryInfo,
    }

    impl LegalBuild {
        fn snapshot(&self) -> BuildSnapshot<'_> {
            BuildSnapshot {
                character_type: Some(CharacterType::Pl0000),
                sigils: &self.sigils,
                summons: &self.summons,
                skillboard: &self.skillboard,
                weapon_state: Some(&self.weapon_state),
                overmastery_info: Some(&self.overmastery_info),
            }
        }
    }

    /// A build a real player could own, assembled so that every one of the five
    /// rule modules has complete data to judge and none of them may object.
    /// Each value is justified against the asset it was read out of:
    ///
    /// * **Sigil** — War Elemental `00612b10`. `sigil-legality.json` gives it
    ///   `trait1: 4c588c27`, `rollsSecond: true` and `trait2Lot: 6`, and no
    ///   `maxLevel`, so both trait levels are capped at the default 15. Steady
    ///   Focus `0053599e` is one of lot 6's 38 traits.
    /// * **Wrightstone** — HP `f372f096` is the Fortification family's primary
    ///   trait, and the three pairs are in **physical slot order** against the
    ///   derived 20/15/10 ceilings. Re-ordering them makes the fixture illegal:
    ///   the check is positional, not sorted.
    /// * **Overmasteries** — all four ids and ladders read from
    ///   `overmastery-tables.json`: Attack `c4925bd7` tops at 1000, Health
    ///   `52a207b5` at 2000, Crit `45c65767` at 20, Stun `6cb38ef3` at 2.0.
    ///   Three sit at their maximum and Stun deliberately does not, so rule 9
    ///   must stay quiet. Stun's 0.6 is a real rung (index 4), NOT a zero —
    ///   a zero now reads as "magnitude never measured" and would skip the
    ///   ladder comparison entirely, leaving the fixture green for the wrong
    ///   reason.
    /// * **Skillboard** — the first 50 real node ids off Gran's own board, so
    ///   rule 6 finds every one of them and rule 7 sits exactly at the cap.
    /// * **Summons** — Lucilius `6e5968fc` and Goldslime III `439cdb88`, both
    ///   `rolled: true`. Levels are inside each candidate's own window and
    ///   below its top, judged against that candidate and nothing else (the
    ///   per-tier model was proven wrong and removed): Lucilius main `5c862e13`
    ///   rolls 11-15 and carries 13; its bonus `2ea9ca80` rolls 5-9 and carries
    ///   6. Goldslime III main `5e422ae5` rolls 11-15 and carries 12; its bonus
    ///   `a3539fbb` rolls 6-9 and carries 7. Neither side is top-of-window, so
    ///   rule 10 cannot fire and rule 11 has nothing to compound.
    fn legal_build() -> LegalBuild {
        let mut skillboard: Vec<u32> = master_traits::board_nodes(CharacterType::Pl0000)
            .into_iter()
            .collect();
        skillboard.sort_unstable();
        skillboard.truncate(master_traits::MAX_MASTER_TRAITS);

        LegalBuild {
            sigils: vec![Sigil {
                first_trait_id: 0x4c58_8c27,
                first_trait_level: 15,
                second_trait_id: 0x0053_599e,
                second_trait_level: 10,
                sigil_id: 0x0061_2b10,
                equipped_character: 0,
                sigil_level: 15,
                acquisition_count: 1,
                notification_enum: 0,
            }],
            summons: vec![
                EquippedSummon {
                    summon_id: 0x6e59_68fc,
                    main_trait_id: 0x5c86_2e13,
                    main_trait_level: 13,
                    bonus_id: 0x2ea9_ca80,
                    bonus_level: 6,
                },
                EquippedSummon {
                    summon_id: 0x439c_db88,
                    main_trait_id: 0x5e42_2ae5,
                    main_trait_level: 12,
                    bonus_id: 0xa353_9fbb,
                    bonus_level: 7,
                },
            ],
            skillboard,
            weapon_state: WeaponState {
                weapon_id: 0,
                exp: 0,
                star_level: 0,
                plus_marks: 0,
                awakening_level: 0,
                wrightstone_id: 0,
                wrightstone_traits: vec![
                    WeaponTraitPair {
                        id: 0xf372_f096,
                        level: 20,
                    },
                    WeaponTraitPair {
                        id: 0xdc58_4f60,
                        level: 15,
                    },
                    WeaponTraitPair {
                        id: 0x57ab_5b10,
                        level: 10,
                    },
                ],
                innate_traits: Vec::new(),
            },
            overmastery_info: OvermasteryInfo {
                overmasteries: vec![
                    Overmastery {
                        id: 0xc492_5bd7,
                        flags: 0,
                        value: 1000.0,
                    },
                    Overmastery {
                        id: 0x52a2_07b5,
                        flags: 0,
                        value: 2000.0,
                    },
                    Overmastery {
                        id: 0x45c6_5767,
                        flags: 0,
                        value: 20.0,
                    },
                    Overmastery {
                        id: 0x6cb3_8ef3,
                        flags: 0,
                        value: 0.6,
                    },
                ],
            },
        }
    }

    /// **The standing guard against false accusation.** Every rule runs at once
    /// against a build the game itself could have produced, and the whole
    /// module must have nothing to say about it.
    ///
    /// If this fails, fix the RULE, not the fixture. A failure means an honest
    /// player is being accused, which is the one outcome this module exists to
    /// prevent — and it is exactly the shape of the two false-accusation bugs
    /// already found by other means (the overmastery rule flagging 23 of 23
    /// real players, and 109 sigils whose second-trait lot is merely unknown).
    #[test]
    fn a_fully_legal_build_yields_no_findings() {
        let build = legal_build();
        assert_eq!(
            build.skillboard.len(),
            master_traits::MAX_MASTER_TRAITS,
            "the fixture no longer holds a full skillboard, so rule 7 is not \
             being exercised at its cap"
        );

        let findings = audit(&build.snapshot());
        assert_eq!(
            findings,
            vec![],
            "a build the game can produce was flagged as illegitimate — a legal \
             build must NEVER be flagged. Fix the rule that fired, not this \
             fixture."
        );
    }

    /// The teeth for the test above. Silence is only meaningful if the rules
    /// actually looked — a fixture no rule can reach produces a comfortable
    /// green forever, which is exactly the failure mode that let two
    /// false-accusation bugs ship. Each case perturbs exactly ONE field of the
    /// legal build and requires the rule that owns that field to speak up,
    /// proving the rule saw the fixture's data and judged it rather than
    /// skipping it as unreadable.
    ///
    /// All eleven rules, so the guard covers the whole module and not merely
    /// one rule per file. Two cases are worth reading closely:
    ///
    /// * **Rule 9** — nudging Stun alone to the top of its ladder fires
    ///   `OvermasteryAllMaxed`, which can only happen if the other three
    ///   magnitudes were read, matched against their own ladders AND recognised
    ///   as maxed. One assertion covers all four slots.
    /// * **Rule 7** — the perturbation duplicates a node already on the board
    ///   rather than inventing one, so the count is the only thing that changed
    ///   and rule 6 stays quiet.
    #[test]
    fn the_legal_fixture_reaches_every_rule() {
        // Rule 1, then rule 2: an over-cap primary level, then a stone carrying
        // no family trait at all.
        let mut build = legal_build();
        build.weapon_state.wrightstone_traits[0].level = 25;
        assert!(
            fires(&build, Rule::WrightstoneTraitLevel),
            "rule 1 never judged the fixture's stone"
        );

        let mut build = legal_build();
        build.weapon_state.wrightstone_traits[0].id = NOT_A_FAMILY_TRAIT;
        assert!(
            fires(&build, Rule::WrightstonePrimaryTrait),
            "rule 2 never judged the fixture's stone"
        );

        // Rules 3, 4 and 5. DMG Cap is a real trait that lot 6 cannot grant and
        // that War Elemental's id does not encode, so it discriminates on both
        // the second-trait and first-trait rules rather than merely rejecting
        // garbage.
        let mut build = legal_build();
        build.sigils[0].first_trait_level = 30;
        assert!(
            fires(&build, Rule::SigilTraitLevel),
            "rule 3 never judged the fixture's sigil"
        );

        let mut build = legal_build();
        build.sigils[0].second_trait_id = DMG_CAP;
        assert!(
            fires(&build, Rule::SigilSecondTrait),
            "rule 4 never judged the fixture's sigil"
        );

        let mut build = legal_build();
        build.sigils[0].first_trait_id = DMG_CAP;
        assert!(
            fires(&build, Rule::SigilFirstTrait),
            "rule 5 never judged the fixture's sigil"
        );

        // Rules 6 and 7.
        let mut build = legal_build();
        build.skillboard.push(NO_SUCH_NODE);
        assert!(
            fires(&build, Rule::MasterTraitUnknownNode),
            "rule 6 never judged the fixture's skillboard"
        );

        let mut build = legal_build();
        let already_unlocked = build.skillboard[0];
        build.skillboard.push(already_unlocked);
        assert!(
            fires(&build, Rule::MasterTraitCount),
            "rule 7 never judged the fixture's skillboard"
        );

        // Rules 8 and 9. Stun's ladder runs …0.6, 0.8… so 0.7 falls between two
        // rungs, and 2.0 is its top.
        let mut build = legal_build();
        build.overmastery_info.overmasteries[3].value = 0.7;
        assert!(
            fires(&build, Rule::OvermasteryValue),
            "rule 8 never judged the fixture's magnitudes"
        );

        let mut build = legal_build();
        build.overmastery_info.overmasteries[3].value = 2.0;
        assert!(
            fires(&build, Rule::OvermasteryAllMaxed),
            "rule 9 never read the fixture's magnitudes"
        );

        // Rules 10 and 11: lift both summons to the top of their own candidates'
        // windows, which is the only thing separating the fixture from perfect.
        let mut build = legal_build();
        build.summons[0].main_trait_level = 15;
        build.summons[0].bonus_level = 9;
        build.summons[1].main_trait_level = 15;
        build.summons[1].bonus_level = 9;
        assert!(
            fires(&build, Rule::SummonPerfect),
            "rule 10 never judged the fixture's summons"
        );
        assert!(
            fires(&build, Rule::SummonPerfectCount),
            "both fixture summons reached rule 10 but rule 11 did not compound them"
        );
    }

    /// DMG Cap: a real trait, but not one lot 6 grants and not one War
    /// Elemental's id encodes.
    const DMG_CAP: u32 = 0xdc58_4f60;
    /// A trait id belonging to none of the four wrightstone families.
    const NOT_A_FAMILY_TRAIT: u32 = 0x9999_0001;
    /// A skillboard node id that sits on no character's board.
    const NO_SUCH_NODE: u32 = 999_999;

    fn fires(build: &LegalBuild, rule: Rule) -> bool {
        audit(&build.snapshot())
            .iter()
            .any(|finding| finding.rule == rule)
    }
}
