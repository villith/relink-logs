//! Shared one-shot RPC client framing for the hook's request/response
//! channels (the toolbox tools and the dev control/eject channel).
//!
//! One request per connection: connect, send one length-delimited bincode
//! frame, read one frame, close. Transport is selected exactly like
//! `connect_event_stream` in main.rs — named pipe on native Windows, TCP
//! under `GBFR_LOGS_FORCE_TCP=1` and on Linux/Wine.

use anyhow::{bail, Context, Result};
use futures::{SinkExt, StreamExt};
use serde::de::DeserializeOwned;
use serde::Serialize;
use std::time::Duration;
use tokio_util::codec::{Framed, LengthDelimitedCodec};

async fn exchange<S, Req, Resp>(stream: S, req: &Req) -> Result<Resp>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    Req: Serialize,
    Resp: DeserializeOwned,
{
    let mut framed = Framed::new(stream, LengthDelimitedCodec::new());
    framed
        .send(protocol::bincode::serialize(req)?.into())
        .await?;
    match framed.next().await {
        Some(Ok(frame)) => Ok(protocol::bincode::deserialize(&frame)?),
        Some(Err(e)) => Err(e.into()),
        None => bail!("rpc channel closed before responding"),
    }
}

async fn call_inner<Req, Resp>(pipe_name: &str, tcp_addr: &str, req: &Req) -> Result<Resp>
where
    Req: Serialize,
    Resp: DeserializeOwned,
{
    #[cfg(windows)]
    if std::env::var("GBFR_LOGS_FORCE_TCP").as_deref() != Ok("1") {
        use interprocess::os::windows::named_pipe::{pipe_mode, tokio::DuplexPipeStream};
        let stream = DuplexPipeStream::<pipe_mode::Bytes>::connect_by_path(pipe_name).await?;
        return exchange(stream, req).await;
    }
    #[cfg(not(windows))]
    let _ = pipe_name;
    let stream = tokio::net::TcpStream::connect(tcp_addr).await?;
    exchange(stream, req).await
}

/// Send one request and await the response, bounded by `timeout` so a wedged
/// hook (or frozen game) can never hang a caller.
pub async fn call<Req, Resp>(
    pipe_name: &str,
    tcp_addr: &str,
    timeout: Duration,
    req: Req,
) -> Result<Resp>
where
    Req: Serialize,
    Resp: DeserializeOwned,
{
    tokio::time::timeout(timeout, call_inner(pipe_name, tcp_addr, &req))
        .await
        .context("rpc timed out")?
}
