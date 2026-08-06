//! The status object's own RTTI class, as a patch-stable hash of its name.
//!
//! `+0x4c` (the cause) is the applying character's ACTION id, and a passive has
//! no action to name — which is why sentinel causes like 9998 exist at all. The
//! object itself still knows what it is: `StatusPl1200UniqueBuffGuardpoint`
//! names both the character and the mechanism.
//!
//! The vtable RVA is what a game patch moves, so it is consumed HERE and never
//! sent: the wire carries a hash of the class NAME. An old log can therefore
//! fail to resolve, but can never resolve to the wrong class.
//!
//! Read-and-compare only, never a vfunc call — the same discipline
//! `summon::is_summon_base_vtable` follows, for the same reason.
use std::sync::atomic::{AtomicBool, Ordering};

use super::diag;
use super::status_class_table::STATUS_CLASS_TABLE;

/// One-shot latch so a patch that moves these vtables logs once per session
/// rather than once per status application.
static STATUS_CLASS_RVA_WARNED: AtomicBool = AtomicBool::new(false);

/// The class-name hash for a status object, or `None` when there is nothing
/// trustworthy to say.
///
/// `None` covers four different failures on purpose, because the caller treats
/// them identically and none of them may produce a guess: an unreadable vtable,
/// a module base that was never set, a vtable this build's table does not know
/// (a stale hook after a patch), and a class that names no mechanism (hash 0,
/// e.g. `StatusBase`).
pub fn status_class_of(status: *const usize) -> Option<u32> {
    let base = diag::MODULE_BASE.load(Ordering::Relaxed);
    if base == 0 {
        return None;
    }
    let vtable = diag::read_ptr_guarded(status as usize, 0)?;
    let rva = vtable.checked_sub(base)?;
    match STATUS_CLASS_TABLE.binary_search_by_key(&rva, |entry| entry.0) {
        // Hash 0 is the table's "known, and deliberately nameless" marker.
        Ok(index) => Some(STATUS_CLASS_TABLE[index].1).filter(|hash| *hash != 0),
        Err(_) => {
            warn_stale_rva_once();
            None
        }
    }
}

fn warn_stale_rva_once() {
    if STATUS_CLASS_RVA_WARNED.swap(true, Ordering::Relaxed) {
        return;
    }
    log::warn!("status class vtable RVAs did not match — offsets may be stale after a game patch");
    #[cfg(feature = "console")]
    println!(
        "WARNING: status class vtable RVAs did not match — offsets may be stale after a game patch"
    );
}

#[cfg(test)]
mod tests {
    #[test]
    fn table_is_sorted_for_binary_search() {
        let table = super::super::status_class_table::STATUS_CLASS_TABLE;
        assert!(table.windows(2).all(|pair| pair[0].0 < pair[1].0));
    }

    #[test]
    fn unknown_vtable_is_rejected_when_module_base_is_unset() {
        // MODULE_BASE is 0 in the test binary, so every lookup must fail closed
        // rather than treat a raw pointer as an RVA.
        let obj: [usize; 1] = [0];
        assert_eq!(super::status_class_of(obj.as_ptr().cast()), None);
    }

    #[test]
    fn null_object_is_rejected() {
        // Honest about its own reach: with MODULE_BASE unset this returns at
        // the `base == 0` guard, so it pins the CONTRACT (a null object never
        // yields a class) rather than the guarded read's null handling — that
        // path needs a live process to exercise, exactly as `summon.rs`'s
        // equivalent test does. Kept so the contract still holds the day
        // MODULE_BASE is set.
        assert_eq!(super::status_class_of(std::ptr::null()), None);
    }
}
