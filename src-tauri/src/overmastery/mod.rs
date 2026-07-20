//! Overmastery (meditation) roll prediction engine.
//!
//! Pure port of the game's meditation roll (v2.0.2, reverse-engineered from
//! FUN_141beb1b0 — see docs/superpowers/specs/2026-07-19-overmastery-predictor-design.md).
//! The snapshot module reads the RNG slot states and character roster from
//! game memory; everything here is deterministic and unit-testable.

pub mod snapshot;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// The game's "empty" sentinel (same constant as synthesis' EMPTY_TRAIT).
pub const EMPTY_KEY: u32 = 0x887a_e0b0;

/// RNG slot for a (character, meditation size) pair: `5 + tier*0x29 + char_idx`.
/// Char index 0 is the protagonist (PL0000/PL0100); everyone else is their
/// index in the roster vector.
pub fn rng_slot(tier: u32, char_idx: u32) -> u32 {
    5 + tier * 0x29 + char_idx
}

/// The protagonist character-id hashes (game custom-XXHash32 of "PL0000" /
/// "PL0100"); the roll special-cases them to character index 0.
pub const PROTAGONIST_IDS: [u32; 2] = [0x2a26_b1b2, 0xa4ac_ba76];

/// A character's index within the RNG slot block: protagonists are 0, other
/// characters use their position in the roster vector.
pub fn char_slot_index(roster: &[u32], char_id: u32) -> Option<u32> {
    if PROTAGONIST_IDS.contains(&char_id) {
        return Some(0);
    }
    roster.iter().position(|&id| id == char_id).map(|i| i as u32)
}

/// One step of the game's per-slot RNG (identical to synthesis).
#[inline]
pub fn xorshift32(mut s: u32) -> u32 {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 15;
    s
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TierDef {
    /// The three (num_masteries, weight) options; stock data is always
    /// [(4,100),(3,0),(2,0)].
    pub counts: [(u32, u32); 3],
    pub msp_cost: u32,
    /// Percent chance the ATK+HP guarantee fires (stock: 0 / 50 / 0).
    pub guarantee_pct: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolEntry {
    /// MED_EFF_* key hash — translatable via `overmasteries.json`.
    pub key: u32,
    pub weight: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParamDef {
    /// Category type: 0=ATK, 1=HP, 2=CRIT, 3=BREAK, 100+ specials. The
    /// guarantee mechanic forces type 0 then type 1.
    pub kind: i32,
    /// Lv1..Lv10 values (level bit n -> values[n]).
    pub values: [f32; 10],
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OvermasteryTables {
    /// Indexed by meditation size 0/1/2 (small/medium/large).
    pub tiers: Vec<TierDef>,
    /// Category pools per size, in table order (order matters: guarantee
    /// direct-picks take the first matching entry, weighted picks walk in
    /// order).
    pub pools: Vec<Vec<PoolEntry>>,
    /// 10 rows; weight column = size.
    pub level_weights: Vec<[u32; 3]>,
    pub params: HashMap<u32, ParamDef>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mastery {
    /// MED_EFF_* key hash (EMPTY_KEY when the param row is missing).
    pub category: u32,
    /// Level 1..10 as shown in game (= level bit + 1).
    pub level: u32,
    pub kind: i32,
    pub value: f32,
}

/// Simulate one meditation roll. Advances `state` exactly as the game's RNG
/// slot would; returns the rolled masteries (stock data: 4, in slot order).
pub fn predict_roll(state: &mut u32, tier: usize, t: &OvermasteryTables) -> Vec<Mastery> {
    let mut draw = || {
        *state = xorshift32(*state);
        *state
    };
    let tier_def = &t.tiers[tier];
    let pool = &t.pools[tier];

    // 1. mastery count: cumulative weighted pick over the three options.
    let mut r = draw();
    let total: u32 = tier_def.counts.iter().map(|&(_, w)| w).sum();
    let mut count = 0;
    if total != 0 {
        r %= total;
        for &(n, w) in &tier_def.counts {
            if r < w {
                count = n;
                break;
            }
            r -= w;
        }
    }

    // 2. guarantee chance (always drawn, even for count 0).
    let guaranteed = draw() % 100 < tier_def.guarantee_pct;

    let mut results: Vec<Mastery> = Vec::with_capacity(count as usize);

    // Weighted level pick over the 10 weight rows (column = tier); the draw
    // is consumed before the total is known. Returns the level BIT (0-based,
    // clamped to 1..=9 like the game).
    let level_roll = |draw: &mut dyn FnMut() -> u32| -> u32 {
        let mut r = draw();
        let total: u32 = t.level_weights.iter().map(|row| row[tier]).sum();
        let mut idx: Option<usize> = None;
        if total != 0 {
            r %= total;
            for (i, row) in t.level_weights.iter().enumerate() {
                if r < row[tier] {
                    idx = Some(i);
                    break;
                }
                r -= row[tier];
            }
        }
        match idx {
            None => 1,
            Some(i) => i.clamp(1, 9) as u32,
        }
    };

    let resolve = |key: u32, bit: u32| -> Mastery {
        match t.params.get(&key) {
            Some(p) => Mastery { category: key, level: bit + 1, kind: p.kind, value: p.values[bit as usize] },
            // The game appends an entry with the empty id and no value when
            // the param row is missing (never happens with stock data).
            None => Mastery { category: EMPTY_KEY, level: bit + 1, kind: 0, value: 0.0 },
        }
    };

    for _ in 0..count {
        // Guarantee: force the first type-0 (ATK) then type-1 (HP) pool
        // entry, without consuming a category draw.
        let mut direct = None;
        if guaranteed {
            let want = if !results.iter().any(|m| m.kind == 0) {
                Some(0)
            } else if !results.iter().any(|m| m.kind == 1) {
                Some(1)
            } else {
                None
            };
            if let Some(want) = want {
                direct = pool
                    .iter()
                    .find(|e| t.params.get(&e.key).is_some_and(|p| p.kind == want))
                    .map(|e| e.key);
            }
        }
        let cat = match direct {
            Some(key) => key,
            None => {
                // Normal weighted pick, pool order, skipping the empty
                // sentinel and already-picked keys. Draw consumed first.
                let mut r = draw();
                let eligible = |e: &&PoolEntry| {
                    e.key != EMPTY_KEY && !results.iter().any(|m| m.category == e.key)
                };
                let total: u32 = pool.iter().filter(eligible).map(|e| e.weight).sum();
                if total == 0 {
                    continue; // nothing appended; no level draw either
                }
                r %= total;
                let mut picked = None;
                for e in pool.iter().filter(eligible) {
                    if r < e.weight {
                        picked = Some(e.key);
                        break;
                    }
                    r -= e.weight;
                }
                match picked {
                    Some(key) => key,
                    None => continue,
                }
            }
        };
        let bit = level_roll(&mut draw);
        results.push(resolve(cat, bit));
    }

    results
}

/// Simulate `rolls` consecutive rolls of the same (character, size) stream
/// starting from `state`.
pub fn simulate(mut state: u32, tier: usize, t: &OvermasteryTables, rolls: u32) -> Vec<Vec<Mastery>> {
    (0..rolls).map(|_| predict_roll(&mut state, tier, t)).collect()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OvermasteryStatus {
    pub game_running: bool,
    /// Character id hashes in roster order (empty when the game isn't up).
    pub roster: Vec<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OvermasteryQuery {
    pub char_id: u32,
    /// Meditation size 0/1/2 (small/medium/large).
    pub tier: usize,
    pub rolls: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OvermasteryPrediction {
    /// Consecutive predicted rolls of this character+size stream.
    pub rolls: Vec<Vec<Mastery>>,
    pub slot: u32,
    pub slot_state: u32,
    /// True when the slot state is 0 (the game will reseed from entropy).
    pub unpredictable: bool,
    pub msp_cost: u32,
}

/// The stock v2.0.2 tables, baked from the game's .tbl files by
/// scripts/gen-overmastery-tables.py.
pub fn stock_tables() -> &'static OvermasteryTables {
    static TABLES: std::sync::OnceLock<OvermasteryTables> = std::sync::OnceLock::new();
    TABLES.get_or_init(|| {
        serde_json::from_str(include_str!("../../assets/overmastery-tables.json"))
            .expect("overmastery-tables.json matches OvermasteryTables")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fixture mirroring scratchpad om_reference.py (independent Python
    /// transcription of the decompiled algorithm).
    fn tables() -> OvermasteryTables {
        let mut params = HashMap::new();
        params.insert(0x100, ParamDef { kind: 0, values: std::array::from_fn(|i| 10.0 * (i + 1) as f32) });
        params.insert(0x200, ParamDef { kind: 1, values: std::array::from_fn(|i| 100.0 * (i + 1) as f32) });
        params.insert(0x300, ParamDef { kind: 2, values: std::array::from_fn(|i| (i + 1) as f32) });
        params.insert(0x400, ParamDef { kind: 3, values: std::array::from_fn(|i| (i + 1) as f32 / 10.0) });
        params.insert(0x500, ParamDef { kind: 100, values: std::array::from_fn(|i| (i + 1) as f32) });
        let pool = |keys: &[u32]| keys.iter().map(|&key| PoolEntry { key, weight: 1 }).collect::<Vec<_>>();
        OvermasteryTables {
            tiers: vec![
                TierDef { counts: [(4, 100), (3, 0), (2, 0)], msp_cost: 700, guarantee_pct: 0 },
                TierDef { counts: [(4, 100), (3, 0), (2, 0)], msp_cost: 1000, guarantee_pct: 50 },
            ],
            // pool 0 carries a duplicate 0x100 like the stock small pool
            pools: vec![
                pool(&[0x100, 0x200, 0x300, 0x400, 0x500, 0x100]),
                pool(&[0x100, 0x200, 0x300, 0x400, 0x500]),
            ],
            level_weights: vec![
                [0, 0, 0],
                [0, 0, 0],
                [3500, 300, 500],
                [2600, 500, 500],
                [1700, 1100, 700],
                [1100, 3500, 1000],
                [500, 2600, 1500],
                [300, 1700, 1800],
                [200, 200, 2200],
                [100, 100, 1800],
            ],
            params,
        }
    }

    fn cats(r: &[Mastery]) -> Vec<u32> {
        r.iter().map(|m| m.category).collect()
    }

    /// Python reference, state 123456789 tier 0 (no guarantee):
    /// end state 0x26b13ea, categories [0x400,0x100,0x500,0x300],
    /// level bits [2,3,8,2] -> levels [3,4,9,3], values [0.3,40.0,9.0,3.0].
    #[test]
    fn roll_reference_no_guarantee() {
        let t = tables();
        let mut s = 123_456_789;
        let r = predict_roll(&mut s, 0, &t);
        assert_eq!(s, 0x26b13ea);
        assert_eq!(cats(&r), vec![0x400, 0x100, 0x500, 0x300]);
        assert_eq!(r.iter().map(|m| m.level).collect::<Vec<_>>(), vec![3, 4, 9, 3]);
        assert_eq!(r.iter().map(|m| m.kind).collect::<Vec<_>>(), vec![3, 0, 100, 2]);
        assert!((r[0].value - 0.3).abs() < 1e-6);
        assert!((r[1].value - 40.0).abs() < 1e-6);
        assert!((r[3].value - 3.0).abs() < 1e-6);
    }

    /// state 42 tier 1: guarantee fires (second draw %100 = 46 < 50) ->
    /// masteries 1+2 are the first type-0 and type-1 pool entries, drawn
    /// without category draws. End state 0x38c9b3c1; levels [6,6,8,6].
    #[test]
    fn roll_guarantee_forces_atk_then_hp() {
        let t = tables();
        let mut s = 42;
        let r = predict_roll(&mut s, 1, &t);
        assert_eq!(s, 0x38c9b3c1);
        assert_eq!(cats(&r), vec![0x100, 0x200, 0x400, 0x500]);
        assert_eq!(r.iter().map(|m| m.level).collect::<Vec<_>>(), vec![6, 6, 8, 6]);
    }

    /// state 3 tier 1: guarantee misses (draw %100 = 51 >= 50) -> all four
    /// categories drawn normally. End state 0xb8b8cc66.
    #[test]
    fn roll_guarantee_chance_can_miss() {
        let t = tables();
        let mut s = 3;
        let r = predict_roll(&mut s, 1, &t);
        assert_eq!(s, 0xb8b8cc66);
        assert_eq!(cats(&r), vec![0x300, 0x100, 0x200, 0x500]);
    }

    /// Consecutive rolls continue the same stream (per-slot persistence):
    /// end states 0x26b13ea -> 0x5c9af88 -> 0xb2c33efd.
    #[test]
    fn successive_rolls_share_stream() {
        let t = tables();
        let rolls = simulate(123_456_789, 0, &t, 3);
        assert_eq!(rolls.len(), 3);
        assert_eq!(cats(&rolls[0]), vec![0x400, 0x100, 0x500, 0x300]);
        assert_eq!(cats(&rolls[1]), vec![0x100, 0x200, 0x500, 0x300]);
        assert_eq!(cats(&rolls[2]), vec![0x300, 0x100, 0x400, 0x500]);
        let mut s = 123_456_789;
        for _ in 0..3 {
            predict_roll(&mut s, 0, &t);
        }
        assert_eq!(s, 0xb2c33efd);
    }

    /// Slot = 5 + tier*0x29 + char index; protagonists (PL0000/PL0100 id
    /// hashes) are always index 0, other characters use their roster
    /// position, unknown ids are None.
    #[test]
    fn slot_mapping() {
        assert_eq!(rng_slot(0, 0), 5);
        assert_eq!(rng_slot(2, 3), 5 + 2 * 0x29 + 3);
        let roster = vec![0x18e2f9f9u32, 0x079df0cc];
        assert_eq!(char_slot_index(&roster, 0x2a26b1b2), Some(0)); // Gran
        assert_eq!(char_slot_index(&roster, 0xa4acba76), Some(0)); // Djeeta
        assert_eq!(char_slot_index(&roster, 0x079df0cc), Some(1));
        assert_eq!(char_slot_index(&roster, 0xdeadbeef), None);
    }

    /// The baked stock tables parse and look like v2.0.2: 3 sizes always
    /// rolling 4 masteries, pools of 23/11/11 in table order (small starts
    /// ATK, HP, CRIT, BREAK), 10 weight rows with rows 1-2 all zero, and a
    /// param entry (with type + 10 values) for every pool key.
    #[test]
    fn stock_tables_shape() {
        let t = stock_tables();
        assert_eq!(t.tiers.len(), 3);
        assert_eq!(
            t.tiers.iter().map(|d| d.msp_cost).collect::<Vec<_>>(),
            vec![700, 1000, 2000]
        );
        assert_eq!(
            t.tiers.iter().map(|d| d.guarantee_pct).collect::<Vec<_>>(),
            vec![0, 50, 0]
        );
        for d in &t.tiers {
            assert_eq!(d.counts, [(4, 100), (3, 0), (2, 0)]);
        }
        assert_eq!(t.pools.iter().map(Vec::len).collect::<Vec<_>>(), vec![23, 11, 11]);
        // MED_EFF_ATK01 / HP01 / CRITICAL01 / BREAK01 head every pool.
        let atk01 = 0xc4925bd7u32;
        for pool in &t.pools {
            assert_eq!(pool[0].key, atk01);
            assert!(pool.iter().all(|e| e.weight == 1));
        }
        assert_eq!(t.level_weights.len(), 10);
        assert_eq!(&t.level_weights[..2], &[[0, 0, 0], [0, 0, 0]]);
        assert_eq!(t.level_weights[2], [3500, 300, 500]);
        for pool in &t.pools {
            for e in pool {
                assert!(t.params.contains_key(&e.key), "param missing for {:#x}", e.key);
            }
        }
        assert_eq!(t.params[&atk01].kind, 0);
        assert_eq!(t.params[&atk01].values[9], 1000.0);
    }

    /// All-zero count weights roll zero masteries but still consume the two
    /// header draws (count + guarantee).
    #[test]
    fn zero_count_weights_consume_two_draws() {
        let mut t = tables();
        t.tiers[0].counts = [(4, 0), (3, 0), (2, 0)];
        let mut s = 123_456_789u32;
        let r = predict_roll(&mut s, 0, &t);
        assert!(r.is_empty());
        assert_eq!(s, xorshift32(xorshift32(123_456_789)));
    }
}
