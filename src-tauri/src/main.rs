// Prevents additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    collections::HashMap,
    fs::File,
    io::Write,
    sync::atomic::{AtomicBool, Ordering},
};

use anyhow::Context;
use gbfr_logs::{db, parser};
#[cfg(windows)]
use gbfr_logs::{overmastery, synthesis};

use db::logs::LogEntry;
#[cfg(windows)]
use dll_syringe::{process::OwnedProcess, Syringe};
#[cfg(windows)]
use interprocess::os::windows::named_pipe::tokio::RecvPipeStream;
#[cfg(windows)]
use std::path::Path;
use log::{info, LevelFilter};
use parser::{
    constants::{CharacterType, EnemyType},
    v1::{self, PlayerData},
};
use protocol::Message;
use rusqlite::params_from_iter;
use serde::{Deserialize, Serialize};
use tauri::{
    api::dialog::blocking::FileDialogBuilder, AppHandle, CustomMenuItem, LogicalSize, Manager,
    Size, State, SystemTray, SystemTrayEvent, SystemTrayMenu, SystemTrayMenuItem,
};
use tauri_plugin_log::LogTarget;
use tauri_plugin_window_state::{AppHandleExt, StateFlags};
use tokio_stream::StreamExt;
use tokio_util::codec::FramedRead;

struct AlwaysOnTop(AtomicBool);
struct ClickThrough(AtomicBool);
struct DebugMode(AtomicBool);

/// Sender half of the live parser's reset channel. `None` until a parser is
/// connected; replaced on every reconnect (the parser is owned by the
/// pipe-reading task, so commands reach it through this channel).
struct ResetChannel(std::sync::Mutex<Option<tokio::sync::mpsc::UnboundedSender<()>>>);

#[tauri::command]
fn reset_encounter(state: State<ResetChannel>) {
    if let Some(tx) = state.0.lock().unwrap().as_ref() {
        let _ = tx.send(());
    }
}

/// Toolbox / Synthesis Helper: snapshot the game's synthesis state and report
/// whether predictions are currently possible.
#[cfg(windows)]
#[tauri::command(async)]
async fn fetch_synthesis_status() -> Result<synthesis::SynthesisStatus, String> {
    tokio::task::spawn_blocking(|| match synthesis::snapshot::take_snapshot() {
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
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Toolbox / Synthesis Helper: fresh snapshot + exhaustive pair search.
#[cfg(windows)]
#[tauri::command(async)]
async fn search_synthesis(
    query: synthesis::SynthesisQuery,
) -> Result<synthesis::SynthesisSearchResponse, String> {
    if query.trait1 == synthesis::EMPTY_TRAIT || query.trait2 == Some(synthesis::EMPTY_TRAIT) {
        return Err("invalid-trait".to_string());
    }
    tokio::task::spawn_blocking(move || {
        let snap = synthesis::snapshot::take_snapshot()
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "game-not-running".to_string())?;
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
#[cfg(windows)]
#[tauri::command(async)]
async fn fetch_synthesis_seed() -> Result<Option<synthesis::SynthesisSeed>, String> {
    tokio::task::spawn_blocking(|| {
        synthesis::snapshot::take_seed_state().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Toolbox / Overmastery Predictor: is the game up, and which characters
/// exist in the roster (for the character picker).
#[cfg(windows)]
#[tauri::command(async)]
async fn fetch_overmastery_status() -> Result<overmastery::OvermasteryStatus, String> {
    tokio::task::spawn_blocking(|| match overmastery::snapshot::take_snapshot() {
        Ok(None) => Ok(overmastery::OvermasteryStatus {
            game_running: false,
            roster: Vec::new(),
        }),
        Ok(Some(snap)) => Ok(overmastery::OvermasteryStatus {
            game_running: true,
            roster: snap.roster,
        }),
        Err(e) => Err(e.to_string()),
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Toolbox / Overmastery Predictor: fresh RNG snapshot + simulate the next N
/// meditation rolls for one character and size.
#[cfg(windows)]
#[tauri::command(async)]
async fn predict_overmastery(
    query: overmastery::OvermasteryQuery,
) -> Result<overmastery::OvermasteryPrediction, String> {
    let tables = overmastery::stock_tables();
    if query.tier >= tables.tiers.len() {
        return Err("invalid-tier".to_string());
    }
    let rolls = query.rolls.min(500);
    tokio::task::spawn_blocking(move || {
        let snap = overmastery::snapshot::take_snapshot()
            .map_err(|e| e.to_string())?
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
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Toolbox / Overmastery Predictor: current RNG state of one slot, for
/// staleness polling against a prediction's `slot_state`. `None` = game not
/// running (staleness unknowable, not stale).
#[cfg(windows)]
#[tauri::command(async)]
async fn fetch_overmastery_seed(slot: u32) -> Result<Option<u32>, String> {
    // The bound is owned by `take_slot_state`, which knows RNG_SLOT_COUNT.
    tokio::task::spawn_blocking(move || {
        overmastery::snapshot::take_slot_state(slot).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Non-Windows stubs: these tools read game memory from outside the process,
/// which the Linux build does not support (see the Linux spec). The frontend
/// hides them; the stub keeps the invoke surface identical.
#[cfg(not(windows))]
#[tauri::command]
async fn fetch_synthesis_status() -> Result<(), String> {
    Err("windows-only".into())
}

#[cfg(not(windows))]
#[tauri::command]
async fn search_synthesis() -> Result<(), String> {
    Err("windows-only".into())
}

#[cfg(not(windows))]
#[tauri::command]
async fn fetch_synthesis_seed() -> Result<(), String> {
    Err("windows-only".into())
}

#[cfg(not(windows))]
#[tauri::command]
async fn fetch_overmastery_status() -> Result<(), String> {
    Err("windows-only".into())
}

#[cfg(not(windows))]
#[tauri::command]
async fn predict_overmastery() -> Result<(), String> {
    Err("windows-only".into())
}

#[cfg(not(windows))]
#[tauri::command]
async fn fetch_overmastery_seed() -> Result<(), String> {
    Err("windows-only".into())
}

#[tauri::command]
fn set_debug_mode(app: AppHandle, state: State<DebugMode>, enabled: bool) {
    if let Some(window) = app.get_window("logs") {
        if enabled {
            window.open_devtools()
        } else {
            window.close_devtools()
        }
    }

    state.0.store(enabled, Ordering::Release);
}

/// Config file the injected hook reads ONCE at startup. It lives in the data
/// dir the HOOK resolves at runtime — `dirs::data_dir()/gbfr-logs` on
/// Windows; on Linux the hook runs inside the Proton prefix, so the same
/// logical path lands inside `pfx/drive_c/...` and we write it there.
fn hook_config_path() -> Result<std::path::PathBuf, String> {
    #[cfg(not(target_os = "linux"))]
    let mut path = {
        let mut path = tauri::api::path::data_dir().ok_or("Could not find the data folder")?;
        path.push("gbfr-logs");
        path
    };
    #[cfg(target_os = "linux")]
    let mut path = {
        use gbfr_logs::linux_support::steam;
        let home = std::env::var_os("HOME")
            .map(std::path::PathBuf::from)
            .ok_or("HOME is not set")?;
        steam::discover(&steam::default_steam_roots(&home))
            .ok_or("Could not find the game's Steam install")?
            .hook_data_dir
    };
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    path.push("hook-config.json");

    Ok(path)
}

/// Whether the dev-only Infinity Full Assist unlock is armed for the next game launch.
#[tauri::command]
fn get_full_assist_unlock() -> Result<bool, String> {
    if !cfg!(debug_assertions) {
        return Ok(false);
    }

    let path = hook_config_path()?;
    let Ok(contents) = std::fs::read_to_string(&path) else {
        return Ok(false);
    };

    let value: serde_json::Value = serde_json::from_str(&contents).map_err(|e| e.to_string())?;

    Ok(value
        .get("unlock_full_assist_infinity")
        .and_then(|v| v.as_bool())
        .unwrap_or(false))
}

/// Arm/disarm the unlock. Dev builds only — and even then it does nothing unless the hook
/// was built with the `fullassist` feature, which only `npm run dev` passes.
#[tauri::command]
fn set_full_assist_unlock(enabled: bool) -> Result<(), String> {
    if !cfg!(debug_assertions) {
        return Err("The Full Assist unlock is only available in development builds".into());
    }

    let path = hook_config_path()?;
    let contents = serde_json::json!({ "unlock_full_assist_infinity": enabled });

    std::fs::write(&path, contents.to_string()).map_err(|e| e.to_string())
}

#[cfg(target_os = "linux")]
mod linux_setup {
    use serde::Serialize;
    use std::path::PathBuf;
    use tauri::AppHandle;

    use gbfr_logs::linux_support::{deploy, steam};

    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct LinuxSetupStatus {
        steam_found: bool,
        game_dir: Option<String>,
        prefix_found: bool,
        /// "missing" | "current" | "outdated" | "foreign"
        proxy_status: String,
        launch_options: String,
    }

    fn game_and_hook(app: &AppHandle) -> Result<(steam::SteamGame, PathBuf), String> {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or("HOME is not set")?;
        let game = steam::discover(&steam::default_steam_roots(&home))
            .ok_or("Could not find the game's Steam install")?;
        let bundled = app
            .path_resolver()
            .resolve_resource("hook.dll")
            .ok_or("hook.dll resource missing from this build")?;
        Ok((game, bundled))
    }

    fn status_word(status: deploy::ProxyStatus) -> String {
        match status {
            deploy::ProxyStatus::Missing => "missing",
            deploy::ProxyStatus::Current => "current",
            deploy::ProxyStatus::Outdated => "outdated",
            deploy::ProxyStatus::Foreign => "foreign",
        }
        .into()
    }

    #[tauri::command]
    pub fn fetch_linux_setup_status(app: AppHandle) -> Result<LinuxSetupStatus, String> {
        let (game, bundled) = match game_and_hook(&app) {
            Ok(pair) => pair,
            Err(e) => {
                // "Steam not found" is the panel's normal empty state, but a
                // missing bundled resource is a packaging defect — keep the
                // real reason in the log.
                log::warn!("linux setup status unavailable: {e}");
                return Ok(LinuxSetupStatus {
                    steam_found: false,
                    game_dir: None,
                    prefix_found: false,
                    proxy_status: "missing".into(),
                    launch_options: deploy::LAUNCH_OPTIONS.into(),
                });
            }
        };
        let proxy = deploy::proxy_status(&game.game_dir, &bundled).map_err(|e| format!("{e:#}"))?;
        Ok(LinuxSetupStatus {
            steam_found: true,
            game_dir: Some(game.game_dir.display().to_string()),
            prefix_found: game.prefix_dir.is_dir(),
            proxy_status: status_word(proxy),
            launch_options: deploy::LAUNCH_OPTIONS.into(),
        })
    }

    #[tauri::command]
    pub fn deploy_linux_hook(app: AppHandle) -> Result<(), String> {
        let (game, bundled) = game_and_hook(&app)?;
        deploy::deploy(&game.game_dir, &bundled)
            .map(|_| ())
            .map_err(|e| format!("{e:#}"))
    }

    #[tauri::command]
    pub fn remove_linux_hook(app: AppHandle) -> Result<(), String> {
        let (game, _) = game_and_hook(&app)?;
        deploy::remove(&game.game_dir).map_err(|e| format!("{e:#}"))
    }
}

#[cfg(target_os = "linux")]
use linux_setup::{deploy_linux_hook, fetch_linux_setup_status, remove_linux_hook};

#[cfg(not(target_os = "linux"))]
#[tauri::command]
fn fetch_linux_setup_status() -> Result<(), String> {
    Err("linux-only".into())
}

#[cfg(not(target_os = "linux"))]
#[tauri::command]
fn deploy_linux_hook() -> Result<(), String> {
    Err("linux-only".into())
}

#[cfg(not(target_os = "linux"))]
#[tauri::command]
fn remove_linux_hook() -> Result<(), String> {
    Err("linux-only".into())
}

#[tauri::command]
async fn delete_all_logs() -> Result<(), String> {
    let conn = db::connect_to_db().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM logs", [])
        .map_err(|e| e.to_string())?;
    // Deleting every log leaves every Conflux run roomless — drop them too so the
    // Conflux tab doesn't keep showing ghost "×0 rooms" runs.
    conn.execute("DELETE FROM runs", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn export_damage_log_to_file(id: u32, options: ParseOptions) -> Result<(), String> {
    let file_path = FileDialogBuilder::new()
        .add_filter("csv", &["csv"])
        .set_file_name(&format!("{id}_damage_log.csv"))
        .set_title("Export Damage Log")
        .save_file()
        .ok_or("No file selected!")?;

    let conn = db::connect_to_db().map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare("SELECT data, version FROM logs WHERE id = ?")
        .map_err(|e| e.to_string())?;

    let (blob, version): (Vec<u8>, u8) = stmt
        .query_row([id], |row| Ok((row.get(0)?, row.get(1)?)))
        .context("Failed to fetch log from database")
        .map_err(|e| e.to_string())?;

    let parser = parser::deserialize_version(&blob, version).map_err(|e| e.to_string())?;

    let file = File::create(file_path).map_err(|e| e.to_string())?;

    // @TODO(false): Split formatting into a separate function.
    let mut writer = std::io::BufWriter::new(file);

    writeln!(
        writer,
        "timestamp,source_type,child_source_type,source_index,target_type,target_index,action_id,flags,damage"
    )
    .map_err(|e| e.to_string())?;

    for (event_ts, event) in parser.encounter.event_log() {
        if let Message::DamageEvent(damage_event) = event {
            let timestamp = event_ts - parser.start_time();
            let target_type = EnemyType::from_hash(damage_event.target.parent_actor_type);
            let parent_character_type =
                CharacterType::from_hash(damage_event.source.parent_actor_type);
            let child_character_type = CharacterType::from_hash(damage_event.source.actor_type);

            // Honour the scrub window too, not just the target filter: the export is
            // meant to be what the view shows, and exporting from a windowed view used to
            // silently write the whole fight.
            let inside_window = options.from_ms.map_or(true, |from| timestamp >= from)
                && options.up_to_ms.map_or(true, |up_to| timestamp <= up_to);

            if inside_window && v1::target_selected(timestamp, damage_event, &options.target_spans)
            {
                writeln!(
                    writer,
                    "{},{},{},{},{},{},{},{},{}",
                    timestamp,
                    parent_character_type,
                    child_character_type,
                    damage_event.source.parent_index,
                    target_type,
                    damage_event.target.parent_index,
                    damage_event.action_id,
                    damage_event.flags,
                    damage_event.damage
                )
                .map_err(|e| e.to_string())?;
            }
        }
    }

    writer.flush().map_err(|e| e.to_string())?;

    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchResult {
    logs: Vec<LogEntry>,
    page: u32,
    page_count: u32,
    log_count: i32,
    /// IDs of the enemies that can be filtered by.
    enemy_ids: Vec<u32>,
    /// IDs of the quests that can be filtered by.
    quest_ids: Vec<u32>,
    /// Names of the Players that can be filtered by.
    player_ids: Vec<String>,
    /// Names of the Characters that can be filtered by.
    player_types: Vec<String>,
}

#[tauri::command]
fn fetch_logs(
    page: Option<u32>,
    filter_by_enemy_id: Option<u32>,
    filter_by_quest_id: Option<u32>,
    sort_direction: Option<String>,
    sort_type: Option<String>,
    quest_completed: Option<bool>,
    filter_by_player_id: Option<String>,
    filter_by_player_character: Option<String>,
) -> Result<SearchResult, String> {
    let conn = db::connect_to_db().map_err(|e| e.to_string())?;
    let page = page.unwrap_or(1);
    let per_page = 10;
    let offset = page.saturating_sub(1) * per_page;

    let sort_type_param = sort_type
        .map(|s| match s.as_str() {
            "time" => db::logs::SortType::Time,
            "duration" => db::logs::SortType::Duration,
            "quest-elapsed-time" => db::logs::SortType::QuestElapsedTime,
            _ => db::logs::SortType::Time,
        })
        .unwrap_or(db::logs::SortType::Time);

    let sort_direction_param = sort_direction
        .map(|s| match s.as_str() {
            "asc" => db::logs::SortDirection::Ascending,
            _ => db::logs::SortDirection::Descending,
        })
        .unwrap_or(db::logs::SortDirection::Descending);

    let logs = db::logs::get_logs(
        &conn,
        filter_by_enemy_id,
        filter_by_quest_id,
        per_page,
        offset,
        &sort_type_param,
        &sort_direction_param,
        quest_completed,
        &filter_by_player_id,
        &filter_by_player_character,
    )
    .map_err(|e| e.to_string())?;

    let log_count = db::logs::get_logs_count(
        &conn,
        filter_by_enemy_id,
        filter_by_quest_id,
        quest_completed,
        &filter_by_player_id,
        &filter_by_player_character,
    )
    .map_err(|e| e.to_string())?;

    let page_count = (log_count as f64 / per_page as f64).ceil() as u32;

    let mut enemy_ids = Vec::new();
    let mut quest_ids = Vec::new();
    let mut player_ids = Vec::new();
    let mut player_types = Vec::new();

    let mut query = conn
        .prepare("SELECT primary_target, quest_id, p1_name, p1_type, p2_name, p2_type, p3_name, p3_type, p4_name, p4_type from logs WHERE run_id IS NULL")
        .map_err(|e| e.to_string())?;

    let rows = query
        .query_map([], |row| {
            Ok((
                row.get::<usize, Option<u32>>(0)?,    // primary_target
                row.get::<usize, Option<u32>>(1)?,    // quest_id
                row.get::<usize, Option<String>>(2)?, // p1_name
                row.get::<usize, Option<String>>(3)?, // p1_type
                row.get::<usize, Option<String>>(4)?, // p2_name
                row.get::<usize, Option<String>>(5)?, // p2_type
                row.get::<usize, Option<String>>(6)?, // p3_name
                row.get::<usize, Option<String>>(7)?, // p3_type
                row.get::<usize, Option<String>>(8)?, // p4_name
                row.get::<usize, Option<String>>(9)?, // p4_type
            ))
        })
        .map_err(|e| e.to_string())?;

    for row in rows {
        let (
            primary_target,
            quest_id,
            p1_name,
            p1_type,
            p2_name,
            p2_type,
            p3_name,
            p3_type,
            p4_name,
            p4_type,
        ) = row.map_err(|e| e.to_string())?;

        if let Some(primary_target) = primary_target {
            if !enemy_ids.contains(&primary_target) {
                enemy_ids.push(primary_target);
            }
        }

        if let Some(quest_id) = quest_id {
            if !quest_ids.contains(&quest_id) {
                quest_ids.push(quest_id);
            }
        }

        for p_name in [p1_name, p2_name, p3_name, p4_name] {
            if let Some(p_name) = p_name {
                if !player_ids.contains(&p_name) {
                    player_ids.push(p_name)
                }
            }
        }

        for p_type in [p1_type, p2_type, p3_type, p4_type] {
            if let Some(p_type) = p_type {
                if !player_types.contains(&p_type) {
                    player_types.push(p_type)
                }
            }
        }
    }

    Ok(SearchResult {
        logs,
        page,
        page_count,
        log_count,
        enemy_ids,
        quest_ids,
        player_ids,
        player_types,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfluxSearchResult {
    runs: Vec<db::runs::ConfluxRun>,
    page: u32,
    page_count: u32,
    run_count: i32,
}

#[tauri::command]
fn fetch_conflux_runs(page: Option<u32>) -> Result<ConfluxSearchResult, String> {
    let conn = db::connect_to_db().map_err(|e| e.to_string())?;
    let page = page.unwrap_or(1);
    let per_page = 10u32;
    let offset = page.saturating_sub(1) * per_page;

    let runs = db::runs::get_runs(&conn, per_page, offset).map_err(|e| e.to_string())?;
    let run_count = db::runs::get_runs_count(&conn).map_err(|e| e.to_string())?;
    let page_count = (run_count as f64 / per_page as f64).ceil() as u32;

    Ok(ConfluxSearchResult {
        runs,
        page,
        page_count,
        run_count,
    })
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct EncounterStateResponse {
    encounter_state: v1::DerivedEncounterState,
    players: [Option<PlayerData>; 4],
    quest_id: Option<u32>,
    quest_timer: Option<u32>,
    quest_completed: bool,
    /// 0-based room index when this log is a Conflux room, else None. Lets the
    /// detail view suppress quest-status/elapsed-time (meaningless for a room).
    room_index: Option<u32>,
    /// Per-spawn selectable targets for the filter dropdown, in first-hit
    /// order — 1:1 with the HP chart's series (same instance numbers).
    target_entries: Vec<v1::TargetSegment>,
    dps_chart: HashMap<u32, Vec<i32>>,
    /// Enemy HP% per DPS-chart bucket, one series per HP pool passing the target
    /// filter (largest pools first, capped). Empty on logs recorded before HP capture.
    hp_chart: Vec<v1::HpChartSeries>,
    sba_chart: HashMap<u32, Vec<f32>>,
    sba_events: Vec<(i64, protocol::Message)>,
    death_events: Vec<(i64, protocol::Message)>,
    chart_len: usize,
    sba_chart_len: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ParseOptions {
    /// Per-spawn segment spans to filter by (empty = all). Spans, not bare
    /// ids: the game reuses freed instance ids across summon waves, so a
    /// selection is "this id DURING this window".
    #[serde(default)]
    target_spans: Vec<v1::TargetSpan>,
    /// Scrubber cutoff relative to the first event (ms): the derived meter state
    /// reflects the fight up to this moment. Absent/None = the full fight.
    #[serde(default)]
    up_to_ms: Option<i64>,
    /// When true, skip chart/segment/event-list building and return those
    /// fields empty — scrub commits only consume `encounter_state` and keep
    /// their charts from the full fetch, so rebuilding the rest per brush
    /// release is wasted work (and its per-player rows would be wrong anyway:
    /// they'd exist only for players active inside the window).
    #[serde(default)]
    state_only: bool,
    /// Scrubber window start relative to the first event (ms); pairs with
    /// `up_to_ms` so the derived meter state covers only `[from_ms, up_to_ms]`.
    /// Absent/None = from the start of the fight.
    #[serde(default)]
    from_ms: Option<i64>,
}

// `(async)` so the decompress + full reparse runs off the main thread — this is
// called on every log open, filter change, and brush release.
#[tauri::command(async)]
fn fetch_encounter_state(id: u64, options: ParseOptions) -> Result<EncounterStateResponse, String> {
    let conn = db::connect_to_db().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT data, version, room_index FROM logs WHERE id = ?")
        .map_err(|e| e.to_string())?;

    let (blob, version, room_index): (Vec<u8>, u8, Option<u32>) = stmt
        .query_row([id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .map_err(|e| e.to_string())?;

    // @TODO(false): If we deserialize from an older version, we should save it back into the DB as the newer format.
    let mut parser = parser::deserialize_version(&blob, version).map_err(|e| e.to_string())?;

    parser.reparse_with_options_window(&options.target_spans, options.from_ms, options.up_to_ms);

    if options.state_only {
        // Only the fields the scrub commit actually consumes; everything else stays at its
        // Default so a new response field doesn't have to be mirrored as a hand-written
        // zero here (where forgetting it would silently return stale-looking data).
        return Ok(EncounterStateResponse {
            encounter_state: parser.derived_state,
            players: parser.encounter.player_data,
            quest_id: parser.encounter.quest_id,
            quest_timer: parser.encounter.quest_timer,
            quest_completed: parser.encounter.quest_completed,
            room_index,
            ..Default::default()
        });
    }

    // Chart buffers span the FULL fight even when a scrub cutoff truncates the
    // derived state — the chart-building loops below walk the full event log, so
    // sizing from the truncated duration would index out of bounds.
    let duration = parser.full_log_duration();

    let mut player_dps: HashMap<u32, Vec<i32>> = HashMap::new();

    // Per-second buckets: the quest-details charts and the window scrubber both
    // work in whole seconds, so a bucket index IS the elapsed second.
    const DPS_INTERVAL: i64 = 1_000;
    const SBA_INTERVAL: i64 = 1_000;

    for player in parser.derived_state.party.values() {
        player_dps.insert(
            player.index,
            vec![0; (duration / DPS_INTERVAL) as usize + 1],
        );
    }

    let start_time = parser.start_time();
    // Dropdown entries are ALWAYS the unfiltered segmentation — the user picks
    // from everything the fight contained, whatever is currently selected.
    let target_entries = v1::segment_targets(&parser.encounter.raw_event_log, start_time);

    for (timestamp, event) in parser.encounter.event_log() {
        match event {
            Message::DamageEvent(damage_event) => {
                // Attribute dragon-form (Id/Pl2000) damage to the Id player, matching the
                // remap the party table uses — otherwise `derived_state.party` (keyed by the
                // remapped index) has no bucket for the raw Pl2000 index and the chart drops it.
                let damage_event =
                    v1::remap_dragon_form(&parser.encounter.player_data, damage_event);
                let damage_event = &damage_event;

                let index = ((timestamp - start_time) / DPS_INTERVAL) as usize;

                if let Some(chart) = player_dps.get_mut(&damage_event.source.parent_index) {
                    // Check to see if the target is in the list of targets to filter by.
                    if v1::target_selected(
                        timestamp - start_time,
                        damage_event,
                        &options.target_spans,
                    ) {
                        chart[index] += damage_event.damage;
                    }
                }
            }
            _ => continue,
        }
    }

    let hp_chart = v1::build_target_hp_charts(
        &parser.encounter.raw_event_log,
        &target_entries,
        start_time,
        DPS_INTERVAL,
        (duration / DPS_INTERVAL) as usize + 1,
        &options.target_spans,
    );

    let sba_chart = parser.generate_sba_chart(SBA_INTERVAL);

    let sba_events = parser
        .encounter
        .event_log()
        .filter(|(_, e)| {
            matches!(
                e,
                Message::OnContinueSBAChain(_)
                    | Message::OnAttemptSBA(_)
                    | Message::OnPerformSBA(_)
            )
        })
        .map(|(ts, e)| (*ts - start_time, e.clone()))
        .collect();

    let death_events = parser
        .encounter
        .event_log()
        .filter(|(_, e)| matches!(e, Message::OnDeathEvent(_)))
        .map(|(ts, e)| (*ts - start_time, e.clone()))
        .collect();

    Ok(EncounterStateResponse {
        encounter_state: parser.derived_state,
        players: parser.encounter.player_data,
        quest_id: parser.encounter.quest_id,
        quest_timer: parser.encounter.quest_timer,
        quest_completed: parser.encounter.quest_completed,
        room_index,
        dps_chart: player_dps,
        hp_chart,
        chart_len: (duration / DPS_INTERVAL) as usize + 1,
        sba_chart_len: (duration / SBA_INTERVAL) as usize + 1,
        sba_chart,
        sba_events,
        death_events,
        target_entries,
    })
}

#[tauri::command]
fn delete_logs(ids: Vec<u64>) -> Result<(), String> {
    let conn = db::connect_to_db().map_err(|e| e.to_string())?;

    let id_params: Vec<String> = ids.iter().map(|_| "?".to_string()).collect();
    let param = id_params.join(",");

    let sql = format!("DELETE FROM logs WHERE id IN ({})", param);
    {
        let mut statement = conn.prepare_cached(&sql).map_err(|e| e.to_string())?;
        statement
            .execute(params_from_iter(ids))
            .map_err(|e| e.to_string())?;
    }

    // A deleted log may have been a Conflux room; reap any run left with no rooms so it
    // doesn't linger as a ghost "×0 rooms" row (the startup sweep only reaps in-progress
    // runs).
    db::runs::delete_runs_without_rooms(&conn).map_err(|e| e.to_string())?;

    Ok(())
}

// Continuously check for the game process and inject the DLL when found.
#[cfg(windows)]
async fn check_and_perform_hook(app: AppHandle) {
    loop {
        match OwnedProcess::find_first_by_name(gbfr_logs::game_mem::GAME_EXE) {
            Some(target) => {
                let syringe = Syringe::for_process(target);
                let debug_dll_path = Path::new("hook-dbg.dll");
                let mut dll_path = Path::new("hook.dll");

                if cfg!(debug_assertions) && debug_dll_path.exists() {
                    dll_path = debug_dll_path;
                }

                info!("Found game process, injecting DLL: {:?}", dll_path);

                let _ = syringe.inject(dll_path);
                let _ = app.emit_all("success-alert", "Found game..");

                connect_and_run_parser(app);

                break;
            }
            None => {
                tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
            }
        }
    }
}

// Linux: no injector. Refresh the dinput8 proxy in the game folder
// (best-effort — the setup panel surfaces failures), then let the TCP
// connect-retry loop double as the "game running?" poll.
#[cfg(not(windows))]
async fn check_and_perform_hook(app: AppHandle) {
    use gbfr_logs::linux_support::{deploy, steam};

    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    let bundled = app.path_resolver().resolve_resource("hook.dll");
    match (home, bundled) {
        (Some(home), Some(bundled)) => {
            match steam::discover(&steam::default_steam_roots(&home)) {
                Some(game) => match deploy::deploy(&game.game_dir, &bundled) {
                    Ok(_) => info!("proxy dinput8.dll is current in {:?}", game.game_dir),
                    Err(e) => log::warn!("could not deploy the proxy DLL: {e:?}"),
                },
                None => log::warn!(
                    "Steam install of the game not found; see Settings → Linux setup"
                ),
            }
        }
        _ => log::warn!("no HOME or no bundled hook.dll; cannot deploy the proxy DLL"),
    }

    connect_and_run_parser(app);
}

/// Connect to the hook's event stream: the named pipe on Windows (localhost
/// TCP when GBFR_LOGS_FORCE_TCP=1, for parity-testing the Linux path), and
/// localhost TCP elsewhere — under Proton the hook detects Wine and listens
/// on TCP because a native Linux app cannot open Wine named pipes.
async fn connect_event_stream() -> anyhow::Result<Box<dyn tokio::io::AsyncRead + Unpin + Send>> {
    #[cfg(windows)]
    if std::env::var("GBFR_LOGS_FORCE_TCP").as_deref() != Ok("1") {
        let stream = RecvPipeStream::connect_by_path(protocol::PIPE_NAME).await?;
        return Ok(Box::new(stream));
    }
    let stream = tokio::net::TcpStream::connect(protocol::TCP_ADDR).await?;
    Ok(Box::new(stream))
}

// Connect to the game hook event channel and listen for damage events.
fn connect_and_run_parser(app: AppHandle) {
    let window = app.get_window("main").expect("Window not found");
    let logs_window = app.get_window("logs").expect("Logs window not found");

    let database = db::connect_to_db().expect("Could not connect to database");
    let mut state = v1::Parser::new(app.clone(), window.clone(), database);

    let (reset_tx, mut reset_rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    *app.state::<ResetChannel>().0.lock().unwrap() = Some(reset_tx);

    tauri::async_runtime::spawn(async move {
        loop {
            match connect_event_stream().await {
                Ok(stream) => {
                    info!("Connected to game!");

                    let _ = app.emit_all("success-alert", "Connnected to game!");

                    let decoder = tokio_util::codec::LengthDelimitedCodec::new();
                    let mut reader = FramedRead::new(stream, decoder);

                    loop {
                        let msg = tokio::select! {
                            next = reader.next() => match next {
                                Some(Ok(msg)) => msg,
                                // Pipe closed or read error: the game is gone.
                                _ => break,
                            },
                            Some(()) = reset_rx.recv() => {
                                state.on_manual_reset();
                                continue;
                            }
                        };

                        // Handle EOF when the game closes.
                        if msg.is_empty() {
                            break;
                        }

                        let debug_mode = app.state::<DebugMode>().0.load(Ordering::Relaxed);

                        if let Ok(msg) = protocol::bincode::deserialize::<protocol::Message>(&msg) {
                            if debug_mode {
                                let _ = logs_window.emit("debug-event", &msg);
                            }

                            match msg {
                                protocol::Message::DamageEvent(event) => {
                                    state.on_damage_event(event);
                                }
                                protocol::Message::OnAreaEnter(event) => {
                                    state.on_area_enter_event(event);
                                }
                                protocol::Message::PlayerLoadEvent(event) => {
                                    state.on_player_load_event(event);
                                }
                                protocol::Message::PlayerIdentityEvent(event) => {
                                    state.on_player_identity_event(event);
                                }
                                protocol::Message::OnQuestComplete(event) => {
                                    state.on_quest_complete_event(event);
                                }
                                protocol::Message::OnQuestFail(event) => {
                                    info!(
                                        "quest retire/fail boundary: quest_id={:#x}",
                                        event.quest_id
                                    );
                                    state.on_quest_fail_event(event);
                                }
                                protocol::Message::OnUpdateSBA(event) => {
                                    state.on_sba_update(event);
                                }
                                protocol::Message::OnAttemptSBA(event) => {
                                    state.on_sba_attempt(event);
                                }
                                protocol::Message::OnPerformSBA(event) => {
                                    state.on_sba_perform(event);
                                }
                                protocol::Message::OnContinueSBAChain(event) => {
                                    state.on_continue_sba_chain(event);
                                }
                                protocol::Message::OnDeathEvent(event) => {
                                    state.on_death_event(event);
                                }
                                protocol::Message::ConfluxRoomEnter(event) => {
                                    info!(
                                        "CONFLUX ingress: ConfluxRoomEnter quest_id={:#x} manager={:#x}",
                                        event.quest_id, event.manager_ptr
                                    );
                                    state.on_conflux_room_enter(event);
                                }
                                protocol::Message::ConfluxBuffAcquired(event) => {
                                    info!(
                                        "CONFLUX ingress: ConfluxBuffAcquired buff_id={:#x}",
                                        event.buff_id
                                    );
                                    state.on_conflux_buff_acquired(event);
                                }
                                protocol::Message::ConfluxRunEnd(event) => {
                                    info!(
                                        "CONFLUX ingress: ConfluxRunEnd manager={:#x}",
                                        event.manager_ptr
                                    );
                                    state.on_conflux_run_end(event);
                                }
                                protocol::Message::OnPlayerStun(event) => {
                                    state.on_player_stun(event);
                                }
                                protocol::Message::OnPerfectGuardStun(event) => {
                                    state.on_perfect_guard_stun(event);
                                }
                                protocol::Message::OnPerfectGuardQuickening(event) => {
                                    state.on_perfect_guard_quickening(event);
                                }
                                protocol::Message::OnStunEffect(event) => {
                                    state.on_stun_effect(event);
                                }
                            }
                        }
                    }

                    info!("Game has closed.");

                    // Last chance to persist anything still in progress (abandoned quest →
                    // quit emits no result screen; mid-quest/mid-run quit likewise) — this
                    // parser instance is gone once we go back to waiting for the game.
                    state.on_game_disconnect();

                    // The game has closed, so we should go back to waiting for the game to reopen.
                    let _ = app.emit_all("error-alert", "Game has closed!");
                    break;
                }
                Err(_) => {
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
            }
        }

        // Check for the game process again.
        tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
        tauri::async_runtime::spawn(check_and_perform_hook(app));
    });
}

fn system_tray_with_menu() -> SystemTray {
    let meter = CustomMenuItem::new("open_meter", "Open Meter");
    let logs = CustomMenuItem::new("open_logs", "Open Logs");
    let always_on_top = CustomMenuItem::new("always_on_top", "Always on top ✓");
    let toggle_clickthrough = CustomMenuItem::new("toggle_clickthrough", "Clickthrough");
    let reset_windows = CustomMenuItem::new("reset_windows", "Reset Windows");
    let quit = CustomMenuItem::new("quit", "Quit");

    let menu = SystemTrayMenu::new()
        .add_item(meter)
        .add_item(logs)
        .add_item(always_on_top)
        .add_item(toggle_clickthrough)
        .add_item(reset_windows)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(quit);

    SystemTray::new().with_menu(menu)
}

fn toggle_window_visibility(handle: &AppHandle, id: &str, focus: Option<bool>) {
    if let Some(window) = handle.get_window(id) {
        if let Some(focus_value) = focus {
            if focus_value {
                window.set_focus().unwrap();
            }
        }

        match window.is_visible().unwrap() {
            true => window.hide().unwrap(),
            false => window.show().unwrap(),
        }
    }
}

#[tauri::command]
fn toggle_always_on_top(window: tauri::Window, state: State<AlwaysOnTop>) {
    let always_on_top = &state.0;
    let new_state = !always_on_top.load(Ordering::Acquire);
    always_on_top.store(new_state, Ordering::Release);
    if let Err(e) = window.set_always_on_top(new_state) {
        log::warn!("set_always_on_top({new_state}) failed: {e:?}");
    }
    let _ = window.emit("on-pinned", new_state);
    let _ = window
        .app_handle()
        .tray_handle()
        .get_item("always_on_top")
        .set_title(if new_state {
            "Always on top ✓"
        } else {
            "Always on top"
        });
}

#[tauri::command]
fn toggle_clickthrough(window: tauri::Window, state: State<ClickThrough>) {
    let click_through = &state.0;
    let new_state = !click_through.load(Ordering::Acquire);
    click_through.store(new_state, Ordering::Release);
    if let Err(e) = window.set_ignore_cursor_events(new_state) {
        log::warn!("set_ignore_cursor_events({new_state}) failed: {e:?}");
    }
    let _ = window.emit("on-clickthrough", new_state);
    let _ = window
        .app_handle()
        .tray_handle()
        .get_item("toggle_clickthrough")
        .set_title(if new_state {
            "Clickthrough ✓"
        } else {
            "Clickthrough"
        });
}

#[tauri::command]
fn reset_meter_window(app_handle: AppHandle) {
    reset_window_to_default(&app_handle, "main", true);
}

/// Show `label` and restore the default geometry declared for it in
/// tauri.conf.json. Shared by the in-app reset command and the tray's
/// "Reset Windows" item so the two can't drift apart.
fn reset_window_to_default(handle: &AppHandle, label: &str, center: bool) {
    let Some(window) = handle.get_window(label) else {
        return;
    };
    let _ = window.show();
    let _ = window.unminimize();
    match handle
        .config()
        .tauri
        .windows
        .iter()
        .find(|w| w.label == label)
    {
        Some(default) => {
            let _ = window.set_size(Size::Logical(LogicalSize {
                width: default.width,
                height: default.height,
            }));
        }
        // Resetting is the escape hatch for a window dragged off-screen or
        // sized to nothing, so a config that no longer declares this label
        // should be loud rather than a silent no-op.
        None => log::warn!("no window config for label {label:?}; size not reset"),
    }
    if center {
        let _ = window.center();
    }
}

fn menu_tray_handler(handle: &AppHandle, event: SystemTrayEvent) {
    let should_focus = true;
    match event {
        SystemTrayEvent::LeftClick { .. } => {
            toggle_window_visibility(handle, "main", Some(should_focus))
        }
        SystemTrayEvent::MenuItemClick { id, .. } => match id.as_str() {
            "open_meter" => toggle_window_visibility(handle, "main", Some(should_focus)),
            "open_logs" => toggle_window_visibility(handle, "logs", Some(should_focus)),
            "toggle_clickthrough" => toggle_clickthrough(
                handle.get_window("main").unwrap(),
                handle.state::<ClickThrough>(),
            ),
            "always_on_top" => toggle_always_on_top(
                handle.get_window("main").unwrap(),
                handle.state::<AlwaysOnTop>(),
            ),
            "reset_windows" => {
                reset_window_to_default(handle, "main", false);
                reset_window_to_default(handle, "logs", false);
            }
            "quit" => {
                let _ = handle.save_window_state(StateFlags::all());
                handle.exit(0)
            }
            _ => {}
        },
        _ => {} // Ignore rest of the events.
    }
}

fn show_window(app: &AppHandle) {
    let windows = app.windows();

    for window in windows.values() {
        let _ = window.show();
    }
}

fn main() {
    // The overlay depends on WM hints native Wayland refuses to clients
    // (always-on-top, clickthrough); route through XWayland — the game under
    // Proton is an XWayland window anyway. Respect an explicit user choice.
    #[cfg(target_os = "linux")]
    if std::env::var_os("GDK_BACKEND").is_none() {
        std::env::set_var("GDK_BACKEND", "x11");
    }

    // logs.db and the logs/ folder are opened via CWD-relative paths. On
    // Windows the installer's shortcut sets CWD to the (writable) install
    // dir, but on Linux a desktop entry or AppImage launches with CWD = `/`
    // or a read-only mount, so anchor the CWD to the XDG data dir instead.
    #[cfg(target_os = "linux")]
    {
        let mut data_dir = tauri::api::path::data_dir()
            .expect("Could not resolve the user data directory ($XDG_DATA_HOME)");
        data_dir.push("gbfr-logs");
        std::fs::create_dir_all(&data_dir)
            .unwrap_or_else(|e| panic!("Failed to create {}: {e}", data_dir.display()));
        std::env::set_current_dir(&data_dir)
            .unwrap_or_else(|e| panic!("Failed to enter {}: {e}", data_dir.display()));
    }

    info!("Starting application..");

    // Setup the database.
    db::setup_db().expect("Failed to setup database");

    info!("Database setup complete, launching application..");

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_window(app);
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(
            tauri_plugin_log::Builder::default()
                .targets([LogTarget::Folder("logs".into()), LogTarget::Stdout])
                .level(LevelFilter::Warn)
                .level_for("tao", LevelFilter::Error)
                .build(),
        )
        .manage(AlwaysOnTop(AtomicBool::new(true)))
        .manage(ClickThrough(AtomicBool::new(false)))
        .manage(DebugMode(AtomicBool::new(false)))
        .manage(ResetChannel(std::sync::Mutex::new(None)))
        .system_tray(system_tray_with_menu())
        .on_system_tray_event(menu_tray_handler)
        .on_window_event(|event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event.event() {
                event.window().hide().unwrap();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![
            fetch_encounter_state,
            fetch_logs,
            fetch_conflux_runs,
            delete_logs,
            delete_all_logs,
            toggle_always_on_top,
            reset_meter_window,
            export_damage_log_to_file,
            set_debug_mode,
            reset_encounter,
            fetch_synthesis_status,
            fetch_synthesis_seed,
            fetch_overmastery_status,
            predict_overmastery,
            fetch_overmastery_seed,
            search_synthesis,
            get_full_assist_unlock,
            set_full_assist_unlock,
            fetch_linux_setup_status,
            deploy_linux_hook,
            remove_linux_hook,
        ])
        .setup(|app| {
            // Perform the game hook check in a separate thread.
            tauri::async_runtime::spawn(check_and_perform_hook(app.handle()));

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
