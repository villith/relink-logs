//! Deploy the hook into the game folder as a dinput8 proxy DLL.
//!
//! `hook.dll` (bundled as a Tauri resource) is copied to
//! `<game_dir>/dinput8.dll`; Wine loads it at game start via the user's
//! `WINEDLLOVERRIDES` launch option. Ownership is detected via the
//! "Relink Logs" CompanyName the hook's winres metadata embeds, so we never
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
            bail!("a dinput8.dll from another tool is already in the game folder")
        }
        ProxyStatus::Missing | ProxyStatus::Outdated => {
            fs::copy(bundled_hook, game_dir.join(PROXY_DLL_NAME))
                .context("copy hook.dll into the game folder")?;
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
        bail!("the dinput8.dll in the game folder is not ours; not deleting it");
    }
    fs::remove_file(&target).context("remove proxy dll")
}

/// The hook's version resource embeds CompanyName "Relink Logs" (UTF-16, see
/// [package.metadata.winres] in src-hook/Cargo.toml) — presence of that
/// string marks a DLL as ours across versions.
fn is_ours(bytes: &[u8]) -> bool {
    let needle: Vec<u8> = "Relink Logs"
        .encode_utf16()
        .flat_map(|c| c.to_le_bytes())
        .collect();
    bytes.windows(needle.len()).any(|w| w == needle)
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

    #[test]
    fn remove_deletes_ours_and_tolerates_missing() {
        let f = fixture();
        remove(&f.game_dir).unwrap(); // nothing there: ok
        deploy(&f.game_dir, &f.bundled).unwrap();
        remove(&f.game_dir).unwrap();
        assert!(!f.game_dir.join(PROXY_DLL_NAME).exists());
    }
}
