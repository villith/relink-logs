//! Status (buff/debuff) lifecycle diagnostics — stage 1 of buff tracking.
//!
//! Background (2026-07-31 investigation; RVAs from the v2.0.3 `gbfr203fast`
//! Ghidra DB): every buff and ailment is one of the 168 `StatusBase`
//! subclasses (`StatusAttackBuff`, `StatusAilmentPoison`, …) held in a
//! per-actor `ExStatus` component and cataloged 1:1 by `status.tbl`
//! (`StatusId` 0-999 = buffs, 1000+ = ailments). Two SHARED functions cover
//! nearly the whole family, so two detours observe almost everything:
//!
//! * `StatusBase::init(this, f32 duration, ctx)` — vtable slot 2 (+0x10),
//!   inherited un-overridden by 165 of the family's vtables (v2.0.3 entry
//!   0x27a7720). It copies the SOURCE entity handle out of `ctx+0x38..0x48`
//!   into `this+0x28..0x38` and arms the duration (negative ⇒ infinite: 9999.0
//!   + flag at +0x79; +0x7c initial, +0x80 remaining). **It is the REFRESH
//!   path only** — the apply worker calls it when it finds an existing status
//!   to re-arm, but compiles the same arming inline when it creates one, so a
//!   fresh application never enters here. That is what
//!   [`OnStatusUpdateHook`] exists to cover; see its comment for the evidence.
//! * the shared `StatusBase` scalar-deleting destructor (v2.0.3 entry
//!   0x29b0cf0, held by ~147 family vtables as slot 0): every status that
//!   dies — expired, dispelled (`ExStatus::clearStatus*`), or owner teardown —
//!   passes through while its fields are still readable. Expiry-vs-dispel
//!   attribution is a later stage (the removal reason rides the +0x70 virtual,
//!   whose per-class override count makes it a poor first hook target).
//!
//! Both detours emit protocol events — `StatusApply` from `init` (a refresh:
//! the game re-inits the SAME instance rather than allocating a new one) and
//! `StatusRemove` from the dtor — and additionally log a field dump under
//! `hookdiag`. A third detour, [`OnStatusUpdateHook`], walks each holder's
//! list per frame and reports what the other two cannot see: the FIRST
//! application of an effect. Every field read is guarded: a layout shift must
//! never fault a game thread.
//!
//! One field the parser's event carries is NOT fully resolvable here, and is
//! sent as its documented fallback rather than guessed at:
//!
//! * `ability_id` — sent as the status's `+0x4c` discriminator (see
//!   [`STATUS_SUBID_OFFSET`]), which separates two abilities granting one
//!   effect but does NOT name either of them: it is an effect-entry constant,
//!   not an action id, and the apply ctx carries no action id at all. Rows show
//!   the number until a mapping from it to a skill exists.
//!
//! `stacks` used to be in that list and no longer is: `+0xb0` is a true count
//! for the 64 `HasLevels` classes, which [`status_levels`] now names, and
//! [`stacks_for`] reports 1 for everything else exactly as before.
//!
//! [`status_levels`]: super::status_levels

#[cfg(feature = "hookdiag")]
use std::fmt::Write as _;

use anyhow::{anyhow, Result};
use retour::static_detour;

use crate::{
    event,
    hooks::diag::{self, readable},
    process::Process,
};

/// `StatusBase::init` entry (vtable slot 2). Anchored on the function's whole
/// body — the source-handle copy from `ctx+0x38..0x48`, the negative-duration
/// check and the +0x79/+0x80/+0x7c stores — with the RIP-relative displacement
/// of the 9999.0f constant wildcarded (it shifts every patch). Verified
/// exactly 1 match on v2.0.3, resolving to the known entry 0x27a7720.
const STATUS_INIT_SIG: &str = "' 4d 85 c0 74 13 c4 c1 78 10 40 38 49 8b 40 48 48 89 41 38 \
                               c5 f8 11 41 28 c5 f8 57 c0 c5 f8 2e c1 76 08 c5 fa 10 0d \
                               ? ? ? ? 0f 97 41 79 c5 fa 11 89 80 00 00 00 c5 fa 11 49 7c";

/// Shared `StatusBase` scalar-deleting destructor entry (vtable slot 0 of
/// ~147 family vtables). Anchored on the prologue + the reset of the object's
/// vftable back to `StatusBase::vftable` (LEA displacement wildcarded — it
/// moves every patch; on 2.0.3 it round-trips to 0x5ab9fe8) + the +0x98
/// member-free preamble. Verified exactly 1 match on v2.0.3 at 0x29b0cf0.
const STATUS_DTOR_SIG: &str = "' 56 57 53 48 83 ec 20 89 d7 48 89 ce 48 8d 05 ? ? ? ? \
                               48 89 01 4c 8b 81 98 00 00 00 4d 85 c0 74 74";

/* StatusBase instance offsets (v2.0.3; see the investigation memory).
Cross-confirmed in three independent decompiles: ExStatus::update compares
+0x50 against 0x3fe (debufftimeextend), the ExPlayerStatus canApply override
scans the active list for +0x50 == 0x11 (antidebuff/Veil), and the VFX
emitter special-cases +0x50 == 0x29 (barrier). */

/// u32 `status.tbl` StatusId.
const STATUS_ID_OFFSET: usize = 0x50;
/// u32 discriminator that, with the status id, identifies WHICH application of
/// an effect this is — the field the emit path sends as `ability_id`.
///
/// The game keys on it itself: the refresh hub `FUN_140bd5220` walks the
/// container's active list looking for a status whose id matches AND whose
/// `+0x4c` matches the caller's value, refreshing that one instead of creating
/// a second. Every call site passes a hardcoded constant (0x6a4 at one, 0 at
/// most), so it is a per-ability compile-time id, not a runtime magnitude —
/// which is what rules out the earlier "it might be potency" reading.
///
/// `0` is the game's own "don't care" (the hub skips the comparison when the
/// caller passes < 1), so it is sent as `None` rather than as a cause.
const STATUS_SUBID_OFFSET: usize = 0x4c;
/// Target entity handle triple (3 qwords).
const STATUS_TARGET_HANDLE: usize = 0x10;
/// Source entity handle triple (3 qwords) — who applied the status. Written by
/// `init` from `ctx+0x38..0x48`, and by the apply worker's creation branch
/// directly. The apply detour does not need it (it has the source's info block
/// as its `ctx` argument), but [`source_info_of`] does: the per-frame walk sees
/// the object without ever seeing the ctx that produced it.
const STATUS_SOURCE_HANDLE: usize = 0x28;
/// Flag bytes +0x78..+0x7b; +0x79 is the infinite-duration flag `init` sets.
#[cfg(feature = "hookdiag")]
const STATUS_FLAGS_OFFSET: usize = 0x78;
/// f32 initial duration (`init` writes it alongside +0x80).
#[cfg(feature = "hookdiag")]
const STATUS_INITIAL_OFFSET: usize = 0x7c;
/// f32 remaining duration, ticked down by `ExStatus::update`.
#[cfg(feature = "hookdiag")]
const STATUS_REMAINING_OFFSET: usize = 0x80;
/// i32 stack/level count (per-class stack-change handlers diff against it;
/// the factory pre-init value is -1). A true count only for the classes
/// `status.tbl` marks `HasLevels` — see [`stacks_for`], which is the only thing
/// that may turn this into a published number.
const STATUS_STACKS_OFFSET: usize = 0xb0;

/// Candidate cached-term field on every status object. Proven for cap buffs
/// (IStatusDamageLimitBuff+8, the live cap term); a probe elsewhere —
/// published raw, interpreted downstream.
const STATUS_TERM_OFFSET: usize = 0x8;

/// The ACTOR's current-action id (v2.0.3). Verified statically: FUN_140b06d20
/// — the proven Pl2000 function that applies Burn with cause 1100 — compares
/// `[RSI+0x1b690]` against `0x578` (1400 "Fourfold Vengeance (Dragonform)") and
/// `0xdc` (220 "Light Blast Finisher"), both real Pl2000 action ids; ten
/// further sites compare it against `0x320` (800, Chain Burst). A state enum
/// would not coincide with the owning character's own action names.
///
/// ONLY ever read on a RESOLVED ACTOR: a `VMOVSS` float write exists at the
/// same displacement on some other object type, so this offset is not
/// universally an action id.
const ACTOR_CURRENT_ACTION_OFFSET: usize = 0x1b690;

/// How many qwords of the init ctx struct to dump. The source handle sits at
/// +0x38..0x48; the window is wide enough to catch an action id / magnitude
/// living anywhere near it without flooding the log.
#[cfg(feature = "hookdiag")]
const CTX_DUMP_LEN: usize = 0x60;

type StatusInitFunc = unsafe extern "system" fn(*const usize, f32, *const usize);
type StatusDtorFunc = unsafe extern "system" fn(*const usize, u32) -> usize;

static_detour! {
    static OnStatusInit: unsafe extern "system" fn(*const usize, f32, *const usize);
    static OnStatusDtor: unsafe extern "system" fn(*const usize, u32) -> usize;
}

#[cfg(any(feature = "eject", test))]
pub(super) fn disable() {
    super::disable_quiet("OnStatusInit", &OnStatusInit);
    super::disable_quiet("OnStatusDtor", &OnStatusDtor);
    super::disable_quiet("OnStatusUpdate", &OnStatusUpdate);
    disable_variants();
}

/* Entity-info block offsets, decoded from the first live capture (2026-07-31):
the init ctx IS the source's entity-info block. +0x08 holds an inline ASCII
name ("PlayerNPC2", "Pl1900_Sub_PL2000", …), +0x38..0x48 the entity's own
handle triple {small id, self ptr, 64-bit uid}. The actor instance is at +0x70,
NOT the +0x50 this comment first claimed — see [`INFO_ACTOR_OFFSET`], which
records the two handle resolvers that prove it; +0x50 carries no identity
record. A status's target handle (+0x10..0x20) carries the
TARGET's entity-info block as its middle qword, so both sides resolve the
same way. */

/// Inline ASCII name within an entity-info block.
#[cfg(feature = "hookdiag")]
const INFO_NAME_OFFSET: usize = 0x08;
/// Longest name we render (the inline field is at least 0x18 bytes: "Pl1900_Sub_PL2000" spans 17).
#[cfg(feature = "hookdiag")]
const INFO_NAME_MAX: usize = 0x20;
/// The actor instance an ENTITY points at.
///
/// Ground truth, not inference: both of the game's own handle resolvers walk
/// exactly this link. `FUN_140c92ba0` validates the handle against the global
/// entity tables and then returns `*(entity + 0x70)`, and `FUN_14064fde0` does
/// the same before looking a component up at `actor + 0xc0`. It is also the
/// link `stunnet` already walks to attribute online stun, so all three agree.
///
/// The earlier `+0x50` reading came from eyeballing a live struct dump, and was
/// wrong: it points at something that carries no identity record, so every
/// holder fell through to the character-scoped `+0x170` index and distinct
/// players collapsed onto one row.
const INFO_ACTOR_OFFSET: usize = 0x70;

/// Middle qword of a handle triple: the entity-info pointer.
const HANDLE_INFO_PTR_OFFSET: usize = 0x8;
/// Span an actor instance must be readable over before calling the +0x58
/// type-id virtual / reading idx at +0x170 — same rule as the damage hook.
const ACTOR_SPAN: usize = 0x174;

/// Reads the inline ASCII name out of an entity-info block, guarded. Returns
/// "?" when the block or name is unreadable/empty.
#[cfg(feature = "hookdiag")]
fn info_name(info: usize) -> String {
    let Some(bytes) = diag::read_bytes_guarded(info, INFO_NAME_OFFSET, INFO_NAME_MAX) else {
        return "?".into();
    };
    let name: String = bytes
        .iter()
        .take_while(|&&b| b != 0)
        .map(|&b| if b.is_ascii_graphic() { b as char } else { '.' })
        .collect();
    if name.is_empty() {
        "?".into()
    } else {
        name
    }
}

/// The status's `status.tbl` id, or `None` when the field cannot be read.
///
/// Not `read_u32_guarded`, which answers 0 for an unreadable address: id 0 is
/// `atkup`, one of the most common buffs in the game, so a failed read there
/// would be indistinguishable from the real thing and would publish phantom
/// Attack Up intervals whenever a layout shifted.
fn status_id_of(status: *const usize) -> Option<u32> {
    diag::read_u32_opt_guarded(status as usize, STATUS_ID_OFFSET)
}

/// The status's `+0x4c` cause discriminator, or `None` when it is absent or
/// unreadable. Strict for the same reason as [`status_id_of`]: a guarded read
/// answering 0 is indistinguishable from the game's own "no specific cause".
fn cause_id_of(status: *const usize) -> Option<u32> {
    diag::read_u32_opt_guarded(status as usize, STATUS_SUBID_OFFSET).filter(|value| *value > 0)
}

/// The actor behind an entity-info block, or `None` when it cannot be
/// resolved. Shared because three readers here need the same guarded hop.
///
/// NOTE this proves the actor's FIRST `ACTOR_SPAN` bytes are mapped, which is
/// what a vtable-slot probe needs — it does NOT cover a deep field read. Those
/// are separately guarded by `read_*_guarded` at their own address.
fn resolve_actor(info: usize) -> Option<*const usize> {
    let actor = diag::read_ptr_guarded(info, INFO_ACTOR_OFFSET).unwrap_or(0);
    if actor == 0 || !readable(actor, ACTOR_SPAN) {
        return None;
    }
    Some(actor as *const usize)
}

/// The action the CASTER was performing when it applied a status, or `None`.
///
/// Names the rows `cause_id_of` cannot: a passive (a trait effect, a
/// guardpoint, a summon aura, a transformation) has no action id to write into
/// `+0x4c`, so the game stores a sentinel there — but the actor is still
/// mid-action, and this field is that action.
///
/// 0 is treated as no action — a reasonable reading of the idle state, but
/// UNCONFIRMED, unlike `cause_id_of`'s equivalent which the refresh hub's
/// `< 1` check backs.
fn caster_action_of(info: usize) -> Option<u32> {
    let actor = resolve_actor(info)? as usize;
    diag::read_u32_opt_guarded(actor, ACTOR_CURRENT_ACTION_OFFSET).filter(|value| *value > 0)
}

/// The actor a status is on, as the index the parser keys players by.
///
/// A player resolves through the same slot-key path the damage and stun hooks
/// use, so a buff lands on the same row as that player's damage. Anything else
/// — an enemy carrying a debuff — has no slot key and answers with its actor
/// index instead, which is what the frontend's roster check treats as "not a
/// player" and files under Debuffs.
///
/// `None` when the entity cannot be resolved at all: an event naming no actor
/// would be filed against a slot that is not the one it happened to.
fn holder_index(info: usize) -> Option<u32> {
    let actor = resolve_actor(info)?;
    // A non-player holder falls through `player_slot_key_for_source` into
    // `actor_type_id`, which CALLS the actor's +0x58 vfunc — and the dtor runs
    // during owner teardown, where the object can be mid-destruction with the
    // pages still mapped. `readable(actor, ACTOR_SPAN)` proves the object is
    // mapped, not that its vtable slot is: probe the slot first, exactly as
    // `resolve_source_parent_ptr` does, so a stale layout fails closed instead
    // of dispatching through a garbage pointer on a game thread.
    if !super::summon::vfunc_slot_readable(actor, 0x58) {
        return None;
    }
    Some(super::player_slot_key_for_source(actor).unwrap_or_else(|| super::actor_idx(actor)))
}

/// Resolves an entity to `name/actor/slot/idx/identity` for the diag log.
///
/// The identity is the discriminator worth keeping: it yields a party index and
/// a display name, and only a real player actor can produce those — which is
/// how the `+0x70` link was confirmed and `+0x50` ruled out. An enemy answers
/// `None` there and is identified by its actor index instead.
#[cfg(feature = "hookdiag")]
fn info_summary(info: usize) -> String {
    let name = info_name(info);
    let actor = diag::read_ptr_guarded(info, INFO_ACTOR_OFFSET).unwrap_or(0);
    if actor == 0 || !readable(actor, ACTOR_SPAN) {
        return format!("{name} actor={actor:#x}<unreadable>");
    }
    let ptr = actor as *const usize;
    format!(
        "{name} actor={actor:#x} emitted={:?} idx={:#x} type={:#x} ident={:?}",
        holder_index(info),
        super::actor_idx(ptr),
        super::actor_type_id(ptr),
        super::player::actor_embedded_identity(actor)
    )
}

/// The entity-info block of whoever a status is ON, read from the middle qword
/// of the target handle triple.
fn target_info_of(status: *const usize) -> usize {
    diag::read_ptr_guarded(
        status as usize,
        STATUS_TARGET_HANDLE + HANDLE_INFO_PTR_OFFSET,
    )
    .unwrap_or(0)
}

/// Renders the nonzero qwords of a guarded window as ` +0xOFF=0xVAL …` for the
/// diag log; unreadable or null windows render as a single marker instead of
/// faulting or spamming zeros.
#[cfg(feature = "hookdiag")]
fn dump_qwords(base: *const usize, len: usize) -> String {
    if base.is_null() {
        return " <null>".into();
    }
    let mut out = String::new();
    for off in (0..len).step_by(8) {
        match diag::read_ptr_guarded(base as usize, off) {
            Some(0) => {}
            Some(v) => {
                let _ = write!(out, " +{off:#x}={v:#x}");
            }
            None => {
                let _ = write!(out, " +{off:#x}=<unreadable>");
                break;
            }
        }
    }
    out
}

/// Largest believable stack count. Above this the field is not a level counter
/// — the layout shifted, or the class reuses it — and the count is dropped
/// rather than published. Same plausibility rule the sigil reader applies to
/// its own levels.
const MAX_PLAUSIBLE_STACKS: i32 = 100;

/// The stack count to publish for a status, from its raw `+0xb0`.
///
/// Answers 1 for everything it cannot vouch for: a status `status.tbl` does not
/// mark `HasLevels` (the field is uninitialised, or the class stores something
/// else there — barrier keeps its absorb value in it), an unreadable field, the
/// factory's pre-init -1, and anything too large to be a level count. 1 is what
/// the hook published for every status before the table existed, so a status
/// that falls through here is no worse off than it was.
fn stacks_for(status_id: u32, raw: Option<i32>) -> u32 {
    if !super::status_levels::has_levels(status_id) {
        return 1;
    }
    match raw {
        Some(count) if (1..=MAX_PLAUSIBLE_STACKS).contains(&count) => count as u32,
        _ => 1,
    }
}

/// The status's raw `+0xb0`, or `None` when it cannot be read.
fn raw_stacks_of(status: *const usize) -> Option<i32> {
    diag::read_i32_opt_guarded(status as usize, STATUS_STACKS_OFFSET)
}

#[cfg(test)]
mod stack_tests {
    use super::stacks_for;

    #[test]
    fn a_stackable_status_reports_its_count() {
        // damagecut (4) is HasLevels, so +0xb0 means what it says.
        assert_eq!(stacks_for(4, Some(3)), 3);
    }

    #[test]
    fn a_non_stackable_status_always_reports_one() {
        // atkup (0) is not HasLevels; whatever sits at +0xb0 is not a count.
        assert_eq!(stacks_for(0, Some(7)), 1);
        // barrier (41) keeps its ABSORB value there — 2000 stacks of anything
        // is exactly the garbage this guard exists to keep off the wire.
        assert_eq!(stacks_for(41, Some(2000)), 1);
    }

    #[test]
    fn the_factory_pre_init_value_is_not_a_count() {
        // The factory writes -1 before the class initialises the field.
        assert_eq!(stacks_for(4, Some(-1)), 1);
        assert_eq!(stacks_for(4, Some(0)), 1);
    }

    #[test]
    fn an_unreadable_field_reports_one() {
        assert_eq!(stacks_for(4, None), 1);
    }

    #[test]
    fn an_implausible_count_reports_one() {
        // Not a level count — the layout shifted, or the class reuses the
        // field. Falling back to 1 loses a stack count; publishing 70000 would
        // put a fabricated one in the log forever.
        assert_eq!(stacks_for(4, Some(70_000)), 1);
    }
}

/// What identifies one live status across frames: the object, the effect, and
/// the cause.
///
/// The object pointer ALONE would not do. The allocator reissues a freed
/// status's address, so a recycled pointer carrying a different effect would be
/// mistaken for the one that used to live there and never reported.
type StatusKey = (usize, u32, Option<u32>);

/// Largest believable number of statuses on one holder. Above this the pair of
/// list bounds did not come from this list — a torn read (the two halves are not
/// read atomically) or a shifted layout — and the walk is abandoned rather than
/// stepping through unrelated memory on a game thread.
const MAX_PLAUSIBLE_STATUSES: usize = 256;

/// How many `StatusBase*` a holder's list holds, or `None` when the bounds are
/// not a plausible description of it.
fn live_count(begin: usize, end: usize) -> Option<usize> {
    let span = end.checked_sub(begin)?;
    if span % std::mem::size_of::<usize>() != 0 {
        return None;
    }
    let count = span / std::mem::size_of::<usize>();
    (count <= MAX_PLAUSIBLE_STATUSES).then_some(count)
}

/// The entries of `current` that `previous` did not hold — i.e. the statuses
/// that arrived since the last walk of this holder.
fn newly_applied(previous: &[StatusKey], current: &[StatusKey]) -> Vec<StatusKey> {
    // The overwhelmingly common frame is "nothing changed", and the membership
    // test below is quadratic. Both lists are built in list order, so an
    // unchanged holder compares equal in one linear pass — which keeps a holder
    // at the plausibility cap from costing 65k comparisons every frame.
    if previous == current {
        return Vec::new();
    }
    current
        .iter()
        .filter(|key| !previous.contains(key))
        .copied()
        .collect()
}

#[cfg(test)]
mod list_tests {
    use super::{live_count, newly_applied, MAX_PLAUSIBLE_STATUSES};

    #[test]
    fn a_normal_span_yields_its_element_count() {
        assert_eq!(live_count(0x1000, 0x1018), Some(3));
    }

    #[test]
    fn an_empty_vector_holds_nothing() {
        // A default-constructed `std::vector` is begin == end == nullptr, which
        // is a holder carrying no statuses — NOT an unreadable list. Rejecting
        // it would be harmless here but would muddle the two cases.
        assert_eq!(live_count(0, 0), Some(0));
        assert_eq!(live_count(0x1000, 0x1000), Some(0));
    }

    #[test]
    fn an_end_before_its_begin_is_rejected() {
        // A torn read of the two halves (they are not read atomically), or a
        // layout shift. Walking it would run off into unrelated memory.
        assert_eq!(live_count(0x1018, 0x1000), None);
    }

    #[test]
    fn a_misaligned_span_is_rejected() {
        // The list holds 8-byte pointers; a span that is not a whole number of
        // them is not this list.
        assert_eq!(live_count(0x1000, 0x1004), None);
    }

    #[test]
    fn an_implausible_count_is_rejected() {
        // The guard that keeps a shifted layout from turning into a walk of
        // millions of entries on a game thread — same rule `stacks_for` applies
        // to its own field.
        let end = 0x1000 + (MAX_PLAUSIBLE_STATUSES + 1) * 8;
        assert_eq!(live_count(0x1000, end), None);
    }

    #[test]
    fn a_status_absent_last_frame_is_newly_applied() {
        assert_eq!(
            newly_applied(&[], &[(0x10, 25, None)]),
            vec![(0x10, 25, None)]
        );
    }

    #[test]
    fn a_status_still_held_is_not_reported_again() {
        // The walk runs every frame. Re-reporting a standing buff would inflate
        // its application count sixty times a second.
        let previous = [(0x10, 25, None)];
        assert!(newly_applied(&previous, &previous).is_empty());
    }

    #[test]
    fn a_recycled_pointer_holding_a_different_effect_is_newly_applied() {
        // The allocator reissues a freed status's address. Keyed on the pointer
        // ALONE, the effect that lands on a recycled one would be taken for the
        // old occupant and never reported at all.
        let previous = [(0x10, 25, None)];
        let current = [(0x10, 6, None)];
        assert_eq!(newly_applied(&previous, &current), vec![(0x10, 6, None)]);
    }

    #[test]
    fn the_same_effect_from_a_second_cause_is_its_own_application() {
        // Identity is (object, effect, cause) for the same reason the parser's
        // interval key carries the cause: two abilities granting one effect must
        // stay separable.
        let previous = [(0x10, 0, Some(500))];
        let current = [(0x10, 0, Some(500)), (0x20, 0, Some(600))];
        assert_eq!(
            newly_applied(&previous, &current),
            vec![(0x20, 0, Some(600))]
        );
    }

    #[test]
    fn everything_is_new_on_the_first_walk() {
        // Injecting mid-quest, or the opening frame of a fight: the holder is
        // already carrying its quest-start buffs, and those are precisely the
        // ones the apply path never reported.
        let current = [(0x10, 20, None), (0x18, 25, None)];
        assert_eq!(newly_applied(&[], &current).len(), 2);
    }
}

/// Observes every `StatusBase::init` — i.e. (nearly) every buff/debuff
/// application. Logs the status identity/duration fields after the original
/// has armed them, plus a raw dump of the apply ctx. Stateless (like
/// `OnFullAssistGateHook`): the struct only carries the `new()/setup()`
/// convention the hook list is wired with; the detour is a free function.
#[derive(Clone)]
pub struct OnStatusInitHook {
    tx: event::Tx,
}

impl OnStatusInitHook {
    pub fn new(tx: event::Tx) -> Self {
        Self { tx }
    }

    pub fn setup(&self, process: &Process) -> Result<()> {
        let cloned_self = self.clone();

        if let Ok(addr) = process.search_address(STATUS_INIT_SIG) {
            unsafe {
                let func: StatusInitFunc = std::mem::transmute(addr);
                OnStatusInit.initialize(func, move |status, duration, ctx| {
                    run_init(&cloned_self.tx, status, duration, ctx)
                })?;
                OnStatusInit.enable()?;
            }
            Ok(())
        } else {
            Err(anyhow!("Could not find status_init"))
        }
    }
}

fn run_init(tx: &event::Tx, status: *const usize, duration: f32, ctx: *const usize) {
    // The id may be stamped before OR after init in the apply sequence —
    // capturing it on both sides of the original call is how we found out.
    // Diag-only: the emit path below reads the id the status is left holding.
    #[cfg(feature = "hookdiag")]
    let id_before = diag::read_u32_guarded(status as usize, STATUS_ID_OFFSET);

    unsafe { OnStatusInit.call(status, duration, ctx) };

    // The ctx IS the source's entity-info block; the target's block rides
    // as the middle qword of the status's target handle triple.
    let target_info = target_info_of(status);

    // Only an apply that names both an effect and an actor it is on can be
    // assembled into an interval; anything less would file a window against a
    // slot it did not happen to. The quest gate comes first because everything
    // after it is expensive: `holder_index` walks the actor's embedded identity
    // record, and statuses are applied constantly in town, menus and the lobby
    // where no encounter can exist to file them against.
    if super::quest::in_quest_now() {
        if let (Some(status_id), Some(actor_index)) =
            (status_id_of(status), holder_index(target_info))
        {
            let _ = tx.send(protocol::Message::StatusApply(protocol::StatusApplyEvent {
                actor_index,
                // The caster is only sent when it resolves; an unresolvable
                // source is not the same claim as "no attributable caster", but
                // both read as "not attributed" downstream and neither may name
                // a wrong one.
                caster_index: holder_index(ctx as usize),
                status_id,
                // The +0x4c discriminator, which is what keeps two abilities
                // granting one effect on separate rows. NOT a named action id:
                // it is an effect-entry constant, so the UI shows the number
                // until a mapping from it to a skill exists.
                ability_id: cause_id_of(status),
                // +0xb0, but only for the ids status.tbl marks HasLevels;
                // everything else reports 1. See `stacks_for`.
                stacks: stacks_for(status_id, raw_stacks_of(status)),
                // What the object IS, for the rows `ability_id` cannot name.
                status_class: super::status_class::status_class_of(status),
                // What the caster was DOING, which names a passive's row even
                // though no action id was recorded against it.
                caster_action_id: caster_action_of(ctx as usize),
            }));
        }
    }

    // Everything below is the diag line only, so none of these reads happen in
    // a release hook.
    #[cfg(feature = "hookdiag")]
    let id_after = diag::read_u32_guarded(status as usize, STATUS_ID_OFFSET);
    #[cfg(feature = "hookdiag")]
    let sub_id = diag::read_u32_guarded(status as usize, STATUS_SUBID_OFFSET);
    #[cfg(feature = "hookdiag")]
    let initial = diag::read_f32_guarded(status as usize, STATUS_INITIAL_OFFSET);
    #[cfg(feature = "hookdiag")]
    let remaining = diag::read_f32_guarded(status as usize, STATUS_REMAINING_OFFSET);
    #[cfg(feature = "hookdiag")]
    let flags = diag::read_u32_guarded(status as usize, STATUS_FLAGS_OFFSET);
    #[cfg(feature = "hookdiag")]
    let stacks = diag::read_u32_guarded(status as usize, STATUS_STACKS_OFFSET) as i32;
    #[cfg(feature = "hookdiag")]
    let source_summary = info_summary(ctx as usize);
    #[cfg(feature = "hookdiag")]
    let target_summary = info_summary(target_info);

    diag::ev!(
        "status_init",
        "this={:#x} id={id_before}->{id_after} sub_id={sub_id:#x} dur_arg={duration} \
         initial={initial:?} remaining={remaining:?} flags78={flags:#010x} stacks={stacks} \
         src[{source_summary}] tgt[{target_summary}] ctx={:#x}[{} ]",
        status as usize,
        ctx as usize,
        dump_qwords(ctx, CTX_DUMP_LEN)
    );
}

/// Observes every shared-dtor status death (expired, dispelled, or owner
/// teardown). Fields are read BEFORE the original tears the object down.
/// Stateless, like [`OnStatusInitHook`].
#[derive(Clone)]
pub struct OnStatusDtorHook {
    tx: event::Tx,
}

impl OnStatusDtorHook {
    pub fn new(tx: event::Tx) -> Self {
        Self { tx }
    }

    pub fn setup(&self, process: &Process) -> Result<()> {
        let cloned_self = self.clone();

        if let Ok(addr) = process.search_address(STATUS_DTOR_SIG) {
            unsafe {
                let func: StatusDtorFunc = std::mem::transmute(addr);
                OnStatusDtor.initialize(func, move |status, dtor_flags| {
                    run_dtor(&cloned_self.tx, status, dtor_flags)
                })?;
                OnStatusDtor.enable()?;
            }
            Ok(())
        } else {
            Err(anyhow!("Could not find status_dtor"))
        }
    }
}

fn run_dtor(tx: &event::Tx, status: *const usize, dtor_flags: u32) -> usize {
    emit_remove(tx, status, dtor_flags);
    unsafe { OnStatusDtor.call(status, dtor_flags) }
}

/// The removal observation itself — everything [`run_dtor`] does short of
/// calling the original. Split out so the per-class dtor variants (below) can
/// share it verbatim: every field read happens BEFORE any original runs, so
/// one body serves all fourteen entry points.
// `dtor_flags` is diag-only, so a release build sees it unused.
#[cfg_attr(not(feature = "hookdiag"), allow(unused_variables))]
fn emit_remove(tx: &event::Tx, status: *const usize, dtor_flags: u32) {
    // Diag-only reads; the removal itself needs the id and the holder.
    #[cfg(feature = "hookdiag")]
    let id = diag::read_u32_guarded(status as usize, STATUS_ID_OFFSET);
    #[cfg(feature = "hookdiag")]
    let remaining = diag::read_f32_guarded(status as usize, STATUS_REMAINING_OFFSET);
    #[cfg(feature = "hookdiag")]
    let flags = diag::read_u32_guarded(status as usize, STATUS_FLAGS_OFFSET);
    #[cfg(feature = "hookdiag")]
    let stacks = diag::read_u32_guarded(status as usize, STATUS_STACKS_OFFSET) as i32;
    // Who the dying status was on: remaining≈0 here is a natural expiry,
    // remaining>0 an early removal (dispel/replace/owner death).
    let target_info = target_info_of(status);

    // Pairs with the apply by (actor, status, ability) — so the ability must be
    // sent the same way it was sent there, or nothing would ever close. Gated
    // identically to the apply, and it must stay that way: a gate that admitted
    // removes but not applies would close windows that were never opened.
    if super::quest::in_quest_now() {
        if let (Some(status_id), Some(actor_index)) =
            (status_id_of(status), holder_index(target_info))
        {
            let _ = tx.send(protocol::Message::StatusRemove(
                protocol::StatusRemoveEvent {
                    actor_index,
                    status_id,
                    // Read the same way `run_init` reads it, from the same field
                    // on the same object: the fields are read BEFORE the
                    // original tears the object down, so +0x4c still holds the
                    // cause it was applied with. Sending `None` here instead
                    // left every status with a nonzero cause permanently open.
                    ability_id: cause_id_of(status),
                },
            ));
        }
    }

    diag::ev!(
        "status_dtor",
        "this={:#x} dtor_flags={dtor_flags:#x} id={id} remaining={remaining:?} \
         flags78={flags:#010x} stacks={stacks} tgt[{}]",
        status as usize,
        info_summary(target_info)
    );
}

/* Per-class dtor overrides.

The shared scalar-deleting dtor covers 147 of the family's vtables, but 20
classes override slot 0 with their own — verified on the v2.0.3 gbfr203fast DB
by dumping slot 0 of every `Status*` vftable and keeping the classes whose
vftable set never reaches the shared entry. Their removals were invisible, so
those statuses' intervals ran to the end of the fight: Zeta's Ares, Io's
Concentration Ex, Katalina's Cover/Noble/Guardpoint among them.

COMDAT folding leaves 13 DISTINCT primary entries (decompile-verified: the
primary is the body that writes `StatusBase::vftable` at offset 0; the other
addresses in each class's set are secondary-vftable full clones the removal
paths never dispatch — `ExStatus` holds primary `StatusBase*` — or adjustor
thunks that forward into a primary). All take the same `(this, flags)` the
shared dtor takes, verified from their prologues.

Each signature anchors on the prologue plus the class's own member
displacements (what makes one fold-group's dtor differ from another's), with
RIP-relative displacements wildcarded; each was verified to match EXACTLY once,
resolving to its known entry. A miss degrades to that group's statuses running
long again — never to a wrong detour, because 0 matches skips the install. */
macro_rules! status_dtor_variants {
    ($(($detour:ident, $label:literal, $sig:expr)),+ $(,)?) => {
        static_detour! {
            $(static $detour: unsafe extern "system" fn(*const usize, u32) -> usize;)+
        }

        #[cfg(any(feature = "eject", test))]
        pub(super) fn disable_variants() {
            $(super::disable_quiet($label, &$detour);)+
        }

        /// Installs every per-class dtor detour, tolerating individual misses:
        /// the ones that matched stay enabled, and the error names the rest.
        fn setup_variants(tx: &event::Tx, process: &Process) -> Result<()> {
            let mut missing: Vec<&'static str> = Vec::new();
            $(
                match process.search_address($sig) {
                    Ok(addr) => {
                        let tx = tx.clone();
                        // Defined outside the unsafe block so the closure's own
                        // `.call` is the one unsafe op it contains.
                        let detour = move |status: *const usize, dtor_flags: u32| -> usize {
                            emit_remove(&tx, status, dtor_flags);
                            unsafe { $detour.call(status, dtor_flags) }
                        };
                        unsafe {
                            let func: StatusDtorFunc = std::mem::transmute(addr);
                            $detour.initialize(func, detour)?;
                            $detour.enable()?;
                        }
                    }
                    Err(_) => missing.push($label),
                }
            )+
            if missing.is_empty() {
                Ok(())
            } else {
                Err(anyhow!("no match for: {}", missing.join(", ")))
            }
        }
    };
}

status_dtor_variants! {
    // Pl1000 charge parry + Pl1100 cover (one folded body).
    (OnDtorChargeParry, "dtor_charge_parry",
     "' 56 57 53 48 83 ec 20 89 d7 48 89 ce 48 8b 89 28 01 00 00 48 85 c9 74 1e 48 8d 86 f0 00 00 00 \
      48 39 c1 0f 95 c2 48 8b 01 ff 50 20 48 c7 86 28 01 00 00 00 00 00 00"),
    // Pl2400 spm damage up.
    (OnDtorSpmDamageUp, "dtor_spm_damage_up",
     "' 56 57 53 48 83 ec 20 89 d7 48 89 ce 48 8b 89 10 01 00 00 48 85 c9 74 1e 48 8d 86 d8 00 00 00 \
      48 39 c1 0f 95 c2 48 8b 01 ff 50 20 48 c7 86 10 01 00 00 00 00 00 00"),
    // Pl1200 guardpoint + Pl2400 ab dmg (one folded body).
    (OnDtorGuardpoint, "dtor_guardpoint",
     "' 56 57 53 48 83 ec 20 89 d7 48 89 ce 48 8b 89 58 01 00 00 48 85 c9 74 1e 48 8d 86 20 01 00 00 \
      48 39 c1 0f 95 c2 48 8b 01 ff 50 20 48 c7 86 58 01 00 00 00 00 00 00"),
    // Pl2400 g-swing just.
    (OnDtorGSwingJust, "dtor_gswing_just",
     "' 56 57 53 48 83 ec 20 89 d7 48 89 ce 48 8b 89 20 01 00 00 48 85 c9 74 1e 48 8d 86 e8 00 00 00 \
      48 39 c1 0f 95 c2 48 8b 01 ff 50 20 48 c7 86 20 01 00 00 00 00 00 00"),
    // The four Pl2600 clock buffs (one folded body); this one re-seats TWO
    // vftables before touching members, hence the different shape.
    (OnDtorClock, "dtor_clock",
     "' 56 57 53 48 83 ec 20 89 d7 48 89 ce 48 8d 05 ? ? ? ? 48 89 01 48 8d 05 ? ? ? ? \
      48 89 81 b0 00 00 00 48 8b 89 f8 00 00 00 48 85 c9 74 1e 48 8d 86 c0 00 00 00"),
    // Pl1000 charge attack.
    (OnDtorChargeAttack, "dtor_charge_attack",
     "' 56 57 53 48 83 ec 20 89 d7 48 89 ce 48 8b 89 40 01 00 00 48 85 c9 74 1e 48 8d 86 08 01 00 00 \
      48 39 c1 0f 95 c2 48 8b 01 ff 50 20 48 c7 86 40 01 00 00 00 00 00 00"),
    // Pl1100 just + Pl1800 charge attack (one folded body).
    (OnDtorJust, "dtor_just",
     "' 56 57 53 48 83 ec 20 89 d7 48 89 ce 48 8b 89 50 01 00 00 48 85 c9 74 1e 48 8d 86 18 01 00 00 \
      48 39 c1 0f 95 c2 48 8b 01 ff 50 20 48 c7 86 50 01 00 00 00 00 00 00"),
    // Pl1000 flame empire.
    (OnDtorFlameEmpire, "dtor_flame_empire",
     "' 56 57 53 48 83 ec 20 89 d7 48 89 ce 48 8b 89 18 01 00 00 48 85 c9 74 1e 48 8d 86 e0 00 00 00 \
      48 39 c1 0f 95 c2 48 8b 01 ff 50 20 48 c7 86 18 01 00 00 00 00 00 00"),
    // Pl0400 concentration EX + Pl1200 noble (one folded body).
    (OnDtorConcentrationEx, "dtor_concentration_ex",
     "' 56 57 53 48 83 ec 20 89 d7 48 89 ce 48 8b 89 a0 01 00 00 48 85 c9 74 1e 48 8d 86 68 01 00 00 \
      48 39 c1 0f 95 c2 48 8b 01 ff 50 20 48 c7 86 a0 01 00 00 00 00 00 00"),
    // Pl0200 Ares.
    (OnDtorAres, "dtor_ares",
     "' 56 57 53 48 83 ec 20 89 d7 48 89 ce 48 8b 89 08 01 00 00 48 85 c9 74 1e 48 8d 86 d0 00 00 00 \
      48 39 c1 0f 95 c2 48 8b 01 ff 50 20 48 c7 86 08 01 00 00 00 00 00 00"),
    // Em1806 aura; the EH-frame prologue variant.
    (OnDtorEm1806Aura, "dtor_em1806_aura",
     "' 55 56 57 53 48 83 ec 28 48 8d 6c 24 20 48 c7 45 00 fe ff ff ff 89 d7 48 89 ce \
      48 8b 89 c0 00 00 00 48 85 c9 74 10 48 c7 86 c0 00 00 00 00 00 00 00 e8 ? ? ? ? \
      48 8d 05 ? ? ? ? 48 89 06"),
    // Em0001 (goblin witch doctor) buff.
    (OnDtorEm0001, "dtor_em0001",
     "' 55 56 57 53 48 83 ec 28 48 8d 6c 24 20 48 c7 45 00 fe ff ff ff 89 d7 48 89 ce \
      48 8b 89 00 01 00 00 48 85 c9 74 10 48 c7 86 00 01 00 00 00 00 00 00 e8 ? ? ? ? \
      48 8d 05 ? ? ? ? 48 89 06"),
    // Pl1200 attack buff.
    (OnDtorPl1200Attack, "dtor_pl1200_attack",
     "' 55 56 57 53 48 83 ec 28 48 8d 6c 24 20 48 c7 45 00 fe ff ff ff 89 d7 48 89 ce \
      48 8b 89 d8 00 00 00 48 85 c9 74 10 48 c7 86 d8 00 00 00 00 00 00 00 e8 ? ? ? ? \
      48 8d 05 ? ? ? ? 48 89 06"),
}

/// Installs the 13 per-class dtor detours — the removal coverage the shared
/// dtor cannot give. Stateless, like [`OnStatusDtorHook`].
#[derive(Clone)]
pub struct OnStatusDtorVariantsHook {
    tx: event::Tx,
}

impl OnStatusDtorVariantsHook {
    pub fn new(tx: event::Tx) -> Self {
        Self { tx }
    }

    pub fn setup(&self, process: &Process) -> Result<()> {
        setup_variants(&self.tx, process)
    }
}

/* The apply coverage `StatusBase::init` cannot give.

`init` is the REFRESH path, not the apply path — a fact this file asserted the
opposite of until 2026-08-06. The shared apply worker `FUN_140bcca20` (v2.0.3)
has two branches: when it finds an existing status with a matching id and cause
it writes the new cause to `+0x4c` and calls `vtable[0x10]` (the hooked `init`),
but when it must create one it builds the object from a factory table and arms
it INLINE — the same `duration < 0 => 9999.0`, `+0x79` flag and `+0x7c`/`+0x80`
stores that `init` does, compiled straight into the branch — then pushes it onto
the holder's list. `init` is never entered, so the application was never
reported.

Measured over one session's hookdiag log, that lost: EVERY application of
Invincibility (0 inits against 295 removals), Autorevive (0/56), Mirror Image,
Critical Hit Rate up, Dragonform, Bloodthirst, DMG up, Pincer Synergy and
Inversa — and all but 36 of ATK up's 240. An effect that is never refreshed had
no row at all; one that is refreshed opened its window at the first REFRESH, so
its uptime began late and its count counted refreshes.

Rather than chase the ~350 apply call sites through two front doors, this
observes the holder itself: `ExStatus::update` ticks one status holder per
frame, so walking its list and reporting what is new since the last tick catches
an application whatever path made it. It is also the only way to see a status
applied before the hook attached, or before the encounter opened.

STRICTLY ADDITIVE: it reports an object only the first time it is seen, and
removals still ride the dtors above. If it observes nothing new, behaviour is
what it was.

Verified 1 match on v2.0.3 resolving to the known entry 0xbd5d20. Both argument
registers come from the PROLOGUE (`MOV R13,RCX` + `VMOVAPS XMM6,XMM1`), not from
the decompiler, which reports this function as taking `param_1` alone: the fast
analysis profile disables Decompiler Parameter ID, so it drops the float. A
one-argument detour here would have left XMM1 garbage on a game thread. */

/// `ExStatus::update(this, f32 delta)` entry. Anchored on the `int3` padding
/// before the entry plus the whole register-save prologue and the frame-gate
/// read that follows it, with that read's RIP-relative displacement wildcarded
/// (it shifts every patch). The prologue alone matches a second, unrelated
/// function — the gate read is what separates them.
const STATUS_UPDATE_SIG: &str = "cc cc cc cc ' 55 41 57 41 56 41 55 41 54 56 57 53 48 81 ec d8 01 \
                                 00 00 48 8d ac 24 80 00 00 00 c5 78 29 a5 40 01 00 00 c5 78 29 9d \
                                 30 01 00 00 c5 78 29 95 20 01 00 00 c5 78 29 8d 10 01 00 00 c5 78 \
                                 29 85 00 01 00 00 c5 f8 29 bd f0 00 00 00 c5 f8 29 b5 e0 00 00 00 \
                                 48 c7 85 d8 00 00 00 fe ff ff ff 48 8b 05 ? ? ? ? f6 40 0a 01";

/// The holder's active-status list: a `std::vector<StatusBase*>`, so begin/end
/// bound it and the difference is a whole number of pointers. Read from the
/// creation branch of the apply worker, which push_backs the new status here.
const EX_STATUS_LIST_BEGIN: usize = 0x18;
/// End of that vector; see [`EX_STATUS_LIST_BEGIN`].
const EX_STATUS_LIST_END: usize = 0x20;

/// Where the `ExStatus` component is EMBEDDED in a player-family actor
/// instance, so a caller holding only the actor (the damage detours do) can
/// reach the same list [`OnStatusUpdateHook`] is handed directly.
///
/// Statically derived against v2.0.4, not guessed. MSVC RTTI records every base
/// subobject's offset, and the whole image defines exactly five
/// `ExStatus::RTTI_Base_Class_Descriptor_at_(N)` — N = 0, 1872, 2784, 3320,
/// 3328 — so the embed offset is CLASS-DEPENDENT and a single constant is only
/// safe for a named family. Reading each class's
/// `RTTI_Base_Class_Array` for the descriptor it lists:
///
/// * 2784 (`0xAE0`) — every playable class checked: `Pl0000`, `Pl0100`,
///   `Pl0200`, `Pl0300`, `Pl0400`, `Pl0500`, `Pl0600`, `Pl0700`, `Pl0800`,
///   `Pl0900`, `Pl1000`, `Pl1100`, `Pl1200`, `Pl1300`, `Pl1400`, `Pl1500`,
///   `Pl1600`, `Pl1700`, `Pl1800`, `Pl1900`, `Pl2000`, `Pl2100`, `Pl2200`,
///   `Pl2300`, `Pl2400`, `Pl2500`, `Pl2600`, `Pl2700`, `Pl2800`, `Pl2900`, and
///   the crew-NPC class `Np0000`. Thirty-one for thirty-one.
/// * 3320 (`0xCF8`) — the enemy classes checked (`Em1200`, `Em2700`), which is
///   why [`snapshot_player_statuses`] refuses anything that is not a player.
///
/// The game's own cap code agrees: the DamageInstance builder
/// (`FUN_1409c1cf0`) reads the attacker's status vector as `holder[0x15f]` /
/// `holder[0x160]` — byte offsets `0xAF8`/`0xB00`, which is exactly this embed
/// plus [`EX_STATUS_LIST_BEGIN`]/[`EX_STATUS_LIST_END`]. Two independent
/// derivations, one number.
const PLAYER_EX_STATUS_OFFSET: usize = 0xAE0;

/// Largest snapshot [`snapshot_player_statuses`] will publish.
///
/// Lower than [`MAX_PLAUSIBLE_STATUSES`] on purpose: that bound protects a
/// per-frame walk from stepping through unrelated memory, while this one also
/// bounds what a per-HIT capture writes into every stored log. A party member
/// carrying more than this many effects at once is not a state any cap
/// condition needs resolved to the last entry, and the list is stored per
/// damage event.
const MAX_SNAPSHOT_STATUSES: usize = 64;

/// Every status a PLAYER actor is carrying right now, as the per-hit snapshot
/// [`protocol::DamageEvent::source_statuses`] publishes.
///
/// `None` — never an empty list — for anything this cannot vouch for: a null
/// actor, an unreadable component, or list bounds that are not a plausible
/// description of a vector. The caller's `Option` then reads as "not captured"
/// rather than "the attacker held nothing", which are different claims.
///
/// The caller is responsible for proving the actor is player-family before
/// calling; see [`PLAYER_EX_STATUS_OFFSET`] for why an enemy would read the
/// wrong component.
pub(crate) fn snapshot_player_statuses(actor: *const usize) -> Option<Vec<protocol::SourceStatus>> {
    if actor.is_null() {
        return None;
    }
    let ex_status = (actor as usize).checked_add(PLAYER_EX_STATUS_OFFSET)?;
    let (begin, end) = (
        diag::read_ptr_guarded(ex_status, EX_STATUS_LIST_BEGIN)?,
        diag::read_ptr_guarded(ex_status, EX_STATUS_LIST_END)?,
    );
    let count = live_count(begin, end)?;
    if count == 0 {
        return Some(Vec::new());
    }
    // ONE probe for the whole array, for the reason `live_keys` documents:
    // `IsBadReadPtr` takes an exception path on unmapped memory, and this runs
    // on a game thread inside the damage call.
    if !readable(begin, count * std::mem::size_of::<usize>()) {
        return None;
    }

    let mut out = Vec::with_capacity(count.min(MAX_SNAPSHOT_STATUSES));
    for index in 0..count.min(MAX_SNAPSHOT_STATUSES) {
        let status =
            unsafe { ((begin + index * std::mem::size_of::<usize>()) as *const usize).read() };
        if status == 0 {
            continue;
        }
        // ONE probe of the object, then two direct field reads — both fields sit
        // inside the span it covers. Going through `status_id_of` /
        // `raw_stacks_of` would probe twice per status, and this walk runs
        // inside the game's own damage call rather than once a frame. A slot
        // pointing at freed memory is skipped rather than abandoning the
        // snapshot: the rest of the list is still good information.
        if !readable(status, STATUS_STACKS_OFFSET + std::mem::size_of::<i32>()) {
            continue;
        }
        // Exactly the fields, and exactly the rules, the apply path publishes —
        // a snapshot that disagreed with the event stream about an effect's id
        // or its stack count would make the two impossible to reconcile.
        let status_id = unsafe { ((status + STATUS_ID_OFFSET) as *const u32).read_unaligned() };
        let raw_stacks =
            unsafe { ((status + STATUS_STACKS_OFFSET) as *const i32).read_unaligned() };
        let term_raw = unsafe { ((status + STATUS_TERM_OFFSET) as *const u32).read_unaligned() };
        out.push(protocol::SourceStatus {
            status_id,
            stacks: stacks_for(status_id, Some(raw_stacks)),
            term_bits: f32::from_bits(term_raw).is_finite().then_some(term_raw),
        });
    }
    Some(out)
}

type StatusUpdateFunc = unsafe extern "system" fn(*const usize, f32);

static_detour! {
    static OnStatusUpdate: unsafe extern "system" fn(*const usize, f32);
}

/// What each holder's list held at its previous tick, keyed by holder.
///
/// Cleared whenever the game is outside a quest, which both bounds it (holders
/// die with their actors, and nothing else ever removes their entry) and makes
/// the first tick of a fight report everything standing — which is the whole
/// point, since quest-start buffs are applied before any encounter exists.
static LAST_SEEN: std::sync::Mutex<Option<std::collections::HashMap<usize, Vec<StatusKey>>>> =
    std::sync::Mutex::new(None);

thread_local! {
    /// Per-thread scratch for the current holder's list, so the per-frame walk
    /// does not allocate. `RefCell` with a FALLIBLE borrow: holders tick on
    /// whichever thread the game chooses, and a reentrant walk must skip rather
    /// than panic on a game thread.
    static SCRATCH: std::cell::RefCell<Vec<StatusKey>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// The entity-info block of whoever APPLIED a status, read from the middle qword
/// of its source handle triple — the mirror of [`target_info_of`].
///
/// This is what lets the walk attribute a caster without the apply ctx that
/// [`run_init`] receives as an argument: the creation branch writes the source
/// triple into the object (`+0x28`..`+0x40`) before the status ever ticks.
fn source_info_of(status: *const usize) -> usize {
    diag::read_ptr_guarded(
        status as usize,
        STATUS_SOURCE_HANDLE + HANDLE_INFO_PTR_OFFSET,
    )
    .unwrap_or(0)
}

/// What the walk actually costs, so a live run reports it instead of leaving it
/// to inference. Emitted every [`walk_stats::REPORT_EVERY`] walks: the `t` delta
/// between two reports is the wall time those walks took, and `unreadable`
/// counts holders whose list span failed its probe — the case that would
/// otherwise cost an exception unwind per slot, on a game thread.
#[cfg(feature = "hookdiag")]
mod walk_stats {
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

    pub static WALKS: AtomicU64 = AtomicU64::new(0);
    pub static UNREADABLE: AtomicU64 = AtomicU64::new(0);
    pub static EMITTED: AtomicU64 = AtomicU64::new(0);
    pub static MAX_LIST: AtomicUsize = AtomicUsize::new(0);

    pub const REPORT_EVERY: u64 = 20_000;

    pub fn note_list(len: usize) {
        MAX_LIST.fetch_max(len, Ordering::Relaxed);
    }

    pub fn note_unreadable() {
        UNREADABLE.fetch_add(1, Ordering::Relaxed);
    }

    pub fn note_emitted() {
        EMITTED.fetch_add(1, Ordering::Relaxed);
    }

    /// True once every [`REPORT_EVERY`] walks.
    pub fn due() -> bool {
        WALKS.fetch_add(1, Ordering::Relaxed) % REPORT_EVERY == REPORT_EVERY - 1
    }

    pub fn snapshot() -> (u64, u64, u64, usize) {
        (
            WALKS.load(Ordering::Relaxed),
            UNREADABLE.load(Ordering::Relaxed),
            EMITTED.load(Ordering::Relaxed),
            MAX_LIST.load(Ordering::Relaxed),
        )
    }
}

/// Every status the holder currently carries, as the identity the diff keys on.
///
/// `None` when the list bounds are not readable or not plausible — the previous
/// snapshot is then left alone, so a single bad frame loses nothing.
fn live_keys(ex_status: *const usize, out: &mut Vec<StatusKey>) -> bool {
    out.clear();
    let base = ex_status as usize;
    let (Some(begin), Some(end)) = (
        diag::read_ptr_guarded(base, EX_STATUS_LIST_BEGIN),
        diag::read_ptr_guarded(base, EX_STATUS_LIST_END),
    ) else {
        return false;
    };
    let Some(count) = live_count(begin, end) else {
        return false;
    };
    if count == 0 {
        return true;
    }

    // ONE probe for the whole array rather than one per slot. `IsBadReadPtr` is
    // ~2 ns on mapped memory but takes an internal exception path on unmapped
    // memory, so a bogus `begin` that happens to satisfy `live_count` used to
    // cost up to 256 exception unwinds PER HOLDER PER FRAME — the walk runs on
    // a game thread, so that is frametime, and it is the shape of a stall that
    // appears only while some transient actor exists.
    if !readable(begin, count * std::mem::size_of::<usize>()) {
        #[cfg(feature = "hookdiag")]
        walk_stats::note_unreadable();
        return false;
    }

    out.reserve(count);
    for index in 0..count {
        // The span above is proven mapped, so the element read needs no probe
        // of its own.
        let status =
            unsafe { ((begin + index * std::mem::size_of::<usize>()) as *const usize).read() };
        if status == 0 {
            continue;
        }
        // One probe of the object, then two direct field reads — the fields sit
        // inside the span that probe covers. A slot pointing at freed or
        // unmapped memory is skipped rather than abandoning the holder: the
        // rest of the list is still good information.
        if !readable(status, STATUS_ID_OFFSET + std::mem::size_of::<u32>()) {
            continue;
        }
        let status_id = unsafe { ((status + STATUS_ID_OFFSET) as *const u32).read_unaligned() };
        let cause = unsafe { ((status + STATUS_SUBID_OFFSET) as *const u32).read_unaligned() };
        out.push((status, status_id, (cause > 0).then_some(cause)));
    }
    true
}

/// Publishes one application observed by the walk.
///
/// Every field is read exactly the way [`run_init`] reads it, off the same
/// object — the two must agree or the parser would file one effect on two rows.
fn emit_apply(tx: &event::Tx, status: *const usize) {
    let target_info = target_info_of(status);
    let source_info = source_info_of(status);

    if let (Some(status_id), Some(actor_index)) = (status_id_of(status), holder_index(target_info))
    {
        let _ = tx.send(protocol::Message::StatusApply(protocol::StatusApplyEvent {
            actor_index,
            caster_index: holder_index(source_info),
            status_id,
            ability_id: cause_id_of(status),
            stacks: stacks_for(status_id, raw_stacks_of(status)),
            status_class: super::status_class::status_class_of(status),
            // A frame later than the apply itself, which is the one fidelity
            // this path gives up: the caster may have advanced. Actions run far
            // longer than a frame, so it is nearly always the same one.
            caster_action_id: caster_action_of(source_info),
        }));
    }

    diag::ev!(
        "status_seen",
        "this={:#x} id={:?} cause={:?} tgt={:#x} src={:#x}",
        status as usize,
        status_id_of(status),
        cause_id_of(status),
        target_info,
        source_info
    );
}

/// Diffs one holder's list against its previous tick and reports what is new.
/// Everything in here runs on a GAME THREAD, and holders tick in parallel, so
/// the shared map is locked for the map operations ONLY. An earlier version held
/// it across [`live_keys`] — hundreds of memory probes — which turned one global
/// mutex into a serialisation point for every status holder in the scene.
fn observe_holder(tx: &event::Tx, ex_status: *const usize) {
    // Cheapest check first, and before any lock. Same gate as the apply and
    // removal paths: statuses tick constantly in town, the lobby and menus,
    // where no encounter exists to file them against.
    if !super::quest::in_quest_now() {
        // Dropping the snapshots is what makes the first tick inside a quest
        // report the buffs applied during the load. Only ever taken outside a
        // quest, so it costs nothing in a fight.
        if let Ok(mut guard) = LAST_SEEN.lock() {
            if let Some(seen) = guard.as_mut() {
                seen.clear();
            }
        }
        return;
    }

    // Read the holder's list WITHOUT the lock held, into a buffer this thread
    // reuses. The walk runs for every holder every frame, so allocating a fresh
    // Vec here meant thousands of heap operations a second competing with the
    // game's own allocator — the contention this file's `readable` comment
    // records as a previously shipped in-combat slowdown. Reused, the steady
    // state allocates nothing.
    let fresh = SCRATCH.with(|scratch| {
        let Ok(mut current) = scratch.try_borrow_mut() else {
            return Vec::new();
        };
        if !live_keys(ex_status, &mut current) {
            return Vec::new();
        }

        #[cfg(feature = "hookdiag")]
        walk_stats::note_list(current.len());

        // A poisoned lock means another thread panicked mid-walk; skipping this
        // tick is always safe, where unwrapping would take the game down.
        let Ok(mut guard) = LAST_SEEN.lock() else {
            return Vec::new();
        };
        let seen = guard.get_or_insert_with(std::collections::HashMap::new);

        // A holder carrying nothing needs no entry: storing an empty list and
        // storing none are the same answer next tick, and dropping it is what
        // keeps the map from accumulating a row per enemy ever spawned.
        if current.is_empty() {
            seen.remove(&(ex_status as usize));
            return Vec::new();
        }

        let previous = seen.entry(ex_status as usize).or_default();
        let fresh = newly_applied(previous, &current);
        // Only an actual change touches the stored snapshot, so an unchanged
        // holder — the overwhelmingly common case — neither allocates nor
        // copies.
        if fresh.is_empty() && previous.len() == current.len() {
            return fresh;
        }
        previous.clear();
        previous.extend_from_slice(&current);
        fresh
    });

    #[cfg(feature = "hookdiag")]
    if walk_stats::due() {
        let (walks, unreadable, emitted, max_list) = walk_stats::snapshot();
        let holders = LAST_SEEN
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().map(|seen| seen.len()))
            .unwrap_or(0);
        diag::ev!(
            "status_walk",
            "walks={walks} unreadable={unreadable} emitted={emitted} \
             max_list={max_list} holders={holders}"
        );
    }

    for (status, _, _) in fresh {
        #[cfg(feature = "hookdiag")]
        walk_stats::note_emitted();
        emit_apply(tx, status as *const usize);
    }
}

#[cfg(test)]
mod snapshot_tests {
    use super::{
        snapshot_player_statuses, EX_STATUS_LIST_BEGIN, EX_STATUS_LIST_END, MAX_SNAPSHOT_STATUSES,
        PLAYER_EX_STATUS_OFFSET, STATUS_ID_OFFSET, STATUS_STACKS_OFFSET,
    };

    /// A stand-in for the parts of game memory the walk touches.
    ///
    /// The guarded readers probe REAL process memory (`IsBadReadPtr`), so a
    /// heap buffer is a faithful fake: it exercises the actual pointer walk,
    /// the actual bounds arithmetic and the actual field offsets, and only the
    /// game's own allocation is replaced. Everything except the values the game
    /// would have written is the shipping code path.
    struct FakeActor {
        actor: Vec<u64>,
        _statuses: Vec<Vec<u64>>,
        slots: Vec<usize>,
    }

    impl FakeActor {
        /// An actor whose `ExStatus` list holds one entry per `(status_id, raw
        /// +0xb0)` pair given.
        fn with_statuses(entries: &[(u32, i32)]) -> Self {
            // Big enough for the embed plus the vector that lives inside it.
            let mut actor = vec![0u64; (PLAYER_EX_STATUS_OFFSET + 0x40) / 8];
            let mut statuses = Vec::new();
            let mut slots = Vec::new();

            for (status_id, raw_stacks) in entries {
                // Past +0xb0, the deepest field either reader touches.
                let mut object = vec![0u64; 0x20];
                let base = object.as_mut_ptr() as usize;
                unsafe {
                    ((base + STATUS_ID_OFFSET) as *mut u32).write(*status_id);
                    ((base + STATUS_STACKS_OFFSET) as *mut i32).write(*raw_stacks);
                }
                slots.push(base);
                statuses.push(object);
            }

            let list_base = PLAYER_EX_STATUS_OFFSET / 8;
            let (begin, end) = if slots.is_empty() {
                // An empty `std::vector` is a valid, equal begin/end pair —
                // exactly what a player carrying nothing looks like.
                (0x1000usize, 0x1000usize)
            } else {
                (
                    slots.as_ptr() as usize,
                    slots.as_ptr() as usize + slots.len() * std::mem::size_of::<usize>(),
                )
            };
            actor[list_base + EX_STATUS_LIST_BEGIN / 8] = begin as u64;
            actor[list_base + EX_STATUS_LIST_END / 8] = end as u64;

            Self {
                actor,
                _statuses: statuses,
                slots,
            }
        }

        fn ptr(&self) -> *const usize {
            self.actor.as_ptr() as *const usize
        }

        /// Base address of the `i`-th status object, for tests that need to
        /// write into a status past what `with_statuses` populates.
        fn slot(&self, i: usize) -> usize {
            self.slots[i]
        }
    }

    #[test]
    fn a_snapshot_reports_every_status_the_actor_holds() {
        // damagecut (4) is `HasLevels`, so its +0xb0 is a real count; atkup (0)
        // is not, so whatever sits there is not one.
        let fake = FakeActor::with_statuses(&[(4, 3), (0, 7)]);

        let snapshot = snapshot_player_statuses(fake.ptr()).expect("captured");

        assert_eq!(snapshot.len(), 2);
        assert_eq!(snapshot[0].status_id, 4);
        assert_eq!(snapshot[0].stacks, 3);
        // The fake writes nothing at +0x8 (the term field), so it reads as a
        // zeroed heap: 0.0f32 is finite, so the walk publishes `Some(0)` — a
        // genuinely-zero cached term is real information, not a special case
        // for `None`.
        assert_eq!(snapshot[0].term_bits, Some(0));
        assert_eq!(snapshot[1].status_id, 0);
        assert_eq!(snapshot[1].stacks, 1);
        assert_eq!(snapshot[1].term_bits, Some(0));
    }

    /// "Captured, and the attacker held nothing" is `Some(vec![])`. A consumer
    /// that read this as `None` would treat a genuinely buff-less hit as
    /// unresolvable instead of as evidence the buff was absent.
    #[test]
    fn an_actor_holding_nothing_captures_an_empty_list() {
        let fake = FakeActor::with_statuses(&[]);
        assert_eq!(snapshot_player_statuses(fake.ptr()), Some(Vec::new()));
    }

    /// Bounds that do not describe a `std::vector<StatusBase*>` — a torn read,
    /// or a layout that shifted under a game patch — must publish nothing
    /// rather than walk unrelated memory on a game thread.
    #[test]
    fn implausible_list_bounds_capture_nothing() {
        let mut fake = FakeActor::with_statuses(&[(4, 1)]);
        let list_base = PLAYER_EX_STATUS_OFFSET / 8;

        // end < begin.
        let begin = fake.actor[list_base + EX_STATUS_LIST_BEGIN / 8];
        fake.actor[list_base + EX_STATUS_LIST_END / 8] = begin - 8;
        assert_eq!(snapshot_player_statuses(fake.ptr()), None);

        // A span that is not a whole number of pointers.
        fake.actor[list_base + EX_STATUS_LIST_END / 8] = begin + 5;
        assert_eq!(snapshot_player_statuses(fake.ptr()), None);

        // More entries than any holder plausibly carries.
        fake.actor[list_base + EX_STATUS_LIST_END / 8] = begin + 8 * 4096;
        assert_eq!(snapshot_player_statuses(fake.ptr()), None);

        // An unmapped array.
        fake.actor[list_base + EX_STATUS_LIST_BEGIN / 8] = 0x10;
        fake.actor[list_base + EX_STATUS_LIST_END / 8] = 0x10 + 8 * 4;
        assert_eq!(snapshot_player_statuses(fake.ptr()), None);
    }

    /// The per-hit snapshot is written into every stored damage event, so the
    /// list it publishes is bounded independently of the per-frame walk's own
    /// plausibility cap.
    #[test]
    fn a_snapshot_is_bounded() {
        let entries: Vec<(u32, i32)> = (0..MAX_SNAPSHOT_STATUSES + 20)
            .map(|index| (index as u32, 1))
            .collect();
        let fake = FakeActor::with_statuses(&entries);

        let snapshot = snapshot_player_statuses(fake.ptr()).expect("captured");

        assert_eq!(snapshot.len(), MAX_SNAPSHOT_STATUSES);
    }

    #[test]
    fn a_null_actor_captures_nothing() {
        assert_eq!(snapshot_player_statuses(std::ptr::null()), None);
    }

    /// The raw term rides along exactly as stored; non-finite bits publish
    /// None so garbage can never masquerade as a live term.
    #[test]
    fn snapshot_publishes_finite_terms_and_drops_nan() {
        let fake = FakeActor::with_statuses(&[(4, 3), (7, 1)]);
        unsafe {
            ((fake.slot(0) + 0x8) as *mut u32).write(1.25f32.to_bits());
            ((fake.slot(1) + 0x8) as *mut u32).write(f32::NAN.to_bits());
        }
        let snapshot = snapshot_player_statuses(fake.ptr()).expect("captured");
        assert_eq!(snapshot[0].term_bits, Some(1.25f32.to_bits()));
        assert_eq!(snapshot[1].term_bits, None);
    }
}

/// Observes one status holder's per-frame tick, reporting any status that has
/// appeared in its list since the last one.
///
/// The walk runs BEFORE the original: a status the tick is about to expire is
/// still listed, so an effect that lived a single frame still opens a window.
#[derive(Clone)]
pub struct OnStatusUpdateHook {
    tx: event::Tx,
}

impl OnStatusUpdateHook {
    pub fn new(tx: event::Tx) -> Self {
        Self { tx }
    }

    pub fn setup(&self, process: &Process) -> Result<()> {
        let cloned_self = self.clone();

        if let Ok(addr) = process.search_address(STATUS_UPDATE_SIG) {
            unsafe {
                let func: StatusUpdateFunc = std::mem::transmute(addr);
                OnStatusUpdate.initialize(func, move |ex_status, delta| {
                    observe_holder(&cloned_self.tx, ex_status);
                    OnStatusUpdate.call(ex_status, delta)
                })?;
                OnStatusUpdate.enable()?;
            }
            Ok(())
        } else {
            Err(anyhow!("Could not find status_update"))
        }
    }
}
