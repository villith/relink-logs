//! Overmastery legality, rules 8 and 9.

use protocol::OvermasteryInfo;

use super::{is_empty, Finding, Rule, Subject, Value};
use crate::overmastery::stock_tables;

/// The game always rolls four overmasteries; fewer means a partial read.
const OVERMASTERY_SLOT_COUNT: usize = 4;

/// Float comparison tolerance. Ladder values are whole numbers or tenths, so
/// this only absorbs f32 representation error. The smallest gap between two
/// adjacent ladder steps anywhere in the stock tables is 0.1, a hundred times
/// this, so no legitimate value can be mistaken for its neighbour.
const EPSILON: f32 = 1e-3;

/// Chance that one slot rolls the top level, taking the most favourable
/// meditation size — the reading most generous to the player. Stock tables
/// weight the top level at 100/100/1800 of 10000, so this is 0.18.
///
/// Derived once: it is a fold over the whole `level_weights` grid and the
/// answer is a property of the baked tables, not of the build being audited.
fn best_max_level_chance() -> f64 {
    static CHANCE: std::sync::OnceLock<f64> = std::sync::OnceLock::new();
    *CHANCE.get_or_init(|| {
        let tables = stock_tables();
        let sizes = tables.level_weights.first().map_or(0, |row| row.len());

        (0..sizes)
            .map(|size| {
                let total: u32 = tables.level_weights.iter().map(|row| row[size]).sum();
                let top = tables.level_weights.last().map_or(0, |row| row[size]);
                if total == 0 {
                    0.0
                } else {
                    f64::from(top) / f64::from(total)
                }
            })
            .fold(0.0_f64, f64::max)
    })
}

/// Whether a slot's magnitude was never read, rather than read as small.
///
/// The hook reports an overmastery it could not measure as exactly `0.0`, on
/// three paths: `read_loadout_overmasteries_and_level` sets `value: 0.0`
/// unconditionally because the loadout stores only id + level bits and no
/// computed magnitude (it is the fallback whenever the record block is
/// sentinel-empty, i.e. in town or out of quest), and the record path itself
/// falls back to `0.0` when the guarded `f32` read fails or returns
/// non-finite. The parser and the log view already render this state as
/// "(Lvl. N)" with no magnitude.
///
/// A zero can never be a real magnitude: the smallest step on any ladder in
/// `overmastery-tables.json` is 0.1, pinned by
/// `zero_is_not_a_legitimate_magnitude_on_any_ladder`. So the comparison is
/// exact and unambiguous — nothing legitimate rounds to it.
fn magnitude_unread(value: f32) -> bool {
    value == 0.0
}

/// Rules 8 and 9. Silent without a full set of four overmasteries, and
/// silent about any slot whose magnitude was never read — including rule 9,
/// which cannot conclude "all four maxed" from a value it never saw.
pub fn audit_overmastery(info: Option<&OvermasteryInfo>) -> Vec<Finding> {
    let Some(info) = info else {
        return Vec::new();
    };
    if info.overmasteries.len() != OVERMASTERY_SLOT_COUNT {
        return Vec::new();
    }

    let tables = stock_tables();
    let mut findings = Vec::new();
    // COUNTED, not a flag cleared on every rejection path. The rule fires only
    // when all four slots are affirmatively proven maxed, so a path that forgets
    // to speak fails CLOSED (no finding). A `bool` set false on each rejection
    // fails OPEN — one forgotten branch is a false accusation, which is the one
    // outcome this module exists to prevent.
    let mut maxed_slots = 0usize;

    for (index, mastery) in info.overmasteries.iter().enumerate() {
        // An empty/unread slot is missing data, not an unknown id.
        if is_empty(mastery.id) {
            continue;
        }

        let Some(param) = tables.params.get(&mastery.id) else {
            findings.push(Finding {
                rule: Rule::OvermasteryValue,
                subject: Subject::Overmastery(index),
                // The id is what was rejected, not the magnitude — and the
                // magnitude may not even have been read. Matches
                // `wrightstone`'s idiom for an id outside the catalogue.
                observed: Value::OvermasteryId(mastery.id),
                allowed: Value::None,
                odds: None,
                evidence: None,
            });
            continue;
        };

        // The id is real data even when the magnitude is not — it was read
        // and passed the hook's own sentinel filter — so the catalogue check
        // above still applies. Everything below judges the magnitude, and
        // there is no magnitude to judge.
        if magnitude_unread(mastery.value) {
            continue;
        }

        let on_ladder = param
            .values
            .iter()
            .any(|&step| (step - mastery.value).abs() < EPSILON);

        if !on_ladder {
            findings.push(Finding {
                rule: Rule::OvermasteryValue,
                subject: Subject::Overmastery(index),
                observed: Value::Amount(mastery.value),
                allowed: Value::Amount(param.values[param.values.len() - 1]),
                odds: None,
                evidence: None,
            });
            continue;
        }

        // Only the five chased effects count toward the tally (see
        // `chased_effects`). A maxed Health Up is a coincidence nobody rerolled
        // for, and counting it made an ordinary endgame set a report.
        //
        // The threshold stays at all four slots, so this is strictly narrower:
        // a single uncounted slot puts the tally permanently out of reach for
        // that set, whatever the other three did.
        let top = param.values[param.values.len() - 1];
        if (top - mastery.value).abs() < EPSILON
            && chased_effects::overmastery_is_chased(mastery.id)
        {
            maxed_slots += 1;
        }
    }

    if maxed_slots == OVERMASTERY_SLOT_COUNT {
        findings.push(Finding {
            rule: Rule::OvermasteryAllMaxed,
            subject: Subject::Overmasteries,
            observed: Value::Count(OVERMASTERY_SLOT_COUNT),
            // Nothing is being exceeded here: four maxed slots are a legal
            // roll, merely an improbable one, so there is no allowed value to
            // name and `odds` is the payload. The previous `Count(4)` on both
            // sides conveyed nothing.
            allowed: Value::None,
            odds: Some(best_max_level_chance().powi(OVERMASTERY_SLOT_COUNT as i32)),
            evidence: None,
        });
    }

    findings
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::Overmastery;

    /// Attack Power Up: ladder 100,100,200,…,1000. Health Up maxes at 2000.
    const ATTACK: u32 = 0xc4925bd7;
    const HEALTH: u32 = 0x52a207b5;
    const CRIT: u32 = 0x45c65767;
    const STUN: u32 = 0x6cb38ef3;

    /// The two other chased effects, both on the 1,1,2,4,6,8,10,12,16,20
    /// ladder. Attack Power Up and Stun Power Up above complete the set of
    /// five names the count rule recognises.
    const NA_DMG_CAP: u32 = 0x43b7_581d;
    const SKILL_DMG_CAP: u32 = 0x9c55_5433;
    /// Skill Damage UP — the same ladder as the cap ups and a stat that looks
    /// just as maxed, but not one the rule counts. The near-miss is the point.
    const SKILL_DMG: u32 = 0x9a97_c049;

    /// Four maxed slots that the rule must recognise: all four are chased
    /// effects. `flags_all_four_at_maximum` pins the finding it produces.
    fn four_chased_maxed() -> OvermasteryInfo {
        info(&[
            (ATTACK, 1000.0),
            (STUN, 2.0),
            (NA_DMG_CAP, 20.0),
            (SKILL_DMG_CAP, 20.0),
        ])
    }

    fn info(entries: &[(u32, f32)]) -> OvermasteryInfo {
        OvermasteryInfo {
            overmasteries: entries
                .iter()
                .map(|&(id, value)| Overmastery {
                    id,
                    flags: 0,
                    value,
                })
                .collect(),
        }
    }

    #[test]
    fn accepts_values_on_the_ladder() {
        let info = info(&[(ATTACK, 500.0), (HEALTH, 800.0), (CRIT, 6.0), (STUN, 0.6)]);
        assert_eq!(audit_overmastery(Some(&info)), vec![]);
    }

    #[test]
    fn flags_a_value_absent_from_the_ladder() {
        let info = info(&[(ATTACK, 5000.0), (HEALTH, 800.0), (CRIT, 6.0), (STUN, 0.6)]);
        let findings = audit_overmastery(Some(&info));
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, Rule::OvermasteryValue);
        assert_eq!(findings[0].subject, Subject::Overmastery(0));
        assert_eq!(findings[0].observed, Value::Amount(5000.0));
    }

    #[test]
    fn flags_an_id_outside_the_pool() {
        let info = info(&[
            (0xdeadbeef, 100.0),
            (HEALTH, 800.0),
            (CRIT, 6.0),
            (STUN, 0.6),
        ]);
        let findings = audit_overmastery(Some(&info));
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, Rule::OvermasteryValue);
        assert_eq!(findings[0].allowed, Value::None);
        // The id is what was rejected, not the magnitude, so the id is what
        // the finding must carry — otherwise a UI can never name the
        // offending overmastery.
        assert_eq!(findings[0].observed, Value::OvermasteryId(0xdeadbeef));
    }

    /// THE EFFECT SCOPE (user, 2026-07-30). Only Attack Power Up, Stun Power Up
    /// and the three Damage Cap Ups count toward the tally, so a maxed Health
    /// Up or Critical Hit Rate Up is no longer evidence of anything — and with
    /// two of the four slots uncounted the tally can never reach four.
    ///
    /// THE PRODUCTION CASE the scope was requested for: a real set of four
    /// maxed rolls, two of them chased and two not, which the rule reported.
    #[test]
    fn a_maxed_set_containing_an_uncounted_effect_is_not_reported() {
        let info = info(&[
            (NA_DMG_CAP, 20.0),
            (SKILL_DMG_CAP, 20.0),
            (CRIT, 20.0),
            (SKILL_DMG, 20.0),
        ]);
        assert_eq!(
            audit_overmastery(Some(&info)),
            vec![],
            "a set with two uncounted effects was reported as all-maxed"
        );
    }

    /// The counterpart, so the scope cannot pass by silencing the rule
    /// outright: four maxed CHASED effects are still the finding.
    #[test]
    fn flags_all_four_at_maximum() {
        let info = four_chased_maxed();
        let findings = audit_overmastery(Some(&info));
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, Rule::OvermasteryAllMaxed);
        // The claim is about the whole set, so the subject is the whole set —
        // pointing at slot 0 made the audit page display a single overmastery.
        assert_eq!(findings[0].subject, Subject::Overmasteries);
        let odds = findings[0].odds.expect("maxed roll reports odds");
        // 0.18^4 on a large meditation.
        assert!((odds - 0.18_f64.powi(4)).abs() < 1e-9, "odds were {odds}");
        // All four slots are at maximum, which is the observation. There is
        // no ceiling being exceeded — the roll is legal, merely improbable —
        // so `allowed` names nothing and `odds` carries the real payload.
        assert_eq!(findings[0].observed, Value::Count(OVERMASTERY_SLOT_COUNT));
        assert_eq!(findings[0].allowed, Value::None);
    }

    /// All four slots are chased effects, so only the count can hold the rule
    /// back — which is what makes this a test of the threshold rather than of
    /// the scope.
    #[test]
    fn three_maxed_slots_are_not_flagged() {
        let info = info(&[
            (ATTACK, 1000.0),
            (STUN, 2.0),
            (NA_DMG_CAP, 20.0),
            (SKILL_DMG_CAP, 16.0),
        ]);
        assert_eq!(audit_overmastery(Some(&info)), vec![]);
    }

    /// The exact shape three real encounters in this repo's `logs.db` carry
    /// (logs 404, 445 and 448): four real, catalogued ids whose magnitudes
    /// were never read. Before the zero guard this accused that player four
    /// times over.
    #[test]
    fn a_production_shaped_unread_set_is_silent() {
        let info = info(&[
            (0x9a97_c049, 0.0),
            (0x9c55_5433, 0.0),
            (0xc492_5bd7, 0.0),
            (0x43b7_581d, 0.0),
        ]);
        assert_eq!(audit_overmastery(Some(&info)), vec![]);
    }

    /// A zero silences its own slot only. A genuinely off-ladder magnitude
    /// elsewhere in the same set is still proof and must still be reported.
    #[test]
    fn an_unread_slot_does_not_silence_a_real_off_ladder_value() {
        let info = info(&[(ATTACK, 0.0), (HEALTH, 777.0), (CRIT, 0.0), (STUN, 0.0)]);
        let findings = audit_overmastery(Some(&info));
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, Rule::OvermasteryValue);
        assert_eq!(findings[0].subject, Subject::Overmastery(1));
        assert_eq!(findings[0].observed, Value::Amount(777.0));
    }

    /// "All four maxed" cannot be concluded from magnitudes that were never
    /// read. Three maxed slots beside one unread slot must stay silent.
    #[test]
    fn all_maxed_does_not_fire_on_a_set_containing_an_unread_slot() {
        let mut info = four_chased_maxed();
        info.overmasteries[1].value = 0.0;
        assert_eq!(audit_overmastery(Some(&info)), vec![]);
    }

    /// The catalogue check is independent of the magnitude: an id that exists
    /// nowhere in the game's tables is still proof even when the value was
    /// never read.
    #[test]
    fn an_unknown_id_is_still_flagged_when_the_magnitude_was_not_read() {
        let info = info(&[
            (0xdead_beef, 0.0),
            (HEALTH, 800.0),
            (CRIT, 6.0),
            (STUN, 0.6),
        ]);
        let findings = audit_overmastery(Some(&info));
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, Rule::OvermasteryValue);
        assert_eq!(findings[0].subject, Subject::Overmastery(0));
    }

    /// The production false positive this guard exists for: 16 findings in a
    /// real database observed id `887ae0b0`, the engine empty sentinel,
    /// because the rule assumed the hook's sentinel filter is airtight. An
    /// empty slot must be silent — including the plain-zero spelling — and
    /// "all four maxed" cannot be concluded across it.
    #[test]
    fn sentinel_ids_are_missing_data_not_unknown_ids() {
        for sentinel in [0x887a_e0b0_u32, 0] {
            // The other three are maxed CHASED effects, so nothing but the
            // sentinel guard itself can be keeping the all-maxed rule quiet.
            let mut info = four_chased_maxed();
            info.overmasteries[0] = Overmastery {
                id: sentinel,
                flags: 0,
                value: 0.0,
            };
            assert_eq!(
                audit_overmastery(Some(&info)),
                vec![],
                "sentinel id {sentinel:08x} was accused (or all-maxed fired past it)"
            );
        }
    }

    /// THE DRIFT GUARD for [`STUN_IDS`].
    ///
    /// The ids are written out rather than derived, so a game update that
    /// renumbers them — or adds a fourth stun id — would switch this report off
    /// with nothing to notice it. Pin every property the rule leans on: each id
    /// is a real param of category 3 topping at 2.0, all three live in the Lv1
    /// pool, the Lv1 pool holds exactly these three and no more, and the larger
    /// pools carry one apiece (which is what makes three self-identifying).
    #[test]
    fn the_stun_ids_are_the_category_3_params_of_the_lv1_pool() {
        let tables = stock_tables();

        for id in STUN_IDS {
            let param = tables
                .params
                .get(&id)
                .unwrap_or_else(|| panic!("stun id {id:08x} left the ladder table"));
            assert_eq!(param.kind, 3, "stun id {id:08x} changed category");
            assert_eq!(param.values[param.values.len() - 1], 2.0);
        }

        let stuns_in = |tier: usize| -> Vec<u32> {
            tables.pools[tier]
                .iter()
                .map(|entry| entry.key)
                .filter(|key| tables.params.get(key).is_some_and(|p| p.kind == 3))
                .collect()
        };

        let mut lv1 = stuns_in(0);
        lv1.sort_unstable();
        let mut expected = STUN_IDS;
        expected.sort_unstable();
        assert_eq!(
            lv1, expected,
            "the Lv1 pool no longer holds exactly the three stun ids the rule counts"
        );

        for tier in [1, 2] {
            assert_eq!(
                stuns_in(tier).len(),
                1,
                "pool {tier} gained a second stun id — three stuns no longer \
                 proves a Lv1 meditation"
            );
        }
    }

    /// No ladder in `overmastery-tables.json` contains 0.0 — the smallest
    /// magnitude any overmastery can legitimately hold is 0.1 — so a zero can
    /// only ever mean "not read". This is what makes the guard above safe.
    #[test]
    fn zero_is_not_a_legitimate_magnitude_on_any_ladder() {
        let tables = stock_tables();
        assert!(!tables.params.is_empty());
        for (id, param) in &tables.params {
            for &step in &param.values {
                assert!(
                    step >= 0.1 - EPSILON,
                    "param {id:08x} admits {step}, so a zero magnitude may be real \
                     and the unread-slot guard needs a different discriminator"
                );
            }
        }
    }

    #[test]
    fn stays_silent_without_overmastery_info() {
        assert_eq!(audit_overmastery(None), vec![]);
    }

    #[test]
    fn stays_silent_on_a_partial_read() {
        // Fewer than four slots means the read is incomplete.
        let info = info(&[(ATTACK, 1000.0), (HEALTH, 2000.0)]);
        assert_eq!(audit_overmastery(Some(&info)), vec![]);
    }
}
