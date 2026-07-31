//! Summon legality: the zero-probability trait check.
//!
//! A summon may only carry a main trait, and an equip bonus, that summons of
//! its NAME can grant. Anything else is an outcome the game's tables price at
//! exactly zero — the game could not have produced it.
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
//! signal). It is a REPORT of long odds and can never be proof, because
//! measured production data forbids it:
//!
//! * A single perfect summon is ordinary — 42 of 72 real players in the
//!   production census own at least one (the rarest single config is only
//!   1 in 18,333, and a confirmed-legitimate player owns it). The rule
//!   therefore only speaks at two or more, where 26 of 72 stood at census
//!   time — the user chose to see that list, knowing its size.
//! * Guaranteed-variant summons (`rolled: false`) are excluded: their fixed
//!   config is a probability-1 drop, not a roll.
//! * A bonus outside this summon's own lots does not count as perfect — its
//!   window is unknown, so it cannot be "top". That keeps a modded summon
//!   from inflating a probability the report would then price as if it had
//!   been rolled.
//! * The reported odds are the product of each counted summon's single-draw
//!   config probability. That is the honest table price of the draws, but it
//!   OVERSTATES rarity for a farmer who rolls hundreds of times and equips
//!   the best — which is exactly why this rule reports rather than accuses.
//!   The odds the UI prints beside it are what carries that distinction to a
//!   reader now that findings no longer carry a severity.
//!
//! # Why levels are deliberately NOT judged, but magnitudes are
//!
//! Production data shows honest players carrying bonus levels the table
//! prices at zero: an unread sentinel (`4294967295`, i.e. `-1`) and levels
//! below the candidate's window (a level-3 bonus in a 5-9 window) both occur
//! on a confirmed-legitimate build. Whatever those levels mean — partial
//! reads, or an acquisition path the table does not model — judging them
//! accuses honest players, so no rule here judges a level.
//!
//! [`Rule::SummonBonusMagnitude`] judges the NUMBER the bonus displays, which
//! is a different claim and safe where the level one is not. The census
//! settles it: every above-window level in 692 logs is the unread sentinel,
//! and a sentinel indexes off the end of the value list, so it displays
//! nothing and the rule never sees it. Below-window levels display SMALLER
//! numbers, which no ceiling can be exceeded by. What remains is a magnitude
//! the summon has no way to produce.

use std::collections::HashMap;

use protocol::EquippedSummon;
use serde::Deserialize;

use super::{
    chased_effects, is_empty, parse_hex, summon_bonus_values, Finding, Rule, Subject, Value,
};

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

    /// The top of a candidate's level window, but only where landing on it was
    /// a ROLL. `None` when the candidate's window holds a single level: the top
    /// is then also the floor, and it lands there with certainty.
    ///
    /// Every rolled watched boss offers five ordinary main traits on an 11-15
    /// curve plus one "special" on a singleton curve at level 15 — War
    /// Elemental (Rolan, Lilith), Berserker Echo (Lucilius), Spartan Echo
    /// (Beelzebub), Stout Heart (Behemoth III, Vrazarek). A special is at the
    /// top of its window the instant it drops, so counting it as a perfect roll
    /// prices certainty as luck.
    ///
    /// Distinct from [`Lot::top_level`], which the magnitude ceiling still
    /// wants: a ceiling is about what a summon CAN display, and a fixed-level
    /// candidate displays its magnitude just as surely as a rolled one.
    pub fn rolled_top_level(&self, id: u32) -> Option<u32> {
        let candidate = self.candidates.get(&id)?;
        let mut live = candidate
            .levels
            .iter()
            .filter(|&&(_, weight)| weight > 0)
            .map(|&(level, _)| level);
        // Levels are ascending, so the last live one is the top — and reaching
        // `last` at all proves a second level existed to have rolled instead.
        live.next()?;
        live.last()
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
    /// Which summons grant each equip-bonus id: one representative id per
    /// display NAME, ascending. Empty for a bonus too widely granted to name
    /// (see [`MAX_NAMED_OWNERS`]) and absent for an id no summon grants at all.
    ///
    /// This is what a bonus-source finding quotes. The claim is about an id, and
    /// ids are invisible on a gear line — two of them share every effect's
    /// display name — so the only way to make the claim checkable is to supply
    /// the fact the line cannot show.
    bonus_owners: HashMap<u32, Vec<u32>>,
}

/// Above this many names the phrase stops being a phrase. The tables leave a
/// wide margin: the only ids the rule can realistically fire on are the boss
/// set's eleven, granted by four summons, while a standard-set id is granted by
/// most of the roster — so nothing lands near this number.
const MAX_NAMED_OWNERS: usize = 6;

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

        // Inverted from the same name-unioned lists the rule accuses with, so
        // the two can never disagree: a bonus is "from" exactly the names whose
        // union would have accepted it. The lowest id represents its group —
        // any member translates to the same display name, and picking one
        // deterministically keeps the phrase stable between runs.
        let mut bonus_owners: HashMap<u32, Vec<u32>> = HashMap::new();
        for ids in groups.values() {
            let Some(&representative) = ids.iter().min() else {
                continue;
            };
            for &bonus in &allowed_bonuses[&representative] {
                bonus_owners.entry(bonus).or_default().push(representative);
            }
        }
        for owners in bonus_owners.values_mut() {
            owners.sort_unstable();
            if owners.len() > MAX_NAMED_OWNERS {
                owners.clear();
            }
        }

        SummonRules {
            allowed_mains,
            allowed_bonuses,
            name_group,
            perfect_watched,
            bonus_owners,
        }
    })
}

/// How many perfect summons an equipped set must carry before the count is
/// reported. One is ordinary (42 of 72 census players own one); the user set
/// the reporting threshold at two.
pub const PERFECT_SUMMON_FLAG_COUNT: usize = 2;

/// The single-draw price of this summon's exact config, or `None` when the
/// summon does not count as "perfect": a guaranteed variant (its fixed config
/// is a probability-1 drop, not a roll), a bonus granting an effect nobody
/// farms for, a slot below the top of its window, a slot whose window holds
/// only one level, or a trait/bonus outside the summon's own lots (its window
/// is unknown).
fn perfect_config_odds(entry: &SummonEntry, summon: &EquippedSummon) -> Option<f64> {
    if !entry.rolled {
        return None;
    }
    // Perfection is only interesting about a stat a player would reroll for
    // (see `chased_effects`) — a maxed Healing Cap Up is a coincidence, not a
    // farm. The main trait is scoped by its window instead: its namespace has
    // no notion of these effects, and `rolled_top_level` below is what keeps
    // the certainty-shaped mains out.
    if !summon_bonus_values::effect_of(summon.bonus_id).is_some_and(chased_effects::is_chased) {
        return None;
    }
    if entry.main_traits.rolled_top_level(summon.main_trait_id)? != summon.main_trait_level {
        return None;
    }
    if entry.bonuses.rolled_top_level(summon.bonus_id)? != summon.bonus_level {
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

/// The highest magnitude any bonus of `effect` can display on a summon of this
/// name, each candidate taken at the top of its own level window.
///
/// `None` when the name group grants no bonus of that effect at all — a
/// ceiling that cannot be stated must not be stated, and [`Rule::SummonBonusSource`]
/// already owns the case where the id itself is wrong.
///
/// The window top is taken across the whole `group` rather than the one summon
/// id, so the ceiling agrees with the allowed-id union: a guaranteed variant
/// holding its rolled sibling's bonus is measured against the sibling's window,
/// which is the window that bonus was actually rolled in.
fn effect_ceiling(group: &[u32], allowed: &[u32], effect: &str) -> Option<f64> {
    allowed
        .iter()
        .filter(|id| summon_bonus_values::effect_of(**id) == Some(effect))
        .filter_map(|id| {
            let top = group
                .iter()
                .filter_map(|summon_id| stock_summons().get(summon_id))
                .filter_map(|entry| entry.bonuses.top_level(*id))
                .max()?;
            summon_bonus_values::magnitude(*id, top)
        })
        .fold(None, |best: Option<f64>, value| {
            Some(best.map_or(value, |best: f64| best.max(value)))
        })
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
                subject: Subject::Summon(index),
                observed: Value::TraitId(summon.main_trait_id),
                allowed: Value::TraitIds(allowed_mains.clone()),
                odds: None,
                evidence: None,
            });
        }

        // Built alongside `allowed_mains` from the same groups, so the lookup
        // above has already proven this one resolves.
        let allowed_bonuses = &rules.allowed_bonuses[&summon.summon_id];

        if !is_empty(summon.bonus_id) && allowed_bonuses.binary_search(&summon.bonus_id).is_err() {
            findings.push(Finding {
                rule: Rule::SummonBonusSource,
                subject: Subject::Summon(index),
                observed: Value::SummonBonusId(summon.bonus_id),
                // WHOSE bonus it is, not what this summon may hold. The line a
                // reader sees shows only the effect's display name, which two
                // ids share — so "not from this summon" contradicted a line
                // reading "Healing Cap Up" on a summon that grants one. Naming
                // the owners is the only form of this claim the reader can check.
                allowed: Value::SummonIds(
                    rules
                        .bonus_owners
                        .get(&summon.bonus_id)
                        .cloned()
                        .unwrap_or_default(),
                ),
                odds: None,
                evidence: None,
            });
        }

        // The magnitude the bonus displays, against the most this summon could
        // ever show for that effect. Both halves are `Option` on purpose: an
        // unread level prices nothing, and an effect the summon never grants
        // has no ceiling — either way there is no claim to make.
        if let (Some(effect), Some(observed)) = (
            summon_bonus_values::effect_of(summon.bonus_id),
            summon_bonus_values::magnitude(summon.bonus_id, summon.bonus_level),
        ) {
            let group = &rules.name_group[&summon.summon_id];
            if let Some(ceiling) = effect_ceiling(group, allowed_bonuses, effect) {
                if observed > ceiling {
                    findings.push(Finding {
                        rule: Rule::SummonBonusMagnitude,
                        subject: Subject::Summon(index),
                        observed: Value::Amount(observed as f32),
                        allowed: Value::Amount(ceiling as f32),
                        odds: None,
                        evidence: None,
                    });
                }
            }
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
            subject: Subject::Summons,
            observed: Value::Count(perfect.len()),
            // Nothing is exceeded: the set is legal, merely improbable, so
            // `odds` is the payload (the `OvermasteryAllMaxed` idiom).
            allowed: Value::None,
            odds: Some(perfect.iter().product()),
            evidence: None,
        });
    }

    findings
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::legality::EMPTY_ID;
    use crate::legality::{Rule, Subject, Value};

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

    /// Lucilius' single-level main candidate: level 15 at pick weight 800,
    /// where its five siblings run 11-15. Its Behemoth III counterpart is
    /// Stout Heart; the shape is the same on all six watched bosses.
    const BERSERKER_ECHO: u32 = 0xee85_cd1f;
    /// The standard-set Healing Cap Up, topping out at +50% where the boss set
    /// reaches +75%. A real candidate of Behemoth III's bonus lot, and an
    /// effect nobody farms for.
    const STANDARD_HEALING_CAP: u32 = 0x2270_bc40;

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
        // A trait id in the bonus slot is granted as a bonus by nobody, so
        // there is no owner to name. The phrase falls back to the bare claim —
        // the rule still fires, it simply has no "then whose is it?" to answer.
        let Value::SummonIds(owners) = &findings[0].allowed else {
            panic!("allowed should name the summons granting the bonus");
        };
        assert_eq!(owners, &Vec::<u32>::new());
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
        assert_eq!(findings[0].subject, Subject::Summon(0));
        assert_eq!(
            findings[0].observed,
            Value::SummonBonusId(BOSS_SET_NA_DMG_CAP)
        );
        let Value::SummonIds(owners) = &findings[0].allowed else {
            panic!("allowed should name the summons granting the bonus");
        };
        assert_eq!(
            names_of(owners),
            ["Beelzebub", "Lilith", "Lucilius", "Rolan"],
            "the finding must name the four bosses that grant the boss set, so a \
             reader can check a claim the gear line itself cannot show"
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
        assert_eq!(findings[0].subject, Subject::Summons);
        assert_eq!(findings[0].observed, Value::Count(2));
        assert_eq!(findings[0].allowed, Value::None);
        let odds = findings[0].odds.expect("the odds are the payload");
        assert!(
            odds > 0.0 && odds < 1e-4,
            "odds {odds} should be tiny but non-zero"
        );
    }

    /// The display names of some summon ids, read from the same lang file the
    /// rule joins on — so a test can assert what a reader will actually see.
    fn names_of(ids: &[u32]) -> Vec<String> {
        let names: HashMap<String, RawName> =
            serde_json::from_str(include_str!("../../lang/en/summons.json"))
                .expect("summons.json matches the lang shape");
        let mut out: Vec<String> = ids
            .iter()
            .map(|id| {
                let key = format!("{id:08x}");
                names
                    .get(&key)
                    .unwrap_or_else(|| panic!("summon {key} is unnamed in lang/en"))
                    .text
                    .clone()
            })
            .collect();
        out.sort();
        out
    }

    /// A FOREIGN BONUS MUST SAY WHOSE IT IS (user, 2026-07-30).
    ///
    /// Two ids share every effect's display name — Behemoth III's own Healing
    /// Cap Up (`2270bc40`, tops at +50%) and the boss set's (`2ea9ca80`, +75%) —
    /// so the rendered line reads "Healing Cap Up", a bonus Behemoth III really
    /// does grant. Against that line the old claim "not from this summon" reads
    /// as simply false, and a reader has nothing on the line to check it with.
    ///
    /// The finding therefore carries the summons that DO grant the id. That is
    /// the fact the line cannot show and the one that settles the claim.
    #[test]
    fn a_foreign_bonus_names_the_summons_that_do_grant_it() {
        let equipped = [summon(
            BEHEMOTH_III_ROLLED,
            (UPLIFT, 15),
            (BOSS_SET_HEALING_CAP, 9),
        )];
        let findings = audit_summons(&equipped);
        let source = findings
            .iter()
            .find(|finding| finding.rule == Rule::SummonBonusSource)
            .expect("the source rule fired");

        let Value::SummonIds(owners) = &source.allowed else {
            panic!("allowed should name the summons granting the bonus, got {source:?}");
        };
        assert_eq!(
            names_of(owners),
            ["Beelzebub", "Lilith", "Lucilius", "Rolan"],
            "the boss-set Healing Cap Up is granted by those four summons alone"
        );
    }

    /// One representative id per NAME, not one per id. Each of those four bosses
    /// owns a rolled and a guaranteed id, and a phrase reading "Lucilius,
    /// Lucilius, Beelzebub, Beelzebub…" names nothing twice as usefully.
    #[test]
    fn the_named_owners_are_one_per_display_name() {
        let equipped = [summon(
            BEHEMOTH_III_ROLLED,
            (UPLIFT, 15),
            (BOSS_SET_HEALING_CAP, 9),
        )];
        let findings = audit_summons(&equipped);
        let Value::SummonIds(owners) = &findings[0].allowed else {
            panic!("allowed should name the granting summons");
        };
        assert_eq!(owners.len(), 4, "expected four names, got {owners:?}");
    }

    /// THE SPECIAL-CANDIDATE GUARD (user, 2026-07-30).
    ///
    /// Every rolled watched boss offers five ordinary main traits on an 11-15
    /// curve plus ONE "special" pinned to a single-level curve at 15 (War
    /// Elemental on Rolan and Lilith, Berserker Echo on Lucilius, Spartan Echo
    /// on Beelzebub, Stout Heart on Behemoth III and Vrazarek). A special is at
    /// "the top of its window" the instant it drops — there is no other level
    /// it could have taken — so calling that a perfect roll prices certainty as
    /// though it were luck.
    #[test]
    fn a_main_trait_that_can_only_ever_be_fifteen_is_not_a_perfect_roll() {
        let equipped = [
            summon(
                LUCILIUS_ROLLED,
                (BERSERKER_ECHO, 15),
                (LUCILIUS_NA_DMG_CAP, 9),
            ),
            summon(BEHEMOTH_III_ROLLED, (UPLIFT, 15), (BEHEMOTH_BONUS, 9)),
        ];
        assert_eq!(
            audit_summons(&equipped),
            vec![],
            "a single-level main trait was counted as a perfect roll"
        );
    }

    /// The same trait on an ordinary multi-level curve still counts — the guard
    /// must reject certainty, not every level-15 trait. Without this, the fix
    /// above passes just as well by refusing to count level 15 at all.
    #[test]
    fn a_main_trait_that_could_have_been_lower_still_counts_at_fifteen() {
        let equipped = [
            summon(LUCILIUS_ROLLED, (ALPHA, 15), (LUCILIUS_NA_DMG_CAP, 9)),
            summon(BEHEMOTH_III_ROLLED, (UPLIFT, 15), (BEHEMOTH_BONUS, 9)),
        ];
        assert!(
            audit_summons(&equipped)
                .iter()
                .any(|finding| finding.rule == Rule::SummonPerfectCount),
            "an 11-15 main trait at 15 stopped counting as a perfect roll"
        );
    }

    /// THE EFFECT SCOPE (user, 2026-07-30): only the stats players actually
    /// chase — Attack Power Up, Stun Power Up and the three Damage Cap Ups —
    /// count toward perfection. Both of these summons sit at the top of both
    /// windows, so both were counted before; a maxed Healing Cap Up is not what
    /// anyone farms for and must not read as one.
    #[test]
    fn a_bonus_outside_the_chased_effects_is_not_a_perfect_roll() {
        let equipped = [
            summon(LUCILIUS_ROLLED, (ALPHA, 15), (BOSS_SET_HEALING_CAP, 9)),
            summon(BEHEMOTH_III_ROLLED, (UPLIFT, 15), (STANDARD_HEALING_CAP, 9)),
        ];
        assert_eq!(
            audit_summons(&equipped),
            vec![],
            "a maxed Healing Cap Up was counted as a perfect roll"
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

    /// THE REPORTED CASE (炎顺帝, log 537): a Behemoth III showing Healing Cap
    /// Up +75%. Its own lots top that effect out at +50% (the standard
    /// `2270bc40` at level 9), so the NUMBER is beyond reach whichever id
    /// produced it.
    ///
    /// This build fires BOTH summon-bonus rules, which is honest rather than
    /// noisy: the id is one no Behemoth III can hold, and separately the
    /// magnitude is one no Behemoth III can display. Either alone would be a
    /// finding; a UI that shows only the first would understate it.
    #[test]
    fn a_magnitude_above_the_summons_ceiling_is_impossible() {
        let equipped = [summon(
            BEHEMOTH_III_ROLLED,
            (UPLIFT, 15),
            (BOSS_SET_HEALING_CAP, 9),
        )];
        let findings = audit_summons(&equipped);

        let magnitude = findings
            .iter()
            .find(|finding| finding.rule == Rule::SummonBonusMagnitude)
            .expect("the magnitude rule should fire on +75% against a +50% ceiling");
        assert_eq!(magnitude.subject, Subject::Summon(0));
        assert_eq!(magnitude.observed, Value::Amount(75.0));
        assert_eq!(magnitude.allowed, Value::Amount(50.0));

        assert!(
            findings
                .iter()
                .any(|finding| finding.rule == Rule::SummonBonusSource),
            "the id is off-union too, so the source rule should also fire"
        );
    }

    /// THE CONSERVATIVE HALF (Kahs, log 549). A magnitude the summon CAN
    /// display stays silent however odd the id that produced it: this
    /// Behemoth III shows Normal Attack DMG Cap Up +50%, which its own
    /// `a66241c9` reaches at the top of its window. Only the source rule may
    /// speak — the magnitude claim would be unprovable, and an unprovable
    /// claim is not made.
    #[test]
    fn a_reachable_magnitude_is_silent_however_odd_the_id() {
        let equipped = [summon(
            BEHEMOTH_III_ROLLED,
            (UPLIFT, 15),
            (BOSS_SET_NA_DMG_CAP, 6),
        )];
        let findings = audit_summons(&equipped);
        assert!(
            !findings
                .iter()
                .any(|finding| finding.rule == Rule::SummonBonusMagnitude),
            "a magnitude Behemoth III can display was called impossible"
        );
    }

    /// THE PRODUCTION REGRESSION GUARD, restated for magnitudes. Every
    /// above-window level in the whole census is the `-1` unread sentinel, and
    /// it prices nothing — so an unread bonus must stay silent rather than
    /// read as an enormous magnitude and accuse the honest players who carry
    /// one.
    #[test]
    fn an_unread_level_has_no_magnitude_and_is_silent() {
        for level in [u32::MAX, 99, 10] {
            let equipped = [summon(
                BEHEMOTH_III_ROLLED,
                (UPLIFT, 15),
                (BEHEMOTH_BONUS, level),
            )];
            assert!(
                !audit_summons(&equipped)
                    .iter()
                    .any(|finding| finding.rule == Rule::SummonBonusMagnitude),
                "level {level} was priced as a magnitude"
            );
        }
    }

    /// A summon whose lots grant NO bonus of the observed effect has no
    /// statable ceiling, so the magnitude rule must stay quiet and leave the
    /// claim to the source rule. Vrazarek Firewyrm III's guaranteed variant
    /// grants exactly one bonus, so every other effect is unpriceable for it.
    #[test]
    fn an_effect_the_summon_never_grants_has_no_ceiling_to_exceed() {
        let equipped = [summon(
            VRAZAREK_III,
            (DMG_CAP, 15),
            (STANDARD_HEALING_CAP, 9),
        )];
        let findings = audit_summons(&equipped);
        assert!(
            !findings
                .iter()
                .any(|finding| finding.rule == Rule::SummonBonusMagnitude),
            "a ceiling was invented for an effect this summon cannot grant"
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
