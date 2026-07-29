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
//! (`-1`) draw nothing. All of this is live-validated: two 8-roll sessions
//! (2026-07-26) reproduce every item AND every rolled gem 2nd trait (7/7),
//! with exact total draw accounting (54 and 47).
//!
//! A wrightstone's grant (FUN_140357250 → functor FUN_140359d60 →
//! FUN_140359e00, solved offline against a recorded 9-draw grant stream)
//! rolls its three traits from the item's item_pendulum.tbl config: trait 1
//! is a fixed family skill whose level walks a skill_level_lot row (1 draw,
//! or 0 when the config fixes it), then two slots each draw a %100 gate,
//! pick their skill exactly like the gem 2nd trait (2 draws through the
//! config's skill_type_lot row), and walk their own skill_level_lot row
//! CAPPED at the previous trait's level (descending levels). The rolled
//! gacha tiers consume 9 grant draws; the top 0.1% tier is fully fixed and
//! consumes NONE (3 draws total for the roll).
//!
//! Knowingly unmodeled, pending more RE:
//! - The item availability filter (quest gates, owned uniques). The live
//!   sessions matched with NO filtering — including duplicate character
//!   sigils — so it is deliberately left out until a roll proves otherwise.
//! - Plain V+ sigils roll their 2nd trait from skill_type_lot 26 in this
//!   path, overriding their gem.tbl value — empirical, baked by the
//!   generator (see scripts/gen-transmarvel-tables.py).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub use game_reader::transmarvel::TM_SLOT;
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
pub struct StoneSlot {
    /// Fixed skill hash; 0 = rolled through the config's type row.
    pub skill: u32,
    /// Fixed level; 0 = rolled from `level_lot`.
    pub fixed_level: u32,
    /// Gate percent for a rolled skill (draw % 100 < chance to roll it).
    pub chance: u32,
    /// skill_level_lot key for a rolled level.
    pub level_lot: i32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoneConfig {
    /// Trait 1: fixed per stone family (Dread→Stun Power, Vitality→Crit
    /// Rate, Fortification→HP, Sequestration→Weak Point DMG).
    pub trait1: u32,
    /// Trait 1 fixed level; 0 = rolled from `trait1_level_lot`.
    pub trait1_level: u32,
    pub trait1_level_lot: i32,
    /// skill_type_lot row both rolled slots pick their skill from.
    pub type_row: i32,
    pub slots: [StoneSlot; 2],
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
    /// skill_level_lot rows: key -> chance weight per level 1..=20, walked
    /// cumulatively by one draw (capped at the previous trait's level for
    /// the stone slots).
    pub skill_level_lots: HashMap<i32, Vec<u32>>,
    /// Wrightstone trait-roll configs from item_pendulum.tbl, by item hash.
    pub stone_configs: HashMap<u32, StoneConfig>,
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
        /// (trait hash, level) pairs, in slot order — always populated
        /// (0..=3 entries; exactly 3 for every gacha stone).
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

/// The 2-draw skill pick shared by gem 2nd traits and stone slots
/// (FUN_140305770): one draw walks the type row's percents cumulatively,
/// one picks uniformly by index inside the chosen skill_lot.
fn pick_skill(t: &TransmarvelTables, type_row: i32, mut draw: impl FnMut() -> u32) -> u32 {
    let opts = &t.skill_type_rows[&type_row];
    let total: u32 = opts.iter().map(|&(_, p)| p).sum();
    let lot = weighted_pick(draw() % total, opts.iter().map(|o| (o, o.1)))
        .expect("weighted_pick with r < total always lands")
        .0;
    let skills = &t.skill_lots[&lot];
    skills[draw() as usize % skills.len()]
}

/// One draw walking the first `cap` weights of a skill_level_lot row
/// cumulatively; the game skips the draw entirely on a zero total (cannot
/// happen with stock tables), mirrored here by returning `None`.
fn level_walk(weights: &[u32], cap: u32, mut draw: impl FnMut() -> u32) -> Option<u32> {
    let ws = &weights[..weights.len().min(cap as usize)];
    let total: u32 = ws.iter().sum();
    if total == 0 {
        return None;
    }
    let mut r = draw() % total;
    for (i, &w) in ws.iter().enumerate() {
        if r < w {
            return Some(i as u32 + 1);
        }
        r -= w;
    }
    unreachable!("r < total lands within the walk")
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
    let groups = if is_gem {
        &t.gem_groups
    } else {
        &t.stone_groups
    };

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
        let trait2 = if item.second_trait_lot >= 0 {
            Some(pick_skill(t, item.second_trait_lot, &mut draw))
        } else {
            (item.trait2 != 0).then_some(item.trait2)
        };
        TransmarvelOutcome::Sigil {
            sigil_id: item.item,
            trait_level: item.trait_level,
            trait1: item.trait1,
            trait2,
        }
    } else {
        // Wrightstone grant: trait 1 fixed + level, then two gated slots
        // with cascading level caps (see module docs). 9 draws for the
        // rolled tiers, 0 for the fully fixed top tier — live-validated
        // draw accounting for the rolled tiers.
        let cfg = &t.stone_configs[&item.item];
        let mut traits = Vec::with_capacity(3);
        let lvl0 = if cfg.trait1_level != 0 {
            cfg.trait1_level
        } else {
            level_walk(&t.skill_level_lots[&cfg.trait1_level_lot], 20, &mut draw).unwrap_or(0)
        };
        traits.push((cfg.trait1, lvl0));
        let mut cap = lvl0;
        for slot in &cfg.slots {
            let skill = if slot.skill != 0 {
                slot.skill
            } else {
                if draw() % 100 >= slot.chance {
                    continue; // gate failed: slot skipped, results compact
                }
                pick_skill(t, cfg.type_row, &mut draw)
            };
            let level = if slot.fixed_level != 0 {
                slot.fixed_level
            } else if cap > 1 {
                level_walk(&t.skill_level_lots[&slot.level_lot], cap, &mut draw).unwrap_or(cap)
            } else {
                cap // a level-1 (or 0) cap leaves nothing to roll
            };
            traits.push((skill, level));
            cap = level;
        }
        TransmarvelOutcome::Wrightstone {
            item: item.item,
            traits,
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
    /// polls it via the generic `fetch_rng_slot(slot)`.
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
            t.gem_groups
                .iter()
                .map(|g| g.items.len())
                .collect::<Vec<_>>(),
            vec![4, 20, 9, 5, 8, 28, 28, 28, 32]
        );
        assert_eq!(
            t.stone_groups
                .iter()
                .map(|g| g.items.len())
                .collect::<Vec<_>>(),
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
        // The row excludes the sigil's own trait's category (see the
        // generator docstring): group 0 = Attack/Health/Crit/Stun V+, whose
        // traits are all in the ATK/HP lot -> row 5.
        assert!(t.gem_groups[0]
            .items
            .iter()
            .all(|i| i.second_trait_lot == 5));
        // Group 1 holds all five categories; spot-check the spread.
        let group1_rows: std::collections::HashSet<i32> = t.gem_groups[1]
            .items
            .iter()
            .map(|i| i.second_trait_lot)
            .collect();
        assert!(
            group1_rows.is_superset(&[6, 7, 26, 27].into()),
            "{group1_rows:?}"
        );
        // Character sigils roll from row 15; awakening _90s have fixed pairs.
        assert!(t.gem_groups[5]
            .items
            .iter()
            .all(|i| i.second_trait_lot == 15));
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
                trait1: 0x4f13_5217,
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
        let TransmarvelOutcome::Wrightstone { item, traits } = roll.outcome else {
            panic!("expected a wrightstone, got {:?}", roll.outcome);
        };
        assert!(t
            .stone_groups
            .iter()
            .flat_map(|g| &g.items)
            .any(|i| i.item == item));
        // Rolled tiers take 3 + 9 draws; the fixed top tier only the 3 picks.
        let top_tier = t.stone_groups[2].items.iter().any(|i| i.item == item);
        assert_eq!(roll.draws, if top_tier { 3 } else { 12 });
        // Stock gates are 100% (or the slot is fixed), so all 3 traits land,
        // at non-increasing levels.
        assert_eq!(traits.len(), 3);
        assert!(traits.windows(2).all(|w| w[0].1 >= w[1].1), "{traits:?}");
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

    /// LIVE ground truth, 2026-07-26 third batch: 8 verified rolls from
    /// 0xd2d9d59c that pinned the category-exclusion row rule — Autorevive
    /// V+ (utility trait1 -> row 27) rolled Quick Cooldown, Celestial Lumen
    /// V+ (no category -> gem.tbl row 6) rolled Low Profile, Health V+
    /// (ATK/HP trait1 -> row 5) rolled ATK-Down Resistance, and the two
    /// defense-trait sigils (-> row 7) rolled Cascade and Autorevive.
    #[test]
    fn live_session_2026_07_26_batch3_category_rule_reproduced() {
        let t = stock_tables();
        let rolls = simulate(0xd2d9_d59c, t, 8);
        let stone = |r: &TransmarvelRoll| match r.outcome {
            TransmarvelOutcome::Wrightstone { item, .. } => (item, r.draws),
            _ => panic!("expected a wrightstone, got {:?}", r.outcome),
        };
        let gem = |r: &TransmarvelRoll| match r.outcome {
            TransmarvelOutcome::Sigil {
                sigil_id, trait2, ..
            } => (sigil_id, trait2, r.draws),
            _ => panic!("expected a sigil, got {:?}", r.outcome),
        };
        assert_eq!(stone(&rolls[0]), (0x7117_3866, 12)); // Vitality Wrightstone
        assert_eq!(gem(&rolls[1]), (0xD340_651C, Some(0x318D_12E9), 5)); // Autorevive V+ / Quick Cooldown
        assert_eq!(gem(&rolls[2]), (0x2049_2635, Some(0xDC60_7D75), 5)); // Celestial Lumen V+ / Low Profile
        assert_eq!(gem(&rolls[3]), (0xE92E_E838, Some(0x4BF2_E191), 5)); // Health V+ / ATK-Down Resistance
        assert_eq!(stone(&rolls[4]), (0x0BD3_73A4, 12)); // Sequestration Wrightstone
        assert_eq!(gem(&rolls[5]), (0xB832_E7A7, Some(0x05F2_ECDC), 5)); // Improved Guard V+ / Cascade
        assert_eq!(stone(&rolls[6]), (0xBCDB_C4B6, 12)); // Dread Wrightstone
        assert_eq!(gem(&rolls[7]), (0x381B_BE64, Some(0x95F3_FA86), 5)); // Garrison V+ / Autorevive
    }

    /// LIVE ground truth: the batch-2 stone (item 0x71173866) from its
    /// pre-roll state rolled Crit Rate 20 / Weak Point DMG 15 /
    /// Greater Aegis 10 (9 grant draws starting at 0x7804fd61).
    #[test]
    fn live_stone_traits_reproduced() {
        let t = stock_tables();
        // 25 draws (5 gems x5) precede the stone in that session; simulate
        // the whole prefix so the test pins the stream, not an offset.
        let rolls = simulate(0xa373_8437, t, 6);
        let TransmarvelOutcome::Wrightstone { item, ref traits } = rolls[5].outcome else {
            panic!("expected the wrightstone");
        };
        assert_eq!(item, 0x7117_3866);
        assert_eq!(
            *traits,
            vec![(0x8d78_a19b, 20), (0x6b69_4d6d, 15), (0x48a9_5b8d, 10)]
        );
    }

    /// The 0.1% tier stones (rows 70-73 of item_pendulum.tbl) are fully
    /// fixed: family trait @20, Aegis @15, ATK @10 — and consume ZERO grant
    /// draws (3 total), unlike the 12-draw rolled tiers.
    #[test]
    fn top_tier_stone_is_fixed_and_draws_3() {
        let t = stock_tables();
        let mut seed = 1u32;
        let roll = loop {
            let mut s = seed;
            let roll = predict_roll(&mut s, t);
            if let TransmarvelOutcome::Wrightstone { item, .. } = roll.outcome {
                if t.stone_groups[2].items.iter().any(|i| i.item == item) {
                    break roll;
                }
            }
            seed += 1;
        };
        assert_eq!(roll.draws, 3);
        let TransmarvelOutcome::Wrightstone { ref traits, .. } = roll.outcome else {
            unreachable!();
        };
        assert_eq!(traits.len(), 3);
        assert_eq!(traits[0].1, 20);
        assert_eq!(traits[1], (0xE0AB_FDFE, 15)); // Aegis
        assert_eq!(traits[2], (0x5007_9A1C, 10)); // ATK
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
