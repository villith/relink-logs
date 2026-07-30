//! Wrightstone legality: the slot-ceiling rule (user rule: no trait level
//! above 20/15/10).
//!
//! The rule avoids the wrightstone item id on purpose: remote players sync
//! the stone's trait pairs but never its id, so an id-based rule would accuse
//! honest players. Each of the three trait levels — in their true, physical
//! slot order (primary, secondary1, secondary2) — must fit under that slot's
//! own ceiling (20/15/10).
//!
//! There is deliberately NO primary-trait rule: the four family traits are
//! derived from the transmarvel gacha configs, which say nothing about
//! stones from other sources — accusing a stone for its primary trait would
//! rest on a table that does not claim to cover it.

use protocol::WeaponState;

use crate::transmarvel;

use super::{Finding, Rule, Severity, Subject, Value};

/// Highest level any weight row permits: index `n` carries level `n + 1`.
/// `None` when the lot grants no level at all.
pub fn max_level_of(weights: &[u32]) -> Option<u32> {
    weights
        .iter()
        .rposition(|&weight| weight > 0)
        .map(|index| index as u32 + 1)
}

/// The three level-lot ids a stone config's slots roll from, slot 0 first.
fn slot_lots(config: &transmarvel::StoneConfig) -> [i32; 3] {
    [
        config.trait1_level_lot,
        config.slots[0].level_lot,
        config.slots[1].level_lot,
    ]
}

/// The max level a single level-lot id permits. Lot `0` is the sentinel the
/// top (0.1%) tier uses for its fully-fixed slots, so it legitimately has no
/// row in `skill_level_lots`; anything else missing is a schema drift in the
/// baked tables, not absent live data, and must fail loudly rather than
/// silently under-deriving the ceiling (see the module-level safety note).
fn ceiling_for_lot(tables: &transmarvel::TransmarvelTables, lot: i32) -> u32 {
    if lot == 0 {
        0
    } else {
        tables
            .skill_level_lots
            .get(&lot)
            .and_then(|weights| max_level_of(weights))
            .unwrap_or_else(|| panic!("stock wrightstone lot {lot} missing from skill_level_lots"))
    }
}

/// The per-slot ceiling across a set of stone configs: the max is safe here
/// only because `0` is a non-contributing sentinel (real trait levels start
/// at 1, so `0` can never win the `.max()`).
fn ceilings_for<'a>(
    tables: &transmarvel::TransmarvelTables,
    configs: impl Iterator<Item = &'a transmarvel::StoneConfig>,
) -> [u32; 3] {
    let mut ceilings = [0_u32; 3];
    for config in configs {
        for (slot, lot) in slot_lots(config).into_iter().enumerate() {
            ceilings[slot] = ceilings[slot].max(ceiling_for_lot(tables, lot));
        }
    }
    ceilings
}

/// The highest legal level per slot, slot 0 first, derived once from the baked
/// transmarvel tables.
pub fn stock_slot_ceilings() -> [u32; 3] {
    static CEILINGS: std::sync::OnceLock<[u32; 3]> = std::sync::OnceLock::new();
    *CEILINGS.get_or_init(|| {
        let tables = transmarvel::stock_tables();
        ceilings_for(tables, tables.stone_configs.values())
    })
}

/// The game engraves exactly three traits on a wrightstone. A shorter list is
/// a partial remote read, not a shorter stone.
const STONE_TRAIT_COUNT: usize = 3;

/// The slot-ceiling rule. Silent unless all three trait pairs arrived.
pub fn audit_wrightstone(state: Option<&WeaponState>) -> Vec<Finding> {
    let Some(state) = state else {
        return Vec::new();
    };
    if state.wrightstone_traits.len() != STONE_TRAIT_COUNT {
        return Vec::new();
    }

    let ceilings = stock_slot_ceilings();

    // Traits arrive in true physical slot order — index 0 is the primary
    // (cap 20), 1 is secondary1 (cap 15), 2 is secondary2 (cap 10). This is
    // confirmed independently by `WeaponState`'s doc comment and by the
    // hook's fixed read order; a shorter vector (already rejected above by
    // the length guard) is the only way slot identity could be lost, so
    // once three pairs arrive, index really does mean slot. The check is
    // therefore positional, NOT sorted: a low primary must not be allowed
    // to "absorb" a secondary slot's excess by comparing against the wrong
    // ceiling once shuffled.
    let over_ceiling = state
        .wrightstone_traits
        .iter()
        .zip(ceilings)
        .any(|(pair, ceiling)| pair.level > ceiling);

    if !over_ceiling {
        return Vec::new();
    }

    vec![Finding {
        rule: Rule::WrightstoneTraitLevel,
        severity: Severity::Impossible,
        subject: Subject::Wrightstone,
        observed: Value::Levels(state.wrightstone_traits.iter().map(|p| p.level).collect()),
        allowed: Value::Levels(ceilings.to_vec()),
        odds: None,
    }]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_twenty_fifteen_ten_ceiling() {
        assert_eq!(stock_slot_ceilings(), [20, 15, 10]);
    }

    /// The global ceiling takes a max across all 12 configs per slot, which
    /// is only sound if no family has a genuinely lower cap hiding behind a
    /// higher-capped sibling. Assert every family derives the identical
    /// ceiling the global one does; a divergence here would mean the
    /// single-global-ceiling model itself is wrong, not just this test.
    #[test]
    fn family_ceilings_agree_with_the_global_ceiling() {
        let tables = transmarvel::stock_tables();
        let global = stock_slot_ceilings();

        let mut by_family: std::collections::HashMap<u32, Vec<&transmarvel::StoneConfig>> =
            std::collections::HashMap::new();
        for config in tables.stone_configs.values() {
            by_family.entry(config.trait1).or_default().push(config);
        }
        assert_eq!(by_family.len(), 4);

        for (trait1, configs) in by_family {
            let family_ceilings = ceilings_for(tables, configs.into_iter());
            assert_eq!(
                family_ceilings, global,
                "family {trait1:08x} ceiling {family_ceilings:?} diverges from the global {global:?}"
            );
        }
    }

    #[test]
    fn max_level_reads_highest_set_bit() {
        // Weight at index 9 means level 10; index 14 means level 15.
        let mut weights = vec![0_u32; 20];
        weights[9] = 1;
        weights[14] = 1;
        assert_eq!(max_level_of(&weights), Some(15));
        assert_eq!(max_level_of(&[0; 20]), None);
        // The contract is general over any length, not just the stock
        // 20-wide row.
        assert_eq!(max_level_of(&[0, 1, 0, 0, 1, 0, 0]), Some(5));
    }

    use protocol::WeaponTraitPair;

    fn stone(traits: &[(u32, u32)]) -> WeaponState {
        WeaponState {
            weapon_id: 0,
            exp: 0,
            star_level: 0,
            plus_marks: 0,
            awakening_level: 0,
            wrightstone_id: 0,
            wrightstone_traits: traits
                .iter()
                .map(|&(id, level)| WeaponTraitPair { id, level })
                .collect(),
            innate_traits: Vec::new(),
        }
    }

    /// HP is the Fortification family trait; 20/15/10 is the legal maximum.
    #[test]
    fn legal_maxed_stone_yields_no_findings() {
        let state = stone(&[(0xf372f096, 20), (0xdc584f60, 15), (0x57ab5b10, 10)]);
        assert_eq!(audit_wrightstone(Some(&state)), vec![]);
    }

    #[test]
    fn flags_level_above_ceiling() {
        let state = stone(&[(0xf372f096, 25), (0xdc584f60, 15), (0x57ab5b10, 10)]);
        let findings = audit_wrightstone(Some(&state));
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, Rule::WrightstoneTraitLevel);
        assert_eq!(findings[0].severity, Severity::Impossible);
        assert_eq!(findings[0].observed, Value::Levels(vec![25, 15, 10]));
        assert_eq!(findings[0].allowed, Value::Levels(vec![20, 15, 10]));
    }

    /// Slot position decides legality, not sorted value: this fixture put a
    /// level-20 trait in the secondary1 slot (cap 15), which only passed
    /// under the old sorted comparison — a low primary (10) was absorbing
    /// the excess. Positional checking must flag it.
    #[test]
    fn flags_a_secondary_slot_above_its_own_ceiling() {
        let state = stone(&[(0x57ab5b10, 10), (0xf372f096, 20), (0xdc584f60, 15)]);
        let findings = audit_wrightstone(Some(&state));
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, Rule::WrightstoneTraitLevel);
        assert_eq!(findings[0].severity, Severity::Impossible);
        assert_eq!(findings[0].observed, Value::Levels(vec![10, 20, 15]));
        assert_eq!(findings[0].allowed, Value::Levels(vec![20, 15, 10]));
    }

    /// The primary need not be the highest-leveled trait: here the max (15)
    /// falls on secondary1, not the primary. This guards against a
    /// plausible positional bug — assuming the primary slot always carries
    /// the highest engraved level (true of the canonical maxed example, but
    /// not in general) and checking that assumed value in place of
    /// `wrightstone_traits[0].level`, rather than each slot's own level
    /// against its own ceiling.
    #[test]
    fn primary_slot_level_is_checked_against_its_own_ceiling_not_the_max() {
        let state = stone(&[(0xf372f096, 5), (0xdc584f60, 15), (0x57ab5b10, 10)]);
        assert_eq!(audit_wrightstone(Some(&state)), vec![]);
    }

    /// There is no primary-trait rule any more: a stone whose traits sit
    /// outside the four gacha families is legal as far as this module can
    /// know (the gacha configs say nothing about stones from other sources).
    /// Levels are still judged on such a stone.
    #[test]
    fn primary_trait_is_never_judged() {
        let legal_levels = stone(&[(0xdc584f60, 20), (0x57ab5b10, 15), (0x95f3fa86, 10)]);
        assert_eq!(audit_wrightstone(Some(&legal_levels)), vec![]);

        let over_cap = stone(&[(0xdc584f60, 25), (0x57ab5b10, 15), (0x95f3fa86, 10)]);
        let findings = audit_wrightstone(Some(&over_cap));
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, Rule::WrightstoneTraitLevel);
        assert_eq!(findings[0].observed, Value::Levels(vec![25, 15, 10]));
    }

    #[test]
    fn stays_silent_without_a_weapon_state() {
        assert_eq!(audit_wrightstone(None), vec![]);
    }

    #[test]
    fn stays_silent_when_no_stone_is_equipped() {
        assert_eq!(audit_wrightstone(Some(&stone(&[]))), vec![]);
    }

    /// A remote player can report fewer than three pairs; judge only what
    /// arrived rather than assuming the rest are zero.
    #[test]
    fn stays_silent_on_a_partial_remote_read() {
        assert_eq!(audit_wrightstone(Some(&stone(&[(0xf372f096, 20)]))), vec![]);
    }
}
