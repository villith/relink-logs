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
//! Both detours are OBSERVE-ONLY passthroughs, compiled and installed only
//! with the `hookdiag` feature (a release `hook.dll` contains neither), and
//! every field read is guarded — a layout shift must never fault a game
//! thread.

use std::fmt::Write as _;

use anyhow::{anyhow, Result};
use retour::static_detour;

use crate::{
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
/// u32 companion value passed alongside the id to the target's +0x88 query.
const STATUS_SUBID_OFFSET: usize = 0x4c;
/// Target entity handle triple (3 qwords).
const STATUS_TARGET_HANDLE: usize = 0x10;
/// Source entity handle triple (3 qwords) — who applied the status. Written
/// by `init` from `ctx+0x38..0x48`.
const STATUS_SOURCE_HANDLE: usize = 0x28;
/// Flag bytes +0x78..+0x7b; +0x79 is the infinite-duration flag `init` sets.
const STATUS_FLAGS_OFFSET: usize = 0x78;
/// f32 initial duration (`init` writes it alongside +0x80).
const STATUS_INITIAL_OFFSET: usize = 0x7c;
/// f32 remaining duration, ticked down by `ExStatus::update`.
const STATUS_REMAINING_OFFSET: usize = 0x80;
/// i32 stack/level count (per-class stack-change handlers diff against it;
/// the factory pre-init value is -1).
const STATUS_STACKS_OFFSET: usize = 0xb0;

/// How many qwords of the init ctx struct to dump. The source handle sits at
/// +0x38..0x48; the window is wide enough to catch an action id / magnitude
/// living anywhere near it without flooding the log.
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
handle triple {small id, self ptr, 64-bit uid}, +0x50 the actor instance the
damage pipeline keys on. A status's target handle (+0x10..0x20) carries the
TARGET's entity-info block as its middle qword, so both sides resolve the
same way. */

/// Inline ASCII name within an entity-info block.
const INFO_NAME_OFFSET: usize = 0x08;
/// Longest name we render (the inline field is at least 0x18 bytes: "Pl1900_Sub_PL2000" spans 17).
const INFO_NAME_MAX: usize = 0x20;
/// Actor instance pointer within an entity-info block.
const INFO_ACTOR_OFFSET: usize = 0x50;
/// Middle qword of a handle triple: the entity-info pointer.
const HANDLE_INFO_PTR_OFFSET: usize = 0x8;
/// Span an actor instance must be readable over before calling the +0x58
/// type-id virtual / reading idx at +0x170 — same rule as the damage hook.
const ACTOR_SPAN: usize = 0x174;

/// Reads the inline ASCII name out of an entity-info block, guarded. Returns
/// "?" when the block or name is unreadable/empty.
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

/// Resolves an entity-info block to `name/actor=0x.../idx/type` for the diag
/// log, reusing the meter's actor-id path (guarded exactly like damage.rs —
/// the type id rides a virtual call, so the span check is mandatory).
fn info_summary(info: usize) -> String {
    let name = info_name(info);
    let actor = diag::read_ptr_guarded(info, INFO_ACTOR_OFFSET).unwrap_or(0);
    if actor != 0 && readable(actor, ACTOR_SPAN) {
        let idx = super::actor_idx(actor as *const usize);
        let type_id = super::actor_type_id(actor as *const usize);
        format!("{name} actor={actor:#x} idx={idx:#x} type={type_id:#x}")
    } else {
        format!("{name} actor={actor:#x}")
    }
}

/// Renders the nonzero qwords of a guarded window as ` +0xOFF=0xVAL …` for the
/// diag log; unreadable or null windows render as a single marker instead of
/// faulting or spamming zeros.
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
pub struct OnStatusInitHook;

impl OnStatusInitHook {
    pub fn new() -> Self {
        OnStatusInitHook
    }

    pub fn setup(&self, process: &Process) -> Result<()> {
        if let Ok(addr) = process.search_address(STATUS_INIT_SIG) {
            unsafe {
                let func: StatusInitFunc = std::mem::transmute(addr);
                OnStatusInit.initialize(func, run_init)?;
                OnStatusInit.enable()?;
            }
            Ok(())
        } else {
            Err(anyhow!("Could not find status_init"))
        }
    }
}

fn run_init(status: *const usize, duration: f32, ctx: *const usize) {
    // The id may be stamped before OR after init in the apply sequence —
    // capturing it on both sides of the original call is how we find out.
    let id_before = diag::read_u32_guarded(status as usize, STATUS_ID_OFFSET);

    unsafe { OnStatusInit.call(status, duration, ctx) };

    let id_after = diag::read_u32_guarded(status as usize, STATUS_ID_OFFSET);
    let sub_id = diag::read_u32_guarded(status as usize, STATUS_SUBID_OFFSET);
    let initial = diag::read_f32_guarded(status as usize, STATUS_INITIAL_OFFSET);
    let remaining = diag::read_f32_guarded(status as usize, STATUS_REMAINING_OFFSET);
    let flags = diag::read_u32_guarded(status as usize, STATUS_FLAGS_OFFSET);
    let stacks = diag::read_u32_guarded(status as usize, STATUS_STACKS_OFFSET) as i32;

    // The ctx IS the source's entity-info block; the target's block rides
    // as the middle qword of the status's target handle triple.
    let target_info = diag::read_ptr_guarded(
        status as usize,
        STATUS_TARGET_HANDLE + HANDLE_INFO_PTR_OFFSET,
    )
    .unwrap_or(0);
    let source_summary = info_summary(ctx as usize);
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
pub struct OnStatusDtorHook;

impl OnStatusDtorHook {
    pub fn new() -> Self {
        OnStatusDtorHook
    }

    pub fn setup(&self, process: &Process) -> Result<()> {
        if let Ok(addr) = process.search_address(STATUS_DTOR_SIG) {
            unsafe {
                let func: StatusDtorFunc = std::mem::transmute(addr);
                OnStatusDtor.initialize(func, run_dtor)?;
                OnStatusDtor.enable()?;
            }
            Ok(())
        } else {
            Err(anyhow!("Could not find status_dtor"))
        }
    }
}

fn run_dtor(status: *const usize, dtor_flags: u32) -> usize {
    let id = diag::read_u32_guarded(status as usize, STATUS_ID_OFFSET);
    let remaining = diag::read_f32_guarded(status as usize, STATUS_REMAINING_OFFSET);
    let flags = diag::read_u32_guarded(status as usize, STATUS_FLAGS_OFFSET);
    let stacks = diag::read_u32_guarded(status as usize, STATUS_STACKS_OFFSET) as i32;
    // Who the dying status was on: remaining≈0 here is a natural expiry,
    // remaining>0 an early removal (dispel/replace/owner death).
    let target_info = diag::read_ptr_guarded(
        status as usize,
        STATUS_TARGET_HANDLE + HANDLE_INFO_PTR_OFFSET,
    )
    .unwrap_or(0);

    diag::ev!(
        "status_dtor",
        "this={:#x} dtor_flags={dtor_flags:#x} id={id} remaining={remaining:?} \
         flags78={flags:#010x} stacks={stacks} tgt[{}]",
        status as usize,
        info_summary(target_info)
    );

    unsafe { OnStatusDtor.call(status, dtor_flags) }
}
