// Prevents additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    collections::HashMap,
    fs::File,
    io::Write,
    sync::atomic::{AtomicBool, Ordering},
};

use anyhow::Context;
use gbfr_logs::toolbox_rpc::{self, HookStatus};
use gbfr_logs::{db, legality, overmastery, parser, settings_db, synthesis, transmarvel};

use db::logs::LogEntry;
#[cfg(windows)]
use dll_syringe::{process::OwnedProcess, Syringe};
#[cfg(windows)]
use interprocess::os::windows::named_pipe::tokio::RecvPipeStream;
use log::{error, info, LevelFilter};
use parser::{
    constants::{CharacterType, EnemyType},
    v1::{self, PlayerData},
};
use protocol::Message;
use rusqlite::params_from_iter;
use serde::{Deserialize, Serialize};
#[cfg(windows)]
use std::path::Path;
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

struct TrayLabels {
    open_meter: std::sync::Mutex<String>,
    open_logs: std::sync::Mutex<String>,
    always_on_top: std::sync::Mutex<String>,
    always_on_top_active: std::sync::Mutex<String>,
    clickthrough: std::sync::Mutex<String>,
    clickthrough_active: std::sync::Mutex<String>,
    reset_windows: std::sync::Mutex<String>,
    quit: std::sync::Mutex<String>,
}

impl Default for TrayLabels {
    fn default() -> Self {
        Self {
            open_meter: std::sync::Mutex::new("Open Meter".into()),
            open_logs: std::sync::Mutex::new("Open Logs".into()),
            always_on_top: std::sync::Mutex::new("Always on top".into()),
            always_on_top_active: std::sync::Mutex::new("Always on top \u{2713}".into()),
            clickthrough: std::sync::Mutex::new("Clickthrough".into()),
            clickthrough_active: std::sync::Mutex::new("Clickthrough \u{2713}".into()),
            reset_windows: std::sync::Mutex::new("Reset Windows".into()),
            quit: std::sync::Mutex::new("Quit".into()),
        }
    }
}

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

/// The meter's damage-source filters, shared between the settings UI and the
/// live parser.
///
/// `current` is read when a parser is constructed so it starts correct however
/// the startup order falls out; `tx` tells an already-running parser to adopt a
/// new value, reparse and re-emit, which is what makes toggling apply to the
/// fight in progress rather than only to hits from here on.
#[derive(Default)]
struct MeterFilterState {
    current: std::sync::Mutex<v1::MeterFilters>,
    tx: std::sync::Mutex<Option<tokio::sync::mpsc::UnboundedSender<v1::MeterFilters>>>,
}

#[tauri::command]
fn set_meter_filters(state: State<MeterFilterState>, filters: v1::MeterFilters) {
    {
        // A send costs the live parser a full replay of the fight so far, so an
        // unchanged value must not reach the channel. The frontend pushes on
        // mount as well as on change, which makes a redundant call the normal
        // case rather than the exceptional one.
        let mut current = state.current.lock().unwrap();
        if *current == filters {
            return;
        }
        *current = filters;
    }
    if let Some(tx) = state.tx.lock().unwrap().as_ref() {
        let _ = tx.send(filters);
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn update_tray_labels(
    app: AppHandle,
    labels: State<TrayLabels>,
    always_on_top_state: State<AlwaysOnTop>,
    clickthrough_state: State<ClickThrough>,
    open_meter: String,
    open_logs: String,
    always_on_top: String,
    always_on_top_active: String,
    clickthrough: String,
    clickthrough_active: String,
    reset_windows: String,
    reload_hook: String,
    quit: String,
) {
    let tray = app.tray_handle();

    let aot_active = always_on_top_state.0.load(Ordering::Acquire);
    let ct_active = clickthrough_state.0.load(Ordering::Acquire);

    // `get_item` panics when the id isn't in the menu (tauri `app/tray.rs`:
    // `panic!("item id not found")`). This runs on the main thread inside the
    // webview IPC callback, so such a panic would unwind across FFI. The
    // fallible variant makes a missing item a no-op — which is what lets us
    // set `reload_hook` unconditionally even though the item only exists
    // under `cfg(all(windows, debug_assertions))`.
    let set = |id: &str, title: &str| {
        if let Some(item) = tray.try_get_item(id) {
            let _ = item.set_title(title);
        }
    };

    let aot_title = if aot_active {
        &always_on_top_active
    } else {
        &always_on_top
    };
    let ct_title = if ct_active {
        &clickthrough_active
    } else {
        &clickthrough
    };

    set("open_meter", &open_meter);
    set("open_logs", &open_logs);
    set("always_on_top", aot_title);
    set("toggle_clickthrough", ct_title);
    set("reset_windows", &reset_windows);
    set("reload_hook", &reload_hook);
    set("quit", &quit);

    // Cached so the toggles can re-render the ✓/no-✓ variants without a round
    // trip to the frontend. `reload_hook` has no toggle state, so it isn't
    // stored.
    let store = |slot: &std::sync::Mutex<String>, value: String| {
        if let Ok(mut v) = slot.lock() {
            *v = value;
        }
    };

    store(&labels.open_meter, open_meter);
    store(&labels.open_logs, open_logs);
    store(&labels.always_on_top, always_on_top);
    store(&labels.always_on_top_active, always_on_top_active);
    store(&labels.clickthrough, clickthrough);
    store(&labels.clickthrough_active, clickthrough_active);
    store(&labels.reset_windows, reset_windows);
    store(&labels.quit, quit);
}

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

/// Compute and broadcast the current hook status to both windows. Called on
/// connect, disconnect, and around a refresh.
fn emit_hook_status(app: &AppHandle) {
    let snapshot = app.state::<HookStatus>().snapshot();
    let _ = app.emit_all("hook-status", &snapshot);
}

/// Re-run the handshake (with its retries) and broadcast the result. Shared by
/// the connect loop and the dev re-handshake so those two cannot drift; the
/// heartbeat folds through the same `apply_hello` but skips the retries (see
/// `hook_heartbeat`).
async fn handshake_and_apply(app: &AppHandle) {
    toolbox_rpc::handshake(&app.state::<HookStatus>()).await;
    emit_hook_status(app);
}

/// Periodic re-probe while the event stream is up.
///
/// The connect-time handshake is one shot, so without this ANY undelivered
/// handshake — a toolbox pipe that lost the startup race with the event pipe,
/// a busy pipe instance, a 2s timeout — pinned its verdict until the game
/// closed, because a fresh event-stream connection was the only other trigger.
/// One RPC per interval, and it only wakes the webviews when the derived
/// status actually changed.
///
/// Deliberately `hello` and not `handshake`: this loop IS the retry, so the
/// backoff ladder would only spend four RPCs (and up to ~10s) per tick to
/// reach the same verdict the next tick re-checks anyway.
/// Re-stat the hook DLL and publish the result if the derived status changed.
///
/// Antivirus quarantines this file (see `hook_dll`), and until it had a state
/// of its own the app reported the aftermath as "No game found" — the inject
/// error went to reload-debug.log and the UI claimed success regardless. Three
/// callers share this: startup (before the game is even running, when the user
/// can still act), the injection loop, and the heartbeat (which is what
/// notices a quarantine that happens mid-session). One `is_file` on a local
/// directory, so the heartbeat can afford it every tick.
#[cfg(windows)]
fn refresh_hook_dll_presence(app: &AppHandle) {
    let hook = app.state::<HookStatus>();
    let before = hook.snapshot();
    let found = gbfr_logs::hook_dll::injectable_hook();
    match &found {
        Some(path) => log::debug!("hook DLL present at {path:?}"),
        None => log::warn!(
            "no hook DLL in any of {:?} — almost always antivirus quarantine; \
             nothing can be injected until it is restored",
            gbfr_logs::hook_dll::search_dirs()
        ),
    }
    hook.dll_missing.store(found.is_none(), Ordering::Relaxed);
    if hook.snapshot() != before {
        emit_hook_status(app);
    }
}

async fn hook_heartbeat(app: AppHandle) {
    loop {
        tokio::time::sleep(toolbox_rpc::HEARTBEAT_INTERVAL).await;

        // Before the connected/gated early-out below: a quarantine that lands
        // while no game is running is exactly the case the user needs told,
        // and it is the case the RPC-only heartbeat could never see.
        #[cfg(windows)]
        refresh_hook_dll_presence(&app);

        let hook = app.state::<HookStatus>();
        // Nothing to ask when the stream is down. A teardown in flight is
        // EXPECTED to fail the RPC, so probing there would manufacture an
        // `Unresponsive` for a hook we are ourselves ejecting.
        if !hook.connected.load(Ordering::Relaxed) || hook.injection_gated() {
            continue;
        }

        let before = hook.snapshot();
        hook.apply_hello(toolbox_rpc::hello().await);
        if hook.snapshot() != before {
            emit_hook_status(&app);
        }
    }
}

#[tauri::command]
fn get_hook_status(hook: State<'_, HookStatus>) -> toolbox_rpc::HookStatusSnapshot {
    hook.snapshot()
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

/// Toolbox: current RNG state of one slot, for staleness polling against a
/// prediction's `slot_state`. Shared by the Overmastery Predictor and the
/// Transmarvel Wishlist (both predictions carry their `slot`). `None` = game
/// not running (staleness unknowable, not stale).
#[tauri::command(async)]
async fn fetch_rng_slot(slot: u32, hook: State<'_, HookStatus>) -> Result<Option<u32>, String> {
    Ok(toolbox_rpc::rng_slot(&hook, slot).await?.map(|s| s.state))
}

/// Toolbox / Transmarvel Searcher: is the game up and the RNG predictable.
#[tauri::command(async)]
async fn fetch_transmarvel_status(
    hook: State<'_, HookStatus>,
) -> Result<transmarvel::TransmarvelStatus, String> {
    match toolbox_rpc::rng_slot(&hook, transmarvel::TM_SLOT).await? {
        None => Ok(transmarvel::TransmarvelStatus {
            game_running: false,
            rng_unpredictable: false,
        }),
        Some(snap) => Ok(transmarvel::TransmarvelStatus {
            game_running: true,
            rng_unpredictable: snap.state == 0,
        }),
    }
}

/// Toolbox / Transmarvel Searcher: fresh RNG snapshot + simulate the next N
/// transmarvel rolls.
#[tauri::command(async)]
async fn predict_transmarvel(
    query: transmarvel::TransmarvelQuery,
    hook: State<'_, HookStatus>,
) -> Result<transmarvel::TransmarvelPrediction, String> {
    // Mirrors the frontend's MAX_ROLLS (TransmarvelSearcher.tsx).
    let rolls = query.rolls.min(50_000);
    let snap = toolbox_rpc::rng_slot(&hook, transmarvel::TM_SLOT)
        .await?
        .ok_or_else(|| "game-not-running".to_string())?;
    if snap.slot_override != u32::MAX {
        return Err("rng-override-active".to_string());
    }
    Ok(transmarvel::TransmarvelPrediction {
        rolls: transmarvel::simulate(snap.state, transmarvel::stock_tables(), rolls),
        slot: transmarvel::TM_SLOT,
        slot_state: snap.state,
        unpredictable: snap.state == 0,
    })
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

/// Broadcast on every settings write so the other window can catch up.
/// `value` is `None` for a deletion. `origin` is filled in from the calling
/// window, never from the frontend, so a window cannot misreport it and
/// swallow its own real changes.
#[derive(Clone, serde::Serialize)]
struct SettingsChanged {
    key: String,
    value: Option<String>,
    origin: String,
}

const SETTINGS_CHANGED_EVENT: &str = "settings-changed";

/// Tell the *other* windows a setting changed.
///
/// Only ever called for a write that changed something. A window that hears a
/// change rehydrates, and zustand's rehydrate writes back through the same
/// adapter, so announcing a write that changed nothing is what would let two
/// windows echo each other without end. The originating window is filtered out
/// because it already has the value; the frontend drops its own `origin` too,
/// as defence in depth.
fn announce(window: &tauri::Window, key: String, value: Option<String>) {
    let origin = window.label().to_string();
    let payload = SettingsChanged {
        key,
        value,
        origin: origin.clone(),
    };

    let _ = window
        .app_handle()
        .emit_filter(SETTINGS_CHANGED_EVENT, payload, |w| w.label() != origin);
}

#[tauri::command]
fn get_settings() -> Result<std::collections::HashMap<String, String>, String> {
    settings_db::read_all().map_err(|e| e.to_string())
}

#[tauri::command]
fn set_setting(window: tauri::Window, key: String, value: String) -> Result<(), String> {
    if settings_db::write(&key, &value).map_err(|e| e.to_string())? {
        announce(&window, key, Some(value));
    }
    Ok(())
}

#[tauri::command]
fn delete_setting(window: tauri::Window, key: String) -> Result<(), String> {
    if settings_db::remove(&key).map_err(|e| e.to_string())? {
        announce(&window, key, None);
    }
    Ok(())
}

/// The dialog every settings/logs database import and export starts from.
fn db_file_dialog(title: &str) -> tauri::api::dialog::blocking::FileDialogBuilder {
    tauri::api::dialog::blocking::FileDialogBuilder::new()
        .set_title(title)
        .add_filter("SQLite database", &["db"])
}

/// One save dialog for a whole-database export: pick a path, clear any
/// existing file (`VACUUM INTO` refuses to overwrite, and the dialog already
/// asked), then run `export`. `None` when the dialog is cancelled.
fn export_db_via_dialog(
    file_name: &str,
    export: impl FnOnce(&std::path::Path) -> Result<(), String>,
) -> Result<Option<String>, String> {
    let Some(path) = db_file_dialog(&format!("Export {file_name}"))
        .set_file_name(file_name)
        .save_file()
    else {
        return Ok(None);
    };

    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }

    export(&path)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Save a copy of the settings store wherever the user picks. `None` when the
/// save dialog is cancelled.
#[tauri::command]
async fn export_settings_db() -> Result<Option<String>, String> {
    export_db_via_dialog("settings.db", |path| {
        settings_db::export_to(path).map_err(|e| e.to_string())
    })
}

/// Native file picker for a settings database to import. `None` means the
/// user cancelled. Async so the blocking dialog runs off the main thread.
#[tauri::command]
async fn pick_settings_db_file() -> Option<String> {
    db_file_dialog("Select the settings.db to import")
        .pick_file()
        .map(|path| path.to_string_lossy().into_owned())
}

/// Overwrite our settings with the rows of the settings database at `path`
/// (from [`pick_settings_db_file`]). Returns how many settings actually
/// changed.
///
/// Each changed key is announced on the normal settings-changed channel with a
/// non-window `origin`, so EVERY window — including the one that invoked this —
/// applies the imported values live.
#[tauri::command]
async fn import_settings_from_file(app: tauri::AppHandle, path: String) -> Result<u32, String> {
    let changed =
        settings_db::import_from(std::path::Path::new(&path)).map_err(|e| e.to_string())?;
    let count = changed.len() as u32;
    for (key, value) in changed {
        let _ = app.emit_all(
            SETTINGS_CHANGED_EVENT,
            SettingsChanged {
                key,
                value: Some(value),
                origin: "settings-import".into(),
            },
        );
    }
    Ok(count)
}

/// Emitted after every stored setting has been deleted. Windows respond by
/// dropping the listed keys from their caches and reloading — a reload rather
/// than a rehydrate, because rehydrating a store from a missing key leaves its
/// in-memory state as it was; only a fresh boot lands on the defaults.
#[derive(Clone, Serialize)]
struct SettingsReset {
    keys: Vec<String>,
}

const SETTINGS_RESET_EVENT: &str = "settings-reset";

/// Delete every stored setting and tell all windows to reload on defaults.
#[tauri::command]
async fn reset_settings_to_default(app: tauri::AppHandle) -> Result<(), String> {
    let keys = settings_db::reset_all().map_err(|e| e.to_string())?;
    let _ = app.emit_all(SETTINGS_RESET_EVENT, SettingsReset { keys });
    Ok(())
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

/// Native file picker for another installation's logs.db. `None` means the
/// user cancelled. Async so the blocking dialog runs off the main thread.
#[tauri::command]
async fn pick_logs_db_file() -> Option<String> {
    let dialog = db_file_dialog("Select the logs.db to import");

    // Start in the install this importer exists for when it's present,
    // otherwise fall back to Program Files, where installs live.
    #[cfg(windows)]
    let dialog = {
        let program_files = std::env::var_os("ProgramFiles").map(std::path::PathBuf::from);
        let start = program_files
            .as_ref()
            .map(|dir| dir.join("GBFR Logs Awa Edition"))
            .filter(|dir| dir.exists())
            .or_else(|| program_files.filter(|dir| dir.exists()));
        match start {
            Some(dir) => dialog.set_directory(dir),
            None => dialog,
        }
    };

    dialog
        .pick_file()
        .map(|path| path.to_string_lossy().into_owned())
}

/// Payload of the `import-progress` event both [`analyze_logs_db`] and
/// [`import_logs_from_file`] emit while working through a source logs.db.
#[derive(Clone, Serialize)]
struct ImportProgressPayload {
    processed: u32,
    total: u32,
}

/// A progress callback that emits `import-progress` to `window`, throttled to
/// 0.1% steps so a large source doesn't flood the webview with events. Both
/// passes report `(rows examined, total rows)`, so one emitter serves both.
fn import_progress_emitter(window: tauri::Window) -> impl FnMut(u32, u32) {
    let mut last_emitted: Option<u32> = None;
    move |processed, total| {
        let step = (total / 1000).max(1);
        let due = match last_emitted {
            None => true,
            Some(last) => processed >= last + step || processed == total,
        };
        if due {
            last_emitted = Some(processed);
            let _ = window.emit(
                "import-progress",
                ImportProgressPayload { processed, total },
            );
        }
    }
}

/// Dry-run a logs.db import: what would come across, and what data those logs
/// actually carry. Decoding every blob is real CPU time, so it runs on a
/// blocking thread rather than tying up an async-runtime worker the other
/// commands and event emission share; progress goes to the invoking window as
/// `import-progress` events.
#[tauri::command]
async fn analyze_logs_db(
    window: tauri::Window,
    path: String,
) -> Result<db::import::ImportAnalysis, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db::connect_to_db().map_err(|e| e.to_string())?;
        db::import::analyze_logs_db_file(
            &conn,
            std::path::Path::new(&path),
            import_progress_emitter(window),
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Merge the logs.db at `path` (from [`pick_logs_db_file`]) into ours, on a
/// blocking thread for the same reason as [`analyze_logs_db`]. Progress goes
/// to the invoking window as `import-progress` events.
#[tauri::command]
async fn import_logs_from_file(
    app: tauri::AppHandle,
    window: tauri::Window,
    path: String,
) -> Result<db::import::ImportSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db::connect_to_db().map_err(|e| e.to_string())?;
        let summary = db::import::import_logs_from_file(
            &conn,
            std::path::Path::new(&path),
            import_progress_emitter(window),
        )
        .map_err(|e| e.to_string())?;

        // Imported rows arrive unstamped; judge them now rather than making the
        // cheat audit wait for the next launch. Same background sweep as startup,
        // so the audit page's progress banner covers this pass too.
        if summary.imported > 0 {
            std::thread::spawn(move || sweep_stale_legality(&app));
        }

        Ok(summary)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// How many logs arrived via the importer — what [`delete_imported_logs`]
/// would delete, so the confirmation dialog can say so.
#[tauri::command]
async fn count_imported_logs() -> Result<u32, String> {
    let conn = db::connect_to_db().map_err(|e| e.to_string())?;
    conn.query_row("SELECT COUNT(*) FROM logs WHERE imported = 1", [], |r| {
        r.get(0)
    })
    .map_err(|e| e.to_string())
}

/// Delete every log that arrived via the importer, returning how many went.
/// Logs recorded by this installation are untouched.
#[tauri::command]
async fn delete_imported_logs() -> Result<u32, String> {
    let conn = db::connect_to_db().map_err(|e| e.to_string())?;
    let deleted = conn
        .execute("DELETE FROM logs WHERE imported = 1", [])
        .map_err(|e| e.to_string())?;
    // Verdicts go with their logs — see delete_logs.
    db::legality::sweep_orphaned_findings(&conn).map_err(|e| e.to_string())?;
    Ok(deleted as u32)
}

/// Save a copy of the whole log store wherever the user picks. `None` when
/// the save dialog is cancelled.
#[tauri::command]
async fn export_logs_db() -> Result<Option<String>, String> {
    export_db_via_dialog("logs.db", |path| {
        let conn = db::connect_to_db().map_err(|e| e.to_string())?;
        db::export_to(&conn, path).map_err(|e| e.to_string())
    })
}

#[tauri::command]
async fn delete_all_logs() -> Result<(), String> {
    let conn = db::connect_to_db().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM logs", [])
        .map_err(|e| e.to_string())?;
    // Verdicts go with their logs — see delete_logs.
    db::legality::sweep_orphaned_findings(&conn).map_err(|e| e.to_string())?;
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

            // Unlike the meter paths this walks the raw log directly rather than
            // reparsing, so the filter has to be applied here by hand — an
            // export is meant to be what the view shows, and a CSV that still
            // contained rows the table excluded would not add up to it.
            if inside_window
                && !v1::is_excluded(damage_event, &options.filters)
                && v1::target_selected(timestamp, damage_event, &options.target_spans)
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
    /// Stored legality verdicts for the logs on this page, keyed by log id.
    /// Sent with the page rather than fetched separately so a row and its
    /// verdicts can never be a render apart — and only for the ten rows drawn,
    /// not the whole table the audit page reads. Logs nobody was flagged in are
    /// absent; the quest list reads a miss as clean.
    legality: HashMap<i64, Vec<db::legality::StoredFinding>>,
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
    flagged_only: Option<bool>,
) -> Result<SearchResult, String> {
    // Absent means "no legality filter" — the quest list only ever asks for the
    // flagged runs or for all of them.
    let flagged_only = flagged_only.unwrap_or(false);
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

    let filters = db::logs::LogFilters {
        enemy_id: filter_by_enemy_id,
        quest_id: filter_by_quest_id,
        cleared: quest_completed,
        player_id: &filter_by_player_id,
        player_character: &filter_by_player_character,
        flagged_only,
    };

    let logs = db::logs::get_logs(
        &conn,
        &filters,
        per_page,
        offset,
        &sort_type_param,
        &sort_direction_param,
    )
    .map_err(|e| e.to_string())?;

    let counts = db::logs::get_counts(&conn, &filters).map_err(|e| e.to_string())?;
    let log_count = counts.logs;

    let page_ids: Vec<i64> = logs.iter().map(|log| log.id()).collect();
    let legality = db::legality::findings_for_logs(&conn, &page_ids).map_err(|e| e.to_string())?;

    // Pages hold a fixed number of CHAINS, not of rows, so a Repeat Quest chain
    // is never cut across a page boundary — see `page_chain_keys`. `log_count`
    // stays the run count: it is the "N saved" figure, which is about the logs.
    let page_count = (counts.chains as f64 / per_page as f64).ceil() as u32;

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
        legality,
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

/// How far the startup legality sweep has got, for the audit page's banner.
/// `done == total` means it has finished.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct LegalitySweepProgress {
    done: usize,
    total: usize,
}

/// Re-audits every log the current rules have not judged, reporting progress to
/// the logs window.
///
/// Errors are logged, never surfaced: a sweep that fails leaves the stored
/// findings exactly as they were, and the next launch tries again. It must not
/// be able to take the app down with it.
fn sweep_stale_legality(app: &tauri::AppHandle) {
    let mut conn = match db::connect_to_db() {
        Ok(conn) => conn,
        Err(error) => {
            log::warn!("legality sweep: could not open the database: {error:#}");
            return;
        }
    };

    // Emitted at most once a second: a 692-log sweep would otherwise push
    // hundreds of events at a window that only renders a percentage.
    let mut last_emit = std::time::Instant::now();
    let result = legality::sweep::sweep_stale_logs(&mut conn, |progress| {
        let finished = progress.done == progress.total;
        if finished || last_emit.elapsed() >= std::time::Duration::from_secs(1) {
            last_emit = std::time::Instant::now();
            let _ = app.emit_to(
                "logs",
                "legality-sweep-progress",
                LegalitySweepProgress {
                    done: progress.done,
                    total: progress.total,
                },
            );
        }
    });

    match result {
        Ok(outcome) if outcome.rescanned > 0 || outcome.unreadable > 0 || outcome.skipped > 0 => {
            info!(
                "legality sweep: re-audited {} logs ({} unreadable, {} older than the audit cutoff)",
                outcome.rescanned, outcome.unreadable, outcome.skipped
            );
        }
        Ok(_) => {}
        Err(error) => log::warn!("legality sweep failed: {error:#}"),
    }
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
    /// Copied in from another installation's logs.db, so it may lack data the
    /// source app never recorded — the detail view marks it.
    imported: bool,
    /// Stored build-legality findings, one vector per party slot so it lines up
    /// with `players` by index. Read from the table rather than recomputed:
    /// the startup sweep keeps them current, and opening a log must not pay
    /// for an audit.
    legality: [Vec<legality::Finding>; 4],
    /// Per-spawn selectable targets for the filter dropdown, in first-hit
    /// order — 1:1 with the HP chart's series (same instance numbers).
    target_entries: Vec<v1::TargetSegment>,
    /// Every distinct (source, target, ability) combination inside the current
    /// window, with the selector pins NOT applied — the analysis view cascades
    /// its three selectors from this without a round trip per keystroke.
    selection_facts: Vec<v1::SelectionFact>,
    /// The analysis view's drill-down chart, present only on a scoped fetch that
    /// pinned a source: what that player's damage was made of, one band per
    /// breakdown row. Empty at every other level — with nothing pinned the
    /// per-player `dps_chart` already answers.
    ability_chart: Vec<v1::AbilityChartSeries>,
    /// The drill-down chart one level further in: with a source AND an ability
    /// pinned, what that ability hit, one band per enemy spawn.
    target_chart: Vec<v1::TargetChartSeries>,
    /// Every window an actor held a status effect for, per actor and never
    /// merged, spanning the FULL fight. The Buffs and Debuffs tables compute
    /// their own uptime from these, so a scrub window narrows the view without
    /// another round trip. Empty on logs recorded before status capture.
    status_intervals: Vec<v1::StatusInterval>,
    dps_chart: HashMap<u32, Vec<i32>>,
    /// Stun applied per DPS-chart bucket. Separate from `dps_chart` because
    /// stun reconciles two capture paths with max(), not a sum — see
    /// `build_player_stun_chart`.
    stun_chart: HashMap<u32, Vec<f64>>,
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
    /// Which contested damage sources to count (see [`v1::MeterFilters`]).
    /// Absent means the default, which excludes: a caller that has not opted in
    /// must never silently get contested damage folded into its totals.
    #[serde(default)]
    filters: v1::MeterFilters,
    /// Which source actors and abilities the selector bar has pinned. Absent or
    /// empty means "All" on every dimension — the shipped default.
    #[serde(default)]
    selection: v1::SelectionFilter,
}

// Per-second buckets: the quest-details charts and the window scrubber both
// work in whole seconds, so a bucket index IS the elapsed second.
const DPS_INTERVAL: i64 = 1_000;
const SBA_INTERVAL: i64 = 1_000;

/// The analysis view's drill-down chart series for the current pins.
///
/// The chart follows the row level, so what it decomposes is decided entirely by
/// what is pinned: a source alone means "what was this player's damage made
/// of", a source and an ability means "what did this ability hit". Nothing
/// pinned needs no series at all — that level is the per-player `dps_chart` the
/// base load already carries — so both come back empty and the caller pays
/// nothing for a fetch that only moved the window.
///
/// Only the FIRST pinned source and ability are read: the selector bar pins one
/// of each, and a chart that stacked two players' abilities together would have
/// no meaningful total.
///
/// `segments`/`assignment` are the caller's segmentation of the UNWINDOWED log,
/// passed in rather than recomputed: the caller already needs it for
/// `selection_facts`, and segmenting twice per fetch is two more full passes
/// over a log that can hold hundreds of thousands of events. Sharing it is also
/// what makes a band and a target-dropdown entry mean the same spawn.
fn build_drill_charts(
    parser: &v1::Parser,
    options: &ParseOptions,
    segments: &[v1::TargetSegment],
    assignment: &[Option<usize>],
) -> (Vec<v1::AbilityChartSeries>, Vec<v1::TargetChartSeries>) {
    let Some(&source_index) = options.selection.source_indices.first() else {
        return (Vec::new(), Vec::new());
    };

    let start_time = parser.start_time();
    // Whole-fight geometry, so a bucket index is still the elapsed second no
    // matter what window the same fetch applied to the derived state.
    let chart_len = (parser.full_log_duration() / DPS_INTERVAL) as usize + 1;

    match options.selection.abilities.first() {
        Some(&ability) => {
            let target_chart = v1::build_target_damage_chart(
                &parser.encounter.raw_event_log,
                &parser.encounter.player_data,
                segments,
                assignment,
                source_index,
                ability,
                start_time,
                DPS_INTERVAL,
                chart_len,
                &options.target_spans,
                options.filters,
            );
            (Vec::new(), target_chart)
        }
        None => {
            let ability_chart = v1::build_ability_damage_chart(
                &parser.encounter.raw_event_log,
                &parser.encounter.player_data,
                source_index,
                start_time,
                DPS_INTERVAL,
                chart_len,
                &options.target_spans,
                options.filters,
            );
            (ability_chart, Vec::new())
        }
    }
}

/// The per-player damage chart for a scope with NO source pinned.
///
/// The base-load `dps_chart` is built with no pins at all, so an enemy or
/// ability pin left the plot showing the whole fight while the table beside it
/// had narrowed — measured on log 1566, where pinning one enemy halved the
/// table's totals and did not move a single line.
///
/// Empty with a source pinned: [`build_drill_charts`] already answers there, and
/// its bands are target-filtered. Empty with nothing narrowing, so a fetch that
/// only moved the window pays nothing.
///
/// Damage only, by construction — this is the damage tab's series. Stun's two
/// capture paths reconcile with `max()` and its network messages carry no target
/// at all, so a target-filtered stun chart would be a fiction; the SBA gauge has
/// no decomposition.
fn build_scoped_player_chart(
    parser: &v1::Parser,
    options: &ParseOptions,
) -> HashMap<u32, Vec<i32>> {
    if !options.selection.source_indices.is_empty()
        || (options.target_spans.is_empty() && options.selection.abilities.is_empty())
    {
        return HashMap::new();
    }

    let player_indices: Vec<u32> = parser
        .derived_state
        .party
        .values()
        .map(|player| player.index)
        .collect();

    // Whole-fight geometry, exactly as `build_drill_charts` uses: the view slices
    // its chart client-side, so a bucket index must stay the elapsed second.
    let chart_len = (parser.full_log_duration() / DPS_INTERVAL) as usize + 1;

    v1::build_player_dps_chart(
        &parser.encounter.raw_event_log,
        &parser.encounter.player_data,
        &player_indices,
        parser.start_time(),
        DPS_INTERVAL,
        chart_len,
        &options.target_spans,
        &options.selection.abilities,
        options.filters,
    )
}

// `(async)` so the decompress + full reparse runs off the main thread — this is
// called on every log open, filter change, and brush release.
#[tauri::command(async)]
fn fetch_encounter_state(id: u64, options: ParseOptions) -> Result<EncounterStateResponse, String> {
    let conn = db::connect_to_db().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT data, version, room_index, imported FROM logs WHERE id = ?")
        .map_err(|e| e.to_string())?;

    let (blob, version, room_index, imported): (Vec<u8>, u8, Option<u32>, bool) = stmt
        .query_row([id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .map_err(|e| e.to_string())?;

    // Regrouped from the flat stored rows into one vector per party slot, so
    // the response lines up with `players` by index. A log the sweep has not
    // reached yet simply has no rows and reads as clean, which is the honest
    // answer until it has been judged.
    let mut findings: [Vec<legality::Finding>; 4] = Default::default();
    match db::legality::findings_for_log(&conn, id as i64) {
        Ok(stored) => {
            for row in stored {
                if let Some(slot) = findings.get_mut(row.player_index) {
                    slot.push(row.finding);
                }
            }
        }
        // Never fatal: a log still opens without its verdicts.
        Err(error) => log::warn!("could not read legality findings for log {id}: {error:#}"),
    }

    // @TODO(false): If we deserialize from an older version, we should save it back into the DB as the newer format.
    let mut parser = parser::deserialize_version(&blob, version).map_err(|e| e.to_string())?;

    parser.filters = options.filters;
    parser.selection = options.selection.clone();
    parser.reparse_with_options_window(&options.target_spans, options.from_ms, options.up_to_ms);

    if options.state_only {
        // Included even here, unlike the charts: it is one pass over the events
        // with no buffers to build, and the analysis view's selectors have to
        // re-cascade against the new window on the very fetch that applies it.
        // The segmentation is over the UNWINDOWED log, exactly as the base load
        // computes `target_entries` — a fact's `target_segment` indexes into
        // those, so the two must be the same segmentation or a pin would point
        // at a different enemy on a scoped fetch than on the load.
        let (segments, assignment) =
            v1::segment_targets_indexed(&parser.encounter.raw_event_log, parser.start_time());
        let selection_facts = v1::selection_facts(
            &parser.encounter.raw_event_log,
            parser.start_time(),
            options.from_ms,
            options.up_to_ms,
            &assignment,
        );

        // The drill-down chart. Built here rather than on the base load because
        // it is the pins that decide what it decomposes, and only a pinned
        // source narrows it enough to be worth sending: the unpinned case is
        // the per-player `dps_chart` the base load already carries.
        //
        // Deliberately spans the FULL fight, ignoring `from_ms`/`up_to_ms`: the
        // view slices its chart client-side from whole-fight buckets, so a
        // pre-sliced series would be windowed twice and a bucket index would
        // stop being the elapsed second.
        let (ability_chart, target_chart) =
            build_drill_charts(&parser, &options, &segments, &assignment);
        // The level above those: no source pinned, but an enemy or an ability
        // still narrowing the fight. Without it the plot kept drawing the whole
        // party's whole fight beside a table that had already narrowed.
        let dps_chart = build_scoped_player_chart(&parser, &options);

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
            imported,
            legality: findings,
            selection_facts,
            ability_chart,
            target_chart,
            dps_chart,
            ..Default::default()
        });
    }

    // Chart buffers span the FULL fight even when a scrub cutoff truncates the
    // derived state — the chart-building loops below walk the full event log, so
    // sizing from the truncated duration would index out of bounds.
    let duration = parser.full_log_duration();

    let start_time = parser.start_time();
    // Dropdown entries are ALWAYS the unfiltered segmentation — the user picks
    // from everything the fight contained, whatever is currently selected.
    // Indexed, because a `SelectionFact` names the SEGMENT it hit rather than
    // the game's actor index (which is recycled between bosses) — and those
    // indices are into this very vector, which ships as `target_entries`.
    let (target_entries, assignment) =
        v1::segment_targets_indexed(&parser.encounter.raw_event_log, start_time);
    // Windowed, but never narrowed by the pins themselves: each selector must
    // keep offering everything the OTHER pins still allow.
    let selection_facts = v1::selection_facts(
        &parser.encounter.raw_event_log,
        start_time,
        options.from_ms,
        options.up_to_ms,
        &assignment,
    );

    let player_indices: Vec<u32> = parser
        .derived_state
        .party
        .values()
        .map(|player| player.index)
        .collect();
    let player_dps = v1::build_player_dps_chart(
        &parser.encounter.raw_event_log,
        &parser.encounter.player_data,
        &player_indices,
        start_time,
        DPS_INTERVAL,
        (duration / DPS_INTERVAL) as usize + 1,
        &options.target_spans,
        &options.selection.abilities,
        options.filters,
    );
    let player_stun = v1::build_player_stun_chart(
        &parser.encounter.raw_event_log,
        &parser.encounter.player_data,
        &player_indices,
        start_time,
        DPS_INTERVAL,
        (duration / DPS_INTERVAL) as usize + 1,
        &options.target_spans,
        options.filters,
    );

    let hp_chart = v1::build_target_hp_charts(
        &parser.encounter.raw_event_log,
        &target_entries,
        start_time,
        DPS_INTERVAL,
        (duration / DPS_INTERVAL) as usize + 1,
        &options.target_spans,
    );

    // Closed against the end of the full log, not the scrub window: an interval
    // still open at the last event runs to the end of the fight, and closing it
    // at a window edge instead would report a buff as having dropped there.
    // Segmented against the same `target_entries` the response ships, so a
    // debuff row names the SPAWN that held it. Without it a recycled boss id
    // merged two enemies' windows into one row labelled with a bare number.
    let status_intervals = v1::assemble_intervals(
        &parser.encounter.raw_event_log,
        start_time,
        duration,
        &target_entries,
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
        imported,
        legality: findings,
        // Nothing to decompose on the base load: it is the unpinned fight, which
        // is exactly the level `dps_chart` already draws.
        ability_chart: Vec::new(),
        target_chart: Vec::new(),
        status_intervals,
        dps_chart: player_dps,
        stun_chart: player_stun,
        hp_chart,
        chart_len: (duration / DPS_INTERVAL) as usize + 1,
        sba_chart_len: (duration / SBA_INTERVAL) as usize + 1,
        sba_chart,
        sba_events,
        death_events,
        target_entries,
        selection_facts,
    })
}

/// Every flagged player across the whole database, for the Toolbox audit page.
///
/// Reads stored verdicts, so this is a join and a group rather than a re-audit
/// of every log. `(async)` regardless: it still walks every finding.
#[tauri::command(async)]
fn fetch_legality_players() -> Result<Vec<db::legality::FlaggedPlayer>, String> {
    let conn = db::connect_to_db().map_err(|e| e.to_string())?;
    db::legality::flagged_players(&conn).map_err(|e| e.to_string())
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

    // Verdicts go with their logs: an orphaned finding would attach itself to
    // whatever future encounter lands on the recycled rowid.
    db::legality::sweep_orphaned_findings(&conn).map_err(|e| e.to_string())?;

    // A deleted log may have been a Conflux room; reap any run left with no rooms so it
    // doesn't linger as a ghost "×0 rooms" row (the startup sweep only reaps in-progress
    // runs).
    db::runs::delete_runs_without_rooms(&conn).map_err(|e| e.to_string())?;

    Ok(())
}

/// Dev reload diagnostics that land in a file we can always read, regardless of
/// the app's log level/target: `%APPDATA%\gbfr-logs\reload-debug.log`, next to
/// the hook's own gbfr-logs.txt. Also mirrors to the normal `info!` sink. The
/// file write happens only in debug builds; release still gets the `info!`.
#[cfg(windows)]
fn reload_dbg(msg: &str) {
    info!("{msg}");
    #[cfg(debug_assertions)]
    {
        use std::io::Write;
        let line = format!(
            "[{}] {msg}\n",
            chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f")
        );
        // Best-effort: a logging hiccup must never disrupt the reload flow.
        if let Some(path) = tauri::api::path::data_dir() {
            let path = path.join("gbfr-logs").join("reload-debug.log");
            if let Ok(mut f) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
            {
                let _ = f.write_all(line.as_bytes());
            }
        }
    }
}

/// The hook module currently mapped in the target, preferring the dev
/// `hook-dbg.dll` over the release `hook.dll` (only one is ever present).
#[cfg(windows)]
fn find_hook_module(
    syringe: &Syringe,
) -> std::io::Result<
    Option<dll_syringe::process::ProcessModule<dll_syringe::process::BorrowedProcess<'_>>>,
> {
    use dll_syringe::process::Process as _;
    let process = syringe.process();
    // A hook-dbg.dll lookup error falls through to hook.dll rather than
    // propagating: a transient module-enumeration error must not read as "no
    // hook present" (that would drive a redundant re-inject over a live hook —
    // refcount bump, stale mapping reused). hook.dll's own error still
    // propagates so eject_hook_until_gone can surface a real failure.
    if let Ok(Some(m)) = process.find_module_by_name("hook-dbg.dll") {
        return Ok(Some(m));
    }
    process.find_module_by_name("hook.dll")
}

/// FreeLibrary the injected hook module until it is genuinely unmapped — not
/// just once.
///
/// `syringe.inject()` is `LoadLibrary`, and Windows runs a DLL's `#[ctor]`
/// (`DllMain` attach) ONLY on the first load into a process; a later
/// `LoadLibrary` of an already-mapped module just bumps its refcount and
/// returns the existing handle WITHOUT re-running the ctor. So a hook module
/// left mapped (refcount > 1 from reconnect re-injections, or a prior session's
/// module that outlived a single FreeLibrary) gets reused on the next inject as
/// a dead hook: no ctor, no event pipe, no control pipe. Ejecting until
/// `find_module_by_name` reports it gone guarantees the next inject is a true
/// fresh load. Bounded so a module that refuses to unmap surfaces as an error
/// instead of looping forever.
#[cfg(windows)]
fn eject_hook_until_gone(syringe: &Syringe) -> anyhow::Result<u32> {
    // dll_syringe::eject runs FreeLibrary (decrementing the refcount) and
    // returns Ok, but then a `debug_assert!(..., "ejected module survived")`
    // panics in debug builds when the module is STILL mapped afterward (i.e.
    // the refcount was > 1). The FreeLibrary already happened by that point, so
    // we catch that specific panic and loop — each pass drops one refcount
    // until the module is genuinely unmapped, at which point eject returns Ok
    // without panicking. This drains a legacy refcount left by pre-fix reconnect
    // re-injections; steady-state refcount is 1, so no panic occurs then.
    //
    // Silence the intentional panics' console noise for the duration (restored
    // right after). The window is brief and only during (re)injection.
    let prev_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let result = (|| -> anyhow::Result<u32> {
        let mut ejected = 0u32;
        for _ in 0..64 {
            let Some(module) = find_hook_module(syringe)? else {
                return Ok(ejected);
            };
            match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| syringe.eject(module))) {
                // Clean unload (module gone → debug_assert passed).
                Ok(Ok(())) => ejected += 1,
                // A real eject error (not the survival assert): give up.
                Ok(Err(e)) => return Err(anyhow::Error::new(e).context("FreeLibrary of the hook")),
                // "ejected module survived": FreeLibrary ran, refcount still > 0.
                Err(_) => ejected += 1,
            }
        }
        anyhow::bail!("hook module still mapped after 64 FreeLibrary attempts")
    })();
    std::panic::set_hook(prev_hook);
    result
}

/// Is a hook module (`hook-dbg.dll` or `hook.dll`) currently mapped in the
/// target process? Used to avoid a second inject (LoadLibrary would just bump
/// the refcount without re-running the ctor) and, more importantly, to avoid
/// FreeLibrary'ing a live hook — see check_and_perform_hook.
#[cfg(windows)]
fn hook_module_present(syringe: &Syringe) -> bool {
    matches!(find_hook_module(syringe), Ok(Some(_)))
}

// Continuously check for the game process and inject the DLL when found.
#[cfg(windows)]
async fn check_and_perform_hook(app: AppHandle) {
    reload_dbg("check_and_perform_hook: (re)entered, polling for game process");
    loop {
        // Hook reload/refresh in flight: the old module must be ejected (and,
        // for a dev reload, hook-dbg.dll refreshed) before we may inject again.
        {
            let hook = app.state::<HookStatus>();
            let mut waits: u32 = 0;
            while hook.injection_gated() {
                // Log the first wait + periodically: dev_hold_out is designed
                // to hold indefinitely (see its doc comment), so a one-shot
                // log here would leave a long hold invisible in
                // reload-debug.log — exactly where a stranded session should
                // leave a breadcrumb.
                if waits == 0 || waits % 50 == 0 {
                    reload_dbg(&format!(
                        "check_and_perform_hook: gate SET, waiting (reloading={}, dev_hold_out={})",
                        hook.reloading.load(Ordering::Relaxed),
                        hook.dev_hold_out.load(Ordering::Relaxed)
                    ));
                }
                waits += 1;
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
            if waits > 0 {
                reload_dbg("check_and_perform_hook: gate CLEARED, proceeding");
            }
        }

        match OwnedProcess::find_first_by_name(gbfr_logs::game_mem::GAME_EXE) {
            Some(target) => {
                // `Syringe` is !Send, so nothing may await while it is alive —
                // hence this sync block, which decides and then drops it. The
                // retry sleeps happen outside, after `ready` comes back false.
                let ready = {
                    let syringe = Syringe::for_process(target);

                    // If a hook is ALREADY mapped, do not inject again and NEVER
                    // FreeLibrary it here. A live hook has detours installed and game
                    // threads running through its trampolines; unmapping it out from
                    // under them crashes the game (AccessViolation). A second inject
                    // would only bump the refcount without re-running the ctor
                    // (LoadLibrary runs it once). The only safe teardown of a live
                    // hook is the graceful control-channel path in reload_hook_inner,
                    // which disables the detours and fully unmaps BEFORE we get here —
                    // so a real reload arrives with nothing mapped and injects below.
                    // A hook already present is therefore either that live hook (from
                    // a prior app session) or an abnormally dead one: in both cases we
                    // just (re)connect and let the pipe tell us which.
                    if hook_module_present(&syringe) {
                        reload_dbg(
                            "check_and_perform_hook: a hook is already mapped; connecting without re-inject (never FreeLibrary a live hook)",
                        );
                        true
                    } else {
                        // Stat before injecting: a quarantined DLL is the
                        // common failure here, and it deserves a named state
                        // rather than an inject error nobody reads. Keep
                        // polling — restoring the file then self-heals
                        // without an app restart.
                        refresh_hook_dll_presence(&app);
                        match gbfr_logs::hook_dll::injectable_hook() {
                            None => {
                                reload_dbg(
                                    "check_and_perform_hook: game found but NO hook DLL on disk; \
                                     not injecting (see the hook status badge)",
                                );
                                false
                            }
                            Some(dll_path) => {
                                reload_dbg(&format!(
                                    "check_and_perform_hook: game found, injecting {dll_path:?}"
                                ));
                                match syringe.inject(&dll_path) {
                                    Ok(module) => {
                                        reload_dbg(&format!(
                                            "check_and_perform_hook: inject OK ({dll_path:?} -> {module:?})"
                                        ));
                                        true
                                    }
                                    // Used to fall through to the "Found
                                    // game.." toast below and then wait on a
                                    // pipe nothing would ever serve. Say so
                                    // and retry instead.
                                    Err(e) => {
                                        reload_dbg(&format!(
                                            "check_and_perform_hook: inject FAILED for {dll_path:?}: {e:?}"
                                        ));
                                        log::error!(
                                            "hook injection failed for {dll_path:?}: {e:?}"
                                        );
                                        let _ = app.emit_all(
                                            "error-alert",
                                            format!("Hook injection failed: {e}"),
                                        );
                                        false
                                    }
                                }
                            }
                        }
                    }
                };

                if !ready {
                    tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
                    continue;
                }
                let _ = app.emit_all("success-alert", "Found game..");

                connect_and_run_parser(app);
                reload_dbg("check_and_perform_hook: connect_and_run_parser spawned; loop exiting");

                break;
            }
            None => {
                tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
            }
        }
    }
}

/// Dev-only hook hot-reload: ask the running hook to tear itself down, eject
/// the dead module, refresh hook-dbg.dll from the cargo artifact, and let
/// the standard reconnect loop re-inject. See
/// docs/superpowers/specs/2026-07-23-dev-hook-hot-reload-design.md.
#[cfg(all(windows, debug_assertions))]
async fn reload_hook(app: AppHandle) {
    if app
        .state::<HookStatus>()
        .reloading
        .swap(true, Ordering::SeqCst)
    {
        return; // a reload is already in flight
    }
    // Same rule as refresh_hook: asking for a reload means asking for a working
    // hook, so a debug hold-out left set must not survive it and block the
    // re-inject that ends this flow.
    app.state::<HookStatus>()
        .dev_hold_out
        .store(false, Ordering::Relaxed);
    reload_dbg("reload_hook: START (reloading gate set)");
    let result = reload_hook_inner(&app, Some(Path::new("../target/release/hook.dll"))).await;
    app.state::<HookStatus>()
        .reloading
        .store(false, Ordering::SeqCst);
    match result {
        Ok(()) => {
            reload_dbg("reload_hook: reload_hook_inner OK; reloading gate cleared");
            let _ = app.emit_all("success-alert", "Hook reloaded");
        }
        Err(e) => {
            reload_dbg(&format!("reload_hook: reload_hook_inner FAILED: {e:?}"));
            log::warn!("hook reload failed: {e:?}");
            let _ = app.emit_all("error-alert", format!("Hook reload failed: {e}"));
        }
    }
}

#[cfg(windows)]
async fn reload_hook_inner(app: &AppHandle, refresh_from: Option<&Path>) -> anyhow::Result<()> {
    use anyhow::{anyhow, bail, Context};

    reload_dbg("reload_hook_inner: sending Eject over control channel");
    gbfr_logs::control_rpc::eject().await?;
    reload_dbg("reload_hook_inner: Eject acknowledged; waiting for connected=false");

    // The event pipe closing (connect loop flips `connected` off) means the
    // hook's runtime exited. Timing out means the hook is half-dead —
    // ejecting would FreeLibrary a module with live threads, so refuse.
    let wait_start = std::time::Instant::now();
    let deadline = wait_start + std::time::Duration::from_secs(5);
    while app.state::<HookStatus>().connected.load(Ordering::Relaxed) {
        if std::time::Instant::now() >= deadline {
            reload_dbg("reload_hook_inner: TIMEOUT — connected never went false within 5s (pipe did not close)");
            bail!("hook did not shut down within 5s; state unknown — restart the game");
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    reload_dbg(&format!(
        "reload_hook_inner: connected=false after {}ms; 300ms grace then eject",
        wait_start.elapsed().as_millis()
    ));
    // Grace: the setup thread finishes exiting shortly after its runtime
    // drops (the pipe closes slightly before the thread is gone).
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    let target = OwnedProcess::find_first_by_name(gbfr_logs::game_mem::GAME_EXE)
        .ok_or_else(|| anyhow!("game process not found"))?;
    let syringe = Syringe::for_process(target);
    // Unmap the old module fully (refcount may be > 1), else the reconnect
    // re-inject reuses it without re-running the ctor. See eject_hook_until_gone.
    match eject_hook_until_gone(&syringe).context("unloading the old hook")? {
        0 => reload_dbg("reload_hook_inner: no hook module mapped; skipping eject"),
        n => reload_dbg(&format!(
            "reload_hook_inner: old hook fully unmapped after {n} FreeLibrary call(s)"
        )),
    }

    // Refresh the DLL to be re-injected, if a source path was given. Dev
    // reload copies the cargo artifact over hook-dbg.dll; production refresh
    // re-injects the installed hook.dll in place (no copy needed), passing None.
    if let Some(src) = refresh_from {
        if src.exists() {
            std::fs::copy(src, "hook-dbg.dll").context("refreshing hook-dbg.dll")?;
            reload_dbg(&format!(
                "reload_hook_inner: hook-dbg.dll refreshed from {src:?}"
            ));
        } else {
            // Missing dev artifact: re-inject the existing hook-dbg.dll rather
            // than hard-failing (which would leave the game with no hook, since
            // the old one is already ejected).
            reload_dbg(&format!(
                "reload_hook_inner: {src:?} NOT FOUND; re-injecting existing hook-dbg.dll"
            ));
        }
    }
    Ok(())
}

/// Production hook hot-swap: graceful eject + re-inject of the installed
/// hook.dll, so an updated app can refresh the hook without a game restart.
/// Gated on the running hook advertising the `eject` control channel — a
/// pre-rollout hook cannot be safely ejected, so we tell the user to restart
/// the game instead. Windows only (no injector under Proton).
#[cfg(windows)]
#[tauri::command]
async fn refresh_hook(app: AppHandle) -> Result<(), String> {
    let hook = app.state::<HookStatus>();
    // A user reaching for Refresh wants a working hook; a stale debug hold-out
    // must never outrank that. Clear it BEFORE the `connected` check: a held
    // gate blocks injection, so `connected` is false in exactly the stranded
    // case this exists to rescue, and clearing below the early return would
    // never run there.
    hook.dev_hold_out.store(false, Ordering::Relaxed);
    if !hook.connected.load(Ordering::Relaxed) {
        return Err("game-not-running".into());
    }
    if !hook.supports_eject.load(Ordering::Relaxed) {
        return Err("hook-refresh-unsupported".into());
    }
    if hook.reloading.swap(true, Ordering::SeqCst) {
        return Err("hook-refresh-in-progress".into());
    }
    emit_hook_status(&app);
    // None => re-inject the installed hook.dll in place (no artifact copy).
    let result = reload_hook_inner(&app, None).await;
    app.state::<HookStatus>()
        .reloading
        .store(false, Ordering::SeqCst);
    emit_hook_status(&app);
    result.map_err(|e| format!("{e}"))
}

/// Non-Windows: no injector, so refresh is not available — restart the game.
#[cfg(not(windows))]
#[tauri::command]
async fn refresh_hook(_app: AppHandle) -> Result<(), String> {
    Err("hook-refresh-unsupported".into())
}

#[cfg(windows)]
mod dev_debug {
    //! Dev Debug tab: every command in this module drives the REAL hook over
    //! the dev control channel. Nothing here fabricates frontend state — the
    //! app derives hook status from real handshakes and the parser derives
    //! encounter status from real frames. (The `#[cfg(not(windows))]` stubs
    //! outside this module drive nothing: there is no control-channel client
    //! there, so they only report the unavailable slug.)

    use super::*;

    /// Report a control-channel failure verbatim. `control_rpc` produces
    /// distinct, actionable errors — "hook refused eject: …", "refusing to
    /// broadcast an empty batch", an unexpected response, a connect refusal
    /// (the common case: a release hook serves no control listener), a 2s
    /// timeout — and collapsing all of them into one slug would make this
    /// diagnostic tool less diagnostic than the layer beneath it. The raw
    /// detail IS the diagnosis, and `backendErrorMessage` passes unmapped
    /// strings through verbatim, so it reaches the user intact. Same choice
    /// `refresh_hook` already makes for the reload toast.
    fn control_failure(e: anyhow::Error) -> String {
        log::warn!("debug control call failed: {e:?}");
        format!("{e:#}")
    }

    /// Eject the live hook. With `hold`, keep it out of the process so the
    /// resulting `Disconnected` stays put instead of self-healing in ~1s.
    #[tauri::command]
    pub async fn debug_eject_hook(app: AppHandle, hold: bool) -> Result<(), String> {
        let hook = app.state::<HookStatus>();
        hook.debug_precondition()?;
        // A hold set while a refresh is in flight survives that refresh's
        // clear — `refresh_hook`/`reload_hook` clear `dev_hold_out` at the
        // START of the flow, so a hold stored mid-flight is never covered.
        // The refresh then ends, `reloading` drops, and the gate stays shut
        // with nothing left to open it: the injection loop waits forever and
        // the badge reads "No game found". See `HookStatus::injection_gated`.
        if hook.reloading.load(Ordering::Relaxed) {
            return Err("hook-refresh-in-progress".into());
        }
        // Set the gate BEFORE ejecting, and clear it again if the eject fails.
        // Storing it afterwards would leave a window between the hook dying
        // and the flag landing in which the injection loop is free to
        // re-inject, so the hold silently would not hold; clearing on error
        // covers the reason the store was down here in the first place (a
        // stuck gate after a failed eject). Setting it while still connected
        // is harmless: the injection loop breaks out after spawning
        // `connect_and_run_parser` and is only respawned once that task's pipe
        // is gone, so nothing is reading the gate yet.
        if hold {
            hook.dev_hold_out.store(true, Ordering::Relaxed);
        }
        let result = gbfr_logs::control_rpc::eject().await;
        if result.is_err() && hold {
            hook.dev_hold_out.store(false, Ordering::Relaxed);
        }
        result.map_err(control_failure)
    }

    /// Release the hold-out gate; the injection loop reinjects on its own.
    #[tauri::command]
    pub fn debug_allow_reinject(app: AppHandle) -> Result<(), String> {
        if !cfg!(debug_assertions) {
            return Err("debug-only".into());
        }
        app.state::<HookStatus>()
            .dev_hold_out
            .store(false, Ordering::Relaxed);
        Ok(())
    }

    /// Read the dev hold-out flag so the Debug page can show it. A SEPARATE
    /// query, deliberately not a field on `HookStatusSnapshot`: putting it
    /// there would undo the point, which is that the reported state stays
    /// derived from real signals. Pull-only, no event — re-query this on
    /// `hook-status`, because `refresh_hook`/`reload_hook` also clear the flag,
    /// behind the page's back.
    #[tauri::command]
    pub fn debug_hold_out_state(app: AppHandle) -> Result<bool, String> {
        if !cfg!(debug_assertions) {
            return Err("debug-only".into());
        }
        Ok(app
            .state::<HookStatus>()
            .dev_hold_out
            .load(Ordering::Relaxed))
    }

    /// Override the live hook's `Hello`, then re-run the handshake so the app
    /// DERIVES the new state instead of being handed it. Each field is
    /// independent: a `None` field keeps the hook's real value for that field
    /// while the override stays installed. Removing the override entirely is a
    /// different operation — `debug_clear_hello_override`.
    #[tauri::command]
    pub async fn debug_set_hello_override(
        app: AppHandle,
        hook_version: Option<String>,
        protocol_version: Option<u32>,
        supports_eject: Option<bool>,
    ) -> Result<(), String> {
        app.state::<HookStatus>().debug_precondition()?;
        let o = protocol::control::HelloOverride {
            hook_version,
            protocol_version,
            supports_eject,
        };
        gbfr_logs::control_rpc::set_hello_override(Some(o))
            .await
            .map_err(control_failure)?;
        handshake_and_apply(&app).await;
        Ok(())
    }

    /// Clear the override on the hook. `resync` then re-runs the handshake so
    /// the app picks the change up at once.
    ///
    /// Passing `false` is what makes `hook_heartbeat` observable: every other
    /// path refreshes the status itself, which masks whether the periodic
    /// re-probe runs at all. Left un-resynced the app holds a now-stale
    /// verdict, so the badge should sit on its old state and turn green on its
    /// own within `HEARTBEAT_INTERVAL` — and if it does not, the heartbeat is
    /// broken.
    #[tauri::command]
    pub async fn debug_clear_hello_override(app: AppHandle, resync: bool) -> Result<(), String> {
        app.state::<HookStatus>().debug_precondition()?;
        gbfr_logs::control_rpc::set_hello_override(None)
            .await
            .map_err(control_failure)?;
        if resync {
            handshake_and_apply(&app).await;
        }
        Ok(())
    }

    /// Send one scenario batch to the hook, which rebroadcasts it on the real
    /// event stream. Returns how many frames the hook QUEUED onto its
    /// broadcast channel — not how many the app saw. 0 means nothing is
    /// subscribed to the stream; a lagging receiver can still drop queued
    /// frames (the channel holds 1024) and end the app's event-stream loop.
    #[tauri::command]
    pub async fn debug_broadcast_scenario(
        app: AppHandle,
        kind: gbfr_logs::debug_events::Scenario,
    ) -> Result<u32, String> {
        app.state::<HookStatus>().debug_precondition()?;
        gbfr_logs::control_rpc::broadcast_events(gbfr_logs::debug_events::scenario(kind))
            .await
            .map_err(control_failure)
    }
}

#[cfg(windows)]
use dev_debug::{
    debug_allow_reinject, debug_broadcast_scenario, debug_clear_hello_override, debug_eject_hook,
    debug_hold_out_state, debug_set_hello_override,
};

// Non-Windows: no control channel client, so the Debug tab reports the same
// slug the Toolbox uses for an unusable hook — the one string
// `backendErrors.ts` still maps for these commands. The parameters are
// declared and ignored rather than dropped: unused here, but they keep the
// two sides' shapes visibly identical, so a rename or an added argument shows
// up on this side too.
#[cfg(not(windows))]
#[tauri::command]
async fn debug_eject_hook(_app: AppHandle, _hold: bool) -> Result<(), String> {
    Err("hook-control-unavailable".into())
}

#[cfg(not(windows))]
#[tauri::command]
fn debug_allow_reinject(_app: AppHandle) -> Result<(), String> {
    Err("hook-control-unavailable".into())
}

/// Unlike its siblings this answers rather than errors: with no injection loop
/// to hold out of, the flag can never be set here, so `false` is the truth.
#[cfg(not(windows))]
#[tauri::command]
fn debug_hold_out_state(_app: AppHandle) -> Result<bool, String> {
    Ok(false)
}

#[cfg(not(windows))]
#[tauri::command]
async fn debug_set_hello_override(
    _app: AppHandle,
    _hook_version: Option<String>,
    _protocol_version: Option<u32>,
    _supports_eject: Option<bool>,
) -> Result<(), String> {
    Err("hook-control-unavailable".into())
}

#[cfg(not(windows))]
#[tauri::command]
async fn debug_clear_hello_override(_app: AppHandle, _resync: bool) -> Result<(), String> {
    Err("hook-control-unavailable".into())
}

#[cfg(not(windows))]
#[tauri::command]
async fn debug_broadcast_scenario(
    _app: AppHandle,
    _kind: gbfr_logs::debug_events::Scenario,
) -> Result<u32, String> {
    Err("hook-control-unavailable".into())
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
        (Some(home), Some(bundled)) => match steam::discover(&steam::default_steam_roots(&home)) {
            Some(game) => match deploy::deploy(&game.game_dir, &bundled) {
                Ok(_) => info!("proxy dinput8.dll is current in {:?}", game.game_dir),
                Err(e) => log::warn!("could not deploy the proxy DLL: {e:?}"),
            },
            None => log::warn!("Steam install of the game not found; see Settings → Linux setup"),
        },
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
    // Seed from whatever the settings window has already pushed: this task can
    // start either side of the frontend's first push, and the parser outlives
    // game reconnects, so it must not depend on being pushed to again.
    state.filters = *app.state::<MeterFilterState>().current.lock().unwrap();

    let (reset_tx, mut reset_rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    *app.state::<ResetChannel>().0.lock().unwrap() = Some(reset_tx);

    let (filters_tx, mut filters_rx) = tokio::sync::mpsc::unbounded_channel::<v1::MeterFilters>();
    *app.state::<MeterFilterState>().tx.lock().unwrap() = Some(filters_tx);

    tauri::async_runtime::spawn(async move {
        #[cfg(windows)]
        let mut connect_failures: u32 = 0;
        loop {
            match connect_event_stream().await {
                Ok(stream) => {
                    info!("Connected to game!");
                    #[cfg(windows)]
                    reload_dbg("connect_and_run_parser: event pipe CONNECTED (hook is live)");

                    let _ = app.emit_all("success-alert", "Connnected to game!");

                    // Marks connected AND drops the previous hook's verdict —
                    // a version answer belongs to the module that gave it.
                    app.state::<HookStatus>().on_connect();
                    // Hello up front, once per (re)connect: the reported
                    // version + eject support drive the status badge and
                    // refresh gating. If it cannot be delivered the state says
                    // exactly that ("not answering", not "out of date") and
                    // `hook_heartbeat` keeps asking.
                    //
                    // Spawned, NOT awaited: nothing below needs the result, and
                    // its retry ladder can run ~10s against a wedged toolbox
                    // channel — which would be ~10s of frames sitting unread in
                    // the event pipe purely to settle a status badge. A late
                    // result is harmless: `snapshot()` gates on `connected`, so
                    // one landing after a disconnect cannot resurrect the badge.
                    let handshake_app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        handshake_and_apply(&handshake_app).await;
                    });

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
                            Some(filters) = filters_rx.recv() => {
                                // Replay the raw log under the new rule so the
                                // toggle applies to the fight in progress, not
                                // just to hits from here on.
                                state.filters = filters;
                                state.reparse();
                                let _ = window.emit("encounter-update", &state.derived_state);
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
                                protocol::Message::OnQuestElapsedTime(event) => {
                                    state.on_quest_elapsed_time(event);
                                }
                                protocol::Message::OnQuestFail(event) => {
                                    info!(
                                        "quest retire/fail boundary: quest_id={:#x}",
                                        event.quest_id
                                    );
                                    state.on_quest_fail_event(event);
                                }
                                protocol::Message::OnTrialStart(_) => {
                                    info!("training-room session start/teardown boundary");
                                    state.on_trial_start_event();
                                }
                                protocol::Message::OnTrialEnd(_) => {
                                    info!("training-room quit boundary");
                                    state.on_trial_end_event();
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
                                protocol::Message::StatusApply(event) => {
                                    state.on_status_apply(event);
                                }
                                protocol::Message::StatusRemove(event) => {
                                    state.on_status_remove(event);
                                }
                            }
                        }
                    }

                    app.state::<HookStatus>()
                        .connected
                        .store(false, Ordering::Relaxed);
                    emit_hook_status(&app);

                    info!("Game has closed.");

                    // Last chance to persist anything still in progress (abandoned quest →
                    // quit emits no result screen; mid-quest/mid-run quit likewise) — this
                    // parser instance is gone once we go back to waiting for the game.
                    state.on_game_disconnect();

                    // The game has closed, so we should go back to waiting for the game to reopen.
                    #[cfg(windows)]
                    reload_dbg("connect_and_run_parser: event pipe closed (connected=false); breaking to respawn check_and_perform_hook");
                    let _ = app.emit_all("error-alert", "Game has closed!");
                    break;
                }
                Err(_) => {
                    // A fresh hook whose ctor never came up leaves us spinning
                    // here forever (no live connection to lose → no respawn).
                    // Log the first failure + periodically so a wedged reload
                    // is visible instead of silent.
                    #[cfg(windows)]
                    {
                        if connect_failures == 0 || connect_failures % 50 == 0 {
                            reload_dbg(&format!(
                                "connect_and_run_parser: event pipe connect failing (attempt {}); no hook pipe to connect to",
                                connect_failures + 1
                            ));
                        }
                        connect_failures += 1;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
            }
        }

        // Check for the game process again.
        tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
        #[cfg(windows)]
        reload_dbg("connect_and_run_parser: respawning check_and_perform_hook");
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
        .add_item(reset_windows);

    // Dev-only hook hot-reload. The English label is the startup default;
    // `update_tray_labels` localizes it once a webview has booted.
    #[cfg(all(windows, debug_assertions))]
    let menu = menu.add_item(CustomMenuItem::new("reload_hook", "Reload hook (dev)"));

    let menu = menu
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
fn toggle_always_on_top(
    window: tauri::Window,
    state: State<AlwaysOnTop>,
    labels: State<TrayLabels>,
) {
    let always_on_top = &state.0;
    let new_state = !always_on_top.load(Ordering::Acquire);
    always_on_top.store(new_state, Ordering::Release);
    if let Err(e) = window.set_always_on_top(new_state) {
        log::warn!("set_always_on_top({new_state}) failed: {e:?}");
    }
    let _ = window.emit("on-pinned", new_state);
    let title = if new_state {
        labels
            .always_on_top_active
            .lock()
            .map(|g| g.clone())
            .unwrap_or_else(|_| "Always on top \u{2713}".into())
    } else {
        labels
            .always_on_top
            .lock()
            .map(|g| g.clone())
            .unwrap_or_else(|_| "Always on top".into())
    };
    if let Some(item) = window
        .app_handle()
        .tray_handle()
        .try_get_item("always_on_top")
    {
        let _ = item.set_title(&title);
    }
}

#[tauri::command]
fn toggle_clickthrough(
    window: tauri::Window,
    state: State<ClickThrough>,
    labels: State<TrayLabels>,
) {
    let click_through = &state.0;
    let new_state = !click_through.load(Ordering::Acquire);
    click_through.store(new_state, Ordering::Release);
    if let Err(e) = window.set_ignore_cursor_events(new_state) {
        log::warn!("set_ignore_cursor_events({new_state}) failed: {e:?}");
    }
    let _ = window.emit("on-clickthrough", new_state);
    let title = if new_state {
        labels
            .clickthrough_active
            .lock()
            .map(|g| g.clone())
            .unwrap_or_else(|_| "Clickthrough \u{2713}".into())
    } else {
        labels
            .clickthrough
            .lock()
            .map(|g| g.clone())
            .unwrap_or_else(|_| "Clickthrough".into())
    };
    if let Some(item) = window
        .app_handle()
        .tray_handle()
        .try_get_item("toggle_clickthrough")
    {
        let _ = item.set_title(&title);
    }
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
                handle.state::<TrayLabels>(),
            ),
            "always_on_top" => toggle_always_on_top(
                handle.get_window("main").unwrap(),
                handle.state::<AlwaysOnTop>(),
                handle.state::<TrayLabels>(),
            ),
            "reset_windows" => {
                reset_window_to_default(handle, "main", false);
                reset_window_to_default(handle, "logs", false);
            }
            "quit" => {
                let _ = handle.save_window_state(StateFlags::all());
                handle.exit(0)
            }
            #[cfg(all(windows, debug_assertions))]
            "reload_hook" => {
                tauri::async_runtime::spawn(reload_hook(handle.clone()));
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

    // The transparent overlay only stays transparent on WebKitGTK's software
    // (Cairo) path: when accelerated compositing engages — it's on-demand, a
    // CSS animation can trigger it mid-session — the GL surface loses its
    // alpha channel and the whole webview composites onto an opaque backdrop,
    // so the transparency slider appears dead (field report). Keep compositing
    // off; must be set before any webview exists, and only bites with the
    // webkit 2.36 the AppImage pins (2.44+ dropped these escape hatches).
    // Respect an explicit user choice.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_COMPOSITING_MODE").is_none() {
        std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
    }

    info!("Starting application..");

    // Setup the database.
    db::setup_db().expect("Failed to setup database");

    // Deliberately not fatal, unlike logs.db: settings are not load-bearing for
    // parsing damage, so a corrupt or unwritable settings.db degrades to
    // localStorage-only behaviour instead of stopping the app from starting.
    if let Err(e) = settings_db::setup() {
        error!("Failed to set up settings.db, settings will not persist: {e}");
    }

    info!("Database setup complete, launching application..");

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_window(app);
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(
            tauri_plugin_log::Builder::default()
                .targets([
                    LogTarget::Folder(gbfr_logs::data_paths::data_dir().join("logs")),
                    LogTarget::Stdout,
                ])
                .level(LevelFilter::Warn)
                .level_for("tao", LevelFilter::Error)
                .build(),
        )
        .manage(AlwaysOnTop(AtomicBool::new(true)))
        .manage(ClickThrough(AtomicBool::new(false)))
        .manage(DebugMode(AtomicBool::new(false)))
        .manage(ResetChannel(std::sync::Mutex::new(None)))
        .manage(MeterFilterState::default())
        .manage(HookStatus::default())
        .manage(TrayLabels::default())
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
            fetch_legality_players,
            delete_logs,
            delete_all_logs,
            pick_logs_db_file,
            analyze_logs_db,
            import_logs_from_file,
            count_imported_logs,
            delete_imported_logs,
            export_logs_db,
            toggle_always_on_top,
            toggle_clickthrough,
            reset_meter_window,
            export_damage_log_to_file,
            set_debug_mode,
            reset_encounter,
            set_meter_filters,
            fetch_synthesis_status,
            fetch_synthesis_seed,
            fetch_overmastery_status,
            predict_overmastery,
            fetch_rng_slot,
            fetch_transmarvel_status,
            predict_transmarvel,
            search_synthesis,
            get_full_assist_unlock,
            set_full_assist_unlock,
            fetch_linux_setup_status,
            deploy_linux_hook,
            remove_linux_hook,
            get_hook_status,
            refresh_hook,
            debug_eject_hook,
            debug_allow_reinject,
            debug_hold_out_state,
            debug_set_hello_override,
            debug_clear_hello_override,
            debug_broadcast_scenario,
            update_tray_labels,
            get_settings,
            set_setting,
            delete_setting,
            export_settings_db,
            pick_settings_db_file,
            import_settings_from_file,
            reset_settings_to_default,
        ])
        .setup(|app| {
            // Before anything waits on a game: if antivirus took the hook DLL,
            // the badge says so from the first frame rather than after the
            // user has launched the game and watched an empty meter.
            #[cfg(windows)]
            refresh_hook_dll_presence(&app.handle());

            // Perform the game hook check in a separate thread.
            tauri::async_runtime::spawn(check_and_perform_hook(app.handle()));
            // Outlives individual connections on purpose: it must also run for
            // a hook that was already mapped when the app started.
            tauri::async_runtime::spawn(hook_heartbeat(app.handle()));

            // Re-audit any log the current rules have not judged — every log
            // recorded before the legality work, and every log at all after a
            // rule changes. On its own thread so a rules bump never delays the
            // window appearing.
            let handle = app.handle();
            std::thread::spawn(move || sweep_stale_legality(&handle));

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
