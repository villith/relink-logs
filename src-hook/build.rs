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

    // The static strings come from `[package.metadata.winres]`. The version
    // cannot: the crate version is a permanent 0.1.0, so without this the DLL
    // ships claiming to be 0.1.0 forever. Set the strings *and* the binary
    // VS_FIXEDFILEINFO fields — they are separate, and tools read both.
    let mut res = winres::WindowsResource::new();
    res.set("FileVersion", &version);
    res.set("ProductVersion", &version);
    let packed = packed_version(&version);
    res.set_version_info(winres::VersionInfo::FILEVERSION, packed);
    res.set_version_info(winres::VersionInfo::PRODUCTVERSION, packed);
    res.compile().unwrap();
}

/// `X.Y.Z` or `X.Y.Z-N` packed into the u64 VS_FIXEDFILEINFO wants: four
/// 16-bit fields, most significant first. Anything unparseable — notably the
/// `0.1.0-dev` local fallback — contributes 0 rather than failing the build,
/// because a dev hook's numeric version is never compared against anything.
fn packed_version(version: &str) -> u64 {
    let (core, build) = version.split_once('-').unwrap_or((version, "0"));
    let mut fields = core.split('.').map(|f| f.parse::<u64>().unwrap_or(0));
    let major = fields.next().unwrap_or(0);
    let minor = fields.next().unwrap_or(0);
    let patch = fields.next().unwrap_or(0);
    let build = build.parse::<u64>().unwrap_or(0);
    (major << 48) | (minor << 32) | (patch << 16) | build
}
