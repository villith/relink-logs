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
