//! Sigil legality: the four user-confirmed sigil rules.
//!
//! * **Two-trait level ceiling** — a sigil carrying BOTH traits caps each at
//!   15 (raised only where the table declares a higher ceiling, e.g. Crabs
//!   Are Forever+ at 45). Single-trait levels are NEVER judged: the per-sigil
//!   max-level data is not a cheat signal (user-confirmed).
//! * **Locked pairs** — the character sigils (X's Awakening+, Fearless
//!   Soul+, Versalis Soul+) fix both traits; any deviation is impossible.
//! * **Quest-locked traits** — the crab traits exist only on their own quest
//!   sigils and roll from no lot; seeing one anywhere else is impossible.
//! * **Single-trait sigils** — Stout Heart (and +) can never carry a second
//!   trait (user-confirmed).
//!
//! What is deliberately NOT here: any generic rule derived from gem.tbl's
//! second-trait columns. That table calls sigils "fixed" that demonstrably
//! roll in the wild — its `Fixed`/`Lot` arms produced 4902 false accusations
//! against a single confirmed-legitimate player before removal — and
//! `sigil-legality.json`'s trait1 column is likewise not trusted to accuse on
//! its own. Anything the tables cannot speak to produces silence, never a
//! finding.

use std::collections::{HashMap, HashSet};

use protocol::Sigil;
use serde::Deserialize;

use crate::transmarvel;

use super::{is_empty, parse_hex, Finding, Rule, Subject, Value};

/// The level ceiling for a sigil trait that the table does not override. A
/// user-confirmed game rule, not a table fact: `maxLevel` is emitted only by
/// the eleven entries that EXCEED it, so a missing key means 15 — never 0.
const DEFAULT_SIGIL_TRAIT_MAX_LEVEL: u32 = 15;

/// One row of `sigil-legality.json`, as generated.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawEntry {
    /// The sigil's intrinsic first trait, hex8.
    trait1: String,
    /// A second trait the item fixes, hex8; `null` when it rolls or has none.
    trait2: Option<String>,
    /// The skill_type_lot id a rolled second trait comes from, decimal.
    /// `null` is AMBIGUOUS on its own — see `rolls_second`.
    trait2_lot: Option<String>,
    /// Whether gem.tbl says this sigil rolls a second trait at all. This is
    /// what disambiguates `trait2Lot: null`: 514 rows genuinely take no
    /// second trait, while 109 roll one from a lot the generator could not
    /// validate. Without this flag the two are indistinguishable and the
    /// second group gets falsely accused.
    rolls_second: bool,
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

/// Every trait reachable through one skill_type_lot id, resolved in the two
/// steps the tables actually require: the lot **id** selects a row of
/// `(lot hash, weight)` options in `skill_type_rows`, and each lot **hash**
/// then keys `skill_lots` for the traits themselves. Looking the small id up
/// in `skill_lots` directly always misses. No rule accuses from these pools
/// any more; they remain because the loader's state split (and its
/// generator-guardrail tests) depend on knowing which lots resolve.
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
                    // No lot named: only `rollsSecond` can say whether that
                    // means "takes none" or "rolls from a lot we cannot
                    // name". Defaulting this to `Nothing` accuses the 109.
                    (None, None) if entry.rolls_second => SecondTrait::Unresolvable,
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

/// The character sigils whose trait pair the game fixes outright, keyed by
/// sigil id. Derived from the transmarvel gacha table — the one source whose
/// trait pairs were live-validated — and NOT from gem.tbl: only the
/// character-sigil rows (`traitLevel == 15`) are locked. The plain stat V+
/// sigils also declare a fixed `trait2` there (`traitLevel == 0`), and those
/// demonstrably roll their second trait in the wild, so they are excluded.
pub fn locked_pairs() -> &'static HashMap<u32, (u32, u32)> {
    static PAIRS: std::sync::OnceLock<HashMap<u32, (u32, u32)>> = std::sync::OnceLock::new();
    PAIRS.get_or_init(|| {
        transmarvel::stock_tables()
            .gem_groups
            .iter()
            .flat_map(|group| &group.items)
            .filter(|item| item.trait2 != 0 && item.trait_level == 15)
            .map(|item| (item.item, (item.trait1, item.trait2)))
            .collect()
    })
}

/// The quest-locked (crab) trait ids: Crabby Resonance, Crabmiration, and the
/// two Crabvestment Returns spellings. None of them is reachable through any
/// skill lot, so outside their own sigils they cannot exist.
pub const QUEST_LOCKED_TRAITS: [u32; 4] = [0x082033cb, 0xd3b8c21f, 0x1b0d9897, 0xd461ecfb];

/// Which sigils may carry each quest-locked trait, derived from the sigil
/// table: the sigils that grant it intrinsically plus the ones that fix it as
/// their second trait (e.g. Crabs Are Forever+ carries two crab traits).
fn quest_locked_homes() -> &'static HashMap<u32, HashSet<u32>> {
    static HOMES: std::sync::OnceLock<HashMap<u32, HashSet<u32>>> = std::sync::OnceLock::new();
    HOMES.get_or_init(|| {
        let mut homes: HashMap<u32, HashSet<u32>> = QUEST_LOCKED_TRAITS
            .iter()
            .map(|&trait_id| (trait_id, HashSet::new()))
            .collect();
        for (&sigil_id, entry) in stock_sigils() {
            if let Some(sigils) = homes.get_mut(&entry.trait1) {
                sigils.insert(sigil_id);
            }
            if let SecondTrait::Fixed(fixed) = entry.second {
                if let Some(sigils) = homes.get_mut(&fixed) {
                    sigils.insert(sigil_id);
                }
            }
        }
        homes
    })
}

/// The sigils that can never carry a second trait, whatever the tables say
/// about anything else: Stout Heart and Stout Heart+. A user-confirmed game
/// rule — deliberately NOT the whole `SecondTrait::Nothing` class, whose 514
/// gem.tbl rows are untrusted.
pub const SINGLE_TRAIT_SIGILS: [u32; 2] = [0xcb5f29c1, 0x26ddcd39];

/// The four sigil rules. Empty slots and sigil ids the table does not know
/// are skipped entirely.
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

        let first = (!is_empty(sigil.first_trait_id)).then_some(sigil.first_trait_id);
        let second = (!is_empty(sigil.second_trait_id)).then_some(sigil.second_trait_id);

        // Two-trait level ceiling: judged ONLY when both traits are present.
        // A single-trait sigil's level is never a signal (quest sigils level
        // far past 15 legitimately), and an empty slot's level field carries
        // no meaning.
        if first.is_some() && second.is_some() {
            for level in [sigil.first_trait_level, sigil.second_trait_level] {
                if level > entry.max_level {
                    findings.push(Finding {
                        rule: Rule::SigilTraitLevel,
                        subject: Subject::Sigil(index),
                        observed: Value::Level(level),
                        allowed: Value::Level(entry.max_level),
                        odds: None,
                        evidence: None,
                    });
                }
            }
        }

        // Locked pairs: a character sigil fixes both traits, so a present
        // trait that differs from its locked one is proof. An empty slot is
        // a partial read, not a missing trait — silence.
        if let Some(&(locked_first, locked_second)) = locked_pairs().get(&sigil.sigil_id) {
            for (observed, locked) in [(first, locked_first), (second, locked_second)] {
                let Some(observed) = observed.filter(|&observed| observed != locked) else {
                    continue;
                };
                findings.push(Finding {
                    rule: Rule::SigilLockedPair,
                    subject: Subject::Sigil(index),
                    observed: Value::TraitId(observed),
                    allowed: Value::TraitIds(vec![locked]),
                    odds: None,
                    evidence: None,
                });
            }
        }

        // Quest-locked traits: a crab trait on any sigil outside its own
        // home set is proof, whichever slot it sits in.
        for trait_id in [first, second].into_iter().flatten() {
            let Some(homes) = quest_locked_homes()
                .get(&trait_id)
                .filter(|homes| !homes.contains(&sigil.sigil_id))
            else {
                continue;
            };
            let mut allowed: Vec<u32> = homes.iter().copied().collect();
            allowed.sort_unstable();
            findings.push(Finding {
                rule: Rule::SigilQuestLockedTrait,
                subject: Subject::Sigil(index),
                observed: Value::TraitId(trait_id),
                // SIGIL ids, not traits: the list names where this trait may live.
                allowed: Value::SigilIds(allowed),
                odds: None,
                evidence: None,
            });
        }

        // Single-trait sigils: Stout Heart can never carry a second trait.
        if let Some(second) = second.filter(|_| SINGLE_TRAIT_SIGILS.contains(&sigil.sigil_id)) {
            findings.push(Finding {
                rule: Rule::SigilSingleTraitOnly,
                subject: Subject::Sigil(index),
                observed: Value::TraitId(second),
                allowed: Value::None,
                odds: None,
                evidence: None,
            });
        }
    }

    findings
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::legality::EMPTY_ID;

    /// War Elemental: trait1 `4c588c27`, second trait rolls from lot 6, and
    /// no `maxLevel` key — so its ceiling is the default 15.
    const WAR_ELEMENTAL: u32 = 0x0061_2b10;
    const WAR_ELEMENTAL_TRAIT: u32 = 0x4c58_8c27;
    /// A member of lot 6.
    const STEADY_FOCUS: u32 = 0x0053_599e;
    /// A real trait, but not one lot 6 can grant — this discriminates rather
    /// than merely rejecting garbage.
    const DMG_CAP: u32 = 0xdc58_4f60;
    /// A sigil that rolls a second trait from a lot the generator could not
    /// validate. Its levels are still judged like anyone else's.
    const UNRESOLVED_LOT_SIGIL: u32 = 0x95a4_1365;
    const UNRESOLVED_LOT_TRAIT1: u32 = 0x1c36_0c63;
    /// Immortal Shell, a single-trait sigil whose entry raises the trait
    /// ceiling to 20. Single-trait levels are never judged, so this exists to
    /// prove exactly that.
    const IMMORTAL_SHELL_SIGIL: u32 = 0x4943_4696;
    const IMMORTAL_SHELL_TRAIT: u32 = 0xbf78_fbfc;

    /// Thunderwolf's Awakening+: locked pair (Recharge, Acuity) — the user's
    /// own canonical example of a locked combination.
    const THUNDERWOLF_AWAKENING_PLUS: u32 = 0x2395_3fd4;
    const THUNDERWOLF_RECHARGE: u32 = 0x7d75_d904;
    const THUNDERWOLF_ACUITY: u32 = 0xbe34_04b9;

    /// The crab quest sigils and their locked traits.
    const CRABBY_RESONANCE_SIGIL: u32 = 0x1c4d_37e4;
    const CRABBY_RESONANCE: u32 = 0x0820_33cb;
    const CRABMIRATION: u32 = 0xd3b8_c21f;
    const CRABVESTMENT_RETURNS: u32 = 0x1b0d_9897;
    /// The second Crabvestment Returns trait id, which no sigil grants.
    const CRABVESTMENT_RETURNS_ALT: u32 = 0xd461_ecfb;
    /// Crabs Are Forever+: fixed crab pair AND a raised ceiling of 45 — the
    /// legal two-trait sigil that a flat "two traits cap at 15" rule would
    /// falsely accuse.
    const CRABS_ARE_FOREVER_PLUS: u32 = 0x426a_d20e;

    const STOUT_HEART_SIGIL: u32 = 0xcb5f_29c1;
    const STOUT_HEART_TRAIT: u32 = 0xa1a8_e39d;
    const STOUT_HEART_PLUS_SIGIL: u32 = 0x26dd_cd39;
    const STOUT_HEART_PLUS_TRAIT: u32 = 0xcac6_aff2;

    // ---- Production counter-examples, all four from the user's own logs ----
    /// Damage Cap V+ `b0cb5c64`, trait1 DMG Cap. gem.tbl's `+0x04` column reads
    /// ATK `50079a1c`, yet this sigil was observed carrying six different
    /// second traits — Improved Dodge among them.
    const DAMAGE_CAP_V_PLUS: u32 = 0xb0cb_5c64;
    const IMPROVED_DODGE: u32 = 0x8b3b_f60c;
    /// Celestial Lumen V+ `20492635`, trait1 Celestial Lumen, assigned lot 6 —
    /// observed 228 times carrying Celestial Terra, which no lot contains.
    const CELESTIAL_LUMEN_V_PLUS: u32 = 0x2049_2635;
    const CELESTIAL_LUMEN: u32 = 0xa772_6190;
    const CELESTIAL_TERRA: u32 = 0x9232_dc17;
    /// Supplementary Damage V+ `035a4ddd`, lot 6 — observed 11 times carrying
    /// DMG Cap.
    const SUPP_DAMAGE_V_PLUS: u32 = 0x035a_4ddd;
    const SUPP_DAMAGE: u32 = 0x57ab_5b10;
    /// Improved Dodge+ `e89224a1`, lot 7 — observed 3 times carrying DMG Cap.
    const IMPROVED_DODGE_PLUS: u32 = 0xe892_24a1;

    /// Every second trait the four counter-examples above were seen carrying,
    /// paired with the sigil that carried it. All from player "manmoth", who
    /// confirmed the build is legitimate, so every one of these MUST be silent.
    const PRODUCTION_COUNTER_EXAMPLES: [(u32, u32, u32); 4] = [
        (DAMAGE_CAP_V_PLUS, DMG_CAP, IMPROVED_DODGE),
        (CELESTIAL_LUMEN_V_PLUS, CELESTIAL_LUMEN, CELESTIAL_TERRA),
        (SUPP_DAMAGE_V_PLUS, SUPP_DAMAGE, DMG_CAP),
        (IMPROVED_DODGE_PLUS, IMPROVED_DODGE, DMG_CAP),
    ];

    /// The four sigils that produced 4902 false accusations between them
    /// against a build its owner confirmed is legitimate. Two came through the
    /// `Fixed` arm (gem.tbl `+0x04`), two through the `Lot` arm (the
    /// synthesis pool). Neither arm may ever speak again.
    #[test]
    fn the_production_counter_examples_are_silent() {
        for (sigil_id, trait1, second) in PRODUCTION_COUNTER_EXAMPLES {
            let equipped = [sigil(sigil_id, (trait1, 15), (second, 15))];
            assert_eq!(
                audit_sigils(&equipped),
                vec![],
                "accused legitimate sigil {sigil_id:08x} of carrying {second:08x}"
            );
        }
    }

    /// The whole shipped table, swept: outside the two narrow user-confirmed
    /// classes — the 28 locked-pair character sigils and the Stout Heart
    /// pair — no sigil id may be accused over its second trait, whatever that
    /// (non-quest-locked) trait is. This is the behavioural companion to
    /// removing the gem.tbl-backed second-trait rule — it fails if a generic
    /// second-trait constraint is reintroduced under any arm.
    #[test]
    fn no_ordinary_sigil_can_be_accused_over_its_second_trait() {
        for (&sigil_id, entry) in stock_sigils() {
            if locked_pairs().contains_key(&sigil_id) || SINGLE_TRAIT_SIGILS.contains(&sigil_id) {
                continue;
            }
            for second in [DMG_CAP, STEADY_FOCUS, CELESTIAL_TERRA, 0xdead_beef] {
                let equipped = [sigil(sigil_id, (entry.trait1, 1), (second, 1))];
                assert_eq!(
                    audit_sigils(&equipped),
                    vec![],
                    "sigil {sigil_id:08x} was accused over second trait {second:08x}"
                );
            }
        }
    }

    /// The locked-pair table: exactly the 28 character sigils, keyed off the
    /// live-validated transmarvel data, with the user's canonical example in
    /// it. The plain stat V+ sigils — which also declare a fixed `trait2` in
    /// that table but roll it in the wild — must NOT be in here; Damage Cap
    /// V+ is the one that produced the bulk of the 4902 false accusations.
    #[test]
    fn locked_pairs_are_the_character_sigils_only() {
        let pairs = locked_pairs();
        assert_eq!(pairs.len(), 28);
        assert_eq!(
            pairs.get(&THUNDERWOLF_AWAKENING_PLUS),
            Some(&(THUNDERWOLF_RECHARGE, THUNDERWOLF_ACUITY))
        );
        assert!(
            !pairs.contains_key(&DAMAGE_CAP_V_PLUS),
            "a plain stat V+ sigil is in the locked-pair table — these roll \
             their second trait in the wild and every owner would be accused"
        );
    }

    /// Cross-corroboration: for every locked pair, the intrinsic first trait
    /// in `sigil-legality.json` (an independent extraction) agrees with the
    /// transmarvel table. A disagreement means one source drifted and the
    /// rule cannot be trusted to accuse.
    #[test]
    fn locked_pair_first_traits_agree_with_the_sigil_table() {
        for (&sigil_id, &(first, _)) in locked_pairs() {
            let entry = stock_sigils()
                .get(&sigil_id)
                .unwrap_or_else(|| panic!("locked-pair sigil {sigil_id:08x} not in sigil table"));
            assert_eq!(
                entry.trait1, first,
                "sigil {sigil_id:08x}: transmarvel says trait1 {first:08x}, \
                 sigil table says {:08x}",
                entry.trait1
            );
        }
    }

    /// The user's canonical example, both ways: the true pair is silent, and
    /// a different second trait on the same sigil is impossible.
    #[test]
    fn a_locked_pair_admits_exactly_its_own_traits() {
        let legal = [sigil(
            THUNDERWOLF_AWAKENING_PLUS,
            (THUNDERWOLF_RECHARGE, 15),
            (THUNDERWOLF_ACUITY, 15),
        )];
        assert_eq!(audit_sigils(&legal), vec![]);

        let wrong_second = [sigil(
            THUNDERWOLF_AWAKENING_PLUS,
            (THUNDERWOLF_RECHARGE, 15),
            (STEADY_FOCUS, 15),
        )];
        let findings = audit_sigils(&wrong_second);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, Rule::SigilLockedPair);
        assert_eq!(findings[0].observed, Value::TraitId(STEADY_FOCUS));
        assert_eq!(
            findings[0].allowed,
            Value::TraitIds(vec![THUNDERWOLF_ACUITY])
        );

        let wrong_first = [sigil(
            THUNDERWOLF_AWAKENING_PLUS,
            (DMG_CAP, 15),
            (THUNDERWOLF_ACUITY, 15),
        )];
        let findings = audit_sigils(&wrong_first);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, Rule::SigilLockedPair);
        assert_eq!(findings[0].observed, Value::TraitId(DMG_CAP));
    }

    /// An empty slot on a locked-pair sigil is a partial read, not a missing
    /// trait — silence, under either empty sentinel.
    #[test]
    fn a_locked_pair_with_an_empty_slot_is_silent() {
        for sentinel in [0_u32, EMPTY_ID] {
            let equipped = [sigil(
                THUNDERWOLF_AWAKENING_PLUS,
                (THUNDERWOLF_RECHARGE, 15),
                (sentinel, 0),
            )];
            assert_eq!(audit_sigils(&equipped), vec![]);
        }
    }

    /// The quest-locked homes, pinned: each crab trait maps to exactly the
    /// sigils the table says grant it. If a regeneration moves one, the rule
    /// must be re-derived, not patched.
    #[test]
    fn quest_locked_homes_match_the_table() {
        let homes = quest_locked_homes();
        let sorted = |trait_id: u32| {
            let mut sigils: Vec<u32> = homes[&trait_id].iter().copied().collect();
            sigils.sort_unstable();
            sigils
        };
        assert_eq!(
            sorted(CRABBY_RESONANCE),
            vec![CRABBY_RESONANCE_SIGIL, CRABS_ARE_FOREVER_PLUS]
        );
        assert_eq!(
            sorted(CRABMIRATION),
            vec![CRABS_ARE_FOREVER_PLUS, 0x82f1_e7e4]
        );
        assert_eq!(
            sorted(CRABVESTMENT_RETURNS),
            vec![0x24f8_f42f, 0x66cb_28ba, 0x7678_6869, 0xf8fe_f304]
        );
        assert_eq!(sorted(CRABVESTMENT_RETURNS_ALT), Vec::<u32>::new());
    }

    /// Crab traits at home are legal — including Crabs Are Forever+, which
    /// carries TWO of them at once.
    #[test]
    fn crab_traits_on_their_own_sigils_are_silent() {
        let equipped = [
            sigil(CRABBY_RESONANCE_SIGIL, (CRABBY_RESONANCE, 45), (0, 0)),
            sigil(
                CRABS_ARE_FOREVER_PLUS,
                (CRABBY_RESONANCE, 45),
                (CRABMIRATION, 45),
            ),
        ];
        assert_eq!(audit_sigils(&equipped), vec![]);
    }

    /// A crab trait anywhere else is impossible, in either slot.
    #[test]
    fn crab_traits_on_any_other_sigil_are_flagged() {
        let as_second = [sigil(
            WAR_ELEMENTAL,
            (WAR_ELEMENTAL_TRAIT, 15),
            (CRABBY_RESONANCE, 10),
        )];
        let findings = audit_sigils(&as_second);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, Rule::SigilQuestLockedTrait);
        assert_eq!(findings[0].observed, Value::TraitId(CRABBY_RESONANCE));

        let as_first = [sigil(WAR_ELEMENTAL, (CRABVESTMENT_RETURNS, 15), (0, 0))];
        let findings = audit_sigils(&as_first);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, Rule::SigilQuestLockedTrait);
        assert_eq!(findings[0].observed, Value::TraitId(CRABVESTMENT_RETURNS));

        // The alternate Crabvestment spelling has no home at all.
        let alt = [sigil(
            WAR_ELEMENTAL,
            (WAR_ELEMENTAL_TRAIT, 15),
            (CRABVESTMENT_RETURNS_ALT, 10),
        )];
        let findings = audit_sigils(&alt);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, Rule::SigilQuestLockedTrait);
        assert_eq!(findings[0].allowed, Value::SigilIds(vec![]));
    }

    /// Stout Heart may hold exactly one trait: bare is legal, any second
    /// trait is impossible — for the base sigil and the +.
    #[test]
    fn stout_heart_can_never_carry_a_second_trait() {
        let legal = [
            sigil(STOUT_HEART_SIGIL, (STOUT_HEART_TRAIT, 15), (0, 0)),
            sigil(STOUT_HEART_PLUS_SIGIL, (STOUT_HEART_PLUS_TRAIT, 15), (0, 0)),
        ];
        assert_eq!(audit_sigils(&legal), vec![]);

        for sigil_id in [STOUT_HEART_SIGIL, STOUT_HEART_PLUS_SIGIL] {
            let trait1 = stock_sigils()[&sigil_id].trait1;
            let equipped = [sigil(sigil_id, (trait1, 15), (STEADY_FOCUS, 10))];
            let findings = audit_sigils(&equipped);
            assert_eq!(findings.len(), 1, "sigil {sigil_id:08x}");
            assert_eq!(findings[0].rule, Rule::SigilSingleTraitOnly);
            assert_eq!(findings[0].observed, Value::TraitId(STEADY_FOCUS));
        }
    }

    /// The Stout Heart ids and the table agree these sigils take no second
    /// trait — the constant is user-confirmed, this pins it to the data.
    #[test]
    fn the_single_trait_sigils_take_no_second_trait_in_the_table() {
        for sigil_id in SINGLE_TRAIT_SIGILS {
            let entry = stock_sigils()
                .get(&sigil_id)
                .unwrap_or_else(|| panic!("single-trait sigil {sigil_id:08x} not in table"));
            assert_eq!(entry.second, SecondTrait::Nothing, "sigil {sigil_id:08x}");
        }
    }

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
    fn flags_a_two_trait_sigil_above_the_cap() {
        let equipped = [sigil(
            WAR_ELEMENTAL,
            (WAR_ELEMENTAL_TRAIT, 30),
            (STEADY_FOCUS, 10),
        )];
        let findings = audit_sigils(&equipped);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, Rule::SigilTraitLevel);
        assert_eq!(findings[0].subject, Subject::Sigil(0));
        assert_eq!(findings[0].observed, Value::Level(30));
        assert_eq!(findings[0].allowed, Value::Level(15));
    }

    /// The level rule is a TWO-trait rule (user-confirmed). A single-trait
    /// sigil's level is never a signal: quest sigils legitimately level far
    /// past 15 and the per-sigil max-level data cannot be trusted to accuse.
    #[test]
    fn single_trait_levels_are_never_judged() {
        // 30 exceeds even Immortal Shell's raised ceiling of 20 — still
        // silent, because the second slot is empty.
        let equipped = [
            sigil(WAR_ELEMENTAL, (WAR_ELEMENTAL_TRAIT, 30), (0, 0)),
            sigil(IMMORTAL_SHELL_SIGIL, (IMMORTAL_SHELL_TRAIT, 30), (0, 0)),
        ];
        assert_eq!(audit_sigils(&equipped), vec![]);
    }

    /// The level ceiling is per-sigil even for two-trait sigils, and the
    /// level rule composes with the others: a sigil whose lot is unknown
    /// still has its levels judged.
    #[test]
    fn a_two_trait_sigil_with_an_unknown_lot_still_has_its_levels_judged() {
        let equipped = [sigil(
            UNRESOLVED_LOT_SIGIL,
            (UNRESOLVED_LOT_TRAIT1, 15),
            (DMG_CAP, 30),
        )];
        let findings = audit_sigils(&equipped);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, Rule::SigilTraitLevel);
        assert_eq!(findings[0].observed, Value::Level(30));
        assert_eq!(findings[0].allowed, Value::Level(15));
    }

    /// The three states must stay distinct in the loaded table, in the exact
    /// proportions the generator's own guardrail pins. Were `Unresolvable` to
    /// collapse back into `Nothing`, 109 sigils would be falsely accused and
    /// the single test above could be deleted without anything else noticing.
    #[test]
    fn the_table_keeps_all_three_second_trait_states_distinct() {
        let mut nothing = 0;
        let mut unresolvable = 0;
        let mut lot = 0;
        let mut fixed = 0;
        for entry in stock_sigils().values() {
            match entry.second {
                SecondTrait::Nothing => nothing += 1,
                SecondTrait::Unresolvable => unresolvable += 1,
                SecondTrait::Lot(_) => lot += 1,
                SecondTrait::Fixed(_) => fixed += 1,
            }
        }
        assert_eq!(
            (nothing, unresolvable, lot, fixed),
            (514, 109, 176, 235),
            "second-trait state split drifted. These four numbers mirror \
             EXPECTED_SECOND_TRAIT_STATES in scripts/gen-sigil-legality.py, \
             which aborts on the same drift — if you legitimately validated \
             more lots by growing transmarvel-pool.json, `unresolved` falls \
             and `lot` rises by the same amount, and BOTH the script's \
             constant and this tuple must be updated in that same commit"
        );
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

    /// The `is_empty` predicate itself, tested directly because the
    /// `sigil_id` call site below cannot discriminate it (see that test).
    #[test]
    fn is_empty_recognises_both_sentinels_and_nothing_else() {
        assert!(is_empty(0));
        assert!(is_empty(EMPTY_ID));
        assert!(!is_empty(WAR_ELEMENTAL));
        assert!(!is_empty(DMG_CAP));
    }

    /// Both empty-slot sentinels must be skipped — the plain zero and the
    /// engine's `0x887AE0B0`.
    ///
    /// HONEST LIMITATION: this test does NOT defend the `is_empty` guard on
    /// `sigil_id`. Deleting that guard outright would leave it passing,
    /// because neither sentinel is a key in the table and the `table.get()`
    /// miss skips them anyway — the assertion below pins exactly that, so
    /// the reason this passes is recorded rather than assumed. Should a
    /// future table ever key a sentinel, that assertion fails and this test
    /// becomes genuinely discriminating; until then the teeth for sentinel
    /// handling live in `is_empty_recognises_both_sentinels_and_nothing_else`
    /// and in `empty_second_trait_slots_are_silent_for_both_sentinels`, whose
    /// second-trait call site has no such backstop.
    #[test]
    fn empty_sigil_slots_are_silent_for_both_sentinels() {
        for sentinel in [0_u32, EMPTY_ID] {
            assert!(
                !stock_sigils().contains_key(&sentinel),
                "sentinel {sentinel:08x} is now a real table key — the is_empty guard on \
                 sigil_id has become load-bearing and this test must be made to prove it"
            );
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
        for sentinel in [0_u32, EMPTY_ID] {
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

    /// The raised-ceiling branch audited end to end, not merely loaded.
    ///
    /// Crabs Are Forever+ carries two traits at up to level 45 — the legal
    /// build a flat "two traits cap at 15" rule would falsely accuse. The
    /// raised ceiling is the one branch of the level rule that can
    /// false-accuse, so it is pinned from both sides: legal at the ceiling,
    /// flagged one step above it.
    #[test]
    fn audits_a_two_trait_sigil_whose_ceiling_the_table_raises() {
        assert_eq!(
            stock_sigils()
                .get(&CRABS_ARE_FOREVER_PLUS)
                .expect("the raised-ceiling sigil is in the table")
                .max_level,
            45,
            "this fixture is only meaningful while the table raises this \
             sigil's ceiling above the default"
        );

        let at_ceiling = [sigil(
            CRABS_ARE_FOREVER_PLUS,
            (CRABBY_RESONANCE, 45),
            (CRABMIRATION, 45),
        )];
        assert_eq!(
            audit_sigils(&at_ceiling),
            vec![],
            "accused a legal trait level of 45 on a sigil whose ceiling is 45"
        );

        let above = [sigil(
            CRABS_ARE_FOREVER_PLUS,
            (CRABBY_RESONANCE, 46),
            (CRABMIRATION, 45),
        )];
        let findings = audit_sigils(&above);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, Rule::SigilTraitLevel);
        assert_eq!(findings[0].observed, Value::Level(46));
        assert_eq!(findings[0].allowed, Value::Level(45));
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
