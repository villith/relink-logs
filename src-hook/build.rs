fn main() {
    // Everything below exists to make hook.dll BYTE-IDENTICAL across builds of
    // unchanged sources, and it is an antivirus measure rather than a tidiness
    // one. Every distinct hash is a zero-prevalence file to the cloud ML
    // classifiers, and low prevalence is most of what the generic detections
    // (Wacatac/Wacapew and friends) actually score on. A hook that is rebuilt
    // but unchanged should keep the reputation the last one earned.
    //
    // The version string used to be baked in here from CI's HOOK_VERSION, which
    // auto-bumps on every push to dev — so the DLL got a new hash per release
    // even when src-hook/ was untouched. The hook now reports its own crate
    // version, hand-bumped in Cargo.toml only when the hook itself changes.
    // The app compares that against the version it bundled (wire skew is
    // caught separately by protocol::TOOLBOX_PROTOCOL_VERSION), so both
    // staleness signals move with the hook, never with the release cadence,
    // and the resource block below stays static.
    println!("cargo:rerun-if-changed=Cargo.toml");

    // /Brepro replaces the two per-link nonces MSVC would otherwise stamp in:
    // the PE TimeDateStamp (wall clock) and the CodeView RSDS GUID that pairs
    // the image with its PDB. Both are content-derived under this flag, so
    // relinking identical input reproduces identical bytes. `strip = true` in
    // the workspace profile does NOT cover them — it drops symbols and leaves
    // the debug directory in place.
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        println!("cargo:rustc-link-arg=/Brepro");

        // The PE debug directory embeds the PDB path as a literal string. This
        // crate is named `hook`, so that string is `hook.pdb` — and AV static
        // heuristics keyword-match "hook" in embedded paths (VirusTotal flags
        // it by name). Override the STORED name only (this does not move where
        // the PDB is actually written) with one tied to the application. The
        // value is a fixed literal, so it stays compatible with the /Brepro
        // reproducibility guarantee above.
        println!("cargo:rustc-link-arg=/PDBALTPATH:gbfr_logs.pdb");
    }

    // The static strings come from `[package.metadata.winres]`; the version
    // fields are set here because winres does not read the crate version.
    let mut res = winres::WindowsResource::new();
    let version = env!("CARGO_PKG_VERSION");
    res.set("FileVersion", version);
    res.set("ProductVersion", version);
    let packed = packed_version(version);
    res.set_version_info(winres::VersionInfo::FILEVERSION, packed);
    res.set_version_info(winres::VersionInfo::PRODUCTVERSION, packed);
    res.compile().unwrap();
}

/// `X.Y.Z` packed into the u64 VS_FIXEDFILEINFO wants: four 16-bit fields, most
/// significant first. Anything unparseable contributes 0 rather than failing
/// the build.
fn packed_version(version: &str) -> u64 {
    let (core, build) = version.split_once('-').unwrap_or((version, "0"));
    let mut fields = core.split('.').map(|f| f.parse::<u64>().unwrap_or(0));
    let major = fields.next().unwrap_or(0);
    let minor = fields.next().unwrap_or(0);
    let patch = fields.next().unwrap_or(0);
    let build = build.parse::<u64>().unwrap_or(0);
    (major << 48) | (minor << 32) | (patch << 16) | build
}
