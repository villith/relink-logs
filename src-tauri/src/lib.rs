//! Library crate for gbfr-logs. Holds the parser + db modules so both the main
//! Tauri binary (`main.rs`) and auxiliary binaries (e.g. `bin/skill_backfill.rs`)
//! can share them. main.rs is a thin binary that `use`s this crate.
pub mod backfill;
// Dev-only client for the hook's control channel (hook hot-reload). Debug
// Windows builds only; release never links it.
#[cfg(all(windows, debug_assertions))]
pub mod control_rpc;
pub mod data_paths;
pub mod db;
#[cfg(windows)]
pub mod game_mem;
pub mod linux_support;
pub mod overmastery;
pub mod parser;
pub mod synthesis;
pub mod toolbox_rpc;
