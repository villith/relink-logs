fn main() {
    // Report a version the app can compare against its own. CI's release
    // hook-build step sets HOOK_VERSION to the release version; dev/local
    // builds leave it unset and fall back to the dev sentinel (kept in sync
    // with protocol::toolbox::HOOK_DEV_VERSION), which the app never flags
    // as out of date on version difference.
    let version = std::env::var("HOOK_VERSION").unwrap_or_else(|_| "0.1.0-dev".to_string());
    println!("cargo:rustc-env=HOOK_VERSION={version}");
    println!("cargo:rerun-if-env-changed=HOOK_VERSION");
    println!("cargo:rerun-if-changed=Cargo.toml");

    let res = winres::WindowsResource::new();
    res.compile().unwrap();
}
