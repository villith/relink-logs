//! Damage-HEAD oracle. Verification only — never compiled into a release hook.
//!
//! Captures the pre-cap damage factorization per hit so the damage-amount
//! forward model (2026-08-14 RE spike) can be scored against ground truth:
//! `FUN_141f44920` returns the full per-hit product (pre-variance `d4`) and
//! `FUN_141f43670` the attack-side chain inside it. The regular event stream
//! already carries the post-variance value (`base_damage`@0x2D4), and the
//! dmgdiag `d0` line recovers the crit multiplier offline, so those need no
//! detour here.
//!
//! Rides [`cap_oracle::BuildGuard`]: the cap oracle's builder detour arms the
//! guard around each DamageInstance build, and both target functions run as
//! synchronous callees of that build, so "armed with this instance" is the
//! per-hit gate. Emission volume is one pair of lines per built instance —
//! acceptable for a hookdiag round, never for release.

use anyhow::{anyhow, Result};
use retour::static_detour;

use crate::hooks::cap_oracle::BuildGuard;
use crate::hooks::damage::within_module_image;
use crate::hooks::diag::{
    first_n_per_key, read_bytes_guarded, read_f32_guarded, read_i32_opt_guarded, read_ptr_guarded,
    read_u32_guarded, read_u64_guarded, MODULE_BASE,
};
use crate::process::Process;

/// `FUN_141f43670` — the attack-side chain: `attack × trait/aggregator
/// multipliers` (formula tree, 2026-08-14 findings doc). 3 args confirmed from
/// the body (`mov rbx,r8` / `mov rdi,rdx` / `mov rsi,rcx` after the
/// `[rcx+0x10]` holder check), returns f32.
///
/// Direct-entry form; the shared prologue idiom alone is not unique, so the
/// pattern runs through the xmm spill block into the distinctive
/// `mov rax,[rcx+0x10]; test; jz +0x33` body head.
/// sigscan 2026-08-14: exactly 1 match, target_rva=0x1f43670 (v2.0.4).
const ATTACK_CHAIN_SIG: &str = "cc cc cc cc ' 56 57 53 48 81 ec 10 01 00 00 \
     c5 78 29 bc 24 00 01 00 00 c5 78 29 b4 24 f0 00 00 00 \
     c5 78 29 ac 24 e0 00 00 00 c5 78 29 a4 24 d0 00 00 00 \
     c5 78 29 9c 24 c0 00 00 00 c5 78 29 94 24 b0 00 00 00 \
     c5 78 29 8c 24 a0 00 00 00 c5 78 29 84 24 90 00 00 00 \
     c5 f8 29 bc 24 80 00 00 00 c5 f8 29 74 24 70 \
     48 8b 41 10 48 85 c0 74 33 4c 89 c3 48 89 d7 48 89 ce";

/// `FUN_141f44920` — the full per-hit damage product (11 factors; see the
/// findings doc). Same arity/return as the attack chain; distinctive body head
/// is `cmp qword [rcx+0x10],0; jz +0x6e`.
/// sigscan 2026-08-14: exactly 1 match, target_rva=0x1f44920 (v2.0.4).
const FULL_DAMAGE_SIG: &str = "cc cc cc cc ' 41 57 41 56 56 57 53 48 81 ec 10 01 00 00 \
     c5 78 29 bc 24 00 01 00 00 c5 78 29 b4 24 f0 00 00 00 \
     c5 78 29 ac 24 e0 00 00 00 c5 78 29 a4 24 d0 00 00 00 \
     c5 78 29 9c 24 c0 00 00 00 c5 78 29 94 24 b0 00 00 00 \
     c5 78 29 8c 24 a0 00 00 00 c5 78 29 84 24 90 00 00 00 \
     c5 f8 29 bc 24 80 00 00 00 c5 f8 29 74 24 70 \
     48 83 79 10 00 74 6e 4c 89 c3 48 89 d7 48 89 ce";

type DamageHeadFunc = unsafe extern "system" fn(*const usize, *const usize, *const usize) -> f32;

static_detour! {
    /// 3 args (slice = attacker+0x22F0, DamageInstance, ctx) → f32.
    static AttackChain: unsafe extern "system" fn(
        *const usize, *const usize, *const usize) -> f32;
    /// Same signature; calls AttackChain internally, so that detour fires
    /// inside this one — recording the LAST chain value per build is right on
    /// both the d0 path (builder calls the chain directly) and the d4 path.
    static FullDamage: unsafe extern "system" fn(
        *const usize, *const usize, *const usize) -> f32;
}

thread_local! {
    /// The attack chain's return during the current build, if it ran.
    static LAST_ATTACK_CHAIN: std::cell::Cell<Option<f32>> =
        const { std::cell::Cell::new(None) };
}

/// DamageInstance fields (v2.0.4). Offsets shared with `ffi.rs`/`cap_oracle`
/// where they overlap; the gate-byte block is this oracle's own.
const INSTANCE_MOTION_VALUE: usize = 0xE0;
const INSTANCE_PRESET_DAMAGE: usize = 0xD8;
const INSTANCE_ATTACK_RATE: usize = 0xDC;
const INSTANCE_FLAGS: usize = 0xE8;
const INSTANCE_CLASS_FLAGS: usize = 0xF0;
const INSTANCE_ACTION_ID: usize = 0x16C;
const INSTANCE_CRIT_RATE: usize = 0x2D8;
const INSTANCE_TARGET_ELEMENT: usize = 0x2C0;
/// Bytes 0x15D..=0x167: is-crit, weak-point, back-attack, internal state
/// (SKILL_015_00), target-debuffed, Overdrive, Break, 0x164..0x166 unknown,
/// crit-rolled latch.
const INSTANCE_GATE_BYTES: usize = 0x15D;
const INSTANCE_GATE_BYTES_LEN: usize = 11;

/// Holder sits at slice+0x10 (`param_1[2]` in the chain, `param_1+0x10` in the
/// product — both check it before anything else).
const SLICE_STATUS_HOLDER: usize = 0x10;
/// The holder's `this`-only player-record getter — the same virtual the
/// builder itself calls (`vfn+0x9f0`; see cap_oracle's overmastery read).
const HOLDER_PLAYER_RECORD_SLOT: usize = 0x9f0;

/// Player-record fields the damage head reads (formula-tree doc).
const RECORD_ATTACK: usize = 0x8;
const RECORD_CRIT_RATE_BASE: usize = 0x14;
const RECORD_DMG_SBA: usize = 0x1C;
const RECORD_DMG_SKILL: usize = 0x24;
const RECORD_BACK_ATTACK: usize = 0x596C;
const RECORD_WEAK_POINT: usize = 0x5970;
const RECORD_CRIT_DMG: usize = 0x5974;
const RECORD_ONLINE_DMG: usize = 0x5978;

/// The slice's first qword is a table of function pointers (the builder reads
/// `*(attacker+0x22F0) + 0x70` and calls it with `&slice` as `this`). These
/// are the per-class virtuals still unresolved statically; logging the table
/// RVA plus each slot target once per distinct table is what closes them
/// (SymbolAt/Decompile afterwards). Slot 0x70 is the cap arc's `fVar30`
/// frontier; 0x40/0x58/0x88 are the chain's multipliers; 0x80 is crit rate's.
const SLICE_SLOTS: [usize; 5] = [0x40, 0x58, 0x70, 0x80, 0x88];

fn run_attack_chain(a1: *const usize, a2: *const usize, a3: *const usize) -> f32 {
    let ret = unsafe { AttackChain.call(a1, a2, a3) };
    if BuildGuard::current().is_some() {
        let _ = LAST_ATTACK_CHAIN.try_with(|c| c.set(Some(ret)));
    }
    ret
}

fn run_full_damage(a1: *const usize, a2: *const usize, a3: *const usize) -> f32 {
    let ret = unsafe { FullDamage.call(a1, a2, a3) };
    if BuildGuard::current() == Some(a2) {
        emit_head_lines(a1 as usize, a2 as usize, ret);
    }
    ret
}

/// The player record behind the slice's holder, bounds-checked the same way
/// cap_oracle's record read is (vtable and slot must live inside the module
/// before the transmuted call).
fn player_record(slice: usize) -> Option<usize> {
    let module_base = MODULE_BASE.load(std::sync::atomic::Ordering::Relaxed);
    if module_base == 0 {
        return None;
    }
    let holder = read_ptr_guarded(slice, SLICE_STATUS_HOLDER).filter(|h| *h != 0)?;
    let vtable = read_ptr_guarded(holder, 0).filter(|v| *v != 0)?;
    if !within_module_image(vtable, module_base) {
        return None;
    }
    let slot = read_ptr_guarded(vtable, HOLDER_PLAYER_RECORD_SLOT).filter(|s| *s != 0)?;
    if !within_module_image(slot, module_base) {
        return None;
    }
    let get_record: unsafe extern "system" fn(usize) -> usize =
        unsafe { std::mem::transmute(slot) };
    let record = unsafe { get_record(holder) };
    (record != 0).then_some(record)
}

/// One DMGHEAD (+ DMGREC when the record resolves) pair per built instance.
/// `inst` is the join key against the CAPORACLE line of the same build.
fn emit_head_lines(slice: usize, inst: usize, ret_full: f32) {
    let ret_chain = LAST_ATTACK_CHAIN
        .try_with(|c| c.take())
        .ok()
        .flatten()
        .unwrap_or(f32::NAN);
    let gates = read_bytes_guarded(inst, INSTANCE_GATE_BYTES, INSTANCE_GATE_BYTES_LEN)
        .map(|b| {
            b.iter()
                .map(|x| format!("{x:02x}"))
                .collect::<Vec<_>>()
                .join(",")
        })
        .unwrap_or_default();

    log::info!(
        "DMGHEAD t={} inst={inst:#x} action={} ret44920={ret_full:.6} ret43670={ret_chain:.6} \
         mv_e0={:.6} d8={:.6} rate_dc={:.3} crit_rate={:.4} class_flags={:#x} flags={:#x} \
         gates=[{gates}] elem_in={}",
        crate::hooks::diag::ms(),
        read_u32_guarded(inst, INSTANCE_ACTION_ID),
        read_f32_guarded(inst, INSTANCE_MOTION_VALUE).unwrap_or(f32::NAN),
        read_f32_guarded(inst, INSTANCE_PRESET_DAMAGE).unwrap_or(f32::NAN),
        read_f32_guarded(inst, INSTANCE_ATTACK_RATE).unwrap_or(f32::NAN),
        read_f32_guarded(inst, INSTANCE_CRIT_RATE).unwrap_or(f32::NAN),
        read_u32_guarded(inst, INSTANCE_CLASS_FLAGS),
        read_u64_guarded(inst, INSTANCE_FLAGS).unwrap_or(0),
        read_u32_guarded(inst, INSTANCE_TARGET_ELEMENT),
    );

    if let Some(record) = player_record(slice) {
        log::info!(
            "DMGREC inst={inst:#x} atk={} crit_base={:.3} dmg_sba={:.3} dmg_skill={:.3} \
             back={:.3} weak={:.3} critdmg={:.3} online={:.3}",
            read_i32_opt_guarded(record, RECORD_ATTACK).unwrap_or(-1),
            read_f32_guarded(record, RECORD_CRIT_RATE_BASE).unwrap_or(f32::NAN),
            read_f32_guarded(record, RECORD_DMG_SBA).unwrap_or(f32::NAN),
            read_f32_guarded(record, RECORD_DMG_SKILL).unwrap_or(f32::NAN),
            read_f32_guarded(record, RECORD_BACK_ATTACK).unwrap_or(f32::NAN),
            read_f32_guarded(record, RECORD_WEAK_POINT).unwrap_or(f32::NAN),
            read_f32_guarded(record, RECORD_CRIT_DMG).unwrap_or(f32::NAN),
            read_f32_guarded(record, RECORD_ONLINE_DMG).unwrap_or(f32::NAN),
        );
    }

    emit_slot_table_once(slice);
}

/// The unresolved-virtuals capture: once per distinct function table, its RVA
/// and each interesting slot's target RVA. Feeding these through
/// SymbolAt/Decompile closes the `vfn+0x40/0x58/0x70/0x80/0x88` frontier
/// (including the cap arc's `fVar30`).
fn emit_slot_table_once(slice: usize) {
    static SEEN: std::sync::Mutex<Vec<(usize, u32)>> = std::sync::Mutex::new(Vec::new());
    let Some(table) = read_ptr_guarded(slice, 0).filter(|t| *t != 0) else {
        return;
    };
    if !first_n_per_key(&SEEN, table, 1) {
        return;
    }
    let base = MODULE_BASE.load(std::sync::atomic::Ordering::Relaxed);
    let slots = SLICE_SLOTS
        .iter()
        .map(|s| match read_ptr_guarded(table, *s) {
            Some(target) => format!("{:#x}:{:#x}", s, target.wrapping_sub(base)),
            None => format!("{s:#x}:?"),
        })
        .collect::<Vec<_>>()
        .join(",");
    log::info!(
        "DMGEXTRAS table_rva={:#x} slots=[{slots}]",
        table.wrapping_sub(base)
    );
}

pub(crate) struct DmgOracleHook;

impl DmgOracleHook {
    pub(crate) fn new() -> Self {
        Self
    }

    pub(crate) fn setup(&self, process: &Process) -> Result<()> {
        let chain = process
            .search_address(ATTACK_CHAIN_SIG)
            .map_err(|e| anyhow!("dmg_oracle: attack-chain sig failed: {e:?}"))?;
        let full = process
            .search_address(FULL_DAMAGE_SIG)
            .map_err(|e| anyhow!("dmg_oracle: full-damage sig failed: {e:?}"))?;

        unsafe {
            let chain: DamageHeadFunc = std::mem::transmute(chain);
            AttackChain.initialize(chain, run_attack_chain)?;
            AttackChain.enable()?;

            let full: DamageHeadFunc = std::mem::transmute(full);
            FullDamage.initialize(full, run_full_damage)?;
            FullDamage.enable()?;
        }

        Ok(())
    }
}

#[cfg(any(feature = "eject", test))]
pub(crate) fn disable() {
    super::disable_quiet("AttackChain", &AttackChain);
    super::disable_quiet("FullDamage", &FullDamage);
}
