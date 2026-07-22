//! Locate the game's Steam install and Proton prefix on Linux.
//!
//! Pure path/string logic over a provided list of Steam roots so it stays
//! compiled and unit-tested on Windows dev machines and CI. Only main.rs
//! decides which real roots to probe.

use std::fs;
use std::path::{Path, PathBuf};

/// Granblue Fantasy: Relink.
pub const APP_ID: &str = "881020";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SteamGame {
    /// `<library>/steamapps/common/<installdir>` — where the proxy DLL goes.
    pub game_dir: PathBuf,
    /// `<library>/steamapps/compatdata/881020/pfx` — exists after the first
    /// Proton launch.
    pub prefix_dir: PathBuf,
    /// Where the hook's `dirs::data_dir()` resolves inside Wine — the hook's
    /// config and log live here.
    pub hook_data_dir: PathBuf,
}

/// The Steam roots worth probing, given the user's home directory
/// (native package, legacy symlink layout, flatpak).
pub fn default_steam_roots(home: &Path) -> Vec<PathBuf> {
    vec![
        home.join(".local/share/Steam"),
        home.join(".steam/steam"),
        home.join(".var/app/com.valvesoftware.Steam/.local/share/Steam"),
    ]
}

/// Find the game in any library of any root. `None` = not installed / no Steam.
///
/// Pre-2021 `libraryfolders.vdf` layouts (numeric key → inline path string)
/// are not handled: any Steam client new enough to run this game under
/// Proton writes the nested format.
pub fn discover(roots: &[PathBuf]) -> Option<SteamGame> {
    for root in roots {
        let mut libraries: Vec<PathBuf> = vec![root.clone()];
        if let Ok(vdf) = fs::read_to_string(root.join("steamapps/libraryfolders.vdf")) {
            for path in vdf_string_values(&vdf, "path") {
                let path = PathBuf::from(path);
                if !libraries.contains(&path) {
                    libraries.push(path);
                }
            }
        }
        for library in libraries {
            let steamapps = library.join("steamapps");
            let Ok(acf) = fs::read_to_string(steamapps.join(format!("appmanifest_{APP_ID}.acf")))
            else {
                continue;
            };
            let Some(installdir) = vdf_string_values(&acf, "installdir").into_iter().next() else {
                continue;
            };
            let game_dir = steamapps.join("common").join(&installdir);
            if !game_dir.is_dir() {
                continue;
            }
            let prefix_dir = steamapps.join("compatdata").join(APP_ID).join("pfx");
            let hook_data_dir =
                prefix_dir.join("drive_c/users/steamuser/AppData/Roaming/gbfr-logs");
            return Some(SteamGame {
                game_dir,
                prefix_dir,
                hook_data_dir,
            });
        }
    }
    None
}

/// Values of every `"key" "value"` line in a VDF blob. Handles the two
/// escapes Steam writes in paths (`\\` and `\"`); nesting doesn't matter for
/// the keys we read (`path`, `installdir`).
fn vdf_string_values(vdf: &str, key: &str) -> Vec<String> {
    let prefix = format!("\"{key}\"");
    let mut out = Vec::new();
    for line in vdf.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix(&prefix) else {
            continue;
        };
        let rest = rest.trim();
        if rest.len() >= 2 && rest.starts_with('"') && rest.ends_with('"') {
            // Sequential replaces mis-decode the pathological `\\"` sequence; a
            // real Steam path/installdir value can never end a segment that way,
            // and this parser is scoped to those two keys.
            out.push(
                rest[1..rest.len() - 1]
                    .replace("\\\\", "\\")
                    .replace("\\\"", "\""),
            );
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIBRARYFOLDERS: &str = r#"
"libraryfolders"
{
    "0"
    {
        "path"		"/home/scott/.local/share/Steam"
        "label"		""
    }
    "1"
    {
        "path"		"/mnt/games/SteamLibrary"
    }
}
"#;

    const APPMANIFEST: &str = r#"
"AppState"
{
    "appid"		"881020"
    "name"		"Granblue Fantasy: Relink"
    "installdir"		"Granblue Fantasy Relink"
}
"#;

    #[test]
    fn vdf_extracts_all_values_of_a_key() {
        assert_eq!(
            vdf_string_values(LIBRARYFOLDERS, "path"),
            vec!["/home/scott/.local/share/Steam", "/mnt/games/SteamLibrary"]
        );
    }

    #[test]
    fn vdf_key_match_is_exact_not_prefix() {
        // "pathext" must not match "path"
        assert!(vdf_string_values("\"pathext\"  \"zzz\"", "path").is_empty());
    }

    #[test]
    fn vdf_unescapes_backslashes() {
        assert_eq!(
            vdf_string_values(r#""path"  "C:\\Games\\Steam""#, "path"),
            vec![r"C:\Games\Steam"]
        );
    }

    #[test]
    fn installdir_is_read_from_the_manifest() {
        assert_eq!(
            vdf_string_values(APPMANIFEST, "installdir"),
            vec!["Granblue Fantasy Relink"]
        );
    }

    #[test]
    fn default_roots_cover_native_legacy_and_flatpak() {
        let roots = default_steam_roots(Path::new("/home/scott"));
        assert_eq!(roots.len(), 3);
        assert!(roots[0].ends_with(".local/share/Steam"));
        assert!(roots[2]
            .to_string_lossy()
            .contains("com.valvesoftware.Steam"));
    }

    /// Full discovery over a fixture tree: root library has the manifest in a
    /// SECOND library listed by libraryfolders.vdf.
    #[test]
    fn discover_walks_secondary_libraries() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("Steam");
        let second = tmp.path().join("SteamLibrary");
        fs::create_dir_all(root.join("steamapps")).unwrap();
        let game_dir = second.join("steamapps/common/Granblue Fantasy Relink");
        fs::create_dir_all(&game_dir).unwrap();

        let vdf = format!(
            "\"libraryfolders\"\n{{\n  \"0\"\n  {{\n    \"path\"  \"{}\"\n  }}\n}}\n",
            second.display()
        );
        fs::write(root.join("steamapps/libraryfolders.vdf"), vdf).unwrap();
        fs::write(
            second.join(format!("steamapps/appmanifest_{APP_ID}.acf")),
            "\"AppState\"\n{\n  \"installdir\"  \"Granblue Fantasy Relink\"\n}\n",
        )
        .unwrap();

        let game = discover(&[root]).expect("game should be found");
        assert_eq!(game.game_dir, game_dir);
        assert_eq!(
            game.prefix_dir,
            second.join("steamapps/compatdata/881020/pfx")
        );
        assert!(game
            .hook_data_dir
            .ends_with("drive_c/users/steamuser/AppData/Roaming/gbfr-logs"));
    }

    #[test]
    fn discover_returns_none_when_nothing_matches() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(discover(&[tmp.path().to_path_buf()]), None);
    }

    /// Two roots both contain the game: the FIRST root's paths must win.
    #[test]
    fn discover_prefers_the_first_root() {
        let tmp = tempfile::tempdir().unwrap();
        let mk = |name: &str| {
            let root = tmp.path().join(name);
            let game = root.join("steamapps/common/Granblue Fantasy Relink");
            fs::create_dir_all(&game).unwrap();
            fs::write(
                root.join(format!("steamapps/appmanifest_{APP_ID}.acf")),
                "\"AppState\"\n{\n  \"installdir\"  \"Granblue Fantasy Relink\"\n}\n",
            )
            .unwrap();
            root
        };
        let first = mk("first");
        let second = mk("second");
        let game = discover(&[first.clone(), second]).unwrap();
        assert!(game.game_dir.starts_with(&first));
    }

    /// A manifest whose game folder is gone (uninstalled/moved) is skipped.
    #[test]
    fn discover_skips_stale_manifest_without_game_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("Steam");
        fs::create_dir_all(root.join("steamapps")).unwrap();
        fs::write(
            root.join(format!("steamapps/appmanifest_{APP_ID}.acf")),
            "\"AppState\"\n{\n  \"installdir\"  \"Granblue Fantasy Relink\"\n}\n",
        )
        .unwrap();
        assert_eq!(discover(&[root]), None);
    }

    /// Garbage vdf/acf content degrades to None, never a panic.
    #[test]
    fn discover_survives_malformed_files() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("Steam");
        fs::create_dir_all(root.join("steamapps")).unwrap();
        fs::write(
            root.join("steamapps/libraryfolders.vdf"),
            "\x00\x01{{{\"path",
        )
        .unwrap();
        fs::write(
            root.join(format!("steamapps/appmanifest_{APP_ID}.acf")),
            "not a vdf at all",
        )
        .unwrap();
        assert_eq!(discover(&[root]), None);
    }
}
