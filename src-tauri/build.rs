use std::{env, fs, path::PathBuf};

use tauri_build::{Attributes, WindowsAttributes};

fn copy_dir_all(src: &PathBuf, dst: &PathBuf) {
    if !src.is_dir() {
        return;
    }
    fs::create_dir_all(dst).expect("Failed to create directory");
    for entry in fs::read_dir(src).expect("Failed to read directory") {
        let entry = entry.expect("Failed to read dir entry");
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_all(&src_path, &dst_path);
        } else {
            fs::copy(&src_path, &dst_path).expect("Failed to copy file");
        }
    }
}

/// Emit `cargo:rerun-if-changed` for every file under `dir` so that Cargo
/// re-runs this build script whenever any translation file is modified.
fn rerun_if_dir_changed(dir: &PathBuf) {
    if !dir.is_dir() {
        return;
    }
    for entry in fs::read_dir(dir).expect("Failed to read directory") {
        let entry = entry.expect("Failed to read dir entry");
        let path = entry.path();
        if path.is_dir() {
            rerun_if_dir_changed(&path);
        } else {
            println!("cargo:rerun-if-changed={}", path.display());
        }
    }
}

fn main() {
    // CARGO_MANIFEST_DIR is src-tauri/, so the workspace root is one level up.
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let workspace_root = manifest_dir.parent().unwrap();

    // Prefer the release build of hook.dll; fall back to debug so that a plain
    // `cargo build` (without --release) still works during development.
    let release_dll = workspace_root.join("target/release/hook.dll");
    let debug_dll = workspace_root.join("target/debug/hook.dll");
    let src_dll = if release_dll.exists() { release_dll } else { debug_dll };
    let dest_dll = manifest_dir.join("hook.dll");

    if src_dll.exists() {
        fs::copy(&src_dll, &dest_dll).expect("Failed to copy hook.dll");
    } else {
        println!(
            "cargo:warning=hook.dll not found; run `cargo build --release --package hook` first."
        );
    }

    println!("cargo:rerun-if-changed={}", workspace_root.join("target/release/hook.dll").display());
    println!("cargo:rerun-if-changed={}", workspace_root.join("target/debug/hook.dll").display());

    // Copy lang/ into the current profile's output directory so that
    // resolveResource() works correctly during `tauri dev` (dev mode resolves
    // resources relative to the Cargo output directory, not src-tauri/).
    let profile = env::var("PROFILE").expect("PROFILE not set");
    let src_lang = manifest_dir.join("lang");
    let dest_lang = workspace_root.join("target").join(&profile).join("lang");
    copy_dir_all(&src_lang, &dest_lang);
    rerun_if_dir_changed(&src_lang);

    let windows = WindowsAttributes::new().app_manifest(include_str!("manifest.xml"));
    tauri_build::try_build(Attributes::new().windows_attributes(windows))
        .expect("Could not build Tauri app.");
}
