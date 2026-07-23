use std::io::Write;
use std::path::PathBuf;

use anyhow::{Context, Result};
use futures::sink::SinkExt;
use interprocess::os::windows::named_pipe::tokio::PipeListenerOptionsExt;
use interprocess::os::windows::named_pipe::{PipeListenerOptions, PipeMode};
use log::{info, warn};
use tokio::sync::broadcast;

mod event;
mod hooks;
mod process;
mod proxy;
mod toolbox;
mod transport;

use protocol::Message;
use tokio_util::codec::{FramedWrite, LengthDelimitedCodec};

async fn handle_client<S>(
    mut stream: FramedWrite<S, LengthDelimitedCodec>,
    mut rx: event::Rx,
) -> Result<()>
where
    S: tokio::io::AsyncWrite + Unpin,
{
    while let Ok(msg) = rx.recv().await {
        let bytes = protocol::bincode::serialize(&msg)?;
        stream.send(bytes.into()).await?;
    }

    Ok(())
}

#[derive(Debug)]
struct Server {
    tx: event::Tx,
}

impl Server {
    fn new() -> Self {
        let (tx, _) = broadcast::channel::<Message>(1024);
        Server { tx }
    }

    async fn run(&self) {
        // The toolbox RPC channel is independent of the event stream and
        // must not die with a client, so it gets its own task.
        tokio::spawn(toolbox::run());
        match transport::select_transport() {
            transport::Transport::NamedPipe => self.run_pipe().await,
            transport::Transport::Tcp => self.run_tcp().await,
        }
    }

    async fn run_pipe(&self) {
        if let Ok(listener) = PipeListenerOptions::new()
            .path(protocol::PIPE_NAME)
            .mode(PipeMode::Bytes)
            .accept_remote(false)
            .create_tokio_send_only()
        {
            loop {
                let read_pipe = listener.accept().await;
                match read_pipe {
                    Ok(stream) => {
                        let rx = self.tx.subscribe();
                        tokio::spawn(async move {
                            let encoder = LengthDelimitedCodec::new();
                            let writer = FramedWrite::new(stream, encoder);

                            let _ = handle_client(writer, rx).await;
                        });
                    }
                    Err(e) => {
                        warn!("Error accepting client: {:?}", e);
                    }
                }
            }
        }
    }

    // Under Wine/Proton: a native Linux app connects to this directly (Wine
    // sockets are real Linux sockets). Bind failures (port taken) retry
    // rather than killing event delivery for the whole session.
    async fn run_tcp(&self) {
        let listener = loop {
            match tokio::net::TcpListener::bind(protocol::TCP_ADDR).await {
                Ok(listener) => break listener,
                Err(e) => {
                    warn!("Could not bind {}: {e:?}; retrying in 5s", protocol::TCP_ADDR);
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                }
            }
        };
        info!("Listening on {}", protocol::TCP_ADDR);
        loop {
            match listener.accept().await {
                Ok((stream, _addr)) => {
                    let rx = self.tx.subscribe();
                    tokio::spawn(async move {
                        let writer = FramedWrite::new(stream, LengthDelimitedCodec::new());
                        let _ = handle_client(writer, rx).await;
                    });
                }
                Err(e) => {
                    warn!("Error accepting client: {:?}", e);
                    // A persistent accept error (fd exhaustion, Wine socket
                    // quirks) must not busy-spin inside the game process.
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
            }
        }
    }
}

#[tokio::main]
async fn setup() {
    info!("Setting up event listener");

    let server = Server::new();
    let tx = server.tx.clone();

    info!("Setting up hooks...");

    match hooks::setup_hooks(tx) {
        Ok(_) => info!("Hooks initialized"),
        Err(e) => warn!("Error initializing hooks: {:?}", e),
    }

    #[cfg(feature = "console")]
    println!("Hook library initialized");

    let _ = std::io::stdout().flush();

    server.run().await;
}

fn initialize_logger() -> anyhow::Result<()> {
    let application_data_dir = dirs::data_dir().context("Could not find data folder")?;
    let mut log_file = PathBuf::new();

    log_file.push(application_data_dir);
    log_file.push("gbfr-logs");
    std::fs::create_dir_all(log_file.as_path())?;
    log_file.push("gbfr-logs.txt");

    fern::Dispatch::new()
        .format(|out, message, record| {
            out.finish(format_args!(
                "[{} {}] {}",
                record.level(),
                record.target(),
                message
            ))
        })
        .level(log::LevelFilter::Info)
        .chain(fern::log_file(log_file)?)
        .apply()?;

    Ok(())
}

/// Log any panic (location + message) to the fern log before it unwinds. A panic inside a
/// detour would otherwise unwind across the FFI boundary into game code (UB) and typically
/// manifests as a silent game freeze with NO record — the log just stops mid-stream. With
/// this hook a future fault that IS a Rust panic leaves a `[ERROR] hook panic: ...` line
/// pointing at the exact file:line, turning a silent freeze into a diagnosable event.
fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown>".to_string());

        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "<non-string panic payload>".to_string());

        log::error!("hook panic at {location}: {message}");
    }));
}

// Not in test builds: the ctor would run inside the test process — sigscanning
// the test binary and creating the app's named pipe are both unwanted there.
#[cfg(not(test))]
#[ctor::ctor]
fn entry() {
    #[cfg(feature = "console")]
    unsafe {
        let _ = windows::Win32::System::Console::AllocConsole();
    }

    let _ = initialize_logger();
    install_panic_hook();
    std::thread::spawn(setup);
}
