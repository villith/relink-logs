//! Where the transmarvel roll draws from. The read itself is
//! [`crate::read_rng_slot`] — transmarvel needs nothing the other RNG-backed
//! tools don't, so it contributes the slot number and no walker of its own.

use crate::RNG_SLOT_COUNT;

/// RNG slot the transmarvel roll draws from. The roll (GemGacha exec,
/// FUN_141bb6610 v2.0.2) sets the slot-override word to the gacha row's
/// slot base + 1 — transmutation Lv1-3 use slots 1-3, transmarvel uses 4 —
/// so every draw inside the roll lands here.
pub const TM_SLOT: u32 = 4;

// Keep the constant honest against the array bounds.
const _: () = assert!((TM_SLOT as usize) < RNG_SLOT_COUNT);
