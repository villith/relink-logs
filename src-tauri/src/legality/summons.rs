//! Summon legality: the zero-probability trait check.
//!
//! A summon may only carry a main trait, and an equip bonus, that summons of
//! its NAME can grant. Anything else is an outcome the game's tables price at
//! exactly zero, so it is [`Severity::Impossible`].
//!
//! # Why the checks are per NAME, not per lot
//!
//! The per-id lot bindings in summon.tbl are real but not stable enough to
//! accuse over. Every boss summon exists under TWO ids — a rolled one with the
//! full candidate pool and a "guaranteed" variant whose lots fix one config
//! (first-clear style) — and players verifiably hold the guaranteed id with
//! ROLLED traits (a `90bd4ac0` Lucilius carrying Berserker Echo,
//! user-confirmed legitimate). Judging each id against only its own lots
//! accuses every such owner, so both allowed lists are the union across all
//! ids sharing the summon's (English) display name.
//!
//! The BONUS side used to be looser still — any real bonus id was accepted on
//! any summon — on the strength of production sightings of "Behemoth III with
//! `2ea9ca80`/`9245dfa4`". That relaxation was a mistake worth remembering:
//! those sightings were two modded builds, so the rule had been calibrated on
//! its own quarry and could no longer see it. A 692-log census
//! (`examples/legality_bonus_probe.rs`) found 5 off-lot bonuses in 4526
//! readings — three of them guaranteed-variant boss summons, which the name
//! union covers, and two of them Behemoth III carrying a boss-set id, which it
//! does not. Eleven of the 22 bonus ids are granted by exactly four summons
//! (Rolan, Lucilius, Beelzebub, Lilith) and reach higher magnitudes for the
//! same eleven effects, so one of those elsewhere is genuinely off-table.
//!
//! # The perfect-summon COUNT report (user-requested 2026-07-30)
//!
//! A second rule reports — never accuses — an equipped set carrying
//! [`PERFECT_SUMMON_FLAG_COUNT`] or more "perfect" summons: a ROLLED summon
//! whose main trait and equip bonus both sit at the top of their level
//! windows in the summon's own lots. Only the six endgame boss summons in
//! [`PERFECT_WATCHED_NAMES`] are counted (user-scoped 2026-07-30: nobody
//! farms perfection on anything else, so a maxed common summon is noise, not
//! signal). It is [`Severity::Improbable`] and can never be `Impossible`,
//! because measured production data forbids it:
//!
//! * A single perfect summon is ordinary — 42 of 72 real players in the
//!   production census own at least one (the rarest single config is only
//!   1 in 18,333, and a confirmed-legitimate player owns it). The rule
//!   therefore only speaks at two or more, where 26 of 72 stood at census
//!   time — the user chose to see that list, knowing its size.
//! * Guaranteed-variant summons (`rolled: false`) are excluded: their fixed
//!   config is a probability-1 drop, not a roll.
//! * A bonus from the parallel id set (not in this summon's own lots) does
//!   not count as perfect — its window is unknown, so it cannot be "top".
//! * The reported odds are the product of each counted summon's single-draw
//!   config probability. That is the honest table price of the draws, but it
//!   OVERSTATES rarity for a farmer who rolls hundreds of times and equips
//!   the best — which is exactly why the severity is a suspicion, not proof.
//!
//! # Why levels are deliberately NOT judged
//!
//! Production data shows honest players carrying bonus levels the table
//! prices at zero: an unread sentinel (`4294967295`, i.e. `-1`) and levels
//! below the candidate's window (a level-3 bonus in a 5-9 window) both occur
//! on a confirmed-legitimate build. Whatever those levels mean — partial
//! reads, or an acquisition path the table does not model — judging them
//! accuses honest players, so only trait MEMBERSHIP is checked.

use std::collections::HashMap;

use protocol::EquippedSummon;
use serde::Deserialize;

use super::{is_empty, parse_hex, Finding, Rule, Severity, Subject, Value};

/// One candidate of a summon's main-trait or equip-bonus lot, as generated.
#[derive(Debug, Clone, Deserialize)]
struct RawCandidate {
    /// This candidate's share of its lot's total weight.
    weight: u32,
    /// `(level, weight)` pairs, ascending.
    levels: Vec<(u32, u32)>,
}

/// One row of `summon-legality.json`, as generated. `tier` is deliberately
/// unread: per-tier level windows do not exist (proven by the removed
/// per-tier model), and levels are not judged at all — see the module docs.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawEntry {
    rolled: bool,
    main_traits: HashMap<String, RawCandidate>,
    bonuses: HashMap<String, RawCandidate>,
}

/// One candidate's share of its lot and its level curve.
#[derive(Debug, Clone)]
pub struct Candidate {
    weight: u32,
    levels: Vec<(u32, u32)>,
}

/// One lot: the candidates for a summon's main trait or its equip bonus.
#[derive(Debug, Clone)]
pub struct Lot {
    candidates: HashMap<u32, Candidate>,
}

impl Lot {
    /// The weight the chances table gives `level` on candidate `id`. `None`
    /// when the id is not a candidate of this lot at all; `Some(0)` when it
    /// is, but the level lies outside that candidate's window. Diagnostics
    /// only — no rule judges levels (see the module docs).
    pub fn level_weight(&self, id: u32, level: u32) -> Option<u32> {
        let candidate = self.candidates.get(&id)?;
        Some(
            candidate
                .levels
                .iter()
                .find(|&&(step, _)| step == level)
                .map_or(0, |&(_, weight)| weight),
        )
    }

    /// The top of a candidate's level window: its highest level with a
    /// non-zero weight. `None` when the id is not a candidate, or the
    /// candidate grants no level at all.
    pub fn top_level(&self, id: u32) -> Option<u32> {
        let candidate = self.candidates.get(&id)?;
        candidate
            .levels
            .iter()
            .rev()
            .find(|&&(_, weight)| weight > 0)
            .map(|&(level, _)| level)
    }

    /// Probability of ONE roll of this lot landing exactly `(id, level)`.
    /// `None` when the outcome is off-table or the table degenerates (zero
    /// total weight) — a price it cannot state must not be stated as zero.
    pub fn config_odds(&self, id: u32, level: u32) -> Option<f64> {
        let candidate = self.candidates.get(&id)?;
        let level_weight = candidate
            .levels
            .iter()
            .find(|&&(step, _)| step == level)
            .map(|&(_, weight)| weight)?;
        let lot_total: u64 = self.candidates.values().map(|c| u64::from(c.weight)).sum();
        let level_total: u64 = candidate.levels.iter().map(|&(_, w)| u64::from(w)).sum();
        if lot_total == 0 || level_total == 0 || level_weight == 0 {
            return None;
        }
        Some(
            (f64::from(candidate.weight) / lot_total as f64)
                * (f64::from(level_weight) / level_total as f64),
        )
    }
}

/// The acquisition roll space of one summon.
#[derive(Debug, Clone)]
pub struct SummonEntry {
    /// `false` means the summon fixes BOTH its main trait and its equip
    /// bonus — the lots then hold exactly one candidate each, so the
    /// membership rule covers fixed summons with no special casing.
    pub rolled: bool,
    pub main_traits: Lot,
    pub bonuses: Lot,
}

fn build_lot(raw: HashMap<String, RawCandidate>) -> Lot {
    let candidates: HashMap<u32, Candidate> = raw
        .into_iter()
        .filter_map(|(id, candidate)| {
            Some((
                parse_hex(&id)?,
                Candidate {
                    weight: candidate.weight,
                    levels: candidate.levels,
                },
            ))
        })
        .collect();
    Lot { candidates }
}

/// The baked summon table, keyed by summon id. A row whose id will not parse
/// is dropped: an unreadable row is missing data, and a summon the table does
/// not know is never audited.
pub fn stock_summons() -> &'static HashMap<u32, SummonEntry> {
    static SUMMONS: std::sync::OnceLock<HashMap<u32, SummonEntry>> = std::sync::OnceLock::new();
    SUMMONS.get_or_init(|| {
        let raw: HashMap<String, RawEntry> =
            serde_json::from_str(include_str!("../../assets/summon-legality.json"))
                .expect("summon-legality.json matches the generated shape");

        raw.into_iter()
            .filter_map(|(id, entry)| {
                Some((
                    parse_hex(&id)?,
                    SummonEntry {
                        rolled: entry.rolled,
                        main_traits: build_lot(entry.main_traits),
                        bonuses: build_lot(entry.bonuses),
                    },
                ))
            })
            .collect()
    })
}

/// One row of `lang/en/summons.json`, read only for its display name — the
/// grouping key that joins a boss summon's rolled and guaranteed ids.
#[derive(Debug, Clone, Deserialize)]
struct RawName {
    text: String,
}

/// The summons the perfect-count report watches, by English display name so
/// each boss's rolled AND guaranteed ids are covered (only rolled ones can
/// ever count as perfect — the name is the stable identity across the pair).
const PERFECT_WATCHED_NAMES: [&str; 6] = [
    "Rolan",
    "Lilith",
    "Lucilius",
    "Beelzebub",
    "Vrazarek Firewyrm III",
    "Behemoth III",
];

/// What the membership rules judge against — see the module docs for why
/// these are unions rather than per-id lots.
struct SummonRules {
    /// Allowed main-trait ids per summon id: the union over every summon id
    /// sharing this one's English display name (ids the lang file does not
    /// name fall back to their own pool).
    allowed_mains: HashMap<u32, Vec<u32>>,
    /// Allowed equip-bonus ids per summon id, unioned over the same name group
    /// and for the same reason: a guaranteed variant's own lot fixes one
    /// config, but players legitimately hold it carrying its rolled sibling's
    /// bonuses.
    allowed_bonuses: HashMap<u32, Vec<u32>>,
    /// Every summon id sharing this one's display name, itself included. The
    /// magnitude ceiling is taken across the whole group, so it agrees with
    /// the union above rather than judging against a narrower window.
    name_group: HashMap<u32, Vec<u32>>,
    /// Summon ids whose display name is on [`PERFECT_WATCHED_NAMES`].
    perfect_watched: std::collections::HashSet<u32>,
}

fn summon_rules() -> &'static SummonRules {
    static RULES: std::sync::OnceLock<SummonRules> = std::sync::OnceLock::new();
    RULES.get_or_init(|| {
        let names: HashMap<String, RawName> =
            serde_json::from_str(include_str!("../../lang/en/summons.json"))
                .expect("summons.json matches the lang shape");

        // Group summon ids by display name; an unnamed id groups alone under
        // its own hex spelling, so it still gets exactly its own pool.
        let mut groups: HashMap<String, Vec<u32>> = HashMap::new();
        for &id in stock_summons().keys() {
            let key = format!("{id:08x}");
            let name = names.get(&key).map_or(key, |raw| raw.text.clone());
            groups.entry(name).or_default().push(id);
        }

        let mut allowed_mains = HashMap::new();
        for ids in groups.values() {
            let mut union: Vec<u32> = ids
                .iter()
                .flat_map(|id| stock_summons()[id].main_traits.candidates.keys().copied())
                .collect();
            union.sort_unstable();
            union.dedup();
            for &id in ids {
                allowed_mains.insert(id, union.clone());
            }
        }

        let mut allowed_bonuses = HashMap::new();
        let mut name_group = HashMap::new();
        for ids in groups.values() {
            let mut union: Vec<u32> = ids
                .iter()
                .flat_map(|id| stock_summons()[id].bonuses.candidates.keys().copied())
                .collect();
            union.sort_unstable();
            union.dedup();
            for &id in ids {
                allowed_bonuses.insert(id, union.clone());
                name_group.insert(id, ids.clone());
            }
        }

        let perfect_watched = groups
            .iter()
            .filter(|(name, _)| PERFECT_WATCHED_NAMES.contains(&name.as_str()))
            .flat_map(|(_, ids)| ids.iter().copied())
            .collect();

        SummonRules {
            allowed_mains,
            allowed_bonuses,
            name_group,
            perfect_watched,
        }
    })
}

/// How many perfect summons an equipped set must carry before the count is
/// reported. One is ordinary (42 of 72 census players own one); the user set
/// the reporting threshold at two.
pub const PERFECT_SUMMON_FLAG_COUNT: usize = 2;

/// The single-draw price of this summon's exact config, or `None` when the
/// summon does not count as "perfect": a guaranteed variant (its fixed config
/// is a probability-1 drop, not a roll), a slot below the top of its window,
/// or a trait/bonus outside the summon's own lots (its window is unknown).
fn perfect_config_odds(entry: &SummonEntry, summon: &EquippedSummon) -> Option<f64> {
    if !entry.rolled {
        return None;
    }
    if entry.main_traits.top_level(summon.main_trait_id)? != summon.main_trait_level {
        return None;
    }
    if entry.bonuses.top_level(summon.bonus_id)? != summon.bonus_level {
        return None;
    }
    let main = entry
        .main_traits
        .config_odds(summon.main_trait_id, summon.main_trait_level)?;
    let bonus = entry
        .bonuses
        .config_odds(summon.bonus_id, summon.bonus_level)?;
    Some(main * bonus)
}

/// The zero-probability trait check, plus the perfect-count report. Unknown
/// summon ids and empty trait slots are missing data and stay silent; levels
/// are never judged for legality (the count report reads them, but a level it
/// cannot price simply doesn't count as perfect).
pub fn audit_summons(summons: &[EquippedSummon]) -> Vec<Finding> {
    let rules = summon_rules();
    let mut findings = Vec::new();

    for (index, summon) in summons.iter().enumerate() {
        // Allowed mains exist exactly for the table's ids, so this lookup is
        // also the unknown-summon guard.
        let Some(allowed_mains) = rules.allowed_mains.get(&summon.summon_id) else {
            continue;
        };

        // Both allowed lists are built sorted and deduped, so both lookups
        // are binary searches.
        if !is_empty(summon.main_trait_id)
            && allowed_mains.binary_search(&summon.main_trait_id).is_err()
        {
            findings.push(Finding {
                rule: Rule::SummonTrait,
                severity: Severity::Impossible,
                subject: Subject::Summon(index),
                observed: Value::TraitId(summon.main_trait_id),
                allowed: Value::TraitIds(allowed_mains.clone()),
                odds: None,
            });
        }

        // Built alongside `allowed_mains` from the same groups, so the lookup
        // above has already proven this one resolves.
        let allowed_bonuses = &rules.allowed_bonuses[&summon.summon_id];

        if !is_empty(summon.bonus_id) && allowed_bonuses.binary_search(&summon.bonus_id).is_err() {
            findings.push(Finding {
                rule: Rule::SummonBonusSource,
                severity: Severity::Impossible,
                subject: Subject::Summon(index),
                observed: Value::SummonBonusId(summon.bonus_id),
                allowed: Value::SummonBonusIds(allowed_bonuses.clone()),
                odds: None,
            });
        }
    }

    // The perfect-count report (see the module docs). Only the watched boss
    // summons are counted; the odds multiply the counted summons' single-draw
    // prices — the honest table price of the draws, knowingly blind to
    // farming, which is why this is Improbable.
    let perfect: Vec<f64> = summons
        .iter()
        .filter(|summon| rules.perfect_watched.contains(&summon.summon_id))
        .filter_map(|summon| {
            stock_summons()
                .get(&summon.summon_id)
                .and_then(|entry| perfect_config_odds(entry, summon))
        })
        .collect();

    if perfect.len() >= PERFECT_SUMMON_FLAG_COUNT {
        findings.push(Finding {
            rule: Rule::SummonPerfectCount,
            severity: Severity::Improbable,
            subject: Subject::Summons,
            observed: Value::Count(perfect.len()),
            // Nothing is exceeded: the set is legal, merely improbable, so
            // `odds` is the payload (the `OvermasteryAllMaxed` idiom).
            allowed: Value::None,
            odds: Some(perfect.iter().product()),
        });
    }

    findings
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::legality::EMPTY_ID;
    use crate::legality::{Rule, Severity, Subject, Value};

    /// Wheel of Fate III: tier 3, rolled.
    const WHEEL_OF_FATE_III: u32 = 0x47e2_ae71;
    /// One of its main candidates.
    const SUPPLEMENTARY_DMG: u32 = 0x57ab_5b10;
    /// One of its bonus candidates.
    const CRIT_RATE_UP: u32 = 0x00d1_71e0;

    /// Vrazarek Firewyrm III: `rolled: false`. It guarantees DMG Cap with
    /// bonus `bc4e92cb` — its lots hold exactly one candidate each.
    const VRAZAREK_III: u32 = 0x9f0e_cf8b;
    const DMG_CAP: u32 = 0xdc58_4f60;
    const VRAZAREK_BONUS: u32 = 0xbc4e_92cb;

    /// A real trait no Wheel of Fate III lot lists (it is Vrazarek's bonus).
    const NOT_A_WHEEL_TRAIT: u32 = 0xbc4e_92cb;

    /// Goldslime III: rolled, main window 11-15, bonus window 6-9. NOT on
    /// the perfect watch list.
    const GOLDSLIME_III: u32 = 0x439c_db88;
    const GOLDSLIME_MAIN: u32 = 0x5e42_2ae5;
    const GOLDSLIME_BONUS: u32 = 0xa353_9fbb;

    /// Two perfect-watch bosses (rolled ids) with real candidates of their
    /// own lots: Alpha 11-15 / NA DMG Cap 5-9 on Lucilius, Uplift 11-15 /
    /// Healing Cap 6-9 on Behemoth III.
    const LUCILIUS_ROLLED: u32 = 0x6e59_68fc;
    const ALPHA: u32 = 0xdbe1_d775;
    const LUCILIUS_NA_DMG_CAP: u32 = 0x9245_dfa4;
    const BEHEMOTH_III_ROLLED: u32 = 0xe4b7_dcf9;
    const UPLIFT: u32 = 0xb5ff_9fd3;
    const BEHEMOTH_BONUS: u32 = 0xa353_9fbb;

    /// Two of the eleven boss-only equip bonuses, granted by Rolan, Lucilius,
    /// Beelzebub and Lilith alone. `2ea9ca80` reaches Healing Cap Up +75%
    /// where the standard set stops at +50%; `9245dfa4` reaches Normal Attack
    /// DMG Cap Up +100% but displays a perfectly ordinary +50% at level 6.
    const BOSS_SET_HEALING_CAP: u32 = 0x2ea9_ca80;
    const BOSS_SET_NA_DMG_CAP: u32 = 0x9245_dfa4;

    fn summon(summon_id: u32, main: (u32, u32), bonus: (u32, u32)) -> EquippedSummon {
        EquippedSummon {
            summon_id,
            main_trait_id: main.0,
            main_trait_level: main.1,
            bonus_id: bonus.0,
            bonus_level: bonus.1,
        }
    }

    /// The table itself, pinned so a regeneration that lost rows or collapsed
    /// the rolled/fixed split cannot silently disable the rule.
    #[test]
    fn the_table_loads_every_summon_and_keeps_the_rolled_split() {
        let table = stock_summons();
        assert_eq!(table.len(), 189);
        let rolled = table.values().filter(|entry| entry.rolled).count();
        assert_eq!((rolled, table.len() - rolled), (152, 37));
    }

    #[test]
    fn a_legal_roll_is_silent() {
        let equipped = [summon(
            WHEEL_OF_FATE_III,
            (SUPPLEMENTARY_DMG, 13),
            (CRIT_RATE_UP, 7),
        )];
        assert_eq!(audit_summons(&equipped), vec![]);
    }

    /// The rule itself, on both sides of the summon. `NOT_A_WHEEL_TRAIT` is a
    /// bonus id — bonus and trait ids are disjoint in the tables, so it can
    /// never be in any name-union of mains; a trait id in the bonus slot is
    /// the mirror case.
    #[test]
    fn a_trait_outside_every_pool_is_impossible() {
        let bad_main = [summon(
            WHEEL_OF_FATE_III,
            (NOT_A_WHEEL_TRAIT, 13),
            (CRIT_RATE_UP, 7),
        )];
        let findings = audit_summons(&bad_main);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, Rule::SummonTrait);
        assert_eq!(findings[0].severity, Severity::Impossible);
        assert_eq!(findings[0].subject, Subject::Summon(0));
        assert_eq!(findings[0].observed, Value::TraitId(NOT_A_WHEEL_TRAIT));
        let Value::TraitIds(allowed) = &findings[0].allowed else {
            panic!("allowed should list the name-union of main candidates");
        };
        assert!(allowed.contains(&SUPPLEMENTARY_DMG));

        let bad_bonus = [summon(
            WHEEL_OF_FATE_III,
            (SUPPLEMENTARY_DMG, 13),
            (SUPPLEMENTARY_DMG, 7),
        )];
        let findings = audit_summons(&bad_bonus);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, Rule::SummonBonusSource);
        assert_eq!(
            findings[0].observed,
            Value::SummonBonusId(SUPPLEMENTARY_DMG)
        );
        let Value::SummonBonusIds(allowed) = &findings[0].allowed else {
            panic!("allowed should list this summon's own bonus candidates");
        };
        assert!(allowed.contains(&CRIT_RATE_UP) && allowed.contains(&VRAZAREK_BONUS));
    }

    /// A guaranteed-variant summon still cannot carry a main trait no summon
    /// of its name rolls. Supplementary DMG is a real, common main elsewhere
    /// but on no Vrazarek Firewyrm III — pinned as a precondition so this
    /// test dies loudly if a table regeneration changes that.
    #[test]
    fn a_fixed_summon_is_still_bounded_by_its_name_union() {
        let legal = [summon(VRAZAREK_III, (DMG_CAP, 15), (VRAZAREK_BONUS, 4))];
        assert_eq!(audit_summons(&legal), vec![]);

        let modded = [summon(
            VRAZAREK_III,
            (SUPPLEMENTARY_DMG, 15),
            (VRAZAREK_BONUS, 4),
        )];
        let findings = audit_summons(&modded);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, Rule::SummonTrait);
        assert_eq!(findings[0].observed, Value::TraitId(SUPPLEMENTARY_DMG));
        let Value::TraitIds(allowed) = &findings[0].allowed else {
            panic!("allowed should list the name-union of main candidates");
        };
        assert!(allowed.contains(&DMG_CAP));
    }

    /// THE PRODUCTION REGRESSION (user-confirmed false positive): the
    /// guaranteed Lucilius id `90bd4ac0` fixes Gamma in its own lots, but
    /// players legitimately hold it with the ROLLED pool's traits — Berserker
    /// Echo among them. The allowed mains are the union across every id
    /// named "Lucilius", so this must be silent.
    #[test]
    fn a_guaranteed_variant_inherits_its_rolled_siblings_pool() {
        const LUCILIUS_GUARANTEED: u32 = 0x90bd_4ac0;
        const BERSERKER_ECHO: u32 = 0xee85_cd1f;
        const LUCILIUS_SET_SKILL_CAP: u32 = 0xce70_c58a;
        let equipped = [summon(
            LUCILIUS_GUARANTEED,
            (BERSERKER_ECHO, 15),
            (LUCILIUS_SET_SKILL_CAP, 7),
        )];
        assert_eq!(
            audit_summons(&equipped),
            vec![],
            "a legitimate Lucilius with Berserker Echo was accused"
        );
    }

    /// THE PRODUCTION CASE (Kahs, log 549): a Behemoth III carrying a
    /// boss-set bonus. Only Rolan, Lucilius, Beelzebub and Lilith grant those
    /// eleven ids, so no Behemoth III can hold one — however ordinary its
    /// magnitude looks. This one displays +50%, which Behemoth III's own
    /// Normal Attack DMG Cap Up does reach, so ONLY the source rule may speak.
    #[test]
    fn a_bonus_no_summon_of_this_name_grants_is_impossible() {
        let equipped = [summon(
            BEHEMOTH_III_ROLLED,
            (UPLIFT, 15),
            (BOSS_SET_NA_DMG_CAP, 6),
        )];
        let findings = audit_summons(&equipped);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, Rule::SummonBonusSource);
        assert_eq!(findings[0].severity, Severity::Impossible);
        assert_eq!(findings[0].subject, Subject::Summon(0));
        assert_eq!(
            findings[0].observed,
            Value::SummonBonusId(BOSS_SET_NA_DMG_CAP)
        );
        let Value::SummonBonusIds(allowed) = &findings[0].allowed else {
            panic!("allowed should list this summon's own bonus candidates");
        };
        assert!(
            allowed.contains(&BEHEMOTH_BONUS) && !allowed.contains(&BOSS_SET_NA_DMG_CAP),
            "allowed should be this summon's name-union, not every bonus id in the game"
        );
    }

    /// THE FALSE-ACCUSATION GUARD (Dai Weaboo, log 549) — the legitimate half
    /// of the evidence that used to justify accepting any bonus anywhere.
    ///
    /// A guaranteed-variant boss summon's own lot fixes ONE config, but
    /// players verifiably hold it carrying its ROLLED sibling's traits and
    /// bonuses (the same user-confirmed phenomenon `allowed_mains` exists
    /// for). The bonus union is per NAME for exactly that reason, so all three
    /// of this player's guaranteed bosses must be silent.
    #[test]
    fn a_guaranteed_variant_inherits_its_rolled_siblings_bonus_pool() {
        const LUCILIUS_GUARANTEED: u32 = 0x90bd_4ac0;
        const BEELZEBUB_GUARANTEED: u32 = 0x2f15_455c;
        const LILITH_GUARANTEED: u32 = 0x855d_018c;
        const BERSERKER_ECHO: u32 = 0xee85_cd1f;
        const SUPPLEMENTARY_DMG_MAIN: u32 = 0x3d81_53a1;
        const LUCILIUS_SKILL_DMG_CAP: u32 = 0xce70_c58a;

        let equipped = [
            summon(
                LUCILIUS_GUARANTEED,
                (BERSERKER_ECHO, 15),
                (LUCILIUS_SKILL_DMG_CAP, 9),
            ),
            summon(
                BEELZEBUB_GUARANTEED,
                (SUPPLEMENTARY_DMG_MAIN, 15),
                (BOSS_SET_NA_DMG_CAP, 9),
            ),
            summon(
                LILITH_GUARANTEED,
                (0x4c58_8c27, 15),
                (BOSS_SET_NA_DMG_CAP, 9),
            ),
        ];
        assert_eq!(
            audit_summons(&equipped),
            vec![],
            "a legitimate guaranteed-variant boss summon was accused over its bonus"
        );
    }

    /// THE PRODUCTION REGRESSION GUARD: levels are never judged, however
    /// impossible the chances table prices them. Confirmed-legitimate builds
    /// carry an unread sentinel level (`-1` as u32) and levels below the
    /// candidate's window; flagging any of these accuses honest players.
    #[test]
    fn levels_are_never_judged_even_when_the_table_prices_them_at_zero() {
        for level in [0, 3, 99, u32::MAX] {
            let equipped = [summon(
                WHEEL_OF_FATE_III,
                (SUPPLEMENTARY_DMG, level),
                (CRIT_RATE_UP, level),
            )];
            assert_eq!(
                audit_summons(&equipped),
                vec![],
                "a summon was accused over its level {level}"
            );
        }
    }

    /// ONE top-of-window ("perfect") roll is LEGAL and must be silent even on
    /// a watched boss — 42 of 72 census players own a perfect summon; the
    /// count report starts at two.
    #[test]
    fn a_single_perfect_roll_is_not_a_finding() {
        let equipped = [summon(
            LUCILIUS_ROLLED,
            (ALPHA, 15),
            (LUCILIUS_NA_DMG_CAP, 9),
        )];
        assert_eq!(audit_summons(&equipped), vec![]);
    }

    /// The user-requested report: two perfect watched bosses together are
    /// worth a row. Improbable with the multiplied single-draw price — never
    /// proof.
    #[test]
    fn two_perfect_watched_summons_are_reported_as_improbable() {
        let equipped = [
            summon(LUCILIUS_ROLLED, (ALPHA, 15), (LUCILIUS_NA_DMG_CAP, 9)),
            summon(BEHEMOTH_III_ROLLED, (UPLIFT, 15), (BEHEMOTH_BONUS, 9)),
        ];
        let findings = audit_summons(&equipped);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, Rule::SummonPerfectCount);
        assert_eq!(findings[0].severity, Severity::Improbable);
        assert_eq!(findings[0].subject, Subject::Summons);
        assert_eq!(findings[0].observed, Value::Count(2));
        assert_eq!(findings[0].allowed, Value::None);
        let odds = findings[0].odds.expect("the odds are the payload");
        assert!(
            odds > 0.0 && odds < 1e-4,
            "odds {odds} should be tiny but non-zero"
        );
    }

    /// THE SCOPE (user, 2026-07-30): nobody farms perfection outside the six
    /// watched bosses, so a pair of maxed common summons — which fired before
    /// the scoping — is noise and must be silent.
    #[test]
    fn perfect_summons_outside_the_watch_list_are_never_reported() {
        let equipped = [
            summon(
                WHEEL_OF_FATE_III,
                (SUPPLEMENTARY_DMG, 15),
                (CRIT_RATE_UP, 9),
            ),
            summon(GOLDSLIME_III, (GOLDSLIME_MAIN, 15), (GOLDSLIME_BONUS, 9)),
        ];
        assert_eq!(audit_summons(&equipped), vec![]);
    }

    /// THE LANG-DRIFT GUARD for the mains union.
    ///
    /// `allowed_mains` is joined on the ENGLISH display name read out of
    /// `lang/en/summons.json` — an autogenerated file that a game update
    /// overwrites (see CLAUDE.md). If a regeneration re-spells or re-splits a
    /// boss name, the join quietly falls back to per-id lots and the union
    /// narrows to exactly the false-accusation mode it exists to prevent.
    /// Nothing else would fail: the table-shape tests count rows, and the
    /// behavioural test below covers only Lucilius.
    ///
    /// So pin the join itself — each boss's rolled and guaranteed ids must
    /// still resolve to ONE shared pool, and that pool must be strictly larger
    /// than the guaranteed id's own single-config lot (which is what proves a
    /// join happened rather than each id standing alone).
    #[test]
    fn the_name_join_still_unions_each_boss_pair() {
        const PAIRS: [(u32, u32); 2] = [
            (LUCILIUS_ROLLED, 0x90bd_4ac0),
            (BEHEMOTH_III_ROLLED, 0x239f_769f),
        ];
        let rules = summon_rules();
        for (rolled, guaranteed) in PAIRS {
            let rolled_mains = rules
                .allowed_mains
                .get(&rolled)
                .unwrap_or_else(|| panic!("rolled id {rolled:08x} is not in the table"));
            let guaranteed_mains = rules
                .allowed_mains
                .get(&guaranteed)
                .unwrap_or_else(|| panic!("guaranteed id {guaranteed:08x} is not in the table"));
            assert_eq!(
                rolled_mains, guaranteed_mains,
                "{rolled:08x} and {guaranteed:08x} no longer share a mains union — the \
                 lang name join broke, and every owner of the guaranteed id with rolled \
                 traits is now falsely accused"
            );
            let own_lot = stock_summons()[&guaranteed].main_traits.candidates.len();
            assert!(
                guaranteed_mains.len() > own_lot,
                "{guaranteed:08x}'s union ({}) is no larger than its own lot ({own_lot}) — \
                 the name join silently did nothing",
                guaranteed_mains.len()
            );
        }
    }

    /// The watch list must resolve against the real tables: each of the six
    /// names owns a rolled and a guaranteed id, so a lang regeneration that
    /// loses the names would silently disable the report — pin the size and
    /// the two ids the tests roll with.
    #[test]
    fn the_watch_list_resolves_to_all_six_bosses() {
        let watched = &summon_rules().perfect_watched;
        assert_eq!(watched.len(), PERFECT_WATCHED_NAMES.len() * 2);
        assert!(watched.contains(&LUCILIUS_ROLLED));
        assert!(watched.contains(&BEHEMOTH_III_ROLLED));
        assert!(watched.contains(&VRAZAREK_III));
    }

    /// A guaranteed-variant summon at its fixed config is a probability-1
    /// drop, not a roll — it must never count toward the perfect total, even
    /// though Vrazarek Firewyrm III is on the watch list.
    #[test]
    fn a_guaranteed_summons_fixed_config_is_not_perfect() {
        let equipped = [
            summon(VRAZAREK_III, (DMG_CAP, 15), (VRAZAREK_BONUS, 4)),
            summon(LUCILIUS_ROLLED, (ALPHA, 15), (LUCILIUS_NA_DMG_CAP, 9)),
        ];
        assert_eq!(
            audit_summons(&equipped),
            vec![],
            "a guaranteed drop was counted as a perfect roll"
        );
    }

    /// One slot below its window top means the summon is not perfect, on
    /// either side.
    #[test]
    fn a_slot_below_its_window_top_is_not_perfect() {
        for (main_level, bonus_level) in [(14, 9), (15, 8)] {
            let equipped = [
                summon(
                    LUCILIUS_ROLLED,
                    (ALPHA, main_level),
                    (LUCILIUS_NA_DMG_CAP, bonus_level),
                ),
                summon(BEHEMOTH_III_ROLLED, (UPLIFT, 15), (BEHEMOTH_BONUS, 9)),
            ];
            assert_eq!(
                audit_summons(&equipped),
                vec![],
                "levels {main_level}/{bonus_level} were counted as perfect"
            );
        }
    }

    /// An off-lot bonus has no window in this summon's own lots, so its "top"
    /// is unknowable and the summon cannot be counted perfect — even on a
    /// watched boss, next to a genuinely perfect one.
    ///
    /// The counting guard and the source rule are different claims and both
    /// must hold: the bonus is accused (it is off-table), and the perfect
    /// COUNT stays at one so the improbability report keeps quiet. Accusing
    /// and counting are separate because a modded summon must not be able to
    /// inflate a probability the report then prices as if it were rolled.
    #[test]
    fn an_off_lot_bonus_never_counts_toward_the_perfect_total() {
        let equipped = [
            summon(BEHEMOTH_III_ROLLED, (UPLIFT, 15), (BOSS_SET_HEALING_CAP, 9)),
            summon(LUCILIUS_ROLLED, (ALPHA, 15), (LUCILIUS_NA_DMG_CAP, 9)),
        ];
        let findings = audit_summons(&equipped);
        assert!(
            !findings
                .iter()
                .any(|finding| finding.rule == Rule::SummonPerfectCount),
            "an off-lot bonus was counted as a perfect roll"
        );
        assert!(
            findings
                .iter()
                .any(|finding| finding.rule == Rule::SummonBonusSource),
            "the off-lot bonus itself should still be accused"
        );
    }

    #[test]
    fn empty_summon_list_is_silent() {
        assert_eq!(audit_summons(&[]), vec![]);
    }

    /// A summon the table does not know says nothing about legality. An
    /// empty slot (id 0) is the same case.
    #[test]
    fn unknown_summon_id_is_silent() {
        for id in [0xdead_beef_u32, 0] {
            assert!(
                !stock_summons().contains_key(&id),
                "{id:08x} is a table key"
            );
            let equipped = [summon(id, (0xdead_beef, 15), (0xdead_beef, 9))];
            assert_eq!(audit_summons(&equipped), vec![], "audited summon {id:08x}");
        }
    }

    /// An empty trait slot is missing data under either sentinel, not a
    /// trait the lot cannot grant.
    #[test]
    fn empty_trait_slots_are_silent_for_both_sentinels() {
        for sentinel in [0_u32, EMPTY_ID] {
            let equipped = [summon(WHEEL_OF_FATE_III, (sentinel, 13), (sentinel, 7))];
            assert_eq!(
                audit_summons(&equipped),
                vec![],
                "empty trait sentinel {sentinel:08x} was audited"
            );
        }
    }

    /// `level_weight`, the diagnostic primitive: `None` off-lot, `Some(0)`
    /// off-window, the real weight in-window.
    #[test]
    fn level_weight_distinguishes_off_lot_from_off_window() {
        let entry = &stock_summons()[&WHEEL_OF_FATE_III];
        assert_eq!(entry.main_traits.level_weight(NOT_A_WHEEL_TRAIT, 15), None);
        assert_eq!(
            entry.main_traits.level_weight(SUPPLEMENTARY_DMG, u32::MAX),
            Some(0)
        );
        let in_window = entry
            .main_traits
            .level_weight(SUPPLEMENTARY_DMG, 15)
            .expect("supplementary dmg is a wheel candidate");
        assert!(in_window > 0);
    }
}
