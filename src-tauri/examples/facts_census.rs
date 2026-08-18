//! Census of the damage-facts capture fields over stored logs — which per-hit
//! windows the hook actually populated, per log and per party actor. This is
//! the offline half of the damage-facts live-gate checklist and the patch-day
//! regression gate for the capture: a game patch that moves a window shows up
//! here as a populated-count collapse before anyone reads a wrong value.
//!
//! Per party actor it reports: hit count; how many hits carry damage_cap /
//! base_damage / class_flags / the attacker HP+status snapshot; how many
//! statuses carry a term_bits probe value; instance/source/record snapshot
//! presence; how many instance snapshots the parser's own rule
//! (`InstSnapshot::builder_populated`, precap-only) reads as MEASURED; and the
//! seven gate bytes' set-rates on populated hits. Unpopulated snapshots with
//! any gate byte set are counted separately — the remote-stamping signal that
//! decides whether a fact's measured boundary can widen (online log 2657:
//! crit rides the network, the six target-state bytes do not).
//!
//! Run: cargo run --release -p gbfr-logs --example facts_census -- [--db path] [--last N | --id N]

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use anyhow::{Context, Result};
use gbfr_logs::parser::v1::damage_facts::{GateByte, InstSnapshot};
use protocol::Message;
use rusqlite::{Connection, OpenFlags};

#[derive(Default)]
struct ActorStats {
    hits: usize,
    cap: usize,
    base: usize,
    class: usize,
    hp: usize,
    statuses: usize,
    status_entries: usize,
    term_bits: usize,
    rec: usize,
    src: usize,
    inst: usize,
    populated: usize,
    unpop_gate_set: usize,
    gate_set: [usize; 7],
    elemental: BTreeSet<String>,
}

fn main() -> Result<()> {
    let mut db = PathBuf::from("src-tauri/logs.db");
    let mut last = 10usize;
    let mut only: Option<i64> = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => db = PathBuf::from(args.next().context("--db needs a path")?),
            "--last" => last = args.next().context("--last needs N")?.parse()?,
            "--id" => only = Some(args.next().context("--id needs N")?.parse()?),
            other => anyhow::bail!("unknown argument {other}"),
        }
    }

    let conn = Connection::open_with_flags(
        &db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| format!("open {}", db.display()))?;
    let mut stmt = conn.prepare(
        "SELECT id, length(data), data, version FROM logs \
         WHERE (?1 IS NULL OR id = ?1) ORDER BY id DESC LIMIT ?2",
    )?;
    let rows = stmt.query_map(rusqlite::params![only, last], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, Vec<u8>>(2)?,
            row.get::<_, u8>(3)?,
        ))
    })?;

    for row in rows {
        let (id, blob_len, blob, version) = row?;
        let Ok(parsed) = gbfr_logs::parser::deserialize_version(&blob, version) else {
            println!("log {id}: undecodable (version {version})");
            continue;
        };

        let party: BTreeSet<u32> = parsed.derived_state.party.keys().copied().collect();
        let mut actors: BTreeMap<u32, ActorStats> = BTreeMap::new();
        for (_, event) in parsed.encounter.raw_event_log.iter() {
            let Message::DamageEvent(hit) = event else {
                continue;
            };
            if !party.contains(&hit.source.parent_index) {
                continue;
            }
            let a = actors.entry(hit.source.parent_index).or_default();
            a.hits += 1;
            a.cap += usize::from(hit.damage_cap.is_some());
            a.base += usize::from(hit.base_damage.is_some());
            a.class += usize::from(hit.class_flags.is_some());
            a.hp += usize::from(hit.source_current_hp.is_some());
            if let Some(statuses) = &hit.source_statuses {
                a.statuses += 1;
                a.status_entries += statuses.len();
                a.term_bits += statuses.iter().filter(|s| s.term_bits.is_some()).count();
            }
            a.rec += usize::from(hit.record_snapshot.is_some());
            if let Some(src) = &hit.source_snapshot {
                if src.len() == 0x20 {
                    a.src += 1;
                    let f = |off: usize| {
                        f32::from_le_bytes([src[off], src[off + 1], src[off + 2], src[off + 3]])
                    };
                    // Window base 0x2480: elemental base +0x2488, overflow k +0x249C.
                    a.elemental.insert(format!("{}/{}", f(0x8), f(0x1C)));
                }
            }
            if let Some(snap) = InstSnapshot::parse(hit.instance_snapshot.as_deref()) {
                a.inst += 1;
                if snap.builder_populated() {
                    a.populated += 1;
                    for (i, byte) in GateByte::ALL.iter().enumerate() {
                        a.gate_set[i] += usize::from(snap.gate(*byte));
                    }
                } else if GateByte::ALL.iter().any(|byte| snap.gate(*byte)) {
                    a.unpop_gate_set += 1;
                }
            }
        }
        if actors.is_empty() {
            continue;
        }

        println!("log {id} ({:.2} MB, v{version})", blob_len as f64 / 1e6);
        for slot in parsed.encounter.player_data.iter().flatten() {
            let p = serde_json::to_value(slot).unwrap_or_default();
            let g = |k: &str| p.get(k).cloned().unwrap_or_default();
            println!(
                "  player actor={} char={} online={} capUp n/s/b = {}/{}/{}",
                g("actorIndex"),
                g("characterType"),
                g("isOnline"),
                g("capUpNormal"),
                g("capUpSkill"),
                g("capUpSba"),
            );
        }
        for (index, a) in &actors {
            let character = parsed
                .derived_state
                .party
                .get(index)
                .map(|p| format!("{:?}", p.character_type))
                .unwrap_or_default();
            println!(
                "  actor {index} ({character}): hits={} cap={} base={} class={} hp={} statuses={} \
                 termBits={}/{} rec={} src={} inst={} populated={} unpopGateSet={}",
                a.hits,
                a.cap,
                a.base,
                a.class,
                a.hp,
                a.statuses,
                a.term_bits,
                a.status_entries,
                a.rec,
                a.src,
                a.inst,
                a.populated,
                a.unpop_gate_set,
            );
            if a.populated > 0 {
                println!(
                    "    gates on populated [crit,wp,ba,vuln,deb,od,brk] = {:?} of {}",
                    a.gate_set, a.populated
                );
            }
            if !a.elemental.is_empty() {
                let shown: Vec<&String> = a.elemental.iter().take(6).collect();
                println!(
                    "    source-window elemental/k: {} distinct: {:?}",
                    a.elemental.len(),
                    shown
                );
            }
        }
    }
    Ok(())
}
