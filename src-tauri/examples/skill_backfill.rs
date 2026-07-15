//! Offline maintenance tool: scan saved encounters in logs.db for player skills
//! that have no name in en/ui.json and stub each with a `"TODO: Skill <id>"`
//! placeholder under its character block. Add-only + idempotent.
//!
//! Run from the repo root:
//!   cargo run -p gbfr-logs --bin skill_backfill
//! Optional args: --db <path to logs.db> --ui <path to en/ui.json>

use std::collections::BTreeSet;
use std::path::PathBuf;

use anyhow::{Context, Result};
use gbfr_logs::backfill::{derive_skill_key, insert_missing, SkillKey};
use gbfr_logs::parser::v1::Encounter;
use protocol::Message;
use rusqlite::Connection;
use serde_json::Value;

fn main() -> Result<()> {
    let mut db_path = PathBuf::from("src-tauri/logs.db");
    let mut ui_path = PathBuf::from("src-tauri/lang/en/ui.json");

    // Minimal flag parsing: --db <path>, --ui <path>.
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => db_path = args.next().context("--db needs a path")?.into(),
            "--ui" => ui_path = args.next().context("--ui needs a path")?.into(),
            other => anyhow::bail!("unknown arg: {other}"),
        }
    }

    let keys = collect_skill_keys(&db_path)?;
    println!(
        "Collected {} distinct skill keys from {}",
        keys.len(),
        db_path.display()
    );

    let mut ui: Value = serde_json::from_slice(
        &std::fs::read(&ui_path).with_context(|| format!("reading {}", ui_path.display()))?,
    )?;
    let skills = ui
        .get_mut("skills")
        .and_then(Value::as_object_mut)
        .context("ui.json has no `skills` object")?;

    let added = insert_missing(skills, &keys);

    if added == 0 {
        println!("No missing skills — nothing to write.");
        return Ok(());
    }

    // Serialize with 2-space indent + trailing newline to match the existing file.
    let mut out = serde_json::to_string_pretty(&ui)?;
    out.push('\n');
    std::fs::write(&ui_path, out).with_context(|| format!("writing {}", ui_path.display()))?;
    println!("Added {added} placeholder(s) to {}", ui_path.display());
    Ok(())
}

/// Reads every encounter blob from `logs.db` and returns the set of skill keys seen.
/// A row whose blob fails to decode is warned about and skipped.
fn collect_skill_keys(db_path: &std::path::Path) -> Result<BTreeSet<SkillKey>> {
    let conn =
        Connection::open(db_path).with_context(|| format!("opening {}", db_path.display()))?;
    let mut stmt = conn.prepare("SELECT id, data FROM logs")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
    })?;

    let mut keys = BTreeSet::new();
    for row in rows {
        let (id, blob) = row?;
        let mut encounter = match Encounter::from_blob(&blob) {
            Ok(e) => e,
            Err(e) => {
                eprintln!("warn: skipping log {id}: blob decode failed: {e}");
                continue;
            }
        };
        encounter.repopulate_event_log();
        for (_, event) in encounter.event_log() {
            if let Message::DamageEvent(dmg) = event {
                if let Some(k) = derive_skill_key(dmg) {
                    keys.insert(k);
                }
            }
        }
    }
    Ok(keys)
}
