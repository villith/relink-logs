//! Which transport the event server should expose.
//!
//! Native Windows: the named pipe (unchanged). Under Wine/Proton a native
//! Linux app cannot open Wine named pipes, so the server listens on
//! localhost TCP instead. `GBFR_LOGS_FORCE_TCP=1` in the game process
//! environment forces TCP so the path can be soak-tested on Windows.
//! Note: winecfg's "Hide Wine version" setting (HideWineExports) removes
//! the export we probe, silently falling back to the pipe —
//! GBFR_LOGS_FORCE_TCP=1 is the escape hatch.

use std::future::Future;
use std::time::Duration;

use interprocess::os::windows::named_pipe::tokio::PipeListenerOptionsExt;
use interprocess::os::windows::named_pipe::{pipe_mode, PipeListenerOptions, PipeMode};
use log::{info, warn};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transport {
    NamedPipe,
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
pub async fn serve_rpc<F, Fut>(pipe_name: &str, tcp_addr: &str, label: &str, serve: F)
where
    F: Fn(BoxStream) -> Fut + Clone + Send + 'static,
    Fut: Future<Output = ()> + Send + 'static,
{
    match select_transport() {
        Transport::NamedPipe => run_pipe(pipe_name, label, serve).await,
        Transport::Tcp => run_tcp(tcp_addr, label, serve).await,
    }
}

async fn run_pipe<F, Fut>(pipe_name: &str, label: &str, serve: F)
where
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
async fn run_tcp<F, Fut>(tcp_addr: &str, label: &str, serve: F)
where
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
