//! Overmastery legality, rules 8 and 9.

use protocol::OvermasteryInfo;

use super::{is_empty, Finding, Rule, Subject, Value};
use crate::overmastery::stock_tables;

/// The game always rolls four overmasteries; fewer means a partial read.
const OVERMASTERY_SLOT_COUNT: usize = 4;

/// The three Stun Power Up ids.
///
/// Written out rather than derived, and guarded by
/// `the_stun_ids_are_the_category_3_params_of_the_lv1_pool`. All three exist
/// only in the Lv1 (700 MSP) pool — the Lv2 and Lv3 pools carry one apiece —
/// so a set holding all three names its own meditation size without the log
/// having to record it.
const STUN_IDS: [u32; 3] = [0x6cb3_8ef3, 0xa354_5ca1, 0x59fb_b7d8];

/// How many maxed stuns the report takes. Three is also the ceiling: a roll
/// never draws the same key twice, and there are only three stun ids.
const MAXED_STUN_COUNT: usize = STUN_IDS.len();

/// Float comparison tolerance. Ladder values are whole numbers or tenths, so
/// this only absorbs f32 representation error. The smallest gap between two
/// adjacent ladder steps anywhere in the stock tables is 0.1, a hundred times
/// this, so no legitimate value can be mistaken for its neighbour.
const EPSILON: f32 = 1e-3;

/// The meditation size the report is about. Only this pool carries three stun
/// ids, so it is the only size that can produce the set.
const LV1_TIER: usize = 0;

/// Chance that one Lv1 meditation produces the reported set: all three stun
/// ids among the four categories it draws, each landing on the top rung.
///
/// Unlike the four-maxed report this replaced, the size is not a guess — three
/// stuns can only have come from the Lv1 pool — so there is no need to quote
/// the reading most generous to the player. This is the whole probability.
///
/// Both halves come from the baked tables, so a patch that reweights the
/// ladders or resizes the pool reprices the claim instead of leaving a stale
/// constant behind. Every pool entry carries weight 1 and a roll never repeats
/// a key, which makes the category draw a uniform 4-subset: the sets holding
/// all three stuns are the `n - 3` ways to fill the one remaining slot, out of
/// `C(n, 4)`. On stock v2.0.2 that is 20/8855 × 0.01³ — 1 in 442,750,000.
///
/// Derived once: the answer is a property of the baked tables, not of the
/// build being audited.
fn triple_stun_chance() -> f64 {
    static CHANCE: std::sync::OnceLock<f64> = std::sync::OnceLock::new();
    *CHANCE.get_or_init(|| {
        let tables = stock_tables();
        let pool_size = tables.pools.get(LV1_TIER).map_or(0, Vec::len) as u64;
        if pool_size < OVERMASTERY_SLOT_COUNT as u64 {
            return 0.0;
        }

        // C(n, 4) = n(n-1)(n-2)(n-3)/24, as a falling product so no factorial
        // overflows. Both literals are the slot count: 4 terms, and 4! = 24.
        // Non-zero by the guard above, so there is nothing further to check.
        let subsets = (pool_size - 3..=pool_size).product::<u64>() / 24;
        let with_all_three = pool_size - MAXED_STUN_COUNT as u64;

        let total: u32 = tables.level_weights.iter().map(|row| row[LV1_TIER]).sum();
        let top = tables.level_weights.last().map_or(0, |row| row[LV1_TIER]);
        if total == 0 {
            return 0.0;
        }
        let top_level = f64::from(top) / f64::from(total);

        with_all_three as f64 / subsets as f64 * top_level.powi(MAXED_STUN_COUNT as i32)
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
/// which cannot conclude "three maxed stuns" from a value it never saw.
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
    // when all three stuns are affirmatively proven maxed, so a path that forgets
    // to speak fails CLOSED (no finding). A `bool` set false on each rejection
    // fails OPEN — one forgotten branch is a false accusation, which is the one
    // outcome this module exists to prevent.
    let mut maxed_stuns = 0usize;

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

        // Only maxed STUNS count toward the tally (user, 2026-08-01). The
        // report used to take any four maxed chased effects, which a Lv3
        // meditation lands once in 62,872 rolls — reachable by a patient player
        // running this app's own Overmastery Predictor, so it had stopped
        // telling cheats apart from users. Three maxed stuns is the one
        // perfection nobody can reach: it exists only in the Lv1 pool, at 1 in
        // 442,750,000, and prediction buys no shortcut because every roll must
        // still be paid for to advance the RNG stream.
        let top = param.values[param.values.len() - 1];
        if (top - mastery.value).abs() < EPSILON && STUN_IDS.contains(&mastery.id) {
            maxed_stuns += 1;
        }
    }

    if maxed_stuns == MAXED_STUN_COUNT {
        findings.push(Finding {
            rule: Rule::OvermasteryAllMaxed,
            subject: Subject::Overmasteries,
            observed: Value::Count(MAXED_STUN_COUNT),
            // Nothing is being exceeded here: three maxed stuns are a legal
            // roll, merely an improbable one, so there is no allowed value to
            // name and `odds` is the payload.
            allowed: Value::None,
            odds: Some(triple_stun_chance()),
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
    /// The three Stun Power Up ids, all on the 0.1,0.1,0.2,…,2.0 ladder.
    /// `STUN` is the one the Lv2 and Lv3 pools also carry; the other two are
    /// Lv1-only, which is what makes a set of three self-identifying.
    const STUN: u32 = 0x6cb38ef3;
    const STUN_B: u32 = 0xa354_5ca1;
    const STUN_C: u32 = 0x59fb_b7d8;

    /// Damage Cap Ups, on the 1,1,2,4,6,8,10,12,16,20 ladder. Maxed, they used
    /// to complete the old four-chased-effects trigger.
    const NA_DMG_CAP: u32 = 0x43b7_581d;
    const SKILL_DMG_CAP: u32 = 0x9c55_5433;

    /// The trigger: all three Stun Power Ups at the top of their ladder, with
    /// a fourth slot the rule does not care about.
    fn three_maxed_stuns() -> OvermasteryInfo {
        info(&[(STUN, 2.0), (STUN_B, 2.0), (STUN_C, 2.0), (HEALTH, 600.0)])
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

    /// THE RESCOPING (user, 2026-08-01). Four maxed rolls out of the chased
    /// five used to be the trigger, at 1 in 62,872 on a Lv3 meditation — odds a
    /// player running this app's own Overmastery Predictor can actually reach,
    /// so the report had stopped separating cheats from patient users. It is
    /// now deliberately silent.
    #[test]
    fn four_maxed_chased_effects_are_no_longer_flagged() {
        let info = info(&[
            (ATTACK, 1000.0),
            (STUN, 2.0),
            (NA_DMG_CAP, 20.0),
            (SKILL_DMG_CAP, 20.0),
        ]);
        assert_eq!(
            audit_overmastery(Some(&info)),
            vec![],
            "the old four-chased-effects trigger still fires"
        );
    }

    /// The trigger: three maxed Stun Power Ups. Only the Lv1 pool carries three
    /// stun ids, so this set names its own meditation size, and at 1 in 442.75
    /// million per roll no amount of prediction reaches it — every roll must
    /// still be paid for to advance the stream.
    #[test]
    fn flags_three_maxed_stuns() {
        let findings = audit_overmastery(Some(&three_maxed_stuns()));
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, Rule::OvermasteryAllMaxed);
        // The claim is about the whole set, so the subject is the whole set —
        // pointing at slot 0 made the audit page display a single overmastery.
        assert_eq!(findings[0].subject, Subject::Overmasteries);
        let odds = findings[0].odds.expect("maxed roll reports odds");
        // 20/8855 category draws × 0.01³ level draws, on a small meditation.
        let expected = 20.0 / 8855.0 * 0.01_f64.powi(3);
        assert!((odds - expected).abs() < 1e-15, "odds were {odds}");
        // Three stuns at maximum is the observation. There is no ceiling being
        // exceeded — the roll is legal, merely improbable — so `allowed` names
        // nothing and `odds` carries the real payload.
        assert_eq!(findings[0].observed, Value::Count(MAXED_STUN_COUNT));
        assert_eq!(findings[0].allowed, Value::None);
    }

    /// The near-miss the threshold exists for. Two maxed stuns beside two other
    /// maxed effects is an ordinary lucky set.
    #[test]
    fn two_maxed_stuns_are_not_flagged() {
        let info = info(&[(STUN, 2.0), (STUN_B, 2.0), (ATTACK, 1000.0), (CRIT, 20.0)]);
        assert_eq!(audit_overmastery(Some(&info)), vec![]);
    }

    /// All three stun ids are present, so only the LEVEL can hold the rule
    /// back — which is what makes this a test of the top-of-ladder condition
    /// rather than of the count.
    #[test]
    fn three_stuns_below_the_top_are_not_flagged() {
        let info = info(&[(STUN, 2.0), (STUN_B, 2.0), (STUN_C, 1.6), (HEALTH, 600.0)]);
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

    /// "Three maxed stuns" cannot be concluded from a magnitude that was never
    /// read. Two maxed stuns beside an unread third must stay silent.
    #[test]
    fn an_unread_stun_cannot_complete_the_count() {
        let mut info = three_maxed_stuns();
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
            // The other three are maxed STUNS, so nothing but the sentinel
            // guard itself can be keeping the all-maxed rule quiet.
            let mut info = three_maxed_stuns();
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
