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
use serde::{Deserialize, Serialize};

pub mod chased_effects;
pub mod master_traits;
pub mod overmastery_rules;
pub mod sigils;
pub mod summon_bonus_values;
pub mod summons;
pub mod sweep;
pub mod wrightstone;

/// The engine's empty-id sentinel (`EMPTY_SIGIL_HASH` in the hook), shared by
/// every rule module so the four copies cannot drift apart.
pub const EMPTY_ID: u32 = game_reader::EMPTY_KEY;

/// Which generation of the rules produced a stored finding.
///
/// Findings are written to `legality_findings` when an encounter is saved, so
/// a rule change leaves every existing log judged by rules nobody is running
/// any more. Bumping this marks those logs stale and the startup sweep
/// re-audits them.
///
/// `the_rules_version_matches_what_the_rules_currently_say` pins this against
/// a snapshot of what the rules actually output, so a change that would
/// silently strand old verdicts fails the build instead.
/// 4: the two perfection reports were scoped to the chased effects, and
/// single-level ("special") summon candidates stopped counting as rolls.
/// 5: a bonus-source finding now names the summons that DO grant the bonus,
/// rather than listing the eleven its own summon may hold.
/// 6: encounters older than [`AUDIT_CUTOFF_MS`] stopped being audited. The
/// rules themselves say exactly what they said at 5 — the bump is what makes
/// the sweep revisit logs already stamped 5 and WITHDRAW the verdicts it now
/// declines to make. Without it the cutoff would only ever govern logs nobody
/// had judged yet, i.e. nothing already in the database.
pub const RULES_VERSION: u32 = 6;

/// Encounters recorded before this are never audited: epoch millis for
/// 2026-07-09T00:00:00Z, inclusive (a log stamped exactly this is judged).
///
/// Every table the rules judge against — the overmastery ladders, the
/// transmarvel stone configs behind the 20/15/10 ceilings, the sigil and summon
/// lots — is baked from the CURRENT game data, and nothing stored with a log
/// says which game version recorded it (`logs.version` is the parser's blob
/// format, not the game's). So a value that was legal under an earlier patch is
/// indistinguishable from one that was never legal at all, and
/// `overmastery_rules::audit_overmastery` is not silent about an id it does not
/// recognise — it accuses. A date is the only discriminator available.
pub const AUDIT_CUTOFF_MS: i64 = 1_783_555_200_000;

/// Whether an encounter that started at `time_ms` (epoch millis — the value
/// stored in `logs.time`) may be judged at all.
///
/// The save path and the startup sweep both ask here rather than comparing for
/// themselves: a cutoff enforced in only one of them is no cutoff. The sweep
/// alone would let a freshly saved pre-cutoff log through (it is stamped
/// current on the way in, so no sweep ever revisits it); the save path alone
/// would leave every log already in the database judged.
pub fn should_audit(time_ms: i64) -> bool {
    time_ms >= AUDIT_CUTOFF_MS
}

/// An empty slot reaches us as either a plain zero or the engine sentinel, so
/// both must count as empty.
///
/// No id normalisation exists anywhere in the hook — do not go looking for one
/// and conclude the `0` arm is dead. The two paths differ in filtering, not in
/// rewriting: `read_snapshot_sigils` (`src-hook/src/hooks/player.rs:1632`)
/// DROPS sentinel entries outright, while the `PlayerLoadEvent` path
/// (`player.rs:153`) copies all twelve raw slots (`SigilList::sigils`,
/// `src-hook/src/hooks/ffi.rs:90`) through untouched. That unfiltered path is
/// why either spelling of "empty" can arrive verbatim. (The one
/// `if v == EMPTY_SIGIL_HASH { 0 }` closure in the hook, at `player.rs:1145`,
/// is inside `read_record_stats` and applies to HP/attack stat words — never
/// to ids.)
///
/// Treating only one as empty either audits empty slots (false accusations) or
/// skips real ones. Narrowing this guard to the sentinel alone would let a
/// zeroed second-trait slot reach the locked-pair and single-trait rules,
/// where an empty slot would be accused as a wrong or extra trait. The
/// overmastery rule needs it for the same reason: a production audit found 16
/// findings observing exactly this id, so the hook's own filter is not
/// airtight and an empty slot must be missing data, never an accusation.
pub fn is_empty(id: u32) -> bool {
    id == 0 || id == EMPTY_ID
}

/// The hex8 spelling every generated legality table keys its rows by.
pub(crate) fn parse_hex(value: &str) -> Option<u32> {
    u32::from_str_radix(value, 16).ok()
}

/// Everything the rules need from a player.
///
/// Owned rather than borrowed: `PlayerData` stores the parser's own mirrors of
/// these `protocol` types, so an audit has to convert them anyway. It lives
/// here rather than in the parser so the rules stay testable without one —
/// `PlayerData::legality_inputs` is merely the bridge that fills it in.
#[derive(Debug, Default, Clone)]
pub struct LegalityInputs {
    pub sigils: Vec<Sigil>,
    pub summons: Vec<EquippedSummon>,
    pub weapon_state: Option<WeaponState>,
    pub overmastery_info: Option<OvermasteryInfo>,
    /// Unlocked skillboard (master trait) node effect ids.
    pub skillboard: Vec<u32>,
}

/// Which rule fired. Serialized so a future UI can translate it; rules never
/// produce human-readable strings themselves.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Rule {
    /// `observed`/`allowed` are `Value::Levels` in true physical slot order
    /// (primary, secondary1, secondary2) — index, not sorted rank, is what
    /// each level is checked against.
    WrightstoneTraitLevel,
    /// A sigil carrying BOTH traits with a level above its own ceiling
    /// (default 15; raised only where the table declares it).
    SigilTraitLevel,
    /// A character sigil (X's Awakening+ et al.) whose fixed trait pair was
    /// tampered with.
    SigilLockedPair,
    /// A quest-locked (crab) trait on a sigil that cannot carry it.
    SigilQuestLockedTrait,
    /// A second trait on a sigil that can only ever hold one (Stout Heart).
    SigilSingleTraitOnly,
    OvermasteryValue,
    OvermasteryAllMaxed,
    /// A summon trait that is not a candidate of that summon's lot — an
    /// outcome the chances table prices at zero.
    SummonTrait,
    /// An equip bonus no summon sharing this one's display name can grant.
    /// Eleven of the 22 bonus ids belong to four boss summons alone, so one of
    /// those on any other summon is off-table however ordinary it displays.
    SummonBonusSource,
    /// An equip bonus DISPLAYING a magnitude higher than any bonus of that
    /// effect in the summon's own lots can reach.
    ///
    /// Judged on the number, not the level. A level is unjudgeable —
    /// below-window reads and the `-1` sentinel both occur on honest builds —
    /// but a number past the summon's ceiling is off-table, and an unread
    /// level prices nothing so it cannot reach this rule at all.
    SummonBonusMagnitude,
    /// Two or more ROLLED summons equipped with both slots at the top of
    /// their level windows. Always `Improbable` — a report, never proof
    /// (26 of 72 census players own such a set; see `summons`'s module docs).
    SummonPerfectCount,
    /// More master traits unlocked than the game's 50-slot skillboard storage
    /// can hold. Only the COUNT is judged; node ids are not (the membership
    /// rule was removed for its staleness-driven false accusations).
    MasterTraitCount,
}

/// What the finding points at, so a UI can anchor it later.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "index")]
pub enum Subject {
    Wrightstone,
    Sigil(usize),
    Summon(usize),
    Overmastery(usize),
    /// The whole overmastery set at once — the all-maxed rule's claim is
    /// about all four slots together, so pointing at slot 0 misrepresents it.
    Overmasteries,
    /// The whole equipped summon set — the perfect-count rule's claim is
    /// about how many together, so pointing at one summon misrepresents it.
    Summons,
    /// The whole unlocked master-trait set — the count rule's claim is about
    /// the set's size, not any one node.
    MasterTraits,
}

/// Observed and allowed values, kept numeric for the UI to format.
///
/// Serialized TAGGED (`{"kind": "traitId", "value": …}`) so a UI can tell an
/// id apart from a level and translate it to a name — with the old untagged
/// bare numbers the two were indistinguishable and the audit page could only
/// print them verbatim.
///
/// Ids carry their CATALOGUE in the tag, one variant per namespace. The rule
/// that builds the finding is the only thing that knows which catalogue an id
/// came from, so it says so here; a UI that had to infer it from the paired
/// [`Rule`] renders the wrong names the moment a rule is added and nobody
/// remembers to teach the UI about it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "value")]
pub enum Value {
    Level(u32),
    Levels(Vec<u32>),
    Count(usize),
    /// An ordinary trait id (the `traits` lang namespace).
    TraitId(u32),
    TraitIds(Vec<u32>),
    /// A sigil ITEM id — `SigilQuestLockedTrait` names the sigils a
    /// quest-locked trait may live on, not traits.
    SigilIds(Vec<u32>),
    /// A summon equip-bonus id (`summon_base_param.tbl`), a namespace disjoint
    /// from ordinary trait ids.
    SummonBonusId(u32),
    /// LEGACY. `SummonBonusSource` used to answer "what may this summon hold?"
    /// with this — eleven ids no surface ever rendered, and which could not
    /// have settled the claim if it had: the offending bonus SHARES its display
    /// name with one of them. It now answers "then whose is it?" with
    /// [`Value::SummonIds`] instead.
    ///
    /// Kept because findings written before that change are still in `logs.db`
    /// and must go on deserializing until the sweep rewrites them — a stored row
    /// that fails to parse fails the whole query it is read in.
    SummonBonusIds(Vec<u32>),
    /// Summon ids, one per display NAME. The summons that grant a bonus some
    /// other summon was caught holding.
    SummonIds(Vec<u32>),
    /// An overmastery id.
    OvermasteryId(u32),
    Amount(f32),
    None,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub rule: Rule,
    pub subject: Subject,
    pub observed: Value,
    pub allowed: Value,
    /// Probability of this occurring legitimately. `None` for a hard table
    /// breach, which has no odds to quote.
    ///
    /// With severity gone this is the only thing separating a report of long
    /// odds from proof that the game could not have produced a build, so a UI
    /// that shows findings must show these odds where they exist.
    pub odds: Option<f64>,
    /// The equipment this finding is about, captured AT AUDIT TIME.
    ///
    /// [`Subject`] carries only a slot index, which is meaningless without the
    /// encounter it indexes into — a UI resolving `Sigil(7)` against any other
    /// build names whatever sigil happens to sit there, and accuses gear the
    /// rules never flagged. Recording what the rule actually saw makes a stored
    /// finding self-describing: it can be rendered from the database alone,
    /// with no encounter to load and no way to pair it with the wrong one.
    ///
    /// `None` on rows written before this field existed; the sweep refills them.
    #[serde(default)]
    pub evidence: Option<Evidence>,
}

/// One trait or bonus line, as a UI draws it beneath its item.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceTrait {
    pub id: u32,
    pub level: u32,
}

/// One equipped summon: its main trait and its equip bonus.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceSummon {
    pub summon_id: u32,
    pub main: EvidenceTrait,
    pub bonus: EvidenceTrait,
}

/// One overmastery, with the raw fields a UI needs to format it the way the
/// equipment tab does — `flags` decides whether the magnitude is a level or an
/// amount, so dropping it prints a bare `20` where `+20%` belongs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceOvermastery {
    pub id: u32,
    pub value: f32,
    pub flags: u32,
}

/// The equipment a finding is about, in the shape a UI renders it.
///
/// Tagged by `kind`, one variant per [`Subject`], so a renderer switches on the
/// same word the subject uses and never has to infer which catalogue an id
/// belongs to.
///
/// `rename_all_fields` is not redundant with `rename_all`: on an enum the latter
/// renames the VARIANTS only, so without it a struct variant's fields ship in
/// snake_case under a correctly camelCased tag — the shape the frontend switches
/// on looks right while the field it then reads is `undefined`. The `alias`es
/// read the findings already stored under those old names.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
pub enum Evidence {
    Sigil {
        #[serde(alias = "sigil_id")]
        sigil_id: u32,
        level: u32,
        traits: Vec<EvidenceTrait>,
    },
    Wrightstone {
        #[serde(alias = "wrightstone_id")]
        wrightstone_id: u32,
        traits: Vec<EvidenceTrait>,
    },
    Summon(EvidenceSummon),
    Summons {
        summons: Vec<EvidenceSummon>,
    },
    Overmastery(EvidenceOvermastery),
    Overmasteries {
        entries: Vec<EvidenceOvermastery>,
    },
    MasterTraits {
        observed: usize,
        allowed: usize,
    },
}

/// Trait pairs with the empty slots dropped — a wrightstone's third slot and a
/// single-trait sigil's second would otherwise render as a garbage name.
fn traits_of(pairs: impl IntoIterator<Item = (u32, u32)>) -> Vec<EvidenceTrait> {
    pairs
        .into_iter()
        .filter(|(id, _)| !is_empty(*id))
        .map(|(id, level)| EvidenceTrait { id, level })
        .collect()
}

fn summon_evidence(summon: &protocol::EquippedSummon) -> EvidenceSummon {
    EvidenceSummon {
        summon_id: summon.summon_id,
        main: EvidenceTrait {
            id: summon.main_trait_id,
            level: summon.main_trait_level,
        },
        bonus: EvidenceTrait {
            id: summon.bonus_id,
            level: summon.bonus_level,
        },
    }
}

/// The equipment a finding points at, resolved against the build it was
/// computed from.
///
/// Called once, inside [`audit`], where the inputs ARE that build — which is
/// the whole point. Doing it anywhere later means holding a slot index and
/// hoping the right encounter is still to hand.
fn evidence_for(build: &LegalityInputs, finding: &Finding) -> Option<Evidence> {
    match finding.subject {
        Subject::Sigil(index) => {
            let sigil = build.sigils.get(index)?;
            Some(Evidence::Sigil {
                sigil_id: sigil.sigil_id,
                level: sigil.sigil_level,
                traits: traits_of([
                    (sigil.first_trait_id, sigil.first_trait_level),
                    (sigil.second_trait_id, sigil.second_trait_level),
                ]),
            })
        }

        Subject::Wrightstone => {
            let weapon = build.weapon_state.as_ref()?;
            Some(Evidence::Wrightstone {
                wrightstone_id: weapon.wrightstone_id,
                traits: traits_of(
                    weapon
                        .wrightstone_traits
                        .iter()
                        .map(|pair| (pair.id, pair.level)),
                ),
            })
        }

        Subject::Summon(index) => {
            Some(Evidence::Summon(summon_evidence(build.summons.get(index)?)))
        }

        Subject::Summons => {
            let summons: Vec<EvidenceSummon> = build
                .summons
                .iter()
                .filter(|summon| !is_empty(summon.summon_id))
                .map(summon_evidence)
                .collect();
            (!summons.is_empty()).then_some(Evidence::Summons { summons })
        }

        Subject::Overmastery(index) => {
            let entry = build.overmastery_info.as_ref()?.overmasteries.get(index)?;
            Some(Evidence::Overmastery(EvidenceOvermastery {
                id: entry.id,
                value: entry.value,
                flags: entry.flags,
            }))
        }

        Subject::Overmasteries => {
            let entries: Vec<EvidenceOvermastery> = build
                .overmastery_info
                .as_ref()?
                .overmasteries
                .iter()
                .map(|entry| EvidenceOvermastery {
                    id: entry.id,
                    value: entry.value,
                    flags: entry.flags,
                })
                .collect();
            (!entries.is_empty()).then_some(Evidence::Overmasteries { entries })
        }

        Subject::MasterTraits => Some(Evidence::MasterTraits {
            observed: match finding.observed {
                Value::Count(count) => count,
                _ => build.skillboard.len(),
            },
            allowed: match finding.allowed {
                Value::Count(count) => count,
                _ => 0,
            },
        }),
    }
}

/// Every legality finding for one build, in rule order, each carrying the
/// equipment it is about.
///
/// The rules themselves emit only a slot; the snapshot is attached here, in the
/// one place the build is guaranteed to be the build the rule just read.
pub fn audit(build: &LegalityInputs) -> Vec<Finding> {
    let mut findings = Vec::new();
    findings.extend(wrightstone::audit_wrightstone(build.weapon_state.as_ref()));
    findings.extend(sigils::audit_sigils(&build.sigils));
    findings.extend(overmastery_rules::audit_overmastery(
        build.overmastery_info.as_ref(),
    ));
    findings.extend(summons::audit_summons(&build.summons));
    findings.extend(master_traits::audit_master_traits(&build.skillboard));

    for finding in &mut findings {
        finding.evidence = evidence_for(build, finding);
    }

    findings
}

/// Audit a parsed player. A caller that also needs the inputs afterwards (to
/// resolve a finding's subject, say) should build them once with
/// [`crate::parser::v1::PlayerData::legality_inputs`] and call [`audit`].
pub fn audit_player(player: &crate::parser::v1::PlayerData) -> Vec<Finding> {
    audit(&player.legality_inputs())
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
        let build = LegalityInputs::default();
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

    /// A build a real player could own, assembled so that every one of the
    /// four rule modules has complete data to judge and none of them may
    /// object. Each value is justified against the asset it was read out of:
    ///
    /// * **Sigils** — one representative of every sigil class a rule watches.
    ///   War Elemental `00612b10` (two traits at the default ceiling of 15;
    ///   Steady Focus is a trait it is seen with in the wild). Thunderwolf's
    ///   Awakening+ `23953fd4` carrying exactly its locked pair (Recharge
    ///   `7d75d904`, Acuity `be3404b9`). Crabby Resonance `1c4d37e4` carrying
    ///   its own quest-locked trait `082033cb` — single trait at 45, far past
    ///   15, which is legal because single-trait levels are never judged.
    ///   Stout Heart `cb5f29c1` with its one trait `a1a8e39d` and an empty
    ///   second slot.
    /// * **Wrightstone** — HP `f372f096` is the Fortification family's primary
    ///   trait, and the three pairs are in **physical slot order** against the
    ///   derived 20/15/10 ceilings. Re-ordering them makes the fixture illegal:
    ///   the check is positional, not sorted.
    /// * **Overmasteries** — all four ids and ladders read from
    ///   `overmastery-tables.json`: Attack Power Up `c4925bd7` tops at 1000,
    ///   Normal Attack DMG Cap Up `43b7581d` and Skill DMG Cap Up `9c555433`
    ///   at 20, Stun Power Up `6cb38ef3` at 2.0. Three sit at their maximum
    ///   and Stun deliberately does not, so the all-maxed rule must stay quiet.
    ///   Stun's 0.6 is a real rung (index 4), NOT a zero — a zero reads as
    ///   "magnitude never measured" and would skip the ladder comparison
    ///   entirely, leaving the fixture green for the wrong reason.
    ///
    ///   All four are `chased_effects`, which is what gives the fixture its
    ///   teeth: the all-maxed rule counts only those five effect names, so a
    ///   set containing a Health Up could never reach the threshold and the
    ///   reachability case below would pass without the rule ever judging a
    ///   magnitude.
    /// * **Summons** — Lucilius `6e5968fc` and Behemoth III `e4b7dcf9`, both
    ///   `rolled: true`, both on the perfect-count WATCH LIST, each carrying
    ///   a genuine candidate of its own lots: Lucilius main `5c862e13` (Gamma,
    ///   window 11-15) with bonus `9245dfa4`, Behemoth III main `b5ff9fd3`
    ///   (Uplift, 11-15) with bonus `a3539fbb`. Lucilius sits at the TOP of
    ///   both windows on purpose: ONE perfect summon is legal and unreported
    ///   (42 of 72 census players own one). Behemoth deliberately sits one step
    ///   below its bonus top (8 of 9) so the perfect COUNT stays at one and the
    ///   >=2 report must stay quiet — the summon twin of Stun's
    ///   deliberately-unmaxed overmastery above.
    ///
    ///   Both bonuses are Damage Cap Ups and both mains are on 11-15 curves,
    ///   for the same reason the overmasteries are all chased effects: a
    ///   Healing Cap Up bonus or a singleton-curve main (Berserker Echo) can
    ///   never count as perfect, so either would leave the reachability case
    ///   below green without the report ever counting a summon.
    /// * **Skillboard** — exactly the 50-node maximum the game's own storage
    ///   holds. The ids are arbitrary on purpose: only the COUNT is judged.
    fn legal_build() -> LegalityInputs {
        LegalityInputs {
            sigils: vec![
                Sigil {
                    first_trait_id: 0x4c58_8c27,
                    first_trait_level: 15,
                    second_trait_id: 0x0053_599e,
                    second_trait_level: 10,
                    sigil_id: 0x0061_2b10,
                    equipped_character: 0,
                    sigil_level: 15,
                    acquisition_count: 1,
                    notification_enum: 0,
                },
                Sigil {
                    first_trait_id: 0x7d75_d904,
                    first_trait_level: 15,
                    second_trait_id: 0xbe34_04b9,
                    second_trait_level: 15,
                    sigil_id: 0x2395_3fd4,
                    equipped_character: 0,
                    sigil_level: 15,
                    acquisition_count: 1,
                    notification_enum: 0,
                },
                Sigil {
                    first_trait_id: 0x0820_33cb,
                    first_trait_level: 45,
                    second_trait_id: 0,
                    second_trait_level: 0,
                    sigil_id: 0x1c4d_37e4,
                    equipped_character: 0,
                    sigil_level: 45,
                    acquisition_count: 1,
                    notification_enum: 0,
                },
                Sigil {
                    first_trait_id: 0xa1a8_e39d,
                    first_trait_level: 15,
                    second_trait_id: 0,
                    second_trait_level: 0,
                    sigil_id: 0xcb5f_29c1,
                    equipped_character: 0,
                    sigil_level: 15,
                    acquisition_count: 1,
                    notification_enum: 0,
                },
            ],
            summons: vec![
                EquippedSummon {
                    summon_id: 0x6e59_68fc,
                    main_trait_id: 0x5c86_2e13,
                    main_trait_level: 15,
                    bonus_id: 0x9245_dfa4,
                    bonus_level: 9,
                },
                EquippedSummon {
                    summon_id: 0xe4b7_dcf9,
                    main_trait_id: 0xb5ff_9fd3,
                    main_trait_level: 15,
                    bonus_id: 0xa353_9fbb,
                    bonus_level: 8,
                },
            ],
            weapon_state: Some(WeaponState {
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
            }),
            overmastery_info: Some(OvermasteryInfo {
                overmasteries: vec![
                    Overmastery {
                        id: 0xc492_5bd7,
                        flags: 0,
                        value: 1000.0,
                    },
                    Overmastery {
                        id: 0x43b7_581d,
                        flags: 0,
                        value: 20.0,
                    },
                    Overmastery {
                        id: 0x9c55_5433,
                        flags: 0,
                        value: 20.0,
                    },
                    Overmastery {
                        id: 0x6cb3_8ef3,
                        flags: 0,
                        value: 0.6,
                    },
                ],
            }),
            skillboard: (0..master_traits::MAX_MASTER_TRAITS as u32).collect(),
        }
    }

    /// The fixture always equips a stone and a full overmastery set; these
    /// keep the perturbation cases below reading as one assignment each.
    fn stone(build: &mut LegalityInputs) -> &mut WeaponState {
        build
            .weapon_state
            .as_mut()
            .expect("the legal fixture equips a wrightstone")
    }

    fn masteries(build: &mut LegalityInputs) -> &mut Vec<Overmastery> {
        &mut build
            .overmastery_info
            .as_mut()
            .expect("the legal fixture rolls four overmasteries")
            .overmasteries
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
        let findings = audit(&legal_build());
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
    /// All ten rules, so the guard covers the whole module and not merely
    /// one rule per file. One case worth reading closely: nudging Stun alone
    /// to the top of its ladder fires `OvermasteryAllMaxed`, which can only
    /// happen if the other three magnitudes were read, matched against their
    /// own ladders AND recognised as maxed — one assertion covers all four
    /// slots.
    #[test]
    fn the_legal_fixture_reaches_every_rule() {
        // Wrightstone: an over-cap primary level.
        let mut build = legal_build();
        stone(&mut build).wrightstone_traits[0].level = 25;
        assert!(
            fires(&build, Rule::WrightstoneTraitLevel),
            "the level rule never judged the fixture's stone"
        );

        // Sigils: an over-cap level on the two-trait sigil, a broken locked
        // pair, a crab trait astray on War Elemental, and a second trait on
        // Stout Heart.
        let mut build = legal_build();
        build.sigils[0].first_trait_level = 30;
        assert!(
            fires(&build, Rule::SigilTraitLevel),
            "the level rule never judged the fixture's sigil"
        );

        let mut build = legal_build();
        build.sigils[1].second_trait_id = DMG_CAP;
        assert!(
            fires(&build, Rule::SigilLockedPair),
            "the locked-pair rule never judged the fixture's Awakening+ sigil"
        );

        let mut build = legal_build();
        build.sigils[0].second_trait_id = CRABBY_RESONANCE;
        assert!(
            fires(&build, Rule::SigilQuestLockedTrait),
            "the quest-locked rule never judged the fixture's sigils"
        );

        let mut build = legal_build();
        build.sigils[3].second_trait_id = DMG_CAP;
        assert!(
            fires(&build, Rule::SigilSingleTraitOnly),
            "the single-trait rule never judged the fixture's Stout Heart"
        );

        // Overmasteries. Stun's ladder runs …0.6, 0.8… so 0.7 falls between
        // two rungs, and 2.0 is its top.
        let mut build = legal_build();
        masteries(&mut build)[3].value = 0.7;
        assert!(
            fires(&build, Rule::OvermasteryValue),
            "the ladder rule never judged the fixture's magnitudes"
        );

        let mut build = legal_build();
        masteries(&mut build)[3].value = 2.0;
        assert!(
            fires(&build, Rule::OvermasteryAllMaxed),
            "the all-maxed rule never read the fixture's magnitudes"
        );

        // Summons: a trait Lucilius' main lot cannot grant.
        let mut build = legal_build();
        build.summons[0].main_trait_id = DMG_CAP;
        assert!(
            fires(&build, Rule::SummonTrait),
            "the membership rule never judged the fixture's summons"
        );

        // Summon bonuses: a boss-set id no Behemoth III can grant, and the
        // same id at its top, where it displays +75% against Behemoth III's
        // +50% ceiling. The first case must NOT fire the magnitude rule (level
        // 5 of the boss table displays +45%, which is under the ceiling) — so
        // the two assertions also prove the rules are separable rather than
        // one rule firing twice.
        let mut build = legal_build();
        build.summons[1].bonus_id = BOSS_SET_HEALING_CAP;
        build.summons[1].bonus_level = 5;
        assert!(
            fires(&build, Rule::SummonBonusSource),
            "the bonus-source rule never judged the fixture's summons"
        );
        assert!(
            !fires(&build, Rule::SummonBonusMagnitude),
            "a magnitude under the ceiling was accused"
        );

        let mut build = legal_build();
        build.summons[1].bonus_id = BOSS_SET_HEALING_CAP;
        build.summons[1].bonus_level = 9;
        assert!(
            fires(&build, Rule::SummonBonusMagnitude),
            "the magnitude rule never judged the fixture's summons"
        );

        // Nudging Behemoth's bonus alone to its top makes a SECOND perfect
        // watched summon, which can only fire if Lucilius' top-of-window
        // state was also read and recognised — the summon twin of the Stun
        // case above.
        let mut build = legal_build();
        build.summons[1].bonus_level = 9;
        assert!(
            fires(&build, Rule::SummonPerfectCount),
            "the perfect-count report never read the fixture's summons"
        );

        // Master traits: one node past the 50-slot storage.
        let mut build = legal_build();
        build.skillboard.push(50);
        assert!(
            fires(&build, Rule::MasterTraitCount),
            "the count rule never judged the fixture's skillboard"
        );
    }

    /// A stored finding must be renderable from the database ALONE.
    ///
    /// `Subject` carries a slot index, which means nothing without the build it
    /// indexes into. Before this, a UI had to load the encounter to name the
    /// gear — and one that loaded the wrong encounter named whichever sigil now
    /// sat in that slot, accusing gear the rules never flagged.
    #[test]
    fn a_finding_carries_the_gear_it_is_about() {
        let mut build = legal_build();
        build.sigils[0].first_trait_level = 30;

        let findings = audit(&build);
        let sigil = findings
            .iter()
            .find(|f| f.rule == Rule::SigilTraitLevel)
            .expect("the level rule fired");

        assert_eq!(
            sigil.evidence,
            Some(Evidence::Sigil {
                sigil_id: build.sigils[0].sigil_id,
                level: build.sigils[0].sigil_level,
                traits: vec![
                    EvidenceTrait {
                        id: build.sigils[0].first_trait_id,
                        level: 30
                    },
                    EvidenceTrait {
                        id: build.sigils[0].second_trait_id,
                        level: build.sigils[0].second_trait_level
                    },
                ],
            })
        );
    }

    /// THE WIRE NAMES `src/types.ts` reads, pinned per variant.
    ///
    /// A mismatch here is invisible from Rust and nearly invisible from the UI:
    /// `#[serde(rename_all)]` on an ENUM renames its VARIANTS, not the fields of
    /// its struct variants, so `sigil_id` shipped unrenamed while `kind` looked
    /// right. The renderer's switch matched, then read `undefined` — a crash for
    /// the sigil id and a silently wrong name for the wrightstone's.
    ///
    /// Every variant is listed, not just the two that broke: the next struct
    /// variant with a two-word field is the same bug again.
    #[test]
    fn evidence_serializes_with_the_field_names_the_frontend_reads() {
        let keys = |evidence: Evidence| {
            let json = serde_json::to_value(evidence).expect("evidence serializes");
            let mut keys: Vec<String> = json
                .as_object()
                .expect("an internally tagged variant is a JSON object")
                .keys()
                .cloned()
                .collect();
            keys.sort();
            keys
        };
        let summon = || EvidenceSummon {
            summon_id: 1,
            main: EvidenceTrait { id: 2, level: 3 },
            bonus: EvidenceTrait { id: 4, level: 5 },
        };
        let overmastery = || EvidenceOvermastery {
            id: 1,
            value: 2.0,
            flags: 3,
        };

        assert_eq!(
            keys(Evidence::Sigil {
                sigil_id: 1,
                level: 2,
                traits: vec![]
            }),
            ["kind", "level", "sigilId", "traits"]
        );
        assert_eq!(
            keys(Evidence::Wrightstone {
                wrightstone_id: 1,
                traits: vec![]
            }),
            ["kind", "traits", "wrightstoneId"]
        );
        assert_eq!(
            keys(Evidence::Summon(summon())),
            ["bonus", "kind", "main", "summonId"]
        );
        assert_eq!(
            keys(Evidence::Summons {
                summons: vec![summon()]
            }),
            ["kind", "summons"]
        );
        assert_eq!(
            keys(Evidence::Overmastery(overmastery())),
            ["flags", "id", "kind", "value"]
        );
        assert_eq!(
            keys(Evidence::Overmasteries {
                entries: vec![overmastery()]
            }),
            ["entries", "kind"]
        );
        assert_eq!(
            keys(Evidence::MasterTraits {
                observed: 51,
                allowed: 50
            }),
            ["allowed", "kind", "observed"]
        );
    }

    /// Findings already in `logs.db` were written with the snake_case names, so
    /// the renamed fields must still ACCEPT them.
    ///
    /// A stored row that fails to parse does not degrade to an unnamed finding —
    /// it fails the whole query it was read in, taking every other player's
    /// findings down with it.
    #[test]
    fn a_stored_finding_written_with_the_old_names_still_reads() {
        let sigil = r#"{"kind":"sigil","sigil_id":6368016,"level":15,"traits":[]}"#;
        assert_eq!(
            serde_json::from_str::<Evidence>(sigil).expect("a stored sigil row reads"),
            Evidence::Sigil {
                sigil_id: 6368016,
                level: 15,
                traits: vec![]
            }
        );

        let wrightstone = r#"{"kind":"wrightstone","wrightstone_id":42,"traits":[]}"#;
        assert_eq!(
            serde_json::from_str::<Evidence>(wrightstone).expect("a stored wrightstone row reads"),
            Evidence::Wrightstone {
                wrightstone_id: 42,
                traits: vec![]
            }
        );
    }

    /// Whole-set rules are about the set, so their snapshot is the set — and it
    /// drops empty slots, which would otherwise render as a garbage name.
    #[test]
    fn a_whole_set_finding_carries_the_whole_set_without_its_empty_slots() {
        let mut build = legal_build();
        build.summons.push(EquippedSummon {
            summon_id: EMPTY_ID,
            main_trait_id: EMPTY_ID,
            main_trait_level: 0,
            bonus_id: EMPTY_ID,
            bonus_level: 0,
        });
        let equipped = build
            .summons
            .iter()
            .filter(|s| !is_empty(s.summon_id))
            .count();

        let evidence = evidence_for(
            &build,
            &Finding {
                rule: Rule::SummonPerfectCount,
                subject: Subject::Summons,
                observed: Value::Count(2),
                allowed: Value::None,
                odds: Some(1e-6),
                evidence: None,
            },
        );

        match evidence {
            Some(Evidence::Summons { summons }) => assert_eq!(summons.len(), equipped),
            other => panic!("expected a summon set, got {other:?}"),
        }
    }

    /// An overmastery snapshot keeps `flags`: it decides whether the magnitude
    /// is a level or an amount, and a UI without it prints a bare `20` where
    /// `+20%` belongs.
    #[test]
    fn an_overmastery_snapshot_keeps_the_flags_that_format_it() {
        let mut build = legal_build();
        masteries(&mut build)[3].value = 0.7;

        let findings = audit(&build);
        let overmastery = findings
            .iter()
            .find(|f| f.rule == Rule::OvermasteryValue)
            .expect("the value rule fired");

        match &overmastery.evidence {
            Some(Evidence::Overmastery(entry)) => {
                assert_eq!(entry.value, 0.7);
                assert_eq!(entry.flags, masteries(&mut legal_build())[3].flags);
            }
            other => panic!("expected one overmastery, got {other:?}"),
        }
    }

    /// THE STALENESS GUARD for [`RULES_VERSION`].
    ///
    /// Findings are STORED, so a rule change that does not bump the version
    /// leaves every log in the database judged by the old rules with nothing
    /// to notice it — the failure would be silent and permanent. This pins
    /// what the rules actually say about one deliberately illegal build, so
    /// any change to their output fails here and forces a deliberate bump.
    ///
    /// When it fails: read the diff, confirm the new output is what you meant,
    /// paste it in, and bump `RULES_VERSION`. Both, always — the snapshot
    /// alone would hide exactly the staleness this exists to catch.
    /// TWO builds, because no single one can reach every rule: the accusation
    /// rules need magnitudes off their ladders, and the two PERFECTION reports
    /// need those same magnitudes at their tops. Snapshotting only the first
    /// left both reports outside the guard entirely — which is how the
    /// 2026-07-30 rescoping of them (chased effects only, single-level windows
    /// excluded) changed what the rules say while this test stayed green.
    ///
    /// `odds` is part of the snapshot because it is the perfection reports'
    /// whole payload: a rescoping that counts a different set of summons can
    /// leave the COUNT untouched and still reprice the claim.
    #[test]
    fn the_rules_version_matches_what_the_rules_currently_say() {
        let mut accused = legal_build();
        accused.summons[1].bonus_id = BOSS_SET_HEALING_CAP;
        accused.summons[1].bonus_level = 9;
        accused.sigils[0].first_trait_level = 30;
        masteries(&mut accused)[3].value = 0.7;

        // Stun to the top of its ladder maxes all four chased overmasteries;
        // Behemoth's bonus to the top of its window makes a second perfect
        // summon beside the fixture's already-perfect Lucilius.
        let mut perfect = legal_build();
        masteries(&mut perfect)[3].value = 2.0;
        perfect.summons[1].bonus_level = 9;

        let snapshot: Vec<String> = [accused, perfect]
            .iter()
            .flat_map(audit)
            .map(|finding| {
                format!(
                    "{:?} {:?} {:?} -> {:?} odds={:?}",
                    finding.rule, finding.subject, finding.observed, finding.allowed, finding.odds
                )
            })
            .collect();

        assert_eq!(
            (RULES_VERSION, snapshot.join("\n").as_str()),
            (
                6,
                "SigilTraitLevel Sigil(0) Level(30) -> Level(15) odds=None\n\
                 OvermasteryValue Overmastery(3) Amount(0.7) -> Amount(2.0) odds=None\n\
                 SummonBonusSource Summon(1) SummonBonusId(782879360) -> \
                 SummonIds([261648089, 789923164, 1851353340, 2237464972]) \
                 odds=None\n\
                 SummonBonusMagnitude Summon(1) Amount(75.0) -> Amount(50.0) odds=None\n\
                 OvermasteryAllMaxed Overmasteries Count(4) -> None \
                 odds=Some(0.0010497599999999998)\n\
                 SummonPerfectCount Summons Count(2) -> None \
                 odds=Some(2.4793388429752063e-8)"
            ),
            "the rules changed what they say — update this snapshot AND bump \
             RULES_VERSION, or every stored log keeps the old verdicts forever"
        );
    }

    /// DMG Cap: a real trait, out of place everywhere the cases above use it.
    const DMG_CAP: u32 = 0xdc58_4f60;
    /// The boss-set Healing Cap Up, granted by Rolan, Lucilius, Beelzebub and
    /// Lilith alone and reaching +75% where the standard set stops at +50%.
    const BOSS_SET_HEALING_CAP: u32 = 0x2ea9_ca80;
    /// The Crabby Resonance quest-locked trait.
    const CRABBY_RESONANCE: u32 = 0x0820_33cb;

    fn fires(build: &LegalityInputs, rule: Rule) -> bool {
        audit(build).iter().any(|finding| finding.rule == rule)
    }
}
