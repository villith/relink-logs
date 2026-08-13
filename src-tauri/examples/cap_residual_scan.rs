//! Residual scan for the damage-cap model: explain the hits the integer-percent
//! grid rejects.
//!
//! ## What the rejects turned out to be (measured 2026-08-13, logs 2549/2612)
//!
//! `cap_curve_check` proves ~99% of capped hits satisfy
//! `cap == trunc(base * K/100)` for an integer K. The rejects cluster on
//! actors with a state-gated cap term — measured on Id (dragon form: human
//! K 2417, transformed 2487, pre-first-transform 2357) and Rackam (his
//! Duration/overheat windows) — and the term does not SWITCH, it EASES: on every state flip the
//! game ramps the +70 in near-linearly over ~1.3s (equal per-frame steps; the
//! rapid dragon combo samples it at exactly +14.4714 K per 267 ms hit), then
//! an asymptotic tail creeps the last ~0.07 K over several more seconds
//! (69.93 -> 69.999). Hits landed mid-transition carry the eased multiplier —
//! genuinely off the integer grid, the game's own value, not model error.
//! The eased value is not reconstructable offline (it is a function of frame
//! time since the flip), but it is BOUNDED: it lies between the actor's own
//! on-grid states. That bound is the classifier here.
//!
//! Two falsified hypotheses, kept as automated checks because they are real
//! mechanisms that could explain OTHER corpora: "DMG Cap Cobalt"
//! (trait `aefeb1bc`, a linear band over crit rate — the only loadout trait
//! whose value is continuous; no violator in this corpus carries it) and its
//! max-HP sibling "Fjord" (`3b71af12`). Network sync was also ruled out: the
//! violating slots include a local AI Rackam and exclude a local AI Id in
//! the same party as a violating remote Id — the discriminator is the state
//! term, not locality.
//!
//! For every off-grid hit this example computes the excess over the actor's
//! modal on-grid K, classifies it (transition-band / Cobalt-band), and
//! correlates off-grid-ness with the per-hit attacker status snapshot
//! (`source_statuses`). All offline — no live round.
//!
//! Modes (the validating-models-against-logs shape):
//! - sweep (default): every log in range, per-actor residual table + a final
//!   worklist of actors with hits NO named mechanism explains.
//! - `--log N` (repeatable): restrict to specific logs.
//! - `--dump`: per-hit rows for every off-grid hit (action, rate, cap, base,
//!   K, excess, snapshot statuses) plus per-actor grid states.
//! - `--trace 0xf000000N`: TSV time series of one actor's every capped hit
//!   and status transitions, for fitting the easing dynamics offline.
//! - `--markdown`: emit `docs/damage-cap-coverage.md` (per-character coverage
//!   table + the unaccounted list) instead of the per-log report.
//!
//! Run: cargo run --release -p gbfr-logs --example cap_residual_scan -- [--db path] [--last N] [--log N ...] [--dump]

use std::collections::BTreeMap;
use std::path::PathBuf;

use anyhow::{Context, Result};
use protocol::Message;
use rusqlite::{Connection, OpenFlags};
use serde::Deserialize;

/// "DMG Cap Cobalt" — the crit-rate-banded cap trait.
const COBALT: u32 = 0xaefeb1bc;
/// "DMG Cap Fjord" — the max-HP-banded sibling. Max HP is fixed for a whole
/// fight, so it shifts EVERY hit by one constant (possibly fractional) offset
/// rather than scattering them; flagged in the loadout line so a uniform
/// off-grid actor reads as this, not as an unknown.
const FJORD: u32 = 0x3b71af12;

#[derive(Deserialize)]
struct Point {
    x: f32,
    y: f32,
}

#[derive(Deserialize)]
struct Tables {
    curves: BTreeMap<String, BTreeMap<String, Vec<Point>>>,
}

/// The Cobalt rows of `cap-up-sources.json`: band value ends per trait level.
struct CobaltBand {
    cap_min: Vec<f64>,
    cap_max: Vec<f64>,
}

/// `xxhash32("SO0000")` — the summon curve's key in the normal map.
const SUMMON_CURVE_KEY: &str = "58f4dbd4";

/// The builder's own ladder walk — see `cap_curve_check` for why f32 is
/// load-bearing.
fn game_base(points: &[Point], rate: f32) -> i64 {
    let Some(last) = points.last() else {
        return 0;
    };
    let mut lo: Option<&Point> = None;
    for p in points {
        if rate < p.x {
            let Some(lo) = lo else {
                return p.y.trunc() as i64;
            };
            let span = p.x - lo.x;
            if span <= 0.0 {
                return lo.y.trunc() as i64;
            }
            return (((p.y - lo.y) * (rate - lo.x)) / span + lo.y).trunc() as i64;
        }
        lo = Some(p);
    }
    last.y.trunc() as i64
}

/// Integer-percent grid test, same tolerance as `capLadder.ts`.
fn cap_consistent(cap: i64, base: i64) -> bool {
    if cap <= 0 || base <= 0 {
        return false;
    }
    let k = ((100 * cap) as f64 / base as f64).round();
    if k < 100.0 {
        return false;
    }
    let predicted = base as f64 * k / 100.0;
    let tolerance = (predicted * 1e-5).max(1.0);
    cap >= (predicted - tolerance).trunc() as i64 && cap <= (predicted + tolerance).trunc() as i64
}

/// Half-percent point test: K within the same tolerance of an odd multiple of
/// 0.5 (an even one is the integer grid). Rosetta's log 2567 measured K exactly
/// at 849.500 / 879.5 / 884.5 across every action all fight — some builds
/// carry a half-percent cap source the integer grid cannot represent, so this
/// is a named class, never folded into `cap_consistent`.
fn half_grid(cap: i64, base: i64) -> bool {
    if cap <= 0 || base <= 0 {
        return false;
    }
    let k2 = ((200 * cap) as f64 / base as f64).round();
    if k2 % 2.0 == 0.0 || k2 < 200.0 {
        return false;
    }
    let predicted = base as f64 * k2 / 200.0;
    let tolerance = (predicted * 1e-5).max(1.0);
    cap >= (predicted - tolerance).trunc() as i64 && cap <= (predicted + tolerance).trunc() as i64
}

/// Attack-class bucket: modal K is only comparable within one class, because
/// the record's cap-up differs per class.
fn bucket(flags: u32) -> &'static str {
    if flags & 0x80 != 0 {
        "summon"
    } else if flags & 0x40000 != 0 {
        "sba"
    } else if flags & 0x10000 != 0 {
        "skill"
    } else {
        "normal"
    }
}

/// Total Cobalt trait level in a stored loadout: sigil traits, weapon traits,
/// plus the weapon-transcendence grant at the weapon's star level. Levels of
/// one trait sum across sources; the game caps the total (15 for Cobalt).
fn trait_level(
    player: &serde_json::Value,
    trait_id: u32,
    transcendence: &serde_json::Value,
) -> u32 {
    let mut level = 0u64;
    if let Some(sigils) = player["sigils"].as_array() {
        for sigil in sigils {
            for (id, lvl) in [
                ("firstTraitId", "firstTraitLevel"),
                ("secondTraitId", "secondTraitLevel"),
            ] {
                if sigil[id].as_u64() == Some(trait_id as u64) {
                    level += sigil[lvl].as_u64().unwrap_or(0);
                }
            }
        }
    }
    let weapon = &player["weaponInfo"];
    for (id, lvl) in [
        ("trait1Id", "trait1Level"),
        ("trait2Id", "trait2Level"),
        ("trait3Id", "trait3Level"),
    ] {
        if weapon[id].as_u64() == Some(trait_id as u64) {
            level += weapon[lvl].as_u64().unwrap_or(0);
        }
    }
    if let (Some(weapon_id), Some(star)) =
        (weapon["weaponId"].as_u64(), weapon["starLevel"].as_u64())
    {
        let key = format!("{weapon_id:08x}");
        if let Some(traits) = transcendence[&key].as_array() {
            for entry in traits {
                let want = format!("{trait_id:08x}");
                if entry["id"].as_str() == Some(want.as_str()) {
                    if let Some(levels) = entry["levels"].as_array() {
                        level += levels
                            .get(star as usize)
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0);
                    }
                }
            }
        }
    }
    level.min(15) as u32
}

struct HitDetail {
    time: i64,
    action: String,
    bucket: &'static str,
    rate: f32,
    cap: i64,
    base: i64,
    k_float: f64,
    statuses: Option<Vec<(u32, u32)>>,
}

#[derive(Default)]
struct ActorStats {
    /// consistent hits: bucket -> (K -> count)
    good_k: BTreeMap<&'static str, BTreeMap<i64, usize>>,
    /// consistent hits' status presence: status -> count, plus total snapshots
    good_status: BTreeMap<u32, usize>,
    good_snapshots: usize,
    good: usize,
    bad: Vec<HitDetail>,
    bad_status: BTreeMap<u32, usize>,
    bad_snapshots: usize,
}

fn main() -> Result<()> {
    let mut db = PathBuf::from("src-tauri/logs.db");
    let mut last = 200usize;
    let mut only_logs: Vec<i64> = Vec::new();
    let mut dump = false;
    let mut markdown = false;
    let mut trace: Option<u32> = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => db = PathBuf::from(args.next().context("--db needs a path")?),
            "--last" => last = args.next().context("--last needs N")?.parse()?,
            "--log" => only_logs.push(args.next().context("--log needs an id")?.parse()?),
            "--dump" => dump = true,
            // Print ONLY the per-character coverage doc (the body of
            // docs/damage-cap-coverage.md) instead of the per-log report.
            "--markdown" => markdown = true,
            // Machine-readable time series for ONE actor: every capped hit's
            // implied K plus the actor's status apply/remove events, for
            // fitting the transition dynamics offline.
            "--trace" => {
                let raw = args.next().context("--trace needs an actor index")?;
                let raw = raw.trim_start_matches("0x");
                trace = Some(u32::from_str_radix(raw, 16).context("--trace parses hex")?);
            }
            other => anyhow::bail!("unknown argument {other}"),
        }
    }

    let tables: Tables = serde_json::from_str(include_str!("../assets/damage-cap-tables.json"))?;
    let normal = tables.curves.get("normal").context("no normal curves")?;
    let arts = tables.curves.get("arts").context("no arts curves")?;
    let hashes: BTreeMap<String, String> =
        serde_json::from_str(include_str!("../../src/assets/character-id-hashes.json"))?;
    let key_by_name: BTreeMap<String, String> = hashes
        .into_iter()
        .map(|(hash, name)| (name, hash))
        .collect();
    let transcendence: serde_json::Value =
        serde_json::from_str(include_str!("../../src/assets/weapon-transcendence.json"))?;
    let sources: serde_json::Value =
        serde_json::from_str(include_str!("../../src/assets/cap-up-sources.json"))?;
    let cobalt_inputs = &sources["conditionalTraitInputs"]["aefeb1bc"];
    let band = CobaltBand {
        cap_min: serde_json::from_value(cobalt_inputs["capMin"].clone())?,
        cap_max: sources["conditionalTraits"]["aefeb1bc"]
            .as_array()
            .context("no cobalt values")?
            .iter()
            .map(|row| row[0].as_f64().unwrap_or(0.0))
            .collect(),
    };

    let conn = Connection::open_with_flags(
        db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let log_ids: Vec<i64> = if only_logs.is_empty() {
        conn.prepare("SELECT id FROM logs ORDER BY id DESC LIMIT ?1")?
            .query_map([last], |row| row.get(0))?
            .collect::<std::result::Result<Vec<i64>, _>>()?
    } else {
        only_logs
    };

    let char_names: BTreeMap<String, String> =
        serde_json::from_str(include_str!("../lang/en/characters.json"))?;

    // worklist entries: (n_bad, description)
    let mut worklist: Vec<(usize, String)> = Vec::new();
    let (mut total_hits, mut total_bad, mut total_explained) = (0usize, 0usize, 0usize);
    // character -> [total, on-grid, transition, settling, half-grid, cobalt, unexplained]
    let mut by_char: BTreeMap<String, [usize; 7]> = BTreeMap::new();

    for id in log_ids {
        let Ok((blob, version)) = conn.query_row(
            "SELECT data, version FROM logs WHERE id = ?1",
            [id],
            |row| Ok((row.get::<_, Vec<u8>>(0)?, row.get::<_, u8>(1)?)),
        ) else {
            continue;
        };
        let Ok(parsed) = gbfr_logs::parser::deserialize_version(&blob, version) else {
            continue;
        };

        // actor index -> stored loadout JSON (the sanctioned example-side view
        // of PlayerData's private fields).
        let mut loadouts: BTreeMap<u32, serde_json::Value> = BTreeMap::new();
        for slot in parsed.encounter.player_data.iter() {
            let value = serde_json::to_value(slot).unwrap_or(serde_json::Value::Null);
            if let Some(actor) = value["actorIndex"].as_u64() {
                loadouts.insert(actor as u32, value);
            }
        }

        let mut actors: BTreeMap<u32, ActorStats> = BTreeMap::new();
        for (timestamp, event) in parsed.encounter.raw_event_log.iter() {
            if let Some(traced) = trace {
                match event {
                    Message::StatusApply(apply) if apply.actor_index == traced => {
                        println!(
                            "STATUS\t{timestamp}\tapply\t{}\t{}",
                            apply.status_id, apply.stacks
                        );
                    }
                    Message::StatusRemove(remove) if remove.actor_index == traced => {
                        println!("STATUS\t{timestamp}\tremove\t{}\t0", remove.status_id);
                    }
                    _ => {}
                }
            }
            let Message::DamageEvent(hit) = event else {
                continue;
            };
            let (Some(cap), Some(rate), Some(flags)) =
                (hit.damage_cap, hit.attack_rate, hit.class_flags)
            else {
                continue;
            };
            if cap <= 0 || !rate.is_finite() {
                continue;
            }
            let points = if flags & 0x80 != 0 {
                normal.get(SUMMON_CURVE_KEY)
            } else {
                let Some(player) = parsed.derived_state.party.get(&hit.source.parent_index) else {
                    continue;
                };
                let name = format!("{:?}", player.character_type);
                let Some(key) = key_by_name.get(&name) else {
                    continue;
                };
                (if flags & 0x40000 != 0 { arts } else { normal }).get(key)
            };
            let Some(points) = points else {
                continue;
            };
            let base = game_base(points, rate);
            if base <= 0 {
                continue;
            }
            total_hits += 1;
            if trace == Some(hit.source.parent_index) {
                println!(
                    "HIT\t{timestamp}\t{}\t{:?}\t{}\t{}\t{}\t{:.6}",
                    bucket(flags),
                    hit.action_id,
                    rate,
                    base,
                    cap,
                    (100 * cap as i64) as f64 / base as f64
                );
            }
            let stats = actors.entry(hit.source.parent_index).or_default();
            let cap = cap as i64;
            let statuses: Option<Vec<(u32, u32)>> = hit
                .source_statuses
                .as_ref()
                .map(|list| list.iter().map(|s| (s.status_id, s.stacks)).collect());
            if cap_consistent(cap, base) {
                stats.good += 1;
                let k = ((100 * cap) as f64 / base as f64).round() as i64;
                *stats
                    .good_k
                    .entry(bucket(flags))
                    .or_default()
                    .entry(k)
                    .or_default() += 1;
                if let Some(statuses) = &statuses {
                    stats.good_snapshots += 1;
                    // Presence, not occurrences: a snapshot can repeat an id.
                    let present: std::collections::BTreeSet<u32> =
                        statuses.iter().map(|(id, _)| *id).collect();
                    for status in present {
                        *stats.good_status.entry(status).or_default() += 1;
                    }
                }
            } else {
                if let Some(statuses) = &statuses {
                    stats.bad_snapshots += 1;
                    let present: std::collections::BTreeSet<u32> =
                        statuses.iter().map(|(id, _)| *id).collect();
                    for status in present {
                        *stats.bad_status.entry(status).or_default() += 1;
                    }
                }
                stats.bad.push(HitDetail {
                    time: *timestamp,
                    action: format!("{:?}", hit.action_id),
                    bucket: bucket(flags),
                    rate,
                    cap,
                    base,
                    k_float: (100 * cap) as f64 / base as f64,
                    statuses,
                });
            }
        }

        for (actor, stats) in &actors {
            total_bad += stats.bad.len();
            let character = parsed
                .derived_state
                .party
                .get(actor)
                .map(|p| format!("{:?}", p.character_type))
                .unwrap_or_else(|| "?".into());
            let tally = by_char.entry(character.clone()).or_default();
            tally[0] += stats.good + stats.bad.len();
            tally[1] += stats.good;
            if stats.bad.is_empty() {
                if dump && stats.good > 0 {
                    // Clean actors' K distributions are the comparison baseline
                    // for a violating actor of the same character in the party.
                    let ks: Vec<String> = stats
                        .good_k
                        .iter()
                        .map(|(bucket, dist)| {
                            let mut top: Vec<(&i64, &usize)> = dist.iter().collect();
                            top.sort_by(|a, b| b.1.cmp(a.1));
                            let entries: Vec<String> = top
                                .iter()
                                .take(5)
                                .map(|(k, n)| format!("{k}x{n}"))
                                .collect();
                            format!("{bucket}[{}]", entries.join(" "))
                        })
                        .collect();
                    println!(
                        "log {id} actor {actor:#x} {character}: clean ({} hits) K: {}",
                        stats.good,
                        ks.join(" ")
                    );
                }
                continue;
            }
            let loadout = loadouts.get(actor);
            let cobalt = loadout
                .map(|p| trait_level(p, COBALT, &transcendence))
                .unwrap_or(0);
            let fjord = loadout
                .map(|p| trait_level(p, FJORD, &transcendence))
                .unwrap_or(0);
            let crit = loadout.and_then(|p| p["playerStats"]["criticalRate"].as_f64());

            // Classify every off-grid hit.
            //
            // transition: K lies strictly between the actor's own on-grid
            // states of the same attack class — the eased value of a
            // state-gated term mid-flip. Requires the bracket to actually
            // exist (>= 2 observed states); a hit outside every bracket is
            // never rationalized into one.
            //
            // cobalt: excess over the modal K lands in (0, capMax - capMin]
            // of the equipped Cobalt level — the crit-rate band, whose
            // resting integer value the modal K already carries.
            let band_span = (cobalt > 0)
                .then(|| {
                    let i = cobalt as usize - 1;
                    Some(band.cap_max.get(i)? - band.cap_min.get(i)?)
                })
                .flatten();
            let in_band =
                |excess: f64| band_span.is_some_and(|span| excess > 0.0 && excess <= span + 1e-6);
            let mut excesses: Vec<(f64, &HitDetail, i64, &'static str)> = Vec::new();
            let mut unexplained_k: Vec<f64> = Vec::new();
            let (mut n_transition, mut n_settling, mut n_half, mut n_cobalt, mut n_unexplained) =
                (0usize, 0usize, 0usize, 0usize, 0usize);
            for hit in &stats.bad {
                let grid = stats.good_k.get(hit.bucket);
                let modal = grid
                    .and_then(|ks| ks.iter().max_by_key(|(_, n)| **n))
                    .map(|(k, _)| *k);
                let bracket = grid.and_then(|ks| {
                    let (lo, hi) = (*ks.keys().next()?, *ks.keys().next_back()?);
                    (lo < hi && hit.k_float > lo as f64 && hit.k_float < hi as f64)
                        .then_some((lo, hi))
                });
                // The ease tail parks within ~0.1 of the target state for
                // seconds (measured 69.93 -> 69.999); a short fight can visit
                // only one state on-grid, so the strict bracket misses these.
                let settling = grid
                    .is_some_and(|ks| ks.keys().any(|k| (hit.k_float - *k as f64).abs() <= 0.15));
                let excess = modal.map(|m| hit.k_float - m as f64);
                let class = if bracket.is_some() {
                    n_transition += 1;
                    "transition"
                } else if settling {
                    n_settling += 1;
                    "settling"
                } else if half_grid(hit.cap, hit.base) {
                    n_half += 1;
                    "half-grid"
                } else if excess.is_some_and(in_band) {
                    n_cobalt += 1;
                    "cobalt"
                } else {
                    n_unexplained += 1;
                    unexplained_k.push(hit.k_float);
                    "unexplained"
                };
                if let Some(excess) = excess {
                    excesses.push((excess, hit, modal.unwrap_or(0), class));
                }
            }
            total_explained += n_transition + n_settling + n_half + n_cobalt;
            let tally = by_char.entry(character.clone()).or_default();
            tally[2] += n_transition;
            tally[3] += n_settling;
            tally[4] += n_half;
            tally[5] += n_cobalt;
            tally[6] += n_unexplained;

            let (min_e, max_e) = excesses
                .iter()
                .fold((f64::MAX, f64::MIN), |(lo, hi), (e, _, _, _)| {
                    (lo.min(*e), hi.max(*e))
                });
            if !markdown {
                println!(
                "log {id} actor {actor:#x} {character}: {} bad / {} hits | transition {n_transition} settling {n_settling} half-grid {n_half} cobalt {n_cobalt} unexplained {n_unexplained} | cobalt lv{cobalt}{} crit {} | excess {:.3}..{:.3}",
                stats.bad.len(),
                stats.bad.len() + stats.good,
                if fjord > 0 {
                    format!(" (FJORD lv{fjord} also equipped)")
                } else {
                    String::new()
                },
                crit.map(|c| format!("{c:.0}%")).unwrap_or_else(|| "?".into()),
                if min_e == f64::MAX { f64::NAN } else { min_e },
                if max_e == f64::MIN { f64::NAN } else { max_e },
            );

                if dump {
                    let ks: Vec<String> = stats
                        .good_k
                        .iter()
                        .map(|(bucket, dist)| {
                            let mut top: Vec<(&i64, &usize)> = dist.iter().collect();
                            top.sort_by(|a, b| b.1.cmp(a.1));
                            let entries: Vec<String> = top
                                .iter()
                                .take(5)
                                .map(|(k, n)| format!("{k}x{n}"))
                                .collect();
                            format!("{bucket}[{}]", entries.join(" "))
                        })
                        .collect();
                    println!("    consistent K: {}", ks.join(" "));
                }

                // Which statuses track the ramp: for each status on bad hits, the
                // mean excess with it present vs absent (bad hits only — a
                // consistent hit's excess is zero by construction).
                if dump && !excesses.is_empty() {
                    let ids: std::collections::BTreeSet<u32> = excesses
                        .iter()
                        .filter_map(|(_, hit, _, _)| hit.statuses.as_ref())
                        .flat_map(|s| s.iter().map(|(id, _)| *id))
                        .collect();
                    for status in ids {
                        let (mut with, mut without): (Vec<f64>, Vec<f64>) =
                            (Vec::new(), Vec::new());
                        for (excess, hit, _, _) in &excesses {
                            let Some(statuses) = hit.statuses.as_ref() else {
                                continue;
                            };
                            if statuses.iter().any(|(id, _)| id == &status) {
                                with.push(*excess);
                            } else {
                                without.push(*excess);
                            }
                        }
                        if with.len() >= 3 && !without.is_empty() {
                            let mean = |v: &[f64]| v.iter().sum::<f64>() / v.len() as f64;
                            println!(
                            "    status {status}: mean excess {:+.2} with (n={}) vs {:+.2} without (n={})",
                            mean(&with),
                            with.len(),
                            mean(&without),
                            without.len()
                        );
                        }
                    }
                }

                // Status correlation: presence rate among bad vs good snapshots.
                if stats.bad_snapshots > 0 && stats.good_snapshots > 0 {
                    let mut diffs: Vec<(f64, u32, f64, f64)> = Vec::new();
                    let ids: std::collections::BTreeSet<u32> = stats
                        .bad_status
                        .keys()
                        .chain(stats.good_status.keys())
                        .copied()
                        .collect();
                    for status in ids {
                        let p_bad = *stats.bad_status.get(&status).unwrap_or(&0) as f64
                            / stats.bad_snapshots as f64;
                        let p_good = *stats.good_status.get(&status).unwrap_or(&0) as f64
                            / stats.good_snapshots as f64;
                        diffs.push(((p_bad - p_good).abs(), status, p_bad, p_good));
                    }
                    diffs.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
                    let top: Vec<String> = diffs
                        .iter()
                        .take(4)
                        .filter(|(d, _, _, _)| *d > 0.05)
                        .map(|(_, status, p_bad, p_good)| {
                            format!(
                                "status {status}: bad {:.0}% vs good {:.0}%",
                                p_bad * 100.0,
                                p_good * 100.0
                            )
                        })
                        .collect();
                    if !top.is_empty() {
                        println!("    status correlates: {}", top.join(", "));
                    }
                }

                if dump {
                    for (excess, hit, modal, class) in &excesses {
                        println!(
                        "    t={} {} [{}] rate {:.4} cap {} base {} K {:.4} modal {} excess {:+.4} {class} statuses {}",
                        hit.time,
                        hit.action,
                        hit.bucket,
                        hit.rate,
                        hit.cap,
                        hit.base,
                        hit.k_float,
                        modal,
                        excess,
                        hit.statuses
                            .as_ref()
                            .map(|s| {
                                s.iter()
                                    .map(|(id, n)| if *n > 1 { format!("{id}x{n}") } else { id.to_string() })
                                    .collect::<Vec<_>>()
                                    .join(",")
                            })
                            .unwrap_or_else(|| "-".into()),
                    );
                    }
                }
            }

            if n_unexplained > 0 {
                let max_dev = excesses
                    .iter()
                    .filter(|(_, _, _, class)| *class == "unexplained")
                    .map(|(e, _, _, _)| *e)
                    .fold(0.0f64, |acc, e| if e.abs() > acc.abs() { e } else { acc });
                // A tight cluster is a STABLE unknown term (one continuous
                // source active all fight), a different lead than scatter —
                // note it, but it stays unexplained either way.
                unexplained_k.sort_by(|a, b| a.partial_cmp(b).unwrap());
                let median = unexplained_k[unexplained_k.len() / 2];
                let constant = unexplained_k
                    .iter()
                    .all(|k| (k - median).abs() <= 0.02 * (1.0 + median.abs() / 1000.0));
                let friendly = char_names.get(&character).unwrap_or(&character);
                worklist.push((
                    n_unexplained,
                    format!(
                        "log {id}, {friendly} ({character}, actor {actor:#x}): {n_unexplained} unexplained hits (max dev {max_dev:+.3}){}",
                        if constant && unexplained_k.len() > 2 {
                            format!(" — constant K≈{median:.3}, one stable unknown source all fight")
                        } else {
                            String::new()
                        }
                    ),
                ));
            }
        }
    }
    worklist.sort_by(|a, b| b.0.cmp(&a.0));

    if markdown {
        println!("# Damage-cap model coverage");
        println!();
        println!("How much of every character's logged damage caps the model explains.");
        println!("A hit is **verified** when its cap sits exactly where the formula");
        println!("puts it (`cap = trunc(base × K/100)`, integer K); **explained** hits");
        println!("are off that grid for a known, named reason (a state buff easing");
        println!("in/out, a half-percent build, the Cobalt crit band). Coverage =");
        println!("verified + explained.");
        println!();
        println!("Regenerate after new logs with:");
        println!();
        println!("```sh");
        println!("cargo run --release -p gbfr-logs --example cap_residual_scan -- --last 5000 --markdown > docs/damage-cap-coverage.md");
        println!("```");
        println!();
        println!("| Character | Capped hits | Verified | Explained | Unaccounted | Coverage |");
        println!("|---|---:|---:|---:|---:|---:|");
        let mut rows: Vec<(&String, &[usize; 7])> = by_char.iter().collect();
        rows.sort_by(|a, b| b.1[0].cmp(&a.1[0]));
        for (character, t) in rows {
            let [total, ongrid, transition, settling, half, cobalt, unexplained] = *t;
            if total == 0 {
                continue;
            }
            let friendly = char_names.get(character).unwrap_or(character);
            let explained = transition + settling + half + cobalt;
            println!(
                "| {friendly} | {total} | {ongrid} | {explained} | {unexplained} | {:.2}% |",
                (ongrid + explained) as f64 / total as f64 * 100.0
            );
        }
        println!();
        println!(
            "Corpus total: {total_hits} capped hits, {:.2}% covered.",
            (total_hits - (total_bad - total_explained)) as f64 / total_hits.max(1) as f64 * 100.0
        );
        println!();
        println!("## Unaccounted");
        println!();
        if worklist.is_empty() {
            println!("Nothing — every capped hit is verified or explained.");
        } else {
            for (_, line) in &worklist {
                println!("- {line}");
            }
        }
        return Ok(());
    }

    println!(
        "\ntotal: {total_hits} hits, {total_bad} off-grid ({:.2}%), {total_explained} explained (transition/settling/half-grid/cobalt)",
        total_bad as f64 / total_hits.max(1) as f64 * 100.0
    );
    if worklist.is_empty() {
        println!("worklist: EMPTY — every off-grid hit has a named mechanism");
    } else {
        println!("worklist ({} entries):", worklist.len());
        for (n, line) in &worklist {
            println!("  [{n:>4}] {line}");
        }
    }
    Ok(())
}
