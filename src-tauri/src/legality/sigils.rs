//! Sigil legality, rules 3, 4 and 5.
//!
//! A sigil's id fixes what it is allowed to carry: `sigil-legality.json`
//! (generated from gem.tbl) maps each of the 1034 sigil ids to its intrinsic
//! first trait, and to either a fixed second trait, a lot the second trait
//! rolls from, or nothing at all. Anything the table cannot speak to — an
//! unknown sigil id, an unresolvable lot — produces silence, never a finding.

use std::collections::{HashMap, HashSet};

use protocol::Sigil;
use serde::Deserialize;

use crate::transmarvel;

use super::{Finding, Rule, Severity, Subject, Value};

/// The level ceiling for a sigil trait that the table does not override. A
/// user-confirmed game rule, not a table fact: `maxLevel` is emitted only by
/// the eleven entries that EXCEED it, so a missing key means 15 — never 0.
const DEFAULT_SIGIL_TRAIT_MAX_LEVEL: u32 = 15;

/// The engine's empty-id sentinel (`EMPTY_SIGIL_HASH` in the hook,
/// `EMPTY_KEY` in game-reader).
const EMPTY_SIGIL_HASH: u32 = 0x887a_e0b0;

/// An empty slot reaches us as either a plain zero or the engine sentinel:
/// the hook normalises `0x887AE0B0` to `0` on one path but passes it straight
/// through on others, so both must count as empty. Treating only one as empty
/// either audits empty slots (false accusations) or skips real ones.
fn is_empty(id: u32) -> bool {
    id == 0 || id == EMPTY_SIGIL_HASH
}

/// One row of `sigil-legality.json`, as generated.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawEntry {
    /// The sigil's intrinsic first trait, hex8.
    trait1: String,
    /// A second trait the item fixes, hex8; `null` when it rolls or has none.
    trait2: Option<String>,
    /// The skill_type_lot id a rolled second trait comes from, decimal.
    trait2_lot: Option<String>,
    /// Highest trait level, only when it exceeds
    /// [`DEFAULT_SIGIL_TRAIT_MAX_LEVEL`].
    max_level: Option<u32>,
}

/// What second trait a sigil may carry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SecondTrait {
    /// The item grants no second trait at all, so any present one is illegal.
    Nothing,
    /// The item fixes one specific trait.
    Fixed(u32),
    /// The trait rolls from this skill_type_lot id.
    Lot(i32),
    /// The table named a lot we cannot resolve — missing data, stay silent.
    Unresolvable,
}

/// The legal shape of one sigil id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SigilEntry {
    pub trait1: u32,
    pub second: SecondTrait,
    /// Already defaulted; the `Option` in the file never escapes the loader.
    pub max_level: u32,
}

fn parse_hex(value: &str) -> Option<u32> {
    u32::from_str_radix(value, 16).ok()
}

/// Every trait reachable through one skill_type_lot id, resolved in the two
/// steps the tables actually require: the lot **id** selects a row of
/// `(lot hash, weight)` options in `skill_type_rows`, and each lot **hash**
/// then keys `skill_lots` for the traits themselves. Looking the small id up
/// in `skill_lots` directly always misses, which would silently disable
/// rule 4 rather than fail.
fn lot_pools() -> &'static HashMap<i32, HashSet<u32>> {
    static POOLS: std::sync::OnceLock<HashMap<i32, HashSet<u32>>> = std::sync::OnceLock::new();
    POOLS.get_or_init(|| {
        let tables = transmarvel::stock_tables();
        tables
            .skill_type_rows
            .iter()
            .map(|(&lot_id, options)| {
                let traits: HashSet<u32> = options
                    .iter()
                    .filter_map(|&(lot_hash, _weight)| tables.skill_lots.get(&lot_hash))
                    .flatten()
                    .copied()
                    .collect();
                (lot_id, traits)
            })
            // An empty pool would permit nothing and accuse everyone; treat it
            // as missing data instead.
            .filter(|(_, traits)| !traits.is_empty())
            .collect()
    })
}

/// The traits one skill_type_lot id can grant, or `None` when the tables
/// cannot resolve it.
pub fn lot_traits(lot_id: i32) -> Option<&'static HashSet<u32>> {
    lot_pools().get(&lot_id)
}

/// The baked sigil table, keyed by sigil id. Rows whose `trait1` will not
/// parse are dropped: an unreadable row is missing data, and a sigil the
/// table does not know is never audited.
pub fn stock_sigils() -> &'static HashMap<u32, SigilEntry> {
    static SIGILS: std::sync::OnceLock<HashMap<u32, SigilEntry>> = std::sync::OnceLock::new();
    SIGILS.get_or_init(|| {
        let raw: HashMap<String, RawEntry> =
            serde_json::from_str(include_str!("../../assets/sigil-legality.json"))
                .expect("sigil-legality.json matches the generated shape");

        raw.into_iter()
            .filter_map(|(id, entry)| {
                let id = parse_hex(&id)?;
                let trait1 = parse_hex(&entry.trait1)?;
                let second = match (&entry.trait2, &entry.trait2_lot) {
                    (Some(fixed), _) => {
                        parse_hex(fixed).map_or(SecondTrait::Unresolvable, SecondTrait::Fixed)
                    }
                    (None, Some(lot)) => match lot.parse::<i32>() {
                        Ok(lot_id) if lot_traits(lot_id).is_some() => SecondTrait::Lot(lot_id),
                        _ => SecondTrait::Unresolvable,
                    },
                    (None, None) => SecondTrait::Nothing,
                };
                Some((
                    id,
                    SigilEntry {
                        trait1,
                        second,
                        max_level: entry.max_level.unwrap_or(DEFAULT_SIGIL_TRAIT_MAX_LEVEL),
                    },
                ))
            })
            .collect()
    })
}

/// Rules 3, 4 and 5. Empty slots and sigil ids the table does not know are
/// skipped entirely.
pub fn audit_sigils(sigils: &[Sigil]) -> Vec<Finding> {
    let table = stock_sigils();
    let mut findings = Vec::new();

    for (index, sigil) in sigils.iter().enumerate() {
        if is_empty(sigil.sigil_id) {
            continue;
        }
        let Some(entry) = table.get(&sigil.sigil_id) else {
            continue;
        };

        // Rule 5: the id encodes the first trait, so a mismatch is proof.
        if sigil.first_trait_id != entry.trait1 {
            findings.push(Finding {
                rule: Rule::SigilFirstTrait,
                severity: Severity::Impossible,
                subject: Subject::Sigil(index),
                observed: Value::TraitId(sigil.first_trait_id),
                allowed: Value::TraitIds(vec![entry.trait1]),
                odds: None,
            });
        }

        // Rule 3: neither trait may exceed the sigil's own ceiling. The
        // second slot's level is only judged when a second trait is actually
        // present — an empty slot's level field carries no meaning.
        let mut levels = vec![sigil.first_trait_level];
        if !is_empty(sigil.second_trait_id) {
            levels.push(sigil.second_trait_level);
        }
        for level in levels {
            if level > entry.max_level {
                findings.push(Finding {
                    rule: Rule::SigilTraitLevel,
                    severity: Severity::Impossible,
                    subject: Subject::Sigil(index),
                    observed: Value::Level(level),
                    allowed: Value::Level(entry.max_level),
                    odds: None,
                });
            }
        }

        // Rule 4: the second trait must be one the item can grant.
        if !is_empty(sigil.second_trait_id) {
            let permitted = match entry.second {
                SecondTrait::Nothing => Some(false),
                SecondTrait::Fixed(fixed) => Some(fixed == sigil.second_trait_id),
                SecondTrait::Lot(lot_id) => {
                    lot_traits(lot_id).map(|pool| pool.contains(&sigil.second_trait_id))
                }
                SecondTrait::Unresolvable => None,
            };

            if permitted == Some(false) {
                findings.push(Finding {
                    rule: Rule::SigilSecondTrait,
                    severity: Severity::Impossible,
                    subject: Subject::Sigil(index),
                    observed: Value::TraitId(sigil.second_trait_id),
                    allowed: Value::None,
                    odds: None,
                });
            }
        }
    }

    findings
}

#[cfg(test)]
mod tests {
    use super::*;

    /// War Elemental: trait1 `4c588c27`, second trait rolls from lot 6, and
    /// no `maxLevel` key — so its ceiling is the default 15.
    const WAR_ELEMENTAL: u32 = 0x0061_2b10;
    const WAR_ELEMENTAL_TRAIT: u32 = 0x4c58_8c27;
    /// A member of lot 6.
    const STEADY_FOCUS: u32 = 0x0053_599e;
    /// A real trait, but not one lot 6 can grant — this discriminates rather
    /// than merely rejecting garbage.
    const DMG_CAP: u32 = 0xdc58_4f60;
    /// A sigil whose entry has both `trait2` and `trait2Lot` null: it takes
    /// no second trait at all.
    const NO_SECOND_SIGIL: u32 = 0x0027_7247;
    const NO_SECOND_TRAIT1: u32 = 0xf26b_aea5;
    /// A sigil whose entry fixes its pair outright — no lot involved.
    const FIXED_PAIR_SIGIL: u32 = 0x0045_57b8;
    const FIXED_PAIR_TRAIT1: u32 = 0xa8a3_163b;
    const FIXED_PAIR_TRAIT2: u32 = 0x5007_9a1c;

    fn sigil(sigil_id: u32, first: (u32, u32), second: (u32, u32)) -> Sigil {
        Sigil {
            first_trait_id: first.0,
            first_trait_level: first.1,
            second_trait_id: second.0,
            second_trait_level: second.1,
            sigil_id,
            equipped_character: 0,
            sigil_level: 15,
            acquisition_count: 1,
            notification_enum: 0,
        }
    }

    /// The guardrail for the two-step lot resolution: lot 6's pool is the
    /// live-validated Transmarvel pool. A table reshuffle that emptied or
    /// shrank it would silently disable rule 4, so this count is pinned.
    #[test]
    fn lot_six_resolves_to_the_live_validated_pool() {
        let pool = lot_traits(6).expect("lot 6 resolves");
        assert_eq!(pool.len(), 38);
        assert!(pool.contains(&STEADY_FOCUS));
        assert!(!pool.contains(&DMG_CAP));
    }

    /// Every lot the sigil table names must resolve, or the rule it backs is
    /// dead code.
    #[test]
    fn every_lot_the_table_names_resolves() {
        for entry in stock_sigils().values() {
            if let SecondTrait::Lot(lot_id) = entry.second {
                assert!(lot_traits(lot_id).is_some(), "lot {lot_id} unresolved");
            }
        }
        assert_eq!(stock_sigils().len(), 1034);
    }

    #[test]
    fn legal_sigil_yields_no_findings() {
        let equipped = [sigil(
            WAR_ELEMENTAL,
            (WAR_ELEMENTAL_TRAIT, 15),
            (STEADY_FOCUS, 10),
        )];
        assert_eq!(audit_sigils(&equipped), vec![]);
    }

    #[test]
    fn flags_a_trait_level_above_the_cap() {
        let equipped = [sigil(
            WAR_ELEMENTAL,
            (WAR_ELEMENTAL_TRAIT, 30),
            (STEADY_FOCUS, 10),
        )];
        let findings = audit_sigils(&equipped);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, Rule::SigilTraitLevel);
        assert_eq!(findings[0].severity, Severity::Impossible);
        assert_eq!(findings[0].subject, Subject::Sigil(0));
        assert_eq!(findings[0].observed, Value::Level(30));
        assert_eq!(findings[0].allowed, Value::Level(15));
    }

    #[test]
    fn flags_a_second_trait_the_lot_cannot_grant() {
        let equipped = [
            sigil(WAR_ELEMENTAL, (WAR_ELEMENTAL_TRAIT, 15), (STEADY_FOCUS, 10)),
            sigil(WAR_ELEMENTAL, (WAR_ELEMENTAL_TRAIT, 15), (DMG_CAP, 10)),
        ];
        let findings = audit_sigils(&equipped);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, Rule::SigilSecondTrait);
        assert_eq!(findings[0].severity, Severity::Impossible);
        assert_eq!(findings[0].subject, Subject::Sigil(1));
        assert_eq!(findings[0].observed, Value::TraitId(DMG_CAP));
        assert_eq!(findings[0].allowed, Value::None);
    }

    #[test]
    fn flags_a_first_trait_the_sigil_id_does_not_encode() {
        let equipped = [sigil(WAR_ELEMENTAL, (DMG_CAP, 15), (STEADY_FOCUS, 10))];
        let findings = audit_sigils(&equipped);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, Rule::SigilFirstTrait);
        assert_eq!(findings[0].severity, Severity::Impossible);
        assert_eq!(findings[0].observed, Value::TraitId(DMG_CAP));
        assert_eq!(
            findings[0].allowed,
            Value::TraitIds(vec![WAR_ELEMENTAL_TRAIT])
        );
    }

    /// A sigil that grants no second trait cannot have one.
    #[test]
    fn flags_a_second_trait_on_a_sigil_that_takes_none() {
        let equipped = [sigil(
            NO_SECOND_SIGIL,
            (NO_SECOND_TRAIT1, 15),
            (STEADY_FOCUS, 10),
        )];
        let findings = audit_sigils(&equipped);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, Rule::SigilSecondTrait);
        assert_eq!(findings[0].observed, Value::TraitId(STEADY_FOCUS));

        // …but with the slot genuinely empty it is a legal single-trait sigil.
        let bare = [sigil(NO_SECOND_SIGIL, (NO_SECOND_TRAIT1, 15), (0, 0))];
        assert_eq!(audit_sigils(&bare), vec![]);
    }

    /// A fixed pair admits exactly one second trait — and it must admit that
    /// one, not merely reject everything.
    #[test]
    fn accepts_only_the_pair_a_fixed_sigil_declares() {
        let legal = [sigil(
            FIXED_PAIR_SIGIL,
            (FIXED_PAIR_TRAIT1, 15),
            (FIXED_PAIR_TRAIT2, 15),
        )];
        assert_eq!(audit_sigils(&legal), vec![]);

        let swapped = [sigil(
            FIXED_PAIR_SIGIL,
            (FIXED_PAIR_TRAIT1, 15),
            (STEADY_FOCUS, 15),
        )];
        let findings = audit_sigils(&swapped);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, Rule::SigilSecondTrait);
        assert_eq!(findings[0].observed, Value::TraitId(STEADY_FOCUS));
    }

    #[test]
    fn empty_sigil_list_is_silent() {
        assert_eq!(audit_sigils(&[]), vec![]);
    }

    /// An id the table does not know says nothing about legality, however
    /// absurd the levels look.
    #[test]
    fn unknown_sigil_id_is_silent_even_with_absurd_levels() {
        let equipped = [sigil(0xdead_beef, (DMG_CAP, 99), (STEADY_FOCUS, 99))];
        assert_eq!(audit_sigils(&equipped), vec![]);
    }

    /// Both empty-slot sentinels must be skipped — the plain zero and the
    /// engine's `0x887AE0B0`.
    #[test]
    fn empty_sigil_slots_are_silent_for_both_sentinels() {
        for sentinel in [0_u32, EMPTY_SIGIL_HASH] {
            let equipped = [sigil(sentinel, (DMG_CAP, 99), (DMG_CAP, 99))];
            assert_eq!(
                audit_sigils(&equipped),
                vec![],
                "sentinel {sentinel:08x} was audited"
            );
        }
    }

    /// An empty SECOND-trait slot must also be skipped under either
    /// sentinel, rather than judged as an illegal second trait.
    #[test]
    fn empty_second_trait_slots_are_silent_for_both_sentinels() {
        for sentinel in [0_u32, EMPTY_SIGIL_HASH] {
            let equipped = [sigil(
                WAR_ELEMENTAL,
                (WAR_ELEMENTAL_TRAIT, 15),
                (sentinel, 99),
            )];
            assert_eq!(
                audit_sigils(&equipped),
                vec![],
                "second-trait sentinel {sentinel:08x} was audited"
            );
        }
    }

    /// The eleven entries that carry `maxLevel` raise the ceiling above the
    /// default; a missing key must never read as 0.
    #[test]
    fn max_level_defaults_to_fifteen_and_is_raised_only_where_declared() {
        let raised = stock_sigils()
            .values()
            .filter(|entry| entry.max_level != DEFAULT_SIGIL_TRAIT_MAX_LEVEL)
            .count();
        assert_eq!(raised, 11);
        assert!(stock_sigils()
            .values()
            .all(|entry| entry.max_level >= DEFAULT_SIGIL_TRAIT_MAX_LEVEL));
    }
}
