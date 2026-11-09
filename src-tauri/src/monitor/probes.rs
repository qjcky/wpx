//! Сетевые проверки. Все — короткие, с таймаутами, ничего не меняют в системе.
//!
//! - `tunnel`: реальный запрос через туннель (как ходит любое приложение ПК).
//! - `leg_http` / `leg_socks`: прямое рукопожатие с прокси по каждому порту
//!   (адрес прокси исключён из TUN, роутер пускает только его) — показывает,
//!   жив ли сам сервер и какой протокол отвечает быстрее.
//! - `direct_escape`: попытка выйти в интернет МИМО туннеля с адреса
//!   физического адаптера. Успех = дыра в kill switch.

use base64::Engine;
use serde::Serialize;
use std::net::{IpAddr, SocketAddr};
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::timeout;

use crate::config::Creds;

pub const TUNNEL_HOST: &str = "www.gstatic.com";
const PROBE_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Clone, Debug, Serialize, Default)]
pub struct LegResult {
    pub ok: bool,
    /// TCP-рукопожатие с прокси, мс.
    pub connect_ms: Option<u32>,
    /// До готового туннеля к цели (вкл. авторизацию), мс.
    pub ready_ms: Option<u32>,
    pub err: Option<String>,
}

fn ms(t: Instant) -> u32 {
    t.elapsed().as_millis().min(u32::MAX as u128) as u32
}

async fn connect(addr: (&str, u16)) -> Result<(TcpStream, u32), String> {
    let t = Instant::now();
    match timeout(PROBE_TIMEOUT, TcpStream::connect(addr)).await {
        Ok(Ok(s)) => {
            let _ = s.set_nodelay(true);
            Ok((s, ms(t)))
        }
        Ok(Err(e)) => Err(short_io(&e)),
        Err(_) => Err("нет ответа (таймаут)".into()),
    }
}

fn short_io(e: &std::io::Error) -> String {
    use std::io::ErrorKind::*;
    match e.kind() {
        ConnectionRefused => "соединение отклонено".into(),
        ConnectionReset => "соединение сброшено".into(),
        TimedOut => "нет ответа (таймаут)".into(),
        _ => e.to_string(),
    }
}

async fn read_until_head<S: AsyncRead + Unpin>(s: &mut S) -> Result<Vec<u8>, String> {
    let mut buf = Vec::with_capacity(512);
    let mut chunk = [0u8; 512];
    loop {
        let n = s.read(&mut chunk).await.map_err(|e| short_io(&e))?;
        if n == 0 {
            return Err("сервер закрыл соединение".into());
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.windows(4).any(|w| w == b"\r\n\r\n") || buf.len() > 16384 {
            return Ok(buf);
        }
    }
}

fn status_code(head: &[u8]) -> Option<u16> {
    let line = head.split(|&b| b == b'\n').next()?;
    let line = String::from_utf8_lossy(line);
    line.split_whitespace().nth(1)?.parse().ok()
}

/// TLS к HTTPS-прокси: имя для сертификата (пусто — адрес сервера) и
/// «не проверять сертификат» (самоподписанный у своего прокси).
#[derive(Clone, Debug, Default)]
pub struct Tls {
    pub sni: String,
    pub insecure: bool,
}

use tokio_rustls::rustls::{self, client::danger, pki_types as pki};

/// Проверка сертификата отключена — только по явной галочке пользователя;
/// подписи рукопожатия всё равно проверяются.
#[derive(Debug)]
struct AcceptAny(std::sync::Arc<rustls::crypto::CryptoProvider>);
impl danger::ServerCertVerifier for AcceptAny {
    fn verify_server_cert(&self, _: &pki::CertificateDer<'_>, _: &[pki::CertificateDer<'_>], _: &pki::ServerName<'_>, _: &[u8], _: pki::UnixTime)
        -> Result<danger::ServerCertVerified, rustls::Error> {
        Ok(danger::ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(&self, m: &[u8], c: &pki::CertificateDer<'_>, d: &rustls::DigitallySignedStruct) -> Result<danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(m, c, d, &self.0.signature_verification_algorithms)
    }
    fn verify_tls13_signature(&self, m: &[u8], c: &pki::CertificateDer<'_>, d: &rustls::DigitallySignedStruct) -> Result<danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(m, c, d, &self.0.signature_verification_algorithms)
    }
    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

async fn tls_wrap(s: TcpStream, server: &str, tls: &Tls) -> Result<tokio_rustls::client::TlsStream<TcpStream>, String> {
    let provider = std::sync::Arc::new(rustls::crypto::ring::default_provider());
    let builder = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?;
    let cfg = if tls.insecure {
        builder.dangerous().with_custom_certificate_verifier(std::sync::Arc::new(AcceptAny(provider))).with_no_client_auth()
    } else {
        let roots = rustls::RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() };
        builder.with_root_certificates(roots).with_no_client_auth()
    };
    let host = if tls.sni.trim().is_empty() { server.to_string() } else { tls.sni.trim().to_string() };
    let name = pki::ServerName::try_from(host).map_err(|_| "неверное имя для сертификата (SNI)".to_string())?;
    tokio_rustls::TlsConnector::from(std::sync::Arc::new(cfg)).connect(name, s).await.map_err(|e| {
        let t = e.to_string();
        if t.to_ascii_lowercase().contains("certificate") { format!("сертификат не прошёл проверку: {t}") } else { format!("TLS: {t}") }
    })
}

async fn http_connect<S: AsyncRead + AsyncWrite + Unpin>(s: &mut S, creds: &Creds) -> Result<(), String> {
    let auth = base64::engine::general_purpose::STANDARD
        .encode(format!("{}:{}", creds.user, creds.pass));
    let req = format!(
        "CONNECT {TUNNEL_HOST}:443 HTTP/1.1\r\nHost: {TUNNEL_HOST}:443\r\nProxy-Authorization: Basic {auth}\r\n\r\n"
    );
    s.write_all(req.as_bytes()).await.map_err(|e| short_io(&e))?;
    let head = read_until_head(s).await?;
    match status_code(&head) {
        Some(200) => Ok(()),
        Some(407) => Err("неверный логин/пароль (407)".to_string()),
        Some(c) => Err(format!("прокси ответил {c}")),
        None => Err("непонятный ответ прокси".into()),
    }
}

/// HTTP CONNECT к www.gstatic.com:443 через прокси с Basic-авторизацией;
/// `tls` — HTTPS-прокси (тот же CONNECT внутри TLS).
pub async fn leg_http(server: &str, port: u16, creds: &Creds, tls: Option<&Tls>) -> LegResult {
    let t = Instant::now();
    let run = async {
        let (s, c_ms) = connect((server, port)).await?;
        match tls {
            Some(tls) => http_connect(&mut tls_wrap(s, server, tls).await?, creds).await?,
            None => http_connect(&mut { s }, creds).await?,
        }
        Ok(c_ms)
    };
    finish(t, timeout(PROBE_TIMEOUT, run).await).await
}

/// SOCKS5 с авторизацией логин/пароль (RFC 1929), CONNECT к www.gstatic.com:443.
pub async fn leg_socks(server: &str, port: u16, creds: &Creds) -> LegResult {
    let t = Instant::now();
    let run = async {
        let (mut s, c_ms) = connect((server, port)).await?;
        let io = |e: std::io::Error| short_io(&e);
        s.write_all(&[5, 1, 2]).await.map_err(io)?;
        let mut r = [0u8; 2];
        s.read_exact(&mut r).await.map_err(io)?;
        if r != [5, 2] {
            return Err(format!("SOCKS: метод не принят ({:?})", r));
        }
        let (u, p) = (creds.user.as_bytes(), creds.pass.as_bytes());
        if u.len() > 255 || p.len() > 255 {
            return Err("слишком длинный логин/пароль".into());
        }
        let mut auth = vec![1, u.len() as u8];
        auth.extend_from_slice(u);
        auth.push(p.len() as u8);
        auth.extend_from_slice(p);
        s.write_all(&auth).await.map_err(io)?;
        s.read_exact(&mut r).await.map_err(io)?;
        if r[1] != 0 {
            return Err("неверный логин/пароль".into());
        }
        let h = TUNNEL_HOST.as_bytes();
        let mut req = vec![5, 1, 0, 3, h.len() as u8];
        req.extend_from_slice(h);
        req.extend_from_slice(&443u16.to_be_bytes());
        s.write_all(&req).await.map_err(io)?;
        let mut rep = [0u8; 4];
        s.read_exact(&mut rep).await.map_err(io)?;
        if rep[1] != 0 {
            return Err(format!("SOCKS: цель недоступна (код {})", rep[1]));
        }
        Ok(c_ms)
    };
    finish(t, timeout(PROBE_TIMEOUT, run).await).await
}

async fn finish(
    t: Instant,
    r: Result<Result<u32, String>, tokio::time::error::Elapsed>,
) -> LegResult {
    match r {
        Ok(Ok(c_ms)) => LegResult {
            ok: true,
            connect_ms: Some(c_ms),
            ready_ms: Some(ms(t)),
            err: None,
        },
        Ok(Err(e)) => LegResult { ok: false, err: Some(e), ..Default::default() },
        Err(_) => LegResult {
            ok: false,
            err: Some("нет ответа за 8 с".into()),
            ..Default::default()
        },
    }
}

/// Простой HTTP GET по обычной маршрутизации ПК (т.е. через TUN).
/// Возвращает (код, тело, мс).
pub(crate) async fn plain_get(host: &str, path: &str) -> Result<(u16, String, u32), String> {
    let t = Instant::now();
    let run = async {
        let (mut s, _) = connect((host, 80)).await?;
        let req = format!(
            "GET {path} HTTP/1.1\r\nHost: {host}\r\nUser-Agent: wpx\r\nConnection: close\r\n\r\n"
        );
        s.write_all(req.as_bytes()).await.map_err(|e| short_io(&e))?;
        let mut buf = Vec::new();
        s.read_to_end(&mut buf).await.map_err(|e| short_io(&e))?;
        // Пустой ответ = движок принял соединение, но не смог пройти через
        // прокси и закрыл его (fake-ip: локальное рукопожатие всегда успешно).
        let code = status_code(&buf).ok_or("туннель закрыл соединение без ответа")?;
        let body = buf
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .map(|i| String::from_utf8_lossy(&buf[i + 4..]).trim().to_string())
            .unwrap_or_default();
        Ok::<_, String>((code, body))
    };
    match timeout(PROBE_TIMEOUT, run).await {
        Ok(Ok((c, b))) => Ok((c, b, ms(t))),
        Ok(Err(e)) => Err(e),
        Err(_) => Err("нет ответа за 8 с".into()),
    }
}

/// Запрос через туннель: задержка «как у приложений». Ok(мс) / Err(причина).
pub async fn tunnel() -> Result<u32, String> {
    match plain_get(TUNNEL_HOST, "/generate_204").await {
        Ok((204, _, m)) => Ok(m),
        Ok((c, _, _)) => Err(format!("неожиданный ответ {c}")),
        Err(e) => Err(e),
    }
}

/// Внешний IP, каким его видит интернет (через туннель).
pub async fn external_ip() -> Result<String, String> {
    let mut last = String::new();
    for host in ["api.ipify.org", "icanhazip.com"] {
        match plain_get(host, "/").await {
            Ok((200, body, _)) if body.parse::<IpAddr>().is_ok() => return Ok(body),
            Ok((c, _, _)) => last = format!("{host}: ответ {c}"),
            Err(e) => last = format!("{host}: {e}"),
        }
    }
    Err(last)
}

/// Попытка выйти напрямую мимо TUN: сокет привязывается к адресу физического
/// адаптера (strong host model Windows ведёт его в тот же интерфейс) и
/// стучится на 1.1.1.1:443. `true` — получилось, т.е. kill switch дырявый.
pub async fn direct_escape(local: IpAddr) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || {
        use socket2::{Domain, Protocol, Socket, Type};
        let sock = Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP))
            .map_err(|e| e.to_string())?;
        sock.bind(&SocketAddr::new(local, 0).into())
            .map_err(|e| format!("bind {local}: {e}"))?;
        let target: SocketAddr = "1.1.1.1:443".parse().unwrap();
        Ok(sock.connect_timeout(&target.into(), Duration::from_secs(3)).is_ok())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_status() {
        assert_eq!(status_code(b"HTTP/1.1 200 Connection established\r\n\r\n"), Some(200));
        assert_eq!(status_code(b"HTTP/1.0 407 Proxy Auth\r\n"), Some(407));
        assert_eq!(status_code(b"garbage"), None);
    }
}
