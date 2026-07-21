---
name: reverse-engineering-signatures
description: Use when a Granblue Fantasy Relink game patch breaks the GBFR Logs hook — signatures no longer match, "Could not find match for pattern" / "Could not find <offset>" warnings, hooks logging FAIL at startup, an offset reads a wrong/garbage value, or a hook crashes the game. Covers re-deriving AOB byte-signatures and struct offsets in src-hook/ using the sigscan harness and Ghidra lean analysis.
---

# Reverse-Engineering GBFR Signatures

## Overview

The hook (`src-hook/`) reads game memory via **reverse-engineered byte-signatures (AOB scans)** and **struct field offsets**. A game patch that recompiles `granblue_fantasy_relink.exe` shifts both, silently. This skill re-derives them.

Two tools, two jobs:
- **`sigscan`** (Rust, in-repo) — scans the *on-disk exe*. Fast. Confirms a pattern's match count, reads offset operands, follows calls, dumps bytes. **Your primary tool.**
- **Ghidra lean analysis** — when you need a function's true **entry point** (for a hook target). `sigscan` can follow a `call`, but the call target may be a *callee mid-logic*, not a clean entry — hooking that crashes the game. Ghidra gives the real function boundary.

Core rule: **a signature is only trustworthy when `sigscan` reports exactly 1 match. A hook target is only safe when Ghidra confirms it's a function ENTRY with the right argument count.**

## When to use

- Hook log (`%APPDATA%\gbfr-logs\gbfr-logs.txt`) shows `Could not find match for pattern` or `[hook FAIL] <name>`.
- An offset resolves but reads a wrong value (e.g. skill names show as `Skill <bignum>`, damage cap reads 0) — an inner struct field shifted.
- A hook crashes the game (access violation) — likely hooking a non-entry or wrong-arity function.
- After any GBFR game update.

Two failure classes, two approaches:

| Symptom | It's a... | Tool |
|---------|-----------|------|
| pattern 0 matches / offset warning | broken **AOB signature** | sigscan (re-anchor) |
| wrong value read, no crash | shifted **struct field offset** | sigscan `dumprva` + live diag |
| game crashes on hook | wrong **function target/arity** | Ghidra (find true entry) |

## The sigscan harness

```sh
# from repo root; GBFR_EXE overrides the default Steam path
cargo run -p hook --bin sigscan --release -- "<pelite pattern>" [mode]
```

Modes: `slice_u32` (default, read a u32 operand at cursor), `slice_u8`, `addr` (follow a call, report target RVA), `dumprva <hexrva> [len]` (raw bytes at an RVA).

Every match prints `pre:` (24 bytes before) + `at:` (48 bytes from the match) — essential for re-anchoring. **Want exactly 1 match.** See the file header in `src-hook/src/bin/sigscan.rs` for details.

**Pattern syntax (pelite):** `?` = wildcard byte, `'` = store-cursor marker (its RVA → `addrs[1]`, what `search_slice`/`search_address` return), `e8 $ { ' }` = follow the `call` and capture its target. `search_address` returns `base + cursor`.

### Re-deriving an offset signature

Old patterns embed **magic type-hash constants** (e.g. `0x887ae0b0` = LE `b0 e0 7a 88`) that **survive recompiles**. Anchor on the surviving constant:

1. `sigscan "<old pattern>"` → confirm it now gives 0 matches (the break).
2. Find the surviving constant nearby; dump bytes around it (`dumprva`).
3. Rebuild the pattern around the constant, place `'` at the operand you need.
4. `sigscan "<new pattern>"` until it gives **1 match** with the right value.

Compiler drift to expect: `mov eax,K`→`mov r8d,K` (`b8`→`41 b8`); base register `rsi`→`r14` (`48 8d 8e`→`49 8d 8e`); AVX sequences re-ordered.

### Shifted struct field (wrong value, no crash)

The AOB sig is fine but a field *inside* the struct moved. Confirm with a wide live dump: build with the `dmgdiag` feature (`cargo build -p hook --features dmgdiag`) — `damage.rs` then logs every nonzero u32 in a window per real hit. Match the known value (a skill ID, a cap magnitude) to its new offset, update `ffi.rs`.

## Ghidra: finding a function's true entry

Needed only for **function-hook targets** (the thing you detour). One-time setup already done (Ghidra 12.1.2 at `C:\ghidra\ghidra_12.1.2_PUBLIC`, JDK 21 wired via `support\launch.properties`).

**For most fixes, use lean import (`-noanalysis`)** + a targeted Java post-script that disassembles only a local window — fast, no decompiler needed.

**When lean isn't enough** (the surviving byte-anchor keeps landing in generic FNV-1a hashmap-lookup helpers, so you can't tell the real accessor apart — this happens for player_load, the sigil/weapon/overmastery offsets, and the SBA family), you need the **decompiler + xrefs** from a full analysis pass.

**The analyzed DB already exists: `gbfr202fast` (project `C:\Users\Scott\ghidra-projects\gbfr`, ~1.7 GB `.rep`, persists).** For v2.0.2 you do NOT need to rebuild it — just query it (see "Decompile a function" below). Only re-run the analysis after a NEW game patch.

To (re)build it after a patch — do NOT run the *default* full analysis (multi-hour: the "Decompiler Parameter ID" analyzer alone ~10x's the time). Run a **fast analysis** with the slow analyzers disabled (still gives function boundaries, xrefs, decompiler, and C++ RTTI class names). **Measured: ~2h49m** on the 118 MB exe (i5-13600K, NVMe) — run it in the background and wait for the completion notification:

```sh
cd C:/ghidra/ghidra_12.1.2_PUBLIC/support
SKILL=C:/Users/Scott/Projects/gbfr-logs/.claude/skills/reverse-engineering-signatures/ghidra
GHIDRA_HEADLESS_MAXMEM=28G ./analyzeHeadless.bat \
  C:/Users/Scott/ghidra-projects/gbfr gbfr<version>fast \
  -import "<path to granblue_fantasy_relink.exe>" -processor x86:LE:64:default \
  -scriptPath "$SKILL" -preScript FastAnalysisOptions.java   # run in background
```

`FastAnalysisOptions.java` disables `Decompiler Parameter ID`, `Decompiler Switch Analysis`, `Call Convention ID`, `Aggressive Instruction Finder`, `Stack`, and logs `getOptionNames()` to prove it applied. **VERIFY** the run log shows `FastAnalysisOptions: DISABLED '<name>'` lines. Success markers at the end: `Analysis succeeded` + `Save succeeded` + `Import succeeded`. **Gotchas:** `-preScript` needs `-scriptPath <dir> -preScript <bare-name.java>` (an absolute path arg → ClassNotFound). Use ≤28G heap (heap is hard-capped by `-Xmx`; won't exceed it). Fresh project name so the lean DB stays usable. The late RTTI phase (`CreateRtti4BackgroundCmd`, "Unprocessed TypeDescriptor" lines) is CPU-light, single-threaded, and logs sparsely — a quiet log ≠ hung; it also emits non-fatal `ERROR No vfTable found` / `VarnodeContext: out of address spaces` and continues. **When checking if it's alive, find the RIGHT java PID** — `Get-CimInstance Win32_Process -Filter "Name='java.exe'" | select ProcessId,CommandLine` and pick the one whose command line contains `ghidra.GhidraClassLoader` (NOT the Cursor/VSCode `redhat.java` LSP), then sample that PID's `TotalProcessorTime` over 10s (>0 = working).

### Decompile a function (the analyzed DB's superpower)

`Decompile.java` prints a function's C. Use it to read what a function actually DOES — arg meaning, which enum values branch where, what struct fields it touches — instead of guessing from asm or chasing byte idioms into generic helpers.

```sh
cd C:/ghidra/ghidra_12.1.2_PUBLIC/support
SKILL=C:/Users/Scott/Projects/gbfr-logs/.claude/skills/reverse-engineering-signatures/ghidra
GHIDRA_HEADLESS_MAXMEM=12G ./analyzeHeadless.bat \
  C:/Users/Scott/ghidra-projects/gbfr gbfr202fast -process granblue_fantasy_relink.exe \
  -noanalysis -scriptPath "$SKILL" -postScript Decompile.java 0x3f1330 0x63ecb0   # 1+ RVAs
```

Filter with `grep 'Decompile.java>'`. Runs against the analyzed `gbfr202fast` DB (the decompiler needs analysis). `-noanalysis` here just means "don't re-analyze on open." Takes the RVA of any byte inside the target function (it resolves the containing function). Example payoff: decompiling the result-screen router `FUN_1403f1330` showed `if (0x13 < param_2) return; if (*(char*)(param_1 + 0xed4 + param_2*0x40) == 0) return;` — i.e. result_type is a per-screen table index, NOT a quest-clear flag, proving that hardcoding `result_type == N` is fragile. That's the kind of ground truth lean analysis can't give you.

### One-time: import the exe (≈2 min)

```sh
cd C:/ghidra/ghidra_12.1.2_PUBLIC/support
GHIDRA_HEADLESS_MAXMEM=24G ./analyzeHeadless.bat \
  C:/Users/Scott/ghidra-projects/gbfr gbfr202lean \
  -import "<path to granblue_fantasy_relink.exe>" \
  -processor x86:LE:64:default -noanalysis
```

The saved program DB lives at `C:\Users\Scott\ghidra-projects\gbfr\gbfr202lean.rep` (~2.3 GB) and **persists**. Re-import only after a new game patch (use a fresh project name, e.g. `gbfr<version>lean`). The project's **parent dir must exist** and Ghidra 12 needs `-processor` explicit.

### Per-query: find entries / inspect a function (≈90 s each)

Scripts live in `ghidra/` next to this skill. Run against the saved DB with `-process` (no re-import). **Ghidra 12 has no Python by default — these are Java `GhidraScript`s.**

```sh
cd C:/ghidra/ghidra_12.1.2_PUBLIC/support
SKILL=C:/Users/Scott/Projects/gbfr-logs/.claude/skills/reverse-engineering-signatures/ghidra

# Find the true ENTRY of the function CONTAINING each anchor RVA (a byte inside it):
GHIDRA_HEADLESS_MAXMEM=24G ./analyzeHeadless.bat \
  C:/Users/Scott/ghidra-projects/gbfr gbfr202lean -process granblue_fantasy_relink.exe \
  -noanalysis -scriptPath "$SKILL/ghidra" -postScript FindEntry.java 0x3f13b5 0x63ecb0

# Inspect a function ENTRY (callers, callees, string refs, arg usage from prologue):
GHIDRA_HEADLESS_MAXMEM=24G ./analyzeHeadless.bat \
  C:/Users/Scott/ghidra-projects/gbfr gbfr202lean -process granblue_fantasy_relink.exe \
  -noanalysis -scriptPath "$SKILL/ghidra" -postScript InspectFunc.java 0x3f1330
```

Output is verbose; filter with `grep 'FindEntry.java>\|InspectFunc.java>'`. Run in background (`run_in_background`) — JVM startup dominates.

### Reading the prologue for argument count (critical)

The prologue tells you the arity — **get this wrong and the detour crashes the game**. In the x64 MS ABI, args arrive in `rcx, rdx, r8, r9`. If the prologue reads `rdx`/`edx`/`r8`/`r9` early, the function takes that many args:

```
cmp edx, 0x13      ; uses arg2 → at least a 2-arg fn
mov rbx, rcx       ; arg1
```

Match your `retour` detour signature and `.call(...)` to the real arity. A 1-arg detour on a 2-arg function leaves a register garbage → access violation.

## End-to-end: fixing one function hook

1. Find a byte fingerprint that survived, *inside* the target (use `sigscan` to confirm it's unique).
2. `FindEntry.java <anchor_rva>` → true entry RVA (self-check: a known-good anchor must resolve to its own entry).
3. `InspectFunc.java <entry_rva>` → confirm it's the right function (callers, behavior) and read its arg count from the prologue.
4. Build a signature that resolves to the entry. Direct-entry form: match the preceding `ret`+`int3` padding then the prologue, cursor at entry — `c3 cc cc cc cc ' <prologue bytes>`. Verify with `sigscan "<pattern>" addr` → 1 match, `target_rva` = the entry.
5. Update the hook's `const *_SIG`, the `type` alias, `static_detour!`, and `run()`/`.call()` to the correct arity.
6. `cargo build -p hook --release`, then copy to `src-tauri/hook.dll` (see below), restart game, test.

## Injection gotcha

The app injects `src-tauri/hook.dll` from CWD (dev). `build.rs` refreshes it *only* on a backend recompile, so after rebuilding just the hook:

```sh
cp -f target/release/hook.dll src-tauri/hook.dll
```

The injected DLL is **locked while the game runs** — close the game to swap it. Re-injecting a same-named already-loaded DLL is a silent no-op.

## Common mistakes

- **Trusting a unique `call`-follow match as a hook target.** Unique ≠ clean entry. The followed target can be a callee mid-function. Always confirm the entry with Ghidra before detouring. (This crashed the quest hook on v2.0.2: the old sig followed a call to a 2-arg helper hooked as 1-arg.)
- **Running the DEFAULT full Ghidra auto-analysis.** Multi-hour (Decompiler Parameter ID ~10x's it). For quick lookups use lean `-noanalysis` + targeted scripts; when you genuinely need the decompiler, use the *fast* analysis (analyzers disabled via `FastAnalysisOptions.java`) — and note the analyzed `gbfr202fast` DB already exists for v2.0.2, so query it, don't rebuild.
- **Misidentifying the Ghidra java PID as hung.** Sampling the wrong `java.exe` (e.g. the editor's `redhat.java` LSP) shows 0 CPU and looks dead. Match on `ghidra.GhidraClassLoader` in the command line first.
- **Writing Ghidra scripts in Python.** Ghidra 12 has no Python without PyGhidra. Use Java `GhidraScript`s.
- **Assuming a surviving AOB sig means correct data.** Inner struct offsets shift independently and fail *silently* as wrong numbers — verify the value, not just the match.
- **Hand-computing RVA→file-offset with a fixed delta.** Wrong for high sections. Use `sigscan dumprva` (correct pelite addressing).
- **Deleting diagnostic logging.** The `dmgdiag` feature block and `console`-gated prints are kept on purpose for the next patch.

## Files

- `src-hook/src/bin/sigscan.rs` — the harness (in-repo, committed).
- `ghidra/FindEntry.java` — anchor RVA(s) → containing-function entry RVA + prologue bytes (lean DB).
- `ghidra/InspectFunc.java` — entry RVA(s) → callers, callees, string refs, prologue disasm (lean DB).
- `ghidra/FindByBytes.java` — byte pattern → containing-function entry for each hit (lean DB).
- `ghidra/FindStringRefs.java` — ASCII substring → enclosing C-strings → code xrefs + containing-function entries (needs the **analyzed** DB for xrefs).
- `ghidra/XrefsTo.java` — RVA(s) → every referencing site, deduped by containing function with per-function counts. THE query for "who touches this global/vtable/function" (needs the **analyzed** DB).
- `ghidra/ListSymbols.java` — case-insensitive substring search over the symbol table (RTTI class/vtable names) (needs the **analyzed** DB).
- `ghidra/FindVCallSlot.java` — slot displacement (e.g. `0x48`) → every indirect `CALL qword ptr [reg + disp]` site with its containing function, plus the surrounding instructions. THE query for "who calls virtual slot N", which `XrefsTo` cannot answer: a virtual call references only the vtable, never the callee. Scans the listing, so data bytes that happen to match are never reported. Expect many hits — filter by the caller's code region and by how the out-param is used.
- `ghidra/DumpVtableSlot.java` — class-name substring + slot displacement → the function each matching `<Class>::vftable` holds at that slot, with a tally of distinct targets. Answers "which subclasses OVERRIDE this virtual and which inherit the base", i.e. exactly how many detours a virtual needs. Classes with multiple vftables (multiple inheritance) or short vtables produce misaligned reads — sanity-check a candidate by decompiling it before trusting it.
- `ghidra/Decompile.java` — RVA(s) → decompiled C of the containing function (needs the **analyzed** `gbfr202fast` DB).
- `ghidra/FastAnalysisOptions.java` — pre-script that disables slow analyzers for the fast full-analysis build.

**Two Ghidra DBs** (both under `C:\Users\Scott\ghidra-projects\gbfr`, both persist): `gbfr202lean` (import-only, for fast FindEntry/InspectFunc/FindByBytes lookups) and `gbfr202fast` (fully analyzed, for `Decompile.java` + xrefs + C++ RTTI names). Re-create both only after a new game patch.

Detailed, evolving findings for the current patch live in the memory file `gbfr-endless-ragnarok-break` (verified entries, offsets, and per-hook status).
