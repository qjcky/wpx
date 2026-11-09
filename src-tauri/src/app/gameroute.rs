//! Замер до сервера игры. Пока игра на связи, по соединениям движка видно, к
//! каким адресам она подключена, — и до них меряется пинг по участкам: с
//! этого ПК напрямую (мимо туннеля), с ПК до каждого своего сервера и, по SSH
//! с самих серверов, от сервера до игры и от сервера до сервера (каскад).
//! Сумма участков ≈ пинг всего пути. Только чтение: ничего не меняет.

use serde::Serialize;
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::time::{Duration, Instant};

use crate::engine::controller::Conn;
use crate::engine::netcfg;
use crate::monitor::Shared;
use crate::platform::Hidden;

/// Адрес, с которым игра сейчас на связи.
#[derive(Serialize, Clone, Debug)]
pub struct GameServer {
    pub ip: String,
    pub port: u16,
    /// "tcp" или "udp".
    pub network: String,
    /// Имя, если игра шла по имени.
    pub host: String,
    pub bytes: u64,
    pub conns: usize,
    /// Через какую точку идёт сейчас, «напрямую» или «блок».
    pub via: String,
}

/// Соединение игры: её exe или что-то из её папки.
fn of_game(g: &netcfg::GameMode, c: &Conn) -> bool {
    let dir = g.dir.trim().trim_end_matches(['\\', '/']).to_lowercase();
    let path = c.path.to_lowercase();
    g.apps.iter().any(|a| a.eq_ignore_ascii_case(&c.process))
        || (!dir.is_empty() && path.starts_with(&dir) && path[dir.len()..].starts_with(['\\', '/']))
}

/// Настоящий адрес имени — у DNS движка (системный в TUN отдал бы fake-ip).
async fn resolve(addr: &str, secret: &str, host: &str) -> Option<String> {
    let q = percent_encoding::utf8_percent_encode(host, percent_encoding::NON_ALPHANUMERIC);
    let (_, v) = crate::engine::controller::raw(addr, secret, "GET", &format!("/dns/query?name={q}&type=A"), Duration::from_secs(4)).await.ok()?;
    v.get("Answer")?.as_array()?.iter().filter_map(|a| a.get("data")?.as_str()).find(|d| d.parse::<IpAddr>().is_ok()).map(String::from)
}

/// Сложить соединения игры по адресам: основной (больше трафика) — первым.
fn group(conns: &[(Conn, String, String)]) -> Vec<GameServer> {
    let mut out: Vec<GameServer> = vec![];
    for (c, ip, via) in conns {
        let b = c.up + c.down;
        match out.iter_mut().find(|s| &s.ip == ip && s.port == c.port && s.network == c.network) {
            Some(s) => {
                if b > s.bytes / s.conns.max(1) as u64 {
                    s.via = via.clone();
                }
                s.bytes += b;
                s.conns += 1;
            }
            None => out.push(GameServer { ip: ip.clone(), port: c.port, network: c.network.clone(), host: c.host.clone(), bytes: b, conns: 1, via: via.clone() }),
        }
    }
    out.sort_by_key(|s| std::cmp::Reverse(s.bytes));
    out.truncate(6);
    out
}

/// Куда сейчас подключена игра (пусто — не запущена или ещё не на сервере).
#[tauri::command]
pub async fn game_servers(shared: tauri::State<'_, Shared>) -> Result<Vec<GameServer>, String> {
    let g = netcfg::load().game;
    if !g.on {
        return Err("Игровой режим выключен".into());
    }
    let (addr, secret) = crate::app::cmd::controller()?;
    let list = crate::engine::controller::connections(&addr, &secret).await?;
    let labels = shared.with(|i| i.labels.clone());
    let mut names: HashMap<String, Option<String>> = HashMap::new();
    let mut mine = vec![];
    for c in list.conns.into_iter().filter(|c| of_game(&g, c) && c.port != 53) {
        let ip = if c.ip.is_empty() {
            if !names.contains_key(&c.host) {
                let r = resolve(&addr, &secret, &c.host).await;
                names.insert(c.host.clone(), r);
            }
            match names.get(&c.host).cloned().flatten() {
                Some(ip) => ip,
                None => continue,
            }
        } else {
            c.ip.clone()
        };
        let via = match c.route {
            "direct" => "напрямую".to_string(),
            "block" => "блок".to_string(),
            _ => labels.iter().find(|(n, _)| n == &c.via).map(|(_, l)| l.clone()).unwrap_or_else(|| c.via.clone()),
        };
        mine.push((c, ip, via));
    }
    Ok(group(&mine))
}

/// Участок пути и его пинг.
#[derive(Serialize, Debug)]
pub struct Leg {
    pub name: String,
    pub ms: Option<u32>,
}

/// Путь до игры: напрямую, через свой сервер или каскадом.
#[derive(Serialize, Debug)]
pub struct RouteRtt {
    /// «Напрямую», «Хельсинки», «Москва → Франкфурт».
    pub name: String,
    /// "direct", "server" или "cascade".
    pub kind: &'static str,
    pub legs: Vec<Leg>,
    /// Сумма участков; нет — какой-то не ответил.
    pub total: Option<u32>,
    /// Профиль этого пути, если уже есть, — им можно сразу играть.
    pub profile: Option<String>,
    /// Что сделать, чтобы путь появился (нет профиля, нет каскада).
    pub note: String,
}

/// «время=12мс», «time=12ms», «time<1ms», «time=12.3 ms» → мс.
fn ping_times(text: &str) -> Vec<u32> {
    let mut out = vec![];
    for key in ["time=", "time<", "время=", "время<"] {
        for (i, _) in text.match_indices(key) {
            let num: String = text[i + key.len()..].chars().take_while(|c| c.is_ascii_digit() || *c == '.' || *c == ',').collect();
            if let Ok(v) = num.replace(',', ".").parse::<f64>() {
                out.push(v.round() as u32);
            }
        }
    }
    out
}

/// Пинг с этого ПК мимо туннеля: ICMP и (порт не 0) TCP-рукопожатие с
/// адреса физического адаптера — лучшее из попыток.
async fn local_rtt(ip: IpAddr, port: u16, bind: IpAddr) -> Option<u32> {
    // Другое семейство адресов адаптер не привяжет — ушло бы в туннель.
    if bind.is_ipv4() != ip.is_ipv4() {
        return None;
    }
    let mut best: Option<u32> = None;
    let mut take = |v: u32| best = Some(best.map_or(v, |b| b.min(v)));
    if port != 0 {
        for _ in 0..3 {
            let sock = if ip.is_ipv4() { tokio::net::TcpSocket::new_v4() } else { tokio::net::TcpSocket::new_v6() };
            let Ok(sock) = sock else { break };
            if sock.bind(SocketAddr::new(bind, 0)).is_err() {
                break;
            }
            let t0 = Instant::now();
            if let Ok(Ok(_)) = tokio::time::timeout(Duration::from_secs(2), sock.connect(SocketAddr::new(ip, port))).await {
                take(t0.elapsed().as_millis() as u32);
            }
        }
    }
    let src = bind.to_string();
    let dst = ip.to_string();
    let icmp = tokio::task::spawn_blocking(move || {
        let args: Vec<&str> = if cfg!(windows) { vec!["-n", "3", "-w", "1000", "-S", &src, &dst] } else { vec!["-n", "-c", "3", "-W", "1", "-I", &src, &dst] };
        std::process::Command::new("ping").args(&args).hidden().output().ok().map(|o| String::from_utf8_lossy(&o.stdout).to_string())
    })
    .await
    .ok()
    .flatten()
    .unwrap_or_default();
    // Windows пишет на языке системы, но «время=»/«time=» и числа — везде.
    for v in ping_times(&icmp) {
        take(v);
    }
    best
}

fn sum(legs: &[Leg]) -> Option<u32> {
    legs.iter().map(|l| l.ms).sum()
}

/// Замерить пути до сервера игры: напрямую, через каждый свой сервер и
/// каскадом из двух своих серверов. Быстрые — сверху.
#[tauri::command]
pub async fn game_measure(ip: String, port: u16, network: String) -> Result<Vec<RouteRtt>, String> {
    let ip: IpAddr = ip.parse().map_err(|_| "неверный адрес сервера игры")?;
    let iface = netcfg::load().interface;
    let bind = tokio::task::spawn_blocking(move || crate::platform::iface_ipv4(&iface)).await.ok().flatten().ok_or("не нашёл адрес физического адаптера — проверьте «Движок» → «Сеть движка»")?;
    let tcp_port = if network == "tcp" { port } else { 0 };
    let (direct, surveys) = tokio::join!(local_rtt(ip, tcp_port, bind), crate::servers::rtt::survey(ip, tcp_port));
    // С ПК до каждого сервера — параллельно.
    let mut pc: HashMap<String, Option<u32>> = HashMap::new();
    let jobs: Vec<_> = surveys
        .iter()
        .map(|s| {
            let (id, host, p) = (s.id.clone(), s.host.clone(), s.tcp_port);
            tauri::async_runtime::spawn(async move {
                let ip = host.parse::<IpAddr>().ok();
                (id, match ip { Some(ip) => local_rtt(ip, p, bind).await, None => None })
            })
        })
        .collect();
    for j in jobs {
        if let Ok((id, v)) = j.await {
            pc.insert(id, v);
        }
    }
    let profiles = crate::profiles::load();
    let profile_of = |origin: &str| profiles.profiles.iter().find(|p| p.origin == origin).map(|p| p.id.clone());
    let mut out = vec![RouteRtt {
        name: "Напрямую".into(),
        kind: "direct",
        legs: vec![Leg { name: "ПК → игра".into(), ms: direct }],
        total: direct,
        profile: None,
        note: if direct.is_none() { "не ответил: сервер игры не отвечает на пинг, или прямой путь закрыт (kill switch)".into() } else { String::new() },
    }];
    for b in surveys.iter().filter(|s| s.err.is_none()) {
        let legs = vec![Leg { name: format!("ПК → {}", b.name), ms: pc.get(&b.id).copied().flatten() }, Leg { name: format!("{} → игра", b.name), ms: b.game }];
        let profile = profile_of(&format!("server:{}", b.id));
        out.push(RouteRtt {
            name: b.name.clone(),
            kind: "server",
            total: sum(&legs),
            legs,
            note: if profile.is_none() { "нет профиля — «Серверы» → «Профиль на этом ПК»".into() } else { String::new() },
            profile,
        });
        for a in surveys.iter().filter(|a| a.id != b.id && a.err.is_none()) {
            let ab = a.peers.iter().find(|(id, _)| id == &b.id).and_then(|(_, v)| *v);
            let legs = vec![
                Leg { name: format!("ПК → {}", a.name), ms: pc.get(&a.id).copied().flatten() },
                Leg { name: format!("{} → {}", a.name, b.name), ms: ab },
                Leg { name: format!("{} → игра", b.name), ms: b.game },
            ];
            let piped = b.entries.contains(&a.id);
            let profile = if piped { profile_of(&format!("route:{}", b.id)) } else { None };
            out.push(RouteRtt {
                name: format!("{} → {}", a.name, b.name),
                kind: "cascade",
                total: sum(&legs),
                legs,
                note: if !piped { "каскад не настроен — «Серверы» → «Каскад»".into() } else if profile.is_none() { "нет профиля каскада".into() } else { String::new() },
                profile,
            });
        }
    }
    for s in surveys.iter().filter(|s| s.err.is_some()) {
        out.push(RouteRtt {
            name: s.name.clone(),
            kind: "server",
            legs: vec![],
            total: None,
            profile: None,
            note: format!("не замерил: {}", s.err.clone().unwrap_or_default()),
        });
    }
    out.sort_by_key(|r| (r.total.is_none(), r.total.unwrap_or(u32::MAX)));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ping_output_any_language() {
        let ru = "Ответ от 1.2.3.4: число байт=32 время=48мс TTL=55\nОтвет от 1.2.3.4: число байт=32 время<1мс TTL=55";
        assert_eq!(ping_times(ru), vec![48, 1]);
        let en = "Reply from 1.2.3.4: bytes=32 time=12ms TTL=55";
        assert_eq!(ping_times(en), vec![12]);
        let linux = "64 bytes from 1.2.3.4: icmp_seq=1 ttl=55 time=31.6 ms";
        assert_eq!(ping_times(linux), vec![32]);
    }

    fn conn(ip: &str, port: u16, net: &str, bytes: u64) -> (Conn, String, String) {
        let c = Conn {
            id: String::new(), process: "game.exe".into(), path: String::new(), host: String::new(), ip: ip.into(), port, network: net.into(), sport: 0,
            up: 0, down: bytes, start: 0, via: "wpx-1".into(), rule: String::new(), route: "vpn", label: String::new(),
        };
        (c, ip.to_string(), "Hy2".to_string())
    }

    #[test]
    fn main_server_first() {
        let g = group(&[conn("10.0.0.1", 443, "tcp", 500), conn("10.0.0.2", 7000, "udp", 90_000), conn("10.0.0.2", 7000, "udp", 10_000)]);
        assert_eq!((g[0].ip.as_str(), g[0].conns, g[0].bytes), ("10.0.0.2", 2, 100_000));
        assert_eq!(g[1].ip, "10.0.0.1");
    }

    #[test]
    fn game_conns_by_exe_or_folder() {
        let g = netcfg::GameMode { on: true, apps: vec!["ArcheAge.exe".into()], dir: r"D:\Games\ArcheAge".into(), ..Default::default() };
        let mut c = conn("1.1.1.1", 1, "tcp", 1).0;
        c.process = "archeage.exe".into();
        assert!(of_game(&g, &c));
        c.process = "x64launcher.exe".into();
        c.path = r"D:\Games\ArcheAge\bin\x64launcher.exe".into();
        assert!(of_game(&g, &c));
        c.path = r"D:\Games\ArcheAgeOld\x.exe".into();
        assert!(!of_game(&g, &c));
    }
}
