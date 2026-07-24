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

/// Pl1900 (Id, human form) actor type hash.
const ID_HUMAN_TYPE: u32 = 0x8056ABCD;
/// Pl2000 (Id, dragon form) actor type hash.
pub(crate) const ID_DRAGON_TYPE: u32 = 0xF5755C0E;
const ID_DRAGON_PARENT_ENTITY_OFFSET: usize = 0x1CA98;

// Returns the specified instance of the parent entity.
// ptr+offset: Entity, then +0x70: m_pSpecifiedInstance (Pl0700, Pl1200, ...).
//
// Both hops are SEH-guarded: these parent-link offsets are version-fragile, and
// a stale one (or a pet/form instance smaller than the offset) previously meant
// a raw deref of unmapped memory on the game thread — the silent-freeze class
// of bug. A failed read just leaves the child actor ungrouped.
#[inline(always)]
pub(crate) fn parent_specified_instance_at(
    actor_ptr: *const usize,
    offset: usize,
) -> Option<*const usize> {
    let entity = diag::read_ptr_guarded(actor_ptr as usize, offset)?;
    if entity == 0 {
        return None;
    }

    let parent = diag::read_ptr_guarded(entity, 0x70)?;
    (parent != 0).then_some(parent as *const usize)
}

/// Resolves a keyless sub-entity source to its owner's instance pointer.
/// Returns `None` for any source we do not own a mapping for, and for every
/// failed read along the way.
fn resolve_source_parent_ptr(source_type_id: u32, source: *const usize) -> Option<*const usize> {
    let parent_offset = match source_type_id {
        // Pl0700Ghost -> Pl0700 (Ferry). v2.0.2 moved the owner-entity link
        // 0xE48 -> 0xE58; with the old offset ALL ghost damage was dropped.
        0x2AF678E8 => 0xE58,
        // Pl0700GhostSatellite (Umlauf) -> Pl0700. Same -0x20 shift.
        0x8364C8BC => 0x4E8,
        // Wp2290 -> Pl2200 (Seofon's Avatar, actions 900-904).
        0x5B1AB457 => 0x4E0,
        // Pl0600PlantRose -> Pl0600.
        0x69C0CA71 => 0x7E0,
        // Wp1890 -> Pl1800 (Cagliostro's sled; also the damage actor for Pain
        // Train and Alexandria). The owner handle is empty in some sled states,
        // so gate on the handle index at +0x550.
        0xC9F45042 => gated_parent_offset(source, 0x550, 0x558)?,
        _ => return None,
    };

    let parent = parent_specified_instance_at(source, parent_offset)?;
    // The fetched value may not be a live entity, and the type-id vfunc makes a
    // vtable call — probe the slot first so a stale offset fails closed.
    if !vfunc_slot_readable(parent, 0x58) {
        return None;
    }
    Some(parent)
}

/// The parent actor to credit a damage source to: `(type id, index, instance)`.
///
/// `Pl2000` is handled ahead of the generic path because Id's dragon form
/// carries its own player key, so it must be forced back onto the human type
/// and the owner's index — the slot-scoped remap behind the recruited-Id
/// empty-slot-4 fix. Do not fold it into the table.
#[inline(always)]
pub fn get_source_parent(
    source_type_id: u32,
    source: *const usize,
) -> Option<(u32, u32, *const usize)> {
    if source_type_id == ID_DRAGON_TYPE {
        let parent_instance =
            parent_specified_instance_at(source, ID_DRAGON_PARENT_ENTITY_OFFSET)?;
        let parent_idx = diag::read_ptr_guarded(parent_instance as usize, 0x170)? as u32;
        return Some((ID_HUMAN_TYPE, parent_idx, parent_instance));
    }

    let parent = resolve_source_parent_ptr(source_type_id, source)?;
    // Call the type-id vfunc through the guarded slot, never a raw re-walk:
    // the guard-to-use gap on a recycled allocation is the probe-crash class.
    let type_fn = validated_vfunc(parent, 0x58)?;
    Some((
        actor_type_id_via(parent, type_fn),
        crate::hooks::actor_idx(parent),
        parent,
    ))
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

    #[test]
    fn resolves_parent_through_the_entity_link() {
        // Layout: actor+OFFSET -> entity, entity+0x70 -> parent instance.
        let parent = Box::new(0usize);
        let parent_ptr = &*parent as *const usize;
        let mut entity = vec![0u8; 0x78];
        let mut actor = vec![0u8; 0x1CA98 + std::mem::size_of::<usize>()];

        unsafe {
            entity
                .as_mut_ptr()
                .byte_add(0x70)
                .cast::<*const usize>()
                .write_unaligned(parent_ptr);
            actor
                .as_mut_ptr()
                .byte_add(0x1CA98)
                .cast::<*const u8>()
                .write_unaligned(entity.as_ptr());
        }

        assert_eq!(
            super::parent_specified_instance_at(actor.as_ptr().cast::<usize>(), 0x1CA98),
            Some(parent_ptr)
        );
    }

    #[test]
    fn null_entity_link_yields_no_parent() {
        let actor = vec![0u8; 0x100];
        assert_eq!(
            super::parent_specified_instance_at(actor.as_ptr().cast(), 0x40),
            None
        );
    }

    #[test]
    fn unmapped_actor_fails_without_dereferencing() {
        assert_eq!(
            super::parent_specified_instance_at(1usize as *const usize, 0),
            None
        );
    }
}
