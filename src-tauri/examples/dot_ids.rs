//! TEMPORARY diagnostic (not for commit): per-source action-id histogram for one
//! stored encounter. Used to compare a pre-2.0.2 log (which has DamageOverTime
//! events) against a post-2.0.2 log (which has none), to test whether DoT ticks
//! still arrive but are classified as ordinary Normal hits.
//!
//! Run: cargo run -p gbfr-logs --example dot_ids -- --db "<logs.db>" --log <id> [--char Pl0500]

use std::collections::BTreeMap;
use std::path::PathBuf;

use anyhow::{Context, Result};
use gbfr_logs::parser::constants::CharacterType;
use gbfr_logs::parser::v1::Encounter;
use protocol::{ActionType, Message};
use rusqlite::Connection;

#[derive(Default)]
struct Stat {
    hits: u64,
    total: i64,
    min: i64,
    max: i64,
}

impl Stat {
    fn add(&mut self, d: i64) {
        if self.hits == 0 {
            self.min = d;
            self.max = d;
        } else {
            self.min = self.min.min(d);
            self.max = self.max.max(d);
        }
        self.hits += 1;
        self.total += d;
    }
}

fn main() -> Result<()> {
    let mut db_path = PathBuf::from("src-tauri/logs.db");
    let mut log_id: i64 = -1;
    let mut want_char = "Pl0500".to_string();

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => db_path = args.next().context("--db needs a path")?.into(),
            "--log" => log_id = args.next().context("--log needs an id")?.parse()?,
            "--char" => want_char = args.next().context("--char needs a type")?,
            other => anyhow::bail!("unknown arg: {other}"),
        }
    }
    anyhow::ensure!(log_id >= 0, "--log <id> is required");

    let conn =
        Connection::open(&db_path).with_context(|| format!("opening {}", db_path.display()))?;
    let (time, blob): (String, Vec<u8>) = conn.query_row(
        "SELECT datetime(time/1000,'unixepoch','localtime'), data FROM logs WHERE id = ?",
        [log_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;

    let mut encounter = Encounter::from_blob(&blob)?;
    encounter.repopulate_event_log();

    // action-id histogram for the requested character, keyed by class + id
    let mut by_action: BTreeMap<String, Stat> = BTreeMap::new();

    for (_, event) in encounter.event_log() {
        let Message::DamageEvent(e) = event else {
            continue;
        };
        let src = CharacterType::from_hash(e.source.parent_actor_type);
        if format!("{src}") != want_char {
            continue;
        }
        let key = match e.action_id {
            ActionType::Normal(id) => format!("Normal({id})"),
            ActionType::DamageOverTime(id) => format!("DoT({id})"),
            ActionType::SupplementaryDamage(id) => format!("Supp({id})"),
            ActionType::LinkAttack => "LinkAttack".into(),
            ActionType::SBA => "SBA".into(),
            ActionType::PerfectGuard => "PerfectGuard".into(),
            ActionType::PerfectGuardQuickening => "PerfectGuardQuickening".into(),
            ActionType::StunEffect(id) => format!("StunEffect({id})"),
        };
        by_action.entry(key).or_default().add(e.damage as i64);
    }

    println!("log {log_id} @ {time} — {want_char} action ids ({} distinct)", by_action.len());
    let mut rows: Vec<_> = by_action.iter().collect();
    rows.sort_by_key(|(_, s)| std::cmp::Reverse(s.hits));
    for (key, s) in rows {
        println!(
            "  {key:<22} hits={:<6} total={:<12} min={:<9} max={}",
            s.hits, s.total, s.min, s.max
        );
    }

    Ok(())
}
