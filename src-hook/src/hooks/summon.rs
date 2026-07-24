//! Source-parent resolution: maps a sub-entity, pet, avatar or summon damage
//! source to the player who owns it.
//!
//! Every arm dereferences across objects, so every read is guarded and a stale
//! offset fails closed rather than faulting the game thread.
//!
//! The summon class table, the extra arms and the vtable-RVA cross-check were
//! cross-referenced against an independent implementation (2026-07-24). The
//! offsets are facts about the game binary, not copied code.

use std::sync::atomic::{AtomicBool, Ordering};

use crate::hooks::diag;
use crate::hooks::GetEntityHashID0x58;

/// Static RVAs of the summon-base body classes that store their summoner at
/// +0xFE8, sorted for `binary_search`. Compared against
/// `*(summon) - MODULE_BASE` — a plain read and compare, never a vfunc call on
/// a swept pointer. Goes stale on every game patch by design; a miss fails
/// closed and warns once.
const SUMMON_BASE_VTABLE_RVAS: &[usize] = &[
    0x59C61D0, // BehaviorSummonObjectBase (generic/data-driven body)
    0x5C58DD0, // So0000  Lucilius
    0x5C59FF0, // So4e00  Albacore
    0x5C5CA60, // So6400  Wheel of Fate
    0x5C5DC10, // So0200  Rolan
    0x5C5EDA0, // So2001  Silverslime var.
    0x5C61020, // So4502  Lilith var.
    0x5E75600, // So4500  Lilith
    0x5E78240, // So4c00  Managarmr Nihilla
    0x5E793D0, // So1d00  Quakadile
    0x5E7A4C0, // So9200  Beelzebub
    0x5E7B650, // So0d00  Goblin Soldier
    0x5E7C7E0, // So4f00  Hope-Filled Skydwellers
    0x5E7D990, // So5600  Mellose Clan
    0x5E7EB40, // So5700  Crew Alliance Rafale
    0x5E7FCF0, // So5f01  Cat var.
    0x617F998, // So1100  Goblin Warrior
    0x617FD38, // So1100Base (generic body)
];

/// One-shot latch so a patch that moves these vtables logs once per session
/// rather than once per hit.
static SUMMON_VTABLE_RVA_WARNED: AtomicBool = AtomicBool::new(false);

fn warn_stale_rva_once(flag: &AtomicBool, what: &str) {
    if flag.swap(true, Ordering::Relaxed) {
        return;
    }
    log::warn!("{what} did not match — offsets may be stale after a game patch");
    #[cfg(feature = "console")]
    println!("WARNING: {what} did not match — offsets may be stale after a game patch");
}

/// True iff `summon`'s vtable RVA is a known summon-base body class. All reads
/// guarded, fails closed, no vfunc call.
fn is_summon_base_vtable(summon: *const usize) -> bool {
    let base = diag::MODULE_BASE.load(Ordering::Relaxed);
    if base == 0 {
        return false;
    }
    let Some(vtable) = diag::read_ptr_guarded(summon as usize, 0) else {
        return false;
    };
    let Some(rva) = vtable.checked_sub(base) else {
        return false;
    };
    SUMMON_BASE_VTABLE_RVAS.binary_search(&rva).is_ok()
}

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

/// Summon body classes that store their summoner as a validated entity handle
/// `{+0xFE0 idx, +0xFE8 CEntityInfo*}`. Enemy-cast summons resolve to an enemy
/// owner, which fails closed downstream — no player is credited, which is
/// correct.
const SUMMON_BODY_HASHES: &[u32] = &[
    0xD2E5407A, // So0000  Lucilius
    0x6D068BDE, // So0200  Rolan
    0x69893920, // So0d00  Goblin Soldier
    0x1D3EDC63, // So1100  Goblin Warrior
    0xAE913DE3, // So1100Base (generic summon body)
    0xDFEC5706, // So1d00  Quakadile
    0x34894579, // So2001  Silverslime var.
    0x1DB19581, // So4500  Lilith
    0x9F394F85, // So4502  Lilith var.
    0x65294C5C, // So4c00  Managarmr Nihilla
    0x18617D59, // So4e00  Albacore
    0x925ADE1B, // So4f00  Hope-Filled Skydwellers
    0x6093301C, // So5600  Mellose Clan
    0xA22E16CF, // So5700  Crew Alliance Rafale
    0x0F617FF0, // So5f01  Cat var.
    0xF065D8B8, // So6400  Wheel of Fate
    0x5395CE93, // So9200  Beelzebub
    0xB0792857, // BehaviorSummonObjectBase (generic summon body)
];

/// Handle offsets on a summon body: index gate, then the entity pointer.
const SUMMON_OWNER_IDX_OFFSET: usize = 0xFE0;
const SUMMON_OWNER_PTR_OFFSET: usize = 0xFE8;

/// Two-hop attribution: source -> parent summon (re-typed by vtable RVA, no
/// vfunc call on a swept pointer) -> summoner. Fails closed at every step.
fn two_hop_summoner(
    source: *const usize,
    hop1_idx_off: usize,
    hop1_ptr_off: usize,
) -> Option<*const usize> {
    let hop1 = gated_parent_offset(source, hop1_idx_off, hop1_ptr_off)?;
    let summon = parent_specified_instance_at(source, hop1)?;

    // Re-type WITHOUT a vfunc call. A miss is a stale-RVA breadcrumb.
    if !is_summon_base_vtable(summon) {
        warn_stale_rva_once(&SUMMON_VTABLE_RVA_WARNED, "summon-base vtable RVAs");
        return None;
    }

    let hop2 = gated_parent_offset(summon, SUMMON_OWNER_IDX_OFFSET, SUMMON_OWNER_PTR_OFFSET)?;
    let owner = parent_specified_instance_at(summon, hop2)?;

    // The terminal must be a real player, else credit nobody.
    if !vfunc_slot_readable(owner, 0x58) {
        return None;
    }
    crate::hooks::player::player_slot_key_for_actor(owner)?;
    Some(owner)
}

/// Resolves a keyless sub-entity source to its owner's instance pointer.
/// Returns `None` for any source we do not own a mapping for, and for every
/// failed read along the way.
fn resolve_source_parent_ptr(source_type_id: u32, source: *const usize) -> Option<*const usize> {
    // Two-hop arms: owner handle -> parent summon -> +0xFE8 summoner. Handled
    // ahead of the table because they yield a resolved pointer, not an offset.
    match source_type_id {
        // SoAhrimanBaseLaser
        0x8FE0DF11 => return two_hop_summoner(source, 0x4F0, 0x4F8),
        // We8090 / We8091 / We8170 (em8000 "Seofon" sword entities)
        0xAE1F95D9 | 0xAE1E9FFC | 0x2E0DE3A8 => {
            return two_hop_summoner(source, SUMMON_OWNER_IDX_OFFSET, SUMMON_OWNER_PTR_OFFSET)
        }
        _ => {}
    }

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
        // Summon bodies -> summoner, via the validated entity handle.
        hash if SUMMON_BODY_HASHES.contains(&hash) => {
            gated_parent_offset(source, SUMMON_OWNER_IDX_OFFSET, SUMMON_OWNER_PTR_OFFSET)?
        }
        // Pl8000 (controllable-summon spawner) -> summoner; same handle idiom.
        0x3B5133C4 => gated_parent_offset(source, 0x23E0, 0x23E8)?,
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
    fn two_hop_fails_closed_when_the_first_handle_is_empty() {
        let actor = vec![0u8; 0x1100];
        assert_eq!(
            super::two_hop_summoner(actor.as_ptr().cast(), 0x4F0, 0x4F8),
            None
        );
    }

    #[test]
    fn two_hop_arms_route_through_the_two_hop_resolver() {
        // All four two-hop sources must fail closed on a zeroed actor rather than
        // falling through to the single-hop table.
        let actor = vec![0u8; 0x1100];
        for hash in [0x8FE0DF11u32, 0xAE1F95D9, 0xAE1E9FFC, 0x2E0DE3A8] {
            assert_eq!(
                super::resolve_source_parent_ptr(hash, actor.as_ptr().cast()),
                None,
                "hash {hash:#X} should fail closed"
            );
        }
    }

    #[test]
    fn summon_class_hashes_are_unique() {
        // A duplicate arm in the match is a silent compile-time shadow: the second
        // never fires, so one summon's damage would vanish with no error.
        let mut hashes = super::SUMMON_BODY_HASHES.to_vec();
        let before = hashes.len();
        hashes.sort_unstable();
        hashes.dedup();
        assert_eq!(before, hashes.len(), "duplicate hash in SUMMON_BODY_HASHES");
        assert_eq!(before, 18, "expected 18 summon body classes");
    }

    #[test]
    fn summon_body_source_with_empty_handle_resolves_to_nothing() {
        // So0000 with a zeroed +0xFE0 handle index must fail closed.
        let actor = vec![0u8; 0x1100];
        assert_eq!(
            super::resolve_source_parent_ptr(0xD2E5407A, actor.as_ptr().cast()),
            None
        );
    }

    #[test]
    fn vtable_rva_table_is_sorted_for_binary_search() {
        // binary_search silently returns wrong answers on an unsorted slice, and a
        // wrong answer here means crediting damage to the wrong player.
        let table = super::SUMMON_BASE_VTABLE_RVAS;
        assert!(
            table.windows(2).all(|w| w[0] < w[1]),
            "SUMMON_BASE_VTABLE_RVAS must be sorted ascending with no duplicates"
        );
    }

    #[test]
    fn unknown_vtable_is_rejected_when_module_base_is_unset() {
        // MODULE_BASE is 0 in the test binary, so every lookup must fail closed.
        let obj = vec![0u8; 0x40];
        assert!(!super::is_summon_base_vtable(obj.as_ptr().cast()));
    }

    #[test]
    fn unmapped_actor_fails_without_dereferencing() {
        assert_eq!(
            super::parent_specified_instance_at(1usize as *const usize, 0),
            None
        );
    }
}
