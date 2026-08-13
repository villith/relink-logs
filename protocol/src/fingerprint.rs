//! A content hash of this crate's own sources, used as the wire version.
//!
//! `protocol` IS the wire — both the event stream (`Message`) and the toolbox
//! RPC — so "does the mapped hook speak my protocol?" is exactly "was it built
//! from these sources?". Hashing the crate answers that automatically, which a
//! hand-bumped integer does not: the constant only protects the wire when
//! somebody remembers to bump it, and a forgotten bump is silent garbage on a
//! bincode stream rather than a clean "out of date".
//!
//! It also has to be reproducible off the build machine, so the hash is taken
//! over normalized text: git checkouts differ in line endings between CI and a
//! Windows working tree, and the two OSes disagree on path separators. Either
//! difference would otherwise make the app and the hook disagree about a wire
//! they in fact share.
//!
//! Compiled into `build.rs` as well as into the crate, so the value baked into
//! the artifact and the code reasoning about it can never drift. That means no
//! imports and nothing outside `std`.

/// FNV-1a (64-bit accumulator, folded to 32) over `name\0contents\0` for every
/// file, in name order. Folded because the value travels as the `u32`
/// `protocol_version` field that has always been on the wire — keeping the type
/// means an old hook still deserializes and still reports a differing number,
/// so it lands on "out of date" instead of "unresponsive".
pub fn wire_fingerprint(files: &[(String, String)]) -> u32 {
    // Sorted, because directory iteration order is the filesystem's business.
    let mut named: Vec<(String, &str)> = files
        .iter()
        .map(|(name, body)| (name.replace('\\', "/"), body.as_str()))
        .collect();
    named.sort();

    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for (name, body) in &named {
        hash = feed(hash, name.bytes());
        // Delimiters: without them ("ab", "c") and ("a", "bc") are one stream.
        hash = feed(hash, [0]);
        hash = feed(hash, lf_only(body));
        hash = feed(hash, [0]);
    }
    // Folded, not truncated, so a change confined to either half still moves
    // the value that ships.
    ((hash >> 32) as u32) ^ (hash as u32)
}

/// Everything the wire depends on, as `(name relative to `crate_root`, text)`:
/// every `.rs` under `src/`, plus `Cargo.toml` — a bincode or serde major bump
/// reshapes the wire without touching a line of our own source.
///
/// Deliberately an over-approximation: comments and `#[cfg(test)]` modules
/// hash too, so a non-wire edit in this crate still rotates the version (and
/// with it `hook.dll`'s bytes). Distinguishing wire-shaping tokens from inert
/// ones would take a parser this build-script-shared, std-only module cannot
/// afford, and a hasher that misses a real wire change fails silent where
/// this one fails loud. See `TOOLBOX_PROTOCOL_VERSION`'s doc for the rule
/// that follows: keep non-wire churn out of `protocol/`.
///
/// Shared by `build.rs` and the test that checks the shipped constant, so the
/// two cannot disagree about what "this crate's sources" means.
pub fn crate_sources(crate_root: &std::path::Path) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let manifest = crate_root.join("Cargo.toml");
    if let Ok(body) = std::fs::read_to_string(manifest) {
        out.push(("Cargo.toml".to_string(), body));
    }
    collect_rs(&crate_root.join("src"), "src", &mut out);
    out
}

fn collect_rs(dir: &std::path::Path, prefix: &str, out: &mut Vec<(String, String)>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    // Collected then sorted by `wire_fingerprint`; read_dir order is not ours.
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();
        let child = format!("{prefix}/{name}");
        if path.is_dir() {
            collect_rs(&path, &child, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            if let Ok(body) = std::fs::read_to_string(&path) {
                out.push((child, body));
            }
        }
    }
}

/// FNV-1a.
fn feed(mut hash: u64, bytes: impl IntoIterator<Item = u8>) -> u64 {
    for byte in bytes {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// `\r\n` -> `\n`. A lone `\r` is passed through: it is not a line ending this
/// repo produces, and swallowing it would let two genuinely different files
/// collide.
fn lf_only(body: &str) -> impl Iterator<Item = u8> + '_ {
    let bytes = body.as_bytes();
    bytes
        .iter()
        .enumerate()
        .filter(|(i, byte)| !(**byte == b'\r' && bytes.get(i + 1) == Some(&b'\n')))
        .map(|(_, byte)| *byte)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(n, b)| (n.to_string(), b.to_string()))
            .collect()
    }

    /// The hazard that makes this worth a function rather than an inline hash:
    /// a Windows working tree checks out CRLF and CI checks out LF, so hashing
    /// raw bytes would have the app and the hook disagree about an identical
    /// wire and paint every release "out of date".
    #[test]
    fn fingerprint_ignores_line_ending_style() {
        let lf = files(&[("lib.rs", "enum Message {\n    Damage,\n}\n")]);
        let crlf = files(&[("lib.rs", "enum Message {\r\n    Damage,\r\n}\r\n")]);
        assert_eq!(wire_fingerprint(&lf), wire_fingerprint(&crlf));
    }

    /// ...and the same for the separator in the names we feed it, which come
    /// from the build machine's filesystem.
    #[test]
    fn fingerprint_ignores_path_separator_style() {
        let windows = files(&[("toolbox\\mod.rs", "pub struct A;")]);
        let unix = files(&[("toolbox/mod.rs", "pub struct A;")]);
        assert_eq!(wire_fingerprint(&windows), wire_fingerprint(&unix));
    }

    /// The whole point: a changed message type must produce a changed wire
    /// version, with nobody having to remember to bump anything.
    #[test]
    fn fingerprint_changes_when_a_message_type_changes() {
        let before = files(&[("lib.rs", "enum Message { Damage }")]);
        let after = files(&[("lib.rs", "enum Message { Damage, Death }")]);
        assert_ne!(wire_fingerprint(&before), wire_fingerprint(&after));
    }

    /// Directory iteration order is not guaranteed across platforms, so the
    /// hash must not depend on it.
    #[test]
    fn fingerprint_is_independent_of_file_order() {
        let one = files(&[("a.rs", "struct A;"), ("b.rs", "struct B;")]);
        let other = files(&[("b.rs", "struct B;"), ("a.rs", "struct A;")]);
        assert_eq!(wire_fingerprint(&one), wire_fingerprint(&other));
    }

    /// Names are hashed, not just bodies: moving a type between modules changes
    /// nothing about the bytes but can absolutely change the wire.
    #[test]
    fn fingerprint_changes_when_a_file_is_renamed() {
        let before = files(&[("events.rs", "struct A;")]);
        let after = files(&[("messages.rs", "struct A;")]);
        assert_ne!(wire_fingerprint(&before), wire_fingerprint(&after));
    }

    /// End to end: the constant baked in by `build.rs` is the hash of the
    /// sources sitting on disk right now. Catches the two ways the build script
    /// can quietly go wrong — a stale value because `rerun-if-changed` missed
    /// an edit, and an enumeration that skips a subdirectory (every file it
    /// fails to walk is a wire change it will never notice).
    #[test]
    fn shipped_wire_version_is_the_hash_of_this_crates_sources() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        assert_eq!(
            crate::toolbox::TOOLBOX_PROTOCOL_VERSION,
            wire_fingerprint(&crate_sources(root)),
        );
    }

    /// The enumeration must actually reach a nested module, not just `src/*`.
    #[test]
    fn crate_sources_walks_subdirectories_and_the_manifest() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let names: Vec<String> = crate_sources(root).into_iter().map(|(n, _)| n).collect();
        assert!(names.contains(&"Cargo.toml".to_string()));
        assert!(names.contains(&"src/lib.rs".to_string()));
        assert!(names.contains(&"src/toolbox.rs".to_string()));
    }

    /// A separator between name and body, and between files, so that
    /// concatenation cannot alias: without it `("ab", "c")` and `("a", "bc")`
    /// hash identically.
    #[test]
    fn fingerprint_does_not_alias_across_the_name_body_boundary() {
        let one = files(&[("ab.rs", "c")]);
        let other = files(&[("a.rs", "bc")]);
        assert_ne!(wire_fingerprint(&one), wire_fingerprint(&other));
    }
}
