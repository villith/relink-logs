//! Where the injectable hook DLL lives, and whether it is still there.
//!
//! Split out of `check_and_perform_hook` for two reasons. The first is that
//! the injector used to name the DLL by a bare relative path (`hook.dll`),
//! which resolves against the process CWD rather than the install directory —
//! a shortcut with a different "Start in", or a tray autostart, made an
//! installed hook unfindable. The second is that antivirus routinely
//! quarantines this DLL (it injects into a game process and installs inline
//! detours, which is indistinguishable from a cheat to a behavioural scanner),
//! so "the file is gone" is a state the app must be able to *name* instead of
//! failing silently. Both need path resolution that is unit-testable without a
//! Tauri app, an installer, or a running game.
//!
//! Platform-independent on purpose: the wiring is Windows-only, but the path
//! logic compiles and tests on Linux CI too.

use std::path::{Path, PathBuf};

/// The release hook, bundled as a Tauri resource next to the executable.
pub const HOOK_DLL: &str = "hook.dll";
/// The dev hook, written next to the app by the tray "Reload hook (dev)" path.
pub const HOOK_DBG_DLL: &str = "hook-dbg.dll";

/// The DLL the injector should load, searching `dirs` in order.
///
/// `allow_debug` mirrors `cfg!(debug_assertions)` at the call site, kept a
/// parameter so both precedences are testable from one test binary. A release
/// build ignores `hook-dbg.dll` entirely, so a stale one left in an install
/// directory can never shadow the signed `hook.dll`.
///
/// The search is filename-major, NOT directory-major: a debug build looks for
/// `hook-dbg.dll` in *every* directory before considering `hook.dll` in any of
/// them. `tauri dev` runs the exe from `target/debug` with the CWD at
/// `src-tauri`, and `scripts/refresh-dbg-hook.mjs` writes the dev hook to the
/// latter — so directory-major order would let a stale `target/debug/hook.dll`
/// shadow the hook the dev loop just built. See the precedence tests.
pub fn resolve_injectable_hook(dirs: &[PathBuf], allow_debug: bool) -> Option<PathBuf> {
    let names: &[&str] = if allow_debug {
        &[HOOK_DBG_DLL, HOOK_DLL]
    } else {
        &[HOOK_DLL]
    };
    names.iter().find_map(|name| {
        dirs.iter()
            .map(|dir| dir.join(name))
            .find(|path| path.is_file())
    })
}

/// The DLL this build would inject right now, or `None` if it is not on disk.
/// Thin convenience over [`resolve_injectable_hook`] + [`search_dirs`] so the
/// three call sites that ask (startup, injection, heartbeat) cannot drift.
pub fn injectable_hook() -> Option<PathBuf> {
    resolve_injectable_hook(&search_dirs(), cfg!(debug_assertions))
}

/// Directories to search, most authoritative first: the executable's own
/// directory (the install directory, whatever the CWD happens to be), then the
/// CWD (which is where `npm run tauri dev` keeps both hooks).
pub fn search_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(exe_dir) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
    {
        dirs.push(exe_dir);
    }
    if let Ok(cwd) = std::env::current_dir() {
        if !dirs.contains(&cwd) {
            dirs.push(cwd);
        }
    }
    dirs
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(dir: &Path, name: &str) {
        std::fs::write(dir.join(name), b"MZ").unwrap();
    }

    #[test]
    fn finds_the_release_hook_next_to_the_executable() {
        let dir = tempfile::tempdir().unwrap();
        touch(dir.path(), HOOK_DLL);

        let found = resolve_injectable_hook(&[dir.path().to_path_buf()], false);

        assert_eq!(found, Some(dir.path().join(HOOK_DLL)));
    }

    #[test]
    fn reports_nothing_when_the_hook_has_been_removed() {
        let dir = tempfile::tempdir().unwrap();

        let found = resolve_injectable_hook(&[dir.path().to_path_buf()], true);

        assert_eq!(found, None);
    }

    #[test]
    fn a_debug_build_prefers_the_dev_hook() {
        let dir = tempfile::tempdir().unwrap();
        touch(dir.path(), HOOK_DLL);
        touch(dir.path(), HOOK_DBG_DLL);

        let found = resolve_injectable_hook(&[dir.path().to_path_buf()], true);

        assert_eq!(found, Some(dir.path().join(HOOK_DBG_DLL)));
    }

    #[test]
    fn a_release_build_ignores_a_stale_dev_hook() {
        let dir = tempfile::tempdir().unwrap();
        touch(dir.path(), HOOK_DLL);
        touch(dir.path(), HOOK_DBG_DLL);

        let found = resolve_injectable_hook(&[dir.path().to_path_buf()], false);

        assert_eq!(found, Some(dir.path().join(HOOK_DLL)));
    }

    #[test]
    fn falls_back_to_a_later_directory_when_the_first_has_no_hook() {
        let empty = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        touch(cwd.path(), HOOK_DLL);

        let found = resolve_injectable_hook(
            &[empty.path().to_path_buf(), cwd.path().to_path_buf()],
            false,
        );

        assert_eq!(found, Some(cwd.path().join(HOOK_DLL)));
    }

    #[test]
    fn an_earlier_directory_wins_over_a_later_one() {
        let exe_dir = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        touch(exe_dir.path(), HOOK_DLL);
        touch(cwd.path(), HOOK_DLL);

        let found = resolve_injectable_hook(
            &[exe_dir.path().to_path_buf(), cwd.path().to_path_buf()],
            false,
        );

        assert_eq!(found, Some(exe_dir.path().join(HOOK_DLL)));
    }

    /// The dev loop's contract: `refresh-dbg-hook.mjs` writes the
    /// console-featured hook to `src-tauri/hook-dbg.dll`, which under
    /// `tauri dev` is the CWD — the LAST directory searched — while the exe
    /// directory (`target/debug`) may hold a stale plain `hook.dll` from an
    /// earlier debug build. Directory order must not let that stale file
    /// shadow the dev hook, or `tauri dev` silently injects a hook with none
    /// of the dev features and none of your changes.
    #[test]
    fn the_dev_hook_beats_a_release_hook_in_an_earlier_directory() {
        let exe_dir = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        touch(exe_dir.path(), HOOK_DLL);
        touch(cwd.path(), HOOK_DBG_DLL);

        let found = resolve_injectable_hook(
            &[exe_dir.path().to_path_buf(), cwd.path().to_path_buf()],
            true,
        );

        assert_eq!(found, Some(cwd.path().join(HOOK_DBG_DLL)));
    }

    /// The same layout in a release build resolves the other way: there is no
    /// dev hook to prefer, so the install directory's signed `hook.dll` wins.
    #[test]
    fn a_release_build_still_takes_the_first_directorys_hook() {
        let exe_dir = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        touch(exe_dir.path(), HOOK_DLL);
        touch(cwd.path(), HOOK_DBG_DLL);

        let found = resolve_injectable_hook(
            &[exe_dir.path().to_path_buf(), cwd.path().to_path_buf()],
            false,
        );

        assert_eq!(found, Some(exe_dir.path().join(HOOK_DLL)));
    }

    #[test]
    fn search_dirs_starts_with_the_executables_own_directory() {
        let dirs = search_dirs();
        let exe_dir = std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .to_path_buf();

        assert_eq!(dirs.first(), Some(&exe_dir));
    }
}
