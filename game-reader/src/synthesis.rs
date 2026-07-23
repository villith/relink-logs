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
