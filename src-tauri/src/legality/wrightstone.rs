//! Wrightstone legality (rules 1 and 2).
//!
//! Both rules avoid the wrightstone item id on purpose: remote players sync
//! the stone's trait pairs but never its id, so an id-based rule would accuse
//! honest players. Instead the primary trait must be one of the four family
//! traits, and the trait levels sorted descending must fit under 20/15/10.

use std::collections::HashSet;

use crate::transmarvel;

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

/// Derived once from the baked transmarvel tables.
pub fn stock_rules() -> &'static WrightstoneRules {
    static RULES: std::sync::OnceLock<WrightstoneRules> = std::sync::OnceLock::new();
    RULES.get_or_init(|| {
        let tables = transmarvel::stock_tables();
        let mut family_traits = HashSet::new();
        let mut slot_ceilings = [0_u32; 3];

        for config in tables.stone_configs.values() {
            family_traits.insert(config.trait1);

            let lots = [
                config.trait1_level_lot,
                config.slots[0].level_lot,
                config.slots[1].level_lot,
            ];
            for (slot, lot) in lots.iter().enumerate() {
                let ceiling = tables
                    .skill_level_lots
                    .get(lot)
                    .and_then(|weights| max_level_of(weights))
                    .unwrap_or(0);
                slot_ceilings[slot] = slot_ceilings[slot].max(ceiling);
            }
        }

        WrightstoneRules {
            family_traits,
            slot_ceilings,
        }
    })
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

    #[test]
    fn max_level_reads_highest_set_bit() {
        // Weight at index 9 means level 10; index 14 means level 15.
        let mut weights = vec![0_u32; 20];
        weights[9] = 1;
        weights[14] = 1;
        assert_eq!(max_level_of(&weights), Some(15));
        assert_eq!(max_level_of(&[0; 20]), None);
    }
}
