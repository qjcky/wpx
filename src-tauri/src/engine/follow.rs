//! «Программа и всё, что она запускает». У правила для приложения с `follow`
//! wpx сам находит её помощников — процессы, которые она запустила (Codex у
//! ChatGPT), — и ведёт их тем же путём. У общих помощников (WebView2, node,
//! PowerShell) имя exe одно на многие программы — по имени их не берём, а
//! берём сайты, на которые ходят именно экземпляры этой программы:
//! соединение движка → локальный порт → процесс. Найденное — в правиле
//! (`learned`); движок берёт правила у окна по 127.0.0.1 (http-провайдер)
//! и перечитывает по API — на лету, без перезапуска и окна Windows.
//! «Сайт и что он подгружает» — то же для сайта: адреса, которые браузер
//! открывает вместе с ним и которые напрямую не отвечают (истории Instagram
//! с cdninstagram.com), — тем же путём, что и сайт.
//! В лаборатории рабочий движок чужой: только запоминаем и показываем.

use std::collections::{HashMap, HashSet};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use sysinfo::{Pid, Process, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tauri::{AppHandle, Emitter};

use crate::config::{self, EngineKind};
use crate::engine::controller::Conn;
use crate::engine::netcfg::{self, NetSettings, RouteRule};

/// Общие помощники: одно имя exe у многих программ — по имени не ведём,
/// только их сайты.
const SHARED: &[&str] = &[
    "msedgewebview2.exe", "node.exe", "python.exe", "pythonw.exe", "java.exe", "javaw.exe", "cmd.exe", "powershell.exe", "pwsh.exe",
    "conhost.exe", "openconsole.exe", "windowsterminal.exe", "git.exe", "bash.exe", "sh.exe", "wsl.exe", "rundll32.exe", "dllhost.exe",
    "svchost.exe", "explorer.exe", "werfault.exe", "crashpad_handler.exe",
];

/// Не запоминаем вовсе: российские зоны и служебные адреса Windows и центров
/// сертификации — у любого приложения они открываются напрямую.
const NEVER_TLD: &[&str] = &["ru", "su", "xn--p1ai"];
const NEVER: &[&str] = &[
    "windowsupdate.com", "msftconnecttest.com", "msftncsi.com", "digicert.com", "sectigo.com", "usertrust.com", "lencr.org",
    "letsencrypt.org", "globalsign.com", "verisign.com", "comodoca.com", "pki.goog",
    // Общее для всех сайтов и фон браузера: выученное, оно увело бы через туннель
    // весь Google, Microsoft, рекламу и расширения, а не «то, что грузит сайт».
    "google.com", "gstatic.com", "googleapis.com", "gvt1.com", "gvt2.com", "microsoft.com", "live.com",
    "doubleclick.net", "googlesyndication.com", "googleadservices.com", "google-analytics.com", "googletagmanager.com",
    "ipify.org", "getadblock.com", "adblockplus.org",
];

/// Стоит ли запоминать адрес `d` у правила `r`: не российская зона, не
/// служебный адрес, не убран вручную (`skip:`) и на него нет правила «напрямую».
fn worth(d: &str, r: &RouteRule, n: &NetSettings) -> bool {
    let item = format!("site:{d}");
    !NEVER_TLD.contains(&d.rsplit('.').next().unwrap_or(""))
        && !NEVER.iter().any(|s| under(d, s))
        && !r.learned.iter().any(|x| *x == item || x.strip_prefix("skip:") == Some(item.as_str()))
        && !n.rules.iter().any(|x| x.kind == "site" && x.target == "direct" && under(d, &x.value.to_ascii_lowercase()))
}

/// Висит напрямую: ушло мимо всех правил, отправили, а за 4 с ни байта —
/// значит, напрямую закрыто. Что открывается напрямую, не запоминаем.
fn stuck(c: &Conn, now: i64) -> bool {
    c.route == "direct" && c.rule == "Match" && c.up > 0 && c.down == 0 && now - c.start >= 4000 && c.process != "—"
}

/// Что нашлось — окну и вырезу.
#[derive(serde::Serialize, Clone)]
struct Learned {
    /// "app" или "site".
    kind: &'static str,
    /// Правило: exe программы или сайт.
    app: String,
    /// "app:codex.exe" или "site:oaistatic.com".
    item: String,
}

fn exe_name(p: &Process) -> String {
    p.exe()
        .and_then(|e| e.file_name())
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_else(|| p.name().to_string_lossy().to_string())
}

fn base(value: &str) -> &str {
    value.rsplit(['\\', '/']).next().unwrap_or(value)
}

/// «www.cdn.example.co.uk:443» → «example.co.uk»; IP и одиночные имена — нет.
fn domain_of(host: &str) -> Option<String> {
    let h = host.trim().trim_end_matches('.').to_ascii_lowercase();
    let h = h.rsplit_once(':').filter(|(_, p)| p.chars().all(|c| c.is_ascii_digit())).map_or(h.as_str(), |(a, _)| a).to_string();
    if h.is_empty() || !h.contains('.') || h.parse::<std::net::IpAddr>().is_ok() || h.contains(',') {
        return None;
    }
    let p: Vec<&str> = h.split('.').collect();
    let n = if p.len() >= 3 && ["co", "com", "net", "org", "gov", "edu", "ac", "or", "ne", "go"].contains(&p[p.len() - 2]) { 3 } else { 2 };
    Some(p[p.len().saturating_sub(n)..].join("."))
}

/// Владельцы TCP-соединений: локальный порт → процесс (Linux: /proc —
/// сокет по порту, процесс по открытому сокету).
#[cfg(not(windows))]
fn tcp_owners() -> HashMap<u16, u32> {
    let mut inode_port: HashMap<u64, u16> = HashMap::new();
    for f in ["/proc/net/tcp", "/proc/net/tcp6"] {
        let Ok(t) = std::fs::read_to_string(f) else { continue };
        for l in t.lines().skip(1) {
            let c: Vec<&str> = l.split_whitespace().collect();
            let (Some(local), Some(inode)) = (c.get(1), c.get(9)) else { continue };
            let port = local.rsplit(':').next().and_then(|p| u16::from_str_radix(p, 16).ok());
            if let (Some(port), Ok(inode)) = (port, inode.parse::<u64>()) {
                inode_port.insert(inode, port);
            }
        }
    }
    let mut out = HashMap::new();
    let Ok(procs) = std::fs::read_dir("/proc") else { return out };
    for p in procs.flatten() {
        let Ok(pid) = p.file_name().to_string_lossy().parse::<u32>() else { continue };
        let Ok(fds) = std::fs::read_dir(p.path().join("fd")) else { continue };
        for fd in fds.flatten() {
            let Ok(link) = std::fs::read_link(fd.path()) else { continue };
            let l = link.to_string_lossy();
            if let Some(inode) = l.strip_prefix("socket:[").and_then(|x| x.strip_suffix(']')).and_then(|x| x.parse::<u64>().ok()) {
                if let Some(port) = inode_port.get(&inode) {
                    out.insert(*port, pid);
                }
            }
        }
    }
    out
}

/// Владельцы TCP-соединений: локальный порт → процесс.
#[cfg(windows)]
fn tcp_owners() -> HashMap<u16, u32> {
    use windows_sys::Win32::NetworkManagement::IpHelper::{GetExtendedTcpTable, MIB_TCPTABLE_OWNER_PID, TCP_TABLE_OWNER_PID_ALL};
    use windows_sys::Win32::Networking::WinSock::AF_INET;
    let mut size = 0u32;
    // SAFETY: первый вызов только узнаёт размер; второй пишет в буфер этого
    // размера (u32 — выравнивание таблицы), строки читаются в его пределах.
    unsafe {
        GetExtendedTcpTable(std::ptr::null_mut(), &mut size, 0, AF_INET as u32, TCP_TABLE_OWNER_PID_ALL, 0);
        let mut buf = vec![0u32; (size as usize + 8192) / 4];
        let mut len = (buf.len() * 4) as u32;
        if GetExtendedTcpTable(buf.as_mut_ptr() as _, &mut len, 0, AF_INET as u32, TCP_TABLE_OWNER_PID_ALL, 0) != 0 {
            return HashMap::new();
        }
        let t = buf.as_ptr() as *const MIB_TCPTABLE_OWNER_PID;
        let n = (*t).dwNumEntries as usize;
        let rows = std::ptr::addr_of!((*t).table) as *const windows_sys::Win32::NetworkManagement::IpHelper::MIB_TCPROW_OWNER_PID;
        if (n * std::mem::size_of::<windows_sys::Win32::NetworkManagement::IpHelper::MIB_TCPROW_OWNER_PID>()) + 4 > buf.len() * 4 {
            return HashMap::new();
        }
        std::slice::from_raw_parts(rows, n)
            .iter()
            .map(|r| (u16::from_be((r.dwLocalPort & 0xffff) as u16), r.dwOwningPid))
            .collect()
    }
}

/// Цель правила ведёт в туннель (сайты помощников учим только для туннеля:
/// правило по сайту действует на все программы — напрямую или в блок так
/// нельзя).
fn to_tunnel(r: &RouteRule) -> bool {
    r.target != "direct" && r.target != "block"
}

/// Найти новое у правил с `follow`: помощников и сайты общих помощников.
async fn scan(sys: &mut System, n: &NetSettings) -> Vec<(String, Vec<String>)> {
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::new().with_exe(UpdateKind::OnlyIfNotSet));
    let mut kids: HashMap<Pid, Vec<Pid>> = HashMap::new();
    for (pid, p) in sys.processes() {
        if let Some(pp) = p.parent() {
            kids.entry(pp).or_default().push(*pid);
        }
    }
    let windir = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into()).to_lowercase();
    let mut out: Vec<(String, Vec<String>)> = vec![];
    let rules: Vec<&RouteRule> = n.rules.iter().filter(|r| r.kind == "app" && netcfg::follows(r)).collect();
    // Процесс общего помощника → правило, чьи сайты он открывает.
    let mut shared: HashMap<u32, usize> = HashMap::new();
    for r in rules.iter().copied() {
        let want = base(&r.value).to_lowercase();
        let known: HashSet<String> = r.learned.iter().filter_map(|x| x.strip_prefix("app:")).map(str::to_lowercase).collect();
        let mut stack: Vec<Pid> = sys
            .processes()
            .iter()
            .filter(|(_, p)| {
                let n = exe_name(p).to_lowercase();
                n == want || known.contains(&n)
            })
            .map(|(pid, _)| *pid)
            .collect();
        let mut family = HashSet::new();
        while let Some(pid) = stack.pop() {
            if family.insert(pid) {
                stack.extend(kids.get(&pid).into_iter().flatten());
            }
        }
        let mut items: Vec<String> = vec![];
        for pid in &family {
            let Some(p) = sys.process(*pid) else { continue };
            let name = exe_name(p);
            let low = name.to_lowercase();
            if low == want || known.contains(&low) {
                continue;
            }
            let path = p.exe().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
            let system = path.starts_with(&windir) || (cfg!(not(windows)) && ["/usr/", "/bin/", "/sbin/", "/lib"].iter().any(|s| path.starts_with(s)));
            let shared_name = SHARED.iter().any(|s| s.trim_end_matches(".exe") == low.trim_end_matches(".exe"));
            if shared_name || system {
                if to_tunnel(r) {
                    shared.insert(pid.as_u32(), out.len());
                }
                continue;
            }
            let it = format!("app:{name}");
            if !items.contains(&it) && !r.learned.contains(&format!("skip:{it}")) {
                items.push(it);
            }
        }
        out.push((r.value.clone(), items));
    }
    if !shared.is_empty() {
        if let Ok((addr, secret)) = crate::app::cmd::controller() {
            if let Ok(list) = crate::engine::controller::connections(&addr, &secret).await {
                let owners = tcp_owners();
                let now = chrono::Utc::now().timestamp_millis();
                // Только то, что напрямую не открывается: остальное и так работает.
                for c in list.conns.iter().filter(|c| c.network == "tcp" && stuck(c, now)) {
                    let Some(ri) = owners.get(&c.sport).and_then(|pid| shared.get(pid)) else { continue };
                    let Some(d) = domain_of(&c.host) else { continue };
                    let it = format!("site:{d}");
                    if worth(&d, rules[*ri], n) && !out[*ri].1.contains(&it) {
                        out[*ri].1.push(it);
                    }
                }
            }
        }
    }
    out.retain(|(_, items)| !items.is_empty());
    out
}

/// «site.com» и его поддомены.
fn under(host: &str, site: &str) -> bool {
    let h = host.trim_end_matches('.').to_ascii_lowercase();
    h == site || h.ends_with(&format!(".{site}"))
}

/// «Сайт и что он подгружает»: память между проходами.
#[derive(Default)]
struct SiteWatch {
    /// Соединение → байт в прошлый проход: растёт — сайт сейчас открыт.
    bytes: HashMap<String, u64>,
    /// (сайт правила, процесс) → когда сайт последний раз качал.
    active: HashMap<(String, String), i64>,
}

impl SiteWatch {
    /// Адрес D — к правилу сайта X, если D открыл тот же процесс (браузер)
    /// не дальше 30 с от того, как X качал, D ушёл напрямую мимо всех правил
    /// и висит без ответа: отправили, а за 4 с не пришло ни байта. Значит,
    /// напрямую D закрыт, а без него X не догружается. Возвращает (сайт, "site:D").
    fn scan(&mut self, sites: &[&RouteRule], conns: &[Conn], now: i64, n: &NetSettings) -> Vec<(String, String)> {
        let mut bytes = HashMap::new();
        for c in conns {
            let b = c.up + c.down;
            if self.bytes.get(&c.id).is_none_or(|p| b > *p) && c.process != "—" {
                for r in sites.iter().filter(|r| under(&c.host, &r.value.to_ascii_lowercase())) {
                    self.active.insert((r.value.to_ascii_lowercase(), c.process.to_ascii_lowercase()), now);
                }
            }
            bytes.insert(c.id.clone(), b);
        }
        self.bytes = bytes;
        self.active.retain(|_, t| now - *t < 120_000);
        let mut out: Vec<(String, String)> = vec![];
        for c in conns {
            let Some(d) = domain_of(&c.host).filter(|_| stuck(c, now)) else { continue };
            let item = format!("site:{d}");
            let p = c.process.to_ascii_lowercase();
            let near = sites
                .iter()
                .filter_map(|r| {
                    let x = r.value.to_ascii_lowercase();
                    let t = *self.active.get(&(x.clone(), p.clone()))?;
                    ((t - c.start).abs() <= 30_000 && !under(&d, &x) && worth(&d, r, n)).then(|| (t, r.value.clone()))
                })
                .max_by_key(|(t, _)| *t);
            if let Some((_, site)) = near {
                if !out.iter().any(|(s, i)| s == &site && i == &item) {
                    out.push((site, item));
                }
            }
        }
        out
    }
}

/// Движку — «перечитай правила»: он скачает их у `serve` заново. В
/// лаборатории не трогаем: движок — рабочего wpx.
pub async fn push(n: &NetSettings) {
    if config::LAB || config::active().kind != EngineKind::Wpx {
        return;
    }
    let Ok((addr, secret)) = crate::app::cmd::controller() else { return };
    for r in n.rules.iter().filter(|r| netcfg::follows(r)) {
        let key = netcfg::follow_key(&r.value);
        let _ = crate::engine::controller::raw(&addr, &secret, "PUT", &format!("/providers/rules/{key}"), Duration::from_secs(3)).await;
    }
}

/// Ответ на запрос движка: `GET /<follow_key>.txt` — строки правил; иначе 404.
fn reply(n: &NetSettings, request: &str) -> String {
    let key = request.split_whitespace().nth(1).and_then(|p| p.strip_prefix('/')).and_then(|p| p.strip_suffix(".txt")).unwrap_or("");
    match n.rules.iter().find(|r| netcfg::follows(r) && netcfg::follow_key(&r.value) == key) {
        Some(r) => {
            let body = netcfg::follow_lines(r);
            format!("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
        }
        None => "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into(),
    }
}

/// Правила «найденного на лету» — движку по 127.0.0.1 (`FOLLOW_ADDR`): он
/// скачивает их к себе, и в его папке нет места, куда пишет пользователь.
/// Окно не запущено — движок берёт свою прежнюю копию. Порт занят — пробуем
/// снова (его могли занять до запуска wpx).
async fn serve() {
    let l = loop {
        match tokio::net::TcpListener::bind(netcfg::FOLLOW_ADDR).await {
            Ok(l) => break l,
            Err(_) => tokio::time::sleep(Duration::from_secs(30)).await,
        }
    };
    loop {
        let Ok((mut s, _)) = l.accept().await else {
            tokio::time::sleep(Duration::from_secs(1)).await;
            continue;
        };
        tauri::async_runtime::spawn(async move {
            let mut buf = [0u8; 2048];
            let Ok(Ok(n)) = tokio::time::timeout(Duration::from_secs(5), s.read(&mut buf)).await else { return };
            let resp = reply(&netcfg::load(), &String::from_utf8_lossy(&buf[..n]));
            let _ = s.write_all(resp.as_bytes()).await;
        });
    }
}

/// Раз в 3 секунды: есть правила с `follow` — ищем новое, запоминаем,
/// отдаём движку, сообщаем окну и вырезу (`follow-learned`).
pub fn spawn(app: AppHandle) {
    if !config::LAB {
        tauri::async_runtime::spawn(serve());
    }
    tauri::async_runtime::spawn(async move {
        tidy().await;
        let mut sys = System::new();
        let mut watch = SiteWatch::default();
        loop {
            tokio::time::sleep(Duration::from_secs(3)).await;
            let n = netcfg::load();
            if !n.rules.iter().any(netcfg::follows) {
                continue;
            }
            let mut found: Vec<(&'static str, String, Vec<String>)> = vec![];
            if n.rules.iter().any(|r| r.kind == "app" && netcfg::follows(r)) {
                found.extend(scan(&mut sys, &n).await.into_iter().map(|(v, items)| ("app", v, items)));
            }
            let sites: Vec<&RouteRule> = n.rules.iter().filter(|r| r.kind == "site" && r.follow && to_tunnel(r)).collect();
            if !sites.is_empty() {
                if let Ok((addr, secret)) = crate::app::cmd::controller() {
                    if let Ok(list) = crate::engine::controller::connections(&addr, &secret).await {
                        let now = chrono::Utc::now().timestamp_millis();
                        found.extend(watch.scan(&sites, &list.conns, now, &n).into_iter().map(|(v, it)| ("site", v, vec![it])));
                    }
                }
            }
            if found.is_empty() {
                continue;
            }
            // Поверх свежих настроек: в окне могли что-то поменять.
            let mut n = netcfg::load();
            let mut news = vec![];
            for (kind, value, items) in found {
                let Some(r) = n.rules.iter_mut().find(|r| r.kind == kind && r.follow && r.value.eq_ignore_ascii_case(&value)) else { continue };
                for it in items {
                    if !r.learned.contains(&it) && !r.learned.contains(&format!("skip:{it}")) {
                        r.learned.push(it.clone());
                        news.push(Learned { kind, app: r.value.clone(), item: it });
                    }
                }
            }
            if news.is_empty() || netcfg::save(&n).is_err() {
                continue;
            }
            push(&n).await;
            for l in news {
                let _ = app.emit("follow-learned", l);
            }
        }
    });
}

/// Найденное прежними версиями без фильтра: российские зоны и служебные
/// адреса открываются напрямую — убрать (насовсем, как вручную).
async fn tidy() {
    let mut n = netcfg::load();
    let mut changed = false;
    for r in n.rules.iter_mut().filter(|r| r.follow) {
        let bad: Vec<String> = r
            .learned
            .iter()
            .filter(|x| x.strip_prefix("site:").is_some_and(|d| NEVER_TLD.contains(&d.rsplit('.').next().unwrap_or("")) || NEVER.iter().any(|s| under(d, s))))
            .cloned()
            .collect();
        for x in bad {
            r.learned.retain(|y| y != &x);
            r.learned.push(format!("skip:{x}"));
            changed = true;
        }
    }
    if changed && netcfg::save(&n).is_ok() {
        push(&n).await;
    }
}

/// Убрать найденное из правила (и сразу из движка).
#[tauri::command]
pub async fn follow_forget(app: String, item: String) -> Result<(), String> {
    let mut n = netcfg::load();
    let r = n.rules.iter_mut().find(|r| netcfg::follows(r) && r.value.eq_ignore_ascii_case(&app)).ok_or("нет такого правила")?;
    r.learned.retain(|x| x != &item);
    let skip = format!("skip:{item}");
    if netcfg::valid_learned(&skip) && !r.learned.contains(&skip) {
        r.learned.push(skip);
    }
    netcfg::save(&n)?;
    push(&n).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn domains() {
        assert_eq!(domain_of("chatgpt.com").as_deref(), Some("chatgpt.com"));
        assert_eq!(domain_of("cdn.oaistatic.com:443").as_deref(), Some("oaistatic.com"));
        assert_eq!(domain_of("a.b.example.co.uk").as_deref(), Some("example.co.uk"));
        assert_eq!(domain_of("104.18.32.47"), None);
        assert_eq!(domain_of("localhost"), None);
        assert_eq!(domain_of(""), None);
    }

    #[test]
    fn follow_file() {
        let r = RouteRule {
            kind: "app".into(),
            value: "ChatGPT.exe".into(),
            target: "main".into(),
            follow: true,
            learned: vec!["app:codex.exe".into(), "site:oaistatic.com".into(), "app:bad,exe".into(), "x:y".into()],
        };
        assert_eq!(netcfg::follow_lines(&r), "PROCESS-NAME,codex.exe\nDOMAIN-SUFFIX,oaistatic.com\n");
        let k = netcfg::follow_key("ChatGPT.exe");
        assert!(k.starts_with("follow-chatgpt-") && k.len() == "follow-chatgpt-".len() + 4, "{k}");
        assert_ne!(netcfg::follow_key(r"C:\A\app.exe"), netcfg::follow_key(r"C:\B\app.exe"));
    }

    fn conn(id: &str, host: &str, route: &'static str, rule: &str, up: u64, down: u64, start: i64) -> Conn {
        Conn {
            id: id.into(), process: "chrome.exe".into(), path: String::new(), host: host.into(), ip: String::new(), port: 443, network: "tcp".into(), sport: 0,
            up, down, start, via: if route == "vpn" { "wpx-1".into() } else { "DIRECT".into() }, rule: rule.into(), route, label: String::new(),
        }
    }

    fn ig(learned: &[&str]) -> RouteRule {
        RouteRule { kind: "site".into(), value: "instagram.com".into(), target: "main".into(), follow: true, learned: learned.iter().map(|s| s.to_string()).collect() }
    }

    #[test]
    fn site_learns_what_hangs_directly() {
        let mut w = SiteWatch::default();
        let t0 = 1_000_000;
        let conns = vec![
            conn("1", "www.instagram.com", "vpn", "DomainSuffix", 900, 50_000, t0),
            // Висит напрямую — сайт без него не догрузится.
            conn("2", "scontent-arn2-1.cdninstagram.com", "direct", "Match", 517, 0, t0 + 2_000),
            // Отвечает напрямую — не трогаем.
            conn("3", "fonts.gstatic.com", "direct", "Match", 600, 9_000, t0 + 2_000),
            // Свежее (меньше 4 с) — ещё рано судить.
            conn("4", "static.xx.fbcdn.net", "direct", "Match", 517, 0, t0 + 7_000),
            // Подпало под правило «напрямую» — человек так решил.
            conn("5", "vk.com", "direct", "DomainSuffix", 517, 0, t0),
        ];
        let pair = |d: &str| ("instagram.com".to_string(), format!("site:{d}"));
        assert_eq!(w.scan(&[&ig(&[])], &conns, t0 + 9_000, &NetSettings::default()), vec![pair("cdninstagram.com")]);
        // Уже найденное второй раз не предлагаем; fbcdn к этому времени завис.
        assert_eq!(w.scan(&[&ig(&["site:cdninstagram.com"])], &conns, t0 + 12_000, &NetSettings::default()), vec![pair("fbcdn.net")]);
    }

    /// Не запоминаем то, что открывается напрямую: российские зоны, служебные
    /// адреса, убранное вручную и сайты с правилом «напрямую».
    #[test]
    fn learns_only_what_is_worth_it() {
        let mut n = NetSettings::default();
        n.rules.push(RouteRule { kind: "site".into(), value: "platipomiru.com".into(), target: "direct".into(), ..Default::default() });
        let r = ig(&["skip:site:example.net"]);
        assert!(worth("cdninstagram.com", &r, &n));
        assert!(!worth("google.com", &r, &n) && !worth("beacons.gvt2.com", &r, &n) && !worth("ad.doubleclick.net", &r, &n));
        for d in ["yandex.ru", "vk.su", "xn--d1acj3b.xn--p1ai", "windowsupdate.com", "digicert.com", "example.net", "platipomiru.com"] {
            assert!(!worth(d, &r, &n), "{d}");
        }
        // Убранное вручную хранится как «skip:» и проходит проверку настроек.
        assert!(netcfg::valid_learned("skip:site:example.net") && !netcfg::valid_learned("skip:skip:site:x.com"));
        // Отвечает напрямую — не «висит»; молчит 4 с и дольше — висит.
        assert!(!stuck(&conn("1", "yandex.ru", "direct", "Match", 600, 9_000, 0), 10_000));
        assert!(stuck(&conn("2", "x.com", "direct", "Match", 517, 0, 0), 10_000));
    }

    #[test]
    fn site_needs_the_site_open_nearby() {
        let mut w = SiteWatch::default();
        // Instagram не открыт — висящий адрес чужой, не берём.
        let conns = vec![conn("2", "cdninstagram.com", "direct", "Match", 517, 0, 0)];
        assert!(w.scan(&[&ig(&[])], &conns, 9_000, &NetSettings::default()).is_empty());
    }

    #[test]
    fn engine_gets_learned_rules_by_key() {
        let mut n = NetSettings::default();
        n.rules.push(RouteRule { kind: "app".into(), value: "ChatGPT.exe".into(), target: "main".into(), follow: true, learned: vec!["app:codex.exe".into()] });
        let key = netcfg::follow_key("ChatGPT.exe");
        let ok = reply(&n, &format!("GET /{key}.txt HTTP/1.1\r\nHost: x\r\n\r\n"));
        assert!(ok.starts_with("HTTP/1.1 200") && ok.ends_with("PROCESS-NAME,codex.exe\n"), "{ok}");
        assert!(reply(&n, "GET /../config.yaml HTTP/1.1\r\n\r\n").starts_with("HTTP/1.1 404"));
        assert!(reply(&n, "").starts_with("HTTP/1.1 404"));
    }

    #[test]
    fn owners_table_reads() {
        // Таблица TCP читается без прав администратора (хотя бы не падает).
        let _ = tcp_owners();
    }
}
