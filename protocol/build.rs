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
    // A generated source file rather than a `rustc-env` string: the constant is
    // a `u32`, and emitting it as one spares lib.rs a const-fn hex parser
    // (`u32::from_str_radix` is not const-stable).
    let out_dir = std::env::var("OUT_DIR").expect("cargo sets OUT_DIR");
    std::fs::write(
        std::path::Path::new(&out_dir).join("wire_fingerprint.rs"),
        format!(
            "/// Content hash of this crate, computed by `build.rs`. See\n\
             /// [`toolbox::TOOLBOX_PROTOCOL_VERSION`], which is what actually travels.\n\
             pub const WIRE_FINGERPRINT: u32 = {fingerprint:#010x};\n"
        ),
    )
    .expect("OUT_DIR is writable");
}
