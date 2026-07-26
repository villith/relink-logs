//! Transmarvel roll simulation: pure function of (rng state, tables).
//!
//! Port of the transmutation-shop roll (v2.0.2, reverse-engineered from
//! ui::fsm::action::GemGacha's exec virtual FUN_141bb6610 — see
//! docs/superpowers/specs/2026-07-26-transmarvel-searcher-design.md).
//! Per roll the game overrides every RNG draw to slot 4 (transmarvel's
//! per-tier slot): three pick draws (gem-vs-wrightstone, rate group, item
//! within the group's lot), then grant-path draws. For a gem whose config
//! rolls a random 2nd trait (`second_trait_lot >= 0`) that's 2 more draws —
//! the grant (FUN_14033dbc0 -> FUN_140305770, v2.0.2) walks the item's
//! skill_type_lot row with one draw and picks uniformly inside the chosen
//! skill_lot with the next; sigils with a fixed pair or no 2nd trait
//! (`-1`) draw nothing. A wrightstone takes 9 trailing draws (3 traits ×
//! 3). All of this is live-validated: two 8-roll sessions (2026-07-26)
//! reproduce every item AND every rolled gem 2nd trait (7/7), with exact
//! total draw accounting (54 and 47).
//!
//! Knowingly unmodeled, pending more RE:
//! - Wrightstone trait VALUES: the 9 draws advance the stream correctly but
//!   the picks go through availability-filtered, weighted skill.tbl walks
//!   (plus the player's owned-unique exclusions) that are not yet decoded.
//!   Both observed stones were base-tier; rarer tiers' draw counts are
//!   assumed equal until seen live.
//! - The item availability filter (quest gates, owned uniques). The live
//!   sessions matched with NO filtering — including duplicate character
//!   sigils — so it is deliberately left out until a roll proves otherwise.
//! - Plain V+ sigils roll their 2nd trait from skill_type_lot 26 in this
//!   path, overriding their gem.tbl value — empirical, baked by the
//!   generator (see scripts/gen-transmarvel-tables.py).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

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
    /// Fixed traits from gem.tbl (0 = none). Wrightstones have neither.
    pub trait1: u32,
    pub trait2: u32,
    /// skill_type_lot key the random 2nd trait rolls from; -1 = no roll
    /// (fixed pair or single-trait item — 2 fewer draws consumed).
    pub second_trait_lot: i32,
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
    /// skill_type_lot rows the gem pool references: key -> (skill lot,
    /// percent) options, walked cumulatively in order by one draw.
    pub skill_type_rows: HashMap<i32, Vec<(u32, u32)>>,
    /// skill_lot groups: lot hash -> trait hashes in table order (weights
    /// all 1, so the pick is uniform by index).
    pub skill_lots: HashMap<u32, Vec<u32>>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TransmarvelOutcome {
    #[serde(rename_all = "camelCase")]
    Sigil {
        sigil_id: u32,
        trait_level: u32,
        /// The sigil's intrinsic trait (hash into `traits.json`; 0 = none).
        trait1: u32,
        /// Second trait: rolled (2 draws) or fixed by the item; None when
        /// the item has none.
        trait2: Option<u32>,
    },
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
        // Random 2nd trait (see module docs): one draw walks the item's
        // skill_type_lot row, one picks uniformly inside the chosen lot.
        let trait2 = match t.skill_type_rows.get(&item.second_trait_lot) {
            Some(opts) if item.second_trait_lot >= 0 => {
                let total: u32 = opts.iter().map(|&(_, p)| p).sum();
                let lot = weighted_pick(draw() % total, opts.iter().map(|o| (o, o.1)))
                    .expect("weighted_pick with r < total always lands")
                    .0;
                let skills = &t.skill_lots[&lot];
                Some(skills[draw() as usize % skills.len()])
            }
            _ => (item.trait2 != 0).then_some(item.trait2),
        };
        TransmarvelOutcome::Sigil {
            sigil_id: item.item,
            trait_level: item.trait_level,
            trait1: item.trait1,
            trait2,
        }
    } else {
        // Wrightstone grant draws: 3 traits x 3; values not yet decoded but
        // the stream advance is exact (live-validated).
        for _ in 0..9 {
            draw();
        }
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
        // 2nd-trait config: every referenced type row resolves, its percents
        // total 100 (the roll is % total), and its lots exist. The plain-V+
        // lots carry the empirical gacha override (row 26, live-derived).
        for i in t.gem_groups.iter().flat_map(|g| &g.items) {
            if i.second_trait_lot >= 0 {
                let opts = &t.skill_type_rows[&i.second_trait_lot];
                assert_eq!(opts.iter().map(|&(_, p)| p).sum::<u32>(), 100);
                for &(lot, _) in opts {
                    assert!(t.skill_lots.contains_key(&lot), "missing lot {lot:#x}");
                }
            }
        }
        assert!(t.gem_groups[0].items.iter().all(|i| i.second_trait_lot == 26));
        assert!(t.gem_groups[1].items.iter().all(|i| i.second_trait_lot == 26));
        // Character sigils roll from row 15; awakening _90s have fixed pairs.
        assert!(t.gem_groups[5].items.iter().all(|i| i.second_trait_lot == 15));
        assert!(t.gem_groups[8]
            .items
            .iter()
            .any(|i| i.second_trait_lot == -1 && i.trait2 != 0));
        // Wrightstones have no gem config.
        for i in t.stone_groups.iter().flat_map(|g| &g.items) {
            assert_eq!((i.trait1, i.trait2, i.second_trait_lot), (0, 0, -1));
        }
    }

    /// Hand-stepped reference against the stock tables, seed 1. The
    /// xorshift32 sequence from 1 is 0x1000a001, 0x45000201, 0x451080a1
    /// (pinned in game-reader's tests):
    ///   d1 = 0x1000a001 % 100 = 17 < 75             -> gem
    ///   d2 = 0x45000201 % 10000 = 8417              -> walks past 640+4940+20+
    ///        420+280+1000+1000 = 8300 into group 7 (F527EF32, 28 items)
    ///   d3 = 0x451080a1 % 1400 = 809, 809/50 = 16   -> item index 16
    /// then the 2 grant draws roll the 2nd trait from type row 15:
    ///   d4 = 0x10150a23 % 100 = 27 -> lot 4ce7152c (ATK/HP/Crit/Stun)
    ///   d5 = 0x2814b28b % 4        -> trait 0xceb700ee
    /// NOTE: pins the simulation's arithmetic, not the game — live validation
    /// is the separate live-session test.
    #[test]
    fn seed_1_reference_roll() {
        let t = stock_tables();
        let mut s = 1u32;
        let roll = predict_roll(&mut s, t);
        assert_eq!(s, 0x2814b28b);
        assert_eq!(roll.draws, 5);
        assert_eq!(t.gem_groups[7].lot, 0xF527EF32);
        let expect = &t.gem_groups[7].items[16];
        assert_eq!(
            roll.outcome,
            TransmarvelOutcome::Sigil {
                sigil_id: expect.item,
                trait_level: expect.trait_level,
                trait1: 0x7440_e869,
                trait2: Some(0xceb7_00ee),
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
        assert_eq!(roll.draws, 12);
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

    /// LIVE ground truth, 2026-07-26 (game v2.0.2): 8 consecutive real rolls
    /// at Siero's from slot-4 state 0x39633789, all outcomes user-verified,
    /// slot advanced by exactly 54 draws to 0xa3738437. Items by lang name:
    /// Vitality Wrightstone ×2, Attack Power V+, War Elemental+, Aegis V+,
    /// Supreme Primarch's Nimbus+, Spirit Edge's Rally+, Ebony's Presence+.
    /// (2nd traits were not recorded for this batch — items and draw counts
    /// are the assertions; the next batch pins the traits.)
    #[test]
    fn live_session_2026_07_26_reproduced() {
        let t = stock_tables();
        let rolls = simulate(0x3963_3789, t, 8);
        let got: Vec<(u32, u32)> = rolls
            .iter()
            .map(|r| match r.outcome {
                TransmarvelOutcome::Sigil { sigil_id, .. } => (sigil_id, r.draws),
                TransmarvelOutcome::Wrightstone { item, .. } => (item, r.draws),
            })
            .collect();
        assert_eq!(
            got,
            vec![
                (0x3EF6_DEF5, 12), // Vitality Wrightstone
                (0x2D7F_2E70, 5),  // Attack Power V+
                (0x3EF6_DEF5, 12), // Vitality Wrightstone
                (0x0061_2B10, 5),  // War Elemental+
                (0x9C23_99DA, 5),  // Aegis V+
                (0x7E3A_52A3, 5),  // Supreme Primarch's Nimbus+
                (0x12DF_D310, 5),  // Spirit Edge's Rally+
                (0xFB0F_9037, 5),  // Ebony's Presence+
            ]
        );
        let mut s = 0x3963_3789u32;
        for _ in 0..54 {
            s = xorshift32(s);
        }
        assert_eq!(s, 0xa373_8437, "54 draws end at the observed post-state");
    }

    /// LIVE ground truth, 2026-07-26 second batch (game v2.0.2): the next 8
    /// rolls from 0xa3738437, all items AND all seven rolled second traits
    /// user-verified in game (+47 draws to 0xd2d9d59c). Trait hashes are
    /// `traits.json` keys: Aegis, Uplift, Dodge Payback, Steady Focus,
    /// Held Under Resistance, (stone), SBA Sealed Resistance, Provoke.
    #[test]
    fn live_session_2026_07_26_batch2_traits_reproduced() {
        let t = stock_tables();
        let rolls = simulate(0xa373_8437, t, 8);
        let gem = |r: &TransmarvelRoll| match r.outcome {
            TransmarvelOutcome::Sigil {
                sigil_id, trait2, ..
            } => (sigil_id, trait2, r.draws),
            _ => panic!("expected a sigil, got {:?}", r.outcome),
        };
        assert_eq!(gem(&rolls[0]), (0xA0F9_4F69, Some(0xE0AB_FDFE), 5)); // Holy Knight's Luster+ / Aegis
        assert_eq!(gem(&rolls[1]), (0xDBE5_03C7, Some(0xB5FF_9FD3), 5)); // Dark Huntress's Surge+ / Uplift
        assert_eq!(gem(&rolls[2]), (0xBB49_C8F6, Some(0x7C2E_4D64), 5)); // Guts V+ / Dodge Payback
        assert_eq!(gem(&rolls[3]), (0xD4EB_B836, Some(0x0053_599E), 5)); // Stronghold V+ / Steady Focus
        assert_eq!(gem(&rolls[4]), (0xDBE5_03C7, Some(0x1DC9_D7E7), 5)); // Dark Huntress's Surge+ / Held Under Res
        let TransmarvelOutcome::Wrightstone { item, .. } = rolls[5].outcome else {
            panic!("expected the wrightstone");
        };
        assert_eq!((item, rolls[5].draws), (0x7117_3866, 12)); // Vitality Wrightstone
        assert_eq!(gem(&rolls[6]), (0x0523_A202, Some(0xCFB4_8782), 5)); // The Black's Mark+ / SBA Sealed Res
        assert_eq!(gem(&rolls[7]), (0xE845_4459, Some(0x6018_372B), 5)); // Stamina V+ / Provoke
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
                        trait1: 3,
                        trait2: Some(4),
                    },
                    draws: 5,
                },
                TransmarvelRoll {
                    outcome: TransmarvelOutcome::Wrightstone {
                        item: 6,
                        traits: vec![(7, 8)],
                    },
                    draws: 9,
                },
            ],
            slot: 10,
            slot_state: 11,
            unpredictable: false,
        };
        assert_eq!(
            serde_json::to_value(&p).unwrap(),
            serde_json::json!({
                "rolls": [
                    {
                        "outcome": {
                            "type": "sigil", "sigilId": 1, "traitLevel": 2,
                            "trait1": 3, "trait2": 4,
                        },
                        "draws": 5,
                    },
                    { "outcome": { "type": "wrightstone", "item": 6, "traits": [[7, 8]] }, "draws": 9 },
                ],
                "slot": 10,
                "slotState": 11,
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
