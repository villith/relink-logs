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
mod damage;
mod death;
pub mod diag;
mod endless;
mod ffi;
mod globals;
mod loadprobe;
mod player;
mod quest;
mod sba;
mod stunnet;

type GetEntityHashID0x58 = unsafe extern "system" fn(*const usize, *const u32) -> *const usize;

/// Pl1900 (Id, human form) actor type hash.
const ID_HUMAN_TYPE: u32 = 0x8056ABCD;
const ID_DRAGON_PARENT_ENTITY_OFFSET: usize = 0x1CA98;

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
    // result screen (see OnQuestRetireHook). Wipes are still covered only by the
    // next-quest-load backstop until a fail-screen probe below is promoted.
    try_step(
        "quest_retire",
        quest::OnQuestRetireHook::new(tx.clone()).setup(&process),
    );
    // hookdiag-only: fail-screen candidates (ResultRetryDialog / MenuGameOver ctor)
    // logged as observers to pick the wipe-moment boundary. No-op without the feature.
    #[cfg(feature = "hookdiag")]
    try_step(
        "fail_screen_probes",
        quest::failprobe::FailScreenProbes::setup(&process),
    );

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
pub fn get_source_parent(
    source_type_id: u32,
    source: *const usize,
) -> Option<(u32, u32, *const usize)> {
    match source_type_id {
        // Pl0700Ghost -> Pl0700
        0x2AF678E8 => {
            let parent_instance = parent_specified_instance_at(source, 0xE48)?;

            Some((
                actor_type_id(parent_instance),
                actor_idx(parent_instance),
                parent_instance,
            ))
        }
        // Pl0700GhostSatellite -> Pl0700
        0x8364C8BC => {
            let parent_instance = parent_specified_instance_at(source, 0x508)?;

            Some((
                actor_type_id(parent_instance),
                actor_idx(parent_instance),
                parent_instance,
            ))
        }
        // Wp1890: Cagliostro's Ouroboros Dragon Sled -> Pl1800
        0xC9F45042 => {
            let parent_instance = parent_specified_instance_at(source, 0x578)?;
            Some((
                actor_type_id(parent_instance),
                actor_idx(parent_instance),
                parent_instance,
            ))
        }
        // Pl2000: Id's Dragon Form -> Pl1900
        0xF5755C0E => {
            let parent_instance =
                parent_specified_instance_at(source, ID_DRAGON_PARENT_ENTITY_OFFSET)?;

            let parent_idx = diag::read_ptr_guarded(parent_instance as usize, 0x170)? as u32;
            Some((ID_HUMAN_TYPE, parent_idx, parent_instance))
        }
        // Wp2290: Seofon's Avatar
        0x5B1AB457 => {
            let parent_instance = parent_specified_instance_at(source, 0x500)?;
            Some((
                actor_type_id(parent_instance),
                actor_idx(parent_instance),
                parent_instance,
            ))
        }
        // Pl0600PlantRose
        0x69C0CA71 => {
            let parent_instance = parent_specified_instance_at(source, 0x7E0)?;
            Some((
                actor_type_id(parent_instance),
                actor_idx(parent_instance),
                parent_instance,
            ))
        }
        _ => None,
    }
}

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
    let (parent_type_id, parent_idx, parent_ptr) = get_source_parent(source_type_id, source)
        .unwrap_or((source_type_id, source_idx, source));

    let keyed_idx = player::player_slot_key_for_actor(parent_ptr).unwrap_or(parent_idx);
    (parent_type_id, keyed_idx)
}

// Returns the specified instance of the parent entity.
// ptr+offset: Entity
// *(ptr+offset) + 0x70: m_pSpecifiedInstance (Pl0700, Pl1200, etc.)
//
// Both hops are SEH-guarded: these parent-link offsets are version-fragile, and a
// stale one (or a pet/form instance smaller than the offset) previously meant a raw
// deref of unmapped memory on the game thread — the silent-freeze class of bug. A
// failed read just leaves the child actor ungrouped.
#[inline(always)]
fn parent_specified_instance_at(actor_ptr: *const usize, offset: usize) -> Option<*const usize> {
    let entity = diag::read_ptr_guarded(actor_ptr as usize, offset)?;
    if entity == 0 {
        return None;
    }

    let parent = diag::read_ptr_guarded(entity, 0x70)?;
    (parent != 0).then_some(parent as *const usize)
}

#[cfg(test)]
mod tests {
    use super::{parent_specified_instance_at, ID_DRAGON_PARENT_ENTITY_OFFSET};

    #[test]
    fn resolves_parent_through_the_entity_link() {
        let parent = Box::new(0usize);
        let parent_ptr = &*parent as *const usize;
        let mut entity = vec![0u8; 0x78];
        let mut actor = vec![0u8; ID_DRAGON_PARENT_ENTITY_OFFSET + std::mem::size_of::<usize>()];

        unsafe {
            entity
                .as_mut_ptr()
                .byte_add(0x70)
                .cast::<*const usize>()
                .write_unaligned(parent_ptr);
            actor
                .as_mut_ptr()
                .byte_add(ID_DRAGON_PARENT_ENTITY_OFFSET)
                .cast::<*const u8>()
                .write_unaligned(entity.as_ptr());
        }

        assert_eq!(
            parent_specified_instance_at(
                actor.as_ptr().cast::<usize>(),
                ID_DRAGON_PARENT_ENTITY_OFFSET,
            ),
            Some(parent_ptr)
        );
    }

    #[test]
    fn invalid_actor_address_fails_without_dereferencing() {
        assert_eq!(
            parent_specified_instance_at(1usize as *const usize, 0),
            None
        );
    }

    #[test]
    fn null_entity_link_yields_no_parent() {
        let actor = vec![0u8; 0x100];
        assert_eq!(
            parent_specified_instance_at(actor.as_ptr().cast(), 0x40),
            None
        );
    }
}
