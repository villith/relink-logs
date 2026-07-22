//! Which transport the event server should expose.
//!
//! Native Windows: the named pipe (unchanged). Under Wine/Proton a native
//! Linux app cannot open Wine named pipes, so the server listens on
//! localhost TCP instead. `GBFR_LOGS_FORCE_TCP=1` in the game process
//! environment forces TCP so the path can be soak-tested on Windows.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transport {
    NamedPipe,
    Tcp,
}

#[allow(dead_code)] // used by Server::run in the next commit
pub fn select_transport() -> Transport {
    select(
        is_wine(),
        std::env::var("GBFR_LOGS_FORCE_TCP").ok().as_deref(),
    )
}

fn select(wine: bool, force_tcp: Option<&str>) -> Transport {
    if wine || force_tcp == Some("1") {
        Transport::Tcp
    } else {
        Transport::NamedPipe
    }
}

/// Wine/Proton exports `wine_get_version` from ntdll; real Windows never does.
fn is_wine() -> bool {
    use windows::core::s;
    use windows::Win32::System::LibraryLoader::{GetModuleHandleA, GetProcAddress};
    unsafe {
        GetModuleHandleA(s!("ntdll.dll"))
            .map(|ntdll| GetProcAddress(ntdll, s!("wine_get_version")).is_some())
            .unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_windows_defaults_to_the_pipe() {
        assert_eq!(select(false, None), Transport::NamedPipe);
    }

    #[test]
    fn wine_selects_tcp() {
        assert_eq!(select(true, None), Transport::Tcp);
    }

    #[test]
    fn force_env_selects_tcp_even_on_native_windows() {
        assert_eq!(select(false, Some("1")), Transport::Tcp);
    }

    #[test]
    fn non_one_force_value_is_ignored() {
        assert_eq!(select(false, Some("0")), Transport::NamedPipe);
        assert_eq!(select(false, Some("")), Transport::NamedPipe);
    }

    /// This test suite runs on real Windows in CI and dev — Wine must not be
    /// detected there.
    #[test]
    fn is_wine_is_false_on_real_windows() {
        assert!(!is_wine());
    }
}
