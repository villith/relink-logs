use std::fs;

use tauri_build::{Attributes, WindowsAttributes};

fn main() {
    println!("cargo:rerun-if-changed=../target/release/hook.dll");

    let _ = fs::copy("../target/release/hook.dll", "hook.dll");

    // The hook crate's own version — hand-bumped in src-hook/Cargo.toml when
    // the hook changes (see CLAUDE.md). The app compares the mapped hook's
    // reported version against this, the version of the DLL it bundles, so a
    // wire-compatible but stale hook (a fix confined to src-hook/ or
    // game-reader/, which never moves TOOLBOX_PROTOCOL_VERSION) still reads
    // OutOfDate. Parsed from the manifest so the two cannot drift.
    println!("cargo:rerun-if-changed=../src-hook/Cargo.toml");
    let manifest =
        fs::read_to_string("../src-hook/Cargo.toml").expect("could not read src-hook/Cargo.toml");
    let hook_version = manifest
        .lines()
        .find_map(|line| {
            line.trim()
                .strip_prefix("version = \"")
                .and_then(|rest| rest.strip_suffix('"'))
        })
        .expect("src-hook/Cargo.toml carries no version");
    println!("cargo:rustc-env=EXPECTED_HOOK_VERSION={hook_version}");

    if cfg!(debug_assertions) {
        tauri_build::build();
    } else {
        let windows = WindowsAttributes::new().app_manifest(include_str!("manifest.xml"));

        tauri_build::try_build(Attributes::new().windows_attributes(windows))
            .expect("Could not build Tauri app.")
    }
}
