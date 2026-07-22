//! Linux (Proton) support: Steam discovery and proxy-DLL deployment.
//!
//! Compiled on ALL platforms — dev and CI run on Windows, so keeping this
//! path-and-file logic platform-independent is what keeps it unit-tested.
//! Only the thin glue in main.rs is #[cfg(target_os = "linux")].
