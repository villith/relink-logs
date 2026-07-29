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

/// Rules 8 and 9. Silent without a full set of four overmasteries.
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
