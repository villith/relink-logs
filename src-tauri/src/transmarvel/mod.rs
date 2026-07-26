//! Transmarvel roll simulation: pure function of (rng state, tables).
//!
//! Port of the transmutation-shop roll (v2.0.2, reverse-engineered from
//! ui::fsm::action::GemGacha's exec virtual FUN_141bb6610 — see
//! docs/superpowers/specs/2026-07-26-transmarvel-searcher-design.md).
//! Per roll the game overrides every RNG draw to slot 4 (transmarvel's
//! per-tier slot) and consumes three draws: gem-vs-wrightstone, rate group,
//! item within the group's lot. The hook takes the slot state in-process
//! (game-reader crate, served over the toolbox RPC channel); everything here
//! is deterministic and unit-testable.
//!
//! Two knowingly-unmodeled inputs, pending live reconciliation:
//! - Wrightstone trait/level rolls happen in the grant path (skill_*_lot
//!   tables) and their draw count is unmeasured, so predictions after a
//!   wrightstone outcome may need resyncing.
//! - The availability filter drops quest-locked items and owned uniques
//!   (character sigils); the simulation currently assumes everything is
//!   available.

use serde::{Deserialize, Serialize};

pub use game_reader::transmarvel::{TransmarvelSnapshot, TM_SLOT};
pub use game_reader::xorshift32;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LotItem {
    /// Item id hash — GEEN_* (translatable via `sigils.json`) for gems,
    /// ITEM_* (`items.json`) for wrightstones.
    pub item: u32,
    pub weight: u32,
    /// Granted trait level (character sigils: 15; "level from item" rows: 0).
    pub trait_level: u32,
    /// Quest gate (0 = ungated): the item only drops once this quest cleared.
    pub quest_id_min: u32,
    pub quest_id_max: u32,
    pub needs_endless_ragnarok: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RateGroup {
    /// gacha_lot Key hash.
    pub lot: u32,
    pub weight: u32,
    /// The lot's items, in table order (the pick walks this order).
    pub items: Vec<LotItem>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransmarvelTables {
    pub gem_chance_percent: u32,
    pub wrightstone_chance_percent: u32,
    /// Rate groups in table order (weights sum to 10000).
    pub gem_groups: Vec<RateGroup>,
    pub stone_groups: Vec<RateGroup>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TransmarvelOutcome {
    #[serde(rename_all = "camelCase")]
    Sigil { sigil_id: u32, trait_level: u32 },
    #[serde(rename_all = "camelCase")]
    Wrightstone {
        item: u32,
        /// (trait hash, level) — empty until the grant-path trait roll is
        /// reverse-engineered; the stone item itself is still exact.
        traits: Vec<(u32, u32)>,
    },
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TransmarvelRoll {
    pub outcome: TransmarvelOutcome,
    /// Draws consumed (for advancing to the next roll's state).
    pub draws: u32,
}

/// Cumulative weighted pick in table order, the game's shape: subtract each
/// weight until the draw undershoots one. `None` on a zero total (nothing
/// eligible — cannot happen with stock tables).
fn weighted_pick<'a, T>(mut r: u32, entries: impl Iterator<Item = (&'a T, u32)>) -> Option<&'a T> {
    for (entry, w) in entries {
        if r < w {
            return Some(entry);
        }
        r -= w;
    }
    None
}

/// Simulate one transmarvel roll. Advances `state` exactly as RNG slot 4
/// would (the roll's slot override redirects every draw there).
pub fn predict_roll(state: &mut u32, t: &TransmarvelTables) -> TransmarvelRoll {
    let mut draws = 0u32;
    let mut draw = || {
        *state = xorshift32(*state);
        draws += 1;
        *state
    };

    // Draw 1: gem vs wrightstone.
    let is_gem = draw() % 100 < t.gem_chance_percent;
    let groups = if is_gem { &t.gem_groups } else { &t.stone_groups };

    // Draw 2: rate group, cumulative over the group weights (sum 10000).
    let total: u32 = groups.iter().map(|g| g.weight).sum();
    let group = weighted_pick(draw() % total, groups.iter().map(|g| (g, g.weight)))
        .expect("weighted_pick with r < total always lands");

    // Draw 3: item within the lot (stock weights all 50 = uniform).
    let total: u32 = group.items.iter().map(|i| i.weight).sum();
    let item = weighted_pick(draw() % total, group.items.iter().map(|i| (i, i.weight)))
        .expect("weighted_pick with r < total always lands");

    let outcome = if is_gem {
        TransmarvelOutcome::Sigil {
            sigil_id: item.item,
            trait_level: item.trait_level,
        }
    } else {
        TransmarvelOutcome::Wrightstone {
            item: item.item,
            traits: Vec::new(),
        }
    };
    TransmarvelRoll { outcome, draws }
}

/// Simulate `rolls` consecutive rolls starting from `state`.
pub fn simulate(mut state: u32, t: &TransmarvelTables, rolls: u32) -> Vec<TransmarvelRoll> {
    (0..rolls).map(|_| predict_roll(&mut state, t)).collect()
}

/// Status for the tool's banner (mirrored in src/types.ts).
#[derive(Serialize, Debug, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct TransmarvelStatus {
    pub game_running: bool,
    pub rng_unpredictable: bool,
}

#[derive(Deserialize, Debug, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct TransmarvelQuery {
    pub rolls: u32,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TransmarvelPrediction {
    pub rolls: Vec<TransmarvelRoll>,
    /// The RNG slot predictions came from — the frontend staleness watch
    /// polls it via the generic `fetch_overmastery_seed(slot)`.
    pub slot: u32,
    pub slot_state: u32,
    pub unpredictable: bool,
}

/// The stock v2.0.2 tables, baked from the game's gacha .tbl files by
/// scripts/gen-transmarvel-tables.py.
pub fn stock_tables() -> &'static TransmarvelTables {
    static TABLES: std::sync::OnceLock<TransmarvelTables> = std::sync::OnceLock::new();
    TABLES.get_or_init(|| {
        serde_json::from_str(include_str!("../../assets/transmarvel-tables.json"))
            .expect("transmarvel-tables.json matches TransmarvelTables")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The baked stock tables parse and look like v2.0.2: 75/25 split, 9 gem
    /// groups and 3 stone groups each summing to 10000, lots in table order
    /// with flat weight 50.
    #[test]
    fn stock_tables_shape() {
        let t = stock_tables();
        assert_eq!(t.gem_chance_percent, 75);
        assert_eq!(t.wrightstone_chance_percent, 25);
        assert_eq!(t.gem_groups.iter().map(|g| g.weight).sum::<u32>(), 10000);
        assert_eq!(t.stone_groups.iter().map(|g| g.weight).sum::<u32>(), 10000);
        assert_eq!(
            t.gem_groups.iter().map(|g| g.items.len()).collect::<Vec<_>>(),
            vec![4, 20, 9, 5, 8, 28, 28, 28, 32]
        );
        assert_eq!(
            t.stone_groups.iter().map(|g| g.items.len()).collect::<Vec<_>>(),
            vec![4, 4, 4]
        );
        // Group order is the cumulative pick's walk order — pin it.
        assert_eq!(t.gem_groups[0].lot, 0x81216A95);
        assert_eq!(t.gem_groups[8].lot, 0x5AD4ADAD);
        assert_eq!(t.stone_groups[0].lot, 0xFB27D2E3);
        assert_eq!(t.stone_groups[2].lot, 0xBD1CBF1C);
        for g in t.gem_groups.iter().chain(&t.stone_groups) {
            assert!(g.items.iter().all(|i| i.weight == 50));
        }
    }

    /// Hand-stepped reference against the stock tables, seed 1. The
    /// xorshift32 sequence from 1 is 0x1000a001, 0x45000201, 0x451080a1
    /// (pinned in game-reader's tests):
    ///   d1 = 0x1000a001 % 100 = 17 < 75             -> gem
    ///   d2 = 0x45000201 % 10000 = 8417              -> walks past 640+4940+20+
    ///        420+280+1000+1000 = 8300 into group 7 (F527EF32, 28 items)
    ///   d3 = 0x451080a1 % 1400 = 809, 809/50 = 16   -> item index 16
    /// NOTE: pins the simulation's arithmetic, not the game — live validation
    /// of the full pipeline is the Phase 1 exit criterion.
    #[test]
    fn seed_1_reference_roll() {
        let t = stock_tables();
        let mut s = 1u32;
        let roll = predict_roll(&mut s, t);
        assert_eq!(s, 0x451080a1);
        assert_eq!(roll.draws, 3);
        assert_eq!(t.gem_groups[7].lot, 0xF527EF32);
        let expect = &t.gem_groups[7].items[16];
        assert_eq!(
            roll.outcome,
            TransmarvelOutcome::Sigil {
                sigil_id: expect.item,
                trait_level: expect.trait_level,
            }
        );
    }

    /// A draw-1 value with d % 100 >= 75 goes down the wrightstone path and
    /// picks from the stone groups.
    #[test]
    fn stone_path_picks_from_stone_groups() {
        let t = stock_tables();
        // Find a seed whose first draw lands in the stone 25%.
        let mut seed = 1u32;
        loop {
            if xorshift32(seed) % 100 >= 75 {
                break;
            }
            seed += 1;
        }
        let mut s = seed;
        let roll = predict_roll(&mut s, t);
        assert_eq!(roll.draws, 3);
        let TransmarvelOutcome::Wrightstone { item, traits } = roll.outcome else {
            panic!("expected a wrightstone, got {:?}", roll.outcome);
        };
        assert!(traits.is_empty());
        assert!(t
            .stone_groups
            .iter()
            .flat_map(|g| &g.items)
            .any(|i| i.item == item));
    }

    /// The JSON contract src/types.ts mirrors — a rename here breaks the
    /// frontend silently, so pin the exact serialized shape.
    #[test]
    fn prediction_serializes_to_the_frontend_contract() {
        let p = TransmarvelPrediction {
            rolls: vec![
                TransmarvelRoll {
                    outcome: TransmarvelOutcome::Sigil {
                        sigil_id: 1,
                        trait_level: 2,
                    },
                    draws: 3,
                },
                TransmarvelRoll {
                    outcome: TransmarvelOutcome::Wrightstone {
                        item: 4,
                        traits: vec![(5, 6)],
                    },
                    draws: 7,
                },
            ],
            slot: 8,
            slot_state: 9,
            unpredictable: false,
        };
        assert_eq!(
            serde_json::to_value(&p).unwrap(),
            serde_json::json!({
                "rolls": [
                    { "outcome": { "type": "sigil", "sigilId": 1, "traitLevel": 2 }, "draws": 3 },
                    { "outcome": { "type": "wrightstone", "item": 4, "traits": [[5, 6]] }, "draws": 7 },
                ],
                "slot": 8,
                "slotState": 9,
                "unpredictable": false,
            })
        );
    }

    /// Consecutive rolls continue the same stream: simulating two rolls from
    /// roll A's pre-state yields roll B as the second outcome.
    #[test]
    fn successive_rolls_share_stream() {
        let t = stock_tables();
        let two = simulate(1, t, 2);
        assert_eq!(two.len(), 2);
        let mut s = 1u32;
        predict_roll(&mut s, t);
        let second = predict_roll(&mut s, t);
        assert_eq!(two[1], second);
    }
}
