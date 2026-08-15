//! Read-time interpretation of the raw per-hit snapshots the hook records,
//! and the per-hit damage FACTS (crit, weak point, back attack, debuffed,
//! Overdrive, Break) derived from them — measured where the snapshot vouches
//! for itself, inferred where it cannot, Unknown otherwise. Assembled per
//! read like `assemble_chart_windows`; the parser fold never changes.

/// Game offset of the snapshot window's first byte, and its exact length.
/// MUST match the hook's `INSTANCE_SNAPSHOT_START`/`INSTANCE_SNAPSHOT_LEN`
/// (src-hook/src/hooks/damage.rs) and the frontend's
/// `src/pages/logs/view/events/damageSnapshot.ts` — three copies of one
/// fact, each documented with this cross-reference.
pub const SNAPSHOT_BASE: usize = 0xC0;
pub const SNAPSHOT_LEN: usize = 0x340 - 0xC0;

/// The seven gate bytes, by their game offset (v2.0.4, damage-head RE).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GateByte {
    Crit,       // +0x15D — attacker-side roll
    WeakPoint,  // +0x15E — part-id flag
    BackAttack, // +0x15F — <90° angle
    VulnAction, // +0x160 — authored vulnerable-action window
    Debuffed,   // +0x161 — target holds a debuff (Injury to Insult's gate)
    Overdrive,  // +0x162 — target mode
    Break,      // +0x163 — target mode
}

impl GateByte {
    pub const ALL: [GateByte; 7] = [
        GateByte::Crit,
        GateByte::WeakPoint,
        GateByte::BackAttack,
        GateByte::VulnAction,
        GateByte::Debuffed,
        GateByte::Overdrive,
        GateByte::Break,
    ];
    fn offset(self) -> usize {
        match self {
            GateByte::Crit => 0x15D,
            GateByte::WeakPoint => 0x15E,
            GateByte::BackAttack => 0x15F,
            GateByte::VulnAction => 0x160,
            GateByte::Debuffed => 0x161,
            GateByte::Overdrive => 0x162,
            GateByte::Break => 0x163,
        }
    }
}

/// A parsed snapshot. Borrowing, not copying: one per damage event per read.
///
/// Snapshots from the damage-TAKEN stream only prove bytes up to +0x2D8 (the
/// apply path builds its instance on the stack) — tail bytes past that must
/// not be read without checking the stream; the gate bytes and both
/// `builder_populated` fields sit inside the proven span, so this interpreter
/// is unaffected.
pub struct InstSnapshot<'a>(&'a [u8]);

impl<'a> InstSnapshot<'a> {
    /// Exact-length blobs only: a future hook changing the window changes the
    /// length, and interpreting a differently-sized blob with THIS offset map
    /// would read neighbours as gate bytes.
    pub fn parse(blob: Option<&'a [u8]>) -> Option<Self> {
        blob.filter(|b| b.len() == SNAPSHOT_LEN).map(Self)
    }
    fn u32_at(&self, game_offset: usize) -> u32 {
        let at = game_offset - SNAPSHOT_BASE;
        u32::from_le_bytes(self.0[at..at + 4].try_into().unwrap())
    }
    pub fn gate(&self, byte: GateByte) -> bool {
        self.0[byte.offset() - SNAPSHOT_BASE] != 0
    }
    /// Whether the DamageInstance BUILDER ran for this hit — d0 (+0xD0) or
    /// precap (+0x2D4) nonzero. Remote players' hits arrive deserialized with
    /// both zero (online log 405), so their gate bytes may mean "not computed
    /// here" rather than "no": only a populated snapshot's bytes are MEASURED.
    pub fn builder_populated(&self) -> bool {
        self.u32_at(0xD0) != 0 || self.u32_at(0x2D4) != 0
    }
}

/// One fact about one hit, with its provenance.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fact {
    MeasuredYes,
    MeasuredNo,
    InferredYes,
    InferredNo,
    Unknown,
}

impl Fact {
    pub fn measured(yes: bool) -> Self {
        if yes {
            Fact::MeasuredYes
        } else {
            Fact::MeasuredNo
        }
    }
    pub fn inferred(yes: bool) -> Self {
        if yes {
            Fact::InferredYes
        } else {
            Fact::InferredNo
        }
    }
}

/// The six facts for one damage event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HitFacts {
    pub crit: Fact,
    pub weak_point: Fact,
    pub back_attack: Fact,
    pub debuffed: Fact,
    pub overdrive: Fact,
    pub break_mode: Fact,
}

impl Default for HitFacts {
    fn default() -> Self {
        Self {
            crit: Fact::Unknown,
            weak_point: Fact::Unknown,
            back_attack: Fact::Unknown,
            debuffed: Fact::Unknown,
            overdrive: Fact::Unknown,
            break_mode: Fact::Unknown,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blob_with(entries: &[(usize, &[u8])]) -> Vec<u8> {
        let mut blob = vec![0u8; SNAPSHOT_LEN];
        for (game_offset, bytes) in entries {
            let at = game_offset - SNAPSHOT_BASE;
            blob[at..at + bytes.len()].copy_from_slice(bytes);
        }
        blob
    }

    #[test]
    fn gate_bytes_read_from_their_documented_offsets() {
        let blob = blob_with(&[
            (0x15D, &[1]), // crit
            (0x15F, &[1]), // back attack
            (0x163, &[1]), // break
            (0xD0, &1000u32.to_le_bytes()),
        ]);
        let snap = InstSnapshot::parse(Some(&blob)).expect("well-formed");
        assert!(snap.gate(GateByte::Crit));
        assert!(!snap.gate(GateByte::WeakPoint));
        assert!(snap.gate(GateByte::BackAttack));
        assert!(snap.gate(GateByte::Break));
        assert!(snap.builder_populated());
    }

    /// Every gate byte reads from its own documented offset and no other:
    /// setting exactly one byte lights exactly one variant, so an
    /// adjacent-byte transposition inside `offset()` cannot pass silently.
    #[test]
    fn each_gate_byte_reads_its_own_offset_alone() {
        for (i, byte) in GateByte::ALL.iter().enumerate() {
            let blob = blob_with(&[(0x15D + i, &[1][..])]);
            let snap = InstSnapshot::parse(Some(&blob)).expect("well-formed");
            for other in GateByte::ALL {
                assert_eq!(
                    snap.gate(other),
                    other == *byte,
                    "{other:?} vs set byte {byte:?}"
                );
            }
        }
    }

    #[test]
    fn a_remote_style_snapshot_is_not_builder_populated() {
        // d0 == 0 and precap == 0.0 — the log-405 remote signature.
        let blob = blob_with(&[(0x15D, &[1])]);
        let snap = InstSnapshot::parse(Some(&blob)).expect("well-formed");
        assert!(!snap.builder_populated());
    }

    #[test]
    fn short_absent_or_oversized_blobs_parse_to_none() {
        assert!(InstSnapshot::parse(None).is_none());
        assert!(InstSnapshot::parse(Some(&[0u8; 16])).is_none());
        assert!(InstSnapshot::parse(Some(&vec![0u8; SNAPSHOT_LEN + 4])).is_none());
    }
}
