use std::ptr::NonNull;

use anyhow::{anyhow, Result};
use protocol::{ActionType, Actor, DamageEvent, Message};
use retour::static_detour;

use crate::{event, hooks::diag::readable, hooks::ffi::DamageInstance, process::Process};

use super::{actor_idx, actor_type_id};

type ProcessDamageEventFunc =
    unsafe extern "system" fn(*const usize, *const usize, *const usize, u8) -> usize;

// v2.0.2: `StatusBase::getDotDamage(StatusBase* status /*rcx*/, DotDamage* out /*rdx*/)`.
// The shared prologue (`mov rsi,rdx; mov rdi,rcx`, r8/r9 never read) confirms **2 args** —
// the previous 4-arg declaration described the wrong function entirely (see PROCESS_DOT_SIG).
type ProcessDotEventFunc = unsafe extern "system" fn(*const usize, *const usize) -> usize;

static_detour! {
    static ProcessDamageEvent: unsafe extern "system" fn(*const usize, *const usize, *const usize, u8) -> usize;
    // One detour per DoT-dealing status subclass; see PROCESS_DOT_SIG.
    static ProcessDotEvent0: unsafe extern "system" fn(*const usize, *const usize) -> usize;
    static ProcessDotEvent1: unsafe extern "system" fn(*const usize, *const usize) -> usize;
    static ProcessDotEvent2: unsafe extern "system" fn(*const usize, *const usize) -> usize;
}

/// Per-target budget for the stun_scan window probe (module-scoped so it can be
/// RESET on quest load). `first_n_per_key` tracks at most 64 distinct keys EVER —
/// the 2026-07-18 online run proved that town/solo play earlier in the same game
/// session exhausts all 64 before the online quest starts, so the probe never
/// sampled the lobby at all. Clearing on each quest load gives every quest a
/// fresh budget.
#[cfg(feature = "hookdiag")]
pub(crate) static STUN_SCAN_PER_TARGET: std::sync::Mutex<Vec<(usize, u32)>> =
    std::sync::Mutex::new(Vec::new());

/// Reset the stun_scan per-target budget (called from the quest-load hook).
#[cfg(feature = "hookdiag")]
pub(crate) fn reset_stun_scan_budget() {
    if let Ok(mut entries) = STUN_SCAN_PER_TARGET.try_lock() {
        entries.clear();
    }
}

#[derive(Clone)]
pub struct OnProcessDamageHook {
    tx: event::Tx,
}

const PROCESS_DAMAGE_EVENT_SIG: &str = "e8 $ { ' } 66 83 bc 24 ? ? ? ? ?";

impl OnProcessDamageHook {
    pub fn new(tx: event::Tx) -> Self {
        OnProcessDamageHook { tx }
    }

    pub fn setup(&self, process: &Process) -> Result<()> {
        let cloned_self = self.clone();

        if let Ok(process_dmg_evt) = process.search_address(PROCESS_DAMAGE_EVENT_SIG) {
            #[cfg(feature = "console")]
            println!("Found process dmg event");

            unsafe {
                let func: ProcessDamageEventFunc = std::mem::transmute(process_dmg_evt);

                ProcessDamageEvent
                    .initialize(func, move |a1, a2, a3, a4| cloned_self.run(a1, a2, a3, a4))?;

                ProcessDamageEvent.enable()?;
            }
        } else {
            return Err(anyhow!("Could not find process_dmg_evt"));
        }

        Ok(())
    }

    fn run(&self, a1: *const usize, a2: *const usize, a3: *const usize, a4: u8) -> usize {
        // hookdiag: process_damage still resolves; log its callers once so we can locate
        // the adjacent (broken) death handler. Fires constantly, so log only the first N.
        #[cfg(feature = "hookdiag")]
        {
            static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
            if crate::hooks::diag::first_n(&N, 3) {
                crate::hooks::diag::log_callers("process_damage");
            }
        }

        // Target is the instance of the actor being damaged.
        // For example: Instance of the Em2700 class.
        //
        // All of these actor derefs are VirtualQuery-guarded (read_ptr/f32_guarded): a NEW
        // character can be a `Pl####` class with a different instance layout, so an offset
        // valid for known actors may fall outside its allocation. A guarded read returns None
        // there and we bail — the game's own damage processing STILL runs (we never skip
        // ProcessDamageEvent.call), we only skip emitting our own event. Previously these were
        // raw derefs that hard-faulted the game thread on an unfamiliar actor (silent freeze).
        use crate::hooks::diag::{read_f32_guarded, read_ptr_guarded};

        // a1+0x08 -> *ptr -> target specified instance. Two hops, each guarded.
        let target_specified_instance_ptr =
            match read_ptr_guarded(a1 as usize, 0x08).and_then(|p| read_ptr_guarded(p, 0x00)) {
                Some(ptr) if ptr != 0 => ptr,
                _ => return unsafe { ProcessDamageEvent.call(a1, a2, a3, a4) },
            };

        // v2.0.2: the stun accumulator moved target+0xA70 -> +0xB90. Live-derived via
        // the stun_scan probe (2026-07-15, three targets across three sessions): +0xB90
        // is strictly monotonic across hits with old-scale increments (repeated attacks
        // add identical amounts, e.g. +12.72 per hit), while the old 0xA70 deltas 0.0
        // on every hit. Nearby look-alikes rejected: +0xB3C refreshes to a 2.50 cap and
        // decays (flinch timer), +0xA44 moves <0.01/hit.
        const STUN_ACCUMULATOR_OFFSET: usize = 0xB90;

        let previous_stun_value =
            read_f32_guarded(target_specified_instance_ptr, STUN_ACCUMULATOR_OFFSET);

        // Stun re-derivation probe (kept for the next patch): snapshot a float window
        // across the original call and log offsets that INCREASED; the accumulator is
        // the offset whose growth tracks hits landing.
        // Budgeted PER TARGET (a global first-48 burned the whole budget on the
        // opening trash mobs of the 2026-07-15 session and never sampled the boss),
        // hookdiag builds only.
        //
        // 2026-07-17 online finding: in a real online lobby the verified +0xB90
        // accumulator never moves — for ANY player, local included (log 405:
        // 0 stun events over 2914 hits, vs thousands offline). The window is
        // widened 0x800..0xE00 -> 0x000..0x1800 to catch an online-mode
        // accumulator living elsewhere in the instance (cost is fine: the
        // window is guarded with ONE probe, and tonight's +0xD60 blips show the
        // interesting region extends below 0x800).
        #[cfg(feature = "hookdiag")]
        let stun_probe_pre = {
            crate::hooks::diag::first_n_per_key(
                &STUN_SCAN_PER_TARGET,
                target_specified_instance_ptr,
                24,
            )
            .then(|| {
                crate::hooks::diag::snapshot_f32_window(
                    target_specified_instance_ptr,
                    0x000,
                    0x1800,
                )
            })
        };

        let original_value = unsafe { ProcessDamageEvent.call(a1, a2, a3, a4) };

        #[cfg(feature = "hookdiag")]
        if let Some(pre) = stun_probe_pre {
            let post = crate::hooks::diag::snapshot_f32_window(
                target_specified_instance_ptr,
                0x000,
                0x1800,
            );
            crate::hooks::diag::log_f32_increases(
                "stun_scan",
                target_specified_instance_ptr,
                0x000,
                &pre,
                &post,
            );
        }

        // Stun is a delta across the original call; if either read is unavailable we simply
        // report no stun rather than faulting.
        let added_stun_value = match (
            previous_stun_value,
            read_f32_guarded(target_specified_instance_ptr, STUN_ACCUMULATOR_OFFSET),
        ) {
            (Some(prev), Some(cur)) => (cur - prev).max(0.0),
            _ => 0.0,
        };

        // This points to the first Entity instance in the 'a2' entity list.
        let source_entity_ptr = match read_ptr_guarded(a2 as usize, 0x18) {
            Some(ptr) => ptr as *const usize,
            None => return original_value,
        };

        // @TODO(false): For some reason, online + Ferry's Umlauf skill pet can return a null pointer here.
        // Possible data race with online?
        if source_entity_ptr.is_null() {
            return original_value;
        }

        // entity->m_pSpecifiedInstance, offset 0x70 from entity pointer.
        // Returns the specific class instance of the source entity. (e.g. Instance of Pl1200 / Pl0700Ghost)
        let source_specified_instance_ptr = match read_ptr_guarded(source_entity_ptr as usize, 0x70)
        {
            Some(ptr) if ptr != 0 => ptr,
            _ => return original_value,
        };

        // hookdiag: DISABLED — the wide instance scan was too heavy for the game thread and
        // froze the game. We already captured the structure (see memory). Left here (commented)
        // as the re-enable point for a NARROW, targeted probe if needed.
        // #[cfg(feature = "hookdiag")]
        // crate::hooks::diag::probe_player_instance(source_specified_instance_ptr);

        let damage_instance = unsafe { NonNull::new(a2 as *mut DamageInstance).unwrap().as_ref() };
        let damage: i32 = damage_instance.damage;

        if original_value == 0 || damage <= 0 {
            return original_value;
        }

        let flags: u64 = damage_instance.flags;

        // Struct-offset diagnostic, kept for the next game patch (a major update shifts
        // fields in the DamageInstance struct on `a2` — this is how action_id was found
        // to move 0x154 -> 0x16c in v2.0.2, and how a relocated damage_cap can be found).
        // Off by default; build with `--features hook/dmgdiag` to dump every nonzero u32
        // in a wide window per real skill hit (Normal/Supplementary, not link/SBA) to the
        // fern log (%APPDATA%\gbfr-logs\gbfr-logs.txt).
        #[cfg(feature = "dmgdiag")]
        {
            // Log EVERY event (no link/SBA gate — the flag-bit classification itself is
            // under suspicion), with the damage-field region 0xC0+ included in the window
            // (the original 0x140 start missed damage/base/flags entirely).
            use std::fmt::Write as _;
            static DIAG_N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
            if crate::hooks::diag::first_n(&DIAG_N, 500) {
                // Source identity (2026-07-17): tag each dump with who dealt the
                // hit, so an online capture can separate remote players' hits
                // (whose cap/base fields read 0 in log 405) from local ones.
                let (src_type, src_idx) = match read_ptr_guarded(a2 as usize, 0x18)
                    .filter(|p| *p != 0)
                    .and_then(|e| read_ptr_guarded(e, 0x70))
                    .filter(|p| *p != 0)
                {
                    Some(src) => (
                        actor_type_id(src as *const usize),
                        actor_idx(src as *const usize),
                    ),
                    None => (0, 0),
                };
                // read_unaligned throughout: this probe exists to be edited to read arbitrary
                // (possibly unaligned) offsets while chasing shifted fields after a patch, so a
                // future non-4-aligned offset must not become UB / fault the game thread.
                let action_id = unsafe { (a2.byte_add(0x16c) as *const u32).read_unaligned() };
                let dmg_d0 = unsafe { (a2.byte_add(0xd0) as *const i32).read_unaligned() };
                let dmg_d4 = unsafe { (a2.byte_add(0xd4) as *const i32).read_unaligned() };
                let rate_d8 = unsafe { (a2.byte_add(0xd8) as *const f32).read_unaligned() };
                let rate_dc = unsafe { (a2.byte_add(0xdc) as *const f32).read_unaligned() };
                let floor = unsafe { (a2.byte_add(0x2b8) as *const i32).read_unaligned() };
                let cap = unsafe { (a2.byte_add(0x2bc) as *const i32).read_unaligned() };
                let precap_f32 = unsafe { (a2.byte_add(0x2d4) as *const f32).read_unaligned() };
                let mut dump = String::new();
                for off in (0xc0usize..0x340).step_by(4) {
                    let v = unsafe { (a2.byte_add(off) as *const u32).read_unaligned() };
                    if v != 0 {
                        let _ = write!(dump, "[0x{:x}]={} ", off, v);
                    }
                }
                log::info!(
                    "DMGDIAG src_type={src_type:#010x} src_idx={src_idx} unk@d0={} dmg@d4={} rate@d8={} rate@dc={} flags@e8={:#x} action@16c={} floor@2b8={} cap@2bc={} precap@2d4={} nonzero: {}",
                    dmg_d0,
                    dmg_d4,
                    rate_d8,
                    rate_dc,
                    flags,
                    action_id,
                    floor,
                    cap,
                    precap_f32,
                    dump
                );
            }
        }

        let action_type: ActionType = if ((1 << 7 | 1 << 50) & flags) != 0 {
            ActionType::LinkAttack
        } else if ((1 << 13 | 1 << 14) & flags) != 0 {
            ActionType::SBA
        } else if ((1 << 15) & flags) != 0 {
            ActionType::SupplementaryDamage(damage_instance.action_id)
        } else {
            ActionType::Normal(damage_instance.action_id)
        };

        // Get the source actor's type ID.
        let source_type_id = actor_type_id(source_specified_instance_ptr as *const usize);
        let source_idx = actor_idx(source_specified_instance_ptr as *const usize);

        // Game 2.0.2: resolve this actor to a cached player identity (name + party
        // slot) and publish it, since the full player_load hook no longer fires.
        // Returns None for enemies/NPCs and players not yet cached — cheap no-op then.
        if let Some(identity) = super::player::identity_event_for_actor(
            source_specified_instance_ptr as *const usize,
            source_type_id,
            source_idx,
        ) {
            // This instance resolved to a player identity — remember it so the
            // Pl2000 parent scan below has real player instances to search for.
            #[cfg(feature = "hookdiag")]
            crate::hooks::diag::note_player_instance(source_specified_instance_ptr);

            let _ = self.tx.send(Message::PlayerIdentityEvent(identity));
        }

        #[cfg(feature = "hookdiag")]
        if source_type_id == 0xF5755C0E {
            crate::hooks::diag::probe_pl2000_parent(source_specified_instance_ptr);
        }

        // Unmapped-source probe (2026-07-20, Cagliostro Pain Train / Alexandria): a
        // source that neither maps to a parent nor is a player itself is exactly what
        // the parser silently drops, so these skills never reach the meter. Unbudgeted
        // by request: EVERY unmapped hit logs (action id ties the actor to the skill
        // that spawned it), and the parent scan rescans until it finds the owner-entity
        // offset a new `get_source_parent` arm needs.
        #[cfg(feature = "hookdiag")]
        {
            let source_ptr = source_specified_instance_ptr as *const usize;
            if super::get_source_parent(source_type_id, source_ptr).is_none()
                && super::player::player_slot_key_for_actor(source_ptr).is_none()
            {
                log::info!(
                    "UNSRC hit type={source_type_id:#010x} idx={source_idx} \
                     action={action_type:?} dmg={damage} flags={flags:#x}"
                );
                crate::hooks::diag::probe_unmapped_source_parent(
                    source_specified_instance_ptr,
                    source_type_id,
                );
            }
        }

        // Resolve pets/avatars to their owner, then key players by their embedded
        // record's party slot (v2.0.2: the raw index is character-scoped and merges
        // two players on the same character into one meter row).
        let (source_parent_type_id, source_parent_idx) = super::player_keyed_parent(
            source_type_id,
            source_idx,
            source_specified_instance_ptr as *const usize,
        );

        let target_type_id: u32 = actor_type_id(target_specified_instance_ptr as *const usize);
        let target_idx = actor_idx(target_specified_instance_ptr as *const usize);

        // Post-hit target HP from the ExHp component. Read AFTER the original call so
        // the killing blow reports 0. Guarded read + plausibility checks: an actor
        // class without the +0x150 embed, or a future patch shifting it, yields None
        // rather than garbage.
        let (target_current_hp, target_max_hp) =
            read_target_hp_pair(target_specified_instance_ptr).unzip();

        let stun_value = if matches!(action_type, ActionType::SupplementaryDamage(_)) {
            None
        } else {
            Some(added_stun_value)
        };

        // Supplementary damage is never subject to the damage cap; the cap value on
        // its instance belongs to the hit that TRIGGERED it. Send no cap so it can
        // never count as a capped hit. (The parser enforces the same rule for events
        // already recorded in old logs.)
        let damage_cap = if matches!(action_type, ActionType::SupplementaryDamage(_)) {
            None
        } else {
            // v2.0.2: "no cap" now arrives as the 99,999,999 sentinel (the game normalizes
            // a -1 cap to it) rather than 0 — send None for both so cap detection stays off
            // for uncapped hits.
            (damage_instance.damage_cap > 0 && damage_instance.damage_cap < 99_999_999)
                .then_some(damage_instance.damage_cap)
        };

        // Pre-cap base damage (game's DamageInstance +0x2D4). Only meaningful alongside a
        // real cap, so send it only for cappable hits — the parser uses base > cap for exact
        // cap detection and (base/cap)*100 for the game's overcap %. Guard against garbage
        // (NaN/inf/negative) so a shifted offset after a future patch can't poison the parser.
        let base_damage = damage_cap.and_then(|_| {
            let b = damage_instance.base_damage;
            (b.is_finite() && b > 0.0).then_some(b)
        });

        let event = Message::DamageEvent(DamageEvent {
            source: Actor {
                index: source_idx,
                actor_type: source_type_id,
                parent_index: source_parent_idx,
                parent_actor_type: source_parent_type_id,
            },
            target: Actor {
                // Per-spawn id, NOT the game index: sibling summons collapse to
                // one game index (Lucilius' three swords), so the instance
                // pointer is the only discriminator between actors alive at the
                // same time. Consumers group targets by `parent_index`; `index`
                // exists to tell simultaneous same-kind actors apart.
                index: target_spawn_id(target_specified_instance_ptr),
                actor_type: target_type_id,
                parent_index: target_idx,
                parent_actor_type: target_type_id,
            },
            damage,
            flags,
            action_id: action_type,
            attack_rate: Some(damage_instance.attack_rate),
            damage_cap,
            stun_value,
            base_damage,
            target_current_hp,
            target_max_hp,
        });

        let _ = self.tx.send(event);

        original_value
    }
}

#[derive(Clone)]
pub struct OnProcessDotHook {
    tx: event::Tx,
}

/// Entry signature for `StatusBase::getDotDamage` — the per-tick DoT damage calculator.
///
/// v2.0.2 rewrote this path and is why no DoT event has been recorded since 2026-07-01.
/// Pre-2.0.2 the calculator was a single directly-called function, which the old sig found
/// by following its `call`. In 2.0.2 it became a **virtual** (vtable slot 9, `+0x48`), so
/// the direct call no longer exists; the sig re-anchored on the surviving byte idiom landed
/// on an unrelated queue-pop helper (0x477cdb0) that never touches a status, so the hook
/// installed cleanly and emitted nothing.
///
/// Established in Ghidra (`gbfr202fast`):
///   * `ExStatus::update` (0x140bdc560) is the ONLY caller — it invokes slot 9 once per
///     ticking status, sums the results and applies them to the target.
///   * Of the 168 `StatusBase` subclasses only three override slot 9: poison (0x3b871f0),
///     burn (0x3b87f30) and darkburn/`StatusAilmentDimensionDamage` (0x3b8a3d0). The other
///     165 inherit a base that reports zero damage.
///   * Those three compile to a byte-identical prologue, so this one pattern resolves to
///     exactly those three entries (verified: 3 matches, no false positives) and each is
///     detoured. The pattern starts at the entry, so `search_match_addresses` returns the
///     entries directly — no `call` to follow.
///
/// The out-descriptor the getter fills:
///   * `+0x00` u32 status id
///   * `+0x04` i32 DoT type — 0 poison, 1 burn, 2 darkburn (the inherited base writes -1);
///     this is what finally populates [`ActionType::DamageOverTime`]'s type field, which
///     was hardcoded to 0 while the type was unknown
///   * `+0x08` `const char*` debug name (`"poison_dot"`, `"darkburn_dot"`)
///   * `+0x10` f32 damage for this tick
const PROCESS_DOT_SIG: &str = "' 41 57 41 56 41 55 41 54 56 57 55 53 48 83 ec 78 c5 f8 29 7c 24 60 \
                               c5 f8 29 74 24 50 48 89 d6 48 89 cf 8b 49 10 31 db 85 c9 74 67 48 8b \
                               47 18 4c 8b 47 20 48 8b 15";

/// How many `getDotDamage` overrides [`PROCESS_DOT_SIG`] is expected to resolve to.
const DOT_OVERRIDE_COUNT: usize = 3;

/// Reads the per-tick damage (f32 at `out+0x10`) as an `i32`, or `None` when the
/// descriptor isn't readable or the value isn't a sane damage number.
fn read_dot_damage(out: *const usize) -> Option<i32> {
    let damage = crate::hooks::diag::read_f32_guarded(out as usize, 0x10)?;
    // The game itself truncates this float to an int before applying it.
    if !damage.is_finite() || damage < 0.0 || damage > i32::MAX as f32 {
        return None;
    }
    Some(damage as i32)
}

/// Reads the DoT type (i32 at `out+0x04`). The inherited no-damage base writes -1; callers
/// only reach this after a positive damage read, so clamp anything negative to 0.
fn read_dot_type(out: *const usize) -> u32 {
    // Unreadable reads 0, which is already the clamp target for the base class's -1.
    (crate::hooks::diag::read_u32_guarded(out as usize, 0x4) as i32).max(0) as u32
}

impl OnProcessDotHook {
    pub fn new(tx: event::Tx) -> Self {
        OnProcessDotHook { tx }
    }

    pub fn setup(&self, process: &Process) -> Result<()> {
        let addrs = process.search_match_addresses(PROCESS_DOT_SIG)?;

        #[cfg(feature = "console")]
        println!("Found {} process dot event entries", addrs.len());

        // MORE than three means the pattern started catching functions Ghidra never
        // verified. Detouring one transmutes it to this 2-arg signature, so re-calling the
        // original leaves r8/r9 unmarshalled in a callee that wanted them — the corruption
        // class that made sba_update write a negative gauge. Refuse: `try_step` logs FAIL
        // and every other hook still installs, which beats corrupting game state.
        if addrs.len() > DOT_OVERRIDE_COUNT {
            return Err(anyhow!(
                "process_dot: PROCESS_DOT_SIG matched {} entries, expected {DOT_OVERRIDE_COUNT} \
                 getDotDamage overrides — the pattern is over-broad and would detour unverified \
                 functions; re-derive it",
                addrs.len()
            ));
        }

        // FEWER is safe (every match is still a genuine hit of a very specific pattern),
        // just incomplete — one DoT type would stop reporting. Warn loudly instead.
        if addrs.len() < DOT_OVERRIDE_COUNT {
            log::warn!(
                "process_dot: expected {DOT_OVERRIDE_COUNT} getDotDamage overrides, found {} — \
                 DoT tracking is incomplete; re-derive PROCESS_DOT_SIG",
                addrs.len()
            );
        }

        // `retour`'s static detours are distinct statics, so each override needs its own.
        // The closure re-calls ITS OWN original and then emits from the shared `emit`.
        macro_rules! attach {
            ($detour:ident, $addr:expr) => {{
                let cloned_self = self.clone();
                unsafe {
                    let func: ProcessDotEventFunc = std::mem::transmute($addr);
                    $detour.initialize(func, move |status, out| {
                        let original_value = $detour.call(status, out);
                        cloned_self.emit(status, out);
                        original_value
                    })?;
                    $detour.enable()?;
                }
            }};
        }

        if let Some(&addr) = addrs.first() {
            attach!(ProcessDotEvent0, addr);
        }
        if let Some(&addr) = addrs.get(1) {
            attach!(ProcessDotEvent1, addr);
        }
        if let Some(&addr) = addrs.get(2) {
            attach!(ProcessDotEvent2, addr);
        }

        Ok(())
    }

    /// Emits one [`Message::DamageEvent`] for a DoT tick, called after the game's own
    /// `getDotDamage` has filled `out`.
    ///
    /// `status` is the `StatusBase` instance (e.g. `StatusAilmentPoison`), whose layout is
    /// unchanged from pre-2.0.2 and re-verified in the 2.0.2 decompilation:
    ///   * `+0x18` → target `CEntityInfo` (what is being damaged), actor at `+0x70`
    ///   * `+0x30` → source `CEntityInfo` (who applied the DoT), actor at `+0x70`
    ///   * `+0x50` → f32 remaining duration
    ///
    /// `out` is the descriptor the getter just wrote (see [`PROCESS_DOT_SIG`]).
    fn emit(&self, status: *const usize, out: *const usize) {
        // The getter is called for every ticking status including the ones whose base
        // implementation reports no damage, so drop zero/absent damage before doing any work.
        let dmg = match read_dot_damage(out) {
            Some(dmg) if dmg > 0 => dmg,
            _ => return,
        };
        let dot_type = read_dot_type(out);

        if !readable(status as usize, 0x58) {
            return;
        }

        // @TODO(false): There's a better way to check null pointers with Option type, but I'm too dumb to figure it out right now.
        let target_info = unsafe { status.byte_add(0x18).read() } as *const usize;
        let source_info = unsafe { status.byte_add(0x30).read() } as *const usize;

        if !readable(target_info as usize, 0x78) || !readable(source_info as usize, 0x78) {
            return;
        }

        let target = unsafe { target_info.byte_add(0x70).read() } as *const usize;
        let source = unsafe { source_info.byte_add(0x70).read() } as *const usize;

        // `actor_idx` raw-reads +0x170 and `actor_type_id` CALLS through the vtable slot at
        // +0x58 — a stale actor pointer there faults the game thread or jumps through
        // garbage. Null alone is not enough: prove the instance spans both offsets first.
        // This path only started running when the 2.0.2 signature fix made it resolve, so
        // it had never actually been exercised in the game before.
        const ACTOR_SPAN: usize = 0x174; // covers the vtable ptr at +0x00 and idx at +0x170
        if !readable(target as usize, ACTOR_SPAN) || !readable(source as usize, ACTOR_SPAN) {
            return;
        }

        let source_idx = actor_idx(source);
        let source_type_id = actor_type_id(source);

        let target_idx = actor_idx(target);
        let target_type_id = actor_type_id(target);

        let (source_parent_type_id, source_parent_idx) =
            super::player_keyed_parent(source_type_id, source_idx, source);

        let event = Message::DamageEvent(DamageEvent {
            source: Actor {
                index: source_idx,
                actor_type: source_type_id,
                parent_index: source_parent_idx,
                parent_actor_type: source_parent_type_id,
            },
            target: Actor {
                // Same per-spawn id scheme as the damage hook, so id-based
                // target filtering keeps a summon's DoT ticks with its hits.
                index: target_spawn_id(target as usize),
                actor_type: target_type_id,
                parent_index: target_idx,
                parent_actor_type: target_type_id,
            },
            damage: dmg,
            flags: 0,
            action_id: ActionType::DamageOverTime(dot_type),
            attack_rate: None,
            stun_value: None,
            damage_cap: None,
            base_damage: None,
            target_current_hp: None,
            target_max_hp: None,
        });

        let _ = self.tx.send(event);
    }
}

/// Per-spawn id for a TARGET actor, folded from its instance pointer. The
/// game's own actor index collapses sibling summons into one value (Lucilius'
/// three swords all report the same index across the whole fight), so the
/// instance pointer is the only stable discriminator between same-kind actors
/// alive at the same time. The low 4 bits are allocation-alignment zeros and
/// are dropped; the high half is folded in so pool-slab reuse at 4GB strides
/// still differs. A freed-and-reused instance CAN repeat an id for a later
/// spawn — the parser's respawn detection (HP jumping back to full) covers that.
fn target_spawn_id(instance: usize) -> u32 {
    ((instance >> 4) as u32) ^ ((instance >> 36) as u32)
}

/// The target's HP lives in its `ExHp` component, embedded at instance+0x150 (statically
/// derived for v2.0.2: `ExHp::RTTI_Base_Class_Descriptor_at_(336)` + the ProcessDamageEvent
/// decompile both pin the embed; the vtable getters read current at this+0x10 and max at
/// this+0x18 as 64-bit ints).
const TARGET_HP_PAIR_OFFSET: usize = 0x150 + 0x10;

/// Read the target's post-hit `(current, max)` HP pair, or `None` when the location isn't
/// readable or the values don't look like a live HP pool.
///
/// The two fields are adjacent 8-byte ints, so ONE 16-byte guard covers both. Two separate
/// `read_ptr_guarded` calls would add two `IsBadReadPtr` probes per hit to a path that runs
/// thousands of times a second on the game's own thread — per-call guard cost on this path
/// is what caused the v1.9.2 in-combat slowdown.
fn read_target_hp_pair(instance: usize) -> Option<(u64, u64)> {
    if instance == 0 {
        return None;
    }
    let addr = instance.wrapping_add(TARGET_HP_PAIR_OFFSET);
    if !readable(addr, 2 * std::mem::size_of::<u64>()) {
        return None;
    }
    let (current, max) = unsafe {
        (
            (addr as *const u64).read_unaligned(),
            ((addr + 8) as *const u64).read_unaligned(),
        )
    };
    sanitize_target_hp(Some(current), Some(max))
}

/// Validate a raw (current, max) HP pair read from the target's ExHp component.
/// Accepts the pair only when it plausibly IS one: both reads succeeded, the pool
/// is initialized (max > 0), current fits inside it, the magnitude is sane, and
/// the pair doesn't sit wholly inside the exe's image band.
///
/// The original 5e9 ceiling sat just under the exe image base (0x140000000 ≈
/// 5.37e9) so ANY pointer would fail it — but hard-mode v2.0.2 bosses sail past
/// it (Lucilius ~7.5e9) and silently lost HP capture entirely. The ceiling now
/// leaves generous headroom; pointer rejection instead targets the two sources
/// directly: heap/ASLR'd-module addresses are all far above the ceiling, and
/// image pointers (vtable/function slots — what a shifted offset would most
/// likely read) are rejected as a pair via the image band below.
fn sanitize_target_hp(current: Option<u64>, max: Option<u64>) -> Option<(u64, u64)> {
    const MAX_PLAUSIBLE_HP: u64 = 100_000_000_000;
    /// granblue_fantasy_relink.exe loads at its preferred base 0x140000000;
    /// pointers into the image land in this band. A real HP pair only overlaps
    /// it while a 5.4e9+ pool is still near full — dropping those few reports
    /// beats letting a vtable-slot pair through as HP.
    const IMAGE_BAND: std::ops::Range<u64> = 0x1_4000_0000..0x1_8000_0000;
    let (current, max) = (current?, max?);
    let looks_like_image_pointers = IMAGE_BAND.contains(&current) && IMAGE_BAND.contains(&max);
    (max > 0 && current <= max && max < MAX_PLAUSIBLE_HP && !looks_like_image_pointers)
        .then_some((current, max))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The ExHp reads are raw memory on an offset that will silently shift on a
    /// future patch — reject anything that doesn't look like a live HP pair so
    /// garbage can never reach the parser as real HP.
    #[test]
    fn sanitize_target_hp_accepts_only_plausible_pairs() {
        // Ordinary mid-fight value.
        assert_eq!(
            sanitize_target_hp(Some(49_000_000), Some(50_000_000)),
            Some((49_000_000, 50_000_000))
        );
        // Death (current 0) is valid.
        assert_eq!(
            sanitize_target_hp(Some(0), Some(50_000_000)),
            Some((0, 50_000_000))
        );
        // Full HP is valid.
        assert_eq!(sanitize_target_hp(Some(500), Some(500)), Some((500, 500)));
        // Hard-mode v2.0.2 boss scale (Lucilius ~7.5e9) must pass — the old
        // 5e9 ceiling silently dropped HP capture for these fights.
        assert_eq!(
            sanitize_target_hp(Some(7_400_000_000), Some(7_500_000_000)),
            Some((7_400_000_000, 7_500_000_000))
        );
        // A pool whose max lands inside the image band is still accepted once
        // current has fallen below the band — only pointer-LIKE PAIRS reject.
        assert_eq!(
            sanitize_target_hp(Some(5_000_000_000), Some(5_500_000_000)),
            Some((5_000_000_000, 5_500_000_000))
        );

        // A failed guarded read on either side -> None.
        assert_eq!(sanitize_target_hp(None, Some(50_000_000)), None);
        assert_eq!(sanitize_target_hp(Some(49_000_000), None), None);
        // Zero max = uninitialized component -> None.
        assert_eq!(sanitize_target_hp(Some(0), Some(0)), None);
        // current > max = not an HP pair -> None.
        assert_eq!(sanitize_target_hp(Some(51_000_000), Some(50_000_000)), None);
        // A pair of exe-image pointers (vtable slots at a shifted offset) -> None.
        assert_eq!(
            sanitize_target_hp(Some(0x1_4000_0000), Some(0x1_4000_0000)),
            None
        );
        assert_eq!(
            sanitize_target_hp(Some(0x1_4012_3450), Some(0x1_4567_89A0)),
            None
        );
        // Heap / ASLR'd-module addresses -> None (above the ceiling).
        assert_eq!(
            sanitize_target_hp(Some(0x7FF6_0000_0000), Some(0x7FF6_0000_0008)),
            None
        );
    }
}
