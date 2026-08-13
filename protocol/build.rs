//! Bakes this crate's content hash in as `WIRE_FINGERPRINT`.
//!
//! The hashing itself lives in `src/fingerprint.rs` and is compiled in here by
//! path rather than duplicated, so the value stamped into the artifact and the
//! code that reasons about it are the same function by construction.

#[path = "src/fingerprint.rs"]
mod fingerprint;

fn main() {
    let root = std::env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR");
    let root = std::path::Path::new(&root);

    // A directory target is scanned recursively, so a NEW module is a rerun
    // trigger too — which matters, since an unnoticed file is a wire change
    // this whole mechanism would then miss.
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=Cargo.toml");

    let fingerprint = fingerprint::wire_fingerprint(&fingerprint::crate_sources(root));
    println!("cargo:rustc-env=WIRE_FINGERPRINT={fingerprint:08x}");
}
