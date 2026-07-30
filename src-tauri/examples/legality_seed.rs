//! Seed ONE synthetic encounter into `logs.db` to exercise the legality audit
//! page against known builds.
//!
//! Four players, one scenario each:
//! * slot 0 — wrightstone with trait levels 30/20/20 (legal ceiling 20/15/10)
//! * slot 1 — 100 unlocked master-trait (skillboard) nodes
//! * slot 2 — 2 different summons, each at max trait level and max equip bonus
//! * slot 3 — 3 different summons, each at max trait level and max equip bonus
//!
//! The players are built through the real parser identity path
//! (`on_player_identity_event`) so the stored `PlayerData` is exactly what a
//! live hook would have produced; only the values are invented. The character
//! hashes are real ones from `parser::constants` — the parser drops damage
//! whose source parent is not a known character.
//!
//! Run: cargo run -p gbfr-logs --example legality_seed -- [--db <path-to-logs.db>]

use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use chrono::Utc;
use protocol::{DamageEvent, EquippedSummon, PlayerIdentityEvent, WeaponState, WeaponTraitPair};
use rusqlite::{params, Connection, OpenFlags};

use gbfr_logs::debug_events::{damage_event, identity_event, PL0000, PL0200, TARGET_TYPE};
use gbfr_logs::legality;
use gbfr_logs::parser::v1::{Encounter, Parser};

/// Real character hashes (`parser::constants::CharacterType::from_hash`). Gran
/// and Katalina come from `debug_events`, which already pins them.
const GRAN: u32 = PL0000;
const KATALINA: u32 = PL0200;
const RACKAM: u32 = 0xF8D7_3D33; // Pl0300
const IO: u32 = 0x7B59_34AD; // Pl0400

/// Wrightstone trait ids: HP (the Fortification primary) plus two real
/// secondary traits. The rule judges LEVELS only, so the ids just need to be
/// plausible.
const HP_TRAIT: u32 = 0xf372_f096;
const DMG_CAP: u32 = 0xdc58_4f60;
const SUPP_DMG: u32 = 0x57ab_5b10;

/// Perfect summons must come from the six watched bosses (rolled ids) or the
/// count report ignores them. Lucilius: "lvl 15 Alpha and +100% NA DMG Cap"
/// — the exact example the fixture request named. All main windows top at
/// 15, all bonus windows at 9.
const LUCILIUS: u32 = 0x6e59_68fc;
const ALPHA: u32 = 0xdbe1_d775;
const NA_DMG_CAP_BONUS: u32 = 0x9245_dfa4;

/// Behemoth III (rolled), Uplift main with a standard-set bonus.
const BEHEMOTH_III: u32 = 0xe4b7_dcf9;
const UPLIFT: u32 = 0xb5ff_9fd3;
const BEHEMOTH_BONUS: u32 = 0xa353_9fbb;

/// Rolan (rolled), Uplift main with a boss-set bonus.
const ROLAN: u32 = 0x0f98_6ed9;
const ROLAN_MAIN: u32 = 0xb5ff_9fd3;
const ROLAN_BONUS: u32 = 0x9245_dfa4;

/// An identity event carrying nothing but who the player is; each scenario
/// fills in the one field it is about. Shares the Debug tab's builders so the
/// two cannot drift as the protocol structs grow.
fn identity(slot: u8, character_type: u32, name: &str) -> PlayerIdentityEvent {
    identity_event(slot, character_type, name)
}

/// A plain attributed hit, same shape as the Debug tab's scripts: flags 0,
/// no cap/stun/HP data fabricated.
fn damage(slot: u8, character_type: u32, amount: i32) -> DamageEvent {
    damage_event(slot, character_type, amount, 100 + slot as u32)
}

fn perfect(summon_id: u32, main: u32, bonus: u32) -> EquippedSummon {
    EquippedSummon {
        summon_id,
        main_trait_id: main,
        main_trait_level: 15,
        bonus_id: bonus,
        bonus_level: 9,
    }
}

fn main() -> Result<()> {
    let mut db_path = PathBuf::from("src-tauri/logs.db");
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => db_path = args.next().context("--db needs a path")?.into(),
            other => bail!("unknown arg: {other}"),
        }
    }
    if !db_path.is_file() {
        bail!(
            "{} does not exist — run the app once to create it, or pass --db",
            db_path.display()
        );
    }

    let mut parser = Parser::from_encounter(Encounter::default());

    // Slot 0: wrightstone engraved 30/20/20 against the 20/15/10 ceiling.
    let mut p0 = identity(0, GRAN, "SEED Wrightstone 30-20-20");
    p0.weapon_state = Some(WeaponState {
        weapon_id: 0,
        exp: 0,
        star_level: 0,
        plus_marks: 0,
        awakening_level: 0,
        wrightstone_id: 0,
        wrightstone_traits: vec![
            WeaponTraitPair {
                id: HP_TRAIT,
                level: 30,
            },
            WeaponTraitPair {
                id: DMG_CAP,
                level: 20,
            },
            WeaponTraitPair {
                id: SUPP_DMG,
                level: 20,
            },
        ],
        innate_traits: Vec::new(),
    });
    parser.on_player_identity_event(p0);

    // Slot 1: 100 unlocked master-trait nodes (the profile blob caps at 50).
    let mut p1 = identity(1, KATALINA, "SEED 100 Master Traits");
    p1.master_level = 55;
    p1.skillboard = (0..100).map(|i| 0xBEEF_0000 + i).collect();
    parser.on_player_identity_event(p1);

    // Slot 2: two different watched bosses, both at the top of every window.
    let mut p2 = identity(2, RACKAM, "SEED 2 Perfect Summons");
    p2.summons = vec![
        perfect(LUCILIUS, ALPHA, NA_DMG_CAP_BONUS),
        perfect(BEHEMOTH_III, UPLIFT, BEHEMOTH_BONUS),
    ];
    parser.on_player_identity_event(p2);

    // Slot 3: three different watched bosses, both slots maxed on each.
    let mut p3 = identity(3, IO, "SEED 3 Perfect Summons");
    p3.summons = vec![
        perfect(LUCILIUS, ALPHA, NA_DMG_CAP_BONUS),
        perfect(BEHEMOTH_III, UPLIFT, BEHEMOTH_BONUS),
        perfect(ROLAN, ROLAN_MAIN, ROLAN_BONUS),
    ];
    parser.on_player_identity_event(p3);

    // A hit per player so the log row carries damage and every row joins a name.
    for (slot, character) in [(0, GRAN), (1, KATALINA), (2, RACKAM), (3, IO)] {
        parser.on_damage_event(damage(slot, character, 100_000 * (slot as i32 + 1)));
    }

    // Quest fields set directly rather than via on_quest_complete_event: that
    // path wipes player_data after its own (db-less, no-op) save.
    parser.encounter.quest_id = Some(0x1234_5678);
    parser.encounter.quest_timer = Some(92);
    parser.encounter.quest_completed = true;

    // Self-check before touching the db: what do the CURRENT rules say?
    println!("== what the current rules find on the seeded players ==");
    for player in parser.encounter.player_data.iter().flatten() {
        let findings = legality::audit_player(player);
        println!("{}: {} finding(s)", player.display_name(), findings.len());
        for finding in &findings {
            println!(
                "    {:?}/{:?} at {:?}: observed {:?}, allowed {:?}",
                finding.rule, finding.severity, finding.subject, finding.observed, finding.allowed
            );
        }
    }

    let blob = parser.encounter.to_blob()?;
    let players: Vec<_> = parser.encounter.player_data.iter().flatten().collect();
    if players.len() != 4 {
        bail!("expected 4 seeded players, got {}", players.len());
    }

    let conn = Connection::open_with_flags(
        &db_path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;

    // Replace, don't accumulate: re-running the seeder (e.g. after the rules
    // or the fixture change) supersedes its previous synthetic encounter.
    // Only rows this seeder created can match — real logs never carry a
    // 'SEED '-prefixed p1.
    let replaced = conn.execute("DELETE FROM logs WHERE p1_name LIKE 'SEED %'", [])?;
    if replaced > 0 {
        println!("\nreplaced {replaced} previously seeded encounter(s)");
    }

    conn.execute(
        r#"INSERT INTO logs (
                name, time, duration, data, version, primary_target,
                p1_name, p1_type, p2_name, p2_type,
                p3_name, p3_type, p4_name, p4_type,
                quest_id, quest_elapsed_time, quest_completed, total_damage
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
        params![
            "",
            Utc::now().timestamp_millis(),
            parser.full_log_duration(),
            &blob,
            1,
            TARGET_TYPE,
            players[0].display_name(),
            players[0].character_type().to_string(),
            players[1].display_name(),
            players[1].character_type().to_string(),
            players[2].display_name(),
            players[2].character_type().to_string(),
            players[3].display_name(),
            players[3].character_type().to_string(),
            parser.encounter.quest_id,
            parser.encounter.quest_timer,
            parser.encounter.quest_completed,
            1_000_000_i64,
        ],
    )?;

    println!(
        "\ninserted synthetic encounter as log id {} into {}",
        conn.last_insert_rowid(),
        db_path.display()
    );
    Ok(())
}
