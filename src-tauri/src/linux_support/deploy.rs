//! Deploy the hook into the game folder as a dinput8 proxy DLL.
//!
//! `hook.dll` (bundled as a Tauri resource) is copied to
//! `<game_dir>/dinput8.dll`; Wine loads it at game start via the user's
//! `WINEDLLOVERRIDES` launch option. Ownership is detected via the
//! [`OWNERSHIP_MARKERS`] the hook's winres metadata embeds, so we never
//! clobber or delete another tool's proxy (e.g. ReShade).

use std::fs;
use std::path::Path;

use anyhow::{bail, Context, Result};

pub const PROXY_DLL_NAME: &str = "dinput8.dll";

/// What the user pastes into Steam → Properties → Launch Options.
pub const LAUNCH_OPTIONS: &str = r#"WINEDLLOVERRIDES="dinput8=n,b" %command%"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProxyStatus {
    /// No dinput8.dll in the game folder.
    Missing,
    /// Byte-identical to the bundled hook.
    Current,
    /// Ours (marker present) but different bytes — an older app version.
    Outdated,
    /// Someone else's dinput8.dll (ReShade, SpecialK, ...). Never touched.
    Foreign,
}

pub fn proxy_status(game_dir: &Path, bundled_hook: &Path) -> Result<ProxyStatus> {
    let target = game_dir.join(PROXY_DLL_NAME);
    if !target.exists() {
        return Ok(ProxyStatus::Missing);
    }
    let existing = fs::read(&target).context("read existing dinput8.dll")?;
    let bundled = fs::read(bundled_hook).context("read bundled hook.dll")?;
    if existing == bundled {
        Ok(ProxyStatus::Current)
    } else if is_ours(&existing) {
        Ok(ProxyStatus::Outdated)
    } else {
        Ok(ProxyStatus::Foreign)
    }
}

/// Copy the bundled hook into place (no-op when already current).
pub fn deploy(game_dir: &Path, bundled_hook: &Path) -> Result<ProxyStatus> {
    match proxy_status(game_dir, bundled_hook)? {
        ProxyStatus::Current => Ok(ProxyStatus::Current),
        ProxyStatus::Foreign => {
            bail!(
                "a dinput8.dll from another tool is already at {}",
                game_dir.join(PROXY_DLL_NAME).display()
            )
        }
        ProxyStatus::Missing | ProxyStatus::Outdated => {
            let bundled = fs::read(bundled_hook).context("read bundled hook.dll")?;
            if !is_ours(&bundled) {
                bail!(
                    "bundled hook.dll at {} lacks the \"Relink Logs\" version resource; \
                     refusing to deploy a DLL later versions could not recognize as ours",
                    bundled_hook.display()
                );
            }
            let target = game_dir.join(PROXY_DLL_NAME);
            // Same-directory temp file → same filesystem → rename is atomic.
            let tmp = game_dir.join("dinput8.dll.gbfr-logs.tmp");
            fs::write(&tmp, &bundled).context("write temp proxy dll")?;
            fs::rename(&tmp, target).context("move temp proxy dll into place")?;
            Ok(ProxyStatus::Current)
        }
    }
}

/// Delete our proxy from the game folder. Refuses foreign DLLs.
pub fn remove(game_dir: &Path) -> Result<()> {
    let target = game_dir.join(PROXY_DLL_NAME);
    if !target.exists() {
        return Ok(());
    }
    if !is_ours(&fs::read(&target).context("read existing dinput8.dll")?) {
        bail!(
            "the dinput8.dll at {} is not ours; not deleting it",
            target.display()
        );
    }
    fs::remove_file(&target).context("remove proxy dll")
}

const OWNERSHIP_MARKERS: &[&str] = &["github.com/villith/relink-logs", "Relink Logs"];

fn is_ours(bytes: &[u8]) -> bool {
    OWNERSHIP_MARKERS.iter().any(|marker| {
        let needle: Vec<u8> = marker
            .encode_utf16()
            .flat_map(|c| c.to_le_bytes())
            .collect();
        bytes.windows(needle.len()).any(|w| w == needle)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ours(extra: &[u8]) -> Vec<u8> {
        let mut bytes: Vec<u8> = "Relink Logs"
            .encode_utf16()
            .flat_map(|c| c.to_le_bytes())
            .collect();
        bytes.extend_from_slice(extra);
        bytes
    }

    struct Fixture {
        _tmp: tempfile::TempDir,
        game_dir: std::path::PathBuf,
        bundled: std::path::PathBuf,
    }

    fn fixture() -> Fixture {
        let tmp = tempfile::tempdir().unwrap();
        let game_dir = tmp.path().join("game");
        fs::create_dir_all(&game_dir).unwrap();
        let bundled = tmp.path().join("hook.dll");
        fs::write(&bundled, ours(b"v2")).unwrap();
        Fixture {
            _tmp: tmp,
            game_dir,
            bundled,
        }
    }

    #[test]
    fn missing_then_deploy_then_current() {
        let f = fixture();
        assert_eq!(
            proxy_status(&f.game_dir, &f.bundled).unwrap(),
            ProxyStatus::Missing
        );
        assert_eq!(
            deploy(&f.game_dir, &f.bundled).unwrap(),
            ProxyStatus::Current
        );
        assert_eq!(
            proxy_status(&f.game_dir, &f.bundled).unwrap(),
            ProxyStatus::Current
        );
    }

    #[test]
    fn our_older_dll_reads_outdated_and_is_replaced() {
        let f = fixture();
        fs::write(f.game_dir.join(PROXY_DLL_NAME), ours(b"v1")).unwrap();
        assert_eq!(
            proxy_status(&f.game_dir, &f.bundled).unwrap(),
            ProxyStatus::Outdated
        );
        deploy(&f.game_dir, &f.bundled).unwrap();
        assert_eq!(
            fs::read(f.game_dir.join(PROXY_DLL_NAME)).unwrap(),
            fs::read(&f.bundled).unwrap()
        );
    }

    #[test]
    fn foreign_dll_is_never_overwritten_or_deleted() {
        let f = fixture();
        fs::write(f.game_dir.join(PROXY_DLL_NAME), b"reshade or whatever").unwrap();
        assert_eq!(
            proxy_status(&f.game_dir, &f.bundled).unwrap(),
            ProxyStatus::Foreign
        );
        assert!(deploy(&f.game_dir, &f.bundled).is_err());
        assert!(remove(&f.game_dir).is_err());
        assert_eq!(
            fs::read(f.game_dir.join(PROXY_DLL_NAME)).unwrap(),
            b"reshade or whatever"
        );
    }

    /// A bundled hook missing the version-resource marker must be refused —
    /// deploying it would wedge the NEXT update (it would read as Foreign).
    #[test]
    fn deploy_refuses_marker_less_bundled_hook() {
        let f = fixture();
        fs::write(&f.bundled, b"built without winres somehow").unwrap();
        assert!(deploy(&f.game_dir, &f.bundled).is_err());
        assert!(!f.game_dir.join(PROXY_DLL_NAME).exists());
    }

    #[test]
    fn remove_deletes_ours_and_tolerates_missing() {
        let f = fixture();
        remove(&f.game_dir).unwrap(); // nothing there: ok
        deploy(&f.game_dir, &f.bundled).unwrap();
        remove(&f.game_dir).unwrap();
        assert!(!f.game_dir.join(PROXY_DLL_NAME).exists());
    }

    fn utf16(s: &str) -> Vec<u8> {
        s.encode_utf16().flat_map(|c| c.to_le_bytes()).collect()
    }

    /// The `key = "value"` strings under `[package.metadata.winres]`, which is
    /// the complete set of text winres embeds in the hook's version resource.
    fn hook_winres_values() -> Vec<String> {
        let manifest = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src-hook/Cargo.toml"),
        )
        .expect("read src-hook/Cargo.toml");
        manifest
            .lines()
            .skip_while(|l| l.trim() != "[package.metadata.winres]")
            .skip(1)
            .take_while(|l| !l.trim_start().starts_with('['))
            .filter_map(|l| l.split_once('='))
            .map(|(_, v)| v.trim().trim_matches('"').to_string())
            .filter(|v| !v.is_empty())
            .collect()
    }

    #[test]
    fn is_ours_recognises_a_string_the_hook_actually_embeds() {
        let values = hook_winres_values();
        assert!(
            !values.is_empty(),
            "no [package.metadata.winres] values found in src-hook/Cargo.toml"
        );

        let recognised: Vec<&String> = values.iter().filter(|v| is_ours(&utf16(v))).collect();

        assert!(
            !recognised.is_empty(),
            "is_ours() recognises none of the strings the hook embeds: {values:?}"
        );
    }

    #[test]
    fn a_pre_rename_proxy_is_still_recognised_as_ours() {
        assert!(is_ours(&utf16("CompanyName: Relink Logs")));
    }

    #[test]
    fn a_really_built_hook_dll_is_recognised_as_ours() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let Some(dll) = [
            root.join("hook.dll"),
            root.join("../target/release/hook.dll"),
        ]
        .into_iter()
        .find(|p| p.is_file()) else {
            eprintln!("no built hook.dll found; skipping");
            return;
        };

        let bytes = fs::read(&dll).expect("read built hook.dll");

        assert!(
            is_ours(&bytes),
            "built hook at {} carries no ownership marker — Linux deploy would refuse it",
            dll.display()
        );
    }
}
