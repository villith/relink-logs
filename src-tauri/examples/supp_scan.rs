//! TEMPORARY diagnostic (not for commit): scan logs.db for SupplementaryDamage-classified
//! hits with implausible damage, dumping their flags/action_id to test whether the
//! v2.0.2 flag-bit classification (bit 15 @ the relocated 0xE8 bitfield) is mislabeling
//! real skill hits as supplementary.
//!
//! Run: cargo run -p gbfr-logs --example supp_scan [-- --db <path>] [--since <id>]

use std::collections::BTreeMap;
use std::path::PathBuf;

use anyhow::{Context, Result};
use gbfr_logs::parser::v1::Encounter;
use protocol::{ActionType, Message};
use rusqlite::Connection;

fn main() -> Result<()> {
    let mut db_path = PathBuf::from("src-tauri/logs.db");
    let mut since_id = 0i64;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => db_path = args.next().context("--db needs a path")?.into(),
            "--since" => since_id = args.next().context("--since needs an id")?.parse()?,
            other => anyhow::bail!("unknown arg: {other}"),
        }
    }

    let conn =
        Connection::open(&db_path).with_context(|| format!("opening {}", db_path.display()))?;
    let mut stmt = conn.prepare(
        "SELECT id, datetime(time/1000,'unixepoch','localtime'), data \
         FROM logs WHERE id >= ? ORDER BY id",
    )?;
    let rows = stmt.query_map([since_id], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Vec<u8>>(2)?,
        ))
    })?;

    for row in rows {
        let (id, time, blob) = row?;
        let mut encounter = match Encounter::from_blob(&blob) {
            Ok(e) => e,
            Err(e) => {
                eprintln!("warn: skipping log {id}: blob decode failed: {e}");
                continue;
            }
        };
        encounter.repopulate_event_log();

        // Per-class damage stats: hits / min / max.
        #[derive(Default)]
        struct S {
            hits: u64,
            min: i64,
            max: i64,
        }
        impl S {
            fn add(&mut self, d: i64) {
                if self.hits == 0 {
                    self.min = d;
                    self.max = d;
                } else {
                    self.min = self.min.min(d);
                    self.max = self.max.max(d);
                }
                self.hits += 1;
            }
        }
        let mut per_class: BTreeMap<&'static str, S> = BTreeMap::new();
        // Supplementary hits: (damage, flags, action_id, source parent type)
        let mut supp: Vec<(i32, u64, u32, u32)> = Vec::new();
        // action_ids seen as Normal (to check if "supplementary" ids are real skills)
        let mut normal_ids: BTreeMap<u32, S> = BTreeMap::new();

        for (_, event) in encounter.event_log() {
            if let Message::DamageEvent(e) = event {
                let class = match e.action_id {
                    ActionType::LinkAttack => "link",
                    ActionType::SBA => "sba",
                    ActionType::SupplementaryDamage(_) => "supp",
                    ActionType::DamageOverTime(_) => "dot",
                    ActionType::Normal(_) => "normal",
                    ActionType::PerfectGuard => "perfect-guard",
                    ActionType::PerfectGuardQuickening => "perfect-guard-quickening",
                    ActionType::StunEffect(_) => "stun-effect",
                };
                per_class.entry(class).or_default().add(e.damage as i64);
                match e.action_id {
                    ActionType::SupplementaryDamage(aid) => {
                        supp.push((e.damage, e.flags, aid, e.source.parent_actor_type));
                    }
                    ActionType::Normal(aid) => {
                        normal_ids.entry(aid).or_default().add(e.damage as i64);
                    }
                    _ => {}
                }
            }
        }

        if per_class.is_empty() {
            continue;
        }

        println!("=== log {id} {time}");
        for (class, s) in &per_class {
            println!("  {class}: hits={} min={} max={}", s.hits, s.min, s.max);
        }

        if !supp.is_empty() {
            supp.sort_by_key(|(d, ..)| std::cmp::Reverse(*d));
            println!("  top supplementary hits (damage / flags / action_id / src_parent):");
            for (d, flags, aid, parent) in supp.iter().take(8) {
                // which flag bits are set, to spot the classification bit patterns
                let bits: Vec<u32> = (0..64).filter(|b| flags & (1u64 << b) != 0).collect();
                let as_normal = normal_ids
                    .get(aid)
                    .map(|s| format!(" [aid also Normal: hits={} max={}]", s.hits, s.max))
                    .unwrap_or_default();
                println!(
                    "    dmg={d:>9} flags={flags:#018x} bits={bits:?} aid={aid} parent={parent:#x}{as_normal}"
                );
            }
        }

        // Pair each supplementary event with the nearest PRECEDING non-supp event that
        // shares its action_id and source, then histogram supp/trigger damage ratios.
        // A tight cluster at a fixed ratio = echoes are arithmetically derived from the
        // trigger (numbers real); a plateau of identical large values = a game-side echo
        // cap we'd be overshooting.
        let events: Vec<&Message> = encounter.event_log().map(|(_, e)| e).collect();
        let mut ratios: BTreeMap<String, u64> = BTreeMap::new();
        let mut flags_by_bucket: BTreeMap<(&'static str, u64), u64> = BTreeMap::new();
        let mut paired = 0u64;
        let mut unpaired = 0u64;
        for (i, event) in events.iter().enumerate() {
            let Message::DamageEvent(e) = event else { continue };
            let ActionType::SupplementaryDamage(aid) = e.action_id else {
                continue;
            };
            let mut found = None;
            for prev in events[..i].iter().rev().take(200) {
                let Message::DamageEvent(p) = prev else { continue };
                let trigger_aid = match p.action_id {
                    ActionType::Normal(a) => a,
                    _ => continue,
                };
                if trigger_aid == aid
                    && p.source.index == e.source.index
                    && p.source.actor_type == e.source.actor_type
                    && p.damage > 0
                {
                    found = Some(p.damage);
                    break;
                }
            }
            match found {
                Some(trigger) => {
                    paired += 1;
                    let r = e.damage as f64 / trigger as f64;
                    *ratios.entry(format!("{:.3}", r)).or_default() += 1;
                    // Bucket confidently-ratioed events and record their flags, to find
                    // a flag bit that separates the 0.2x (supplementary) population from
                    // the 0.4x (echo) population.
                    let bucket = if (r - 0.2).abs() < 0.005 {
                        Some("0.2")
                    } else if (r - 0.4).abs() < 0.005 {
                        Some("0.4")
                    } else {
                        None
                    };
                    if let Some(bucket) = bucket {
                        *flags_by_bucket
                            .entry((bucket, e.flags))
                            .or_default() += 1;
                    }
                }
                None => unpaired += 1,
            }
        }
        // Strategy comparison: how often does each trigger-matching strategy yield a
        // clean 0.2/0.4 ratio? Tests whether "events come in order" (strategy A/B)
        // makes the ring-buffer matching (strategy D) unnecessary.
        {
            let clean = |r: f64| (r - 0.2).abs() < 0.01 || (r - 0.4).abs() < 0.01;
            let mut counts = [(0u64, 0u64); 4]; // (clean, total) for A,B,C,D
            for (i, event) in events.iter().enumerate() {
                let Message::DamageEvent(e) = event else { continue };
                let ActionType::SupplementaryDamage(aid) = e.action_id else {
                    continue;
                };
                // A: immediately previous damage event from same source, any action
                let mut a: Option<f64> = None;
                // B: nearest previous same-source Normal(aid) event
                let mut b: Option<f64> = None;
                // C: nearest previous same-source Normal(aid) event on the SAME TARGET
                let mut c: Option<f64> = None;
                // D: best of last 8 same-source Normal(aid) hits, closest to 0.2/0.4
                let mut d_best: Option<f64> = None;
                let mut d_seen = 0;
                for prev in events[..i].iter().rev().take(400) {
                    let Message::DamageEvent(p) = prev else { continue };
                    if p.source.index != e.source.index
                        || p.source.actor_type != e.source.actor_type
                        || p.damage <= 0
                        || matches!(p.action_id, ActionType::SupplementaryDamage(_))
                    {
                        continue;
                    }
                    let r = e.damage as f64 / p.damage as f64;
                    if a.is_none() {
                        a = Some(r);
                    }
                    if let ActionType::Normal(paid) = p.action_id {
                        if paid == aid {
                            if b.is_none() {
                                b = Some(r);
                            }
                            if c.is_none()
                                && p.target.index == e.target.index
                                && p.target.actor_type == e.target.actor_type
                            {
                                c = Some(r);
                            }
                            if d_seen < 8 {
                                d_seen += 1;
                                let dist = |x: f64| (x - 0.2).abs().min((x - 0.4).abs());
                                if d_best.map_or(true, |best| dist(r) < dist(best)) {
                                    d_best = Some(r);
                                }
                            }
                        }
                    }
                    if a.is_some() && b.is_some() && c.is_some() && d_seen >= 8 {
                        break;
                    }
                }
                for (slot, r) in [(0, a), (1, b), (2, c), (3, d_best)] {
                    if let Some(r) = r {
                        counts[slot].1 += 1;
                        if clean(r) {
                            counts[slot].0 += 1;
                        }
                    }
                }
            }
            for (name, (cl, tot)) in ["A prev-any", "B prev-same-aid", "C same-aid+target", "D best-of-8"]
                .iter()
                .zip(counts)
            {
                if tot > 0 {
                    println!(
                        "    strategy {name}: clean={cl}/{tot} ({:.1}%)",
                        cl as f64 / tot as f64 * 100.0
                    );
                }
            }

            // Window-size sweep: clean-rate and ambiguity-rate of best-of-K for
            // several K, to pick the knee of the curve instead of guessing.
            for k in [1usize, 2, 4, 6, 8, 12, 16] {
                let (mut cl, mut tot, mut amb) = (0u64, 0u64, 0u64);
                for (i, event) in events.iter().enumerate() {
                    let Message::DamageEvent(e) = event else { continue };
                    let ActionType::SupplementaryDamage(aid) = e.action_id else {
                        continue;
                    };
                    let mut best: Option<f64> = None;
                    let (mut has02, mut has04, mut seen) = (false, false, 0);
                    for prev in events[..i].iter().rev().take(600) {
                        let Message::DamageEvent(p) = prev else { continue };
                        if p.source.index != e.source.index
                            || p.source.actor_type != e.source.actor_type
                            || p.damage <= 0
                            || p.action_id != ActionType::Normal(aid)
                        {
                            continue;
                        }
                        let r = e.damage as f64 / p.damage as f64;
                        let dist = |x: f64| (x - 0.2).abs().min((x - 0.4).abs());
                        if best.map_or(true, |b| dist(r) < dist(b)) {
                            best = Some(r);
                        }
                        if (r - 0.2).abs() < 0.01 {
                            has02 = true;
                        }
                        if (r - 0.4).abs() < 0.01 {
                            has04 = true;
                        }
                        seen += 1;
                        if seen >= k {
                            break;
                        }
                    }
                    if let Some(r) = best {
                        tot += 1;
                        if (r - 0.2).abs() < 0.01 || (r - 0.4).abs() < 0.01 {
                            cl += 1;
                        }
                        if has02 && has04 {
                            amb += 1;
                        }
                    }
                }
                if tot > 0 {
                    println!(
                        "    window K={k:>2}: clean={:.1}% ambiguous={:.1}% (n={tot})",
                        cl as f64 / tot as f64 * 100.0,
                        amb as f64 / tot as f64 * 100.0
                    );
                }
            }

            // Ambiguity count: procs where the last-8 window contains BOTH a clean
            // 0.2 candidate and a clean 0.4 candidate (a 2x pair of hits) — the case
            // the ratio heuristic cannot resolve, only tie-break.
            let mut ambiguous = 0u64;
            let mut total_procs = 0u64;
            for (i, event) in events.iter().enumerate() {
                let Message::DamageEvent(e) = event else { continue };
                let ActionType::SupplementaryDamage(aid) = e.action_id else {
                    continue;
                };
                total_procs += 1;
                let (mut has02, mut has04, mut seen) = (false, false, 0);
                for prev in events[..i].iter().rev().take(400) {
                    let Message::DamageEvent(p) = prev else { continue };
                    if p.source.index != e.source.index
                        || p.source.actor_type != e.source.actor_type
                        || p.damage <= 0
                        || p.action_id != ActionType::Normal(aid)
                    {
                        continue;
                    }
                    let r = e.damage as f64 / p.damage as f64;
                    if (r - 0.2).abs() < 0.01 {
                        has02 = true;
                    }
                    if (r - 0.4).abs() < 0.01 {
                        has04 = true;
                    }
                    seen += 1;
                    if seen >= 8 {
                        break;
                    }
                }
                if has02 && has04 {
                    ambiguous += 1;
                }
            }
            if total_procs > 0 {
                println!(
                    "    ambiguous (both 0.2 and 0.4 candidates in window): {ambiguous}/{total_procs} ({:.1}%)",
                    ambiguous as f64 / total_procs as f64 * 100.0
                );
            }
        }

        // Per-trigger combo analysis: how many supp events attach to each trigger hit,
        // and in which ratio buckets? Both-buckets-on-one-trigger => two independent
        // mechanics; never-both => one mechanic with a variable multiplier.
        let mut per_trigger: BTreeMap<usize, Vec<String>> = BTreeMap::new();
        for (i, event) in events.iter().enumerate() {
            let Message::DamageEvent(e) = event else { continue };
            let ActionType::SupplementaryDamage(aid) = e.action_id else {
                continue;
            };
            let mut found = None;
            for (back, prev) in events[..i].iter().rev().take(200).enumerate() {
                let Message::DamageEvent(p) = prev else { continue };
                let ActionType::Normal(trigger_aid) = p.action_id else {
                    continue;
                };
                if trigger_aid == aid
                    && p.source.index == e.source.index
                    && p.source.actor_type == e.source.actor_type
                    && p.damage > 0
                {
                    found = Some((i - 1 - back, p.damage));
                    break;
                }
            }
            if let Some((trigger_idx, trigger_dmg)) = found {
                let r = e.damage as f64 / trigger_dmg as f64;
                per_trigger
                    .entry(trigger_idx)
                    .or_default()
                    .push(format!("{:.2}", r));
            }
        }
        let mut combos: BTreeMap<String, u64> = BTreeMap::new();
        for (_, mut rs) in per_trigger {
            rs.sort();
            *combos.entry(rs.join("+")).or_default() += 1;
        }
        let mut combo_list: Vec<_> = combos.iter().collect();
        combo_list.sort_by_key(|(_, n)| std::cmp::Reverse(**n));
        for (combo, n) in combo_list.iter().take(12) {
            println!("    combo [{combo}] x{n}");
        }
        println!("  ratio pairing: paired={paired} unpaired={unpaired}");
        let mut top: Vec<_> = ratios.iter().collect();
        top.sort_by_key(|(_, n)| std::cmp::Reverse(**n));
        for (r, n) in top.iter().take(10) {
            println!("    ratio {r} x{n}");
        }
        for ((bucket, flags), n) in &flags_by_bucket {
            let bits: Vec<u32> = (0..64).filter(|b| flags & (1u64 << b) != 0).collect();
            println!("    bucket {bucket} flags={flags:#018x} bits={bits:?} x{n}");
        }
    }

    Ok(())
}
