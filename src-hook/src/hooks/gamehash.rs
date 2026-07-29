//! The game's custom XXHash32, which turns an id string into the 32-bit hash
//! the engine identifies actors and table rows by.
//!
//! It differs from stock XXHash32 in three ways: a fixed seed of `0x178A54A4`,
//! hardcoded lane seeds instead of ones derived from the seed, and a `> 16`
//! rather than `>= 16` bound on the inner loop. A faithful port of
//! GBFRDataTools' `XXHash32Custom`, and of `scripts/gbfr_hash.py` which the
//! table generators use — the tests below pin it to hashes the hook already
//! carries, so a port slip cannot pass silently.

const PRIME32_1: u32 = 0x9E37_79B1;
const PRIME32_2: u32 = 0x85EB_CA77;
const PRIME32_3: u32 = 0xC2B2_AE3D;
const PRIME32_4: u32 = 0x27D4_EB2F;
const PRIME32_5: u32 = 0x1656_67B1;
const SEED: u32 = 0x178A_54A4;

/// Hashes an ASCII id (`"So2100"`, `"Pl1800"`, …) into its engine hash.
pub fn game_xxhash32(data: &[u8]) -> u32 {
    let mut pos = 0usize;
    let len = data.len();

    let mut hash = if len >= 16 {
        let (mut v1, mut v2, mut v3, mut v4) = (
            0x2557_311Bu32,
            0x871F_B76Au32,
            0x0133_ECF3u32,
            0x62FC_7342u32,
        );
        loop {
            for lane in [&mut v1, &mut v2, &mut v3, &mut v4] {
                let word = u32::from_le_bytes(data[pos..pos + 4].try_into().expect("4 bytes"));
                *lane = lane
                    .wrapping_add(word.wrapping_mul(PRIME32_2))
                    .rotate_left(13)
                    .wrapping_mul(PRIME32_1);
                pos += 4;
            }
            // `>`, not `>=`: the quirk that makes this hash the game's own.
            if len - pos <= 16 {
                break;
            }
        }
        v1.rotate_left(1)
            .wrapping_add(v2.rotate_left(7))
            .wrapping_add(v3.rotate_left(12))
            .wrapping_add(v4.rotate_left(18))
    } else {
        SEED
    };

    hash = hash.wrapping_add(len as u32);

    while len - pos >= 4 {
        let word = u32::from_le_bytes(data[pos..pos + 4].try_into().expect("4 bytes"));
        hash = hash
            .wrapping_add(word.wrapping_mul(PRIME32_3))
            .rotate_left(17)
            .wrapping_mul(PRIME32_4);
        pos += 4;
    }
    while pos < len {
        hash = hash
            .wrapping_add((data[pos] as u32).wrapping_mul(PRIME32_5))
            .rotate_left(11)
            .wrapping_mul(PRIME32_1);
        pos += 1;
    }

    hash ^= hash >> 15;
    hash = hash.wrapping_mul(PRIME32_2);
    hash ^= hash >> 13;
    hash = hash.wrapping_mul(PRIME32_3);
    hash ^ (hash >> 16)
}

#[cfg(test)]
mod tests {
    use super::game_xxhash32;

    #[test]
    fn hashes_the_summon_classes_the_hook_already_knows() {
        // These are entries from SUMMON_BODY_HASHES, derived independently by
        // the game itself — matching them proves the port, not just self-
        // consistency.
        for (id, expected) in [
            (&b"So0000"[..], 0xD2E5_407Au32),
            (&b"So4c00"[..], 0x6529_4C5C),
            (&b"So9200"[..], 0x5395_CE93),
            (&b"So2001"[..], 0x3489_4579),
            (&b"So1100"[..], 0x1D3E_DC63),
        ] {
            assert_eq!(
                game_xxhash32(id),
                expected,
                "{} hashed wrong",
                String::from_utf8_lossy(id)
            );
        }
    }

    #[test]
    fn hashes_an_input_long_enough_to_run_the_lane_loop() {
        // Every id the hook hashes is six bytes, so without this the four-lane
        // branch and its `>` bound would never be exercised. This vector is not
        // arbitrary: the class hash the game reports for the generic summon body
        // IS the hash of its class name, so matching it checks the long path
        // against the game rather than against another port of the same code.
        assert_eq!(game_xxhash32(b"BehaviorSummonObjectBase"), 0xB079_2857);
        assert_eq!(game_xxhash32(&[0u8; 16]), 0xE277_EF3E);
    }

    #[test]
    fn hashes_the_empty_input_without_reading_anything() {
        // 0x887AE0B0 is the engine's empty-id sentinel — it appears inline in
        // the summon body's own constructor.
        assert_eq!(game_xxhash32(b""), 0x887A_E0B0);
    }
}
