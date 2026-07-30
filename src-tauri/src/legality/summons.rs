//! Summon legality, rules 10 and 11.

use std::collections::HashMap;

use protocol::EquippedSummon;
use serde::Deserialize;

use super::{Finding, Rule, Severity, Subject, Value};

/// One candidate of a summon's main-trait or equip-bonus lot, as generated.
#[derive(Debug, Clone, Deserialize)]
struct RawCandidate {
    /// This candidate's share of its lot's total weight.
    weight: u32,
    /// `(level, weight)` pairs, ascending — so the last is the top.
    levels: Vec<(u32, u32)>,
}

/// One row of `summon-legality.json`, as generated. `tier` is deliberately
/// unread: the per-tier level windows the plan first assumed do not exist, and
/// judging a level against its tier rather than its candidate produces false
/// accusations (see the tests).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawEntry {
    rolled: bool,
    main_traits: HashMap<String, RawCandidate>,
    bonuses: HashMap<String, RawCandidate>,
}

/// One candidate with its level curve, weights intact so the reported odds are
/// the game's real ones rather than a uniform-draw approximation.
#[derive(Debug, Clone)]
pub struct Candidate {
    weight: u32,
    levels: Vec<(u32, u32)>,
}

impl Candidate {
    /// The top of THIS candidate's window — the last entry, the file being
    /// generated ascending.
    fn top(&self) -> Option<(u32, u32)> {
        self.levels.last().copied()
    }

    fn level_total(&self) -> u32 {
        self.levels.iter().map(|&(_, weight)| weight).sum()
    }

    /// P(top level | this candidate), or `None` when the curve is empty or
    /// weightless — missing data, never a certainty.
    fn top_chance(&self) -> Option<f64> {
        let (_, weight) = self.top()?;
        let total = self.level_total();
        (total > 0).then(|| f64::from(weight) / f64::from(total))
    }
}

/// One lot: the candidates for a summon's main trait or its equip bonus.
///
/// Totals are summed rather than read from the file, which deliberately omits
/// them because they vary (10000, 9999 or 9998 — the table's own rounding).
#[derive(Debug, Clone)]
pub struct Lot {
    total: u32,
    candidates: HashMap<u32, Candidate>,
}

impl Lot {
    fn get(&self, id: u32) -> Option<&Candidate> {
        self.candidates.get(&id)
    }

    /// P(candidate, level = its top). The verified draw model is
    /// `candidateWeight/Σ candidateWeights × levelWeight/Σ levelWeights`:
    /// each curve's weight sum equals the lot weight of exactly the candidates
    /// sharing it, so "pick candidate then level" and a joint draw agree.
    fn top_chance(&self, id: u32) -> Option<f64> {
        let candidate = self.get(id)?;
        if self.total == 0 {
            return None;
        }
        let share = f64::from(candidate.weight) / f64::from(self.total);
        Some(share * candidate.top_chance()?)
    }

    /// The most likely top-of-window outcome in this lot, used only to prove
    /// the certainty invariant in the tests.
    #[cfg(test)]
    fn best_top_chance(&self) -> Option<f64> {
        self.candidates
            .keys()
            .filter_map(|&id| self.top_chance(id))
            .fold(None, |best: Option<f64>, chance| {
                Some(best.map_or(chance, |best| best.max(chance)))
            })
    }
}

/// The acquisition roll space of one summon.
#[derive(Debug, Clone)]
pub struct SummonEntry {
    /// `false` means the summon fixes BOTH its main trait and its equip bonus
    /// — one candidate, one level, probability exactly 1.0 on each side.
    pub rolled: bool,
    pub main_traits: Lot,
    pub bonuses: Lot,
}

fn parse_hex(value: &str) -> Option<u32> {
    u32::from_str_radix(value, 16).ok()
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
    let total = candidates.values().map(|candidate| candidate.weight).sum();
    Lot { total, candidates }
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

/// A summon sitting at the top of BOTH of its own candidates' level windows.
struct PerfectRoll {
    /// The probability of having rolled exactly this configuration.
    chance: f64,
    /// The two ceilings it reached, `[main trait, equip bonus]`, read out of
    /// the table so the finding names the windows it judged against.
    ceilings: Vec<u32>,
}

/// Whether this summon is perfect, and if so how unlikely that was. `None`
/// means "not perfect, or not knowable" — the two cases a rule must treat
/// alike, since neither justifies a finding:
///
///   * the summon fixes its trait and bonus (`rolled: false`), so the
///     configuration is guaranteed rather than lucky;
///   * the equipped trait or bonus is not a candidate the lot lists, so the
///     level has no window to be measured against;
///   * either level differs from its candidate's top. A level BELOW the top is
///     an ordinary roll. A level ABOVE it is outside the acquisition window,
///     but whether a summon can be improved after acquisition is unconfirmed
///     gameplay behaviour, so it is not reported either.
fn perfect_roll(entry: &SummonEntry, summon: &EquippedSummon) -> Option<PerfectRoll> {
    // Guard one: the 37 unrolled summons hand every owner the same trait and
    // bonus. Top-of-window is true of them by construction, so a naive rule
    // accuses everyone who owns one.
    if !entry.rolled {
        return None;
    }

    // Every level and probability below comes from the candidate the summon
    // actually carries — never from its tier, whose windows do not exist.
    let main = entry.main_traits.get(summon.main_trait_id)?;
    let bonus = entry.bonuses.get(summon.bonus_id)?;
    let (main_top, _) = main.top()?;
    let (bonus_top, _) = bonus.top()?;
    if main_top != summon.main_trait_level || bonus_top != summon.bonus_level {
        return None;
    }

    let chance = entry.main_traits.top_chance(summon.main_trait_id)?
        * entry.bonuses.top_chance(summon.bonus_id)?;

    // Guard two, on the probability itself. Today the two guards are
    // equivalent — `only_unrolled_summons_can_be_certain` proves every
    // unrolled summon is certain and no rolled one can be — but the flag is a
    // property of the generator while this is a property of the odds we are
    // about to publish, and reporting a certainty as improbable is exactly the
    // false accusation this module exists to prevent.
    (chance < 1.0).then_some(PerfectRoll {
        chance,
        ceilings: vec![main_top, bonus_top],
    })
}

/// Rules 10 and 11. Both are [`Severity::Improbable`] and never
/// [`Severity::Impossible`](super::Severity::Impossible): a perfect summon is
/// legal, merely rare. These rules report odds, they do not accuse.
pub fn audit_summons(summons: &[EquippedSummon]) -> Vec<Finding> {
    let table = stock_summons();
    let mut findings = Vec::new();
    let mut perfect = Vec::new();

    for (index, summon) in summons.iter().enumerate() {
        let Some(entry) = table.get(&summon.summon_id) else {
            continue;
        };
        let Some(roll) = perfect_roll(entry, summon) else {
            continue;
        };
        perfect.push(roll.chance);

        // `observed` and `allowed` are both `[main trait level, equip bonus
        // level]` and are equal by construction, as with `OvermasteryAllMaxed`
        // — what the rule reports is precisely that the observed levels ARE
        // the ceilings. `allowed` comes from the table rather than being
        // echoed from the input, so it names the windows judged against.
        findings.push(Finding {
            rule: Rule::SummonPerfect,
            severity: Severity::Improbable,
            subject: Subject::Summon(index),
            observed: Value::Levels(vec![summon.main_trait_level, summon.bonus_level]),
            allowed: Value::Levels(roll.ceilings),
            odds: Some(roll.chance),
        });
    }

    // Rule 11: one perfect summon is luck; several compound. Independent
    // draws, so the joint probability is the product.
    if perfect.len() > 1 {
        findings.push(Finding {
            rule: Rule::SummonPerfectCount,
            severity: Severity::Improbable,
            subject: Subject::Summon(0),
            observed: Value::Count(perfect.len()),
            allowed: Value::Count(1),
            odds: Some(perfect.iter().product()),
        });
    }

    findings
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::legality::{Rule, Severity, Subject, Value};

    /// Wheel of Fate III: tier 3, rolled. Main lot total 9998, bonus lot
    /// total 9999.
    const WHEEL_OF_FATE_III: u32 = 0x47e2_ae71;
    /// Its main candidate Supplementary DMG: weight 3066, levels 11..=15 with
    /// the top weighted 1000 of 9200 — so level 15 is the top of ITS window.
    const SUPPLEMENTARY_DMG: u32 = 0x57ab_5b10;
    /// Its bonus candidate Critical Hit Rate Up: weight 909, levels 6..=9 at
    /// 2500 each — top bonus index 9.
    const CRIT_RATE_UP: u32 = 0x00d1_71e0;
    /// P(main 57ab5b10 @15) x P(bonus 00d171e0 @9), computed from the table's
    /// own weights: 0.033333 x 0.022727 = 1 in 1320.0.
    const WHEEL_PERFECT_ODDS: f64 = 0.000_757_562_579_709_617_9;

    /// Goldslime II: tier 2, rolled, and one of the 21 lots carrying a second
    /// curve. Its special main candidate is fixed at level 15 — far outside
    /// the 7-10 window the other three candidates roll in.
    const GOLDSLIME_II: u32 = 0x3166_41a4;
    const WAR_ELEMENTAL: u32 = 0x4c58_8c27;
    /// P(main 4c588c27 @15) = 300/9999 x 300/300 = 0.030003, times
    /// P(bonus 00d171e0 @5) = 909/9999 x 3340/10000 = 0.030364.
    const GOLDSLIME_PERFECT_ODDS: f64 = 0.000_911_000_190_928_183_7;

    /// Vrazarek Firewyrm III: `rolled: false`. It GUARANTEES DMG Cap at level
    /// 15 with equip bonus index 4 — probability exactly 1.0, top of window
    /// on both sides by construction.
    const VRAZAREK_III: u32 = 0x9f0e_cf8b;
    const DMG_CAP: u32 = 0xdc58_4f60;
    const VRAZAREK_BONUS: u32 = 0xbc4e_92cb;

    fn summon(summon_id: u32, main: (u32, u32), bonus: (u32, u32)) -> EquippedSummon {
        EquippedSummon {
            summon_id,
            main_trait_id: main.0,
            main_trait_level: main.1,
            bonus_id: bonus.0,
            bonus_level: bonus.1,
        }
    }

    fn wheel_perfect() -> EquippedSummon {
        summon(
            WHEEL_OF_FATE_III,
            (SUPPLEMENTARY_DMG, 15),
            (CRIT_RATE_UP, 9),
        )
    }

    fn goldslime_perfect() -> EquippedSummon {
        summon(GOLDSLIME_II, (WAR_ELEMENTAL, 15), (CRIT_RATE_UP, 5))
    }

    /// The table itself, pinned so a regeneration that lost rows or collapsed
    /// the rolled/fixed split cannot silently disable both rules.
    #[test]
    fn the_table_loads_every_summon_and_keeps_the_rolled_split() {
        let table = stock_summons();
        assert_eq!(table.len(), 189);
        let rolled = table.values().filter(|entry| entry.rolled).count();
        assert_eq!((rolled, table.len() - rolled), (152, 37));
    }

    /// The justification for the p = 1.0 guard, checked against the table
    /// rather than assumed: every `rolled: false` summon has exactly one
    /// configuration and it is certain, while NO `rolled: true` summon can
    /// reach certainty on any top-of-window path. If a future table breaks
    /// that equivalence, the probability guard is what still holds.
    #[test]
    fn only_unrolled_summons_can_be_certain() {
        for (id, entry) in stock_summons() {
            let best = entry
                .main_traits
                .best_top_chance()
                .zip(entry.bonuses.best_top_chance())
                .map(|(main, bonus)| main * bonus)
                .expect("every summon has at least one candidate per side");
            if entry.rolled {
                assert!(best < 1.0, "rolled summon {id:08x} can be certain: {best}");
            } else {
                assert!(
                    (best - 1.0).abs() < f64::EPSILON,
                    "fixed summon {id:08x} is not certain: {best}"
                );
            }
        }
    }

    /// Rule 10, positive. The odds are the finding's whole point, so the real
    /// number is asserted, not merely its presence.
    #[test]
    fn flags_a_perfect_summon_with_its_true_odds() {
        let findings = audit_summons(&[wheel_perfect()]);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, Rule::SummonPerfect);
        assert_eq!(findings[0].severity, Severity::Improbable);
        assert_eq!(findings[0].subject, Subject::Summon(0));
        assert_eq!(findings[0].observed, Value::Levels(vec![15, 9]));
        assert_eq!(findings[0].allowed, Value::Levels(vec![15, 9]));
        let odds = findings[0].odds.expect("a perfect summon reports odds");
        assert!(
            (odds - WHEEL_PERFECT_ODDS).abs() < 1e-12,
            "odds were {odds}, expected {WHEEL_PERFECT_ODDS} (1 in {})",
            1.0 / odds
        );
        assert!((1.0 / odds - 1320.0).abs() < 0.1, "1 in {}", 1.0 / odds);
    }

    /// Rule 10, negative. Maxing one side is not perfection.
    #[test]
    fn half_maxed_summons_yield_no_findings() {
        let mid_bonus = summon(
            WHEEL_OF_FATE_III,
            (SUPPLEMENTARY_DMG, 15),
            (CRIT_RATE_UP, 8),
        );
        assert_eq!(audit_summons(&[mid_bonus]), vec![]);

        let mid_main = summon(
            WHEEL_OF_FATE_III,
            (SUPPLEMENTARY_DMG, 14),
            (CRIT_RATE_UP, 9),
        );
        assert_eq!(audit_summons(&[mid_main]), vec![]);
    }

    /// Rule 11. Two perfect summons compound, and the count finding is
    /// emitted exactly once alongside the per-summon ones.
    #[test]
    fn two_perfect_summons_compound_into_one_count_finding() {
        let findings = audit_summons(&[wheel_perfect(), goldslime_perfect()]);
        let counts: Vec<_> = findings
            .iter()
            .filter(|finding| finding.rule == Rule::SummonPerfectCount)
            .collect();
        assert_eq!(counts.len(), 1);
        assert_eq!(counts[0].severity, Severity::Improbable);
        assert_eq!(counts[0].subject, Subject::Summon(0));
        assert_eq!(counts[0].observed, Value::Count(2));
        assert_eq!(counts[0].allowed, Value::Count(1));

        let expected = WHEEL_PERFECT_ODDS * GOLDSLIME_PERFECT_ODDS;
        let odds = counts[0].odds.expect("the count finding reports odds");
        assert!(
            (odds - expected).abs() < 1e-18,
            "odds were {odds}, expected {expected}"
        );

        assert_eq!(
            findings
                .iter()
                .filter(|finding| finding.rule == Rule::SummonPerfect)
                .count(),
            2
        );
    }

    /// One perfect summon is not a count finding.
    #[test]
    fn a_single_perfect_summon_produces_no_count_finding() {
        let findings = audit_summons(&[wheel_perfect()]);
        assert!(findings
            .iter()
            .all(|finding| finding.rule != Rule::SummonPerfectCount));
    }

    #[test]
    fn empty_summon_list_is_silent() {
        assert_eq!(audit_summons(&[]), vec![]);
    }

    /// A summon the table does not know says nothing about legality, however
    /// maxed it looks. An empty slot (id 0) is the same case.
    ///
    /// HONEST LIMITATION: a flag-everything mutant of `perfect_chance` leaves
    /// this test passing, because the table lookup misses before any rule
    /// runs. The precondition is asserted rather than assumed, so should a
    /// future table ever key these ids the assertion — not silence — is what
    /// fails first.
    #[test]
    fn unknown_summon_id_is_silent_even_with_maxed_levels() {
        for id in [0xdead_beef_u32, 0] {
            assert!(
                !stock_summons().contains_key(&id),
                "{id:08x} is a table key"
            );
            let equipped = [summon(id, (SUPPLEMENTARY_DMG, 15), (CRIT_RATE_UP, 9))];
            assert_eq!(audit_summons(&equipped), vec![], "audited summon {id:08x}");
        }
    }

    /// The false-accusation guard this module exists for. Vrazarek Firewyrm
    /// III hands every owner a level-15 DMG Cap trait and bonus index 4; a
    /// naive top-of-window rule reports the game's own guaranteed summon as
    /// improbable.
    #[test]
    fn the_guaranteed_summon_is_never_flagged() {
        let equipped = [summon(VRAZAREK_III, (DMG_CAP, 15), (VRAZAREK_BONUS, 4))];
        assert_eq!(audit_summons(&equipped), vec![]);

        // Nor does pairing it with a real perfect summon manufacture a count
        // finding out of one genuine perfect roll.
        let with_perfect = [
            summon(VRAZAREK_III, (DMG_CAP, 15), (VRAZAREK_BONUS, 4)),
            wheel_perfect(),
        ];
        let findings = audit_summons(&with_perfect);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, Rule::SummonPerfect);
        assert_eq!(findings[0].subject, Subject::Summon(1));
    }

    /// The regression guard against the dead per-tier model. Goldslime II is
    /// tier 2, whose ordinary candidates roll 7-10, but its special candidate
    /// is fixed at 15. Judged against the tier the level looks out of range;
    /// judged against the candidate it is exactly top-of-window, and the odds
    /// come from that candidate's own 300/9999 share.
    #[test]
    fn a_special_candidate_is_judged_against_its_own_window() {
        let findings = audit_summons(&[goldslime_perfect()]);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, Rule::SummonPerfect);
        assert_eq!(findings[0].severity, Severity::Improbable);
        assert_eq!(findings[0].observed, Value::Levels(vec![15, 5]));
        let odds = findings[0].odds.expect("a perfect summon reports odds");
        assert!(
            (odds - GOLDSLIME_PERFECT_ODDS).abs() < 1e-12,
            "odds were {odds}, expected {GOLDSLIME_PERFECT_ODDS}"
        );

        // An ordinary candidate of the same summon tops out at 10, not 15 —
        // the window belongs to the candidate, not the tier.
        let ordinary = summon(GOLDSLIME_II, (0x5e42_2ae5, 10), (CRIT_RATE_UP, 5));
        let findings = audit_summons(&[ordinary]);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].observed, Value::Levels(vec![10, 5]));
    }

    /// A trait id the summon's lot does not list is missing data, not proof.
    /// The level is meaningless without a candidate to measure it against, so
    /// the only honest answer is silence.
    #[test]
    fn a_trait_absent_from_the_summons_lot_is_silent() {
        let unknown_main = [summon(WHEEL_OF_FATE_III, (DMG_CAP, 15), (CRIT_RATE_UP, 9))];
        assert_eq!(audit_summons(&unknown_main), vec![]);

        let unknown_bonus = [summon(
            WHEEL_OF_FATE_III,
            (SUPPLEMENTARY_DMG, 15),
            (DMG_CAP, 9),
        )];
        assert_eq!(audit_summons(&unknown_bonus), vec![]);
    }

    /// A level above the candidate's top is out of the acquisition window,
    /// but whether a summon can be improved after acquisition is unconfirmed
    /// gameplay behaviour — so it is NOT perfection and NOT an accusation.
    #[test]
    fn a_level_above_the_window_is_not_reported() {
        let equipped = [summon(
            WHEEL_OF_FATE_III,
            (SUPPLEMENTARY_DMG, 99),
            (CRIT_RATE_UP, 99),
        )];
        assert_eq!(audit_summons(&equipped), vec![]);
    }
}
