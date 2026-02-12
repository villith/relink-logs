use std::{env, fs, path::PathBuf};

use tauri_build::{Attributes, WindowsAttributes};

fn main() {
    // CARGO_MANIFEST_DIR is src-tauri/, so the workspace root is one level up.
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let workspace_root = manifest_dir.parent().unwrap();

    // Prefer the release build of hook.dll; fall back to debug so that a plain
    // `cargo build` (without --release) still works during development.
    let release_dll = workspace_root.join("target/release/hook.dll");
    let debug_dll = workspace_root.join("target/debug/hook.dll");

    let src_dll = if release_dll.exists() {
        release_dll
    } else {
        debug_dll
    };

    let dest_dll = manifest_dir.join("hook.dll");

    if src_dll.exists() {
        fs::copy(&src_dll, &dest_dll).expect("Failed to copy hook.dll");
    } else {
        // Not yet built – emit a warning so the developer knows what to do.
        println!(
            "cargo:warning=hook.dll not found; run `cargo build --release --package hook` first."
        );
    }

    // Rerun this build script whenever the hook DLL changes so that the copy
    // is always kept up to date.
    println!(
        "cargo:rerun-if-changed={}",
        workspace_root.join("target/release/hook.dll").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        workspace_root.join("target/debug/hook.dll").display()
    );

    let windows = WindowsAttributes::new().app_manifest(include_str!("manifest.xml"));

    tauri_build::try_build(Attributes::new().windows_attributes(windows))
        .expect("Could not build Tauri app.");
}
