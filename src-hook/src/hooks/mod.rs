use anyhow::Result;
use death::OnDeathHook;

use crate::{event, process::Process};

use self::{
    area::OnAreaEnterHook,
    damage::{OnProcessDamageHook, OnProcessDotHook},
    player::OnLoadPlayerHook,
    quest::{OnLoadQuestHook, OnQuestCompleteHook},
    sba::{
        OnAttemptSBAHook, OnCheckSBACollisionHook, OnContinueSBAChainHook, OnHandleSBAUpdateHook,
        OnRemoteSBAUpdateHook,
    },
};

mod area;
mod damage;
mod death;
pub mod diag;
mod ffi;
mod globals;
mod loadprobe;
mod player;
mod quest;
mod sba;

type GetEntityHashID0x58 = unsafe extern "system" fn(*const usize, *const u32) -> *const usize;

/// Run one hook/global setup step, logging (and swallowing) any error so that a
/// single broken signature does not prevent every other hook from installing.
///
/// A game patch (e.g. the 2.0.2 Endless Ragnarok expansion) breaks the
/// reverse-engineered signatures one at a time; before this, `setup_hooks` bailed
/// at the first failure, so a single stale signature disabled the entire overlay.
/// Now each step is independent: whatever still resolves keeps working, and each
/// failure is reported by name to guide re-derivation.
fn try_step(name: &str, result: Result<()>) {
    match result {
        Ok(()) => {
            #[cfg(feature = "console")]
            println!("[hook ok] {name}");
        }
        Err(e) => {
            log::warn!("Hook step '{name}' failed: {e:?}");
            #[cfg(feature = "console")]
            println!("[hook FAIL] {name}: {e:?}");
        }
    }
}

pub fn setup_hooks(tx: event::Tx) -> Result<()> {
    let process = Process::with_name("granblue_fantasy_relink.exe")?;

    // Records the module base so the hookdiag caller-RVA logging can convert absolute
    // return addresses to module-relative RVAs. Compiles out without `--features hookdiag`.
    diag::set_module_base(process.base_address);

    // Globals hold the memory offsets other hooks read; setup_globals is itself
    // resilient (see globals::setup_globals) so partial failure still stores what
    // it could find.
    try_step("globals", globals::setup_globals(&process));

    /* Damage Events */
    try_step("process_damage", OnProcessDamageHook::new(tx.clone()).setup(&process));
    try_step("process_dot", OnProcessDotHook::new(tx.clone()).setup(&process));
    try_step("death", OnDeathHook::new(tx.clone()).setup(&process));

    /* Player Data */
    try_step("player_load", OnLoadPlayerHook::new(tx.clone()).setup(&process));

    // hookdiag-only: probe to re-derive the broken player_load address from a live stage
    // load (see loadprobe.rs). No-op without the feature.
    try_step(
        "loadprobe",
        loadprobe::OnComponentLookupProbe::new().setup(&process),
    );

    /* Quest + Area Tracking */
    try_step("area_enter", OnAreaEnterHook::new(tx.clone()).setup(&process));
    try_step("quest_load_state", OnLoadQuestHook::new().setup(&process));
    try_step("quest_complete", OnQuestCompleteHook::new(tx.clone()).setup(&process));

    /* SBA */
    try_step("sba_update", OnHandleSBAUpdateHook::new(tx.clone()).setup(&process));
    try_step("sba_remote_update", OnRemoteSBAUpdateHook::new(tx.clone()).setup(&process));
    try_step("sba_attempt", OnAttemptSBAHook::new(tx.clone()).setup(&process));
    try_step("sba_collision", OnCheckSBACollisionHook::new(tx.clone()).setup(&process));
    try_step("sba_continue_chain", OnContinueSBAChainHook::new(tx.clone()).setup(&process));

    Ok(())
}

#[inline(always)]
pub unsafe fn v_func<T: Sized>(ptr: *const usize, offset: usize) -> T {
    ((ptr.read() as *const usize).byte_add(offset) as *const T).read()
}

#[inline(always)]
pub fn actor_type_id(actor_ptr: *const usize) -> u32 {
    let mut type_id: u32 = 0;

    unsafe {
        v_func::<GetEntityHashID0x58>(actor_ptr, 0x58)(actor_ptr, &mut type_id as *mut u32);
    }

    type_id
}

#[inline(always)]
pub fn actor_idx(actor_ptr: *const usize) -> u32 {
    unsafe { (actor_ptr.byte_add(0x170) as *const u32).read() }
}

// Returns the parent entity of the source entity if necessary.
#[inline(always)]
pub fn get_source_parent(source_type_id: u32, source: *const usize) -> Option<(u32, u32)> {
    match source_type_id {
        // Pl0700Ghost -> Pl0700
        0x2AF678E8 => {
            let parent_instance = parent_specified_instance_at(source, 0xE48)?;

            Some((actor_type_id(parent_instance), actor_idx(parent_instance)))
        }
        // Pl0700GhostSatellite -> Pl0700
        0x8364C8BC => {
            let parent_instance = parent_specified_instance_at(source, 0x508)?;

            Some((actor_type_id(parent_instance), actor_idx(parent_instance)))
        }
        // Wp1890: Cagliostro's Ouroboros Dragon Sled -> Pl1800
        0xC9F45042 => {
            let parent_instance = parent_specified_instance_at(source, 0x578)?;
            Some((actor_type_id(parent_instance), actor_idx(parent_instance)))
        }
        // Pl2000: Id's Dragon Form -> Pl1900
        0xF5755C0E => {
            let parent_instance = parent_specified_instance_at(source, 0xD488)?;
            Some((actor_type_id(parent_instance), actor_idx(parent_instance)))
        }
        // Wp2290: Seofon's Avatar
        0x5B1AB457 => {
            let parent_instance = parent_specified_instance_at(source, 0x500)?;
            Some((actor_type_id(parent_instance), actor_idx(parent_instance)))
        }
        // Pl0600PlantRose
        0x69C0CA71 => {
            let parent_instance = parent_specified_instance_at(source, 0x7E0)?;
            Some((actor_type_id(parent_instance), actor_idx(parent_instance)))
        }
        _ => None,
    }
}

// Returns the specified instance of the parent entity.
// ptr+offset: Entity
// *(ptr+offset) + 0x70: m_pSpecifiedInstance (Pl0700, Pl1200, etc.)
#[inline(always)]
fn parent_specified_instance_at(actor_ptr: *const usize, offset: usize) -> Option<*const usize> {
    unsafe {
        let info = (actor_ptr.byte_add(offset) as *const *const *const usize).read_unaligned();

        if info.is_null() {
            return None;
        }

        Some(info.byte_add(0x70).read())
    }
}
