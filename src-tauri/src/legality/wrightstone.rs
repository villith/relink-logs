//! Wrightstone legality (rules 1 and 2).
//!
//! Both rules avoid the wrightstone item id on purpose: remote players sync
//! the stone's trait pairs but never its id, so an id-based rule would accuse
//! honest players. Instead the primary trait must be one of the four family
//! traits, and the trait levels sorted descending must fit under 20/15/10.

use std::collections::HashSet;

use protocol::WeaponState;

use crate::transmarvel;

use super::{Finding, Rule, Severity, Subject, Value};

/// The legal wrightstone shape, derived from the stock gacha tables.
#[derive(Debug, Clone, PartialEq)]
pub struct WrightstoneRules {
    /// The fixed primary trait of each stone family.
    pub family_traits: HashSet<u32>,
    /// Highest legal level per slot, slot 0 first.
    pub slot_ceilings: [u32; 3],
}

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

/// Derived once from the baked transmarvel tables.
pub fn stock_rules() -> &'static WrightstoneRules {
    static RULES: std::sync::OnceLock<WrightstoneRules> = std::sync::OnceLock::new();
    RULES.get_or_init(|| {
        let tables = transmarvel::stock_tables();
        let family_traits: HashSet<u32> = tables
            .stone_configs
            .values()
            .map(|config| config.trait1)
            .collect();
        let slot_ceilings = ceilings_for(tables, tables.stone_configs.values());

        WrightstoneRules {
            family_traits,
            slot_ceilings,
        }
    })
}

/// The game engraves exactly three traits on a wrightstone. A shorter list is
/// a partial remote read, not a shorter stone.
const STONE_TRAIT_COUNT: usize = 3;

/// Rules 1 and 2. Silent unless all three trait pairs arrived.
pub fn audit_wrightstone(state: Option<&WeaponState>) -> Vec<Finding> {
    let Some(state) = state else {
        return Vec::new();
    };
    if state.wrightstone_traits.len() != STONE_TRAIT_COUNT {
        return Vec::new();
    }

    let rules = stock_rules();
    let mut findings = Vec::new();

    let mut levels: Vec<u32> = state
        .wrightstone_traits
        .iter()
        .map(|pair| pair.level)
        .collect();
    levels.sort_unstable_by(|a, b| b.cmp(a));

    if levels
        .iter()
        .zip(rules.slot_ceilings.iter())
        .any(|(level, ceiling)| level > ceiling)
    {
        findings.push(Finding {
            rule: Rule::WrightstoneTraitLevel,
            severity: Severity::Impossible,
            subject: Subject::Wrightstone,
            observed: Value::Levels(levels),
            allowed: Value::Levels(rules.slot_ceilings.to_vec()),
            odds: None,
        });
    }

    // A stone's primary trait always matches one of the four families. We
    // only flag when NONE of the three engraved traits is a family trait: a
    // secondary slot can legitimately roll a trait id that happens to be
    // another family's primary, so requiring exactly one would falsely
    // accuse an honest build.
    let primaries: Vec<u32> = state
        .wrightstone_traits
        .iter()
        .map(|pair| pair.id)
        .filter(|id| rules.family_traits.contains(id))
        .collect();

    if primaries.is_empty() {
        let highest = state
            .wrightstone_traits
            .iter()
            .max_by_key(|pair| pair.level)
            .map(|pair| pair.id)
            .unwrap_or(0);
        let mut allowed: Vec<u32> = rules.family_traits.iter().copied().collect();
        allowed.sort_unstable();

        findings.push(Finding {
            rule: Rule::WrightstonePrimaryTrait,
            severity: Severity::Impossible,
            subject: Subject::Wrightstone,
            observed: Value::TraitId(highest),
            allowed: Value::TraitIds(allowed),
            odds: None,
        });
    }

    findings
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_four_families_from_stock_tables() {
        let rules = stock_rules();
        assert_eq!(rules.family_traits.len(), 4);
        // Dread -> Stun Power, Vitality -> Critical Hit Rate,
        // Fortification -> HP, Sequestration -> Weak Point DMG.
        for expected in [0xceb700ee_u32, 0x8d78a19b, 0xf372f096, 0x6b694d6d] {
            assert!(
                rules.family_traits.contains(&expected),
                "missing family trait {expected:08x}"
            );
        }
    }

    #[test]
    fn derives_twenty_fifteen_ten_ceiling() {
        assert_eq!(stock_rules().slot_ceilings, [20, 15, 10]);
    }

    /// The global ceiling takes a max across all 12 configs per slot, which
    /// is only sound if no family has a genuinely lower cap hiding behind a
    /// higher-capped sibling. Assert every family derives the identical
    /// ceiling the global one does; a divergence here would mean the
    /// single-global-ceiling model itself is wrong, not just this test.
    #[test]
    fn family_ceilings_agree_with_the_global_ceiling() {
        let tables = transmarvel::stock_tables();
        let global = stock_rules().slot_ceilings;

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

    /// Trait order must not matter: the same three traits shuffled are legal.
    #[test]
    fn ignores_trait_ordering() {
        let state = stone(&[(0x57ab5b10, 10), (0xf372f096, 20), (0xdc584f60, 15)]);
        assert_eq!(audit_wrightstone(Some(&state)), vec![]);
    }

    /// DMG Cap is a real trait but never a stone family's primary.
    #[test]
    fn flags_primary_trait_outside_the_four_families() {
        let state = stone(&[(0xdc584f60, 20), (0x57ab5b10, 15), (0x95f3fa86, 10)]);
        let findings = audit_wrightstone(Some(&state));
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, Rule::WrightstonePrimaryTrait);
        assert_eq!(findings[0].observed, Value::TraitId(0xdc584f60));
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
