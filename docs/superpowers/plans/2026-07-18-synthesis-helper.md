# Synthesis Helper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Toolbox page in the logs window whose first tool, Synthesis Helper, reads the running game's memory and answers: "which two of my sigils do I synthesize to get trait X + trait Y (optionally level-15 roll)?"

**Architecture:** A pure Rust prediction engine (port of the game's synthesis algorithm, fully reverse-engineered — see spec `docs/superpowers/specs/2026-07-18-synthesis-helper-design.md`) + a read-only process-memory snapshot reader in the Tauri backend + a React Toolbox page. The hook DLL is untouched.

**Tech Stack:** Rust (pelite sigscan, windows-rs ReadProcessMemory), Tauri commands, React + Mantine + i18next, Vitest.

---

## Reverse-engineered algorithm (reference for all tasks)

Everything below was decompiled from game v2.0.2 (Ghidra `gbfr202fast` DB) and the RNG slot argument confirmed by disassembly. Function RVAs: commit = `0x1ce5e80`, prospect generator = `0x402eda0`, RNG = `0x38f310`.

**Globals** (each a pointer-sized global holding a heap pointer):
- `MGR` (sigil manager) — v2.0.2 RVA `0x7c20940`
- `RNG` (shared RNG object) — v2.0.2 RVA `0x7c23e40`

Resolve them by sigscan (verified: 1 match / 2 matches that agree):
- `COMMIT_SIG = "55 41 57 41 56 41 55 41 54 56 57 53 48 81 ec ? ? 00 00 48 8d ac 24 80 00 00 00 48 c7 85 ? ? 00 00 fe ff ff ff 48 8b 3d ' ? ? ? ? 48 8b 05"` → cursor at the `mov rdi,[rip+disp]` disp32; `MGR_RVA = cursor + 4 + disp` (wrapping u32 add).
- `RNG_SIG = "48 8b 0d ' ? ? ? ? ba 81 00 00 00 e8"` → each match: `RNG_RVA = cursor + 4 + disp`. Multiple matches are fine; all must compute the same RVA.

**RNG** = xorshift32, one u32 of state per "slot": `s ^= s<<13; s ^= s>>17; s ^= s<<15;` returns the new state. Synthesis uses slot `0x81` → state u32 at `RNG_ptr + 0x204`. If state is 0 the game reseeds from entropy (unpredictable — surface as a warning). `RNG_ptr + 0x20c` is a slot-override index, normally `0xffffffff`.

**MGR struct offsets** (all maps are MSVC `std::unordered_map`: header `{load_factor f32 @+0, sentinel_node* @+8, size u64 @+0x10, buckets @+0x18, mask @+0x30}`; node `{link0* @+0, link1* @+8, key @+0x10, value @+0x14 or +0x18}`; enumerate by walking node = `*sentinel`, following `+0` until back at sentinel):

| offset | what | node layout |
|---|---|---|
| `+0x000` | item-config map: item id → record ptr | key u32 @0x10, record* @0x18; `record+8` = i32 "record level" |
| `+0x180` | level-roll weight map: ranksum → weights | key u32 @0x10, val* @0x18 → `{lo u32, hi u32}` |
| `+0x240` | trait id → result sigil item id | key u32 @0x10, item id u32 inline @0x14 |
| `+0x2d8` | u32 seed counter (feeds warm-up; reseeds slot 0x81 after each synthesis) | — |
| `+0x2e0` | pair-counter map: pairKey u64 → count | key u64 @0x10, count u32 inline @0x18 |
| `+0x37f80` | sigil instance map: uid → value ptr | key u32 @0x10, val* @0x18 → `{trait1 u32, lvl1 u32, trait2 u32, lvl2 u32, item_id u32}` |

Empty-trait sentinel: `0x887ae0b0`.

**Synthesis of sigils A, B** (uids; algorithm is symmetric in A/B):

```
tsum(s)   = (t1 == EMPTY ? 0 : t1) + (t2 == EMPTY ? 0 : t2)          // u64 sums of u32s
rank(s)   = (t1 == EMPTY ? 0 : lvl1) + (t2 == EMPTY ? 0 : lvl2)      // u32
pairKey   = tsum(A) + tsum(B) + u64(u32(recLevel(A) + recLevel(B)))  // recLevel = record+8 via item_id
n         = pairCounters.get(pairKey).unwrap_or(0) + 1               // game then stores n back
warm      = (u64(u32(n*9)) + pairKey + u64(seedCounter)) % 1000
s = rng_state; repeat warm times: s = xorshift32(s)
(lo, hi)  = weights.get(rank(A)+rank(B)).unwrap_or((0,0))
s = xorshift32(s)                                                    // level roll draw (always)
lucky     = lo+hi > 0 && (s % (lo+hi)) >= lo                         // lucky → level-15 variant
cand      = non-EMPTY of [t1A,t2A,t1B,t2B]  (duplicates KEPT)
sort cand ascending (u32)
for i in 0..cand.len():                                              // Fisher-Yates
    s = xorshift32(s); r = s
    if r >= (len-i) as u32 { r %= (len-i) as u32 }
    swap(cand[i], cand[i + r])
result traits = cand[0] (slot 1), cand[1] (slot 2, absent if len==1)
result item id = traitToItem.get(cand[0])
```

Predictions hold until the RNG state changes: any synthesis (state is reset to `seedCounter`, pair counter increments) or quest completion (seed changes). The UI must say "refresh after synthesizing or completing a quest".

**Validation caveat:** live validation must run with the Smart Synthesis mod removed or its "Force Selected Prospect" toggled OFF — the mod overwrites the very result we predict.

---

### Task 1: Prediction engine — types, xorshift32, predict()

**Files:**
- Create: `src-tauri/src/synthesis/mod.rs`
- Modify: `src-tauri/src/lib.rs` (add `pub mod synthesis;` after `pub mod parser;` — the crate has a lib target that main.rs and the examples both consume)

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/synthesis/mod.rs` with the types and empty stubs plus tests. Reference vectors were computed independently (Python) from the decompiled algorithm.

```rust
//! Sigil Synthesis prediction engine.
//!
//! Pure port of the game's synthesis algorithm (v2.0.2, reverse-engineered —
//! see docs/superpowers/specs/2026-07-18-synthesis-helper-design.md). The
//! snapshot module reads the inputs from game memory; everything here is
//! deterministic and unit-testable.

pub mod snapshot;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// The game's "no trait in this slot" sentinel.
pub const EMPTY_TRAIT: u32 = 0x887a_e0b0;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SynthesisSigil {
    /// Per-copy instance uid (map key in the sigil manager).
    pub uid: u32,
    /// The sigil's item id (GEEN_* hash) — translatable via `sigils.json`.
    pub sigil_id: u32,
    pub trait1: u32,
    pub trait1_level: u32,
    pub trait2: u32,
    pub trait2_level: u32,
    /// `record+8` of the sigil's item-config record; feeds the warm-up count.
    #[serde(skip)]
    pub record_level: i32,
}

#[derive(Debug, Default)]
pub struct SynthesisSnapshot {
    /// xorshift32 state of RNG slot 0x81 at snapshot time.
    pub rng_state: u32,
    /// MGR+0x2d8; part of the warm-up count.
    pub seed_counter: u32,
    /// pairKey -> times this pair-shape has been synthesized.
    pub pair_counters: HashMap<u64, u32>,
    /// rank(A)+rank(B) -> (lo, hi) level-roll weights.
    pub level_weights: HashMap<u32, (u32, u32)>,
    /// first result trait -> result sigil item id.
    pub trait_to_item: HashMap<u32, u32>,
    pub sigils: Vec<SynthesisSigil>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prediction {
    pub trait1: u32,
    pub trait2: Option<u32>,
    /// true = the weighted roll hit the upgraded (level-15) outcome.
    pub lucky: bool,
}

/// One step of the game's per-slot RNG. Returns the new state, which is also
/// the drawn value.
#[inline]
pub fn xorshift32(mut s: u32) -> u32 {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 15;
    s
}

fn trait_sum(s: &SynthesisSigil) -> u64 {
    let t1 = if s.trait1 == EMPTY_TRAIT { 0 } else { s.trait1 as u64 };
    let t2 = if s.trait2 == EMPTY_TRAIT { 0 } else { s.trait2 as u64 };
    t1 + t2
}

fn rank(s: &SynthesisSigil) -> u32 {
    let l1 = if s.trait1 == EMPTY_TRAIT { 0 } else { s.trait1_level };
    let l2 = if s.trait2 == EMPTY_TRAIT { 0 } else { s.trait2_level };
    l1.wrapping_add(l2)
}

pub fn predict(snap: &SynthesisSnapshot, a: &SynthesisSigil, b: &SynthesisSigil) -> Prediction {
    todo!()
}
```

Append the test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn sigil(uid: u32, t1: u32, l1: u32, t2: u32, l2: u32, rec: i32) -> SynthesisSigil {
        SynthesisSigil {
            uid,
            sigil_id: 0,
            trait1: t1,
            trait1_level: l1,
            trait2: t2,
            trait2_level: l2,
            record_level: rec,
        }
    }

    /// Reference sequence computed independently from the decompiled
    /// algorithm: s=1 -> 0x1000a001, 0x45000201, 0x451080a1, 0x10150a23, ...
    #[test]
    fn xorshift32_reference_sequence() {
        let mut s = 1u32;
        let expect = [0x1000a001u32, 0x45000201, 0x451080a1, 0x10150a23, 0x2814b28b];
        for e in expect {
            s = xorshift32(s);
            assert_eq!(s, e);
        }
    }

    /// Full predict() against an independently computed fixture:
    /// A = {t 0x100 l11, t 0x200 l15, rec 5}, B = {t 0x300 l12, empty, rec 7}
    /// pair_key = 0x100+0x200+0x300+(5+7) = 1548; counters empty -> n=1;
    /// seed_counter = 42 -> warm = (9+1548+42) % 1000 = 599.
    /// rng_state = 123456789; weights {38: (3,7)}.
    /// Expected (Python reference): lucky = true, result = [0x300, 0x200] (0x100 last).
    #[test]
    fn predict_reference_fixture() {
        let a = sigil(0xA, 0x100, 11, 0x200, 15, 5);
        let b = sigil(0xB, 0x300, 12, EMPTY_TRAIT, 0, 7);
        let mut snap = SynthesisSnapshot {
            rng_state: 123_456_789,
            seed_counter: 42,
            ..Default::default()
        };
        snap.level_weights.insert(38, (3, 7));
        let p = predict(&snap, &a, &b);
        assert_eq!(p.trait1, 0x300);
        assert_eq!(p.trait2, Some(0x200));
        assert!(p.lucky);
    }

    /// The algorithm only sums the two sigils' contributions — order must not matter.
    #[test]
    fn predict_is_symmetric() {
        let a = sigil(0xA, 0x100, 11, 0x200, 15, 5);
        let b = sigil(0xB, 0x300, 12, 0x400, 3, 7);
        let mut snap = SynthesisSnapshot {
            rng_state: 0xdead_beef,
            seed_counter: 7,
            ..Default::default()
        };
        snap.level_weights.insert(41, (10, 1));
        assert_eq!(predict(&snap, &a, &b), predict(&snap, &b, &a));
    }

    /// Missing weight entry (or lo+hi == 0) can never be lucky, but the level
    /// draw still advances the stream before the shuffle.
    #[test]
    fn predict_no_weights_is_never_lucky() {
        let a = sigil(0xA, 0x100, 11, 0x200, 15, 5);
        let b = sigil(0xB, 0x300, 12, EMPTY_TRAIT, 0, 7);
        let snap = SynthesisSnapshot {
            rng_state: 123_456_789,
            seed_counter: 42,
            ..Default::default()
        };
        let p = predict(&snap, &a, &b);
        assert!(!p.lucky);
        // Same draws as the reference fixture -> same shuffle outcome.
        assert_eq!(p.trait1, 0x300);
        assert_eq!(p.trait2, Some(0x200));
    }

    /// A pair counter shifts the warm-up by 9 per prior synthesis.
    #[test]
    fn predict_pair_counter_changes_warmup() {
        let a = sigil(0xA, 0x100, 11, 0x200, 15, 5);
        let b = sigil(0xB, 0x300, 12, EMPTY_TRAIT, 0, 7);
        let mut snap = SynthesisSnapshot {
            rng_state: 123_456_789,
            seed_counter: 42,
            ..Default::default()
        };
        let base = predict(&snap, &a, &b);
        snap.pair_counters.insert(1548, 3); // n becomes 4 -> warm = 626 instead of 599
        let shifted = predict(&snap, &a, &b);
        assert_ne!(base, shifted);
        // Python reference for warm=626: result [0x200, 0x300, 0x100]
        assert_eq!(shifted.trait1, 0x200);
        assert_eq!(shifted.trait2, Some(0x300));
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p gbfr-logs synthesis 2>&1 | tail -20`
Expected: compile error (`snapshot` module missing). Create an empty `src-tauri/src/synthesis/snapshot.rs` containing only `//! Game-memory snapshot reader (Task 3).` and re-run.
Expected: `predict_reference_fixture` and the other predict tests FAIL with `not yet implemented` panic; `xorshift32_reference_sequence` PASSES.

Also add `pub mod synthesis;` in `src-tauri/src/lib.rs` after `pub mod parser;` or the module won't compile at all.

- [ ] **Step 3: Implement predict()**

Replace the `todo!()`:

```rust
pub fn predict(snap: &SynthesisSnapshot, a: &SynthesisSigil, b: &SynthesisSigil) -> Prediction {
    let pair_key = trait_sum(a)
        + trait_sum(b)
        + (a.record_level.wrapping_add(b.record_level) as u32) as u64;
    let n = snap.pair_counters.get(&pair_key).copied().unwrap_or(0).wrapping_add(1);
    let warm = (n.wrapping_mul(9) as u64)
        .wrapping_add(pair_key)
        .wrapping_add(snap.seed_counter as u64)
        % 1000;

    let mut s = snap.rng_state;
    for _ in 0..warm {
        s = xorshift32(s);
    }

    let (lo, hi) = snap
        .level_weights
        .get(&rank(a).wrapping_add(rank(b)))
        .copied()
        .unwrap_or((0, 0));
    s = xorshift32(s); // the level roll always draws, even with no weights
    let lucky = lo + hi > 0 && (s % (lo + hi)) >= lo;

    let mut cand: Vec<u32> = [a.trait1, a.trait2, b.trait1, b.trait2]
        .into_iter()
        .filter(|&t| t != EMPTY_TRAIT)
        .collect();
    cand.sort_unstable();
    let len = cand.len();
    for i in 0..len {
        s = xorshift32(s);
        let rem = (len - i) as u32;
        let mut r = s;
        if r >= rem {
            r %= rem;
        }
        cand.swap(i, i + r as usize);
    }

    Prediction {
        trait1: cand[0],
        trait2: cand.get(1).copied(),
        lucky,
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p gbfr-logs synthesis 2>&1 | tail -10`
Expected: all 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/synthesis/mod.rs src-tauri/src/synthesis/snapshot.rs src-tauri/src/lib.rs
git commit -m "feat: synthesis prediction engine (xorshift32 + predict)"
```

### Task 2: Engine search()

**Files:**
- Modify: `src-tauri/src/synthesis/mod.rs`

- [ ] **Step 1: Write the failing tests**

Add to the tests module:

```rust
    fn search_snap() -> SynthesisSnapshot {
        let mut snap = SynthesisSnapshot {
            rng_state: 123_456_789,
            seed_counter: 42,
            ..Default::default()
        };
        snap.trait_to_item.insert(0x300, 0x9999);
        snap.sigils = vec![
            sigil(1, 0x100, 11, 0x200, 15, 5),
            sigil(2, 0x300, 12, EMPTY_TRAIT, 0, 7),
            sigil(3, 0x500, 10, 0x600, 10, 4),
        ];
        snap
    }

    /// Pair (1,2) is the reference fixture -> predicts (0x300, 0x200).
    #[test]
    fn search_finds_matching_pair() {
        let snap = search_snap();
        let q = SynthesisQuery {
            trait1: 0x300,
            trait2: Some(0x200),
            any_order: false,
            require_lucky: false,
        };
        let (matches, tested, total) = search(&snap, &q, 100);
        assert_eq!(total, 1);
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].sigil_a.uid, 1);
        assert_eq!(matches[0].sigil_b.uid, 2);
        assert_eq!(matches[0].result_sigil_id, Some(0x9999));
        // pairs (1,3) and (2,3) can't produce 0x300+0x200 together; only (1,2) is tested
        assert_eq!(tested, 1);
    }

    /// Exact order excludes the swapped outcome; any_order accepts it.
    #[test]
    fn search_order_toggle() {
        let snap = search_snap();
        let exact = SynthesisQuery { trait1: 0x200, trait2: Some(0x300), any_order: false, require_lucky: false };
        let (m, _, total) = search(&snap, &exact, 100);
        assert_eq!(total, 0);
        assert!(m.is_empty());
        let any = SynthesisQuery { trait1: 0x200, trait2: Some(0x300), any_order: true, require_lucky: false };
        let (m, _, total) = search(&snap, &any, 100);
        assert_eq!(total, 1);
        assert_eq!(m.len(), 1);
    }

    /// require_lucky filters out normal rolls (fixture has no weights -> never lucky).
    #[test]
    fn search_require_lucky() {
        let snap = search_snap();
        let q = SynthesisQuery { trait1: 0x300, trait2: Some(0x200), any_order: false, require_lucky: true };
        let (m, _, total) = search(&snap, &q, 100);
        assert_eq!(total, 0);
        assert!(m.is_empty());
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p gbfr-logs synthesis 2>&1 | tail -10`
Expected: compile error — `SynthesisQuery`/`search`/`SynthesisMatch` undefined.

- [ ] **Step 3: Implement search**

Add above the tests module:

```rust
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SynthesisQuery {
    pub trait1: u32,
    pub trait2: Option<u32>,
    pub any_order: bool,
    pub require_lucky: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SynthesisMatch {
    pub sigil_a: SynthesisSigil,
    pub sigil_b: SynthesisSigil,
    pub prediction: Prediction,
    /// Item id of the result sigil (for display), when known.
    pub result_sigil_id: Option<u32>,
}

/// Test every unordered pair whose combined traits could contain the queried
/// ones; return (matches up to `cap`, pairs actually predicted, total matches).
pub fn search(
    snap: &SynthesisSnapshot,
    q: &SynthesisQuery,
    cap: usize,
) -> (Vec<SynthesisMatch>, u64, u64) {
    let has = |s: &SynthesisSigil, t: u32| s.trait1 == t || s.trait2 == t;
    let wanted = |p: &Prediction| -> bool {
        if q.require_lucky && !p.lucky {
            return false;
        }
        match q.trait2 {
            None => p.trait1 == q.trait1 || (q.any_order && p.trait2 == Some(q.trait1)),
            Some(t2) => {
                let exact = p.trait1 == q.trait1 && p.trait2 == Some(t2);
                let swapped = p.trait1 == t2 && p.trait2 == Some(q.trait1);
                exact || (q.any_order && swapped)
            }
        }
    };

    let mut matches = Vec::new();
    let (mut tested, mut total) = (0u64, 0u64);
    for i in 0..snap.sigils.len() {
        for j in (i + 1)..snap.sigils.len() {
            let (a, b) = (&snap.sigils[i], &snap.sigils[j]);
            if !has(a, q.trait1) && !has(b, q.trait1) {
                continue;
            }
            if let Some(t2) = q.trait2 {
                if !has(a, t2) && !has(b, t2) {
                    continue;
                }
            }
            tested += 1;
            let p = predict(snap, a, b);
            if wanted(&p) {
                total += 1;
                if matches.len() < cap {
                    matches.push(SynthesisMatch {
                        sigil_a: a.clone(),
                        sigil_b: b.clone(),
                        prediction: p,
                        result_sigil_id: snap.trait_to_item.get(&p.trait1).copied(),
                    });
                }
            }
        }
    }
    (matches, tested, total)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p gbfr-logs synthesis 2>&1 | tail -10`
Expected: all 8 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/synthesis/mod.rs
git commit -m "feat: synthesis pair search over a snapshot"
```

### Task 3: Snapshot reader (game process memory)

**Files:**
- Modify: `src-tauri/Cargo.toml` (add deps)
- Modify: `src-tauri/src/synthesis/snapshot.rs` (replace stub)

No unit tests here — this module is thin I/O against a live process; it is validated by the Task 4 diag example against the running game. Keep ALL parsing/derivation logic out of it (that lives in `mod.rs`).

- [ ] **Step 1: Add dependencies**

In `src-tauri/Cargo.toml` `[dependencies]` add (same versions the hook crate uses):

```toml
pelite = "0.10.0"
windows = { version = "0.52.0", features = [
  "Win32_Foundation",
  "Win32_System_Diagnostics_Debug",
  "Win32_System_Diagnostics_ToolHelp",
  "Win32_System_Threading",
] }
```

- [ ] **Step 2: Implement the reader**

Replace `src-tauri/src/synthesis/snapshot.rs` with:

```rust
//! Read-only snapshot of the game's synthesis state via ReadProcessMemory.
//!
//! Global RVAs are resolved by sigscanning the exe on disk (pelite), cached
//! per exe path. All reads are bounds-checked; a torn/absurd read fails the
//! snapshot rather than producing wrong predictions.

use super::{SynthesisSigil, SynthesisSnapshot};
use anyhow::{bail, Context, Result};
use pelite::pattern;
use pelite::pe64::{Pe, PeFile};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::Diagnostics::Debug::ReadProcessMemory;
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Module32FirstW, Process32FirstW, Process32NextW, MODULEENTRY32W,
    PROCESSENTRY32W, TH32CS_SNAPMODULE, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ};

const GAME_EXE: &str = "granblue_fantasy_relink.exe";

// Cursor lands on the disp32 of `mov rdi/rcx, [rip+disp]`; global RVA = cursor + 4 + disp.
const COMMIT_SIG: &str = "55 41 57 41 56 41 55 41 54 56 57 53 48 81 ec ? ? 00 00 48 8d ac 24 80 00 00 00 48 c7 85 ? ? 00 00 fe ff ff ff 48 8b 3d ' ? ? ? ? 48 8b 05";
const RNG_SIG: &str = "48 8b 0d ' ? ? ? ? ba 81 00 00 00 e8";

// Sigil-manager offsets (see plan header table).
const MGR_ITEM_MAP: u64 = 0x0;
const MGR_WEIGHT_MAP: u64 = 0x180;
const MGR_TRAIT_ITEM_MAP: u64 = 0x240;
const MGR_SEED_COUNTER: u64 = 0x2d8;
const MGR_PAIR_MAP: u64 = 0x2e0;
const MGR_UID_MAP: u64 = 0x37f80;
const RNG_SYNTH_STATE: u64 = 0x81 * 4; // slot 0x81
const RNG_SLOT_OVERRIDE: u64 = 0x20c;

const MAX_MAP_ENTRIES: u64 = 500_000;

struct Mem(HANDLE);

impl Mem {
    fn read(&self, addr: u64, buf: &mut [u8]) -> Result<()> {
        let mut got = 0usize;
        unsafe {
            ReadProcessMemory(
                self.0,
                addr as *const _,
                buf.as_mut_ptr() as *mut _,
                buf.len(),
                Some(&mut got),
            )
        }
        .ok()
        .with_context(|| format!("read {:#x} ({} bytes)", addr, buf.len()))?;
        if got != buf.len() {
            bail!("short read at {addr:#x}");
        }
        Ok(())
    }
    fn u64(&self, addr: u64) -> Result<u64> {
        let mut b = [0u8; 8];
        self.read(addr, &mut b)?;
        Ok(u64::from_le_bytes(b))
    }
    fn u32(&self, addr: u64) -> Result<u32> {
        let mut b = [0u8; 4];
        self.read(addr, &mut b)?;
        Ok(u32::from_le_bytes(b))
    }
    fn i32(&self, addr: u64) -> Result<i32> {
        Ok(self.u32(addr)? as i32)
    }
}

impl Drop for Mem {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

fn wide_to_string(w: &[u16]) -> String {
    let end = w.iter().position(|&c| c == 0).unwrap_or(w.len());
    String::from_utf16_lossy(&w[..end])
}

/// Find the game process id, or None if it isn't running.
fn find_game_pid() -> Result<Option<u32>> {
    let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }?;
    let snap = Mem(snap); // reuse Drop for CloseHandle
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let mut ok = unsafe { Process32FirstW(snap.0, &mut entry) }.is_ok();
    while ok {
        if wide_to_string(&entry.szExeFile).eq_ignore_ascii_case(GAME_EXE) {
            return Ok(Some(entry.th32ProcessID));
        }
        ok = unsafe { Process32NextW(snap.0, &mut entry) }.is_ok();
    }
    Ok(None)
}

/// Main-module (exe) base address and on-disk path.
fn module_base(pid: u32) -> Result<(u64, PathBuf)> {
    let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPMODULE, pid) }?;
    let snap = Mem(snap);
    let mut entry = MODULEENTRY32W {
        dwSize: std::mem::size_of::<MODULEENTRY32W>() as u32,
        ..Default::default()
    };
    unsafe { Module32FirstW(snap.0, &mut entry) }.context("Module32FirstW")?;
    Ok((
        entry.modBaseAddr as u64,
        PathBuf::from(wide_to_string(&entry.szExePath)),
    ))
}

/// Sigscan the on-disk exe for the two globals. Cached: the path+result pair
/// survives for the process lifetime (the exe only changes on a game patch,
/// which requires a game restart anyway).
fn resolve_globals(exe: &Path) -> Result<(u32, u32)> {
    static CACHE: OnceLock<(PathBuf, (u32, u32))> = OnceLock::new();
    if let Some((p, rvas)) = CACHE.get() {
        if p == exe {
            return Ok(*rvas);
        }
    }
    let data = std::fs::read(exe).with_context(|| format!("read {}", exe.display()))?;
    let pe = PeFile::from_bytes(&data).context("parse exe")?;

    let rva_from_cursor = |cursor: u32| -> Result<u32> {
        let disp = u32::from_le_bytes(
            pe.derva_slice::<u8>(cursor, 4)
                .map_err(|e| anyhow::anyhow!("derva {cursor:#x}: {e:?}"))?
                .try_into()
                .unwrap(),
        );
        Ok(cursor.wrapping_add(4).wrapping_add(disp))
    };

    let scan = |sig: &str| -> Result<Vec<u32>> {
        let pat = pattern::parse(sig).context("parse pattern")?;
        let mut out = Vec::new();
        let mut matches = pe.scanner().matches_code(&pat);
        let mut save = [0u32; 8];
        while matches.next(&mut save) {
            out.push(save[1]);
        }
        Ok(out)
    };

    let commit = scan(COMMIT_SIG)?;
    if commit.len() != 1 {
        bail!("commit signature matched {} times (game patched?)", commit.len());
    }
    let mgr_rva = rva_from_cursor(commit[0])?;

    let rng_cursors = scan(RNG_SIG)?;
    if rng_cursors.is_empty() {
        bail!("rng signature matched 0 times (game patched?)");
    }
    let mut rng_rvas: Vec<u32> = Vec::new();
    for c in rng_cursors {
        rng_rvas.push(rva_from_cursor(c)?);
    }
    rng_rvas.dedup();
    if rng_rvas.len() != 1 {
        bail!("rng signature resolved to conflicting globals {rng_rvas:x?}");
    }
    let rvas = (mgr_rva, rng_rvas[0]);
    let _ = CACHE.set((exe.to_path_buf(), rvas));
    Ok(rvas)
}

/// Walk an MSVC std::unordered_map's node list. `header` is the address of
/// the map header ({lf, sentinel*, size, ...}); calls `f(node_addr)` per node.
fn walk_map(mem: &Mem, header: u64, mut f: impl FnMut(u64) -> Result<()>) -> Result<()> {
    let sentinel = mem.u64(header + 8)?;
    if sentinel == 0 {
        bail!("map at {header:#x} has null sentinel");
    }
    let size = mem.u64(header + 0x10)?;
    if size > MAX_MAP_ENTRIES {
        bail!("map at {header:#x} claims {size} entries");
    }
    let mut node = mem.u64(sentinel)?;
    let mut visited = 0u64;
    while node != sentinel {
        f(node)?;
        visited += 1;
        if visited > size {
            bail!("map walk at {header:#x} overran its size ({size})");
        }
        node = mem.u64(node)?;
    }
    Ok(())
}

/// Take a full synthesis snapshot. Ok(None) = game not running.
pub fn take_snapshot() -> Result<Option<SynthesisSnapshot>> {
    let Some(pid) = find_game_pid()? else {
        return Ok(None);
    };
    let handle =
        unsafe { OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, false, pid) }
            .context("OpenProcess (run as admin?)")?;
    let mem = Mem(handle);
    let (base, exe) = module_base(pid)?;
    let (mgr_rva, rng_rva) = resolve_globals(&exe)?;

    let mgr = mem.u64(base + mgr_rva as u64)?;
    let rng = mem.u64(base + rng_rva as u64)?;
    if mgr == 0 || rng == 0 {
        bail!("synthesis globals not initialized yet (still on title screen?)");
    }

    let mut snap = SynthesisSnapshot {
        rng_state: mem.u32(rng + RNG_SYNTH_STATE)?,
        seed_counter: mem.u32(mgr + MGR_SEED_COUNTER)?,
        ..Default::default()
    };
    let slot_override = mem.u32(rng + RNG_SLOT_OVERRIDE)?;
    if slot_override != u32::MAX {
        // All draws would come from another slot; predictions would be wrong.
        bail!("rng slot override active ({slot_override:#x}) — unsupported");
    }

    // item id -> record level (needed for the warm-up pairKey)
    let mut record_levels: HashMap<u32, i32> = HashMap::new();
    walk_map(&mem, mgr + MGR_ITEM_MAP, |node| {
        let item_id = mem.u32(node + 0x10)?;
        let record = mem.u64(node + 0x18)?;
        if record != 0 {
            record_levels.insert(item_id, mem.i32(record + 8)?);
        }
        Ok(())
    })?;

    walk_map(&mem, mgr + MGR_WEIGHT_MAP, |node| {
        let key = mem.u32(node + 0x10)?;
        let val = mem.u64(node + 0x18)?;
        if val != 0 {
            snap.level_weights.insert(key, (mem.u32(val)?, mem.u32(val + 4)?));
        }
        Ok(())
    })?;

    walk_map(&mem, mgr + MGR_TRAIT_ITEM_MAP, |node| {
        let trait_id = mem.u32(node + 0x10)?;
        snap.trait_to_item.insert(trait_id, mem.u32(node + 0x14)?);
        Ok(())
    })?;

    walk_map(&mem, mgr + MGR_PAIR_MAP, |node| {
        let key = mem.u64(node + 0x10)?;
        snap.pair_counters.insert(key, mem.u32(node + 0x18)?);
        Ok(())
    })?;

    walk_map(&mem, mgr + MGR_UID_MAP, |node| {
        let uid = mem.u32(node + 0x10)?;
        let val = mem.u64(node + 0x18)?;
        if val == 0 {
            return Ok(());
        }
        let mut b = [0u8; 20];
        mem.read(val, &mut b)?;
        let f = |i: usize| u32::from_le_bytes(b[i..i + 4].try_into().unwrap());
        let sigil_id = f(16);
        snap.sigils.push(SynthesisSigil {
            uid,
            sigil_id,
            trait1: f(0),
            trait1_level: f(4),
            trait2: f(8),
            trait2_level: f(12),
            record_level: record_levels.get(&sigil_id).copied().unwrap_or(0),
        });
        Ok(())
    })?;

    Ok(Some(snap))
}
```

- [ ] **Step 3: Verify it compiles and existing tests still pass**

Run: `cargo test -p gbfr-logs synthesis 2>&1 | tail -10`
Expected: compiles, all 8 tests PASS.
Run: `cargo clippy -p gbfr-logs 2>&1 | tail -5`
Expected: no new warnings in `synthesis/`.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/Cargo.toml Cargo.lock src-tauri/src/synthesis/snapshot.rs
git commit -m "feat: synthesis snapshot reader (process memory, sigscan-resolved globals)"
```

### Task 4: Diag example + live snapshot validation

**Files:**
- Create: `src-tauri/examples/synth_diag.rs`

- [ ] **Step 1: Write the example**

```rust
//! Live diagnostic for the synthesis snapshot + engine.
//!
//! Usage (game running, as admin):
//!   cargo run -p gbfr-logs --example synth_diag            # snapshot summary
//!   cargo run -p gbfr-logs --example synth_diag <uidA> <uidB>   # predict one pair (hex uids)

use gbfr_logs::synthesis::{self, snapshot};

fn main() -> anyhow::Result<()> {
    let snap = match snapshot::take_snapshot()? {
        Some(s) => s,
        None => {
            println!("game not running");
            return Ok(());
        }
    };
    println!(
        "rng_state={:#010x} seed_counter={} sigils={} pair_counters={} weights={} trait_to_item={}",
        snap.rng_state,
        snap.seed_counter,
        snap.sigils.len(),
        snap.pair_counters.len(),
        snap.level_weights.len(),
        snap.trait_to_item.len(),
    );
    let mut weights: Vec<_> = snap.level_weights.iter().collect();
    weights.sort();
    println!("weights: {weights:?}");
    for s in snap.sigils.iter().take(10) {
        println!(
            "  uid={:#010x} sigil={:#010x} t1={:#010x} l{} t2={:#010x} l{} rec={}",
            s.uid, s.sigil_id, s.trait1, s.trait1_level, s.trait2, s.trait2_level, s.record_level
        );
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let [a, b] = args.as_slice() {
        let parse = |s: &str| u32::from_str_radix(s.trim_start_matches("0x"), 16).unwrap();
        let (ua, ub) = (parse(a), parse(b));
        let find = |uid: u32| snap.sigils.iter().find(|s| s.uid == uid).expect("uid not found");
        let p = synthesis::predict(&snap, find(ua), find(ub));
        println!("prediction: trait1={:#010x} trait2={:x?} lucky={}", p.trait1, p.trait2, p.lucky);
    }
    Ok(())
}
```

Note: `src-tauri/src/lib.rs` already exposes the crate as a library (existing examples do `use gbfr_logs::parser::...`), and Task 1 added `pub mod synthesis;` there, so this import path just works.

- [ ] **Step 2: Build the example**

Run: `cargo build -p gbfr-logs --example synth_diag 2>&1 | tail -3`
Expected: builds clean.

- [ ] **Step 3: Live validation (needs the game running — coordinate with Scott)**

This is the milestone-1 gate. With the game running (Smart Synthesis mod OFF/removed), from an elevated shell:

1. `cargo run -p gbfr-logs --example synth_diag` — expect: plausible sigil count (~3000), nonzero rng_state, weights table with keys in the ~20–60 range, sanity-check a few known sigils against the in-game sigil list.
2. Open the synthesis menu, pick two sigils, note their identities; find their uids in the dump (match by trait pair + levels); run `synth_diag <uidA> <uidB>`; note the prediction.
3. Perform that exact synthesis in-game; compare the received sigil's two traits (order matters) and whether it was the upgraded level. All three must match.
4. Re-run `synth_diag` (fresh snapshot), predict another pair, synthesize, compare — proves the post-synthesis state (seed reset + counter bump) is read correctly.
5. Complete any quick quest, re-run, predict, synthesize, compare — proves quest reseeding is captured.

Record outcomes (values + pass/fail) in the memory file (Task 8). If step 3 mismatches, debug order-of-draws first (warm count, then level draw, then shuffle) by comparing successive snapshots.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/examples/synth_diag.rs
git commit -m "feat: synth_diag example for live synthesis validation"
```

### Task 5: Tauri commands

**Files:**
- Modify: `src-tauri/src/synthesis/mod.rs` (response types)
- Modify: `src-tauri/src/main.rs` (commands + registration)

- [ ] **Step 1: Add response types to `synthesis/mod.rs`**

```rust
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SynthesisStatus {
    pub game_running: bool,
    pub sigil_count: u32,
    /// True when RNG state is 0 (the game will reseed from entropy — unpredictable).
    pub rng_unpredictable: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SynthesisSearchResponse {
    pub matches: Vec<SynthesisMatch>,
    pub pairs_tested: u64,
    pub total_matches: u64,
    pub sigil_count: u32,
    pub rng_unpredictable: bool,
}
```

- [ ] **Step 2: Add commands in `main.rs`** (near the other `#[tauri::command]` fns). main.rs consumes the lib crate, so add `use gbfr_logs::synthesis;` beside its existing `use gbfr_logs::...` imports.

```rust
/// Toolbox / Synthesis Helper: snapshot the game's synthesis state and report
/// whether predictions are currently possible.
#[tauri::command(async)]
fn fetch_synthesis_status() -> Result<synthesis::SynthesisStatus, String> {
    match synthesis::snapshot::take_snapshot() {
        Ok(None) => Ok(synthesis::SynthesisStatus {
            game_running: false,
            sigil_count: 0,
            rng_unpredictable: false,
        }),
        Ok(Some(snap)) => Ok(synthesis::SynthesisStatus {
            game_running: true,
            sigil_count: snap.sigils.len() as u32,
            rng_unpredictable: snap.rng_state == 0,
        }),
        Err(e) => Err(e.to_string()),
    }
}

/// Toolbox / Synthesis Helper: fresh snapshot + exhaustive pair search.
#[tauri::command(async)]
fn search_synthesis(
    query: synthesis::SynthesisQuery,
) -> Result<synthesis::SynthesisSearchResponse, String> {
    let snap = synthesis::snapshot::take_snapshot()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "game-not-running".to_string())?;
    let (matches, pairs_tested, total_matches) = synthesis::search(&snap, &query, 500);
    Ok(synthesis::SynthesisSearchResponse {
        matches,
        pairs_tested,
        total_matches,
        sigil_count: snap.sigils.len() as u32,
        rng_unpredictable: snap.rng_state == 0,
    })
}
```

Register both in the `tauri::generate_handler![...]` list (main.rs:785): add `fetch_synthesis_status, search_synthesis,` after `reset_encounter`.

- [ ] **Step 3: Verify compile + tests**

Run: `cargo test -p gbfr-logs synthesis 2>&1 | tail -5` — all PASS.
Run: `cargo clippy -p gbfr-logs 2>&1 | tail -3` — no new warnings.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/synthesis/mod.rs src-tauri/src/main.rs
git commit -m "feat: fetch_synthesis_status + search_synthesis Tauri commands"
```

### Task 6: Frontend types, i18n strings

**Files:**
- Modify: `src/types.ts`
- Modify: `src-tauri/lang/en/ui.json`

- [ ] **Step 1: Mirror the Rust types in `src/types.ts`** (append at the end, matching the file's existing doc-comment style)

```ts
/** Toolbox / Synthesis Helper — mirrors src-tauri/src/synthesis/mod.rs. */
export type SynthesisSigil = {
  uid: number;
  sigilId: number;
  trait1: number;
  trait1Level: number;
  trait2: number;
  trait2Level: number;
};

export type SynthesisPrediction = {
  trait1: number;
  trait2: number | null;
  lucky: boolean;
};

export type SynthesisMatch = {
  sigilA: SynthesisSigil;
  sigilB: SynthesisSigil;
  prediction: SynthesisPrediction;
  resultSigilId: number | null;
};

export type SynthesisStatus = {
  gameRunning: boolean;
  sigilCount: number;
  rngUnpredictable: boolean;
};

export type SynthesisSearchResponse = {
  matches: SynthesisMatch[];
  pairsTested: number;
  totalMatches: number;
  sigilCount: number;
  rngUnpredictable: boolean;
};
```

Note: serde serializes `trait1_level` as `trait1Level`; keep exactly these names.

- [ ] **Step 2: Add UI strings** — in `src-tauri/lang/en/ui.json`, inside the top-level `"ui"` object (sibling of `"logs"`), add:

```json
"toolbox": {
  "title": "Toolbox",
  "synthesis-helper": "Synthesis Helper",
  "trait-1": "Trait 1 (first slot)",
  "trait-2": "Trait 2 (second slot)",
  "any-order": "Match either slot order",
  "require-lucky": "High roll only (higher-level result)",
  "search": "Search",
  "searching": "Searching...",
  "game-not-running": "Game is not running. Start Granblue Fantasy: Relink first — the helper reads your sigil box and the synthesis seed from the game.",
  "rng-unpredictable": "The synthesis RNG has no seed yet. Perform one synthesis or complete a quest, then search again.",
  "results-caveat": "Predictions are for your next synthesis only. Completing a quest or synthesizing anything changes the seed — search again after either.",
  "pairs-summary": "{{sigils}} sigils, {{tested}} pairs simulated, {{matches}} matching",
  "no-results": "No pair in your sigil box produces this result with the current seed. Try again after the next quest.",
  "truncated": "Showing the first {{shown}} of {{total}} matches.",
  "col-sigil-a": "Sigil A",
  "col-sigil-b": "Sigil B",
  "col-result": "Result",
  "high-roll": "high roll",
  "select-trait": "Select a trait..."
}
```

(Only `ui.json` may be hand-edited per repo conventions; other languages fall back to `en`.)

- [ ] **Step 3: Verify**

Run: `npm run build 2>&1 | tail -3`
Expected: tsc + vite succeed.
Run: `python -c "import json; json.load(open('src-tauri/lang/en/ui.json')); print('ok')"`
Expected: `ok`.

- [ ] **Step 4: Commit**

```bash
git add src/types.ts src-tauri/lang/en/ui.json
git commit -m "feat: synthesis helper frontend types + UI strings"
```

### Task 7: Toolbox page, routes, header button

**Files:**
- Create: `src/pages/Toolbox.tsx`
- Modify: `src/App.tsx`
- Modify: `src/pages/Logs.tsx`

- [ ] **Step 1: Create `src/pages/Toolbox.tsx`**

```tsx
import { Box, Flex, NavLink } from "@mantine/core";
import { Flask } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import { Link, Outlet, useLocation } from "react-router-dom";

/** Toolbox: fixed 300px tool menu on the left, the selected tool on the right. */
const ToolboxPage = () => {
  const { t } = useTranslation();
  const { pathname } = useLocation();

  return (
    <Flex gap="md" align="flex-start">
      <Box w={300} style={{ flexShrink: 0 }}>
        <NavLink
          component={Link}
          to="/logs/toolbox/synthesis"
          label={t("ui.toolbox.synthesis-helper", "Synthesis Helper")}
          leftSection={<Flask size="1rem" />}
          active={pathname.startsWith("/logs/toolbox/synthesis")}
        />
      </Box>
      <Box style={{ flexGrow: 1, minWidth: 0 }}>
        <Outlet />
      </Box>
    </Flex>
  );
};

export default ToolboxPage;
```

- [ ] **Step 2: Routes in `src/App.tsx`**

Add imports:

```tsx
import { Navigate } from "react-router-dom"; // extend the existing react-router-dom import
import ToolboxPage from "./pages/Toolbox";
import SynthesisHelper from "./pages/toolbox/SynthesisHelper";
```

Inside the `/logs` route, before the `:id` route (so "toolbox" isn't captured as an id):

```tsx
<Route path="toolbox" element={<ToolboxPage />}>
  <Route index element={<Navigate to="synthesis" replace />} />
  <Route path="synthesis" element={<SynthesisHelper />} />
</Route>
```

(`SynthesisHelper` is created in Task 8 — create it as a stub first if executing tasks strictly in order: `const SynthesisHelper = () => <div />; export default SynthesisHelper;` in `src/pages/toolbox/SynthesisHelper.tsx`.)

- [ ] **Step 3: Header button in `src/pages/Logs.tsx`**

Left of the Settings button (before its `<Button ...to="/logs/settings">` block) add:

```tsx
<Button
  variant="subtle"
  color="gray"
  size="compact-sm"
  leftSection={<Wrench size="1rem" />}
  component={Link}
  to="/logs/toolbox"
>
  Toolbox
</Button>
```

Add `Wrench` to the `@phosphor-icons/react` import. Also update the tab-active logic so Quests doesn't highlight on the toolbox page (Logs.tsx:53):

```tsx
const questsActive =
  !confluxActive && !pathname.startsWith("/logs/settings") && !pathname.startsWith("/logs/toolbox");
```

- [ ] **Step 4: Verify**

Run: `npm run build 2>&1 | tail -3` — clean.
Run: `npm run lint 2>&1 | tail -3` — clean.

- [ ] **Step 5: Commit**

```bash
git add src/pages/Toolbox.tsx src/pages/toolbox/SynthesisHelper.tsx src/App.tsx src/pages/Logs.tsx
git commit -m "feat: Toolbox page with side menu + header nav button"
```

### Task 8: Synthesis Helper panel

**Files:**
- Create: `src/pages/toolbox/useSynthesisHelper.ts`
- Create/replace: `src/pages/toolbox/SynthesisHelper.tsx`
- Create: `src/pages/toolbox/useSynthesisHelper.test.ts`

- [ ] **Step 1: Write the failing test** (`src/pages/toolbox/useSynthesisHelper.test.ts`)

```ts
import { describe, expect, it } from "vitest";

import { buildQuery } from "./useSynthesisHelper";

describe("buildQuery", () => {
  it("parses hex trait values and maps the form to the backend query", () => {
    expect(
      buildQuery({ trait1: "0114dd91", trait2: "01b49f0d", anyOrder: true, requireLucky: false })
    ).toEqual({
      trait1: 0x0114dd91,
      trait2: 0x01b49f0d,
      anyOrder: true,
      requireLucky: false,
    });
  });

  it("returns null without a first trait, and null trait2 when unset", () => {
    expect(buildQuery({ trait1: null, trait2: null, anyOrder: false, requireLucky: false })).toBeNull();
    expect(
      buildQuery({ trait1: "0114dd91", trait2: null, anyOrder: false, requireLucky: true })
    ).toEqual({ trait1: 0x0114dd91, trait2: null, anyOrder: false, requireLucky: true });
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run src/pages/toolbox/useSynthesisHelper.test.ts`
Expected: FAIL (module not found). Never use `npm run test` (watch mode, never exits).

- [ ] **Step 3: Implement the hook** (`src/pages/toolbox/useSynthesisHelper.ts`)

```ts
import { SynthesisSearchResponse, SynthesisStatus } from "@/types";
import { invoke } from "@tauri-apps/api";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

export type SynthesisForm = {
  /** Trait ids as 8-hex strings (the `traits:` bundle key space), or null. */
  trait1: string | null;
  trait2: string | null;
  anyOrder: boolean;
  requireLucky: boolean;
};

export type SynthesisQueryPayload = {
  trait1: number;
  trait2: number | null;
  anyOrder: boolean;
  requireLucky: boolean;
};

/** Form -> backend query; null when the form is incomplete (no first trait). */
export const buildQuery = (form: SynthesisForm): SynthesisQueryPayload | null => {
  if (!form.trait1) return null;
  return {
    trait1: parseInt(form.trait1, 16),
    trait2: form.trait2 ? parseInt(form.trait2, 16) : null,
    anyOrder: form.anyOrder,
    requireLucky: form.requireLucky,
  };
};

/**
 * State + handlers for the Synthesis Helper tool: a trait-pair query form,
 * the live game status, and the search results.
 */
export default function useSynthesisHelper() {
  // Re-render when the traits bundle loads / language changes (same pattern
  // as useChecklistSettings).
  const { i18n } = useTranslation("traits");
  const [form, setForm] = useState<SynthesisForm>({
    trait1: null,
    trait2: null,
    anyOrder: false,
    requireLucky: false,
  });
  const [status, setStatus] = useState<SynthesisStatus | null>(null);
  const [response, setResponse] = useState<SynthesisSearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    invoke<SynthesisStatus>("fetch_synthesis_status")
      .then(setStatus)
      .catch((e) => setError(String(e)));
  }, []);

  const traitOptions = (): { value: string; label: string }[] => {
    const bundle = (i18n.getResourceBundle(i18n.language, "traits") ??
      i18n.getResourceBundle("en", "traits") ??
      {}) as Record<string, { text?: string }>;
    return Object.entries(bundle)
      .filter(([, value]) => Boolean(value?.text))
      .map(([hex, value]) => ({ value: hex, label: value.text as string }))
      .sort((a, b) => a.label.localeCompare(b.label));
  };

  const search = async () => {
    const query = buildQuery(form);
    if (!query) return;
    setSearching(true);
    setError(null);
    try {
      setResponse(await invoke<SynthesisSearchResponse>("search_synthesis", { query }));
    } catch (e) {
      setResponse(null);
      setError(String(e));
    } finally {
      setSearching(false);
    }
  };

  return { form, setForm, status, response, error, searching, traitOptions, search };
}
```

- [ ] **Step 4: Run the test again**

Run: `npx vitest run src/pages/toolbox/useSynthesisHelper.test.ts`
Expected: PASS (2 tests). If the `@tauri-apps/api` import breaks under vitest, check how existing tests handle it (`src/pages/ChecklistSection.test.tsx` mocks); `buildQuery` is exported standalone so the test only needs the module to import cleanly.

- [ ] **Step 5: Implement the panel** (`src/pages/toolbox/SynthesisHelper.tsx`, replacing the Task 7 stub)

```tsx
import { translateSigilId, translateTraitId } from "@/utils";
import { Alert, Badge, Button, Checkbox, Group, Select, Stack, Table, Text, Title } from "@mantine/core";
import { useTranslation } from "react-i18next";

import { SynthesisMatch, SynthesisSigil } from "@/types";

import useSynthesisHelper from "./useSynthesisHelper";

const SigilCell = ({ sigil }: { sigil: SynthesisSigil }) => (
  <Stack gap={0}>
    <Text size="sm">{translateSigilId(sigil.sigilId)}</Text>
    <Text size="xs" c="dimmed">
      {translateTraitId(sigil.trait1)} Lv{sigil.trait1Level}
      {translateTraitId(sigil.trait2) && ` / ${translateTraitId(sigil.trait2)} Lv${sigil.trait2Level}`}
    </Text>
  </Stack>
);

const ResultCell = ({ match }: { match: SynthesisMatch }) => {
  const { t } = useTranslation();
  const { prediction, resultSigilId } = match;
  return (
    <Group gap="xs">
      <Stack gap={0}>
        {resultSigilId !== null && <Text size="sm">{translateSigilId(resultSigilId)}</Text>}
        <Text size="xs" c="dimmed">
          {translateTraitId(prediction.trait1)}
          {prediction.trait2 !== null && ` / ${translateTraitId(prediction.trait2)}`}
        </Text>
      </Stack>
      {prediction.lucky && <Badge color="yellow">{t("ui.toolbox.high-roll", "high roll")}</Badge>}
    </Group>
  );
};

const SynthesisHelper = () => {
  const { t } = useTranslation();
  const { form, setForm, status, response, error, searching, traitOptions, search } = useSynthesisHelper();
  const options = traitOptions();

  return (
    <Stack gap="md" pr="md">
      <Title order={4}>{t("ui.toolbox.synthesis-helper", "Synthesis Helper")}</Title>
      {status && !status.gameRunning && (
        <Alert color="yellow">{t("ui.toolbox.game-not-running")}</Alert>
      )}
      {(status?.rngUnpredictable || response?.rngUnpredictable) && (
        <Alert color="orange">{t("ui.toolbox.rng-unpredictable")}</Alert>
      )}
      {error && <Alert color="red">{error}</Alert>}
      <Group align="flex-end" gap="sm">
        <Select
          label={t("ui.toolbox.trait-1", "Trait 1 (first slot)")}
          placeholder={t("ui.toolbox.select-trait", "Select a trait...")}
          searchable
          clearable
          data={options}
          value={form.trait1}
          onChange={(value) => setForm({ ...form, trait1: value })}
          w={260}
        />
        <Select
          label={t("ui.toolbox.trait-2", "Trait 2 (second slot)")}
          placeholder={t("ui.toolbox.select-trait", "Select a trait...")}
          searchable
          clearable
          data={options}
          value={form.trait2}
          onChange={(value) => setForm({ ...form, trait2: value })}
          w={260}
        />
        <Checkbox
          label={t("ui.toolbox.any-order", "Match either slot order")}
          checked={form.anyOrder}
          onChange={(e) => setForm({ ...form, anyOrder: e.currentTarget.checked })}
        />
        <Checkbox
          label={t("ui.toolbox.require-lucky", "High roll only (higher-level result)")}
          checked={form.requireLucky}
          onChange={(e) => setForm({ ...form, requireLucky: e.currentTarget.checked })}
        />
        <Button onClick={search} loading={searching} disabled={!form.trait1}>
          {t("ui.toolbox.search", "Search")}
        </Button>
      </Group>
      {response && (
        <Stack gap="xs">
          <Text size="sm" c="dimmed">
            {t("ui.toolbox.pairs-summary", {
              sigils: response.sigilCount,
              tested: response.pairsTested,
              matches: response.totalMatches,
            })}
          </Text>
          <Text size="xs" c="dimmed">
            {t("ui.toolbox.results-caveat")}
          </Text>
          {response.totalMatches === 0 && <Text>{t("ui.toolbox.no-results")}</Text>}
          {response.totalMatches > response.matches.length && (
            <Text size="xs" c="dimmed">
              {t("ui.toolbox.truncated", { shown: response.matches.length, total: response.totalMatches })}
            </Text>
          )}
          {response.matches.length > 0 && (
            <Table striped highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t("ui.toolbox.col-sigil-a", "Sigil A")}</Table.Th>
                  <Table.Th>{t("ui.toolbox.col-sigil-b", "Sigil B")}</Table.Th>
                  <Table.Th>{t("ui.toolbox.col-result", "Result")}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {response.matches.map((match) => (
                  <Table.Tr key={`${match.sigilA.uid}-${match.sigilB.uid}`}>
                    <Table.Td>
                      <SigilCell sigil={match.sigilA} />
                    </Table.Td>
                    <Table.Td>
                      <SigilCell sigil={match.sigilB} />
                    </Table.Td>
                    <Table.Td>
                      <ResultCell match={match} />
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
        </Stack>
      )}
    </Stack>
  );
};

export default SynthesisHelper;
```

- [ ] **Step 6: Verify**

Run: `npx vitest run` — all suites PASS.
Run: `npm run build 2>&1 | tail -3` — clean.
Run: `npm run lint 2>&1 | tail -3` — clean.

- [ ] **Step 7: Commit**

```bash
git add src/pages/toolbox/
git commit -m "feat: Synthesis Helper tool (trait query, live search, results table)"
```

### Task 9: End-to-end validation + memory

- [ ] **Step 1: Full app run (needs the game + Scott)**

`npm run tauri dev`, open the logs window → Toolbox → Synthesis Helper:
1. Game closed: page shows the "game not running" alert; search returns the same error.
2. Game running: pick a trait pair known to exist in the box, Search; verify plausible pairs appear with real sigil/trait names and the summary line.
3. Ground truth: synthesize a listed pair in-game (mod off); received sigil must match the predicted traits (in slot order) and level class. If Task 4's validation passed, this should too — a mismatch here means the command path (serde field names, caps) diverged, not the engine.

- [ ] **Step 2: Save memory + handoff**

Write a new auto-memory file `gbfr-synthesis-helper.md` (type: project) recording: the algorithm summary, MGR/RNG RVAs + offsets table, signature strings, validation results (which pairs, pass/fail), and any offsets that needed correction during live validation. Link it from `MEMORY.md`.

- [ ] **Step 3: Final commit**

```bash
git add -A docs/ && git commit -m "docs: synthesis helper validation notes"
```

---

## Self-review notes

- Spec coverage: engine (Tasks 1–2), snapshot via ReadProcessMemory with sigscan resolution + error handling (Task 3), validation plan incl. mod-off caveat (Tasks 4, 9), Tauri commands (Task 5), Toolbox UI at `/logs/toolbox` with 300px menu + header button left of Settings (Tasks 6–8), result-validity messaging (`results-caveat` string). Fallback mode ("possible outcomes only") intentionally NOT built — only needed if live validation fails; decide then.
- The `0x2d7f2e70` fallback item id from the decompile is deliberately unused: `trait_to_item.get()` returning `None` renders as traits-only, which is more honest than a magic id.
- Known risk, called out in Task 4: draw order (warm → level → shuffle) and the `record_level` source were derived from decompilation; live validation step 3 exercises every term (warm count via pairKey/counters/seed, level roll via weights, shuffle via candidates). Mismatch debugging starts there.
