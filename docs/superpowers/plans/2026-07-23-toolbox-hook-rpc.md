# Toolbox via Hook RPC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the two Toolbox tools (Synthesis Helper, Overmastery Predictor) from inside the injected hook over a new request/response channel, on Windows and Linux, replacing the out-of-process `ReadProcessMemory` path.

**Architecture:** A dedicated RPC listener in the hook (duplex named pipe `\\.\pipe\gbfr-logs-toolbox` on Windows, TCP 127.0.0.1:39372 under Wine), one request per connection, bincode over length-delimited frames. The snapshot walkers move to a new platform-independent `game-reader` crate generic over a `MemRead` trait; the hook implements it with guarded in-process reads, the diag probes keep an RPM-backed impl as independent ground truth. The prediction/search engines are untouched.

**Tech Stack:** Rust (nightly), tokio + tokio-util codec, interprocess 2.0 (duplex pipes), pelite (PeView in-memory / PeFile on-disk sigscan), Tauri v1, React/TS frontend.

**Spec:** `docs/superpowers/specs/2026-07-23-toolbox-hook-rpc-design.md`

**Branch:** `feat/toolbox-hook-rpc` off `dev`. Do NOT use a git worktree (CLAUDE.md). Do NOT push to `dev` directly (every push publishes an RC). The working tree has unrelated untracked files (`linux-instructions.md`, `virus-total-result.json`, modified keep-above docs) — never `git add` them.

**Verified facts this plan relies on:** interprocess is pinned at 2.0.1 (Cargo.lock) and provides `PipeListenerOptions::create_tokio_duplex::<pipe_mode::Bytes>()` and `DuplexPipeStream::<pipe_mode::Bytes>::connect_by_path`; `src-hook/src/hooks/mod.rs` declares `pub mod diag`, and `diag::readable` is `pub(crate)`, so `crate::hooks::diag::readable` is reachable from a new root module; `pelite::pe64::Pe<'a>` is implemented by both `PeFile<'a>` and `PeView<'a>` (both `Copy`); the probes call only `snapshot::take_snapshot()` (om_probe.rs:27, synth_probe.rs:42, synth_diag.rs:10), never the seed reads.

**Never use `npm run test`** (watch mode, never exits) — use `npx vitest run`.

---

## File map

| File | Change |
|---|---|
| `Cargo.toml` (workspace) | Add `game-reader`, `protocol` to members |
| `protocol/src/lib.rs` | Register `pub mod toolbox;`, extend crate doc |
| `protocol/src/toolbox.rs` | NEW — RPC constants, request/response enums, snapshot data types |
| `game-reader/Cargo.toml` | NEW crate |
| `game-reader/src/lib.rs` | NEW — `MemRead` trait, RE'd constants, sig helpers, `FakeMem` test support |
| `game-reader/src/synthesis.rs` | NEW — synthesis walkers (moved from src-tauri) + tests |
| `game-reader/src/overmastery.rs` | NEW — overmastery walkers (moved from src-tauri) + tests |
| `src-hook/Cargo.toml` | Add `game-reader` dep |
| `src-hook/src/toolbox.rs` | NEW — RPC server, in-process `MemRead`, lazy global resolution |
| `src-hook/src/lib.rs` | Spawn the toolbox listener |
| `src-tauri/Cargo.toml` | Add `game-reader` dep |
| `src-tauri/src/lib.rs` | Ungate `synthesis`/`overmastery`, add `toolbox_rpc` |
| `src-tauri/src/toolbox_rpc.rs` | NEW — RPC client, `HookStatus`, error-slug mapping |
| `src-tauri/src/game_mem.rs` | Shrink to diag-only RPM plumbing + `rpm_*` snapshot wrappers |
| `src-tauri/src/synthesis/mod.rs` | Types from protocol, RNG helpers from game-reader, drop snapshot mod |
| `src-tauri/src/synthesis/snapshot.rs` | DELETE (moved to game-reader) |
| `src-tauri/src/overmastery/mod.rs` | Same treatment |
| `src-tauri/src/overmastery/snapshot.rs` | DELETE (moved to game-reader) |
| `src-tauri/src/main.rs` | Rewrite six toolbox commands (no cfg split), `HookStatus` wiring in connect loop |
| `src-tauri/examples/om_probe.rs`, `synth_probe.rs`, `synth_diag.rs` | Call `game_mem::rpm_*` instead of `snapshot::` |
| `src-tauri/examples/toolbox_probe.rs` | NEW — RPC vs RPM A/B harness |
| `src/backendErrors.ts` | `hook-outdated` / `hook-unreachable` slugs |
| `src-tauri/lang/en/ui.json` | Two new strings |
| `src/pages/Toolbox.tsx` | Remove `windowsOnly` flags |
| `src/types.ts` | Add `recordLevel` to `SynthesisSigil` |
| `.github/workflows/ci.yaml` | Test `game-reader` in the Linux job |
| `CLAUDE.md` | Architecture section: new crate + RPC channel |

---

### Task 1: Branch

- [ ] **Step 1:** `git checkout dev && git checkout -b feat/toolbox-hook-rpc`
- [ ] **Step 2:** `git status` — confirm only the pre-existing unrelated files are dirty (`linux-instructions.md`, `virus-total-result.json`, `docs/superpowers/specs/2026-07-22-linux-keep-above-design.md`, `docs/superpowers/plans/2026-07-22-linux-keep-above.md`). Leave them alone for the whole branch.

---

### Task 2: Protocol — RPC types and constants

**Files:**
- Create: `protocol/src/toolbox.rs`
- Modify: `protocol/src/lib.rs`
- Modify: `Cargo.toml` (workspace root)

- [ ] **Step 1: Add workspace members.** In root `Cargo.toml` replace:

```toml
members = [
  "src-hook",
  "src-tauri"
]
```

with:

```toml
members = [
  "game-reader",
  "protocol",
  "src-hook",
  "src-tauri"
]
```

(`game-reader` doesn't exist until Task 3; create an empty placeholder now so the workspace parses: `game-reader/Cargo.toml` with `[package] name = "game-reader" version = "0.1.0" edition = "2021"` and an empty `game-reader/src/lib.rs`. Task 3 fills them in.)

- [ ] **Step 2: Write the failing test.** Create `protocol/src/toolbox.rs` with ONLY this test module for now:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    /// The wire is bincode both ways; a round-trip through it is the whole
    /// serialization contract.
    #[test]
    fn request_and_response_round_trip_through_bincode() {
        let req = ToolboxRequest::OvermasterySlot(0x42);
        let bytes = bincode::serialize(&req).unwrap();
        assert_eq!(bincode::deserialize::<ToolboxRequest>(&bytes).unwrap(), req);

        let snap = SynthesisSnapshot {
            rng_state: 1,
            seed_counter: 2,
            pair_counters: [(3u64, 4u32)].into_iter().collect(),
            level_weights: [(5u32, (6u32, 7u32))].into_iter().collect(),
            trait_to_item: [(8u32, 9u32)].into_iter().collect(),
            sigils: vec![SynthesisSigil {
                uid: 1,
                sigil_id: 2,
                trait1: 3,
                trait1_level: 11,
                trait2: 4,
                trait2_level: 15,
                record_level: 5,
            }],
        };
        let resp = ToolboxResponse::SynthesisSnapshot(Ok(snap));
        let bytes = bincode::serialize(&resp).unwrap();
        let back: ToolboxResponse = bincode::deserialize(&bytes).unwrap();
        let ToolboxResponse::SynthesisSnapshot(Ok(back)) = back else {
            panic!("wrong variant");
        };
        // record_level MUST cross the wire (it feeds the warm-up pairKey);
        // this catches anyone re-adding the old #[serde(skip)].
        assert_eq!(back.sigils[0].record_level, 5);
    }
}
```

And in `protocol/src/lib.rs` add after the `pub use bincode;` line:

```rust
pub mod toolbox;
```

- [ ] **Step 3: Run** — `cargo test -p protocol` — Expected: FAIL (types not defined).

- [ ] **Step 4: Implement.** Prepend to `protocol/src/toolbox.rs` (above the test module):

```rust
//! The Toolbox RPC channel: on-demand synthesis/overmastery snapshots served
//! by the hook from inside the game process.
//!
//! Separate from the event stream on purpose: events are broadcast to every
//! client, RPC is strictly one request -> one response per CONNECTION (the
//! client connects, sends one frame, reads one frame, closes — no request
//! ids, nothing to resynchronize). Same length-delimited framing and bincode
//! payload as the event stream, so hook and app must be compiled together.
//!
//! These messages never enter the parser's on-disk log format.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Windows RPC endpoint (duplex named pipe).
pub const TOOLBOX_PIPE_NAME: &str = r"\\.\pipe\gbfr-logs-toolbox";
/// Wine/Proton RPC endpoint (`TCP_PORT + 1`).
pub const TOOLBOX_TCP_PORT: u16 = super::TCP_PORT + 1;
pub const TOOLBOX_TCP_ADDR: &str = "127.0.0.1:39372";

/// Bumped on ANY change to the RPC wire shape. The app checks it via `Hello`
/// each time the event stream connects: on Linux the deployed dinput8 proxy
/// can be older than the app until the game restarts, and a bincode mismatch
/// is silent garbage — better "restart the game" than wrong predictions.
pub const TOOLBOX_PROTOCOL_VERSION: u32 = 1;

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolboxRequest {
    Hello,
    SynthesisSnapshot,
    SynthesisSeed,
    OvermasterySnapshot,
    /// Current state of one RNG slot (< RNG_SLOT_COUNT), for staleness polls.
    OvermasterySlot(u32),
}

/// One variant per request. Payload `Err` strings are user-facing (shown by
/// the tools' error banner, unmapped slugs verbatim — see backendErrors.ts).
#[derive(Serialize, Deserialize, Debug, Clone)]
pub enum ToolboxResponse {
    Hello { protocol_version: u32 },
    SynthesisSnapshot(Result<SynthesisSnapshot, String>),
    SynthesisSeed(Result<SynthesisSeed, String>),
    OvermasterySnapshot(Result<OvermasterySnapshot, String>),
    OvermasterySlot(Result<u32, String>),
}

/// One sigil in the box. camelCase because the app also serializes these to
/// the frontend as JSON (bincode ignores field names, so the rename is free
/// on the wire). `record_level` is NOT skipped: it feeds the warm-up pairKey
/// and must cross the RPC wire (the frontend just ignores it).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
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
    pub record_level: i32,
}

#[derive(Serialize, Deserialize, Debug, Default, Clone, PartialEq)]
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

/// The two live values every synthesis prediction depends on (beyond the
/// sigil box itself); read cheaply for staleness polling.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SynthesisSeed {
    pub rng_state: u32,
    pub seed_counter: u32,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct OvermasterySnapshot {
    /// xorshift32 state per RNG slot at snapshot time.
    pub slots: Vec<u32>,
    /// Slot override word (0xffffffff when idle; anything else means a roll
    /// is mid-flight and predictions would race it).
    pub slot_override: u32,
    /// Character id hashes (game custom-XXHash32 of "PL####"), in roster
    /// order; a character's slot index is its position here (protagonists
    /// PL0000/PL0100 are index 0).
    pub roster: Vec<u32>,
}
```

Also extend the crate-level doc comment in `protocol/src/lib.rs`: after the paragraph ending "message types that are ignored by the parser", append:

```text

The `toolbox` module carries the second channel: request/response RPC served
by the hook (snapshots for the Toolbox tools). It shares the compiled-together
rule but never touches the parser's on-disk format.
```

- [ ] **Step 5: Run** — `cargo test -p protocol` — Expected: PASS.

- [ ] **Step 6: Commit** — `git add Cargo.toml Cargo.lock protocol/ game-reader/ && git commit -m "feat(protocol): toolbox RPC channel types and version"`

---

### Task 3: game-reader crate — trait, constants, sig helpers

**Files:**
- Modify: `game-reader/Cargo.toml`
- Modify: `game-reader/src/lib.rs`

- [ ] **Step 1: Fill `game-reader/Cargo.toml`:**

```toml
[package]
name = "game-reader"
version = "0.1.0"
edition = "2021"

[dependencies]
anyhow = "1.0"
pelite = "0.10.0"
protocol = { path = "../protocol" }
```

- [ ] **Step 2: Write failing tests.** `game-reader/src/lib.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    /// Reference sequence computed independently from the decompiled
    /// algorithm (same fixture as the synthesis engine's test).
    #[test]
    fn xorshift32_reference_sequence() {
        let mut s = 1u32;
        let expect = [0x1000a001u32, 0x45000201, 0x451080a1, 0x10150a23];
        for e in expect {
            s = xorshift32(s);
            assert_eq!(s, e);
        }
    }

    #[test]
    fn fake_mem_reads_what_was_put_and_fails_elsewhere() {
        let mut m = FakeMem::default();
        m.put_u32(0x1000, 0xdead_beef);
        use crate::MemRead;
        assert_eq!(m.u32(0x1000).unwrap(), 0xdead_beef);
        assert!(m.u32(0x2000).is_err());
    }
}
```

- [ ] **Step 3: Run** — `cargo test -p game-reader` — Expected: FAIL (nothing defined).

- [ ] **Step 4: Implement.** Prepend to `game-reader/src/lib.rs`:

```rust
//! Platform-independent readers for the game structures behind the Toolbox
//! tools (synthesis, overmastery): the RE'd signatures, struct offsets, and
//! snapshot walkers, generic over [`MemRead`].
//!
//! Two implementations exist: the hook reads in-process (guarded raw copies;
//! the production path on both platforms, served over the toolbox RPC
//! channel), and the diag probes in src-tauri/examples read out-of-process
//! via ReadProcessMemory as an independent ground-truth cross-check.
//! A game patch that moves these structures is fixed HERE, in one place.

use anyhow::{bail, Context, Result};
use pelite::pattern;
use pelite::pe64::Pe;

pub mod overmastery;
pub mod synthesis;

/// The game process/module name (shared by the injector and the probes).
pub const GAME_EXE: &str = "granblue_fantasy_relink.exe";

/// The game's "empty" sentinel hash (no trait in this slot / missing key).
pub const EMPTY_KEY: u32 = 0x887a_e0b0;

/// The RNG slot-array global. Cursor lands on the disp32 of a rip-relative
/// load of the array pointer.
pub const RNG_SIG: &str = "48 8b 0d ' ? ? ? ? ba 81 00 00 00 e8";
/// Number of RNG slots (0..=0x82).
pub const RNG_SLOT_COUNT: usize = 0x83;
/// Offset of the slot-override word, right after the slots (0xffffffff when
/// idle; anything else redirects every draw to that slot).
pub const RNG_SLOT_OVERRIDE: u64 = 0x20c;
const _: () = assert!(RNG_SLOT_OVERRIDE == RNG_SLOT_COUNT as u64 * 4);

/// One step of the game's per-slot RNG. Returns the new state, which is also
/// the drawn value.
#[inline]
pub fn xorshift32(mut s: u32) -> u32 {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 15;
    s
}

/// A bounds-checked window into the game's memory. Implementors must fail
/// (not fault) on unreadable addresses — the walkers chase pointers out of
/// possibly-torn game structures.
pub trait MemRead {
    fn read(&self, addr: u64, buf: &mut [u8]) -> Result<()>;

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

/// Decode the rip-relative disp32 a signature cursor points at:
/// global RVA = cursor + 4 + disp. (`+ Copy` on these helpers because
/// callers reuse the handle across calls — PeFile and PeView are both Copy.)
pub fn rva_from_cursor<'a>(pe: impl Pe<'a> + Copy, cursor: u32) -> Result<u32> {
    let bytes: [u8; 4] = pe
        .derva_slice::<u8>(cursor, 4)
        .map_err(|e| anyhow::anyhow!("derva {cursor:#x}: {e:?}"))?
        .try_into()
        .expect("slice length is 4");
    Ok(cursor
        .wrapping_add(4)
        .wrapping_add(u32::from_le_bytes(bytes)))
}

/// All cursor RVAs matching `sig` (the pattern's save slot 1).
pub fn scan_cursors<'a>(pe: impl Pe<'a> + Copy, sig: &str) -> Result<Vec<u32>> {
    let pat = pattern::parse(sig).context("parse pattern")?;
    let mut out = Vec::new();
    let mut matches = pe.scanner().matches_code(&pat);
    let mut save = [0u32; 8];
    while matches.next(&mut save) {
        out.push(save[1]);
    }
    Ok(out)
}

/// Scan for `sig`, demanding exactly one match; returns the decoded global RVA.
pub fn scan_unique_rva<'a>(pe: impl Pe<'a> + Copy, sig: &str, what: &str) -> Result<u32> {
    let cursors = scan_cursors(pe, sig)?;
    if cursors.len() != 1 {
        bail!(
            "{what} signature matched {} times (game patched?)",
            cursors.len()
        );
    }
    rva_from_cursor(pe, cursors[0])
}

/// The RNG slot-array global. Its signature matches several call sites that
/// must all decode to the same RVA.
pub fn resolve_rng_rva<'a>(pe: impl Pe<'a> + Copy) -> Result<u32> {
    let cursors = scan_cursors(pe, RNG_SIG)?;
    // Distinguish "the signature is gone" from "it points at two different
    // globals" — after a game patch these need very different fixes.
    if cursors.is_empty() {
        bail!("rng signature matched 0 times (game patched?)");
    }
    let mut rvas: Vec<u32> = cursors
        .into_iter()
        .map(|c| rva_from_cursor(pe, c))
        .collect::<Result<_>>()?;
    rvas.dedup();
    if rvas.len() != 1 {
        bail!("rng signature resolved to conflicting globals {rvas:x?} (game patched?)");
    }
    Ok(rvas[0])
}

/// Sparse fake memory for walker tests: every byte must have been `put`, so
/// a walker chasing an address the test didn't stage fails loudly.
#[cfg(test)]
#[derive(Default)]
pub(crate) struct FakeMem(std::collections::HashMap<u64, u8>);

#[cfg(test)]
impl FakeMem {
    pub fn put(&mut self, addr: u64, bytes: &[u8]) {
        for (i, b) in bytes.iter().enumerate() {
            self.0.insert(addr + i as u64, *b);
        }
    }
    pub fn put_u32(&mut self, addr: u64, v: u32) {
        self.put(addr, &v.to_le_bytes());
    }
    pub fn put_u64(&mut self, addr: u64, v: u64) {
        self.put(addr, &v.to_le_bytes());
    }
}

#[cfg(test)]
impl MemRead for FakeMem {
    fn read(&self, addr: u64, buf: &mut [u8]) -> Result<()> {
        for (i, out) in buf.iter_mut().enumerate() {
            *out = *self
                .0
                .get(&(addr + i as u64))
                .with_context(|| format!("fake mem: unmapped byte at {:#x}", addr + i as u64))?;
        }
        Ok(())
    }
}
```

Also create the two empty module files so this compiles: `game-reader/src/synthesis.rs` and `game-reader/src/overmastery.rs` each containing only a placeholder comment `//! Filled in by the next task.` (Tasks 4 and 5 replace them).

- [ ] **Step 5: Run** — `cargo test -p game-reader` — Expected: PASS (2 tests).

- [ ] **Step 6: Commit** — `git add game-reader/ Cargo.lock && git commit -m "feat(game-reader): MemRead trait, RNG constants, generic sig helpers"`

---

### Task 4: game-reader — synthesis walkers

**Files:**
- Replace: `game-reader/src/synthesis.rs`

This is a move of `src-tauri/src/synthesis/snapshot.rs` with three deliberate changes: (1) reads go through `&impl MemRead` instead of the concrete `Mem`; (2) "is the game running / where is it" is the CALLER's job — the functions take `base` + pre-resolved RVAs and return `Result<T>`, not `Result<Option<T>>`; (3) sig resolution is a separate function generic over `Pe` so both PeFile (probes) and PeView (hook) can call it. Do NOT change any offset, signature, or bounds check.

- [ ] **Step 1: Write the walkers + tests.** Replace `game-reader/src/synthesis.rs` entirely with:

```rust
//! Read-only snapshot of the game's synthesis state.
//!
//! All reads are bounds-checked; a torn/absurd read fails the snapshot
//! rather than producing wrong predictions. Offsets are the v2.0.2 layout.

use crate::{resolve_rng_rva, scan_unique_rva, MemRead, RNG_SLOT_OVERRIDE};
use anyhow::{bail, Result};
use pelite::pe64::Pe;
pub use protocol::toolbox::{SynthesisSeed, SynthesisSigil, SynthesisSnapshot};
use std::collections::HashMap;

// Cursor lands on the disp32 of `mov rdi/rcx, [rip+disp]`; global RVA = cursor + 4 + disp.
const COMMIT_SIG: &str = "55 41 57 41 56 41 55 41 54 56 57 53 48 81 ec ? ? 00 00 48 8d ac 24 80 00 00 00 48 c7 85 ? ? 00 00 fe ff ff ff 48 8b 3d ' ? ? ? ? 48 8b 05";

// Sigil-manager struct offsets (v2.0.2 layout).
const MGR_ITEM_MAP: u64 = 0x0;
const MGR_WEIGHT_MAP: u64 = 0x180;
const MGR_TRAIT_ITEM_MAP: u64 = 0x240;
const MGR_SEED_COUNTER: u64 = 0x2d8;
const MGR_PAIR_MAP: u64 = 0x2e0;
const MGR_UID_MAP: u64 = 0x37f80;
const RNG_SYNTH_STATE: u64 = 0x81 * 4; // slot 0x81

const MAX_MAP_ENTRIES: u64 = 500_000;

/// The two globals synthesis needs, as module-relative RVAs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SynthesisRvas {
    pub manager: u32,
    pub rng: u32,
}

/// Sigscan for the two globals (manager + RNG array). Works on a PeFile
/// (on-disk exe, probes) or PeView (loaded image, hook) alike.
pub fn resolve_rvas<'a>(pe: impl Pe<'a> + Copy) -> Result<SynthesisRvas> {
    Ok(SynthesisRvas {
        manager: scan_unique_rva(pe, COMMIT_SIG, "commit")?,
        rng: resolve_rng_rva(pe)?,
    })
}

/// Walk an MSVC std::unordered_map's node list. `header` is the address of
/// the map header ({load_factor, sentinel*, size, ...}); calls `f(node_addr)`
/// for each node ({link, link, key @0x10, value @0x14/0x18}).
fn walk_map(mem: &impl MemRead, header: u64, mut f: impl FnMut(u64) -> Result<()>) -> Result<()> {
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

/// Dereference the two globals, failing while they are still null (title
/// screen). Returns (manager, rng_array) pointers.
fn deref_globals(mem: &impl MemRead, base: u64, rvas: SynthesisRvas) -> Result<(u64, u64)> {
    let mgr = mem.u64(base + rvas.manager as u64)?;
    let rng = mem.u64(base + rvas.rng as u64)?;
    if mgr == 0 || rng == 0 {
        bail!("synthesis globals not initialized yet (still on title screen?)");
    }
    Ok((mgr, rng))
}

/// Light read of just the synthesis seed identity (RNG slot 0x81 state +
/// manager seed counter) for staleness polling — no map walks.
pub fn take_seed_state(mem: &impl MemRead, base: u64, rvas: SynthesisRvas) -> Result<SynthesisSeed> {
    let (mgr, rng) = deref_globals(mem, base, rvas)?;
    Ok(SynthesisSeed {
        rng_state: mem.u32(rng + RNG_SYNTH_STATE)?,
        seed_counter: mem.u32(mgr + MGR_SEED_COUNTER)?,
    })
}

/// Take a full synthesis snapshot.
pub fn take_snapshot(
    mem: &impl MemRead,
    base: u64,
    rvas: SynthesisRvas,
) -> Result<SynthesisSnapshot> {
    let (mgr, rng) = deref_globals(mem, base, rvas)?;

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

    // item id -> record level (feeds the warm-up pairKey)
    let mut record_levels: HashMap<u32, i32> = HashMap::new();
    walk_map(mem, mgr + MGR_ITEM_MAP, |node| {
        let item_id = mem.u32(node + 0x10)?;
        let record = mem.u64(node + 0x18)?;
        if record != 0 {
            record_levels.insert(item_id, mem.i32(record + 8)?);
        }
        Ok(())
    })?;

    walk_map(mem, mgr + MGR_WEIGHT_MAP, |node| {
        let key = mem.u32(node + 0x10)?;
        let val = mem.u64(node + 0x18)?;
        if val != 0 {
            snap.level_weights
                .insert(key, (mem.u32(val)?, mem.u32(val + 4)?));
        }
        Ok(())
    })?;

    walk_map(mem, mgr + MGR_TRAIT_ITEM_MAP, |node| {
        let trait_id = mem.u32(node + 0x10)?;
        snap.trait_to_item.insert(trait_id, mem.u32(node + 0x14)?);
        Ok(())
    })?;

    walk_map(mem, mgr + MGR_PAIR_MAP, |node| {
        let key = mem.u64(node + 0x10)?;
        snap.pair_counters.insert(key, mem.u32(node + 0x18)?);
        Ok(())
    })?;

    walk_map(mem, mgr + MGR_UID_MAP, |node| {
        let uid = mem.u32(node + 0x10)?;
        let val = mem.u64(node + 0x18)?;
        if val == 0 {
            return Ok(());
        }
        let mut b = [0u8; 20];
        mem.read(val, &mut b)?;
        let field = |i: usize| u32::from_le_bytes(b[i..i + 4].try_into().expect("4-byte field"));
        let sigil_id = field(16);
        snap.sigils.push(SynthesisSigil {
            uid,
            sigil_id,
            trait1: field(0),
            trait1_level: field(4),
            trait2: field(8),
            trait2_level: field(12),
            record_level: record_levels.get(&sigil_id).copied().unwrap_or(0),
        });
        Ok(())
    })?;

    Ok(snap)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::FakeMem;

    const BASE: u64 = 0x1_4000_0000;
    const RVAS: SynthesisRvas = SynthesisRvas {
        manager: 0x1000,
        rng: 0x2000,
    };
    const MGR: u64 = 0x5000_0000;
    const RNG: u64 = 0x6000_0000;

    /// Stage an unordered_map at `header` whose chain visits `nodes` in
    /// order. The sentinel is placed at header+0x80 (the walkers never read
    /// near there). Callers stage each node's key/value bytes themselves.
    fn put_map(m: &mut FakeMem, header: u64, nodes: &[u64]) {
        let sentinel = header + 0x80;
        m.put_u64(header + 8, sentinel);
        m.put_u64(header + 0x10, nodes.len() as u64);
        let mut prev = sentinel;
        for &n in nodes {
            m.put_u64(prev, n);
            prev = n;
        }
        m.put_u64(prev, sentinel);
    }

    /// Globals + RNG words + all five maps empty: the smallest valid world.
    fn valid_world() -> FakeMem {
        let mut m = FakeMem::default();
        m.put_u64(BASE + RVAS.manager as u64, MGR);
        m.put_u64(BASE + RVAS.rng as u64, RNG);
        m.put_u32(RNG + RNG_SYNTH_STATE, 0xdead);
        m.put_u32(RNG + RNG_SLOT_OVERRIDE, u32::MAX);
        m.put_u32(MGR + MGR_SEED_COUNTER, 7);
        for off in [
            MGR_ITEM_MAP,
            MGR_WEIGHT_MAP,
            MGR_TRAIT_ITEM_MAP,
            MGR_PAIR_MAP,
            MGR_UID_MAP,
        ] {
            put_map(&mut m, MGR + off, &[]);
        }
        m
    }

    #[test]
    fn seed_state_reads_rng_and_counter() {
        let m = valid_world();
        let seed = take_seed_state(&m, BASE, RVAS).unwrap();
        assert_eq!(seed.rng_state, 0xdead);
        assert_eq!(seed.seed_counter, 7);
    }

    #[test]
    fn null_globals_fail_with_title_screen_hint() {
        let mut m = valid_world();
        m.put_u64(BASE + RVAS.manager as u64, 0);
        let err = take_snapshot(&m, BASE, RVAS).unwrap_err().to_string();
        assert!(err.contains("title screen"), "{err}");
    }

    #[test]
    fn active_slot_override_fails_the_snapshot() {
        let mut m = valid_world();
        m.put_u32(RNG + RNG_SLOT_OVERRIDE, 5);
        let err = take_snapshot(&m, BASE, RVAS).unwrap_err().to_string();
        assert!(err.contains("override"), "{err}");
    }

    #[test]
    fn null_sentinel_fails_the_walk() {
        let mut m = valid_world();
        m.put_u64(MGR + MGR_ITEM_MAP + 8, 0);
        let err = take_snapshot(&m, BASE, RVAS).unwrap_err().to_string();
        assert!(err.contains("null sentinel"), "{err}");
    }

    #[test]
    fn oversized_map_claim_fails_the_walk() {
        let mut m = valid_world();
        m.put_u64(MGR + MGR_ITEM_MAP + 0x10, MAX_MAP_ENTRIES + 1);
        let err = take_snapshot(&m, BASE, RVAS).unwrap_err().to_string();
        assert!(err.contains("claims"), "{err}");
    }

    #[test]
    fn chain_longer_than_declared_size_fails_as_overrun() {
        let mut m = valid_world();
        // One real node in the chain, but the header claims size 0.
        let node = 0x7000_0000u64;
        put_map(&mut m, MGR + MGR_ITEM_MAP, &[node]);
        m.put_u64(MGR + MGR_ITEM_MAP + 0x10, 0);
        m.put_u32(node + 0x10, 1);
        m.put_u64(node + 0x18, 0);
        let err = take_snapshot(&m, BASE, RVAS).unwrap_err().to_string();
        assert!(err.contains("overran"), "{err}");
    }

    #[test]
    fn full_snapshot_joins_uid_map_with_record_levels() {
        let mut m = valid_world();

        // Item map: sigil id 0xAA -> record with level 3 at +8.
        let item_node = 0x7000_0000u64;
        let record = 0x7000_0100u64;
        put_map(&mut m, MGR + MGR_ITEM_MAP, &[item_node]);
        m.put_u32(item_node + 0x10, 0xAA);
        m.put_u64(item_node + 0x18, record);
        m.put_u32(record + 8, 3);

        // Uid map: uid 1 -> 20-byte sigil blob {t1, l1, t2, l2, sigil_id}.
        let uid_node = 0x7000_0200u64;
        let blob = 0x7000_0300u64;
        put_map(&mut m, MGR + MGR_UID_MAP, &[uid_node]);
        m.put_u32(uid_node + 0x10, 1);
        m.put_u64(uid_node + 0x18, blob);
        for (i, v) in [0x11u32, 15, 0x22, 15, 0xAA].into_iter().enumerate() {
            m.put_u32(blob + i as u64 * 4, v);
        }

        // Weight map: rank 30 -> (60, 40) via a value pointer.
        let w_node = 0x7000_0400u64;
        let w_val = 0x7000_0500u64;
        put_map(&mut m, MGR + MGR_WEIGHT_MAP, &[w_node]);
        m.put_u32(w_node + 0x10, 30);
        m.put_u64(w_node + 0x18, w_val);
        m.put_u32(w_val, 60);
        m.put_u32(w_val + 4, 40);

        // Pair map: u64 key 99 -> count 2 (inline u32 value).
        let p_node = 0x7000_0600u64;
        put_map(&mut m, MGR + MGR_PAIR_MAP, &[p_node]);
        m.put_u64(p_node + 0x10, 99);
        m.put_u32(p_node + 0x18, 2);

        // Trait->item map: trait 0x11 -> item 0xAA (inline u32 at +0x14).
        let t_node = 0x7000_0700u64;
        put_map(&mut m, MGR + MGR_TRAIT_ITEM_MAP, &[t_node]);
        m.put_u32(t_node + 0x10, 0x11);
        m.put_u32(t_node + 0x14, 0xAA);

        let snap = take_snapshot(&m, BASE, RVAS).unwrap();
        assert_eq!(snap.rng_state, 0xdead);
        assert_eq!(snap.seed_counter, 7);
        assert_eq!(snap.pair_counters.get(&99), Some(&2));
        assert_eq!(snap.level_weights.get(&30), Some(&(60, 40)));
        assert_eq!(snap.trait_to_item.get(&0x11), Some(&0xAA));
        assert_eq!(
            snap.sigils,
            vec![SynthesisSigil {
                uid: 1,
                sigil_id: 0xAA,
                trait1: 0x11,
                trait1_level: 15,
                trait2: 0x22,
                trait2_level: 15,
                record_level: 3,
            }]
        );
    }
}
```

- [ ] **Step 2: Run** — `cargo test -p game-reader` — Expected: PASS (all synthesis tests + Task 3's).

- [ ] **Step 3: Commit** — `git add game-reader/src/synthesis.rs && git commit -m "feat(game-reader): synthesis snapshot walkers over MemRead"`

---

### Task 5: game-reader — overmastery walkers

**Files:**
- Replace: `game-reader/src/overmastery.rs`

Same move rules as Task 4 (from `src-tauri/src/overmastery/snapshot.rs`).

- [ ] **Step 1: Write walkers + tests.** Replace `game-reader/src/overmastery.rs` entirely with:

```rust
//! Read-only snapshot of the game's meditation RNG state: the RNG slot array
//! and the character roster vector (character -> slot index).

use crate::{resolve_rng_rva, scan_unique_rva, MemRead, RNG_SLOT_COUNT};
use anyhow::{bail, Result};
use pelite::pe64::Pe;
pub use protocol::toolbox::OvermasterySnapshot;

/// Anchored on the PL0100/PL0000 id compares inside the meditation roll
/// (FUN_141beb1b0); cursor lands on the disp32 of `mov rax, [rip+disp]`
/// loading the character roster global.
const ROSTER_SIG: &str = "81 f9 76 ba ac a4 74 ? 81 f9 b2 b1 26 2a 75 ? 8d 0c 9b 44 8d 04 cb 42 8d 14 00 83 c2 05 48 8b 0d ? ? ? ? 83 fa ff 74 ? 44 01 c0 83 f8 7d 7f ? eb ? 48 8b 05 ' ? ? ? ?";

const MAX_ROSTER: u64 = 64;

/// The two globals overmastery needs, as module-relative RVAs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OvermasteryRvas {
    pub rng: u32,
    pub roster: u32,
}

/// Sigscan for the RNG and roster globals (PeFile or PeView alike).
pub fn resolve_rvas<'a>(pe: impl Pe<'a> + Copy) -> Result<OvermasteryRvas> {
    Ok(OvermasteryRvas {
        rng: resolve_rng_rva(pe)?,
        roster: scan_unique_rva(pe, ROSTER_SIG, "roster")?,
    })
}

fn deref_rng(mem: &impl MemRead, base: u64, rvas: OvermasteryRvas) -> Result<u64> {
    let rng = mem.u64(base + rvas.rng as u64)?;
    if rng == 0 {
        bail!("rng global not initialized yet (still on title screen?)");
    }
    Ok(rng)
}

/// Light read of one RNG slot's state (`slot` < `RNG_SLOT_COUNT`) for
/// staleness polling — a single 4-byte read, no roster walk.
pub fn take_slot_state(
    mem: &impl MemRead,
    base: u64,
    rvas: OvermasteryRvas,
    slot: u32,
) -> Result<u32> {
    if slot as usize >= RNG_SLOT_COUNT {
        bail!("slot {slot:#x} out of range");
    }
    let rng = deref_rng(mem, base, rvas)?;
    mem.u32(rng + slot as u64 * 4)
}

/// Take a meditation RNG snapshot.
pub fn take_snapshot(
    mem: &impl MemRead,
    base: u64,
    rvas: OvermasteryRvas,
) -> Result<OvermasterySnapshot> {
    let rng = deref_rng(mem, base, rvas)?;

    let mut block = vec![0u8; RNG_SLOT_COUNT * 4 + 4];
    mem.read(rng, &mut block)?;
    let word = |i: usize| u32::from_le_bytes(block[i * 4..i * 4 + 4].try_into().expect("4 bytes"));
    let slots: Vec<u32> = (0..RNG_SLOT_COUNT).map(word).collect();
    // RNG_SLOT_OVERRIDE == RNG_SLOT_COUNT * 4 is asserted at compile time in
    // the crate root, so the override word is simply the slot after the last.
    let slot_override = word(RNG_SLOT_COUNT);

    // The global holds a pointer to the roster object; the id vector's
    // begin/end pointers sit at +8 / +0x10 of THAT object.
    let roster_obj = mem.u64(base + rvas.roster as u64)?;
    if roster_obj == 0 {
        bail!("roster object not initialized yet (still on title screen?)");
    }
    let begin = mem.u64(roster_obj + 8)?;
    let end = mem.u64(roster_obj + 0x10)?;
    if begin == 0 || end < begin || (end - begin) % 4 != 0 {
        bail!("roster vector looks torn ({begin:#x}..{end:#x})");
    }
    let count = (end - begin) / 4;
    if count > MAX_ROSTER {
        bail!("roster claims {count} characters");
    }
    let mut buf = vec![0u8; count as usize * 4];
    if !buf.is_empty() {
        mem.read(begin, &mut buf)?;
    }
    let roster = buf
        .chunks_exact(4)
        .map(|c| u32::from_le_bytes(c.try_into().expect("4 bytes")))
        .collect();

    Ok(OvermasterySnapshot {
        slots,
        slot_override,
        roster,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{FakeMem, RNG_SLOT_OVERRIDE};

    const BASE: u64 = 0x1_4000_0000;
    const RVAS: OvermasteryRvas = OvermasteryRvas {
        rng: 0x2000,
        roster: 0x3000,
    };
    const RNG: u64 = 0x6000_0000;
    const ROSTER_OBJ: u64 = 0x8000_0000;
    const IDS: u64 = 0x8000_1000;

    fn valid_world() -> FakeMem {
        let mut m = FakeMem::default();
        m.put_u64(BASE + RVAS.rng as u64, RNG);
        for i in 0..RNG_SLOT_COUNT {
            m.put_u32(RNG + i as u64 * 4, i as u32 + 100);
        }
        m.put_u32(RNG + RNG_SLOT_OVERRIDE, u32::MAX);
        m.put_u64(BASE + RVAS.roster as u64, ROSTER_OBJ);
        m.put_u64(ROSTER_OBJ + 8, IDS);
        m.put_u64(ROSTER_OBJ + 0x10, IDS + 8); // two ids
        m.put_u32(IDS, 0xaaaa);
        m.put_u32(IDS + 4, 0xbbbb);
        m
    }

    #[test]
    fn snapshot_reads_slots_override_and_roster() {
        let snap = take_snapshot(&valid_world(), BASE, RVAS).unwrap();
        assert_eq!(snap.slots.len(), RNG_SLOT_COUNT);
        assert_eq!(snap.slots[0x81], 0x81 + 100);
        assert_eq!(snap.slot_override, u32::MAX);
        assert_eq!(snap.roster, vec![0xaaaa, 0xbbbb]);
    }

    #[test]
    fn torn_roster_vector_fails() {
        let mut m = valid_world();
        m.put_u64(ROSTER_OBJ + 0x10, IDS - 8); // end < begin
        let err = take_snapshot(&m, BASE, RVAS).unwrap_err().to_string();
        assert!(err.contains("torn"), "{err}");
    }

    #[test]
    fn slot_state_reads_one_slot_and_bounds_checks() {
        let m = valid_world();
        assert_eq!(take_slot_state(&m, BASE, RVAS, 2).unwrap(), 102);
        let err = take_slot_state(&m, BASE, RVAS, RNG_SLOT_COUNT as u32)
            .unwrap_err()
            .to_string();
        assert!(err.contains("out of range"), "{err}");
    }

    #[test]
    fn null_rng_global_fails_with_title_screen_hint() {
        let mut m = valid_world();
        m.put_u64(BASE + RVAS.rng as u64, 0);
        let err = take_snapshot(&m, BASE, RVAS).unwrap_err().to_string();
        assert!(err.contains("title screen"), "{err}");
    }
}
```

- [ ] **Step 2: Run** — `cargo test -p game-reader` — Expected: PASS.

- [ ] **Step 3: Commit** — `git add game-reader/src/overmastery.rs && git commit -m "feat(game-reader): overmastery snapshot walkers over MemRead"`

---

### Task 6: Hook — toolbox RPC server

**Files:**
- Modify: `src-hook/Cargo.toml`
- Create: `src-hook/src/toolbox.rs`
- Modify: `src-hook/src/lib.rs`

- [ ] **Step 1: Add the dependency.** In `src-hook/Cargo.toml` `[dependencies]`, after the `protocol` line add:

```toml
game-reader = { path = "../game-reader" }
```

- [ ] **Step 2: Write the failing tests.** Create `src-hook/src/toolbox.rs` containing only:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use protocol::toolbox::{ToolboxRequest, ToolboxResponse, TOOLBOX_PROTOCOL_VERSION};

    #[test]
    fn hello_reports_our_protocol_version() {
        let ToolboxResponse::Hello { protocol_version } = handle_request(ToolboxRequest::Hello)
        else {
            panic!("wrong variant");
        };
        assert_eq!(protocol_version, TOOLBOX_PROTOCOL_VERSION);
    }

    /// In the test binary the sigscan finds nothing — the handler must turn
    /// that into an error RESPONSE, never a panic or unwind.
    #[test]
    fn snapshot_against_a_non_game_binary_is_an_error_response() {
        let ToolboxResponse::SynthesisSnapshot(result) =
            handle_request(ToolboxRequest::SynthesisSnapshot)
        else {
            panic!("wrong variant");
        };
        assert!(result.is_err());
    }
}
```

And in `src-hook/src/lib.rs`, add `mod toolbox;` to the module list (after `mod transport;`).

- [ ] **Step 3: Run** — `cargo test -p hook` — Expected: FAIL (`handle_request` not defined).

- [ ] **Step 4: Implement.** Prepend to `src-hook/src/toolbox.rs`:

```rust
//! Toolbox RPC server: synthesis/overmastery snapshots read in-process and
//! served on demand — needs no privileges on either platform (the Linux app
//! cannot ReadProcessMemory a Wine process; this replaces that path).
//!
//! One request per connection: read one frame, answer one frame, done. Runs
//! entirely on the hook's tokio runtime — never on a game thread. The walks
//! happen at menu cadence (a user sitting in the synthesis/meditation
//! screen), so per-read SEH guard overhead is irrelevant; what matters is
//! that a torn pointer becomes an error response instead of a game crash.

use anyhow::Result;
use futures::{SinkExt, StreamExt};
use game_reader::MemRead;
use interprocess::os::windows::named_pipe::tokio::PipeListenerOptionsExt;
use interprocess::os::windows::named_pipe::{pipe_mode, PipeListenerOptions, PipeMode};
use log::{info, warn};
use pelite::pe64::PeView;
use protocol::toolbox::{
    ToolboxRequest, ToolboxResponse, TOOLBOX_PIPE_NAME, TOOLBOX_PROTOCOL_VERSION, TOOLBOX_TCP_ADDR,
};
use std::sync::OnceLock;
use tokio_util::codec::{Framed, LengthDelimitedCodec};

use crate::hooks::diag::readable;
use crate::transport::{self, Transport};

/// Guarded in-process reads: chasing a torn map pointer unguarded would
/// crash the game, so every read SEH-probes first (see `diag::readable`).
struct InProcMem;

impl MemRead for InProcMem {
    fn read(&self, addr: u64, buf: &mut [u8]) -> Result<()> {
        if !readable(addr as usize, buf.len()) {
            anyhow::bail!("unreadable memory at {addr:#x} ({} bytes)", buf.len());
        }
        unsafe { std::ptr::copy_nonoverlapping(addr as *const u8, buf.as_mut_ptr(), buf.len()) };
        Ok(())
    }
}

struct Globals {
    base: u64,
    synthesis: game_reader::synthesis::SynthesisRvas,
    overmastery: game_reader::overmastery::OvermasteryRvas,
}

/// Resolve the toolbox globals by sigscanning the loaded exe image, once per
/// process lifetime. A failure (game patch changed the signatures) is cached
/// too — rescanning the same image cannot start succeeding.
fn globals() -> Result<&'static Globals, String> {
    static GLOBALS: OnceLock<Result<Globals, String>> = OnceLock::new();
    GLOBALS
        .get_or_init(|| {
            let module = unsafe {
                windows::Win32::System::LibraryLoader::GetModuleHandleW(None)
            }
            .map_err(|e| format!("GetModuleHandleW: {e:?}"))?;
            let base = module.0 as u64;
            let view = unsafe { PeView::module(base as *const u8) };
            Ok(Globals {
                base,
                synthesis: game_reader::synthesis::resolve_rvas(view)
                    .map_err(|e| e.to_string())?,
                overmastery: game_reader::overmastery::resolve_rvas(view)
                    .map_err(|e| e.to_string())?,
            })
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// Run a read under catch_unwind: a walker panic must degrade to an error
/// response, never unwind across the listener (and never reach game code).
fn guarded<T>(f: impl FnOnce() -> Result<T>) -> Result<T, String> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Err("toolbox read panicked (see hook log)".to_string()),
    }
}

fn handle_request(req: ToolboxRequest) -> ToolboxResponse {
    match req {
        ToolboxRequest::Hello => ToolboxResponse::Hello {
            protocol_version: TOOLBOX_PROTOCOL_VERSION,
        },
        ToolboxRequest::SynthesisSnapshot => ToolboxResponse::SynthesisSnapshot(
            globals().and_then(|g| {
                guarded(|| game_reader::synthesis::take_snapshot(&InProcMem, g.base, g.synthesis))
            }),
        ),
        ToolboxRequest::SynthesisSeed => ToolboxResponse::SynthesisSeed(globals().and_then(|g| {
            guarded(|| game_reader::synthesis::take_seed_state(&InProcMem, g.base, g.synthesis))
        })),
        ToolboxRequest::OvermasterySnapshot => {
            ToolboxResponse::OvermasterySnapshot(globals().and_then(|g| {
                guarded(|| {
                    game_reader::overmastery::take_snapshot(&InProcMem, g.base, g.overmastery)
                })
            }))
        }
        ToolboxRequest::OvermasterySlot(slot) => {
            ToolboxResponse::OvermasterySlot(globals().and_then(|g| {
                guarded(|| {
                    game_reader::overmastery::take_slot_state(
                        &InProcMem,
                        g.base,
                        g.overmastery,
                        slot,
                    )
                })
            }))
        }
    }
}

/// One connection = one request, one response.
async fn serve<S>(stream: S)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let mut framed = Framed::new(stream, LengthDelimitedCodec::new());
    let Some(Ok(frame)) = framed.next().await else {
        return;
    };
    let req = match protocol::bincode::deserialize::<ToolboxRequest>(&frame) {
        Ok(req) => req,
        Err(e) => {
            warn!("toolbox: undecodable request: {e:?}");
            return;
        }
    };
    let resp = handle_request(req);
    match protocol::bincode::serialize(&resp) {
        Ok(bytes) => {
            let _ = framed.send(bytes.into()).await;
        }
        Err(e) => warn!("toolbox: could not serialize response: {e:?}"),
    }
}

pub async fn run() {
    match transport::select_transport() {
        Transport::NamedPipe => run_pipe().await,
        Transport::Tcp => run_tcp().await,
    }
}

async fn run_pipe() {
    let listener = match PipeListenerOptions::new()
        .path(TOOLBOX_PIPE_NAME)
        .mode(PipeMode::Bytes)
        .accept_remote(false)
        .create_tokio_duplex::<pipe_mode::Bytes>()
    {
        Ok(listener) => listener,
        Err(e) => {
            warn!("toolbox: could not create pipe listener: {e:?}");
            return;
        }
    };
    loop {
        match listener.accept().await {
            Ok(stream) => {
                tokio::spawn(serve(stream));
            }
            Err(e) => warn!("toolbox: error accepting client: {e:?}"),
        }
    }
}

// Same bind-retry rationale as the event listener: a taken port must not
// permanently disable the toolbox for the session.
async fn run_tcp() {
    let listener = loop {
        match tokio::net::TcpListener::bind(TOOLBOX_TCP_ADDR).await {
            Ok(listener) => break listener,
            Err(e) => {
                warn!("toolbox: could not bind {TOOLBOX_TCP_ADDR}: {e:?}; retrying in 5s");
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            }
        }
    };
    info!("toolbox: listening on {TOOLBOX_TCP_ADDR}");
    loop {
        match listener.accept().await {
            Ok((stream, _addr)) => {
                tokio::spawn(serve(stream));
            }
            Err(e) => {
                warn!("toolbox: error accepting client: {e:?}");
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        }
    }
}
```

- [ ] **Step 5: Spawn it.** In `src-hook/src/lib.rs`, in `Server::run`, add the spawn before the transport match:

```rust
    async fn run(&self) {
        // The toolbox RPC channel is independent of the event stream and
        // must not die with a client, so it gets its own task.
        tokio::spawn(toolbox::run());
        match transport::select_transport() {
            transport::Transport::NamedPipe => self.run_pipe().await,
            transport::Transport::Tcp => self.run_tcp().await,
        }
    }
```

- [ ] **Step 6: Run** — `cargo test -p hook` — Expected: PASS (the two new tests + existing transport/assist tests).

- [ ] **Step 7: Run** — `cargo clippy -p hook` — Expected: no new warnings.

- [ ] **Step 8: Commit** — `git add src-hook/ Cargo.lock && git commit -m "feat(hook): toolbox RPC server with guarded in-process reads"`

---

### Task 7: src-tauri — RPC client and HookStatus

**Files:**
- Create: `src-tauri/src/toolbox_rpc.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/Cargo.toml`

This task is additive — nothing existing changes behavior yet.

- [ ] **Step 1: Dependency.** In `src-tauri/Cargo.toml` `[dependencies]` (the platform-independent block, right after `protocol`):

```toml
game-reader = { path = "../game-reader" }
```

- [ ] **Step 2: Create `src-tauri/src/toolbox_rpc.rs`:**

```rust
//! Client for the hook's toolbox RPC channel (one request per connection),
//! plus [`HookStatus`] — what the commands consult before calling so that
//! "game not running", "hook outdated", and "hook unreachable" each surface
//! as the right thing in the UI.

use anyhow::{bail, Context, Result};
use futures::{SinkExt, StreamExt};
use protocol::toolbox::{
    ToolboxRequest, ToolboxResponse, TOOLBOX_PROTOCOL_VERSION, TOOLBOX_TCP_ADDR,
};
use protocol::toolbox::{OvermasterySnapshot, SynthesisSeed, SynthesisSnapshot};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio_util::codec::{Framed, LengthDelimitedCodec};

/// Managed Tauri state, kept current by the event-stream connect loop in
/// main.rs. Both flags default to false.
#[derive(Default)]
pub struct HookStatus {
    /// True while the event stream is connected (the hook is alive).
    pub connected: AtomicBool,
    /// True when the hook's Hello failed or reported another protocol
    /// version — e.g. a stale Linux dinput8 proxy until the game restarts,
    /// or a pre-RPC hook that refuses the connection outright.
    pub outdated: AtomicBool,
}

/// A wedged hook (or frozen game) must not hang a Tauri command.
const RPC_TIMEOUT: Duration = Duration::from_secs(2);

async fn exchange<S>(stream: S, req: &ToolboxRequest) -> Result<ToolboxResponse>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let mut framed = Framed::new(stream, LengthDelimitedCodec::new());
    framed
        .send(protocol::bincode::serialize(req)?.into())
        .await?;
    match framed.next().await {
        Some(Ok(frame)) => Ok(protocol::bincode::deserialize(&frame)?),
        Some(Err(e)) => Err(e.into()),
        None => bail!("toolbox channel closed before responding"),
    }
}

/// Same transport selection as `connect_event_stream` in main.rs: pipe on
/// native Windows, TCP under GBFR_LOGS_FORCE_TCP=1 and on Linux.
async fn call_inner(req: &ToolboxRequest) -> Result<ToolboxResponse> {
    #[cfg(windows)]
    if std::env::var("GBFR_LOGS_FORCE_TCP").as_deref() != Ok("1") {
        // TOOLBOX_PIPE_NAME referenced fully qualified: a top-level import
        // would be an unused-import warning in the Linux build.
        use interprocess::os::windows::named_pipe::{pipe_mode, tokio::DuplexPipeStream};
        let stream = DuplexPipeStream::<pipe_mode::Bytes>::connect_by_path(
            protocol::toolbox::TOOLBOX_PIPE_NAME,
        )
        .await?;
        return exchange(stream, req).await;
    }
    let stream = tokio::net::TcpStream::connect(TOOLBOX_TCP_ADDR).await?;
    exchange(stream, req).await
}

pub async fn call(req: ToolboxRequest) -> Result<ToolboxResponse> {
    tokio::time::timeout(RPC_TIMEOUT, call_inner(&req))
        .await
        .context("toolbox rpc timed out")?
}

/// True only when the hook answers Hello with OUR protocol version. Called
/// by the connect loop each time the event stream (re)connects.
pub async fn hello_ok() -> bool {
    matches!(
        call(ToolboxRequest::Hello).await,
        Ok(ToolboxResponse::Hello { protocol_version })
            if protocol_version == TOOLBOX_PROTOCOL_VERSION
    )
}

/// Shared precondition for every toolbox command. `Ok(None)` = the event
/// stream is down, which the tools present as "game not running". The two
/// error slugs are mapped to friendly copy in src/backendErrors.ts; remote
/// error strings (e.g. "still on title screen?") pass through verbatim.
async fn request(hook: &HookStatus, req: ToolboxRequest) -> Result<Option<ToolboxResponse>, String> {
    if !hook.connected.load(Ordering::Relaxed) {
        return Ok(None);
    }
    if hook.outdated.load(Ordering::Relaxed) {
        return Err("hook-outdated".into());
    }
    match call(req).await {
        Ok(resp) => Ok(Some(resp)),
        Err(e) => {
            log::warn!("toolbox rpc failed: {e:?}");
            Err("hook-unreachable".into())
        }
    }
}

pub async fn synthesis_snapshot(hook: &HookStatus) -> Result<Option<SynthesisSnapshot>, String> {
    match request(hook, ToolboxRequest::SynthesisSnapshot).await? {
        None => Ok(None),
        Some(ToolboxResponse::SynthesisSnapshot(r)) => r.map(Some),
        Some(other) => Err(format!("unexpected toolbox response {other:?}")),
    }
}

pub async fn synthesis_seed(hook: &HookStatus) -> Result<Option<SynthesisSeed>, String> {
    match request(hook, ToolboxRequest::SynthesisSeed).await? {
        None => Ok(None),
        Some(ToolboxResponse::SynthesisSeed(r)) => r.map(Some),
        Some(other) => Err(format!("unexpected toolbox response {other:?}")),
    }
}

pub async fn overmastery_snapshot(hook: &HookStatus) -> Result<Option<OvermasterySnapshot>, String> {
    match request(hook, ToolboxRequest::OvermasterySnapshot).await? {
        None => Ok(None),
        Some(ToolboxResponse::OvermasterySnapshot(r)) => r.map(Some),
        Some(other) => Err(format!("unexpected toolbox response {other:?}")),
    }
}

pub async fn overmastery_slot(hook: &HookStatus, slot: u32) -> Result<Option<u32>, String> {
    match request(hook, ToolboxRequest::OvermasterySlot(slot)).await? {
        None => Ok(None),
        Some(ToolboxResponse::OvermasterySlot(r)) => r.map(Some),
        Some(other) => Err(format!("unexpected toolbox response {other:?}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The gating rules the frontend copy depends on, without any live hook.
    #[tokio::test]
    async fn disconnected_hook_reads_as_game_not_running() {
        let hook = HookStatus::default();
        assert_eq!(synthesis_snapshot(&hook).await, Ok(None));
    }

    #[tokio::test]
    async fn outdated_hook_maps_to_its_slug() {
        let hook = HookStatus::default();
        hook.connected.store(true, Ordering::Relaxed);
        hook.outdated.store(true, Ordering::Relaxed);
        assert_eq!(
            synthesis_snapshot(&hook).await,
            Err("hook-outdated".to_string())
        );
    }

    /// connected + current but nothing listening (no game in tests) → the
    /// unreachable slug, not a hang (RPC_TIMEOUT bounds it).
    #[tokio::test]
    async fn unreachable_hook_maps_to_its_slug() {
        let hook = HookStatus::default();
        hook.connected.store(true, Ordering::Relaxed);
        assert_eq!(
            synthesis_snapshot(&hook).await,
            Err("hook-unreachable".to_string())
        );
    }
}
```

Note: the tests compare with `assert_eq!`, so `SynthesisSnapshot` etc. need `PartialEq` — Task 2 already derived it.

- [ ] **Step 3: Register the module.** In `src-tauri/src/lib.rs` add (alphabetical position):

```rust
pub mod toolbox_rpc;
```

- [ ] **Step 4: Run** — `cargo test -p gbfr-logs --lib toolbox_rpc` — Expected: PASS (3 tests). Caveat: on native Windows the "unreachable" test requires no real game+hook to be running with a live pipe; close the game first if it is.

- [ ] **Step 5: Commit** — `git add src-tauri/ Cargo.lock && git commit -m "feat(app): toolbox RPC client and HookStatus gating"`

---

### Task 8: src-tauri — the switch (engines re-point, commands rewritten, RPM demoted to diag)

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/synthesis/mod.rs`
- Delete: `src-tauri/src/synthesis/snapshot.rs`
- Modify: `src-tauri/src/overmastery/mod.rs`
- Delete: `src-tauri/src/overmastery/snapshot.rs`
- Replace: `src-tauri/src/game_mem.rs`
- Modify: `src-tauri/src/main.rs`
- Modify: `src-tauri/examples/om_probe.rs`, `synth_probe.rs`, `synth_diag.rs`

This is one atomic compiling unit: the engines' types move to protocol, the snapshot modules die, the commands switch to RPC, and the probes switch to the `rpm_*` wrappers. Steps in order, one commit at the end.

- [ ] **Step 1: Re-point `synthesis/mod.rs`.** Delete `pub mod snapshot;` and the local `SynthesisSigil`/`SynthesisSnapshot`/`SynthesisSeed` struct definitions (keep `Prediction`, `SynthesisQuery`, `SynthesisMatch`, `SynthesisStatus`, `SynthesisSearchResponse` and ALL functions/tests). Replace the two `pub use crate::game_mem::...` lines at the top with:

```rust
pub use game_reader::xorshift32;
/// The game's "no trait in this slot" sentinel.
pub use game_reader::EMPTY_KEY as EMPTY_TRAIT;
pub use protocol::toolbox::{SynthesisSeed, SynthesisSigil, SynthesisSnapshot};
```

Update the module doc comment's second paragraph: "The snapshot module reads the inputs from game memory" → "The hook takes the input snapshot in-process (game-reader crate, served over the toolbox RPC channel)".

- [ ] **Step 2: Re-point `overmastery/mod.rs`.** Same treatment: delete `pub mod snapshot;`, replace the `pub use crate::game_mem::...` line with:

```rust
pub use game_reader::{xorshift32, EMPTY_KEY};
pub use protocol::toolbox::OvermasterySnapshot;
```

(The `OvermasterySnapshot` struct definition lived in the old snapshot.rs, so nothing local to delete here.) Update the doc comment the same way.

- [ ] **Step 3: Delete the snapshot modules.**

```bash
git rm src-tauri/src/synthesis/snapshot.rs src-tauri/src/overmastery/snapshot.rs
```

- [ ] **Step 4: Replace `src-tauri/src/game_mem.rs` entirely:**

```rust
//! Diag-only RPM plumbing: open the running game with OpenProcess /
//! ReadProcessMemory and take toolbox snapshots from OUTSIDE the process.
//!
//! The production path no longer lives here — the hook serves snapshots
//! in-process over the toolbox RPC channel (see `toolbox_rpc`). This module
//! remains for the ground-truth probes in examples/ (om_probe, synth_probe,
//! synth_diag, toolbox_probe), which deliberately read the same structures
//! through a channel that shares no hook code, so they can cross-check it.
//! Windows-only, requires admin, reads the on-disk exe for sigscanning.

use anyhow::{bail, Context, Result};
use dll_syringe::process::{OwnedProcess, Process};
use game_reader::MemRead;
use pelite::pe64::PeFile;
use std::path::PathBuf;
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::Diagnostics::Debug::ReadProcessMemory;
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Module32FirstW, MODULEENTRY32W, TH32CS_SNAPMODULE,
};
use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ};

pub use game_reader::GAME_EXE;

pub struct Mem(pub HANDLE);

impl MemRead for Mem {
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

/// Find the game process id, or None if it isn't running. Uses the same
/// dll_syringe lookup as the injector (`check_and_perform_hook` in main.rs).
pub fn find_game_pid() -> Result<Option<u32>> {
    let Some(process) = OwnedProcess::find_first_by_name(GAME_EXE) else {
        return Ok(None);
    };
    Ok(Some(process.pid().context("query game pid")?.get()))
}

/// Main-module (exe) base address and on-disk path.
pub fn module_base(pid: u32) -> Result<(u64, PathBuf)> {
    let snap = Mem(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPMODULE, pid) }?);
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

/// Open the running game for reading: process handle + exe base + exe path.
/// `Ok(None)` = game not running. Uncached — the probes are one-shot tools;
/// the old cache existed for the app's 5-second staleness pollers, which now
/// go through the hook instead.
pub fn open_game() -> Result<Option<(Mem, u64, PathBuf)>> {
    let Some(pid) = find_game_pid()? else {
        return Ok(None);
    };
    let mem = Mem(unsafe { OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, false, pid) }
        .context("OpenProcess (run as admin?)")?);
    let (base, exe) = module_base(pid)?;
    Ok(Some((mem, base, exe)))
}

/// RPM synthesis snapshot (probe ground truth). `Ok(None)` = game not running.
pub fn rpm_synthesis_snapshot() -> Result<Option<protocol::toolbox::SynthesisSnapshot>> {
    let Some((mem, base, exe)) = open_game()? else {
        return Ok(None);
    };
    let data = std::fs::read(&exe).with_context(|| format!("read {}", exe.display()))?;
    let pe = PeFile::from_bytes(&data).context("parse exe")?;
    let rvas = game_reader::synthesis::resolve_rvas(pe)?;
    Ok(Some(game_reader::synthesis::take_snapshot(&mem, base, rvas)?))
}

/// RPM overmastery snapshot (probe ground truth). `Ok(None)` = game not running.
pub fn rpm_overmastery_snapshot() -> Result<Option<protocol::toolbox::OvermasterySnapshot>> {
    let Some((mem, base, exe)) = open_game()? else {
        return Ok(None);
    };
    let data = std::fs::read(&exe).with_context(|| format!("read {}", exe.display()))?;
    let pe = PeFile::from_bytes(&data).context("parse exe")?;
    let rvas = game_reader::overmastery::resolve_rvas(pe)?;
    Ok(Some(game_reader::overmastery::take_snapshot(&mem, base, rvas)?))
}
```

- [ ] **Step 5: Ungate the engine modules.** In `src-tauri/src/lib.rs` remove the `#[cfg(windows)]` lines above `pub mod overmastery;` and `pub mod synthesis;` (keep the one above `pub mod game_mem;`). Result:

```rust
pub mod backfill;
pub mod data_paths;
pub mod db;
#[cfg(windows)]
pub mod game_mem;
pub mod linux_support;
pub mod overmastery;
pub mod parser;
pub mod synthesis;
pub mod toolbox_rpc;
```

- [ ] **Step 6: Rewrite the six commands in `src-tauri/src/main.rs`.** First the imports — replace:

```rust
use gbfr_logs::{db, parser};
#[cfg(windows)]
use gbfr_logs::{overmastery, synthesis};
```

with:

```rust
use gbfr_logs::toolbox_rpc::{self, HookStatus};
use gbfr_logs::{db, overmastery, parser, synthesis};
```

Then delete ALL twelve toolbox command functions (the six `#[cfg(windows)]` ones AND the six `#[cfg(not(windows))]` stubs, main.rs lines ~56–226) and replace them with these six (no cfg attributes):

```rust
/// Toolbox / Synthesis Helper: snapshot the game's synthesis state (served
/// by the hook over the toolbox RPC channel) and report whether predictions
/// are currently possible.
#[tauri::command(async)]
async fn fetch_synthesis_status(
    hook: State<'_, HookStatus>,
) -> Result<synthesis::SynthesisStatus, String> {
    match toolbox_rpc::synthesis_snapshot(&hook).await? {
        None => Ok(synthesis::SynthesisStatus {
            game_running: false,
            sigil_count: 0,
            rng_unpredictable: false,
        }),
        Some(snap) => Ok(synthesis::SynthesisStatus {
            game_running: true,
            sigil_count: snap.sigils.len() as u32,
            rng_unpredictable: snap.rng_state == 0,
        }),
    }
}

/// Toolbox / Synthesis Helper: fresh snapshot + exhaustive pair search. The
/// snapshot is an RPC; the search itself is CPU-heavy, so it stays on a
/// blocking thread.
#[tauri::command(async)]
async fn search_synthesis(
    query: synthesis::SynthesisQuery,
    hook: State<'_, HookStatus>,
) -> Result<synthesis::SynthesisSearchResponse, String> {
    if query.trait1 == synthesis::EMPTY_TRAIT || query.trait2 == Some(synthesis::EMPTY_TRAIT) {
        return Err("invalid-trait".to_string());
    }
    let snap = toolbox_rpc::synthesis_snapshot(&hook)
        .await?
        .ok_or_else(|| "game-not-running".to_string())?;
    tokio::task::spawn_blocking(move || {
        let (matches, pairs_tested) = synthesis::search(&snap, &query);
        Ok(synthesis::SynthesisSearchResponse {
            matches,
            pairs_tested,
            sigil_count: snap.sigils.len() as u32,
            rng_unpredictable: snap.rng_state == 0,
            rng_state: snap.rng_state,
            seed_counter: snap.seed_counter,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Toolbox / Synthesis Helper: current seed identity for staleness polling.
/// `None` = game not running (staleness unknowable, not stale).
#[tauri::command(async)]
async fn fetch_synthesis_seed(
    hook: State<'_, HookStatus>,
) -> Result<Option<synthesis::SynthesisSeed>, String> {
    toolbox_rpc::synthesis_seed(&hook).await
}

/// Toolbox / Overmastery Predictor: is the game up, and which characters
/// exist in the roster (for the character picker).
#[tauri::command(async)]
async fn fetch_overmastery_status(
    hook: State<'_, HookStatus>,
) -> Result<overmastery::OvermasteryStatus, String> {
    match toolbox_rpc::overmastery_snapshot(&hook).await? {
        None => Ok(overmastery::OvermasteryStatus {
            game_running: false,
            roster: Vec::new(),
        }),
        Some(snap) => Ok(overmastery::OvermasteryStatus {
            game_running: true,
            roster: snap.roster,
        }),
    }
}

/// Toolbox / Overmastery Predictor: fresh RNG snapshot + simulate the next N
/// meditation rolls for one character and size.
#[tauri::command(async)]
async fn predict_overmastery(
    query: overmastery::OvermasteryQuery,
    hook: State<'_, HookStatus>,
) -> Result<overmastery::OvermasteryPrediction, String> {
    let tables = overmastery::stock_tables();
    if query.tier >= tables.tiers.len() {
        return Err("invalid-tier".to_string());
    }
    let rolls = query.rolls.min(500);
    let snap = toolbox_rpc::overmastery_snapshot(&hook)
        .await?
        .ok_or_else(|| "game-not-running".to_string())?;
    if snap.slot_override != u32::MAX {
        return Err("rng-override-active".to_string());
    }
    let char_idx = overmastery::char_slot_index(&snap.roster, query.char_id)
        .ok_or_else(|| "character-not-found".to_string())?;
    let slot = overmastery::rng_slot(query.tier as u32, char_idx);
    let slot_state = *snap
        .slots
        .get(slot as usize)
        .ok_or_else(|| "slot-out-of-range".to_string())?;
    Ok(overmastery::OvermasteryPrediction {
        rolls: overmastery::simulate(slot_state, query.tier, tables, rolls),
        slot,
        slot_state,
        unpredictable: slot_state == 0,
        msp_cost: tables.tiers[query.tier].msp_cost,
    })
}

/// Toolbox / Overmastery Predictor: current RNG state of one slot, for
/// staleness polling against a prediction's `slot_state`. `None` = game not
/// running (staleness unknowable, not stale).
#[tauri::command(async)]
async fn fetch_overmastery_seed(
    slot: u32,
    hook: State<'_, HookStatus>,
) -> Result<Option<u32>, String> {
    toolbox_rpc::overmastery_slot(&hook, slot).await
}
```

- [ ] **Step 7: Manage the state.** In `main.rs` where the builder does `.manage(ResetChannel(...))` (line ~1298), add after it:

```rust
        .manage(HookStatus::default())
```

- [ ] **Step 8: Wire the connect loop.** In `connect_and_run_parser`'s spawned task (main.rs ~966): after `info!("Connected to game!");` and the `success-alert` emit, add:

```rust
                    let hook_status = app.state::<HookStatus>();
                    hook_status.connected.store(true, Ordering::Relaxed);
                    // Hello up front, once per (re)connect: a stale Linux
                    // proxy or pre-RPC hook shows as "outdated" instead of
                    // per-command failures.
                    hook_status
                        .outdated
                        .store(!toolbox_rpc::hello_ok().await, Ordering::Relaxed);
```

And immediately after the inner read `loop { ... }` ends (the `break`s land there — the game disconnected), before whatever follows (disconnect alert / retry sleep), add:

```rust
                    app.state::<HookStatus>()
                        .connected
                        .store(false, Ordering::Relaxed);
```

- [ ] **Step 9: main.rs line ~888** (`check_and_perform_hook`) references `gbfr_logs::game_mem::GAME_EXE` — unchanged and still valid (game_mem re-exports it). Verify with: `Grep pattern="game_mem::GAME_EXE" path=src-tauri/src` — expect the one hit, and the file still compiles under `#[cfg(windows)]` context.

- [ ] **Step 10: Fix the probes.** In `src-tauri/examples/om_probe.rs` change line 23 from:

```rust
use gbfr_logs::overmastery::{char_slot_index, rng_slot, simulate, snapshot, stock_tables};
```

to:

```rust
use gbfr_logs::game_mem;
use gbfr_logs::overmastery::{char_slot_index, rng_slot, simulate, stock_tables};
```

and its `snapshot::take_snapshot()` call (line 27) to `game_mem::rpm_overmastery_snapshot()`.

In `src-tauri/examples/synth_probe.rs` change line 24 from:

```rust
use gbfr_logs::synthesis::{self, snapshot, SynthesisQuery, SynthesisSigil, EMPTY_TRAIT};
```

to:

```rust
use gbfr_logs::game_mem;
use gbfr_logs::synthesis::{self, SynthesisQuery, SynthesisSigil, EMPTY_TRAIT};
```

and its `snapshot::take_snapshot()` call (line 42) to `game_mem::rpm_synthesis_snapshot()`.

In `src-tauri/examples/synth_diag.rs` change line 7 from:

```rust
use gbfr_logs::synthesis::{self, snapshot};
```

to:

```rust
use gbfr_logs::game_mem;
use gbfr_logs::synthesis;
```

and its `snapshot::take_snapshot()` call (line 10) to `game_mem::rpm_synthesis_snapshot()`.

- [ ] **Step 11: Build everything.**

```
cargo test -p gbfr-logs --lib
cargo check -p gbfr-logs --examples
cargo clippy -p gbfr-logs
```

Expected: all green — engine tests (synthesis, overmastery, toolbox_rpc, parser, db) pass, examples compile.

- [ ] **Step 12: Commit** — `git add -A src-tauri/ Cargo.lock && git commit -m "feat(app): serve toolbox tools via hook RPC on both platforms"`

---

### Task 9: Frontend — unhide on Linux, new error slugs

**Files:**
- Modify: `src/backendErrors.ts`
- Modify: `src-tauri/lang/en/ui.json`
- Modify: `src/pages/Toolbox.tsx`
- Modify: `src/types.ts`

- [ ] **Step 1: Slugs.** In `src/backendErrors.ts` add to BOTH tool maps (`synthesis` and `overmastery`):

```ts
    "hook-outdated": "ui.toolbox.hook-outdated",
    "hook-unreachable": "ui.toolbox.hook-unreachable",
```

- [ ] **Step 2: Strings.** In `src-tauri/lang/en/ui.json`, inside `ui.toolbox`, add (only the `en` file — the others are autogenerated and fall back):

```json
    "hook-outdated": "The game is running an outdated version of the hook. Restart the game to load the update.",
    "hook-unreachable": "Couldn't reach the game hook. If this keeps happening, restart the game and Relink Logs.",
```

- [ ] **Step 3: Unhide the tools.** In `src/pages/Toolbox.tsx` delete both `windowsOnly: true,` lines from `TOOLS` and update the `visibleTools` doc comment to:

```ts
/** Tools visible on this platform. All current tools are served by the hook
 * over the toolbox RPC channel and work everywhere; the mechanism stays for
 * any future platform-gated tool. */
```

(Keep `visibleTools`, its type parameter, `useIsLinux`, and the existing `Toolbox.test.tsx` — the filter is now a no-op for the live TOOLS list but stays tested.)

- [ ] **Step 4: Types.** In `src/types.ts` add to `SynthesisSigil` (it now crosses as JSON with `recordLevel` since the serde skip was removed):

```ts
  /** Item-config record level; backend implementation detail, unused in UI. */
  recordLevel: number;
```

- [ ] **Step 5: Run** — `npx vitest run` — Expected: all frontend tests PASS (Toolbox.test.tsx untouched and still green). Then `npm run lint` and `npm run build` (tsc typecheck) — Expected: clean.

- [ ] **Step 6: Commit** — `git add src/ src-tauri/lang/en/ui.json && git commit -m "feat(frontend): toolbox on Linux, hook-outdated/unreachable states"`

---

### Task 10: toolbox_probe example — RPC vs RPM A/B harness

**Files:**
- Create: `src-tauri/examples/toolbox_probe.rs`

- [ ] **Step 1: Create `src-tauri/examples/toolbox_probe.rs`:**

```rust
//! Live A/B harness for the toolbox RPC channel: takes each snapshot BOTH
//! ways — via the hook's RPC listener (production path) and via
//! ReadProcessMemory (independent ground truth) — and reports whether they
//! agree. Run as admin with the game running and the hook injected:
//!
//!   cargo run -p gbfr-logs --example toolbox_probe
//!
//! Set GBFR_LOGS_FORCE_TCP=1 to exercise the TCP path (what Linux uses).
//! The two reads are not atomic — a sigil-box or RNG change between them is
//! a real difference, so run it while idling in a menu.

use anyhow::{bail, Result};
use gbfr_logs::{game_mem, toolbox_rpc};
use protocol::toolbox::{ToolboxRequest, ToolboxResponse, TOOLBOX_PROTOCOL_VERSION};

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    match toolbox_rpc::call(ToolboxRequest::Hello).await? {
        ToolboxResponse::Hello { protocol_version } => {
            println!(
                "hello: hook v{protocol_version}, app v{TOOLBOX_PROTOCOL_VERSION} => {}",
                if protocol_version == TOOLBOX_PROTOCOL_VERSION { "OK" } else { "MISMATCH" }
            );
        }
        other => bail!("unexpected hello response: {other:?}"),
    }

    let rpc_synth = match toolbox_rpc::call(ToolboxRequest::SynthesisSnapshot).await? {
        ToolboxResponse::SynthesisSnapshot(r) => r,
        other => bail!("unexpected response: {other:?}"),
    };
    let rpm_synth = game_mem::rpm_synthesis_snapshot();
    match (&rpc_synth, &rpm_synth) {
        (Ok(a), Ok(Some(b))) => {
            println!(
                "synthesis: rpc {} sigils (rng {:#x}, seed {}), rpm {} sigils (rng {:#x}, seed {}) => {}",
                a.sigils.len(), a.rng_state, a.seed_counter,
                b.sigils.len(), b.rng_state, b.seed_counter,
                if a == b { "IDENTICAL" } else { "DIFFER (re-run while idle in a menu)" }
            );
        }
        _ => println!("synthesis: rpc={rpc_synth:?}\n           rpm={rpm_synth:?}"),
    }

    let rpc_om = match toolbox_rpc::call(ToolboxRequest::OvermasterySnapshot).await? {
        ToolboxResponse::OvermasterySnapshot(r) => r,
        other => bail!("unexpected response: {other:?}"),
    };
    let rpm_om = game_mem::rpm_overmastery_snapshot();
    match (&rpc_om, &rpm_om) {
        (Ok(a), Ok(Some(b))) => {
            println!(
                "overmastery: rpc {} roster / override {:#x}, rpm {} roster / override {:#x} => {}",
                a.roster.len(), a.slot_override, b.roster.len(), b.slot_override,
                if a == b { "IDENTICAL" } else { "DIFFER (RNG may have ticked; re-run)" }
            );
        }
        _ => println!("overmastery: rpc={rpc_om:?}\n             rpm={rpm_om:?}"),
    }

    Ok(())
}
```

- [ ] **Step 2: Run** — `cargo check -p gbfr-logs --examples` — Expected: compiles.

- [ ] **Step 3: Commit** — `git add src-tauri/examples/toolbox_probe.rs && git commit -m "feat(diag): toolbox_probe RPC-vs-RPM A/B harness"`

---

### Task 11: CI + docs

**Files:**
- Modify: `.github/workflows/ci.yaml`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Linux CI.** In `.github/workflows/ci.yaml`, in the `cargo_check_linux` job, after the `- run: cargo check -p protocol` line add:

```yaml
      - run: cargo test -p game-reader
```

(The Windows `cargo_test` job runs the whole workspace, which now includes game-reader and protocol via the members list — no change needed there, but verify its command covers the workspace while editing.)

- [ ] **Step 2: CLAUDE.md.** In the architecture section:
  - Change the heading `## Architecture: four subprojects, two languages` to `## Architecture: five subprojects, two languages`.
  - In item 1 (src-hook), append to the paragraph: `The hook also serves the Toolbox RPC channel (see game-reader below).`
  - In item 2 (protocol), append: `The toolbox module carries the request/response channel for the Toolbox tools (\\.\pipe\gbfr-logs-toolbox on Windows, TCP 127.0.0.1:39372 under Wine; one request per connection; TOOLBOX_PROTOCOL_VERSION guards hook/app skew).`
  - Insert a new item 3 and renumber the old 3 and 4 to 4 and 5:

```markdown
3. **`game-reader/`** (crate `game-reader`) — Platform-independent snapshot
   walkers plus the RE'd signatures/offsets behind the Toolbox tools
   (synthesis, overmastery), generic over a `MemRead` trait and unit-tested
   against fake memory. Production path: the hook reads in-process (guarded)
   and serves results over the toolbox RPC channel — on both OSes. The diag
   examples (`om_probe`, `synth_probe`, `synth_diag`, `toolbox_probe`) read
   the same structures via `ReadProcessMemory` (`src-tauri/src/game_mem.rs`,
   Windows-only, admin) as an independent cross-check. A game patch that
   moves these structures is fixed in this crate.
```

- [ ] **Step 3: Commit** — `git add .github/workflows/ci.yaml CLAUDE.md && git commit -m "chore: CI and docs for the game-reader crate and toolbox RPC"`

---

### Task 12: Full verification

- [ ] **Step 1: Workspace build + tests** (from the repo root):

```
cargo test
cargo clippy --workspace
```

Expected: every crate green (protocol, game-reader, hook, gbfr-logs), no new clippy warnings. Note: `cargo test` on the workspace builds the hook crate too — normal on Windows.

- [ ] **Step 2: Frontend:**

```
npx vitest run
npm run lint
npm run build
```

Expected: all green.

- [ ] **Step 3: Do NOT write a CHANGELOG entry** (humans-only per repo policy) — instead remind the user: the next stable release needs a `## <version>` section covering "Toolbox tools now work on Linux".

- [ ] **Step 4: Report the manual live-test checklist to the user** (Claude cannot run the game). All on Windows; item 4 covers the exact code path Linux uses:

1. Rebuild + relaunch: `npm run tauri dev`, then **close and relaunch the game** so the new hook (with the RPC listener) loads. Beware the stale-`hook-dbg.dll` trap: the dev script refreshes it, but only a game restart loads it.
2. Synthesis Helper: with the game in a menu, open the tool — status shows sigil count; run a search; verify results appear and the staleness banner still triggers after performing one synthesis in-game.
3. Overmastery Predictor: roster picker populates; predict; staleness poll flips after rolling in-game.
4. TCP parity: set `GBFR_LOGS_FORCE_TCP=1` in BOTH the game's and the app's environment, restart both, repeat step 2 — this is the Linux transport end-to-end.
5. A/B: `cargo run -p gbfr-logs --example toolbox_probe` (admin, game idle in menu) — expect `IDENTICAL` for both tools.
6. Version-skew UX: temporarily build the app with `TOOLBOX_PROTOCOL_VERSION` bumped (edit, build, revert) OR run the new app against the still-running old hook — the tools should show the "outdated hook — restart the game" banner, not garbage.
7. No-game UX: with the game closed, both tools show the plain "game not running" state.

- [ ] **Step 5:** After user confirms live tests: merge via PR to `dev` per repo flow (push branch, `gh pr create`). Remind: pushing to `dev` publishes a signed RC prerelease automatically.
