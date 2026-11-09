//! SSH к своим серверам (russh, без внешних программ).
//!
//! - Пароль нужен один раз — поставить ключ wpx; сам пароль нигде не хранится.
//! - Ключ сервера сверяется с отпечатком, который пользователь подтвердил при
//!   добавлении (`fingerprint` узнаёт его, ничего не отправляя); дальше он
//!   запомнен, и если сменился — отказ до отправки пароля (возможна подмена).
//! - Соединение идёт мимо туннеля: сокет привязан к адресу физического
//!   адаптера (как `ssh -b`), — либо через другой свой сервер (прыжок по
//!   `direct-tcpip`, как `ssh -J`), если напрямую до сервера не достать.

use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client::{self, Handle};
use russh::keys::{HashAlg, PrivateKey, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::ChannelMsg;

pub enum Auth {
    Password(String),
    Key(Arc<PrivateKey>),
}

/// Как дойти до сервера.
pub enum Route<'a> {
    /// Напрямую; `bind` — адрес физического адаптера (мимо туннеля).
    Direct { bind: Option<IpAddr> },
    /// Через уже открытую сессию другого сервера.
    Jump(&'a Session),
}

struct Client {
    /// Ожидаемый отпечаток (`SHA256:…`); `probe` — только узнать ключ:
    /// принять его нельзя, и до пароля или ключа wpx дело не доходит.
    expected: Option<String>,
    probe: bool,
    seen: Arc<Mutex<Option<String>>>,
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let fp = match key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.fingerprint(HashAlg::Sha256).to_string(),
            PublicKeyOrCertificate::Certificate(c) => c.public_key().fingerprint(HashAlg::Sha256).to_string(),
        };
        *self.seen.lock().unwrap() = Some(fp.clone());
        if self.probe {
            return Ok(false);
        }
        Ok(self.expected.as_deref().is_some_and(|e| same_fingerprint(e, &fp)))
    }
}

pub struct Session {
    handle: Handle<Client>,
    /// Отпечаток ключа сервера (`SHA256:…`).
    pub host_key: String,
}

pub struct Output {
    pub code: u32,
    pub out: String,
    pub err: String,
}

impl Output {
    /// Последняя непустая строка stderr/stdout — для сообщения об ошибке.
    pub fn reason(&self) -> String {
        let pick = |s: &str| s.lines().rev().find(|l| !l.trim().is_empty()).map(|l| l.trim().to_string());
        pick(&self.err).or_else(|| pick(&self.out)).unwrap_or_else(|| format!("код {}", self.code))
    }
}

fn config() -> Arc<client::Config> {
    Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(300)),
        keepalive_interval: Some(Duration::from_secs(20)),
        nodelay: true,
        ..Default::default()
    })
}

async fn tcp(addr: SocketAddr, bind: Option<IpAddr>) -> Result<tokio::net::TcpStream, String> {
    let sock = if addr.is_ipv4() { tokio::net::TcpSocket::new_v4() } else { tokio::net::TcpSocket::new_v6() }.map_err(|e| e.to_string())?;
    if let Some(ip) = bind.filter(|ip| ip.is_ipv4() == addr.is_ipv4()) {
        sock.bind(SocketAddr::new(ip, 0)).map_err(|e| format!("привязка к {ip}: {e}"))?;
    }
    match tokio::time::timeout(Duration::from_secs(10), sock.connect(addr)).await {
        Ok(Ok(s)) => Ok(s),
        Ok(Err(e)) => Err(format!("{addr}: {e}")),
        Err(_) => Err(format!("{addr}: нет ответа за 10 с")),
    }
}

// ─── Отпечаток ключа сервера ─────────────────────────────────────

/// Отпечаток к одному виду `SHA256:<base64 без «=»>`. Понимает и вывод
/// `ssh-keygen -lf` («256 SHA256:… root@host (ED25519)»), и голый base64.
pub fn norm_fingerprint(s: &str) -> Option<String> {
    let b64 = |t: &str| t.len() >= 40 && t.chars().all(|c| c.is_ascii_alphanumeric() || "+/-_=".contains(c));
    s.split_whitespace().map(|t| t.trim_matches(|c| ",;()[]".contains(c))).find_map(|t| {
        let v = match t.split_once(':') {
            Some((p, v)) if p.eq_ignore_ascii_case("sha256") => v,
            Some(_) => return None,
            None => t,
        };
        b64(v).then(|| format!("SHA256:{}", v.trim_end_matches('=')))
    })
}

/// Один и тот же ключ (с точностью до записи).
pub fn same_fingerprint(a: &str, b: &str) -> bool {
    match (norm_fingerprint(a), norm_fingerprint(b)) {
        (Some(x), Some(y)) => x == y,
        _ => false,
    }
}

/// Рукопожатие до проверки ключа сервера. Возвращает исход russh и
/// отпечаток, который сервер показал (пусто — не дошли до ключа).
async fn handshake(host: &str, port: u16, route: Route<'_>, expected: Option<&str>, probe: bool) -> Result<(Result<Handle<Client>, russh::Error>, String), String> {
    let seen = Arc::new(Mutex::new(None));
    let h = Client { expected: expected.map(String::from), probe, seen: seen.clone() };
    let res = match route {
        Route::Direct { bind } => {
            let ip: IpAddr = host.parse().map_err(|_| format!("«{host}» — нужен IP-адрес"))?;
            let s = tcp(SocketAddr::new(ip, port), bind).await?;
            tokio::time::timeout(Duration::from_secs(20), client::connect_stream(config(), s, h)).await
        }
        Route::Jump(j) => {
            let ch = j
                .handle
                .channel_open_direct_tcpip(host, port as u32, "127.0.0.1", 0)
                .await
                .map_err(|e| format!("сервер-посредник не открыл путь до {host}:{port}: {e}"))?;
            tokio::time::timeout(Duration::from_secs(20), client::connect_stream(config(), ch.into_stream(), h)).await
        }
    };
    let fp = seen.lock().unwrap().clone().unwrap_or_default();
    match res {
        Err(_) => Err(format!("{host}: SSH не ответил за 20 с")),
        Ok(r) => Ok((r, fp)),
    }
}

/// Узнать отпечаток ключа сервера, не входя: ключ не принимается, пароль и
/// ключ wpx не отправляются. Пользователь сверяет его в панели хостинга.
pub async fn fingerprint(host: &str, port: u16, route: Route<'_>) -> Result<String, String> {
    let (res, fp) = handshake(host, port, route, None, true).await?;
    match res {
        Ok(h) => {
            let _ = h.disconnect(russh::Disconnect::ByApplication, "", "en").await;
            if fp.is_empty() {
                return Err(format!("{host}: сервер не показал ключ"));
            }
        }
        Err(e) if fp.is_empty() => return Err(format!("{host}: {e}")),
        Err(_) => {}
    }
    Ok(fp)
}

/// Подключиться и войти. `known` — отпечаток ключа сервера: подтверждённый
/// пользователем при добавлении или запомненный. Не совпал — отказ до входа.
pub async fn connect(host: &str, port: u16, user: &str, auth: &Auth, known: &str, route: Route<'_>) -> Result<Session, String> {
    if norm_fingerprint(known).is_none() {
        return Err(format!("{host}: отпечаток ключа сервера не сохранён — удалите сервер в wpx и добавьте заново"));
    }
    let (res, host_key) = handshake(host, port, route, Some(known), false).await?;
    let mut handle = match res {
        Err(e) => {
            if !host_key.is_empty() && !same_fingerprint(known, &host_key) {
                return Err(format!(
                    "Ключ сервера {host} изменился (был {known}, сейчас {host_key}). Возможна подмена — подключение прервано. Если сервер переустанавливали, удалите его в wpx и добавьте заново."
                ));
            }
            return Err(format!("{host}: {e}"));
        }
        Ok(h) => h,
    };
    let ok = match auth {
        Auth::Password(p) => handle.authenticate_password(user, p.clone()).await,
        Auth::Key(k) => {
            let hash = if k.algorithm().is_rsa() { handle.best_supported_rsa_hash().await.ok().flatten().flatten() } else { None };
            handle.authenticate_publickey(user, PrivateKeyWithHashAlg::new(k.clone(), hash)).await
        }
    }
    .map_err(|e| format!("{host}: {e}"))?;
    if !ok.success() {
        return Err(match auth {
            Auth::Password(_) => format!("{user}@{host}: неверный пароль или вход по паролю запрещён"),
            Auth::Key(_) => format!("{user}@{host}: сервер не принял ключ wpx"),
        });
    }
    Ok(Session { handle, host_key })
}

impl Session {
    /// Выполнить команду; `stdin` — тело скрипта или файла (секреты идут
    /// только так, не в командной строке).
    pub async fn run(&self, cmd: &str, stdin: &[u8], limit: Duration) -> Result<Output, String> {
        let job = async {
            let mut ch = self.handle.channel_open_session().await.map_err(|e| e.to_string())?;
            ch.exec(true, cmd).await.map_err(|e| e.to_string())?;
            if !stdin.is_empty() {
                ch.data(stdin).await.map_err(|e| e.to_string())?;
            }
            ch.eof().await.map_err(|e| e.to_string())?;
            let (mut out, mut err, mut code) = (Vec::new(), Vec::new(), None);
            while let Some(msg) = ch.wait().await {
                match msg {
                    ChannelMsg::Data { data } => out.extend_from_slice(&data),
                    ChannelMsg::ExtendedData { data, .. } => err.extend_from_slice(&data),
                    ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
                    _ => {}
                }
            }
            Ok::<_, String>(Output {
                code: code.unwrap_or(255),
                out: String::from_utf8_lossy(&out).into_owned(),
                err: String::from_utf8_lossy(&err).into_owned(),
            })
        };
        tokio::time::timeout(limit, job).await.map_err(|_| format!("команда не уложилась в {} с", limit.as_secs()))?
    }

    pub async fn close(self) {
        let _ = self.handle.disconnect(russh::Disconnect::ByApplication, "", "en").await;
    }
}

/// Новый ключ wpx (ed25519).
pub fn new_key() -> Result<PrivateKey, String> {
    use rand_core::RngCore;
    let mut seed = [0u8; 32];
    rand_core::OsRng.fill_bytes(&mut seed);
    let mut k = PrivateKey::from(russh::keys::ssh_key::private::Ed25519Keypair::from_seed(&seed));
    k.set_comment("wpx");
    Ok(k)
}

pub fn key_to_text(k: &PrivateKey) -> Result<String, String> {
    k.to_openssh(russh::keys::ssh_key::LineEnding::LF).map(|z| z.to_string()).map_err(|e| e.to_string())
}

pub fn key_from_text(s: &str) -> Result<PrivateKey, String> {
    PrivateKey::from_openssh(s).map_err(|e| format!("ключ: {e}"))
}

pub fn public_line(k: &PrivateKey) -> Result<String, String> {
    k.public_key().to_openssh().map_err(|e| e.to_string())
}

/// IPv4 физического адаптера (для выхода мимо туннеля).
pub fn phys_ip(alias: &str) -> Option<IpAddr> {
    crate::platform::iface_ipv4(alias)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_roundtrip() {
        let k = new_key().unwrap();
        let text = key_to_text(&k).unwrap();
        assert!(text.starts_with("-----BEGIN OPENSSH PRIVATE KEY-----"));
        let back = key_from_text(&text).unwrap();
        assert_eq!(public_line(&k).unwrap(), public_line(&back).unwrap());
        assert!(public_line(&k).unwrap().starts_with("ssh-ed25519 "));
    }

    #[test]
    fn fingerprints_compare_by_value() {
        let fp = "SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8";
        // Как показывает wpx, как печатает ssh-keygen -lf, с «=», голый base64.
        assert!(same_fingerprint(fp, &format!("256 {fp} root@vps (ED25519)")));
        assert!(same_fingerprint(fp, &format!("{fp}=")));
        assert!(same_fingerprint(fp, "nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8"));
        assert!(same_fingerprint(fp, &format!("  sha256:{} ", &fp[7..])));
        // Другой ключ, мусор, пусто — не совпадают.
        assert!(!same_fingerprint(fp, "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"));
        assert!(!same_fingerprint(fp, "MD5:aa:bb:cc"));
        assert!(!same_fingerprint(fp, ""));
        assert!(!same_fingerprint("", ""));
        assert_eq!(norm_fingerprint("ключ не найден"), None);
        assert_eq!(norm_fingerprint(&format!("{fp}==")).as_deref(), Some(fp));
    }

    /// Живая проверка (только чтение): `WPX_SSH_KEY=<файл ключа>
    /// WPX_SSH_HOST=<ip> [WPX_SSH_JUMP=<ip>] WPX_SSH_BIND=<ip> cargo test -- --ignored live`.
    /// Отпечатки сначала узнаются без входа, потом вход — с ними.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn live() {
        let env = |k: &str| std::env::var(k).ok();
        let key = Arc::new(russh::keys::load_secret_key(env("WPX_SSH_KEY").unwrap(), None).unwrap());
        let bind = env("WPX_SSH_BIND").and_then(|s| s.parse().ok());
        let host = env("WPX_SSH_HOST").unwrap();
        let (jump, target) = match env("WPX_SSH_JUMP") {
            Some(j) => {
                let jf = fingerprint(&j, 22, Route::Direct { bind }).await.unwrap();
                let js = connect(&j, 22, "root", &Auth::Key(key.clone()), &jf, Route::Direct { bind }).await.unwrap();
                println!("jump {j}: {}", js.host_key);
                let tf = fingerprint(&host, 22, Route::Jump(&js)).await.unwrap();
                let s = connect(&host, 22, "root", &Auth::Key(key.clone()), &tf, Route::Jump(&js)).await.unwrap();
                (Some(js), s)
            }
            None => {
                let tf = fingerprint(&host, 22, Route::Direct { bind }).await.unwrap();
                (None, connect(&host, 22, "root", &Auth::Key(key), &tf, Route::Direct { bind }).await.unwrap())
            }
        };
        println!("{host}: {}", target.host_key);
        let o = target.run("bash -s", b"hostname; . /etc/os-release; echo $PRETTY_NAME; echo stdin-ok", Duration::from_secs(20)).await.unwrap();
        println!("code {} out {:?} err {:?}", o.code, o.out, o.err);
        assert_eq!(o.code, 0);
        target.close().await;
        if let Some(j) = jump {
            j.close().await;
        }
    }
}
