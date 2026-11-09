//! Диагностика: проверка утечек в один клик и отчёт для поддержки.
//!
//! Утечки проверяются так же, как их видят сайты, но без чужих сервисов
//! проверки: свой запрос IP (Cloudflare trace), свой DNS-запрос к 8.8.8.8,
//! свой STUN-запрос (то, что делает WebRTC в браузере), попытка IPv6 и выход
//! мимо туннеля. Только чтение — систему и движок не трогает.
//!
//! Отчёт — текстовый файл в «Загрузках»: версия, движок, профиль (без ключей),
//! защита, события, простои, утечки, ошибки движка. Внешние адреса и сайты
//! по умолчанию замаскированы.

use serde::Serialize;
use std::fmt::Write as _;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;
use tauri::Manager;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::time::timeout;

use crate::config;
use crate::monitor::{self, now_ms};
use crate::monitor::probes;
use crate::platform::Hidden;

#[derive(Serialize, Clone)]
pub struct LeakItem {
    pub key: &'static str,
    pub title: &'static str,
    /// "ok" | "leak" | "unknown"
    pub verdict: &'static str,
    pub detail: String,
}

#[derive(Serialize, Clone)]
pub struct LeakCheck {
    pub at: i64,
    /// "ok" | "leak" | "unknown"
    pub verdict: &'static str,
    pub summary: String,
    pub items: Vec<LeakItem>,
}

const T: Duration = Duration::from_secs(4);

// ─── Запросы ─────────────────────────────────────────────────────

/// `ip=` и `loc=` из ответа Cloudflare `/cdn-cgi/trace`.
fn trace(body: &str) -> Option<(String, String)> {
    let get = |k: &str| body.lines().find_map(|l| l.strip_prefix(k)).map(|v| v.trim().to_string());
    Some((get("ip=")?, get("loc=").unwrap_or_default()))
}

/// Внешний адрес обычным путём ПК (через туннель) — как его видят сайты.
async fn exit_ip() -> Result<(String, String), String> {
    match probes::plain_get("www.cloudflare.com", "/cdn-cgi/trace").await {
        Ok((200, body, _)) => trace(&body).ok_or_else(|| "непонятный ответ".to_string()),
        _ => probes::external_ip().await.map(|ip| (ip, String::new())),
    }
}

/// Адрес провайдера: запрос с адреса физического адаптера мимо туннеля.
/// Закрыто (kill switch) — `None`, и это хорошо.
async fn isp_ip(local: IpAddr) -> Option<String> {
    tokio::task::spawn_blocking(move || {
        use socket2::{Domain, Protocol, Socket, Type};
        use std::io::{Read, Write};
        let s = Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP)).ok()?;
        s.bind(&SocketAddr::new(local, 0).into()).ok()?;
        s.connect_timeout(&SocketAddr::from(([1, 1, 1, 1], 80)).into(), Duration::from_secs(3)).ok()?;
        let mut t: std::net::TcpStream = s.into();
        t.set_read_timeout(Some(Duration::from_secs(4))).ok()?;
        t.write_all(b"GET /cdn-cgi/trace HTTP/1.1\r\nHost: 1.1.1.1\r\nUser-Agent: wpx\r\nConnection: close\r\n\r\n").ok()?;
        let mut buf = Vec::new();
        let _ = t.read_to_end(&mut buf);
        trace(&String::from_utf8_lossy(&buf)).map(|(ip, _)| ip)
    })
    .await
    .ok()
    .flatten()
}

/// IPv6 обычным путём: соединение с IPv6-адресом Cloudflare и его trace.
/// `Ok(None)` — IPv6 наружу не выходит.
async fn ipv6_path() -> Result<Option<String>, String> {
    let addr: SocketAddr = "[2606:4700:4700::1111]:80".parse().unwrap();
    let mut s = match timeout(Duration::from_secs(3), tokio::net::TcpStream::connect(addr)).await {
        Ok(Ok(s)) => s,
        _ => return Ok(None),
    };
    let run = async {
        s.write_all(b"GET /cdn-cgi/trace HTTP/1.1\r\nHost: one.one.one.one\r\nUser-Agent: wpx\r\nConnection: close\r\n\r\n").await?;
        let mut buf = Vec::new();
        s.read_to_end(&mut buf).await?;
        Ok::<_, std::io::Error>(buf)
    };
    match timeout(T, run).await {
        Ok(Ok(buf)) => Ok(trace(&String::from_utf8_lossy(&buf)).map(|(ip, _)| ip)),
        _ => Ok(None),
    }
}

/// Глобальные IPv6 физического адаптера (есть ли IPv6 у провайдера вообще).
fn phys_v6(alias: &str) -> Vec<String> {
    crate::platform::iface_ipv6(alias)
}

fn dns_query(name: &str, id: u16) -> Vec<u8> {
    let mut q = vec![(id >> 8) as u8, id as u8, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0];
    for l in name.split('.') {
        q.push(l.len() as u8);
        q.extend(l.as_bytes());
    }
    q.extend([0, 0, 1, 0, 1]);
    q
}

/// Первая A-запись ответа DNS.
fn dns_answer(r: &[u8]) -> Option<Ipv4Addr> {
    let skip_name = |mut i: usize| -> Option<usize> {
        loop {
            let l = *r.get(i)? as usize;
            if l == 0 {
                return Some(i + 1);
            }
            if l & 0xc0 == 0xc0 {
                return Some(i + 2);
            }
            i += l + 1;
        }
    };
    let an = u16::from_be_bytes([*r.get(6)?, *r.get(7)?]);
    let mut i = skip_name(12)? + 4;
    for _ in 0..an {
        i = skip_name(i)?;
        let ty = u16::from_be_bytes([*r.get(i)?, *r.get(i + 1)?]);
        let len = u16::from_be_bytes([*r.get(i + 8)?, *r.get(i + 9)?]) as usize;
        if ty == 1 && len == 4 {
            return Some(Ipv4Addr::new(*r.get(i + 10)?, *r.get(i + 11)?, *r.get(i + 12)?, *r.get(i + 13)?));
        }
        i += 10 + len;
    }
    None
}

/// DNS-запрос к 8.8.8.8 напрямую (как делают программы со своим DNS).
async fn dns_direct() -> Result<Option<Ipv4Addr>, String> {
    let s = tokio::net::UdpSocket::bind("0.0.0.0:0").await.map_err(|e| e.to_string())?;
    s.send_to(&dns_query("www.google.com", 0x5770), "8.8.8.8:53").await.map_err(|e| e.to_string())?;
    let mut buf = [0u8; 512];
    match timeout(Duration::from_secs(3), s.recv(&mut buf)).await {
        Ok(Ok(n)) => Ok(dns_answer(&buf[..n])),
        _ => Ok(None),
    }
}

/// Адрес из ответа STUN (XOR-MAPPED-ADDRESS, иначе MAPPED-ADDRESS).
fn stun_addr(r: &[u8]) -> Option<Ipv4Addr> {
    if r.len() < 20 || r[0..2] != [0x01, 0x01] {
        return None;
    }
    let mut i = 20;
    while i + 4 <= r.len() {
        let ty = u16::from_be_bytes([r[i], r[i + 1]]);
        let len = u16::from_be_bytes([r[i + 2], r[i + 3]]) as usize;
        let v = r.get(i + 4..i + 4 + len)?;
        if len >= 8 && v[1] == 1 {
            let a = [v[4], v[5], v[6], v[7]];
            match ty {
                0x0020 => return Some(Ipv4Addr::new(a[0] ^ 0x21, a[1] ^ 0x12, a[2] ^ 0xa4, a[3] ^ 0x42)),
                0x0001 => return Some(Ipv4Addr::from(a)),
                _ => {}
            }
        }
        i += 4 + len.div_ceil(4) * 4;
    }
    None
}

/// STUN — то, чем WebRTC в браузере узнаёт «свой» адрес.
async fn stun() -> Result<Option<Ipv4Addr>, String> {
    for host in ["stun.l.google.com:19302", "stun.cloudflare.com:3478"] {
        let Ok(Ok(mut addrs)) = timeout(Duration::from_secs(3), tokio::net::lookup_host(host)).await else { continue };
        let Some(to) = addrs.find(|a| a.is_ipv4()) else { continue };
        let s = tokio::net::UdpSocket::bind("0.0.0.0:0").await.map_err(|e| e.to_string())?;
        let mut req = vec![0x00, 0x01, 0x00, 0x00, 0x21, 0x12, 0xa4, 0x42];
        let mut tid = [0u8; 12];
        rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut tid);
        req.extend(tid);
        let _ = s.send_to(&req, to).await;
        let mut buf = [0u8; 512];
        if let Ok(Ok(n)) = timeout(Duration::from_secs(3), s.recv(&mut buf)).await {
            if let Some(a) = stun_addr(&buf[..n]) {
                return Ok(Some(a));
            }
        }
    }
    Ok(None)
}

/// Адреса своих выходов: серверы профилей и свои VPS (с подписью).
fn known() -> Vec<(String, String)> {
    let mut v = vec![];
    for p in crate::profiles::load().profiles {
        if !p.server.is_empty() {
            v.push((p.server.clone(), p.name.clone()));
        }
        for e in &p.endpoints {
            v.push((e.ep.server.clone(), p.name.clone()));
        }
    }
    for s in crate::servers::load().servers {
        v.push((s.host.clone(), s.name.clone()));
    }
    v
}

fn is_fake(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    o[0] == 198 && (o[1] == 18 || o[1] == 19)
}

// ─── Проверка ────────────────────────────────────────────────────

pub async fn leaks() -> LeakCheck {
    let alias = crate::engine::netcfg::load().interface;
    let local = {
        let a = alias.clone();
        tokio::task::spawn_blocking(move || crate::servers::ssh::phys_ip(&a)).await.ok().flatten()
    };
    let a6 = alias.clone();
    let (exit, isp, escape, v6, v6_local, dns, rtc) = tokio::join!(
        exit_ip(),
        async { match local { Some(l) => isp_ip(l).await, None => None } },
        async { match local { Some(l) => probes::direct_escape(l).await.ok(), None => None } },
        ipv6_path(),
        async { tokio::task::spawn_blocking(move || phys_v6(&a6)).await.unwrap_or_default() },
        dns_direct(),
        stun(),
    );
    let known = known();
    let mine = |ip: &str| known.iter().find(|(h, _)| h == ip).map(|(_, n)| n.clone());
    let mut items = vec![];
    let item = |key, title, verdict, detail: String| LeakItem { key, title, verdict, detail };

    // Реальный IP.
    let exit_ip = exit.as_ref().ok().map(|(ip, _)| ip.clone());
    items.push(match (&exit, &isp) {
        (Err(e), _) => item("ip", "Ваш IP для сайтов", "unknown", format!("не узнать: {e}")),
        (Ok((ip, _)), Some(isp)) if ip == isp => item("ip", "Ваш IP для сайтов", "leak", format!("сайты видят ваш настоящий адрес {ip} — трафик идёт мимо VPN")),
        (Ok((ip, loc)), _) => {
            let place = if loc.is_empty() { String::new() } else { format!(", {loc}") };
            match mine(ip) {
                Some(n) => item("ip", "Ваш IP для сайтов", "ok", format!("{ip}{place} — адрес «{n}»")),
                None if isp.is_some() => item("ip", "Ваш IP для сайтов", "ok", format!("{ip}{place} — не адрес провайдера")),
                None => item("ip", "Ваш IP для сайтов", "ok", format!("{ip}{place} — выход VPN (прямой выход к провайдеру закрыт)")),
            }
        }
    });
    // Мимо туннеля.
    items.push(match escape {
        Some(false) => item("escape", "Выход мимо туннеля", "ok", "закрыт — если VPN упадёт, интернет не пойдёт напрямую".into()),
        Some(true) => item("escape", "Выход мимо туннеля", "leak", "открыт — при сбое VPN трафик пойдёт напрямую через провайдера".into()),
        None => item("escape", "Выход мимо туннеля", "unknown", "не удалось проверить (нет адреса физического адаптера)".into()),
    });
    // IPv6.
    let prefix = |a: &str| a.split(':').take(4).collect::<Vec<_>>().join(":");
    items.push(match v6 {
        Ok(Some(ip)) if v6_local.iter().any(|l| prefix(l) == prefix(&ip)) => item("ipv6", "IPv6", "leak", format!("идёт мимо VPN: сайты с IPv6 видят {ip}")),
        Ok(Some(ip)) => item("ipv6", "IPv6", "ok", format!("через туннель ({ip})")),
        _ if v6_local.is_empty() => item("ipv6", "IPv6", "ok", "у провайдера IPv6 нет — утечь нечему".into()),
        _ => item("ipv6", "IPv6", "ok", "закрыт: IPv6 у провайдера есть, но наружу не выходит".into()),
    });
    // DNS.
    items.push(match dns {
        Ok(Some(a)) if is_fake(a) => item("dns", "DNS", "ok", "запросы к любым DNS перехватывает wpx — провайдер не видит, какие сайты вы открываете".into()),
        Ok(Some(_)) if escape == Some(true) => item("dns", "DNS", "leak", "запрос к 8.8.8.8 ушёл мимо wpx — провайдер может видеть, какие сайты вы открываете".into()),
        Ok(Some(_)) => item("dns", "DNS", "ok", "запрос к 8.8.8.8 прошёл через туннель — провайдер его не видит".into()),
        Ok(None) => item("dns", "DNS", "ok", "сторонние DNS-серверы недоступны — запросы не утекают".into()),
        Err(e) => item("dns", "DNS", "unknown", e),
    });
    // WebRTC.
    items.push(match rtc {
        Ok(Some(a)) if isp.as_deref() == Some(&a.to_string()) => item("webrtc", "WebRTC (звонки в браузере)", "leak", format!("браузер может раскрыть настоящий адрес {a}")),
        Ok(Some(a)) => {
            let who = mine(&a.to_string()).map(|n| format!(" — адрес «{n}»")).or_else(|| (exit_ip.as_deref() == Some(&a.to_string())).then(|| " — тот же выход VPN".into())).unwrap_or_default();
            item("webrtc", "WebRTC (звонки в браузере)", "ok", format!("покажет {a}{who}"))
        }
        Ok(None) => item("webrtc", "WebRTC (звонки в браузере)", "ok", "UDP наружу закрыт — WebRTC адрес не выдаст".into()),
        Err(e) => item("webrtc", "WebRTC (звонки в браузере)", "unknown", e),
    });

    let leaks = items.iter().filter(|i| i.verdict == "leak").count();
    let unknown = items.iter().filter(|i| i.verdict == "unknown").count();
    let (verdict, summary) = if leaks > 0 {
        ("leak", format!("Найдено утечек: {leaks}"))
    } else if unknown > 0 {
        ("unknown", format!("Утечек не найдено, но {unknown} проверк{} не удалось провести", if unknown == 1 { "у" } else { "и" }))
    } else {
        ("ok", "Утечек нет".to_string())
    };
    LeakCheck { at: now_ms(), verdict, summary, items }
}

#[tauri::command]
pub async fn leak_check() -> LeakCheck {
    leaks().await
}

// ─── Отчёт для поддержки ─────────────────────────────────────────

/// Внешние IPv4 → `a.b.x.x`, сайты → `‹сайт›` (свои серверы — по имени).
fn mask(text: &str, known: &[(String, String)]) -> String {
    let mut out = String::new();
    for tok in text.split_inclusive(|c: char| c.is_whitespace() || "()[]{}<>,;\"'=".contains(c)) {
        let (word, tail) = tok.split_at(tok.trim_end_matches(|c: char| c.is_whitespace() || "()[]{}<>,;\"'=".contains(c)).len());
        let core = word.trim_end_matches(['.', ':']);
        let (host, rest) = match core.rsplit_once(':') {
            Some((h, p)) if p.chars().all(|c| c.is_ascii_digit()) && !h.contains(':') => (h, &word[h.len()..]),
            _ => (core, &word[core.len()..]),
        };
        let masked = if let Ok(ip) = host.parse::<Ipv4Addr>() {
            match known.iter().find(|(h, _)| h == host) {
                Some((_, n)) => format!("‹{n}›"),
                None if ip.is_private() || ip.is_loopback() || is_fake(ip) || ip.is_unspecified() => host.to_string(),
                None => format!("{}.{}.x.x", ip.octets()[0], ip.octets()[1]),
            }
        } else if host.contains('.')
            && host.rsplit('.').next().is_some_and(|tld| tld.len() >= 2 && tld.chars().all(|c| c.is_ascii_alphabetic()))
            && host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
            && !host.ends_with(".exe")
            && !host.ends_with(".json")
            && !host.ends_with(".yaml")
            && !host.ends_with(".log")
        {
            "‹сайт›".to_string()
        } else {
            host.to_string()
        };
        out.push_str(&masked);
        out.push_str(rest);
        out.push_str(tail);
    }
    out
}

fn when(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|d| d.with_timezone(&chrono::Local).format("%d.%m %H:%M:%S").to_string())
        .unwrap_or_default()
}

async fn build(app: Option<&tauri::AppHandle>, hide: bool) -> String {
    let (snap, outages) = match app.and_then(|a| a.try_state::<monitor::Shared>()) {
        Some(s) => s.with(|i| (Some(monitor::snapshot(i)), i.outages.iter().rev().take(30).cloned().collect::<Vec<_>>())),
        None => (None, vec![]),
    };
    let leaks = leaks().await;
    let known = known();
    let mut r = String::new();
    let _ = writeln!(r, "Отчёт wpx для поддержки — {}", chrono::Local::now().format("%d.%m.%Y %H:%M"));
    let _ = writeln!(r, "Ключи и пароли в отчёт не попадают.{}\n", if hide { " Внешние адреса и сайты замаскированы." } else { "" });
    let _ = writeln!(r, "wpx {}{}", env!("CARGO_PKG_VERSION"), if config::LAB { " (лаборатория)" } else { "" });
    let _ = writeln!(r, "Windows: {}", sysinfo::System::long_os_version().unwrap_or_default());

    let _ = writeln!(r, "\n== Сейчас ==");
    if let Some(s) = &snap {
        let _ = writeln!(r, "Состояние: {:?} с {}{}", s.health, when(s.health_since), s.cause.as_ref().map(|c| format!(" — {c}")).unwrap_or_default());
        let _ = writeln!(r, "Задержка: {}{}", s.last_ms.map(|m| format!("{m} мс")).unwrap_or("—".into()), s.last_err.as_ref().map(|e| format!(" · {e}")).unwrap_or_default());
        let _ = writeln!(r, "Движок: {:?} · работает {} · TUN {} · самовосстановление {}", s.engine_kind, s.engine.running, s.tun_device, if s.heal { "вкл" } else { "выкл" });
        if let Some(e) = &s.config_err {
            let _ = writeln!(r, "Ошибка конфига: {e}");
        }
        let _ = writeln!(r, "Профиль: {}", s.profile.clone().unwrap_or("—".into()));
        for l in &s.legs {
            let res = if l.result.ok { format!("✓ {} мс", l.result.ready_ms.unwrap_or(0)) } else { format!("✗ {}", l.result.err.clone().unwrap_or_default()) };
            let _ = writeln!(r, "  {} {:5} {} {}:{} {}{}", if l.active { "▶" } else { " " }, l.role, l.label, l.server, l.port, res, if l.kind.is_empty() { String::new() } else { format!(" [{}]", l.kind) });
        }
        let _ = writeln!(r, "\n== Защита ==");
        for g in &s.guard {
            let _ = writeln!(r, "  {} {} — {}", match g.ok { Some(true) => "✓", Some(false) => "✗", None => "?" }, g.label, g.detail);
        }
    }
    let _ = writeln!(r, "\n== Утечки: {} ==", leaks.summary);
    for i in &leaks.items {
        let _ = writeln!(r, "  {} {} — {}", match i.verdict { "ok" => "✓", "leak" => "✗", _ => "?" }, i.title, i.detail);
    }

    let net = crate::engine::netcfg::load();
    let _ = writeln!(r, "\n== Настройки сети ==");
    let _ = writeln!(r, "Режим: {} · UDP: {} · QUIC блок: {} · адаптер: {} · правил: {}", net.mode, net.udp, net.block_quic, net.interface, net.rules.len());
    for x in &net.rules {
        let _ = writeln!(r, "  {} {} → {}", x.kind, x.value, x.target);
    }

    let ps = crate::profiles::load();
    let _ = writeln!(r, "\n== Профили ==");
    for p in &ps.profiles {
        let kinds: Vec<String> = p.endpoints.iter().map(|e| format!("{:?} {}:{}", e.ep.kind, e.ep.server, e.ep.port)).collect();
        let what = if let Some(c) = &p.cascade { format!("каскад {} → {}", c.entry, c.exit) } else if !p.route.is_empty() { format!("маршрут из {}", p.route.len()) } else if kinds.is_empty() { format!("прокси {}", p.server) } else { kinds.join(", ") };
        let _ = writeln!(r, "  {}{} [{}] {}", if ps.active.as_deref() == Some(&p.id) { "▶ " } else { "  " }, p.name, p.mode, what);
    }
    let st = crate::servers::load();
    if !st.servers.is_empty() {
        let _ = writeln!(r, "\n== Свои серверы ==");
        for s in &st.servers {
            let f = s.facts.as_ref();
            let protos: Vec<String> = s.vless.iter().map(|v| format!("VLESS :{}", v.port)).chain(s.hy2.iter().map(|h| format!("Hy2 :{}", h.port))).chain(s.awg.iter().map(|a| format!("AWG :{}", a.port))).collect();
            let _ = writeln!(r, "  {} {} · {} · {} · {} · трубы {} · доступов {}", s.name, s.host, f.map(|f| f.os.as_str()).unwrap_or("?"), s.runtime, protos.join(", "), s.pipes.len(), s.guests.len());
        }
    }
    if let Some(s) = &snap {
        let _ = writeln!(r, "\n== События (последние 60) ==");
        for e in s.events.iter().rev().take(60) {
            let _ = writeln!(r, "  {} {:?}{} {}", when(e.t), e.kind, if e.count > 1 { format!(" ×{}", e.count) } else { String::new() }, e.text);
        }
    }
    if !outages.is_empty() {
        let _ = writeln!(r, "\n== Простои (последние 30) ==");
        for o in &outages {
            let d = o.end.map(|e| format!("{} с", (e - o.start) / 1000)).unwrap_or("идёт".into());
            let _ = writeln!(r, "  {} · {} · {}", when(o.start), d, o.cause);
        }
    }
    let log = config::active().log();
    if let Ok(t) = std::fs::read_to_string(&log) {
        let bad: Vec<&str> = t.lines().filter(|l| l.contains("level=error") || l.contains("level=warning") || l.contains("ERR") || l.contains("WRN")).collect();
        let _ = writeln!(r, "\n== Ошибки движка (последние 80 из {}) ==", bad.len());
        for l in &bad[bad.len().saturating_sub(80)..] {
            let _ = writeln!(r, "  {l}");
        }
    }
    if hide { mask(&r, &known) } else { r }
}

/// Сохранить отчёт в «Загрузки» и показать файл в проводнике.
#[tauri::command]
pub async fn support_report(app: tauri::AppHandle, hide: bool) -> Result<String, String> {
    let text = build(Some(&app), hide).await;
    let dir = std::path::PathBuf::from(std::env::var("USERPROFILE").map_err(|e| e.to_string())?).join("Downloads");
    let path = dir.join(format!("wpx-отчёт-{}.txt", chrono::Local::now().format("%Y-%m-%d-%H%M")));
    // BOM — чтобы Блокнот и почта не путали кодировку.
    std::fs::write(&path, format!("\u{feff}{text}")).map_err(|e| format!("не записал {}: {e}", path.display()))?;
    let _ = std::process::Command::new("explorer").arg(format!("/select,{}", path.display())).hidden().spawn();
    Ok(path.display().to_string())
}

/// `wpx --leaks` — проверка утечек в консоль; `wpx --report` — текст отчёта
/// (без состояния монитора: он живёт только в окне).
pub fn cli(report: bool) {
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("tokio");
    if report {
        println!("{}", rt.block_on(build(None, true)));
        return;
    }
    let r = rt.block_on(leaks());
    println!("{}", r.summary);
    for i in &r.items {
        println!("  {} {} — {}", match i.verdict { "ok" => "✓", "leak" => "✗", _ => "?" }, i.title, i.detail);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dns_and_stun_parse() {
        // Ответ: www.google.com A 142.250.74.36 (имя ответа — указатель на вопрос).
        let mut r = dns_query("www.google.com", 1);
        r[2] = 0x81;
        r[3] = 0x80;
        r[7] = 1;
        r.extend([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 142, 250, 74, 36]);
        assert_eq!(dns_answer(&r), Some(Ipv4Addr::new(142, 250, 74, 36)));
        assert!(is_fake(Ipv4Addr::new(198, 18, 0, 7)) && !is_fake(Ipv4Addr::new(198, 51, 100, 1)));
        // STUN: XOR-MAPPED-ADDRESS 203.0.113.5:40000.
        let ip = [203u8 ^ 0x21, 0 ^ 0x12, 113 ^ 0xa4, 5 ^ 0x42];
        let mut s = vec![0x01, 0x01, 0, 12, 0x21, 0x12, 0xa4, 0x42];
        s.extend([0u8; 12]);
        s.extend([0x00, 0x20, 0, 8, 0, 1, 0x9c ^ 0x21, 0x40 ^ 0x12]);
        s.extend(ip);
        assert_eq!(stun_addr(&s), Some(Ipv4Addr::new(203, 0, 113, 5)));
        assert_eq!(trace("fl=1\nip=203.0.113.5\nloc=SG\n"), Some(("203.0.113.5".into(), "SG".into())));
    }

    #[test]
    fn masks_addresses_and_sites() {
        let known = vec![("203.0.113.10".to_string(), "Сингапур".to_string())];
        let t = "dial 203.0.113.10:443 ok, to 198.51.100.20:8443 youtube.com:443 (10.0.0.2) engine.log wpx-probe.exe 198.18.0.5";
        let m = mask(t, &known);
        assert_eq!(m, "dial ‹Сингапур›:443 ok, to 198.51.x.x:8443 ‹сайт›:443 (10.0.0.2) engine.log wpx-probe.exe 198.18.0.5");
    }
}
