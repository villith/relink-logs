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
//!   0x27a7720). The apply path calls it on every application: it copies the
//!   SOURCE entity handle out of `ctx+0x38..0x48` into `this+0x28..0x38` and
//!   arms the duration (negative ⇒ infinite: 9999.0 + flag at +0x79; +0x7c
//!   initial, +0x80 remaining). Whether a REFRESH re-enters here, and whether
//!   `ctx` carries the acting action id (the "which ability applied this
//!   Poison" requirement), is exactly what this diag exists to answer — hence
//!   the raw ctx window dump per call.
//! * the shared `StatusBase` scalar-deleting destructor (v2.0.3 entry
//!   0x29b0cf0, held by ~147 family vtables as slot 0): every status that
//!   dies — expired, dispelled (`ExStatus::clearStatus*`), or owner teardown —
//!   passes through while its fields are still readable. Expiry-vs-dispel
//!   attribution is a later stage (the removal reason rides the +0x70 virtual,
//!   whose per-class override count makes it a poor first hook target).
//!
//! Both detours emit protocol events — `StatusApply` from `init` (which covers
//! a refresh: the game re-inits the SAME instance rather than allocating a new
//! one) and `StatusRemove` from the dtor — and additionally log a field dump
//! under `hookdiag`. Every field read is guarded: a layout shift must never
//! fault a game thread.
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
/// Source entity handle triple (3 qwords) — who applied the status. Written
/// by `init` from `ctx+0x38..0x48`. Documented rather than read: the apply
/// detour already has the source's info block as its `ctx` argument.
#[allow(dead_code)]
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
    let base = status as usize;
    if base == 0 || !readable(base.wrapping_add(STATUS_ID_OFFSET), 4) {
        return None;
    }
    Some(unsafe { (base.wrapping_add(STATUS_ID_OFFSET) as *const u32).read_unaligned() })
}

/// The status's `+0x4c` cause discriminator, or `None` when it is absent or
/// unreadable. Strict for the same reason as [`status_id_of`]: a guarded read
/// answering 0 is indistinguishable from the game's own "no specific cause".
fn cause_id_of(status: *const usize) -> Option<u32> {
    let base = status as usize;
    if base == 0 || !readable(base.wrapping_add(STATUS_SUBID_OFFSET), 4) {
        return None;
    }
    let value = unsafe { (base.wrapping_add(STATUS_SUBID_OFFSET) as *const u32).read_unaligned() };
    (value > 0).then_some(value)
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
    let actor = diag::read_ptr_guarded(info, INFO_ACTOR_OFFSET).unwrap_or(0);
    if actor == 0 || !readable(actor, ACTOR_SPAN) {
        return None;
    }
    let actor = actor as *const usize;
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
    let base = status as usize;
    if base == 0 || !readable(base.wrapping_add(STATUS_STACKS_OFFSET), 4) {
        return None;
    }
    Some(unsafe { (base.wrapping_add(STATUS_STACKS_OFFSET) as *const i32).read_unaligned() })
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

    unsafe { OnStatusDtor.call(status, dtor_flags) }
}

