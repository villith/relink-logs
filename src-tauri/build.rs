use std::fs;

use tauri_build::{Attributes, WindowsAttributes};

fn main() {
    println!("cargo:rerun-if-changed=../target/release/hook.dll");

    let _ = fs::copy("../target/release/hook.dll", "hook.dll");

    if cfg!(debug_assertions) {
        tauri_build::build();
    } else {
        let windows = WindowsAttributes::new().app_manifest(include_str!("manifest.xml"));

        tauri_build::try_build(Attributes::new().windows_attributes(windows))
            .expect("Could not build Tauri app.")
    }
}
