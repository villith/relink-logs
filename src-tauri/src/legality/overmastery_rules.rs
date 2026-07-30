//! Overmastery legality, rules 8 and 9.

use protocol::OvermasteryInfo;

use super::{Finding, Rule, Severity, Subject, Value};
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
fn best_max_level_chance() -> f64 {
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
    let mut all_maxed = true;

    for (index, mastery) in info.overmasteries.iter().enumerate() {
        let Some(param) = tables.params.get(&mastery.id) else {
            all_maxed = false;
            findings.push(Finding {
                rule: Rule::OvermasteryValue,
                severity: Severity::Impossible,
                subject: Subject::Overmastery(index),
                observed: Value::Amount(mastery.value),
                allowed: Value::None,
                odds: None,
            });
            continue;
        };

        // The id is real data even when the magnitude is not — it was read
        // and passed the hook's own sentinel filter — so the catalogue check
        // above still applies. Everything below judges the magnitude, and
        // there is no magnitude to judge.
        if magnitude_unread(mastery.value) {
            all_maxed = false;
            continue;
        }

        let on_ladder = param
            .values
            .iter()
            .any(|&step| (step - mastery.value).abs() < EPSILON);

        if !on_ladder {
            all_maxed = false;
            findings.push(Finding {
                rule: Rule::OvermasteryValue,
                severity: Severity::Impossible,
                subject: Subject::Overmastery(index),
                observed: Value::Amount(mastery.value),
                allowed: Value::Amount(param.values[param.values.len() - 1]),
                odds: None,
            });
            continue;
        }

        let top = param.values[param.values.len() - 1];
        if (top - mastery.value).abs() >= EPSILON {
            all_maxed = false;
        }
    }

    if all_maxed {
        findings.push(Finding {
            rule: Rule::OvermasteryAllMaxed,
            severity: Severity::Improbable,
            subject: Subject::Overmastery(0),
            observed: Value::Count(OVERMASTERY_SLOT_COUNT),
            allowed: Value::Count(OVERMASTERY_SLOT_COUNT),
            odds: Some(best_max_level_chance().powi(OVERMASTERY_SLOT_COUNT as i32)),
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
        assert_eq!(findings[0].severity, Severity::Impossible);
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
    }

    #[test]
    fn flags_all_four_at_maximum() {
        let info = info(&[
            (ATTACK, 1000.0),
            (HEALTH, 2000.0),
            (CRIT, 20.0),
            (STUN, 2.0),
        ]);
        let findings = audit_overmastery(Some(&info));
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, Rule::OvermasteryAllMaxed);
        assert_eq!(findings[0].severity, Severity::Improbable);
        let odds = findings[0].odds.expect("maxed roll reports odds");
        // 0.18^4 on a large meditation.
        assert!((odds - 0.18_f64.powi(4)).abs() < 1e-9, "odds were {odds}");
    }

    #[test]
    fn three_maxed_slots_are_not_flagged() {
        let info = info(&[
            (ATTACK, 1000.0),
            (HEALTH, 2000.0),
            (CRIT, 20.0),
            (STUN, 0.6),
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
        let info = info(&[
            (ATTACK, 1000.0),
            (HEALTH, 2000.0),
            (CRIT, 20.0),
            (STUN, 0.0),
        ]);
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
