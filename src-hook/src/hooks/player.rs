use std::{
    ffi::{c_void, CStr, CString},
    sync::{Mutex, OnceLock},
};

use anyhow::{anyhow, Result};
use protocol::{Message, PlayerIdentityEvent};
use retour::static_detour;
use windows::Win32::{Foundation::HANDLE, System::Diagnostics::Debug::ReadProcessMemory};

use crate::{
    event,
    hooks::{
        actor_type_id,
        ffi::{Overmasteries, PlayerStats, SigilList, VBuffer, WeaponInfo},
        globals::{OVERMASTERY_OFFSET, PLAYER_DATA_OFFSET, SIGIL_OFFSET, WEAPON_OFFSET},
    },
    process::Process,
};

type OnLoadPlayerFunc = unsafe extern "system" fn(*const usize) -> usize;
type RefreshPlayerIdentityFunc = unsafe extern "system" fn(*const usize);

static_detour! {
    static OnLoadPlayer: unsafe extern "system" fn(*const usize) -> usize;
    static RefreshPlayerIdentity: unsafe extern "system" fn(*const usize);
}

#[derive(Clone)]
pub struct OnLoadPlayerHook {
    tx: event::Tx,
}

impl OnLoadPlayerHook {
    pub fn new(tx: event::Tx) -> Self {
        OnLoadPlayerHook { tx }
    }

    pub fn setup(&self, process: &Process) -> Result<()> {
        let cloned_self = self.clone();

        if let Ok(on_load_player_original) =
            process.search_address("49 89 ce e8 $ { ' } 31 ff 85 c0 ? ? ? ? ? ? 49 8b 46 28")
        {
            #[cfg(feature = "console")]
            println!("Found on load player");

            unsafe {
                let func: OnLoadPlayerFunc = std::mem::transmute(on_load_player_original);
                OnLoadPlayer.initialize(func, move |a1| cloned_self.run(a1))?;
                OnLoadPlayer.enable()?;
            }
        } else {
            return Err(anyhow!("Could not find on_load_player"));
        }

        Ok(())
    }

    fn run(&self, a1: *const usize) -> usize {
        #[cfg(feature = "console")]
        println!("on load player: {:p}", a1);

        let ret = unsafe { OnLoadPlayer.call(a1) };

        let player_idx = unsafe { a1.byte_add(0x170).read() } as u32;

        let player_offset = PLAYER_DATA_OFFSET.load(std::sync::atomic::Ordering::Relaxed);
        let weapon_offset = WEAPON_OFFSET.load(std::sync::atomic::Ordering::Relaxed);
        let overmastery_offset = OVERMASTERY_OFFSET.load(std::sync::atomic::Ordering::Relaxed);
        let sigil_offset = SIGIL_OFFSET.load(std::sync::atomic::Ordering::Relaxed);

        // If any offset failed to resolve (a game patch broke its signature; setup_globals
        // now logs-and-continues instead of aborting, leaving the offset at its default 0),
        // the struct pointers below would be computed at a1+0 and, worse, the sigil pointer
        // would be read from *(a1+0) — the object's vtable pointer reinterpreted as a
        // SigilList*, which is non-null and so passes the NonNull guard before being
        // dereferenced. Bail rather than read/deref garbage on the game thread.
        if player_offset == 0 || weapon_offset == 0 || overmastery_offset == 0 || sigil_offset == 0
        {
            log::warn!(
                "player_load: skipping, unresolved offset(s) player_data={player_offset:#x} \
                 weapon={weapon_offset:#x} overmastery={overmastery_offset:#x} sigil={sigil_offset:#x}"
            );
            return ret;
        }

        let raw_player_stats = std::ptr::NonNull::new(
            unsafe { a1.byte_add(player_offset as usize) } as *mut PlayerStats,
        );

        let raw_weapon_info = std::ptr::NonNull::new(
            unsafe { a1.byte_add(weapon_offset as usize) } as *mut WeaponInfo,
        );

        let raw_overmastery_info =
            std::ptr::NonNull::new(
                unsafe { a1.byte_add(overmastery_offset as usize) } as *mut Overmasteries
            );

        let sigil_list = std::ptr::NonNull::new(
            unsafe { a1.byte_add(sigil_offset as usize).read() } as *mut SigilList,
        );

        if let (
            Some(raw_player_stats),
            Some(weapon_info),
            Some(overmastery_info),
            Some(sigil_list),
        ) = (
            raw_player_stats,
            raw_weapon_info,
            raw_overmastery_info,
            sigil_list,
        ) {
            let character_type = actor_type_id(a1);
            let player_stats = unsafe { raw_player_stats.as_ref() };
            let weapon_info = unsafe { weapon_info.as_ref() };
            let overmastery_info = unsafe { overmastery_info.as_ref() };
            let sigil_list = unsafe { sigil_list.as_ref() };

            if (sigil_list.party_index as u8) == 0xFF && sigil_list.is_online == 0 {
                return ret;
            }

            let sigils = sigil_list
                .sigils
                .iter()
                .map(|sigil| protocol::Sigil {
                    first_trait_id: sigil.first_trait_id,
                    first_trait_level: sigil.first_trait_level,
                    second_trait_id: sigil.second_trait_id,
                    second_trait_level: sigil.second_trait_level,
                    sigil_id: sigil.sigil_id,
                    equipped_character: sigil.equipped_character,
                    sigil_level: sigil.sigil_level,
                    acquisition_count: sigil.acquisition_count,
                    notification_enum: sigil.notification_enum,
                })
                .collect();

            let character_name = CStr::from_bytes_until_nul(&sigil_list.character_name)
                .ok()
                .map(|cstr| cstr.to_owned())
                .unwrap_or(CString::new("").unwrap());

            let display_name =
                VBuffer(std::ptr::addr_of!(sigil_list.display_name) as *const usize).raw();

            let weapon_info = protocol::WeaponInfo {
                weapon_id: weapon_info.weapon_id,
                star_level: weapon_info.star_level,
                plus_marks: weapon_info.plus_marks,
                awakening_level: weapon_info.awakening_level,
                trait_1_id: weapon_info.trait_1_id,
                trait_1_level: weapon_info.trait_1_level,
                trait_2_id: weapon_info.trait_2_id,
                trait_2_level: weapon_info.trait_2_level,
                trait_3_id: weapon_info.trait_3_id,
                trait_3_level: weapon_info.trait_3_level,
                wrightstone_id: weapon_info.wrightstone_id,
                weapon_level: weapon_info.weapon_level,
                weapon_hp: weapon_info.weapon_hp,
                weapon_attack: weapon_info.weapon_attack,
            };

            let overmastery_info = protocol::OvermasteryInfo {
                overmasteries: overmastery_info
                    .stats
                    .iter()
                    .map(|overmastery| protocol::Overmastery {
                        id: overmastery.id,
                        flags: overmastery.flags,
                        value: overmastery.value,
                    })
                    .collect(),
            };

            let payload = Message::PlayerLoadEvent(protocol::PlayerLoadEvent {
                sigils,
                character_name,
                display_name,
                actor_index: player_idx,
                is_online: sigil_list.is_online != 0,
                party_index: sigil_list.party_index as u8,
                player_stats: protocol::PlayerStats {
                    level: player_stats.level,
                    total_hp: player_stats.total_health,
                    total_attack: player_stats.total_attack,
                    stun_power: player_stats.stun_power,
                    critical_rate: player_stats.critical_rate,
                    total_power: player_stats.total_power,
                },
                character_type,
                weapon_info,
                overmastery_info,
            });

            #[cfg(feature = "console")]
            println!("sending player load event: {:?}", payload);

            let _ = self.tx.send(payload);
        }

        ret
    }
}

// ---------------------------------------------------------------------------
// Game 2.0.2 identity path
//
// The full OnLoadPlayer hook above depends on equipment offsets (sigil/weapon/
// overmastery) that shifted in the 2.0 update and are not yet re-derived, so it
// no longer fires. The identity path below recovers the piece the meter actually
// needs to tell players apart — display name + party slot — from the identity
// snapshot alone, which DID survive the patch.
//
// Two moving parts:
//   1. RefreshPlayerIdentity hook — fires when the game rebuilds a player's
//      identity snapshot. We read the stable name/party fields and cache them
//      keyed by the record's player-key.
//   2. identity_event_for_actor — called from the damage hook with the concrete
//      combat actor. It resolves that actor to a cached identity via the actor's
//      own player-key, and emits a PlayerIdentityEvent.
// ---------------------------------------------------------------------------

/// Offset of the identity snapshot pointer inside the player *record* passed to
/// RefreshPlayerIdentity. VERIFIED on v2.0.2: the hooked function reads
/// `[record + 0x5E60]` as the snapshot base (sigscan + Ghidra decompile of
/// FUN_140a2b600). The snapshot's inner field layout matches [`SigilList`]
/// (is_online/character_name/display_name/party_index at 0x1C8/0x1E8/0x208/0x22C).
const PLAYER_IDENTITY_OFFSET: usize = 0x5E60;

/// Offset of the owning player's key inside the player *record*.
/// UNVERIFIED on this exe — carried over from onelittlechildawa's independent
/// 2.0.2 fix. Read defensively (a wrong value is rejected below, never crashes).
const PLAYER_KEY_OFFSET: usize = 0x5EA8;

/// Offset of the owning player's key inside a concrete combat *actor* (the source
/// instance the damage hook sees). UNVERIFIED on this exe — carried over from the
/// same fork. Read via ReadProcessMemory so a bad range fails the read instead of
/// faulting the game thread.
const ACTOR_PLAYER_KEY_OFFSET: usize = 0x1AB40;

/// Sentinel that the game uses for an unset player key. This is the same
/// `0x887AE0B0` player-data type-hash that anchors the player_data offset scan;
/// it appears where a real key has not been assigned, so treat it as "no key".
const INVALID_PLAYER_KEY: u32 = 0x887A_E0B0;

/// Prologue of the function that rebuilds the player identity snapshot
/// (FUN_140a2b600). VERIFIED unique (1 match) on v2.0.2; clean entry, 1-arg
/// `fn(rcx = player record)`. Hooking the refresh gives us names as soon as a
/// player's identity is (re)built, before the first damage event.
const REFRESH_PLAYER_IDENTITY_SIG: &str =
    "55 41 57 41 56 41 54 56 57 53 48 83 ec 70 48 8d 6c 24 70 48 c7 45 f8 fe ff ff ff 80 b9 bc 5e 00 00 00";

/// Cached identity fields for one player, resolved from a snapshot.
#[derive(Clone, Debug)]
struct StoredPlayerIdentity {
    character_name: CString,
    display_name: CString,
    party_index: u8,
    is_online: bool,
}

/// One party slot's identity, paired with the id its record most recently carried
/// at [`PLAYER_KEY_OFFSET`].
struct SlotIdentity {
    id: u32,
    identity: StoredPlayerIdentity,
}

/// Player identities keyed by PARTY SLOT — the game's own addressing for player
/// records (they're fetched per slot 0..=3 internally).
///
/// v2.0.2: the id at record+0x5EA8 is RECYCLED, not a stable player key — the same
/// value moves between players/slots, and even the local player's id changes
/// between contexts within one session (confirmed live). So the id is only a
/// transient correlator: it's matched at the instant a damage event arrives against
/// the LATEST value each slot's record announced, and is never cached per actor.
/// A stale pairing therefore cannot outlive the next identity refresh, which is
/// what made names flip between players and stick wrong before.
#[derive(Default)]
struct IdentityStore {
    by_slot: [Option<SlotIdentity>; 4],
}

impl IdentityStore {
    /// Records that party slot `identity.party_index` currently carries `id`.
    /// Latest claim wins: an id can belong to at most one slot at a time, so any
    /// other slot still holding it is evicted.
    fn claim(&mut self, id: u32, identity: StoredPlayerIdentity) {
        let slot = identity.party_index.min(3) as usize;

        for (index, entry) in self.by_slot.iter_mut().enumerate() {
            if index != slot && entry.as_ref().is_some_and(|e| e.id == id) {
                #[cfg(feature = "hookdiag")]
                log::info!("IDDIAG id {id:#010x} moved slot {index} -> {slot}");
                *entry = None;
            }
        }

        #[cfg(feature = "hookdiag")]
        if let Some(previous) = &self.by_slot[slot] {
            if previous.identity.display_name != identity.display_name || previous.id != id {
                log::info!(
                    "IDDIAG slot {slot} update {:?}/{:#010x} -> {:?}/{id:#010x}",
                    previous.identity.display_name,
                    previous.id,
                    identity.display_name,
                );
            }
        }

        self.by_slot[slot] = Some(SlotIdentity { id, identity });
    }

    /// Finds the slot whose record most recently carried `id`.
    fn find_by_id(&self, id: u32) -> Option<&StoredPlayerIdentity> {
        self.by_slot
            .iter()
            .flatten()
            .find(|entry| entry.id == id)
            .map(|entry| &entry.identity)
    }
}

static IDENTITIES: OnceLock<Mutex<IdentityStore>> = OnceLock::new();

fn identities() -> &'static Mutex<IdentityStore> {
    IDENTITIES.get_or_init(|| Mutex::new(IdentityStore::default()))
}

#[derive(Clone)]
pub struct OnLoadPlayerIdentityHook {
    // Retained for symmetry with the other hooks and future use; the identity
    // path publishes through identity_event_for_actor at damage time, not here.
    #[allow(dead_code)]
    tx: event::Tx,
}

impl OnLoadPlayerIdentityHook {
    pub fn new(tx: event::Tx) -> Self {
        Self { tx }
    }

    pub fn setup(&self, process: &Process) -> Result<()> {
        let refresh_player_identity = process
            .search_match_address(REFRESH_PLAYER_IDENTITY_SIG)
            .map_err(|_| anyhow!("Could not find refresh_player_identity"))?;

        #[cfg(feature = "console")]
        println!("Found refresh player identity");

        let cloned_self = self.clone();

        unsafe {
            let func: RefreshPlayerIdentityFunc = std::mem::transmute(refresh_player_identity);
            RefreshPlayerIdentity.initialize(func, move |record| cloned_self.run(record))?;
            RefreshPlayerIdentity.enable()?;
        }

        Ok(())
    }

    fn run(&self, record: *const usize) {
        unsafe { RefreshPlayerIdentity.call(record) };

        if record.is_null() {
            return;
        }

        let snapshot = unsafe {
            (record.byte_add(PLAYER_IDENTITY_OFFSET) as *const *const u8).read_unaligned()
        };
        let player_key = unsafe {
            record
                .byte_add(PLAYER_KEY_OFFSET)
                .cast::<u32>()
                .read_unaligned()
        };

        // v2.0.2 identity diagnosis: log every record refresh with its mode enum and id
        // neighborhood. Ghidra shows record+0x5EAC is a small mode enum (0..=5) and
        // +0x5EA8 an id the game itself re-resolves live — the mode is the missing piece
        // to know WHICH records are authoritative. Guarded reads, hookdiag builds only.
        #[cfg(feature = "hookdiag")]
        log_identity_record(record, snapshot, player_key);

        if player_key == 0 || player_key == INVALID_PLAYER_KEY {
            return;
        }

        let Some(mut identity) = (unsafe { read_player_identity(snapshot) }) else {
            return;
        };

        // Offline non-slot-0 records are the AI companions (and, transiently, the
        // pre-population placeholders of an online lobby). Their snapshot carries the
        // LOCAL profile's name (confirmed live: all four records announce the local
        // name with distinct keys), which is not the AI's own name — so cache them
        // with the names BLANKED. This lets AI damage resolve to its party slot (the
        // meter then shows "[N] <character>" instead of "[Guest] <character>"), while
        // a real remote player joining the slot re-claims it with their real name on
        // the next identity refresh (latest claim wins).
        if is_ai_placeholder(&identity) {
            identity.display_name = CString::new("").expect("empty CString is valid");
            identity.character_name = CString::new("").expect("empty CString is valid");
        }

        #[cfg(feature = "console")]
        println!(
            "player identity cached: key={player_key:#010x} party={} online={} name={}",
            identity.party_index,
            identity.is_online,
            identity.display_name.to_string_lossy()
        );

        identities()
            .lock()
            .expect("identity map lock poisoned")
            .claim(player_key, identity);
    }
}

/// Slot 0 is always the local player. Any other slot that is not flagged online is
/// an AI companion (or a not-yet-populated lobby placeholder) whose snapshot name is
/// the local profile's, not its own.
fn is_ai_placeholder(identity: &StoredPlayerIdentity) -> bool {
    identity.party_index != 0 && !identity.is_online
}

/// Resolves the concrete combat actor (as seen by the damage hook) to a cached
/// identity, emitting a [`PlayerIdentityEvent`] if one is known.
///
/// The actor's id is read FRESH on every call and matched against the latest id
/// each party slot's record announced — deliberately no per-actor caching, because
/// v2.0.2 ids are recycled between players/contexts and a cached pairing goes
/// stale (that was the wrong/flip-flopping-names bug). One guarded 4-byte read per
/// damage event is negligible.
///
/// Returns `None` when the actor has no resolvable player-key or no slot currently
/// claims it (e.g. an NPC/enemy, or a player whose snapshot has not refreshed).
/// Safe to call for every damage source.
pub fn identity_event_for_actor(
    actor: *const usize,
    character_type: u32,
    actor_index: u32,
) -> Option<PlayerIdentityEvent> {
    if actor.is_null() {
        return None;
    }

    #[cfg(feature = "hookdiag")]
    let actor_address = actor as usize;
    let Some(player_key) = read_actor_player_key(actor) else {
        // Bounded: log the first N actors whose key read comes back
        // empty/sentinel so "player shows as [Guest]" cases are visible.
        #[cfg(feature = "hookdiag")]
        {
            use std::sync::atomic::AtomicU32;
            static N: AtomicU32 = AtomicU32::new(0);
            if crate::hooks::diag::first_n(&N, 60) {
                let raw =
                    crate::hooks::diag::read_u32_guarded(actor_address, ACTOR_PLAYER_KEY_OFFSET);
                log::info!(
                    "IDDIAG actor={actor_address:#x} type={character_type:#010x} idx={actor_index} key read FAILED raw@1AB40={raw:#010x}"
                );
            }
        }
        return None;
    };

    // First sight of this actor: log the id pair around 0x1AB40 — Ghidra shows
    // [+0x1AB40]=id passed to the record manager and [+0x1AB44] compared against
    // the 0x887AE0B0 sentinel. Logging only; resolution never caches.
    #[cfg(feature = "hookdiag")]
    {
        use std::collections::HashSet;
        use std::sync::{Mutex as DiagMutex, OnceLock as DiagOnceLock};
        static SEEN: DiagOnceLock<DiagMutex<HashSet<usize>>> = DiagOnceLock::new();
        let seen = SEEN.get_or_init(|| DiagMutex::new(HashSet::new()));
        let mut seen = seen.lock().expect("iddiag seen lock poisoned");
        if seen.len() < 256 && seen.insert(actor_address) {
            let k44 =
                crate::hooks::diag::read_u32_guarded(actor_address, ACTOR_PLAYER_KEY_OFFSET + 4);
            let k64 = crate::hooks::diag::read_u32_guarded(
                actor_address,
                ACTOR_PLAYER_KEY_OFFSET + 0x24,
            );
            log::info!(
                "IDDIAG actor={actor_address:#x} type={character_type:#010x} idx={actor_index} id@1AB40={player_key:#010x} @1AB44={k44:#010x} @1AB64={k64:#010x}"
            );
        }
    }

    let identity = identities()
        .lock()
        .expect("identity map lock poisoned")
        .find_by_id(player_key)
        .cloned()?;

    Some(PlayerIdentityEvent {
        character_name: identity.character_name,
        display_name: identity.display_name,
        character_type,
        party_index: identity.party_index,
        actor_index,
        is_online: identity.is_online,
    })
}

/// Reads the player-key from a concrete combat actor via ReadProcessMemory so an
/// invalid/short actor range fails the read rather than faulting the game thread.
fn read_actor_player_key(actor: *const usize) -> Option<u32> {
    let mut player_key = 0u32;
    let mut bytes_read = 0usize;
    let result = unsafe {
        ReadProcessMemory(
            HANDLE(-1),
            actor.byte_add(ACTOR_PLAYER_KEY_OFFSET).cast::<c_void>(),
            (&mut player_key as *mut u32).cast::<c_void>(),
            std::mem::size_of::<u32>(),
            Some(&mut bytes_read),
        )
    };

    if result.is_err()
        || bytes_read != std::mem::size_of::<u32>()
        || player_key == 0
        || player_key == INVALID_PLAYER_KEY
    {
        return None;
    }

    Some(player_key)
}

/// Reads the stable identity fields from a snapshot. Field offsets match the
/// [`SigilList`] layout (verified surviving in v2.0.2): is_online @ 0x1C8,
/// character_name @ 0x1E8, display_name @ 0x208, party_index @ 0x22C.
unsafe fn read_player_identity(snapshot: *const u8) -> Option<StoredPlayerIdentity> {
    if snapshot.is_null() {
        return None;
    }

    let list = &*(snapshot as *const SigilList);

    let is_online = list.is_online;
    let party_index = list.party_index;

    // Reject obviously-bogus snapshots (garbage pointer / wrong struct) so we
    // never cache a junk identity.
    if is_online > 1 || party_index > 3 {
        return None;
    }

    let display_name =
        VBuffer(std::ptr::addr_of!(list.display_name) as *const usize).checked_raw()?;

    // A real player always has a display name; an empty one means this snapshot
    // is not a resolvable identity yet.
    if display_name.as_bytes().is_empty() {
        return None;
    }

    let character_name = CStr::from_bytes_until_nul(&list.character_name)
        .ok()
        .map(|cstr| cstr.to_owned())
        .unwrap_or_else(|| CString::new("").expect("empty CString is valid"));

    Some(StoredPlayerIdentity {
        character_name,
        display_name,
        party_index: party_index as u8,
        is_online: is_online != 0,
    })
}

/// hookdiag: one line per RefreshPlayerIdentity fire — the record's mode enum
/// (+0x5EAC, values 0..=5 per the v2.0.2 decompile of FUN_140a2b600), the id at
/// +0x5EA8 the hook currently keys identities by, its u32 neighbors, and the
/// snapshot's name/party/online. All reads guarded; never faults.
#[cfg(feature = "hookdiag")]
fn log_identity_record(record: *const usize, snapshot: *const u8, player_key: u32) {
    use crate::hooks::diag::read_u32_guarded;

    let base = record as usize;
    let mode = read_u32_guarded(base, 0x5EAC);
    let n_a4 = read_u32_guarded(base, 0x5EA4);
    let n_b0 = read_u32_guarded(base, 0x5EB0);
    let (name, party, online) = match unsafe { read_player_identity(snapshot) } {
        Some(identity) => (
            identity.display_name.to_string_lossy().into_owned(),
            identity.party_index as i32,
            identity.is_online as i32,
        ),
        None => ("<unreadable>".to_string(), -1, -1),
    };
    log::info!(
        "IDDIAG record={base:#x} mode@5EAC={mode} id@5EA8={player_key:#010x} n@5EA4={n_a4:#010x} n@5EB0={n_b0:#010x} party={party} online={online} name={name}"
    );
}
