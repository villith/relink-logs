# Per-Skill Supplementary/Echo Attribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show, per skill, how often Supplementary (0.2×) and Echo (0.4×) procs triggered and how much damage they added, with a toggle that folds proc damage into each skill's row instead of one merged "Supplementary Damage" row.

**Architecture:** The parser (Tauri backend, `src-tauri/src/parser/v1/`) classifies each `SupplementaryDamage(aid)` event by dividing its damage by recent hits of the triggering skill (ratio ≈0.2 → Supplementary, ≈0.4 → Echo) and accumulates per-skill counters. The React frontend adds Supp%/Echo% columns, a persisted `merge_supplementary` setting, and — when merged — combined totals, Supp/Echo damage columns, lighter bar segments, and a residual row for unattributed proc damage. No hook, protocol, or DB changes; old logs gain the stat on re-parse.

**Tech Stack:** Rust (rusqlite/serde/bincode parser crate `gbfr-logs`), React + TypeScript (Vite, Mantine, Zustand, vitest).

**Spec:** `docs/superpowers/specs/2026-07-16-supp-echo-attribution-design.md`

---

## File map

| File | Change |
|---|---|
| `src-tauri/src/parser/v1/skill_state.rs` | `ProcKind`, ratio constants, 4 new counters, `recent_hits` ring buffer, `classify_proc` |
| `src-tauri/src/parser/v1/player_state.rs` | supp-event branch: attribute to trigger row, then merge (replaces in-loop merge) |
| `src/types.ts` | `SkillState` + `ComputedSkillState` + `ComputedSkillGroup` new fields |
| `src/stores/useMeterSettingsStore.ts` | `merge_supplementary` setting |
| `src/pages/useSettings.ts`, `src/pages/Settings.tsx` | settings checkbox |
| `src-tauri/lang/en/ui.json` | checkbox label/description strings |
| `src/components/mergeSupplementary.ts` (new) | pure merge/residual helper + action-type guards |
| `src/components/mergeSupplementary.test.ts` (new) | vitest for the helper |
| `src/components/useSkillBreakdown.ts` | merge flag, display totals, segment %s, group sums, sort |
| `src/components/SkillBreakdown.tsx` | new column headers |
| `src/components/useSkillRow.ts`, `src/components/SkillRow.tsx` | new cells + bar segments |
| `src/components/useSkillGroupRow.tsx`, `src/components/SkillGroupRow.tsx` | same for groups |
| `src/App.css` | `.damage-bar-supp` / `.damage-bar-echo` opacity |

---

### Task 1: Parser — proc counters, ring buffer, and `classify_proc`

**Files:**
- Modify: `src-tauri/src/parser/v1/skill_state.rs`

- [ ] **Step 1: Write the failing tests**

Append to the `tests` module in `src-tauri/src/parser/v1/skill_state.rs` (the module already has `make_event`; add a target-aware variant):

```rust
    fn make_event_on_target(damage: i32, target_index: u32) -> DamageEvent {
        let mut event = make_event(damage, None);
        event.target.index = target_index;
        event
    }

    fn record_hit(skill: &mut SkillState, damage: i32, target_index: u32) {
        let event = make_event_on_target(damage, target_index);
        skill.update_from_damage_event(&AdjustedDamageInstance::from_damage_event(&event, None));
    }

    #[test]
    fn classifies_supplementary_ratio() {
        let mut skill = SkillState::new(ActionType::Normal(1), CharacterType::Pl0000);
        record_hit(&mut skill, 1000, 0);
        assert_eq!(skill.classify_proc(200, 0, 0), ProcKind::Supplementary);
    }

    #[test]
    fn classifies_echo_ratio() {
        let mut skill = SkillState::new(ActionType::Normal(1), CharacterType::Pl0000);
        record_hit(&mut skill, 1000, 0);
        assert_eq!(skill.classify_proc(400, 0, 0), ProcKind::Echo);
    }

    #[test]
    fn picks_best_hit_across_window_not_newest() {
        let mut skill = SkillState::new(ActionType::Normal(1), CharacterType::Pl0000);
        // Older hit is the true trigger (ratio 0.2); newest gives a garbage 0.5.
        record_hit(&mut skill, 1_000_000, 0);
        record_hit(&mut skill, 400_000, 0);
        assert_eq!(skill.classify_proc(200_000, 0, 0), ProcKind::Supplementary);
    }

    #[test]
    fn empty_buffer_defaults_to_supplementary() {
        let skill = SkillState::new(ActionType::Normal(1), CharacterType::Pl0000);
        assert_eq!(skill.classify_proc(12345, 0, 0), ProcKind::Supplementary);
    }

    #[test]
    fn ambiguous_two_x_pair_prefers_same_target() {
        let mut skill = SkillState::new(ActionType::Normal(1), CharacterType::Pl0000);
        // 2,000,000 on target 1 and 1,000,000 on target 2: a 400,000 proc is
        // exactly 0.2x the first AND 0.4x the second. Same-target must win.
        record_hit(&mut skill, 2_000_000, 1);
        record_hit(&mut skill, 1_000_000, 2);
        assert_eq!(skill.classify_proc(400_000, 2, 0), ProcKind::Echo);
        assert_eq!(skill.classify_proc(400_000, 1, 0), ProcKind::Supplementary);
    }

    #[test]
    fn nearest_bucket_when_no_exact_match() {
        let mut skill = SkillState::new(ActionType::Normal(1), CharacterType::Pl0000);
        record_hit(&mut skill, 1000, 0);
        // 0.27 -> below the 0.283 midpoint -> Supplementary
        assert_eq!(skill.classify_proc(270, 0, 0), ProcKind::Supplementary);
        // 0.30 -> above the midpoint -> Echo
        assert_eq!(skill.classify_proc(300, 0, 0), ProcKind::Echo);
    }

    #[test]
    fn old_serialized_state_defaults_proc_fields_to_zero() {
        // Old logs' derived state lacks the proc fields; serde(default) must
        // fill zeros and the skip'd ring buffer must come back empty.
        let skill = SkillState::new(ActionType::Normal(1), CharacterType::Pl0000);
        let mut json: serde_json::Value = serde_json::to_value(&skill).unwrap();
        let obj = json.as_object_mut().unwrap();
        obj.remove("suppHits");
        obj.remove("echoHits");
        obj.remove("suppDamage");
        obj.remove("echoDamage");
        let revived: SkillState = serde_json::from_value(json).unwrap();
        assert_eq!(revived.supp_hits, 0);
        assert_eq!(revived.echo_hits, 0);
        assert_eq!(revived.supp_damage, 0);
        assert_eq!(revived.echo_damage, 0);
        assert!(revived.recent_hits.is_empty());
    }

    #[test]
    fn ring_buffer_caps_at_window_size() {
        let mut skill = SkillState::new(ActionType::Normal(1), CharacterType::Pl0000);
        for i in 0..10 {
            record_hit(&mut skill, 1000 + i, 0);
        }
        assert_eq!(skill.recent_hits.len(), 8);
        // Oldest entries (1000, 1001) evicted.
        assert_eq!(skill.recent_hits.front().copied(), Some((1002, 0, 0)));
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p gbfr-logs skill_state`
Expected: compile error — `ProcKind`, `classify_proc`, `recent_hits` not defined.

- [ ] **Step 3: Implement**

In `src-tauri/src/parser/v1/skill_state.rs`:

Add imports at the top:

```rust
use std::collections::VecDeque;
```

Add above `pub struct SkillState`:

```rust
/// Which proc mechanic produced a supplementary-type damage event.
/// The event stream carries no discriminator — flags are identical for both —
/// so classification divides the proc's damage by its trigger hit's damage:
/// Supplementary procs deal 0.2x, Echo procs 0.4x (spec 2026-07-16).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcKind {
    Supplementary,
    Echo,
}

const SUPP_RATIO: f64 = 0.2;
const ECHO_RATIO: f64 = 0.4;
/// Geometric mean of 0.2 and 0.4 — the classification boundary.
const RATIO_MIDPOINT: f64 = 0.283;
/// A ratio this close to 0.2/0.4 is an exact match; nothing can beat it.
const EXACT_TOLERANCE: f64 = 0.002;
/// Window size measured on logs 244-247: accuracy plateaus at 8, larger
/// windows only add ambiguous 2x pairs.
const RECENT_HITS_WINDOW: usize = 8;
```

Add fields to `SkillState` (after `cappable_samples`):

```rust
    /// Procs classified as Supplementary (≈0.2× their trigger hit)
    #[serde(default)]
    pub supp_hits: u32,
    /// Procs classified as Echo (≈0.4× their trigger hit)
    #[serde(default)]
    pub echo_hits: u32,
    /// Damage from Supplementary procs attributed to this skill
    #[serde(default)]
    pub supp_damage: u64,
    /// Damage from Echo procs attributed to this skill
    #[serde(default)]
    pub echo_damage: u64,
    /// `(damage, target_index, target_actor_type)` of the last 8 hits, used to
    /// classify proc events by ratio. Never serialized — rebuilt on re-parse.
    #[serde(skip)]
    pub recent_hits: VecDeque<(i32, u32, u32)>,
```

Initialize them in `SkillState::new` (after `cappable_samples: Vec::new(),`):

```rust
            supp_hits: 0,
            echo_hits: 0,
            supp_damage: 0,
            echo_damage: 0,
            recent_hits: VecDeque::new(),
```

Record hits at the end of `update_from_damage_event`:

```rust
        self.recent_hits.push_back((
            damage_instance.event.damage,
            damage_instance.event.target.index,
            damage_instance.event.target.actor_type,
        ));
        if self.recent_hits.len() > RECENT_HITS_WINDOW {
            self.recent_hits.pop_front();
        }
```

(The merged Supplementary row also records its procs here; its buffer is never
queried, so that is harmless.)

Add the classifier as a method on `SkillState`:

```rust
    /// Classify a supplementary-type proc against this skill's recent hits.
    /// Search order (spec): exact ratio match on the proc's own target, then
    /// exact match on any target, then nearest ratio overall. Iteration is
    /// newest-first so ties break toward the most recent hit. An empty buffer
    /// defaults to Supplementary.
    pub fn classify_proc(
        &self,
        proc_damage: i32,
        target_index: u32,
        target_actor_type: u32,
    ) -> ProcKind {
        let dist = |r: f64| (r - SUPP_RATIO).abs().min((r - ECHO_RATIO).abs());
        let kind_of = |r: f64| {
            if r < RATIO_MIDPOINT {
                ProcKind::Supplementary
            } else {
                ProcKind::Echo
            }
        };
        let ratios = |same_target_only: bool| {
            self.recent_hits
                .iter()
                .rev()
                .filter(move |(damage, t_idx, t_type)| {
                    *damage > 0
                        && (!same_target_only
                            || (*t_idx == target_index && *t_type == target_actor_type))
                })
                .map(move |(damage, _, _)| proc_damage as f64 / *damage as f64)
        };

        if let Some(r) = ratios(true).find(|r| dist(*r) < EXACT_TOLERANCE) {
            return kind_of(r);
        }
        if let Some(r) = ratios(false).find(|r| dist(*r) < EXACT_TOLERANCE) {
            return kind_of(r);
        }
        // Nearest bucket. Strict `<` keeps the first (newest) of equal candidates.
        let mut best: Option<f64> = None;
        for r in ratios(false) {
            if best.map_or(true, |b| dist(r) < dist(b)) {
                best = Some(r);
            }
        }
        best.map(kind_of).unwrap_or(ProcKind::Supplementary)
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p gbfr-logs skill_state`
Expected: all pass, including the pre-existing `updating_from_damage_event`, `counts_capped_hits`, `supplementary_damage_is_never_capped_nor_cappable`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/parser/v1/skill_state.rs
git commit -m "feat(parser): classify supplementary/echo procs by trigger ratio"
```

---

### Task 2: Parser — attribute procs to the triggering skill row

**Files:**
- Modify: `src-tauri/src/parser/v1/player_state.rs`

- [ ] **Step 1: Write the failing tests**

Append to the `tests` module in `player_state.rs`. The module's existing tests build `DamageEvent` literals; add helpers:

```rust
    fn empty_player() -> PlayerState {
        PlayerState {
            index: 0,
            character_type: CharacterType::Pl0000,
            total_damage: 0,
            last_known_pet_skill: None,
            dps: 0.0,
            skill_breakdown: vec![],
            sba: 0.0,
            total_stun_value: 0.0,
            stun_per_second: 0.0,
            capped_hits: 0,
            cappable_hits: 0,
        }
    }

    fn plain_event(action_id: ActionType, damage: i32) -> DamageEvent {
        DamageEvent {
            source: protocol::Actor {
                index: 0,
                actor_type: 0,
                parent_actor_type: 0,
                parent_index: 0,
            },
            target: protocol::Actor {
                index: 0,
                actor_type: 0,
                parent_actor_type: 0,
                parent_index: 0,
            },
            action_id,
            damage,
            flags: 0,
            attack_rate: None,
            stun_value: None,
            damage_cap: None,
        }
    }

    fn apply(player: &mut PlayerState, event: &DamageEvent) {
        player.update_from_damage_event(&AdjustedDamageInstance::from_damage_event(event, None));
    }

    #[test]
    fn supplementary_proc_attributes_to_trigger_skill() {
        let mut player = empty_player();
        apply(&mut player, &plain_event(ActionType::Normal(1), 1000));
        apply(
            &mut player,
            &plain_event(ActionType::SupplementaryDamage(1), 200),
        );

        let trigger = player
            .skill_breakdown
            .iter()
            .find(|s| s.action_type == ActionType::Normal(1))
            .unwrap();
        assert_eq!(trigger.supp_hits, 1);
        assert_eq!(trigger.supp_damage, 200);
        assert_eq!(trigger.echo_hits, 0);
        // The trigger row's own hit stats are untouched by the proc.
        assert_eq!(trigger.hits, 1);
        assert_eq!(trigger.total_damage, 1000);

        // The merged Supplementary Damage row still aggregates as before.
        let merged = player
            .skill_breakdown
            .iter()
            .find(|s| matches!(s.action_type, ActionType::SupplementaryDamage(_)))
            .unwrap();
        assert_eq!(merged.hits, 1);
        assert_eq!(merged.total_damage, 200);
        assert_eq!(player.total_damage, 1200);
    }

    #[test]
    fn echo_proc_classified_by_ratio() {
        let mut player = empty_player();
        apply(&mut player, &plain_event(ActionType::Normal(1), 1000));
        apply(
            &mut player,
            &plain_event(ActionType::SupplementaryDamage(1), 400),
        );

        let trigger = player
            .skill_breakdown
            .iter()
            .find(|s| s.action_type == ActionType::Normal(1))
            .unwrap();
        assert_eq!(trigger.echo_hits, 1);
        assert_eq!(trigger.echo_damage, 400);
        assert_eq!(trigger.supp_hits, 0);
    }

    #[test]
    fn proc_without_matching_skill_row_only_merges() {
        let mut player = empty_player();
        apply(
            &mut player,
            &plain_event(ActionType::SupplementaryDamage(99), 200),
        );

        // Only the merged row exists; nothing was attributed anywhere.
        assert_eq!(player.skill_breakdown.len(), 1);
        let merged = &player.skill_breakdown[0];
        assert!(matches!(
            merged.action_type,
            ActionType::SupplementaryDamage(_)
        ));
        assert_eq!(merged.total_damage, 200);
        assert_eq!(merged.supp_hits, 0);
        assert_eq!(merged.echo_hits, 0);
    }

    #[test]
    fn multiple_procs_accumulate() {
        let mut player = empty_player();
        apply(&mut player, &plain_event(ActionType::Normal(1), 1000));
        apply(
            &mut player,
            &plain_event(ActionType::SupplementaryDamage(1), 200),
        );
        apply(&mut player, &plain_event(ActionType::Normal(1), 2000));
        apply(
            &mut player,
            &plain_event(ActionType::SupplementaryDamage(1), 800),
        );

        let trigger = player
            .skill_breakdown
            .iter()
            .find(|s| s.action_type == ActionType::Normal(1))
            .unwrap();
        // 200/1000 = 0.2 -> supp; 800/2000 = 0.4 -> echo.
        assert_eq!(trigger.supp_hits, 1);
        assert_eq!(trigger.supp_damage, 200);
        assert_eq!(trigger.echo_hits, 1);
        assert_eq!(trigger.echo_damage, 800);
        // Merged row got both procs.
        let merged = player
            .skill_breakdown
            .iter()
            .find(|s| matches!(s.action_type, ActionType::SupplementaryDamage(_)))
            .unwrap();
        assert_eq!(merged.hits, 2);
        assert_eq!(merged.total_damage, 1000);
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p gbfr-logs player_state`
Expected: the four new tests FAIL — `supp_hits` stays 0 because attribution doesn't exist yet (the merged-row behavior alone passes some asserts, but `supplementary_proc_attributes_to_trigger_skill` and the others assert nonzero counters).

- [ ] **Step 3: Implement**

In `player_state.rs`, import `ProcKind`:

```rust
use super::{skill_state::ProcKind, skill_state::SkillState, AdjustedDamageInstance};
```

(replacing the existing `use super::{skill_state::SkillState, AdjustedDamageInstance};`)

In `update_from_damage_event`, after `let action = ...` (the Ferry remap) and **before** the `for skill in self.skill_breakdown.iter_mut()` loop, insert:

```rust
        // Supplementary-type procs: attribute to the skill row that triggered
        // them (the proc carries the trigger's action id), then merge into the
        // shared Supplementary Damage row as before. Classification is by
        // damage ratio — the event stream has no other discriminator.
        if let protocol::ActionType::SupplementaryDamage(trigger_aid) = action {
            let event = damage_instance.event;
            if let Some(idx) = self.skill_breakdown.iter().position(|s| {
                s.action_type == ActionType::Normal(trigger_aid)
                    && s.child_character_type == child_character_type
            }) {
                let row = &mut self.skill_breakdown[idx];
                match row.classify_proc(event.damage, event.target.index, event.target.actor_type)
                {
                    ProcKind::Supplementary => {
                        row.supp_hits += 1;
                        row.supp_damage += event.damage as u64;
                    }
                    ProcKind::Echo => {
                        row.echo_hits += 1;
                        row.echo_damage += event.damage as u64;
                    }
                }
            }

            if let Some(merged) = self
                .skill_breakdown
                .iter_mut()
                .find(|s| matches!(s.action_type, protocol::ActionType::SupplementaryDamage(_)))
            {
                merged.update_from_damage_event(damage_instance);
            } else {
                let mut skill = SkillState::new(action, child_character_type);
                skill.update_from_damage_event(damage_instance);
                self.skill_breakdown.push(skill);
            }
            return;
        }
```

Then delete the now-dead supp-merge branch inside the loop (the
`if matches!(skill.action_type, protocol::ActionType::SupplementaryDamage(_)) && matches!(action, ...)` block at lines 108–116) — supplementary events return early and never reach the loop.

Note: Ferry pet procs that her remap converts to a `Normal` id keep today's
behavior (they fall through to the normal loop) — spec's known limitation.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p gbfr-logs`
Expected: all parser tests pass, including the pre-existing `counts_player_capped_hits_across_skills` (its capped-hit path goes through the normal loop, unaffected).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/parser/v1/player_state.rs
git commit -m "feat(parser): attribute supplementary/echo procs to their trigger skill"
```

---

### Task 3: Frontend — types, setting, settings UI

**Files:**
- Modify: `src/types.ts:38-90`
- Modify: `src/stores/useMeterSettingsStore.ts`
- Modify: `src/pages/useSettings.ts`
- Modify: `src/pages/Settings.tsx:122-128`
- Modify: `src-tauri/lang/en/ui.json`

- [ ] **Step 1: Extend `SkillState` in `src/types.ts`**

Add to `export type SkillState = { ... }` after `cappableHits`:

```ts
  /** Procs classified as Supplementary (~0.2x their trigger hit) */
  suppHits: number;
  /** Procs classified as Echo (~0.4x their trigger hit) */
  echoHits: number;
  /** Damage from Supplementary procs attributed to this skill */
  suppDamage: number;
  /** Damage from Echo procs attributed to this skill */
  echoDamage: number;
```

Add to `export type ComputedSkillState = SkillState & { ... }` after `percentage`:

```ts
  /** Damage shown in the Total column — own damage, plus proc damage when the merge toggle is on */
  totalDisplayDamage: number;
  /** Supp proc damage as a percentage of the player total (0 when merge is off) */
  suppPercentage: number;
  /** Echo proc damage as a percentage of the player total (0 when merge is off) */
  echoPercentage: number;
```

Add to `export type ComputedSkillGroup = { ... }` after `cappableHits` (around line 90 — the group type mirrors the skill fields):

```ts
  /** Procs classified as Supplementary across the group */
  suppHits: number;
  /** Procs classified as Echo across the group */
  echoHits: number;
  /** Supplementary proc damage across the group */
  suppDamage: number;
  /** Echo proc damage across the group */
  echoDamage: number;
  /** Damage shown in the Total column — own + proc damage when the merge toggle is on */
  totalDisplayDamage: number;
  /** Supp proc damage as a percentage of the player total (0 when merge is off) */
  suppPercentage: number;
  /** Echo proc damage as a percentage of the player total (0 when merge is off) */
  echoPercentage: number;
```

- [ ] **Step 2: Add the setting to the store**

In `src/stores/useMeterSettingsStore.ts` add to `interface MeterSettings` after `use_condensed_skills: boolean;`:

```ts
  merge_supplementary: boolean;
```

and to `DEFAULT_METER_SETTINGS` after `use_condensed_skills: true,`:

```ts
  merge_supplementary: false,
```

- [ ] **Step 3: Plumb it through `useSettings`**

In `src/pages/useSettings.ts` add `merge_supplementary` alongside `use_condensed_skills` in all three places: the destructure (line ~25), the selector object (line ~38: `merge_supplementary: state.merge_supplementary,`), and the return object (line ~87).

- [ ] **Step 4: Add the checkbox**

In `src/pages/Settings.tsx`, add `merge_supplementary` to the `useSettings()` destructure (line ~37), then insert after the `use_condensed_skills` checkbox block (line 128):

```tsx
          <Tooltip label={t("ui.merge-supplementary-description")}>
            <Checkbox
              label={t("ui.merge-supplementary")}
              checked={merge_supplementary}
              onChange={(event) => setMeterSettings({ merge_supplementary: event.currentTarget.checked })}
            />
          </Tooltip>
```

- [ ] **Step 5: Add the strings**

In `src-tauri/lang/en/ui.json`, next to the `use-condensed-skills` keys inside the `ui` object, add:

```json
    "merge-supplementary": "Merge Supplementary/Echo into skills",
    "merge-supplementary-description": "Show Supplementary and Echo proc damage as part of the skill that triggered it, instead of a separate Supplementary Damage row.",
```

(Only hand-edit the `en` file — other languages fall back to it.)

- [ ] **Step 6: Typecheck**

Run: `npm run build`
Expected: FAILS — `suppHits` etc. are now required on `SkillState`/`ComputedSkillState`/`ComputedSkillGroup` and `useSkillBreakdown.ts` doesn't provide the computed fields yet. That's the driver for Task 4/5; if it instead fails somewhere unrelated, fix that first. (If it passes, fine — structural typing may defer errors to Task 5.)

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/stores/useMeterSettingsStore.ts src/pages/useSettings.ts src/pages/Settings.tsx src-tauri/lang/en/ui.json
git commit -m "feat(ui): merge_supplementary setting and supp/echo skill fields"
```

---

### Task 4: Frontend — pure merge helper (TDD)

**Files:**
- Create: `src/components/mergeSupplementary.ts`
- Create: `src/components/mergeSupplementary.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/components/mergeSupplementary.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SkillState } from "@/types";
import { isDotAction, isSupplementaryAction, mergeSupplementaryRows } from "./mergeSupplementary";

const skill = (overrides: Partial<SkillState>): SkillState => ({
  actionType: { Normal: 1 },
  childCharacterType: "Pl0000",
  hits: 1,
  minDamage: 100,
  maxDamage: 100,
  totalDamage: 100,
  totalStunValue: 0,
  maxStunValue: 0,
  cappedHits: 0,
  cappableHits: 0,
  suppHits: 0,
  echoHits: 0,
  suppDamage: 0,
  echoDamage: 0,
  ...overrides,
});

describe("isSupplementaryAction / isDotAction", () => {
  it("detects the action families", () => {
    expect(isSupplementaryAction({ SupplementaryDamage: 5 })).toBe(true);
    expect(isSupplementaryAction({ Normal: 5 })).toBe(false);
    expect(isSupplementaryAction("LinkAttack")).toBe(false);
    expect(isDotAction({ DamageOverTime: 0 })).toBe(true);
    expect(isDotAction({ Normal: 5 })).toBe(false);
  });
});

describe("mergeSupplementaryRows", () => {
  it("drops the merged supp row when its damage is fully attributed", () => {
    const rows = [
      skill({ actionType: { Normal: 1 }, totalDamage: 1000, suppDamage: 150, echoDamage: 50 }),
      skill({ actionType: { SupplementaryDamage: 1 }, totalDamage: 200 }),
    ];
    const merged = mergeSupplementaryRows(rows);
    expect(merged).toHaveLength(1);
    expect(merged[0].actionType).toEqual({ Normal: 1 });
  });

  it("keeps a residual row when some proc damage is unattributed", () => {
    const rows = [
      skill({ actionType: { Normal: 1 }, totalDamage: 1000, suppDamage: 150 }),
      skill({ actionType: { SupplementaryDamage: 1 }, totalDamage: 200 }),
    ];
    const merged = mergeSupplementaryRows(rows);
    expect(merged).toHaveLength(2);
    const residual = merged.find((s) => isSupplementaryAction(s.actionType));
    expect(residual?.totalDamage).toBe(50);
  });

  it("leaves rows unchanged when there is no supp row", () => {
    const rows = [skill({ actionType: { Normal: 1 }, totalDamage: 1000 })];
    expect(mergeSupplementaryRows(rows)).toEqual(rows);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/mergeSupplementary.test.ts`
Expected: FAIL — module `./mergeSupplementary` not found.

- [ ] **Step 3: Implement**

Create `src/components/mergeSupplementary.ts`:

```ts
import { SkillState } from "@/types";

type ActionTypeLike = SkillState["actionType"];

export const isSupplementaryAction = (actionType: ActionTypeLike): boolean =>
  typeof actionType === "object" && Object.hasOwn(actionType, "SupplementaryDamage");

export const isDotAction = (actionType: ActionTypeLike): boolean =>
  typeof actionType === "object" && Object.hasOwn(actionType, "DamageOverTime");

/// With the merge toggle on: hide the merged Supplementary Damage row when its
/// damage is fully attributed to trigger skills, otherwise keep only the
/// unattributed remainder so the encounter total still adds up.
export const mergeSupplementaryRows = (skills: SkillState[]): SkillState[] => {
  const attributed = skills.reduce((acc, s) => acc + s.suppDamage + s.echoDamage, 0);

  return skills.flatMap((s) => {
    if (!isSupplementaryAction(s.actionType)) return [s];
    const residual = s.totalDamage - attributed;
    return residual > 0 ? [{ ...s, totalDamage: residual }] : [];
  });
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/mergeSupplementary.test.ts`
Expected: PASS (all 4).

- [ ] **Step 5: Commit**

```bash
git add src/components/mergeSupplementary.ts src/components/mergeSupplementary.test.ts
git commit -m "feat(ui): mergeSupplementaryRows helper with residual handling"
```

---

### Task 5: Frontend — computed fields in `useSkillBreakdown`

**Files:**
- Modify: `src/components/useSkillBreakdown.ts`

- [ ] **Step 1: Wire the merge flag and computed fields**

Replace the top of the hook (selector + `computedSkills` construction, lines 9–22) with:

```ts
  const { useCondensedSkills, mergeSupplementary } = useMeterSettingsStore(
    useShallow((state) => ({
      useCondensedSkills: state.use_condensed_skills,
      mergeSupplementary: state.merge_supplementary,
    }))
  );

  // Denominator: the player's full damage including the merged supp row, so
  // percentages are identical whether or not the row is folded in.
  const totalDamage = player.skillBreakdown.reduce((acc, skill) => acc + skill.totalDamage, 0);
  const breakdown = mergeSupplementary ? mergeSupplementaryRows(player.skillBreakdown) : player.skillBreakdown;
  const computedSkills = breakdown.map<ComputedSkillState>((skill) => {
    const totalDisplayDamage = skill.totalDamage + (mergeSupplementary ? skill.suppDamage + skill.echoDamage : 0);
    return {
      percentage: (totalDisplayDamage / totalDamage) * 100,
      totalDisplayDamage,
      suppPercentage: mergeSupplementary ? (skill.suppDamage / totalDamage) * 100 : 0,
      echoPercentage: mergeSupplementary ? (skill.echoDamage / totalDamage) * 100 : 0,
      groupName: getSkillName(player.characterType, skill),
      ...skill,
    };
  });
```

Add the import:

```ts
import { mergeSupplementaryRows } from "./mergeSupplementary";
```

- [ ] **Step 2: Extend group aggregation**

In the condensed-skills branch, extend the *update* object (the `skills[skillGroupIndex] = { ...skillGroup, ... }` spread) with:

```ts
                suppHits: skillGroup.suppHits + skill.suppHits,
                echoHits: skillGroup.echoHits + skill.echoHits,
                suppDamage: skillGroup.suppDamage + skill.suppDamage,
                echoDamage: skillGroup.echoDamage + skill.echoDamage,
                totalDisplayDamage: skillGroup.totalDisplayDamage + skill.totalDisplayDamage,
                suppPercentage: skillGroup.suppPercentage + skill.suppPercentage,
                echoPercentage: skillGroup.echoPercentage + skill.echoPercentage,
```

and the *create* object (`skills.push({ ... })`) with:

```ts
                suppHits: skill.suppHits,
                echoHits: skill.echoHits,
                suppDamage: skill.suppDamage,
                echoDamage: skill.echoDamage,
                totalDisplayDamage: skill.totalDisplayDamage,
                suppPercentage: skill.suppPercentage,
                echoPercentage: skill.echoPercentage,
```

- [ ] **Step 3: Sort by display total**

Replace `skillsToShow.sort((a, b) => b.totalDamage - a.totalDamage);` with:

```ts
  skillsToShow.sort((a, b) => b.totalDisplayDamage - a.totalDisplayDamage);
```

(Both branch types now carry `totalDisplayDamage`; with the toggle off it equals `totalDamage`, preserving today's order.)

- [ ] **Step 4: Typecheck**

Run: `npm run build`
Expected: PASS — all required computed fields now exist. If `ComputedSkillGroup` complains about a missing field in the push-literal, cross-check Task 3 Step 1's field list.

- [ ] **Step 5: Commit**

```bash
git add src/components/useSkillBreakdown.ts
git commit -m "feat(ui): combined display totals and proc percentages in skill breakdown"
```

---

### Task 6: Frontend — columns, bar segments, CSS

**Files:**
- Modify: `src/components/SkillBreakdown.tsx:52-63`
- Modify: `src/components/useSkillRow.ts`
- Modify: `src/components/SkillRow.tsx`
- Modify: `src/components/useSkillGroupRow.tsx`
- Modify: `src/components/SkillGroupRow.tsx`
- Modify: `src/App.css`

Column order everywhere (headers and cells must match):
`Skill | Hits | Total | Min | Max | Avg | [Supp] | Supp% | [Echo] | Echo% | Cap | %`
— bracketed damage columns render only when the merge toggle is on.

- [ ] **Step 1: Headers**

In `SkillBreakdown.tsx`, read the flag (add imports for `useShallow` and the store):

```ts
import { useShallow } from "zustand/react/shallow";
import { useMeterSettingsStore } from "@/stores/useMeterSettingsStore";
```

inside the component:

```ts
  const { mergeSupplementary } = useMeterSettingsStore(
    useShallow((state) => ({ mergeSupplementary: state.merge_supplementary }))
  );
```

Replace the `<thead>` row contents with:

```tsx
            <tr>
              <th className="header-name">Skill</th>
              <th className="header-column text-center">Hits</th>
              <th className="header-column text-center">Total</th>
              <th className="header-column text-center">Min</th>
              <th className="header-column text-center">Max</th>
              <th className="header-column text-center">Avg</th>
              {mergeSupplementary && <th className="header-column text-center">Supp</th>}
              <th className="header-column text-center">Supp%</th>
              {mergeSupplementary && <th className="header-column text-center">Echo</th>}
              <th className="header-column text-center">Echo%</th>
              <th className="header-column text-center">Cap</th>
              <th className="header-column text-center">%</th>
            </tr>
```

- [ ] **Step 2: `useSkillRow` additions**

Replace `src/components/useSkillRow.ts` with:

```ts
import { useMeterSettingsStore } from "@/stores/useMeterSettingsStore";
import { ComputedSkillState } from "@/types";
import { humanizeNumbers } from "@/utils";
import { useShallow } from "zustand/react/shallow";

export const useSkillRow = (skill: ComputedSkillState) => {
  const { show_full_values, merge_supplementary } = useMeterSettingsStore(
    useShallow((state) => ({
      show_full_values: state.show_full_values,
      merge_supplementary: state.merge_supplementary,
    }))
  );

  const rawTotalDamage = skill.totalDisplayDamage ?? skill.totalDamage;
  const [totalDamage, totalDamageUnit] = humanizeNumbers(rawTotalDamage);
  const [minDmg, minDmgUnit] = humanizeNumbers(skill.minDamage || 0);
  const [maxDmg, maxDmgUnit] = humanizeNumbers(skill.maxDamage || 0);
  const rawAverageDmg = skill.hits === 0 ? 0 : rawTotalDamage / skill.hits;
  const [averageDmg, averageDmgUnit] = humanizeNumbers(rawAverageDmg);
  const [suppDmg, suppDmgUnit] = humanizeNumbers(skill.suppDamage);
  const [echoDmg, echoDmgUnit] = humanizeNumbers(skill.echoDamage);
  const ownPercentage = skill.percentage - (skill.suppPercentage ?? 0) - (skill.echoPercentage ?? 0);

  return {
    showFullValues: show_full_values,
    mergeSupplementary: merge_supplementary,
    rawTotalDamage,
    totalDamage,
    totalDamageUnit,
    minDmg,
    minDmgUnit,
    maxDmg,
    maxDmgUnit,
    rawAverageDmg,
    averageDmg,
    averageDmgUnit,
    suppDmg,
    suppDmgUnit,
    echoDmg,
    echoDmgUnit,
    ownPercentage,
  };
};
```

- [ ] **Step 3: `SkillRow` cells and bar**

In `SkillRow.tsx`:

Add imports:

```ts
import { isDotAction, isSupplementaryAction } from "./mergeSupplementary";
```

Extend the hook destructure with the new values:

```ts
  const {
    showFullValues,
    mergeSupplementary,
    rawTotalDamage,
    totalDamage,
    totalDamageUnit,
    minDmg,
    minDmgUnit,
    maxDmg,
    maxDmgUnit,
    rawAverageDmg,
    averageDmg,
    averageDmgUnit,
    suppDmg,
    suppDmgUnit,
    echoDmg,
    echoDmgUnit,
    ownPercentage,
  } = useSkillRow(skill);

  // Proc columns are meaningless on rows that are themselves procs or DoT.
  const isProcSource = !isSupplementaryAction(skill.actionType) && !isDotAction(skill.actionType);
```

Change the Total cell's full-value branch from `skill.totalDamage.toLocaleString()` to `rawTotalDamage.toLocaleString()` (the humanized branch already uses the hook's `totalDamage`).

Insert after the Avg cell (`rawAverageDmg` cell) and before the Cap cell:

```tsx
      {mergeSupplementary && (
        <td className="text-center row-data">
          {isProcSource && skill.suppDamage > 0 ? (
            showFullValues ? (
              skill.suppDamage.toLocaleString()
            ) : (
              <>
                {suppDmg}
                <span className="unit font-sm">{suppDmgUnit}</span>
              </>
            )
          ) : (
            ""
          )}
        </td>
      )}
      <td className="text-center row-data">
        {isProcSource ? (
          <>
            {skill.hits > 0 ? ((skill.suppHits / skill.hits) * 100).toFixed(0) : 0}
            <span className="font-sm">%</span>
          </>
        ) : (
          ""
        )}
      </td>
      {mergeSupplementary && (
        <td className="text-center row-data">
          {isProcSource && skill.echoDamage > 0 ? (
            showFullValues ? (
              skill.echoDamage.toLocaleString()
            ) : (
              <>
                {echoDmg}
                <span className="unit font-sm">{echoDmgUnit}</span>
              </>
            )
          ) : (
            ""
          )}
        </td>
      )}
      <td className="text-center row-data">
        {isProcSource ? (
          <>
            {skill.hits > 0 ? ((skill.echoHits / skill.hits) * 100).toFixed(0) : 0}
            <span className="font-sm">%</span>
          </>
        ) : (
          ""
        )}
      </td>
```

Replace the single damage bar `<div className="damage-bar" ... />` with three segments (supp/echo widths are 0 when the toggle is off, so nothing extra renders):

```tsx
      <div className="damage-bar" style={{ backgroundColor: color, width: `${ownPercentage}%` }} />
      {(skill.suppPercentage ?? 0) > 0 && (
        <div
          className="damage-bar damage-bar-supp"
          style={{ backgroundColor: color, left: `${ownPercentage}%`, width: `${skill.suppPercentage}%` }}
        />
      )}
      {(skill.echoPercentage ?? 0) > 0 && (
        <div
          className="damage-bar damage-bar-echo"
          style={{
            backgroundColor: color,
            left: `${ownPercentage + (skill.suppPercentage ?? 0)}%`,
            width: `${skill.echoPercentage}%`,
          }}
        />
      )}
```

- [ ] **Step 4: Group row (same treatment)**

Replace `src/components/useSkillGroupRow.tsx` with:

```ts
import { useMeterSettingsStore } from "@/stores/useMeterSettingsStore";
import { ComputedSkillGroup } from "@/types";
import { humanizeNumbers } from "@/utils";
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";

export const useSkillGroupRow = (group: ComputedSkillGroup) => {
  const { show_full_values, merge_supplementary } = useMeterSettingsStore(
    useShallow((state) => ({
      show_full_values: state.show_full_values,
      merge_supplementary: state.merge_supplementary,
    }))
  );

  const [expanded, setExpanded] = useState(false);

  const rawTotalDamage = group.totalDisplayDamage ?? group.totalDamage;
  const [totalDamage, totalDamageUnit] = humanizeNumbers(rawTotalDamage);
  const [minDmg, minDmgUnit] = humanizeNumbers(group.minDamage || 0);
  const [maxDmg, maxDmgUnit] = humanizeNumbers(group.maxDamage || 0);
  const rawAverageDmg = group.hits === 0 ? 0 : rawTotalDamage / group.hits;
  const [averageDmg, averageDmgUnit] = humanizeNumbers(rawAverageDmg);
  const [suppDmg, suppDmgUnit] = humanizeNumbers(group.suppDamage);
  const [echoDmg, echoDmgUnit] = humanizeNumbers(group.echoDamage);
  const ownPercentage = group.percentage - (group.suppPercentage ?? 0) - (group.echoPercentage ?? 0);

  const sortedSkills = (group.skills || []).sort((a, b) => b.totalDisplayDamage - a.totalDisplayDamage);

  return {
    showFullValues: show_full_values,
    mergeSupplementary: merge_supplementary,
    rawTotalDamage,
    totalDamage,
    totalDamageUnit,
    minDmg,
    minDmgUnit,
    maxDmg,
    maxDmgUnit,
    rawAverageDmg,
    averageDmg,
    averageDmgUnit,
    suppDmg,
    suppDmgUnit,
    echoDmg,
    echoDmgUnit,
    ownPercentage,
    expanded,
    setExpanded,
    sortedSkills,
  };
};
```

In `SkillGroupRow.tsx`: extend the hook destructure with `mergeSupplementary, rawTotalDamage, suppDmg, suppDmgUnit, echoDmg, echoDmgUnit, ownPercentage`; change the full-value Total branch from `group.totalDamage.toLocaleString()` to `rawTotalDamage.toLocaleString()`; insert these four cells between the Avg cell and the Cap cell (groups only ever contain `Normal` skills, so no proc-source guard is needed):

```tsx
        {mergeSupplementary && (
          <td className="text-center row-data">
            {group.suppDamage > 0 ? (
              showFullValues ? (
                group.suppDamage.toLocaleString()
              ) : (
                <>
                  {suppDmg}
                  <span className="unit font-sm">{suppDmgUnit}</span>
                </>
              )
            ) : (
              ""
            )}
          </td>
        )}
        <td className="text-center row-data">
          {group.hits > 0 ? ((group.suppHits / group.hits) * 100).toFixed(0) : 0}
          <span className="font-sm">%</span>
        </td>
        {mergeSupplementary && (
          <td className="text-center row-data">
            {group.echoDamage > 0 ? (
              showFullValues ? (
                group.echoDamage.toLocaleString()
              ) : (
                <>
                  {echoDmg}
                  <span className="unit font-sm">{echoDmgUnit}</span>
                </>
              )
            ) : (
              ""
            )}
          </td>
        )}
        <td className="text-center row-data">
          {group.hits > 0 ? ((group.echoHits / group.hits) * 100).toFixed(0) : 0}
          <span className="font-sm">%</span>
        </td>
```

and replace its damage bar with the same three-segment block as `SkillRow`, using the group's fields:

```tsx
        <div className="damage-bar" style={{ backgroundColor: color, width: `${ownPercentage}%` }} />
        {(group.suppPercentage ?? 0) > 0 && (
          <div
            className="damage-bar damage-bar-supp"
            style={{ backgroundColor: color, left: `${ownPercentage}%`, width: `${group.suppPercentage}%` }}
          />
        )}
        {(group.echoPercentage ?? 0) > 0 && (
          <div
            className="damage-bar damage-bar-echo"
            style={{
              backgroundColor: color,
              left: `${ownPercentage + (group.suppPercentage ?? 0)}%`,
              width: `${group.echoPercentage}%`,
            }}
          />
        )}
```

- [ ] **Step 5: CSS**

In `src/App.css`, after the `.table .damage-bar` rules (line ~161):

```css
.table .damage-bar-supp {
  opacity: 0.55;
}

.table .damage-bar-echo {
  opacity: 0.3;
}
```

(`.skill-row.nested .damage-bar` brightness still applies on top — nested segments stay consistent.)

- [ ] **Step 6: Typecheck, lint, tests**

Run: `npm run build && npm run lint && npm run test`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/SkillBreakdown.tsx src/components/useSkillRow.ts src/components/SkillRow.tsx src/components/useSkillGroupRow.tsx src/components/SkillGroupRow.tsx src/App.css
git commit -m "feat(ui): supp/echo columns, merge toggle rendering, segmented damage bars"
```

---

### Task 7: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Rust suite**

Run: `cargo test -p gbfr-logs`
Expected: PASS.

Run: `cargo clippy -p gbfr-logs`
Expected: no new warnings in `skill_state.rs` / `player_state.rs`.

- [ ] **Step 2: Frontend suite**

Run: `npm run build && npm run lint && npm run test`
Expected: PASS.

- [ ] **Step 3: Behavioral check against real data**

Run the app (`npm run tauri dev` — build needs `hook.dll` present; see the `building-gbfr-logs` project skill if the Tauri build complains) and open an existing post-patch log (ids 230+ in `src-tauri/logs.db`) in the logs window:

1. Toggle OFF: skill rows show Supp% / Echo% (roughly 60–100% on main skills for a supplementary build); Supplementary Damage row present and blank in those columns.
2. Toggle ON (Settings → "Merge Supplementary/Echo into skills"): Supplementary Damage row disappears (or shrinks to a small residual), Supp/Echo damage columns appear, Total grows accordingly, rows re-sort, bars show lighter tail segments.
3. Player's total damage and the encounter total are identical under both toggle states.
4. Live check if the game is running: the meter updates with the same columns during an encounter.

- [ ] **Step 4: Final commit if any fixups were needed**

```bash
git add -A && git commit -m "fix: post-verification fixups for supp/echo attribution"
```

(Skip if the working tree is clean.)
