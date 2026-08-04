use anyhow::Result;
use death::OnDeathHook;

use crate::{event, process::Process};

use self::{
    area::OnAreaEnterHook,
    damage::{OnProcessDamageHook, OnProcessDotHook},
    endless::{OnEndlessBuffInstallHook, OnEndlessMgrDtorHook, OnReceptionFlowDispatchHook},
    player::{OnLoadPlayerHook, OnLoadPlayerIdentityHook},
    quest::{OnLoadQuestHook, OnQuestCompleteHook},
    sba::{
        OnAttemptSBAHook, OnCheckSBACollisionHook, OnContinueSBAChainHook, OnHandleSBAUpdateHook,
        OnRemoteSBAUpdateHook,
    },
};

mod area;
// Compiled under `cfg(test)` too, so a plain `cargo test` type-checks and exercises the
// quest-classification logic. The hook itself is still only INSTALLED behind the feature
// (see `setup_hooks`), so a release `hook.dll` contains none of this.
#[cfg(any(feature = "fullassist", test))]
mod assist;
mod damage;
mod death;
pub mod diag;
mod endless;
mod ffi;
mod filediag;
mod gamehash;
mod globals;
mod loadprobe;
mod player;
mod quest;
mod sba;
// Buff/debuff lifecycle (see hooks/status.rs): emits StatusApply/StatusRemove,
// and logs a field dump on top of that under `hookdiag`.
mod status;
// Generated from status.tbl's HasLevels column — which ids the +0xb0 stack
// count is real for. Regenerate with scripts/gen-stackable-statuses.py.
mod status_levels;
mod stunnet;
mod summon;
mod trial;

pub(crate) type GetEntityHashID0x58 =
    unsafe extern "system" fn(*const usize, *const u32) -> *const usize;

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
            log::info!("[hook ok] {name}");
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

/// Disable one static detour during dev eject. `NotInitialized` is the
/// normal case for a signature that never resolved on this game build, so it
/// is silent; anything else is logged but must not stop the other detours.
#[cfg(any(feature = "eject", test))]
fn disable_quiet<T: retour::Function>(name: &str, detour: &retour::StaticDetour<T>) {
    match unsafe { detour.disable() } {
        Ok(()) => log::info!("[hook off] {name}"),
        Err(retour::Error::NotInitialized) => {}
        Err(e) => log::warn!("[hook off FAIL] {name}: {e:?}"),
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
    try_step(
        "process_damage",
        OnProcessDamageHook::new(tx.clone()).setup(&process),
    );
    try_step(
        "process_dot",
        OnProcessDotHook::new(tx.clone()).setup(&process),
    );
    try_step("death", OnDeathHook::new(tx.clone()).setup(&process));

    /* Player Data */
    try_step(
        "player_load",
        OnLoadPlayerHook::new(tx.clone()).setup(&process),
    );

    // Game 2.0.2 identity path: the full player_load layout (sigil/weapon/overmastery
    // offsets) is not yet re-derived, so player_load above no longer fires. This hook
    // reads only the stable identity snapshot (name + party slot) and, together with
    // the damage hook's identity_event_for_actor lookup, is what distinguishes players
    // and fixes [Guest] names + same-character collapse. See hooks/player.rs.
    try_step(
        "player_identity",
        OnLoadPlayerIdentityHook::new(tx.clone()).setup(&process),
    );

    // hookdiag-only: probe to re-derive the broken player_load address from a live stage
    // load (see loadprobe.rs). No-op without the feature.
    // hookdiag-only: CreateFileW/A open tracing to verify which loose external files
    // the game actually reads (see filediag.rs). No-op without the feature.
    try_step("filediag", filediag::setup());

    try_step(
        "loadprobe",
        loadprobe::OnComponentLookupProbe::new().setup(&process),
    );

    // Network stun-apply message handler — the ONLY path online stun accrual takes
    // (host-authoritative; see stunnet.rs). Emits per-hit OnPlayerStun events with
    // slot-keyed source attribution; the parser prefers them over the (online-dead)
    // accumulator-delta path.
    try_step(
        "stun_net",
        stunnet::OnNetworkStunHook::new(tx.clone()).setup(&process),
    );

    /* Quest + Area Tracking */
    try_step(
        "area_enter",
        OnAreaEnterHook::new(tx.clone()).setup(&process),
    );
    try_step(
        "quest_load_state",
        OnLoadQuestHook::new(tx.clone()).setup(&process),
    );
    try_step(
        "quest_complete",
        OnQuestCompleteHook::new(tx.clone()).setup(&process),
    );
    // Retire/abandon confirm — the immediate boundary for quests that end with no
    // result screen (see OnQuestRetireHook).
    try_step(
        "quest_retire",
        quest::OnQuestRetireHook::new(tx.clone()).setup(&process),
    );
    // Wipe (party-death fail) boundary: quest-flow state poll in the sequence tick
    // (see OnQuestFlowEndHook). Redundant with quest_retire on abandons by design.
    try_step(
        "quest_flow_end",
        quest::OnQuestFlowEndHook::new(tx.clone()).setup(&process),
    );
    // Training room: no flow object and no quest load, so its own start/quit
    // boundaries are the only thing that can close a training encounter.
    try_step("trial", trial::TrialHooks::new(tx.clone()).setup(&process));

    /* Conflux / EndlessMode — emits run-start / buff / run-end messages so the parser can
    group a run's rooms + buffs (room-enter itself comes from quest_load_state above). The
    hookdiag field-window probes inside each hook stay available for future offset work. */
    try_step(
        "endless_reception",
        OnReceptionFlowDispatchHook::new(tx.clone()).setup(&process),
    );
    try_step(
        "endless_buff_install",
        OnEndlessBuffInstallHook::new(tx.clone()).setup(&process),
    );
    try_step(
        "endless_run_end",
        OnEndlessMgrDtorHook::new(tx.clone()).setup(&process),
    );

    /* Status (buff/debuff) lifecycle. Detours the shared StatusBase::init (apply
    AND refresh — the game re-inits the same instance; 165/168 classes inherit
    it) and the shared scalar-deleting dtor (removal). */
    try_step(
        "status_init",
        status::OnStatusInitHook::new(tx.clone()).setup(&process),
    );
    try_step(
        "status_dtor",
        status::OnStatusDtorHook::new(tx.clone()).setup(&process),
    );
    /* The 20 classes whose vtables override the shared dtor (Ares,
    Concentration Ex, Cover, the clock buffs, …) — without these their
    removals are invisible and their uptime runs to the end of the fight. */
    try_step(
        "status_dtor_variants",
        status::OnStatusDtorVariantsHook::new(tx.clone()).setup(&process),
    );

    /* SBA */
    try_step(
        "sba_update",
        OnHandleSBAUpdateHook::new(tx.clone()).setup(&process),
    );
    try_step(
        "sba_remote_update",
        OnRemoteSBAUpdateHook::new(tx.clone()).setup(&process),
    );
    try_step(
        "sba_attempt",
        OnAttemptSBAHook::new(tx.clone()).setup(&process),
    );
    try_step(
        "sba_collision",
        OnCheckSBACollisionHook::new(tx.clone()).setup(&process),
    );
    try_step(
        "sba_continue_chain",
        OnContinueSBAChainHook::new(tx.clone()).setup(&process),
    );
    // PRODUCTION: the register-hit gate (v2.0.3 entry 0x9adaa0) whose
    // synchronous callee chain performs the gauge update. Parks the causing
    // hit's damage instance on a thread-local so sba_update can attribute the
    // gain — without it every SbaGain stays unemitted (the gauge-level poll
    // still works).
    try_step(
        "sba_register_hit",
        sba::OnSBARegisterHitHook::new().setup(&process),
    );
    // hookdiag-only: log-only detour of the per-hit gauge-grant virtual
    // (0x9b41b0) — tests whether the statically-derived grant path actually
    // runs per hit at runtime (see sba::OnSBAGrantProbeHook). Never placed
    // in a build without the feature.
    #[cfg(feature = "hookdiag")]
    try_step(
        "sba_grant_probe",
        sba::OnSBAGrantProbeHook::new().setup(&process),
    );

    // DEV BUILDS ONLY. The one hook that changes game behavior rather than observing it;
    // it no-ops unless hook-config.json asks for it (see hooks/assist.rs).
    #[cfg(feature = "fullassist")]
    try_step(
        "full_assist_unlock",
        assist::OnFullAssistGateHook::new().setup(&process),
    );

    Ok(())
}

/// Dev-only (feature `eject`): disable every detour `setup_hooks` may have
/// installed, in mirror order. After this, no game thread can ENTER our
/// code; callers still wait a drain period for threads already inside a
/// trampoline before the module is ejected (see crate::teardown).
#[cfg(any(feature = "eject", test))]
pub fn teardown_hooks() {
    damage::disable();
    death::disable();
    player::disable();
    stunnet::disable();
    area::disable();
    quest::disable();
    trial::disable();
    endless::disable();
    sba::disable();
    #[cfg(feature = "hookdiag")]
    loadprobe::disable();
    status::disable();
    #[cfg(any(feature = "fullassist", test))]
    assist::disable();
    log::info!("all detours disabled");
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

pub use summon::get_source_parent;
// Re-exported so the damage hook's Pl2000 identity publish and its own
// specified-instance walk keep their existing `super::` call sites.
pub(crate) use summon::{parent_specified_instance_at, ID_DRAGON_TYPE};

/// The parent-resolved, PLAYER-UNIQUE attribution pair for a source actor:
/// pets/avatars resolve to their owner first, then the (owner) actor's
/// embedded-record party slot replaces the character-scoped index when it
/// resolves (v2.0.2 same-character collapse fix — two players on the same
/// character share `+0x170`/`+0x1AB40`, so only the slot key separates them).
/// Non-player sources (enemies) keep their real index.
pub fn player_keyed_parent(
    source_type_id: u32,
    source_idx: u32,
    source: *const usize,
) -> (u32, u32) {
    let (parent_type_id, parent_idx, parent_ptr) =
        get_source_parent(source_type_id, source).unwrap_or((source_type_id, source_idx, source));

    let keyed_idx = player::player_slot_key_for_actor(parent_ptr).unwrap_or(parent_idx);
    (parent_type_id, keyed_idx)
}

/// The slot key of the PLAYER to credit an event on `source` to: the actor's
/// own embedded-record slot when it is a player, else its player-keyed owner
/// (pets/avatars resolve to the owner via [`player_keyed_parent`]). `None` for
/// enemy/unowned sources. Shared by the stun-net hook and the damage hooks'
/// guard attribution so they can never resolve differently.
pub fn player_slot_key_for_source(source: *const usize) -> Option<u32> {
    player::player_slot_key_for_actor(source).or_else(|| {
        let (_, keyed) = player_keyed_parent(actor_type_id(source), actor_idx(source), source);
        player::is_player_slot_key(keyed).then_some(keyed)
    })
}

#[cfg(test)]
mod teardown_tests {
    /// In the test binary no detour is ever initialized; teardown must treat
    /// that as "nothing to do" for every hook and return cleanly.
    #[test]
    fn teardown_hooks_with_no_detours_initialized_returns_cleanly() {
        super::teardown_hooks();
    }
}
