//! Damage-logging audit: reconcile logged damage against observed enemy HP.
//!
//! Since 2026-07-20 every damage event carries the target's post-hit
//! `(current_hp, max_hp)` pair, read from its `ExHp` component. Damage we logged
//! should equal HP the enemy lost. Where it doesn't, the difference is either
//! explained (a killing blow overflowing past zero, an enemy regenerating) or it
//! is damage the hook failed to log — the failure this module exists to find.
//!
//! Reconciliation works over INTERVALS BETWEEN HP SAMPLES, not per hit. Only
//! hits carrying an HP pair sample the pool; DoT ticks carry `None`, and so does
//! every event in a log recorded before HP capture shipped. Comparing per hit
//! would charge each DoT tick as unlogged damage. Accumulating all logged damage
//! since the last sample credits every hit to exactly one interval.

use std::collections::BTreeMap;

use protocol::Message;

use super::segment_targets_indexed;
use crate::parser::constants::EnemyType;

/// How an interval's residual is explained.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Bucket {
    /// Logged damage equals HP lost.
    Matched,
    /// We logged more than the pool lost, and the pool reached zero: the
    /// killing blow overflowed. Explained.
    Overkill,
    /// We logged more than the pool lost while it was still alive: the enemy
    /// regenerated. Explained only for enemies the corpus shows to do this.
    Healed,
    /// The pool lost more HP than we logged. The bug this audit hunts.
    UnderLogged,
    /// A segment's opening interval whose logged damage falls short of the drop
    /// from max HP — so the pool cannot be shown to have started full, and the
    /// shortfall is not attributable to the meter. Real logs carry bosses whose
    /// `max_hp` does not describe the pool their `current_hp` drains, and every
    /// later interval in those fights reconciles exactly.
    AnchorUnverified,
    /// No HP anchor available, so the interval cannot be reconciled at all:
    /// pre-HP-capture logs, sanitizer rejects, DoT-only tails.
    Unmeasured,
}

/// One reconciled span between two HP samples of a single target spawn.
#[derive(Debug, Clone, PartialEq)]
pub struct AuditInterval {
    pub target_index: u32,
    pub enemy_type: EnemyType,
    /// The `instance` of the owning [`TargetSegment`] — the "#n" the UI shows.
    pub instance: u32,
    pub start_ms: i64,
    pub end_ms: i64,
    pub logged: i64,
    pub hp_before: Option<u64>,
    pub hp_after: Option<u64>,
    /// `logged - (hp_before - hp_after)`. Positive: we logged more than the pool
    /// lost. Negative: the pool lost more than we logged.
    pub residual: i64,
    pub bucket: Bucket,
    /// Whether `hp_before` came from the segment's max HP rather than an
    /// observed sample. Anchors carry an assumption; see [`AuditOptions`].
    pub is_anchor: bool,
    /// Whether this target hangs off another actor (a breakable part or a
    /// summon), rather than being its own parent.
    pub is_part: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct AuditTotals {
    pub logged_damage: i64,
    pub hp_removed: i64,
    pub overkill: i64,
    pub healed: i64,
    pub under_logged: i64,
    /// The share of `under_logged` charged to targets that hang off a parent.
    /// Hitting a part can drain the body's pool too, so this portion is an
    /// attribution artifact rather than evidence of a missing hit.
    pub under_logged_on_parts: i64,
    /// The share of `healed` charged to targets that hang off a parent, where a
    /// repaired part or a reused index mimics regeneration.
    pub healed_on_parts: i64,
    /// HP loss observed on whole enemies — the population where "logged damage
    /// equals HP lost" actually holds, and the one the verdict is built on.
    pub whole_enemy_hp_removed: i64,
    pub whole_enemy_under_logged: i64,
    pub whole_enemy_healed: i64,
    pub unmeasured_damage: i64,
    /// Damage logged into opening intervals whose max-HP anchor the data
    /// contradicts. Neither confirmed nor blamed on the meter.
    pub anchor_unverified_damage: i64,
    pub matched_intervals: usize,
    pub intervals: usize,
}

impl std::ops::AddAssign for AuditTotals {
    /// Destructured rather than field-by-field: a new total added above stops
    /// this compiling instead of silently summing to zero in every corpus sweep.
    fn add_assign(&mut self, rhs: Self) {
        let Self {
            logged_damage,
            hp_removed,
            overkill,
            healed,
            under_logged,
            under_logged_on_parts,
            healed_on_parts,
            whole_enemy_hp_removed,
            whole_enemy_under_logged,
            whole_enemy_healed,
            unmeasured_damage,
            anchor_unverified_damage,
            matched_intervals,
            intervals,
        } = rhs;
        self.logged_damage += logged_damage;
        self.hp_removed += hp_removed;
        self.overkill += overkill;
        self.healed += healed;
        self.under_logged += under_logged;
        self.under_logged_on_parts += under_logged_on_parts;
        self.healed_on_parts += healed_on_parts;
        self.whole_enemy_hp_removed += whole_enemy_hp_removed;
        self.whole_enemy_under_logged += whole_enemy_under_logged;
        self.whole_enemy_healed += whole_enemy_healed;
        self.unmeasured_damage += unmeasured_damage;
        self.anchor_unverified_damage += anchor_unverified_damage;
        self.matched_intervals += matched_intervals;
        self.intervals += intervals;
    }
}

impl AuditTotals {
    /// Unexplained HP loss on whole enemies, before the corpus discounts
    /// enemies it has shown to regenerate.
    pub fn whole_enemy_unexplained(&self) -> i64 {
        self.whole_enemy_under_logged + self.whole_enemy_healed
    }

    /// Pessimistic accuracy: every heal counts as unexplained. The corpus sweep
    /// refines this by discounting enemies it has shown to regenerate.
    ///
    /// `None` when nothing was measurable — a log with no HP data must not
    /// score a perfect 100%.
    pub fn accuracy(&self) -> Option<f64> {
        if self.hp_removed <= 0 {
            return None;
        }
        Some(1.0 - (self.under_logged + self.healed) as f64 / self.hp_removed as f64)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct AuditOptions {
    /// Anchor each segment's first interval at the pool's max HP. This is what
    /// ties logged damage back to enemy maximum health, but it assumes a segment
    /// starts full — untrue of a phase transition into a partly-damaged pool.
    /// Disable to reconcile only between observed samples.
    pub anchor_at_max_hp: bool,
}

impl Default for AuditOptions {
    fn default() -> Self {
        Self {
            anchor_at_max_hp: true,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct EncounterAudit {
    pub intervals: Vec<AuditInterval>,
    pub totals: AuditTotals,
    /// Segments sharing a parent and a max-HP value — the shape a group-HP boss
    /// (`ExEmGroupHp`) would take if its parts share one pool. Listed, never
    /// assumed: whether the game does this is unverified.
    pub shared_pool_suspects: Vec<SharedPoolSuspect>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SharedPoolSuspect {
    pub parent_index: u32,
    pub max_hp: u64,
    pub target_indices: Vec<u32>,
}

/// Per-enemy-type tallies, the input to regen-outlier classification.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct EnemyStats {
    pub intervals: usize,
    pub healed_intervals: usize,
    pub healed_damage: i64,
    /// The portion of `healed_damage` observed on whole enemies rather than
    /// parts — the only portion the verdict may spend.
    pub whole_enemy_healed: i64,
    pub under_logged: i64,
    pub hp_removed: i64,
}

impl std::ops::AddAssign for EnemyStats {
    fn add_assign(&mut self, rhs: Self) {
        let Self {
            intervals,
            healed_intervals,
            healed_damage,
            whole_enemy_healed,
            under_logged,
            hp_removed,
        } = rhs;
        self.intervals += intervals;
        self.healed_intervals += healed_intervals;
        self.healed_damage += healed_damage;
        self.whole_enemy_healed += whole_enemy_healed;
        self.under_logged += under_logged;
        self.hp_removed += hp_removed;
    }
}

/// An enemy type earns "known regen" status only on repeated, systematic
/// evidence: heals in at least this many distinct logs...
pub const REGEN_MIN_LOGS: usize = 3;
/// ...and in at least this share of its intervals. One heal in a thousand is
/// noise; one in twenty is a mechanic.
pub const REGEN_MIN_INTERVAL_SHARE: f64 = 0.05;

/// Promote enemy types whose heals are systematic rather than incidental.
///
/// Nothing is hardcoded here. Naming Lucilius in the source would hide whichever
/// enemy regenerates next.
pub fn classify_regen_outliers(
    per_enemy: &[(EnemyType, EnemyStats, usize)],
) -> Vec<EnemyType> {
    per_enemy
        .iter()
        .filter(|(_, stats, logs_with_heals)| {
            *logs_with_heals >= REGEN_MIN_LOGS
                && stats.intervals > 0
                && stats.healed_intervals as f64 / stats.intervals as f64
                    >= REGEN_MIN_INTERVAL_SHARE
        })
        .map(|(enemy_type, _, _)| *enemy_type)
        .collect()
}

/// A segment's reconciliation state: the HP the pool held when the current
/// interval opened, and the damage logged into it since.
struct Open {
    hp_before: Option<u64>,
    is_anchor: bool,
    pending: i64,
    start_ms: i64,
    last_ms: i64,
    parent_index: Option<u32>,
}

/// Reconcile one encounter's raw event log against observed enemy HP.
pub fn audit_encounter(
    events: &[(i64, Message)],
    start_time: i64,
    options: AuditOptions,
) -> EncounterAudit {
    let (segments, assignment) = segment_targets_indexed(events, start_time);

    let mut open: Vec<Open> = segments
        .iter()
        .map(|segment| Open {
            hp_before: options.anchor_at_max_hp.then_some(segment.max_hp).flatten(),
            is_anchor: options.anchor_at_max_hp && segment.max_hp.is_some(),
            pending: 0,
            start_ms: segment.start_ms,
            last_ms: segment.start_ms,
            parent_index: None,
        })
        .collect();

    let mut intervals: Vec<AuditInterval> = Vec::new();

    for (event_index, (timestamp, message)) in events.iter().enumerate() {
        let Message::DamageEvent(event) = message else {
            continue;
        };
        let Some(position) = assignment[event_index] else {
            continue;
        };
        let segment = &segments[position];
        let state = &mut open[position];
        let rel_ts = timestamp - start_time;

        state.pending += event.damage as i64;
        state.last_ms = rel_ts;
        state.parent_index.get_or_insert(event.target.parent_index);

        // Only an HP-carrying event closes an interval. DoT ticks and pre-HP
        // events accumulate into the one already open.
        let Some((current, _)) = event.target_current_hp.zip(event.target_max_hp) else {
            continue;
        };

        intervals.push(close_interval(
            segment,
            state,
            Some(current),
            event.target.parent_index != event.target.index,
        ));

        state.hp_before = Some(current);
        state.is_anchor = false;
        state.pending = 0;
        state.start_ms = rel_ts;
    }

    // Damage logged after a segment's last HP sample never closes. On a pool
    // already at zero that is overflow onto a corpse; otherwise it is simply
    // unmeasurable.
    for (position, state) in open.iter().enumerate() {
        if state.pending == 0 {
            continue;
        }
        intervals.push(close_interval(
            &segments[position],
            state,
            None,
            state.parent_index.is_some_and(|parent| parent != segments[position].id),
        ));
    }

    let mut totals = AuditTotals::default();
    for interval in &intervals {
        totals.intervals += 1;
        totals.logged_damage += interval.logged;

        // An unverified anchor's drop is not established, so it must not swell
        // the denominator the verdict divides by.
        if interval.bucket != Bucket::AnchorUnverified {
            if let (Some(before), Some(after)) = (interval.hp_before, interval.hp_after) {
                let removed = (before as i64 - after as i64).max(0);
                totals.hp_removed += removed;
                if !interval.is_part {
                    totals.whole_enemy_hp_removed += removed;
                }
            }
        }

        match interval.bucket {
            Bucket::Matched => totals.matched_intervals += 1,
            Bucket::Overkill => totals.overkill += interval.residual,
            Bucket::Healed => {
                totals.healed += interval.residual;
                if interval.is_part {
                    totals.healed_on_parts += interval.residual;
                } else {
                    totals.whole_enemy_healed += interval.residual;
                }
            }
            Bucket::UnderLogged => {
                totals.under_logged += -interval.residual;
                if interval.is_part {
                    totals.under_logged_on_parts += -interval.residual;
                } else {
                    totals.whole_enemy_under_logged += -interval.residual;
                }
            }
            Bucket::Unmeasured => totals.unmeasured_damage += interval.logged,
            Bucket::AnchorUnverified => totals.anchor_unverified_damage += interval.logged,
        }
    }

    let parents: Vec<Option<u32>> = open.iter().map(|state| state.parent_index).collect();
    let shared_pool_suspects = find_shared_pool_suspects(&segments, &parents);

    EncounterAudit {
        intervals,
        totals,
        shared_pool_suspects,
    }
}

/// Classify one span between HP samples. `hp_after` is `None` for a trailing
/// span that no later sample ever closed.
///
/// Everything else about the span comes off `state` — passing the struct rather
/// than its fields keeps the two call sites from having to order four
/// interchangeable integers correctly.
fn close_interval(
    segment: &super::TargetSegment,
    state: &Open,
    hp_after: Option<u64>,
    is_part: bool,
) -> AuditInterval {
    let Open {
        hp_before,
        is_anchor,
        pending: logged,
        start_ms,
        last_ms: end_ms,
        ..
    } = *state;

    let (residual, bucket) = match (hp_before, hp_after) {
        (Some(before), Some(after)) => {
            let residual = logged - (before as i64 - after as i64);
            let bucket = if residual == 0 {
                Bucket::Matched
            } else if residual > 0 {
                // Past zero the pool cannot absorb more; the rest overflowed.
                if after == 0 {
                    Bucket::Overkill
                } else {
                    Bucket::Healed
                }
            } else if is_anchor {
                // The anchor assumed this pool started at max HP and the data
                // disagrees. "We missed damage" and "we never saw it full" are
                // indistinguishable here, so neither is claimed.
                Bucket::AnchorUnverified
            } else {
                Bucket::UnderLogged
            };
            (residual, bucket)
        }
        // Trailing damage on a pool already dead is overflow onto a corpse.
        (Some(0), None) => (logged, Bucket::Overkill),
        _ => (0, Bucket::Unmeasured),
    };

    AuditInterval {
        target_index: segment.id,
        enemy_type: segment.enemy_type,
        instance: segment.instance,
        start_ms,
        end_ms,
        logged,
        hp_before,
        hp_after,
        residual,
        bucket,
        is_anchor,
        is_part,
    }
}

/// Sibling parts reporting one identical max HP under a shared parent — the
/// shape a group-HP boss (`ExEmGroupHp`) would take if its parts drew on one
/// pool. Whether the game does this is unverified, so this reports the pattern
/// and stops there.
fn find_shared_pool_suspects(
    segments: &[super::TargetSegment],
    parents: &[Option<u32>],
) -> Vec<SharedPoolSuspect> {
    let mut groups: BTreeMap<(u32, u64), Vec<u32>> = BTreeMap::new();

    for (segment, parent) in segments.iter().zip(parents) {
        let (Some(parent), Some(max)) = (parent, segment.max_hp) else {
            continue;
        };
        let indices = groups.entry((*parent, max)).or_default();
        if !indices.contains(&segment.id) {
            indices.push(segment.id);
        }
    }

    groups
        .into_iter()
        .filter(|(_, indices)| indices.len() > 1)
        .map(|((parent_index, max_hp), mut target_indices)| {
            target_indices.sort_unstable();
            SharedPoolSuspect {
                parent_index,
                max_hp,
                target_indices,
            }
        })
        .collect()
}

/// Aggregate an audit's intervals by enemy type.
pub fn per_enemy_stats(audit: &EncounterAudit) -> Vec<(EnemyType, EnemyStats)> {
    // EnemyType has no Hash and n is tiny, so a linear scan beats a map.
    let mut per_enemy: Vec<(EnemyType, EnemyStats)> = Vec::new();

    for interval in &audit.intervals {
        let entry = match per_enemy
            .iter_mut()
            .find(|(enemy_type, _)| *enemy_type == interval.enemy_type)
        {
            Some((_, stats)) => stats,
            None => {
                per_enemy.push((interval.enemy_type, EnemyStats::default()));
                &mut per_enemy.last_mut().expect("just pushed").1
            }
        };

        entry.intervals += 1;
        if interval.bucket != Bucket::AnchorUnverified {
            if let (Some(before), Some(after)) = (interval.hp_before, interval.hp_after) {
                entry.hp_removed += (before as i64 - after as i64).max(0);
            }
        }
        match interval.bucket {
            Bucket::Healed => {
                entry.healed_intervals += 1;
                entry.healed_damage += interval.residual;
                if !interval.is_part {
                    entry.whole_enemy_healed += interval.residual;
                }
            }
            Bucket::UnderLogged => entry.under_logged += -interval.residual,
            _ => {}
        }
    }

    per_enemy
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::{ActionType, Actor, DamageEvent};

    /// One damage event against target index `target`, optionally carrying a
    /// post-hit `(current, max)` HP pair.
    fn hit(ts: i64, target: u32, damage: i32, hp: Option<(u64, u64)>) -> (i64, Message) {
        let (current, max) = match hp {
            Some((current, max)) => (Some(current), Some(max)),
            None => (None, None),
        };

        (
            ts,
            Message::DamageEvent(DamageEvent {
                source: Actor {
                    index: 0,
                    actor_type: 0x2AF6_78E8,
                    parent_actor_type: 0x2AF6_78E8,
                    parent_index: 0,
                },
                target: Actor {
                    index: target,
                    actor_type: target,
                    parent_actor_type: target,
                    parent_index: target,
                },
                damage,
                flags: 0,
                action_id: ActionType::Normal(1),
                attack_rate: None,
                stun_value: None,
                damage_cap: None,
                base_damage: None,
                target_current_hp: current,
                target_max_hp: max,
            }),
        )
    }

    fn audit(events: &[(i64, Message)]) -> EncounterAudit {
        audit_encounter(events, 0, AuditOptions::default())
    }

    fn buckets(audit: &EncounterAudit) -> Vec<Bucket> {
        audit.intervals.iter().map(|i| i.bucket).collect()
    }

    /// The baseline: a hit whose damage exactly equals the HP the pool lost,
    /// measured from the segment's max-HP anchor.
    #[test]
    fn exact_hit_matches() {
        let audit = audit(&[hit(0, 1, 100, Some((900, 1000)))]);

        assert_eq!(buckets(&audit), vec![Bucket::Matched]);
        assert_eq!(audit.totals.hp_removed, 100);
        assert_eq!(audit.totals.logged_damage, 100);
        assert_eq!(audit.totals.under_logged, 0);
        assert_eq!(audit.intervals[0].residual, 0);
        assert!(audit.intervals[0].is_anchor);
    }

    /// A killing blow overflows past zero. The excess is explained, not a defect,
    /// so it lands in `Overkill` and never in `UnderLogged`.
    #[test]
    fn killing_blow_is_overkill() {
        let audit = audit(&[
            hit(0, 1, 900, Some((100, 1000))),
            hit(1_000, 1, 500, Some((0, 1000))),
        ]);

        assert_eq!(buckets(&audit), vec![Bucket::Matched, Bucket::Overkill]);
        assert_eq!(audit.totals.overkill, 400);
        assert_eq!(audit.totals.under_logged, 0);
        // Only HP the pool actually lost counts toward the denominator.
        assert_eq!(audit.totals.hp_removed, 1000);
    }

    /// DoT ticks carry no HP pair. Their damage belongs to the interval that
    /// encloses them — charging it against the next sample as unlogged damage
    /// would make every poisoned fight look broken.
    #[test]
    fn dot_between_samples_is_credited_to_the_enclosing_interval() {
        let audit = audit(&[
            hit(0, 1, 100, Some((900, 1000))),
            hit(500, 1, 50, None),
            hit(1_000, 1, 100, Some((750, 1000))),
        ]);

        assert_eq!(buckets(&audit), vec![Bucket::Matched, Bucket::Matched]);
        assert_eq!(audit.totals.under_logged, 0);
        assert_eq!(audit.totals.logged_damage, 250);
        assert_eq!(audit.totals.hp_removed, 250);
    }

    /// An enemy that regenerates loses less HP than we dealt while still alive.
    #[test]
    fn regeneration_shows_as_healed() {
        let audit = audit(&[
            hit(0, 1, 100, Some((900, 1000))),
            hit(1_000, 1, 100, Some((850, 1000))),
        ]);

        assert_eq!(buckets(&audit), vec![Bucket::Matched, Bucket::Healed]);
        assert_eq!(audit.totals.healed, 50);
        assert_eq!(audit.totals.under_logged, 0);
    }

    /// The signal we are hunting: the pool lost more HP than we logged.
    #[test]
    fn missed_damage_is_under_logged() {
        let audit = audit(&[
            hit(0, 1, 100, Some((900, 1000))),
            hit(1_000, 1, 100, Some((700, 1000))),
        ]);

        assert_eq!(buckets(&audit), vec![Bucket::Matched, Bucket::UnderLogged]);
        assert_eq!(audit.totals.under_logged, 100);
        assert_eq!(audit.totals.healed, 0);
        assert_eq!(audit.intervals[1].residual, -100);
    }

    /// The game reuses one actor index across summon waves. Without segmenting,
    /// wave 2 rising from zero back to full reads as an enormous heal.
    #[test]
    fn a_respawn_is_not_a_heal() {
        let audit = audit(&[
            hit(0, 1, 900, Some((100, 1000))),
            hit(1_000, 1, 100, Some((0, 1000))),
            // Wave 2, after a wave-length quiet gap.
            hit(40_000, 1, 40, Some((960, 1000))),
        ]);

        assert_eq!(audit.totals.healed, 0, "a respawn must not read as regen");
        assert_eq!(
            buckets(&audit),
            vec![Bucket::Matched, Bucket::Matched, Bucket::Matched]
        );
        // The second wave anchors at its own full pool.
        assert!(audit.intervals[2].is_anchor);
        assert_eq!(audit.intervals[2].instance, 2);
    }

    /// A log recorded before HP capture shipped can be measured against nothing.
    /// It must report as unmeasurable, never as perfect.
    #[test]
    fn an_hp_less_log_is_unmeasured_not_perfect() {
        let audit = audit(&[
            hit(0, 1, 100, None),
            hit(1_000, 1, 200, None),
            hit(2_000, 1, 300, None),
        ]);

        assert_eq!(buckets(&audit), vec![Bucket::Unmeasured]);
        assert_eq!(audit.totals.unmeasured_damage, 600);
        assert_eq!(audit.totals.hp_removed, 0);
        assert_eq!(audit.totals.accuracy(), None, "nothing measurable ≠ 100%");
    }

    /// Segment assignment must follow the segmenter's own boundaries, not
    /// timestamps: a phase change can open a new segment at the same millisecond
    /// as the previous segment's last event, and a time-based split would file
    /// the new pool's damage against the old pool.
    #[test]
    fn events_tied_at_a_segment_boundary_land_in_the_right_segment() {
        let audit = audit(&[
            hit(0, 1, 100, Some((900, 1000))),
            hit(1_000, 1, 100, Some((800, 1000))),
            // Same millisecond, new max HP: phase 2 begins.
            hit(1_000, 1, 50, Some((1_950, 2_000))),
        ]);

        assert_eq!(
            buckets(&audit),
            vec![Bucket::Matched, Bucket::Matched, Bucket::Matched]
        );
        assert_eq!(audit.totals.under_logged, 0);
        assert_eq!(audit.totals.healed, 0);
        assert_eq!(audit.intervals[2].hp_before, Some(2_000));
    }

    /// A pool whose first sample sits far below its reported max cannot be
    /// anchored: we cannot tell missed damage from a pool we never saw start
    /// full. Real logs make this concrete — a boss reporting max 1.5e9 whose
    /// first sample reads 64.6m, after which every later interval reconciles
    /// exactly. Charging that gap as under-logged damage blames the meter for a
    /// max-HP field that does not describe the pool being drained.
    #[test]
    fn an_anchor_contradicted_by_its_first_sample_is_not_under_logged() {
        let audit = audit(&[
            hit(0, 1, 1_000, Some((64_000, 1_500_000))),
            hit(1_000, 1, 1_000, Some((63_000, 1_500_000))),
        ]);

        assert_eq!(
            buckets(&audit),
            vec![Bucket::AnchorUnverified, Bucket::Matched]
        );
        assert_eq!(
            audit.totals.under_logged, 0,
            "an unverifiable anchor is not evidence of missed damage"
        );
        assert_eq!(
            audit.totals.hp_removed, 1_000,
            "only the observed drop counts; the phantom anchor drop does not"
        );
        assert_eq!(audit.totals.anchor_unverified_damage, 1_000);
    }

    /// An anchor the logged damage corroborates stays trustworthy: we logged at
    /// least as much as the pool lost, so a full-HP start is consistent.
    #[test]
    fn an_anchor_corroborated_by_logged_damage_is_kept() {
        let audit = audit(&[hit(0, 1, 1_500, Some((0, 1000)))]);

        assert_eq!(buckets(&audit), vec![Bucket::Overkill]);
        assert_eq!(audit.totals.anchor_unverified_damage, 0);
        assert_eq!(audit.totals.hp_removed, 1_000);
    }

    /// Disabling the anchor drops the assumption that a segment starts full;
    /// its first interval becomes unmeasurable rather than reconciled.
    #[test]
    fn disabling_the_anchor_marks_the_first_interval_unmeasured() {
        let events = [
            hit(0, 1, 100, Some((900, 1000))),
            hit(1_000, 1, 100, Some((800, 1000))),
        ];
        let audit = audit_encounter(
            &events,
            0,
            AuditOptions {
                anchor_at_max_hp: false,
            },
        );

        assert_eq!(buckets(&audit), vec![Bucket::Unmeasured, Bucket::Matched]);
        assert_eq!(audit.totals.unmeasured_damage, 100);
        assert_eq!(audit.totals.hp_removed, 100);
    }

    /// Outlier promotion needs BOTH repetition across logs and prevalence within
    /// them. Either alone is noise.
    #[test]
    fn regen_outliers_need_both_repetition_and_prevalence() {
        let systematic = EnemyStats {
            intervals: 100,
            healed_intervals: 10,
            ..Default::default()
        };
        let rare_but_widespread = EnemyStats {
            intervals: 1000,
            healed_intervals: 10,
            ..Default::default()
        };
        let prevalent_but_isolated = EnemyStats {
            intervals: 100,
            healed_intervals: 50,
            ..Default::default()
        };

        let outliers = classify_regen_outliers(&[
            (EnemyType::Unknown(1), systematic, 5),
            (EnemyType::Unknown(2), rare_but_widespread, 5),
            (EnemyType::Unknown(3), prevalent_but_isolated, 2),
        ]);

        assert_eq!(outliers, vec![EnemyType::Unknown(1)]);
    }

    /// The regen classifier judges an enemy type on all its heals, but the
    /// verdict may only spend whole-enemy ones, so the two are tallied apart.
    #[test]
    fn per_enemy_stats_separate_whole_enemy_heals_from_part_heals() {
        let mut events = vec![
            hit(0, 5, 100, Some((900, 1000))),
            hit(1_000, 5, 100, Some((850, 1000))),
            hit(2_000, 10, 100, Some((900, 1000))),
            hit(3_000, 10, 100, Some((880, 1000))),
        ];
        for (_, message) in events.iter_mut().skip(2) {
            if let Message::DamageEvent(event) = message {
                event.target.parent_index = 7;
                event.target.parent_actor_type = 5;
            }
        }

        let audit = audit(&events);
        let stats = per_enemy_stats(&audit);
        let (_, body) = stats
            .iter()
            .find(|(enemy_type, _)| *enemy_type == EnemyType::Unknown(5))
            .expect("both targets report the same enemy type");

        assert_eq!(body.healed_damage, 130, "all heals feed the classifier");
        assert_eq!(body.whole_enemy_healed, 50, "only the body's heal is spendable");
    }

    /// Sibling parts reporting an identical max HP under one parent are the
    /// shape a shared (`ExEmGroupHp`) pool would take. The audit reports the
    /// pattern; it does not decide the question.
    #[test]
    fn sibling_parts_sharing_a_max_hp_are_flagged_as_suspects() {
        let mut events = vec![
            hit(0, 10, 100, Some((900, 1000))),
            hit(1_000, 11, 100, Some((800, 1000))),
        ];
        // Both parts hang off the same parent.
        for (_, message) in events.iter_mut() {
            if let Message::DamageEvent(event) = message {
                event.target.parent_index = 7;
            }
        }

        let audit = audit(&events);

        assert_eq!(
            audit.shared_pool_suspects,
            vec![SharedPoolSuspect {
                parent_index: 7,
                max_hp: 1000,
                target_indices: vec![10, 11],
            }]
        );
    }

    /// Hitting a breakable part can drain the body's pool as well as the part's.
    /// Damage logged against the part then shows up as HP the BODY lost without
    /// matching logged damage — an attribution artifact, not a missing hit. The
    /// audit splits the two so the headline is not quietly built on it.
    #[test]
    fn under_logging_is_split_between_parts_and_bodies() {
        let mut events = vec![
            // A body: its own parent.
            hit(0, 5, 100, Some((900, 1000))),
            hit(1_000, 5, 100, Some((700, 1000))),
            // A part hanging off a different parent.
            hit(2_000, 10, 100, Some((900, 1000))),
            hit(3_000, 10, 100, Some((650, 1000))),
        ];
        for (_, message) in events.iter_mut().skip(2) {
            if let Message::DamageEvent(event) = message {
                event.target.parent_index = 7;
            }
        }

        let audit = audit(&events);

        assert_eq!(audit.totals.under_logged, 250);
        assert_eq!(
            audit.totals.under_logged_on_parts, 150,
            "the part's shortfall is tracked apart from the body's"
        );
        assert!(!audit.intervals[1].is_part);
        assert!(audit.intervals[3].is_part);
    }

    /// Heals need the same split for the same reason: a part whose pool refills
    /// on repair, or whose index is reused by a sibling, reads as regeneration
    /// that the enemy never performed.
    #[test]
    fn healing_is_split_between_parts_and_bodies() {
        let mut events = vec![
            hit(0, 5, 100, Some((900, 1000))),
            hit(1_000, 5, 100, Some((850, 1000))),
            hit(2_000, 10, 100, Some((900, 1000))),
            hit(3_000, 10, 100, Some((880, 1000))),
        ];
        for (_, message) in events.iter_mut().skip(2) {
            if let Message::DamageEvent(event) = message {
                event.target.parent_index = 7;
            }
        }

        let audit = audit(&events);

        assert_eq!(audit.totals.healed, 130);
        assert_eq!(audit.totals.healed_on_parts, 80);
    }

    /// The trustworthy population: intervals measured sample-to-sample on a
    /// whole enemy. Everything the audit cannot vouch for is excluded rather
    /// than averaged in.
    #[test]
    fn whole_enemy_totals_exclude_parts_and_anchors() {
        let mut events = vec![
            hit(0, 5, 100, Some((900, 1000))),
            hit(1_000, 5, 100, Some((700, 1000))),
            hit(2_000, 10, 100, Some((900, 1000))),
            hit(3_000, 10, 100, Some((650, 1000))),
        ];
        for (_, message) in events.iter_mut().skip(2) {
            if let Message::DamageEvent(event) = message {
                event.target.parent_index = 7;
            }
        }

        let audit = audit(&events);

        // Body: a corroborated anchor removing 100, then an observed interval
        // removing 200 of which only 100 was logged. The part's 350 is excluded.
        assert_eq!(audit.totals.whole_enemy_hp_removed, 300);
        assert_eq!(audit.totals.whole_enemy_unexplained(), 100);
    }

    /// Every damage event's damage must be accounted for exactly once, whichever
    /// bucket it lands in. A leak here silently deflates the denominator.
    #[test]
    fn every_logged_point_of_damage_is_accounted_for_exactly_once() {
        let events = [
            hit(0, 1, 900, Some((100, 1000))),
            hit(500, 1, 50, None),
            hit(1_000, 1, 500, Some((0, 1000))),
            hit(2_000, 2, 300, None),
            hit(40_000, 1, 40, Some((960, 1000))),
        ];
        let audit = audit(&events);

        let interval_sum: i64 = audit.intervals.iter().map(|i| i.logged).sum();
        assert_eq!(interval_sum, 1790);
        assert_eq!(audit.totals.logged_damage, 1790);
    }

    /// Damage logged after a pool is already dead is overflow, not a mystery,
    /// even when no further HP sample ever closes the interval.
    #[test]
    fn trailing_damage_on_a_dead_pool_is_overkill() {
        let audit = audit(&[
            hit(0, 1, 1000, Some((0, 1000))),
            // Splash landing on the corpse before it despawns.
            hit(100, 1, 250, None),
        ]);

        assert_eq!(audit.totals.overkill, 250);
        assert_eq!(audit.totals.unmeasured_damage, 0);
    }
}
