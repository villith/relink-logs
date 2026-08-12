//! Which transport the event server should expose.
//!
//! Native Windows: the named pipe, and only ever the named pipe. Under
//! Wine/Proton a native Linux app cannot open Wine named pipes, so the
//! server listens on localhost TCP instead — that entire path is behind the
//! `proton` feature and is absent from the Windows DLL.
//!
//! Why it is gated rather than just runtime-skipped: the Windows build is
//! injected into the game process, and a listening socket in an injected DLL
//! is a backdoor signature to AV heuristics. `is_wine()` is false on Windows,
//! so the code never executed there — it only ever sat in the binary being
//! read by scanners. See also `proxy.rs`.
//!
//! Under `proton`, `GBFR_LOGS_FORCE_TCP=1` in the game process environment
//! forces TCP so the path can be soak-tested on Windows. Note: winecfg's
//! "Hide Wine version" setting (HideWineExports) removes the export we probe,
//! silently falling back to the pipe — GBFR_LOGS_FORCE_TCP=1 is the escape
//! hatch.

use std::future::Future;
#[cfg(feature = "proton")]
use std::time::Duration;

use interprocess::os::windows::named_pipe::tokio::PipeListenerOptionsExt;
use interprocess::os::windows::named_pipe::{pipe_mode, PipeListenerOptions, PipeMode};
use log::{info, warn};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transport {
    NamedPipe,
    #[cfg(feature = "proton")]
    Tcp,
}

/// A boxed, type-erased duplex stream (named pipe or TCP) so one generic
/// `serve` handles both transports. `AsyncRead + AsyncWrite` are two
/// non-auto traits and can't be combined in a trait object directly, so we
/// fold them into one subtrait.
pub trait RpcStream: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send {}
impl<T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send> RpcStream for T {}
pub type BoxStream = std::pin::Pin<Box<dyn RpcStream>>;

/// One-request-per-connection RPC listener shared by the toolbox and dev
/// control channels: named pipe on native Windows, localhost TCP under
/// Wine/Proton (and `GBFR_LOGS_FORCE_TCP=1`). Each accepted connection is
/// handed to `serve` on its own task; `label` tags the log lines.
///
/// `ready`, when given, is signalled once the channel is actually connectable
/// — never merely once this task has started. Dropping it (a listener that
/// could not be created) wakes the waiter too, so nobody blocks on a channel
/// that will never exist.
///
/// `tcp_addr` is unused without `proton`; callers pass the constant either
/// way so the two builds share one call site.
#[cfg_attr(not(feature = "proton"), allow(unused_variables))]
pub async fn serve_rpc<F, Fut>(
    pipe_name: &str,
    tcp_addr: &str,
    label: &str,
    serve: F,
    ready: Option<tokio::sync::oneshot::Sender<()>>,
) where
    F: Fn(BoxStream) -> Fut + Clone + Send + 'static,
    Fut: Future<Output = ()> + Send + 'static,
{
    match select_transport() {
        Transport::NamedPipe => run_pipe(pipe_name, label, serve, ready).await,
        #[cfg(feature = "proton")]
        Transport::Tcp => run_tcp(tcp_addr, label, serve, ready).await,
    }
}

async fn run_pipe<F, Fut>(
    pipe_name: &str,
    label: &str,
    serve: F,
    ready: Option<tokio::sync::oneshot::Sender<()>>,
) where
    F: Fn(BoxStream) -> Fut + Clone + Send + 'static,
    Fut: Future<Output = ()> + Send + 'static,
{
    let listener = match PipeListenerOptions::new()
        .path(pipe_name)
        .mode(PipeMode::Bytes)
        .accept_remote(false)
        .create_tokio_duplex::<pipe_mode::Bytes>()
    {
        Ok(listener) => listener,
        Err(e) => {
            warn!("{label}: could not create pipe listener: {e:?}");
            return;
        }
    };
    info!("{label}: listening on {pipe_name}");
    // The instance exists now, so a client can connect even before the first
    // `accept()` below parks on it.
    if let Some(ready) = ready {
        let _ = ready.send(());
    }
    loop {
        match listener.accept().await {
            Ok(stream) => {
                let serve = serve.clone();
                tokio::spawn(async move { serve(Box::pin(stream)).await });
            }
            Err(e) => warn!("{label}: error accepting client: {e:?}"),
        }
    }
}

// Same bind-retry rationale as the event listener: a taken port must not
// permanently disable the channel for the session.
#[cfg(feature = "proton")]
async fn run_tcp<F, Fut>(
    tcp_addr: &str,
    label: &str,
    serve: F,
    ready: Option<tokio::sync::oneshot::Sender<()>>,
) where
    F: Fn(BoxStream) -> Fut + Clone + Send + 'static,
    Fut: Future<Output = ()> + Send + 'static,
{
    let listener = loop {
        match tokio::net::TcpListener::bind(tcp_addr).await {
            Ok(listener) => break listener,
            Err(e) => {
                warn!("{label}: could not bind {tcp_addr}: {e:?}; retrying in 5s");
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        }
    };
    info!("{label}: listening on {tcp_addr}");
    if let Some(ready) = ready {
        let _ = ready.send(());
    }
    loop {
        match listener.accept().await {
            Ok((stream, _addr)) => {
                let serve = serve.clone();
                tokio::spawn(async move { serve(Box::pin(stream)).await });
            }
            Err(e) => {
                warn!("{label}: error accepting client: {e:?}");
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }
}

#[cfg(feature = "proton")]
pub fn select_transport() -> Transport {
    select(
        is_wine(),
        std::env::var("GBFR_LOGS_FORCE_TCP").ok().as_deref(),
    )
}

/// No wine probe and no env override: without `proton` there is no TCP
/// transport for either to select, so neither is compiled in.
#[cfg(not(feature = "proton"))]
pub fn select_transport() -> Transport {
    select(false, None)
}

#[cfg(feature = "proton")]
fn select(wine: bool, force_tcp: Option<&str>) -> Transport {
    if wine || force_tcp == Some("1") {
        Transport::Tcp
    } else {
        Transport::NamedPipe
    }
}

#[cfg(not(feature = "proton"))]
fn select(_wine: bool, _force_tcp: Option<&str>) -> Transport {
    Transport::NamedPipe
}

/// Wine/Proton exports `wine_get_version` from ntdll; real Windows never does.
#[cfg(feature = "proton")]
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

    /// The Windows DLL must carry NO TCP path at all. A listening socket
    /// inside a DLL injected into a game process is one of the strongest
    /// AV heuristics we present, and it exists solely for Proton — so
    /// without the `proton` feature even a forced answer stays on the pipe.
    #[cfg(not(feature = "proton"))]
    #[test]
    fn windows_build_never_selects_tcp() {
        assert_eq!(select(true, Some("1")), Transport::NamedPipe);
    }

    #[cfg(feature = "proton")]
    #[test]
    fn wine_selects_tcp() {
        assert_eq!(select(true, None), Transport::Tcp);
    }

    #[cfg(feature = "proton")]
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
    #[cfg(feature = "proton")]
    #[test]
    fn is_wine_is_false_on_real_windows() {
        assert!(!is_wine());
    }

    /// The app fires its Hello the instant the EVENT pipe accepts, so the
    /// toolbox channel has to be up first — and "up" has to mean connectable,
    /// not merely spawned. A ready signal that fires before its listener
    /// exists hands the app an ERROR_FILE_NOT_FOUND on a perfectly healthy
    /// hook, which is the startup race behind the bogus status.
    #[tokio::test]
    async fn ready_fires_only_once_the_listener_accepts_connections() {
        use interprocess::os::windows::named_pipe::{pipe_mode, tokio::DuplexPipeStream};

        let path = r"\\.\pipe\gbfr-logs-test-ready";
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        tokio::spawn(serve_rpc(
            path,
            "127.0.0.1:39399",
            "test",
            |_stream| async {},
            Some(ready_tx),
        ));

        ready_rx.await.expect("listener never signalled ready");

        // Would fail with os error 2 if `ready` outran the pipe's creation.
        DuplexPipeStream::<pipe_mode::Bytes>::connect_by_path(path)
            .await
            .expect("ready fired before the pipe was connectable");
    }
}
