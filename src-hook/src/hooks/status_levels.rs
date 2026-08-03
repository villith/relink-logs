//! Which statuses carry a real stack count. GENERATED — do not edit by hand.
//!
//! Regenerate with `scripts/gen-stackable-statuses.py` after a game update; the
//! source is `status.tbl`'s `HasLevels` column.
//!
//! `StatusBase+0xb0` is a stack/level count ONLY for these ids. Elsewhere the
//! factory's pre-init -1 is still there, or the class uses the field for
//! something else (barrier stores its absorb value in it), so reading it
//! unconditionally would publish garbage as a stack count.

/// `status.tbl` ids whose `+0xb0` is a stack count, sorted for binary search.
pub(super) const STACKABLE_STATUS_IDS: [u32; 64] = [
    4, 26, 33, 37, 54, 55, 60, 64, 65, 66, 68, 69, 71, 72, 74, 75, 78, 79, 80, 82, 85, 86, 87, 88,
    90, 91, 92, 93, 94, 96, 102, 104, 105, 107, 108, 109, 110, 111, 112, 114, 115, 116, 117, 118,
    123, 124, 125, 127, 128, 129, 130, 131, 132, 133, 135, 136, 137, 138, 139, 144, 145, 146, 147,
    148,
];

/// Whether `+0xb0` means "stacks" for this status.
pub(super) fn has_levels(status_id: u32) -> bool {
    STACKABLE_STATUS_IDS.binary_search(&status_id).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_table_is_sorted_for_binary_search() {
        assert!(STACKABLE_STATUS_IDS
            .windows(2)
            .all(|pair| pair[0] < pair[1]));
    }

    #[test]
    fn known_stackable_and_non_stackable_ids() {
        // damagecut (4) is the first HasLevels row; atkup (0) is the most
        // common buff in the game and is NOT stackable, which is what makes a
        // wrong answer here so visible.
        assert!(has_levels(4));
        assert!(!has_levels(0));
        // barrier (41) keeps its ABSORB value at +0xb0 — the exact field this
        // table exists to stop the hook from reading as a stack count.
        assert!(!has_levels(41));
    }
}
