use std::ffi::CString;

// v2.0.2 (Endless Ragnarok) layout, re-derived from the Ghidra decompile of
// process_damage (FUN_141fbd440) cross-checked against live dmgdiag dumps:
//   0xD0  shared per-action damage value (i32) — the SAME number appears here on the
//         main hit and its supplementary hit, and matches neither on-screen number.
//         (Earlier session called this "final damage, live-verified" — that was wrong;
//         the values merely coincided in that test.)
//   0xD4  FINAL displayed damage (i32) — live-verified 2026-07-11: exactly matches the
//         in-game hit numbers on both the main hit (111348 = cap 92790 × 1.2 crit) and
//         its supplementary hit (44539), while 0xD0 read 212736 for both. Post-cap,
//         post-crit.
//   0xD8  f32 rate, 0xDC f32 rate — a pair of attack-rate floats (skill 212 shows 16.17
//         at 0xDC, its known attack rate). The OLD code read `flags` here, so link/SBA
//         classification was reading float bit patterns (usually 0 for the tested bits).
//   0xE8  flags (u64) — the real bitfield; the game tests bits 55, 39, 24 here.
//   0xF0  attack-class flags (u32) — a DIFFERENT bitfield from 0xE8. The cap
//         builder reads it to pick which of the record's three cap-up fields
//         applies: 0x40000 = Skybound Art, 0x10000 = Skill, neither = Normal.
//         Same offset `cap_oracle.rs` reads as INSTANCE_CLASS_FLAGS.
//   0x16C action_id (was 0x154; confirmed live: IDs match ui.json)
//   0x2B8 damage floor (i32, -1 = none)
//   0x2BC damage cap (i32, was 0x264; -1 is normalized to 99,999,999 = "no cap");
//         live values scale with skill strength (104k @ rate 1.0 … 2.0M @ rate 16.17)
//   0x2D4 pre-cap base damage stored as f32 (uncapped damage IS recoverable in v2.0.2)
#[derive(Debug)]
#[repr(C)]
pub struct DamageInstance {
    padding_00: [u8; 0xD4], // 0x00 - 0xD4 (0xD0 = shared per-action value, see above)
    pub damage: i32,        // 0xD4 final displayed damage
    padding_d8: [u8; 0x04], // 0xD8 rate float
    pub attack_rate: f32,   // 0xDC
    padding_e0: [u8; 0x08], // 0xE0 - 0xE8
    pub flags: u64,         // 0xE8
    pub class_flags: u32,   // 0xF0 attack class; see the header comment
    padding_f4: [u8; 0x78], // 0xF4 - 0x16C
    pub action_id: u32,     // 0x16C
    padding_170: [u8; 0x14C], // 0x170 - 0x2BC
    pub damage_cap: i32,    // 0x2BC
    padding_2c0: [u8; 0x14], // 0x2C0 - 0x2D4
    pub base_damage: f32,   // 0x2D4 pre-cap base damage (uncapped); capped <=> base > cap
}

/// v2.0.2 (Endless Ragnarok) layout. The base pointer is the quest manager
/// singleton itself (`OnLoadQuestState`'s a1) — the pre-2.0 `a1+0x1D8`
/// sub-struct is gone, so every field below is an offset from the manager.
///
/// `quest_id` @ +0xDC8 is Ghidra-confirmed (the hooked loader reads
/// `*(uint*)(rcx + 0xdc8)` and FNV-1a-hashes it for the quest-table lookup).
///
/// `elapsed_time` @ +0xAC8 is the in-game quest timer (IGT), the same number
/// the result screen shows as the clear time. Pre-2.0 it was +0x64C *within*
/// the old sub-struct; when the base was rebased to the manager that relative
/// offset was kept by mistake, so the hook had been reading mgr+0x1414 (a
/// constant 1). The 2026-07-15 diag scan could not have caught it: it swept
/// forward from the old base (mgr+0xDC8), and the real field sits 0x300 bytes
/// *before* that.
#[derive(Debug, Clone, Copy)]
#[repr(C)]
pub struct QuestState {
    padding_00: [u8; 0xAC8], // 0x000 - 0xAC8
    /// In-game quest timer in whole seconds; frozen once the quest ends.
    pub elapsed_time: u32, // 0xAC8
    padding_acc: [u8; 0x10], // 0xACC - 0xADC
    /// Quest-complete latch: 0 while playing, 1 once the quest ends and the
    /// clear time above is final. Reset to 0 on the next quest load.
    pub freeze_flag: u8, // 0xADC
    padding_add: [u8; 0x2EB], // 0xADD - 0xDC8
    pub quest_id: u32,       // 0xDC8
}

/// Offset of [`QuestState::elapsed_time`] from the quest manager, for the
/// guarded per-frame read that does not want a full struct copy.
pub const QUEST_ELAPSED_TIME_OFFSET: usize = 0xAC8;
/// Offset of [`QuestState::quest_id`] from the quest manager.
pub const QUEST_ID_OFFSET: usize = 0xDC8;

#[derive(Debug)]
#[repr(C)]
pub struct SigilEntry {
    pub first_trait_id: u32,
    pub first_trait_level: u32,
    pub second_trait_id: u32,
    pub second_trait_level: u32,
    pub sigil_id: u32,
    pub equipped_character: u32,
    pub sigil_level: u32,
    pub acquisition_count: u32,
    pub notification_enum: u32,
}

#[derive(Debug)]
#[repr(C)]
pub struct SigilList {
    pub sigils: [SigilEntry; 12], // 0x00
    unk_1b0: u32,                 //0x01B0
    unk_1b4: u32,                 //0x01B4
    unk_1b8: u32,                 //0x01B8
    unk_1bc: u32,                 //0x01BC
    unk_1c0: u32,                 //0x01C0
    unk_1c4: u32,                 //0x01C4
    /// 0 == local, 1 == online
    pub is_online: u32, //0x01C8
    unk_1cc: u32,                 //0x01CC
    unk_1d0: u32,                 //0x01D0
    unk_1d4: u32,                 //0x01D4
    unk_1d8: u32,                 //0x01D8
    unk_1dc: u32,                 //0x01DC
    unk_1e0: u32,                 //0x01E0
    unk_1e4: u32,                 //0x01E4
    pub character_name: [u8; 16], //0x01E8
    padding_1f8: [u8; 16],        //0x01F8
    pub display_name: [u8; 16],   //0x0208
    padding_218: [u8; 20],        //0x0218
    pub party_index: u32,         //0x022C
}

#[derive(Debug)]
#[repr(C)]
pub struct PlayerStats {
    pub level: u32,
    pub total_health: u32,
    pub total_attack: u32,
    pub unk_0c: u32,
    pub stun_power: f32,
    pub critical_rate: f32,
    pub total_power: u32,
}

#[derive(Debug)]
#[repr(C)]
pub struct WeaponInfo {
    unk_00: u32,
    /// Weapon ID Hash
    pub weapon_id: u32,
    pub weapon_ap_tree: u32,
    unk_0c: u32,
    pub weapon_exp: u32,
    /// How many uncap stars the weapon has
    pub star_level: u32,
    /// Number of plus marks on the weapon
    pub plus_marks: u32,
    /// Weapon's awakening level
    pub awakening_level: u32,
    /// First trait ID
    pub trait_1_id: u32,
    /// First trait level
    pub trait_1_level: u32,
    /// Second trait ID
    pub trait_2_id: u32,
    /// Second trait level
    pub trait_2_level: u32,
    /// Third trait ID
    pub trait_3_id: u32,
    /// Third trait level
    pub trait_3_level: u32,
    /// Wrightstone used on the weapon
    pub wrightstone_id: u32,
    unk_3c: u32,
    /// Current weapon level
    pub weapon_level: u32,
    /// Weapon's HP Stats (before plus marks)
    pub weapon_hp: u32,
    /// Weapon's Attack Stats (before plus marks)
    pub weapon_attack: u32,
}

#[derive(Debug)]
#[repr(C)]
pub struct Overmastery {
    /// Overmastery Stats ID type
    pub id: u32,
    /// Flags
    pub flags: u32,
    unk_08: u32,
    /// Value for the overmastery
    pub value: f32,
}

#[derive(Debug)]
#[repr(C)]
pub struct Overmasteries {
    pub stats: [Overmastery; 4],
}

pub struct VBuffer(pub *const usize);

impl VBuffer {
    pub fn ptr(&self) -> *const usize {
        if self.max_size() > 0xf {
            unsafe { self.0.read() as *const usize }
        } else {
            self.0
        }
    }

    fn used_size(&self) -> usize {
        unsafe { self.0.byte_add(0x10).read() }
    }

    fn max_size(&self) -> usize {
        unsafe { self.0.byte_add(0x18).read() }
    }

    pub fn raw(&self) -> CString {
        let bytes =
            unsafe { std::slice::from_raw_parts(self.ptr() as *const u8, self.used_size()) };

        unsafe { CString::from_vec_unchecked(bytes.to_vec()) }
    }

    /// Bounds-checked read for use on snapshots that come straight from game
    /// memory (e.g. the 2.0.2 identity path), where a wrong offset could otherwise
    /// hand `raw()` a garbage length/pointer. Rejects implausible sizes and any
    /// non-UTF-8 / interior-NUL content, returning `None` instead of reading junk.
    pub fn checked_raw(&self) -> Option<CString> {
        let used_size = self.checked_len()?;
        let bytes = unsafe { std::slice::from_raw_parts(self.ptr() as *const u8, used_size) };
        CString::new(bytes).ok()
    }

    /// The validated length of the buffer's contents — every check
    /// [`checked_raw`] applies, without building the `CString`.
    ///
    /// Exists because the identity resolution behind player attribution only
    /// needs to know whether a name is PRESENT, and it runs on a game thread
    /// per damage event and per status application. Allocating a string to test
    /// it for emptiness put that churn on the hot path.
    pub fn checked_len(&self) -> Option<usize> {
        const MAX_PLAYER_NAME_BYTES: usize = 0x100;

        let used_size = self.used_size();
        let max_size = self.max_size();

        if used_size > MAX_PLAYER_NAME_BYTES || max_size < used_size || max_size > 0x1000 {
            return None;
        }

        let bytes_ptr = self.ptr() as *const u8;
        if bytes_ptr.is_null() {
            return None;
        }

        // The out-of-line path follows a heap pointer embedded in game memory;
        // plausible sizes don't make it a valid pointer, so probe before reading.
        if used_size > 0 && !crate::hooks::diag::readable(bytes_ptr as usize, used_size) {
            return None;
        }

        let bytes = unsafe { std::slice::from_raw_parts(bytes_ptr, used_size) };
        std::str::from_utf8(bytes).ok()?;
        // `CString::new` rejects an interior NUL, so this must too — otherwise
        // the length path would accept names `checked_raw` turns away.
        if bytes.contains(&0) {
            return None;
        }
        Some(used_size)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The exact non-pointer value the 2026-07-18 crash dump showed being
    // dereferenced (two adjacent u32s 0x5b0/0x5b1 read as a "pointer");
    // unmapped in any normal process.
    const UNMAPPED_PTR: usize = 0x0000_05b1_0000_05b0;

    #[test]
    fn checked_raw_rejects_unmapped_heap_buffer() {
        // A string header whose sizes pass the plausibility checks but whose
        // heap pointer (max_size > 0xf selects the out-of-line path) is garbage.
        let header: Box<[usize; 4]> = Box::new([UNMAPPED_PTR, 0, 8, 0x20]);
        let vbuffer = VBuffer(header.as_ptr() as *const usize);
        assert!(vbuffer.checked_raw().is_none());
    }

    /// Pin the quest-manager offsets. `elapsed_time` is the DPS denominator's
    /// source, and the struct's leading padding makes a silent drift easy —
    /// the pre-fix build read the timer 0x94C bytes past its real home.
    #[test]
    fn quest_state_field_offsets() {
        use std::mem::offset_of;
        assert_eq!(
            offset_of!(QuestState, elapsed_time),
            QUEST_ELAPSED_TIME_OFFSET
        );
        assert_eq!(offset_of!(QuestState, elapsed_time), 0xAC8);
        assert_eq!(offset_of!(QuestState, freeze_flag), 0xADC);
        assert_eq!(offset_of!(QuestState, quest_id), QUEST_ID_OFFSET);
        assert_eq!(offset_of!(QuestState, quest_id), 0xDC8);
    }

    // `checked_len` is the acceptance half of `checked_raw` with the allocation
    // removed, so the two must agree on every input or the identity fast path
    // would accept snapshots the slow path rejects.
    #[test]
    fn checked_len_agrees_with_checked_raw_on_an_inline_buffer() {
        let mut header: Box<[usize; 4]> = Box::new([0, 0, 4, 0xf]);
        header[0] = usize::from_le_bytes(*b"Gran\0\0\0\0");
        let vbuffer = VBuffer(header.as_ptr() as *const usize);
        assert_eq!(vbuffer.checked_len(), Some(4));
    }

    #[test]
    fn checked_len_agrees_with_checked_raw_on_an_unmapped_buffer() {
        let header: Box<[usize; 4]> = Box::new([UNMAPPED_PTR, 0, 8, 0x20]);
        let vbuffer = VBuffer(header.as_ptr() as *const usize);
        assert!(vbuffer.checked_raw().is_none());
        assert_eq!(vbuffer.checked_len(), None);
    }

    #[test]
    fn checked_len_reports_zero_for_an_empty_name() {
        // The identity path treats an empty name as "not resolvable yet", so
        // this must be a clean Some(0) and not confusable with a rejection.
        let header: Box<[usize; 4]> = Box::new([0, 0, 0, 0xf]);
        let vbuffer = VBuffer(header.as_ptr() as *const usize);
        assert_eq!(vbuffer.checked_len(), Some(0));
    }

    #[test]
    fn checked_raw_reads_inline_buffer() {
        // max_size <= 0xf keeps the bytes inline in the header itself.
        let mut header: Box<[usize; 4]> = Box::new([0, 0, 4, 0xf]);
        header[0] = usize::from_le_bytes(*b"Gran\0\0\0\0");
        let vbuffer = VBuffer(header.as_ptr() as *const usize);
        assert_eq!(
            vbuffer
                .checked_raw()
                .expect("inline name must resolve")
                .as_bytes(),
            b"Gran"
        );
    }

    /// The struct reaches its fields by padding arithmetic, so a miscounted
    /// pad silently shifts every field after it and the hook reads a
    /// neighbouring value with no error anywhere. This pins the three offsets
    /// the cap work depends on against the decompile.
    ///
    /// It proves the arithmetic, NOT the offsets: those are v2.0.4 facts that
    /// only a live run can confirm. A failure here means the padding is wrong —
    /// fix the padding, never the assertion.
    #[test]
    fn damage_instance_fields_sit_at_their_documented_offsets() {
        use std::mem::offset_of;
        assert_eq!(offset_of!(DamageInstance, class_flags), 0xF0);
        assert_eq!(offset_of!(DamageInstance, action_id), 0x16C);
        assert_eq!(offset_of!(DamageInstance, damage_cap), 0x2BC);
        // The two fields the cap card reads either side of the clamp.
        assert_eq!(offset_of!(DamageInstance, damage), 0xD4);
        assert_eq!(offset_of!(DamageInstance, base_damage), 0x2D4);
    }
}
