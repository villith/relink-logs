//! Read-time interpretation of the raw per-hit snapshots the hook records,
//! and the per-hit damage FACTS (crit, weak point, back attack, debuffed,
//! Overdrive, Break) derived from them — measured where the snapshot vouches
//! for itself, inferred where it cannot, Unknown otherwise. Assembled per
//! read like `assemble_chart_windows`; the parser fold never changes.
//!
//! [`assemble_hit_facts`] is the entry point: one [`HitFacts`] per
//! `Message::DamageEvent` in the raw log, `None` everywhere else, aligned by
//! POSITION with the log it was built from — `aggregate_groups` (Task 7)
//! indexes into this by the same position, so the index alignment is a
//! contract, not an implementation detail.
//!
//! A populated snapshot (`InstSnapshot::builder_populated`) is MEASURED and
//! needs nothing else. An unpopulated or absent snapshot — the remote-player
//! case — falls back to INFERENCE, one fact family at a time:
//!
//! - `overdrive` / `break_mode`: a running per-enemy mode map, fed by
//!   `Message::EnemyMode` in stream order, keyed on the same actor index a
//!   damage event's `target.parent_index` names. A target this walk has
//!   never seen in a mode event answers `Unknown` for both, never a guess.
//! - `debuffed`: NOT inferred, on purpose. The game's own harmful/beneficial
//!   flag (`status.tbl`'s `PositiveStatusOrNegativeStatus`) exists only as
//!   `src/pages/logs/view/metrics/statusPolarity.ts` — a frontend-only,
//!   TypeScript-generated table (`scripts/gen-status-polarity.py`). Neither
//!   `protocol::StatusApplyEvent`/`StatusRemoveEvent` nor any
//!   `src-tauri/assets/*.json` carries that flag Rust-side, so this module
//!   has no honest way to tell a beneficial status from a harmful one. An
//!   "any status held = debuffed" approximation would misfile every buff
//!   uptime effect (e.g. an attack buff) as a debuff, which is worse than
//!   admitting the unknown — so `debuffed` stays `Unknown` for every
//!   unpopulated hit. Revisit only if the polarity table (or an equivalent)
//!   ships as a Rust-side asset.
//! - `crit`: a SECOND PASS after the walk, over damage events whose crit is
//!   still `Unknown`, grouped by `(source.parent_index, action_id)` — full
//!   `ActionType`, so a `SupplementaryDamage`/`DamageOverTime` id never joins
//!   a `Normal` group of the same numeric id. Those two action kinds are
//!   excluded from clustering entirely: their damage is not a fresh roll, so
//!   a crit read from their spread would be meaningless. Within a group,
//!   damages are sorted and split at the largest adjacent RATIO gap; the
//!   split is accepted only inside the guardrails documented on
//!   [`MIN_TOTAL_HITS`]/[`MIN_CLUSTER_HITS`]/[`CRIT_RATIO_MIN`]/[`CRIT_RATIO_MAX`].
//!   A capped remote hit (its cap is unknown, since remotes don't carry a
//!   populated snapshot) can pile many hits at one identical value and
//!   *look* like a cluster boundary; the ratio band is what keeps that from
//!   being misread as a crit split — live gate (b) is the validation this
//!   heuristic still needs. A rejected or ambiguous split resolves every hit
//!   in the group to `Unknown` — never a guess. Two other surfaces can still
//!   mis-accept in-band: (a) a multi-part action with two authored damage
//!   tiers (e.g. a hit-then-finisher skill) landing at an in-band ratio
//!   (1.3–3.5, ≥2 hits on each tier) reads as a crit split when it is really
//!   two non-crit tiers; (b) the group key deliberately omits the TARGET, so
//!   cross-target defense differences or a buff window that opens mid-group
//!   can manufacture in-band bimodality inside one `(source, action)` group
//!   that has nothing to do with crit.

use std::collections::HashMap;

use protocol::{ActionType, DamageEvent, Message};

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

/// Minimum group size before a crit split is even attempted. Below this, two
/// or three same-value hits are as likely to be coincidence as a real crit
/// bimodal — not enough signal to split on.
pub const MIN_TOTAL_HITS: usize = 8;

/// Minimum size for EACH side of a split. A "cluster" of one hit is a
/// singleton, not a distribution — accepting it would let one lucky hit turn
/// the whole group's crit read into a guess.
pub const MIN_CLUSTER_HITS: usize = 2;

/// Lower bound on `mean(high) / mean(low)` for an accepted split. Crit
/// multipliers in this game are never below 1.35x, so a gap smaller than this
/// is ordinary damage variance, not a crit boundary; the 0.05 of headroom
/// below 1.35 absorbs ordinary variance pulling the two cluster means
/// slightly together.
pub const CRIT_RATIO_MIN: f64 = 1.3;

/// Upper bound on `mean(high) / mean(low)` for an accepted split. The
/// one-sided (non-crit) damage variance measured live tops out around 1.05x;
/// a gap past 3.5x is more likely a multi-part-MV action (several differently
/// weighted hits under one action id) than a crit split, so it is rejected
/// rather than misread.
pub const CRIT_RATIO_MAX: f64 = 3.5;

/// One [`HitFacts`] per `Message::DamageEvent` in `raw_event_log`, `None`
/// everywhere else — aligned by POSITION with the log passed in. See the
/// module doc for the measured/inferred resolution order.
pub fn assemble_hit_facts(raw_event_log: &[(i64, Message)]) -> Vec<Option<HitFacts>> {
    let mut facts: Vec<Option<HitFacts>> = Vec::with_capacity(raw_event_log.len());
    // Per-enemy: the last mode this actor was seen in, by `EnemyModeEvent`'s
    // own actor index — the same index a damage event's `target.parent_index`
    // names for that enemy.
    let mut mode_by_actor: HashMap<u32, u32> = HashMap::new();
    // Damage events whose crit is still `Unknown` after the first pass,
    // grouped by `(source.parent_index, action_id)` as candidates for the
    // ratio-gap split — the index into `facts` alongside each damage value.
    let mut crit_candidates: HashMap<(u32, ActionType), Vec<(usize, f64)>> = HashMap::new();

    for (_ts, message) in raw_event_log {
        match message {
            Message::EnemyMode(event) => {
                mode_by_actor.insert(event.actor_index, event.mode);
                facts.push(None);
            }
            Message::DamageEvent(event) => {
                let hit_facts = resolve_hit_facts(event, &mode_by_actor);
                let index = facts.len();
                facts.push(Some(hit_facts));
                if hit_facts.crit == Fact::Unknown
                    // A non-positive damage value (a miss recorded as 0, a
                    // heal, a data glitch) is not a real roll and must never
                    // enter a cluster: left in, it drags a cluster's mean
                    // down without dragging its ratio search away from it,
                    // which can pull an otherwise-flat group's mean ratio
                    // into the accept band.
                    && event.damage > 0
                    && !matches!(
                        event.action_id,
                        ActionType::SupplementaryDamage(_) | ActionType::DamageOverTime(_)
                    )
                {
                    crit_candidates
                        .entry((event.source.parent_index, event.action_id))
                        .or_default()
                        .push((index, event.damage as f64));
                }
            }
            _ => facts.push(None),
        }
    }

    for hits in crit_candidates.into_values() {
        if let Some((low, high)) = split_crit_cluster(&hits) {
            for (index, _) in low {
                if let Some(hit_facts) = facts[index].as_mut() {
                    hit_facts.crit = Fact::InferredNo;
                }
            }
            for (index, _) in high {
                if let Some(hit_facts) = facts[index].as_mut() {
                    hit_facts.crit = Fact::InferredYes;
                }
            }
        }
    }

    facts
}

/// One damage event's facts: measured from a populated snapshot, or inferred
/// (mode only — see the module doc for why `debuffed` is not) from the
/// running state built up so far. Crit is left `Unknown` here even for
/// unpopulated hits — the ratio-gap split runs as a second pass, since it
/// needs every hit in the group collected first.
fn resolve_hit_facts(event: &DamageEvent, mode_by_actor: &HashMap<u32, u32>) -> HitFacts {
    if let Some(snap) = InstSnapshot::parse(event.instance_snapshot.as_deref()) {
        if snap.builder_populated() {
            return HitFacts {
                crit: Fact::measured(snap.gate(GateByte::Crit)),
                weak_point: Fact::measured(snap.gate(GateByte::WeakPoint)),
                back_attack: Fact::measured(snap.gate(GateByte::BackAttack)),
                debuffed: Fact::measured(snap.gate(GateByte::Debuffed)),
                overdrive: Fact::measured(snap.gate(GateByte::Overdrive)),
                break_mode: Fact::measured(snap.gate(GateByte::Break)),
            };
        }
    }

    let mut facts = HitFacts::default();
    if let Some(&mode) = mode_by_actor.get(&event.target.parent_index) {
        facts.overdrive = Fact::inferred(mode == protocol::EnemyModeEvent::MODE_OVERDRIVE);
        facts.break_mode = Fact::inferred(mode == protocol::EnemyModeEvent::MODE_BREAK);
    }
    // `debuffed` stays `Unknown` — see the module doc's "not inferred" note.
    facts
}

/// Splits one crit-candidate group's `(facts index, damage)` pairs into
/// (low, high) clusters at the largest adjacent ratio gap, or `None` if the
/// split fails any guardrail — see [`MIN_TOTAL_HITS`], [`MIN_CLUSTER_HITS`],
/// [`CRIT_RATIO_MIN`], [`CRIT_RATIO_MAX`].
fn split_crit_cluster(hits: &[(usize, f64)]) -> Option<(Vec<(usize, f64)>, Vec<(usize, f64)>)> {
    if hits.len() < MIN_TOTAL_HITS {
        return None;
    }

    let mut sorted = hits.to_vec();
    sorted.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());

    // The index of the last element of the low cluster, at the largest
    // adjacent ratio.
    let mut split_at = 0;
    let mut max_ratio = f64::MIN;
    for i in 0..sorted.len() - 1 {
        let (_, low) = sorted[i];
        let (_, high) = sorted[i + 1];
        if low <= 0.0 {
            continue;
        }
        let ratio = high / low;
        if ratio > max_ratio {
            max_ratio = ratio;
            split_at = i;
        }
    }

    let low = &sorted[..=split_at];
    let high = &sorted[split_at + 1..];
    if low.len() < MIN_CLUSTER_HITS || high.len() < MIN_CLUSTER_HITS {
        return None;
    }

    let mean = |xs: &[(usize, f64)]| xs.iter().map(|(_, v)| v).sum::<f64>() / xs.len() as f64;
    let ratio = mean(high) / mean(low);
    if !(CRIT_RATIO_MIN..=CRIT_RATIO_MAX).contains(&ratio) {
        return None;
    }

    Some((low.to_vec(), high.to_vec()))
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

    // -- assemble_hit_facts -------------------------------------------------

    use protocol::{Actor, DamageEvent, EnemyModeEvent, LinkTimeEvent};

    const PLAYER_HASH: u32 = 0x28AC_1108;

    /// A minimal hit from party slot `source_index` onto enemy actor
    /// `target_index` (its own parent, i.e. not a summon/pet body). No
    /// snapshot by default — callers attach one for the measured-path tests.
    fn hit(source_index: u32, target_index: u32, action: ActionType, damage: i32) -> DamageEvent {
        DamageEvent {
            source: Actor {
                index: source_index,
                actor_type: PLAYER_HASH,
                parent_index: source_index,
                parent_actor_type: PLAYER_HASH,
            },
            target: Actor {
                index: target_index,
                actor_type: 0xE000_0000 | target_index,
                parent_index: target_index,
                parent_actor_type: 0xE000_0000 | target_index,
            },
            damage,
            flags: 0,
            action_id: action,
            attack_rate: None,
            stun_value: None,
            damage_cap: None,
            base_damage: None,
            target_current_hp: None,
            target_max_hp: None,
            class_flags: None,
            source_current_hp: None,
            source_max_hp: None,
            source_statuses: None,
            instance_snapshot: None,
            source_snapshot: None,
            record_snapshot: None,
        }
    }

    fn damage(ts: i64, event: DamageEvent) -> (i64, Message) {
        (ts, Message::DamageEvent(event))
    }

    fn mode(ts: i64, actor_index: u32, mode: u32) -> (i64, Message) {
        (ts, Message::EnemyMode(EnemyModeEvent { actor_index, mode }))
    }

    /// A group of `n` hits under one `(source, action)` key — the second
    /// pass's grouping key, so these always land in one crit candidate group
    /// regardless of timestamp. `start_ts` and the 100ms spacing only keep
    /// the fixture's timestamps distinct and readable.
    fn hits_at(start_ts: i64, action: ActionType, damages: &[i32]) -> Vec<(i64, Message)> {
        damages
            .iter()
            .enumerate()
            .map(|(i, &d)| damage(start_ts + i as i64 * 100, hit(1, 10, action, d)))
            .collect()
    }

    #[test]
    fn populated_snapshot_resolves_all_six_facts_as_measured() {
        let blob = blob_with(&[
            (0x15D, &[1]),                   // crit: set
            (0x15E, &[0]),                   // weak point: clear
            (0x15F, &[1]),                   // back attack: set
            (0x161, &[1]),                   // debuffed: set
            (0x162, &[0]),                   // overdrive: clear
            (0x163, &[1]),                   // break: set
            (0xD0, &1_000u32.to_le_bytes()), // builder ran
        ]);
        let event = DamageEvent {
            instance_snapshot: Some(blob),
            ..hit(1, 10, ActionType::Normal(500), 999)
        };
        let facts = assemble_hit_facts(&[damage(0, event)]);

        assert_eq!(facts.len(), 1);
        let hit_facts = facts[0].expect("a damage event yields facts");
        assert_eq!(hit_facts.crit, Fact::MeasuredYes);
        assert_eq!(hit_facts.weak_point, Fact::MeasuredNo);
        assert_eq!(hit_facts.back_attack, Fact::MeasuredYes);
        assert_eq!(hit_facts.debuffed, Fact::MeasuredYes);
        assert_eq!(hit_facts.overdrive, Fact::MeasuredNo);
        assert_eq!(hit_facts.break_mode, Fact::MeasuredYes);
    }

    #[test]
    fn unpopulated_hit_infers_mode_from_the_last_seen_mode_event() {
        let log = vec![
            mode(1_000, 7, EnemyModeEvent::MODE_OVERDRIVE),
            damage(2_000, hit(1, 7, ActionType::Normal(1), 100)),
            // Actor 9 is never named by a mode event at all.
            damage(2_500, hit(1, 9, ActionType::Normal(1), 100)),
        ];
        let facts = assemble_hit_facts(&log);

        let known = facts[1].expect("damage event");
        assert_eq!(known.overdrive, Fact::InferredYes);
        assert_eq!(known.break_mode, Fact::InferredNo);

        let unseen = facts[2].expect("damage event");
        assert_eq!(unseen.overdrive, Fact::Unknown);
        assert_eq!(unseen.break_mode, Fact::Unknown);
    }

    #[test]
    fn a_hit_before_any_mode_event_for_its_target_is_unknown() {
        // A later mode event for the same actor must not retroactively
        // inform a hit that came before it in the log.
        let log = vec![
            damage(500, hit(1, 7, ActionType::Normal(1), 100)),
            mode(1_000, 7, EnemyModeEvent::MODE_OVERDRIVE),
        ];
        let facts = assemble_hit_facts(&log);

        let hit_facts = facts[0].expect("damage event");
        assert_eq!(hit_facts.overdrive, Fact::Unknown);
        assert_eq!(hit_facts.break_mode, Fact::Unknown);
    }

    #[test]
    fn a_mode_event_at_the_same_timestamp_applies_when_ordered_first() {
        // Stream order, not timestamp order, governs — matches the windows
        // fold's own semantics.
        let log = vec![
            mode(5_000, 7, EnemyModeEvent::MODE_BREAK),
            damage(5_000, hit(1, 7, ActionType::Normal(1), 100)),
        ];
        let facts = assemble_hit_facts(&log);

        let hit_facts = facts[1].expect("damage event");
        assert_eq!(hit_facts.break_mode, Fact::InferredYes);
        assert_eq!(hit_facts.overdrive, Fact::InferredNo);
    }

    #[test]
    fn an_unrecognized_mode_infers_neither_overdrive_nor_break() {
        // Mode 3 is reachable (the hook forwards raw modes < 6) and is
        // neither Overdrive nor Break — matches the windows fold's own
        // "any other mode closes both" semantics.
        let log = vec![
            mode(1_000, 7, 3),
            damage(2_000, hit(1, 7, ActionType::Normal(1), 100)),
        ];
        let facts = assemble_hit_facts(&log);

        let hit_facts = facts[1].expect("damage event");
        assert_eq!(hit_facts.overdrive, Fact::InferredNo);
        assert_eq!(hit_facts.break_mode, Fact::InferredNo);
    }

    #[test]
    fn crit_clean_split_infers_low_as_no_and_high_as_yes() {
        // Six hits ~1000 (±3%), four hits ~2550 (±3%): a clean ~2.5x gap
        // between clusters, well inside the accepted band.
        let low = [970, 985, 995, 1_005, 1_015, 1_030];
        let high = [2_480, 2_520, 2_560, 2_600];
        let mut log = hits_at(0, ActionType::Normal(500), &low);
        log.extend(hits_at(1_000, ActionType::Normal(500), &high));

        let facts = assemble_hit_facts(&log);
        let crits: Vec<Fact> = facts.iter().map(|f| f.unwrap().crit).collect();
        assert_eq!(&crits[..6], &[Fact::InferredNo; 6]);
        assert_eq!(&crits[6..], &[Fact::InferredYes; 4]);
    }

    #[test]
    fn crit_split_rejected_when_total_hits_is_below_the_minimum() {
        // A real ~2.5x gap, but only 7 hits total — below MIN_TOTAL_HITS.
        let low = [970, 985, 995, 1_005, 1_015];
        let high = [2_480, 2_520];
        let mut log = hits_at(0, ActionType::Normal(500), &low);
        log.extend(hits_at(1_000, ActionType::Normal(500), &high));

        let facts = assemble_hit_facts(&log);
        assert!(facts.iter().all(|f| f.unwrap().crit == Fact::Unknown));
    }

    #[test]
    fn crit_split_rejected_when_damages_are_uniform() {
        // No gap at all: every adjacent ratio is 1.0, so the largest-gap
        // search leaves `split_at` at its initial 0 — a singleton low
        // cluster, which MIN_CLUSTER_HITS rejects before the ratio band is
        // ever consulted.
        let uniform = [1_000; 8];
        let log = hits_at(0, ActionType::Normal(500), &uniform);

        let facts = assemble_hit_facts(&log);
        assert!(facts.iter().all(|f| f.unwrap().crit == Fact::Unknown));
    }

    #[test]
    fn crit_split_rejected_when_the_ratio_is_too_large() {
        // A clean two-cluster split, but the gap is 5x — past CRIT_RATIO_MAX,
        // more likely multi-part MV structure than a crit boundary.
        let low = [1_000, 1_010, 1_020, 1_030];
        let high = [5_000, 5_050, 5_100, 5_150];
        let mut log = hits_at(0, ActionType::Normal(500), &low);
        log.extend(hits_at(1_000, ActionType::Normal(500), &high));

        let facts = assemble_hit_facts(&log);
        assert!(facts.iter().all(|f| f.unwrap().crit == Fact::Unknown));
    }

    #[test]
    fn a_non_positive_damage_is_excluded_and_cannot_drag_a_cluster_mean() {
        // Regression: a zero-damage hit alongside seven identical 1000s used
        // to slip into the low cluster (only the GAP SEARCH skipped
        // non-positive pairs, not candidate collection), dragging
        // mean(low) down until seven identical hits split into 1 InferredNo
        // + 6 InferredYes. The zero must never enter a cluster at all, and
        // with it gone the seven 1000s have no gap to split on — every hit
        // here stays Unknown.
        let mut log = hits_at(0, ActionType::Normal(500), &[0]);
        log.extend(hits_at(100, ActionType::Normal(500), &[1_000; 7]));

        let facts = assemble_hit_facts(&log);
        assert_eq!(facts.len(), 8);
        assert!(
            facts.iter().all(|f| f.unwrap().crit == Fact::Unknown),
            "the zero-damage hit and all seven 1000s must stay Unknown: {facts:?}"
        );
    }

    #[test]
    fn supplementary_and_dot_damage_are_excluded_from_crit_clustering() {
        // A clean bimodal split, but under action kinds the second pass must
        // never cluster: their damage is not a fresh roll. Every hit stays
        // Unknown, and every position is still `Some` (aligned).
        let low = [970, 985, 995, 1_005, 1_015, 1_030];
        let high = [2_480, 2_520, 2_560, 2_600];
        let mut log = hits_at(0, ActionType::SupplementaryDamage(500), &low);
        log.extend(hits_at(1_000, ActionType::SupplementaryDamage(500), &high));
        log.extend(hits_at(2_000, ActionType::DamageOverTime(0), &low));
        log.extend(hits_at(3_000, ActionType::DamageOverTime(0), &high));

        let facts = assemble_hit_facts(&log);
        assert_eq!(facts.len(), 20);
        assert!(facts.iter().all(|f| f.unwrap().crit == Fact::Unknown));
    }

    #[test]
    fn alignment_by_index_holds_across_a_mixed_log() {
        let log = vec![
            mode(0, 5, EnemyModeEvent::MODE_NORMAL),           // 0: None
            damage(100, hit(1, 5, ActionType::Normal(1), 50)), // 1: Some
            (200, Message::LinkTime(LinkTimeEvent { active: true })), // 2: None
            damage(300, hit(1, 5, ActionType::Normal(1), 60)), // 3: Some
            damage(400, hit(1, 5, ActionType::Normal(1), 70)), // 4: Some
            mode(500, 5, EnemyModeEvent::MODE_BREAK),          // 5: None
        ];
        let facts = assemble_hit_facts(&log);

        assert_eq!(facts.len(), 6);
        assert!(facts[0].is_none(), "index 0: EnemyMode");
        assert!(facts[1].is_some(), "index 1: DamageEvent");
        assert!(facts[2].is_none(), "index 2: LinkTime");
        assert!(facts[3].is_some(), "index 3: DamageEvent");
        assert!(facts[4].is_some(), "index 4: DamageEvent");
        assert!(facts[5].is_none(), "index 5: EnemyMode");
    }
}
