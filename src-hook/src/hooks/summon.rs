//! Source-parent resolution: maps a sub-entity, pet, avatar or summon damage
//! source to the player who owns it.
//!
//! Every arm dereferences across objects, so every read is guarded and a stale
//! offset fails closed rather than faulting the game thread.
//!
//! The summon class table, the extra arms and the vtable-RVA cross-check were
//! cross-referenced against an independent implementation (2026-07-24). The
//! offsets are facts about the game binary, not copied code.

use crate::hooks::diag;
use crate::hooks::GetEntityHashID0x58;

/// The owner is stored as an entity-handle triple `{idx, CEntityInfo*, serial}`.
/// The handle can be legitimately empty, so require a non-zero index before
/// trusting the pointer. Returns the pointer offset to follow, or `None`.
#[inline(always)]
pub(crate) fn gated_parent_offset(
    source: *const usize,
    idx_offset: usize,
    ptr_offset: usize,
) -> Option<usize> {
    // read_u32_guarded returns 0 both for a failed read and an empty handle;
    // both must fail closed, so one check covers them.
    match diag::read_u32_guarded(source as usize, idx_offset) {
        0 => None,
        _ => Some(ptr_offset),
    }
}

/// Reads and validates the vfunc slot at `offset`, returning the function
/// pointer. Closes the wild-call window when a parent offset goes stale.
///
/// A caller invoking the vfunc on a resolved pointer MUST call through this
/// returned pointer and never re-walk the vtable raw: the guard and a raw
/// re-walk are two reads with a gap, and on a recycled allocation that gap is
/// the probe-crash class of bug.
pub(crate) fn validated_vfunc(instance: *const usize, offset: usize) -> Option<*const usize> {
    let vtable = diag::read_ptr_guarded(instance as usize, 0)?;
    if vtable == 0 {
        return None;
    }
    match diag::read_ptr_guarded(vtable, offset) {
        Some(slot) if slot != 0 => Some(slot as *const usize),
        _ => None,
    }
}

/// Discard-the-pointer form of [`validated_vfunc`] for call sites that only
/// need to know the slot is safe to walk.
pub(crate) fn vfunc_slot_readable(instance: *const usize, offset: usize) -> bool {
    validated_vfunc(instance, offset).is_some()
}

/// Invokes the GetEntityHashID vfunc through an already-guarded pointer from
/// [`validated_vfunc`], avoiding a second raw vtable walk.
pub(crate) fn actor_type_id_via(instance: *const usize, type_fn: *const usize) -> u32 {
    let mut type_id: u32 = 0;
    unsafe {
        let func: GetEntityHashID0x58 = std::mem::transmute(type_fn);
        func(instance, &mut type_id as *mut u32);
    }
    type_id
}

#[cfg(test)]
mod tests {
    use super::gated_parent_offset;

    #[test]
    fn gated_offset_returns_the_pointer_offset_when_the_handle_index_is_set() {
        let mut actor = vec![0u8; 0x100];
        unsafe {
            actor
                .as_mut_ptr()
                .byte_add(0x10)
                .cast::<u32>()
                .write_unaligned(7);
        }
        assert_eq!(
            gated_parent_offset(actor.as_ptr().cast::<usize>(), 0x10, 0x18),
            Some(0x18)
        );
    }

    #[test]
    fn gated_offset_rejects_an_empty_handle_index() {
        let actor = vec![0u8; 0x100];
        assert_eq!(
            gated_parent_offset(actor.as_ptr().cast::<usize>(), 0x10, 0x18),
            None
        );
    }

    #[test]
    fn gated_offset_rejects_an_unmapped_actor_without_dereferencing() {
        assert_eq!(gated_parent_offset(1usize as *const usize, 0x10, 0x18), None);
    }
}
