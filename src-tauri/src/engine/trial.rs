//! Пробный запуск профиля: движок профиля без TUN, на локальном порту.
//!
//! Систему и рабочий туннель не трогает: свой процесс `wpx-trial.exe`,
//! свои порты (прокси, API, без DNS-порта), выход к серверам — через
//! физический адаптер, как у песочницы. Через него открывается отдельное
//! окно браузера и меряется скорость; API движка показывает, какая точка
//! сейчас активна и какие живы, — на этом же строится монитор VPN-профилей.

use serde::Serialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::engine::controller;
use crate::engine::netcfg::{self, GROUP};
use crate::profiles;
use crate::engine::sandbox;
use crate::platform::Hidden;

/// Своё имя процесса пробного запуска (монитор и самовосстановление его не спутают).
fn exe() -> String {
    crate::platform::exe("wpx-trial")
}
const CHECK_URL: &str = "http://www.gstatic.com/generate_204";

struct Point {
    name: String,
    label: String,
    summary: String,
    entry: bool,
}

struct Trial {
    child: Child,
    profile_id: String,
    profile: String,
    mode: String,
    port: u16,
    ctl: String,
    secret: String,
    started: Instant,
    points: Vec<Point>,
    /// Все группы конфига (проверяются по кнопке «Проверить точки»).
    groups: Vec<String>,
    /// Логины HTTP/SOCKS-прокси: в файле конфига их нет — монитору отсюда.
    creds: Vec<(String, crate::config::Creds)>,
}

static TRIAL: Mutex<Option<Trial>> = Mutex::new(None);

fn dir() -> PathBuf {
    crate::config::data_dir().join("trial")
}

/// Убить пробные движки, оставшиеся от прошлого запуска окна (только наши — по пути).
fn kill_stale() {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
    let ours = dir().join(exe());
    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::new().with_exe(sysinfo::UpdateKind::Always));
    for p in sys.processes().values() {
        if p.exe().map(|e| e == ours).unwrap_or(false) {
            p.kill();
        }
    }
}

/// Конфиг пробного движка. Пока движок его не прочитал — с ключами и
/// паролями профиля открытым текстом, поэтому живёт на диске считанные секунды.
fn config_path() -> PathBuf {
    dir().join("config.yaml")
}

/// Секреты точек в конфиге mihomo (см. `secrets` в proto.rs).
const SECRET_KEYS: &[&str] = &["uuid", "password", "obfs-password", "private-key", "pre-shared-key", "username"];

/// Конфиг без секретов: движок свой уже прочитал, а на диске остаётся только
/// то, что нужно монитору лаборатории (адреса, протоколы, группы).
fn strip_secrets(cfg: &mut Value) {
    let Some(o) = cfg.as_object_mut() else { return };
    o.remove("secret");
    for p in o.get_mut("proxies").and_then(Value::as_array_mut).into_iter().flatten() {
        if let Some(p) = p.as_object_mut() {
            for k in SECRET_KEYS {
                p.remove(*k);
            }
        }
    }
}

pub fn stop() {
    if let Some(mut t) = TRIAL.lock().unwrap().take() {
        let _ = t.child.kill();
        let _ = t.child.wait();
    }
    let _ = std::fs::remove_file(config_path());
}

#[derive(Serialize, Clone)]
pub struct TrialPoint {
    pub name: String,
    pub label: String,
    pub summary: String,
    /// "exit" — точка выхода, "entry" — вход каскада.
    pub role: &'static str,
    pub alive: bool,
    pub delay_ms: Option<u32>,
    pub active: bool,
}

#[derive(Serialize, Clone, Default)]
pub struct TrialStatus {
    pub running: bool,
    pub profile_id: String,
    pub profile: String,
    /// "auto" — самая быстрая, "fallback" — по порядку.
    pub mode: String,
    pub port: u16,
    pub uptime_s: u64,
    pub points: Vec<TrialPoint>,
    pub error: Option<String>,
}

/// Конфиг пробного движка: тот же, что боевой, но без TUN и на своих портах.
fn trial_config(p: &profiles::Profile, port: u16, ctl: &str, secret: &str) -> Result<(Value, Vec<Point>, Vec<String>), String> {
    let st = profiles::load();
    let ch = profiles::chain_of(&st, p)?;
    let net = netcfg::load();
    let mut cfg = netcfg::build(&ch, &net)?;
    let o = cfg.as_object_mut().ok_or("конфиг")?;
    o.remove("tun");
    o.insert("mixed-port".into(), json!(port));
    o.insert("external-controller".into(), json!(ctl));
    o.insert("secret".into(), json!(secret));
    o.insert("profile".into(), json!({ "store-selected": false, "store-fake-ip": false }));
    if let Some(d) = o.get_mut("dns").and_then(Value::as_object_mut) {
        // DNS-порт занят рабочим движком; пробному слушать DNS незачем.
        d.remove("listen");
    }
    // Выходы сверху, входы каскадов — под ними; у маршрута — с названием участника.
    let mut pts = ch.points();
    pts.sort_by_key(|(_, _, entry, _)| *entry);
    let points = pts
        .into_iter()
        .map(|(n, e, entry, title)| Point {
            name: n,
            label: e.label.clone(),
            summary: if title.is_empty() { e.summary() } else { format!("{title} · {}", e.summary()) },
            entry,
        })
        .collect();
    // Профили из правил, резерв, постоянный IP — тоже точки пробного запуска.
    let mut points: Vec<Point> = points;
    points.extend(netcfg::side_labels(&net, &ch.id).into_iter().map(|(n, label, entry)| Point { name: n, summary: label.clone(), label, entry }));
    let groups = cfg["proxy-groups"].as_array().map(|g| g.iter().filter_map(|x| x["name"].as_str().map(String::from)).collect()).unwrap_or_default();
    Ok((cfg, points, groups))
}

pub async fn start(profile_id: &str) -> Result<TrialStatus, String> {
    stop();
    let st = profiles::load();
    let p = st.profiles.iter().find(|p| p.id == profile_id).cloned().ok_or("Профиль не найден")?;
    tokio::task::spawn_blocking(kill_stale).await.map_err(|e| e.to_string())?;
    let port = sandbox::free_port()?;
    let ctl = format!("127.0.0.1:{}", sandbox::free_port()?);
    let secret = crate::engine::ops::random_hex(24);
    let (cfg, points, groups) = trial_config(&p, port, &ctl, &secret)?;
    let exe = sandbox::engine_copy("trial", &exe())?;
    let path = config_path();
    let full = serde_json::to_string_pretty(&cfg).unwrap_or_default();
    let creds: Vec<(String, crate::config::Creds)> = cfg["proxies"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| {
            let user = p["username"].as_str().filter(|u| !u.is_empty())?;
            Some((p["name"].as_str()?.to_string(), crate::config::Creds { user: user.into(), pass: p["password"].as_str().unwrap_or("").into() }))
        })
        .collect();
    let safe = {
        let mut c = cfg;
        strip_secrets(&mut c);
        serde_json::to_string_pretty(&c).unwrap_or_default()
    };
    {
        // Под замком: пока файл лежит с секретами, `status()` не должен
        // принять его за остаток прошлого запуска и удалить.
        let mut g = TRIAL.lock().unwrap();
        std::fs::write(&path, &full).map_err(|e| e.to_string())?;
        let child = Command::new(&exe)
            .arg("-d").arg(dir()).arg("-f").arg(&path)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .hidden()
            .spawn()
            .map_err(|e| {
                let _ = std::fs::remove_file(&path);
                format!("запуск пробного движка: {e}")
            })?;
        *g = Some(Trial {
            child,
            profile_id: p.id.clone(),
            profile: p.name.clone(),
            mode: p.mode.clone(),
            port,
            ctl: ctl.clone(),
            secret: secret.clone(),
            started: Instant::now(),
            points,
            groups,
            creds,
        });
    }
    let t0 = Instant::now();
    loop {
        if controller::raw(&ctl, &secret, "GET", "/version", Duration::from_secs(1)).await.map(|r| r.0) == Ok(200) {
            // Движок конфиг прочитал — секретам на диске больше делать нечего.
            let _ = std::fs::write(&path, &safe);
            break;
        }
        if t0.elapsed() > Duration::from_secs(10) {
            stop();
            return Err("Пробный движок не запустился за 10 с (конфиг профиля не принят?)".into());
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    check().await
}

/// Снимок: что активно, какие точки живы (по последним проверкам движка).
pub async fn status() -> TrialStatus {
    let (ctl, secret, mut s, points) = {
        let mut g = TRIAL.lock().unwrap();
        let Some(t) = g.as_mut() else {
            // Остаток от прошлого запуска окна (wpx упал, не успев прибрать).
            let _ = std::fs::remove_file(config_path());
            return TrialStatus::default();
        };
        if let Ok(Some(code)) = t.child.try_wait() {
            let id = t.profile_id.clone();
            *g = None;
            return TrialStatus { profile_id: id, error: Some(format!("пробный движок завершился ({code})")), ..Default::default() };
        }
        let s = TrialStatus {
            running: true,
            profile_id: t.profile_id.clone(),
            profile: t.profile.clone(),
            mode: t.mode.clone(),
            port: t.port,
            uptime_s: t.started.elapsed().as_secs(),
            ..Default::default()
        };
        let pts: Vec<(String, String, String, bool)> = t.points.iter().map(|p| (p.name.clone(), p.label.clone(), p.summary.clone(), p.entry)).collect();
        (t.ctl.clone(), t.secret.clone(), s, pts)
    };
    let all = match controller::raw(&ctl, &secret, "GET", "/proxies", Duration::from_secs(3)).await {
        Ok((200, v)) => v,
        Ok((c, _)) => return TrialStatus { error: Some(format!("API движка: ответ {c}")), ..s },
        Err(e) => return TrialStatus { error: Some(e), ..s },
    };
    let px = &all["proxies"];
    // Активная точка — куда доходит выбор главной группы (через участника
    // маршрута), активный вход — по группе входа этой точки.
    let now_exit = controller::leaf(px, GROUP).unwrap_or_default();
    let now_entry = controller::leaf(px, &crate::engine::netcfg::entry_group_for(&now_exit)).unwrap_or_default();
    s.points = points
        .into_iter()
        .map(|(name, label, summary, entry)| {
            let p = &px[&name];
            let last = p["history"].as_array().and_then(|h| h.last()).and_then(|x| x["delay"].as_u64()).filter(|d| *d > 0);
            TrialPoint {
                active: if entry { name == now_entry } else { name == now_exit },
                role: if entry { "entry" } else { "exit" },
                alive: p["alive"].as_bool().unwrap_or(false),
                delay_ms: last.map(|d| d as u32),
                name,
                label,
                summary,
            }
        })
        .collect();
    s
}

/// Проверить все точки сейчас (движок сам обновит выбор в группах).
pub async fn check() -> Result<TrialStatus, String> {
    let (ctl, secret, mut groups) = {
        let g = TRIAL.lock().unwrap();
        let t = g.as_ref().ok_or("Пробный запуск не идёт")?;
        (t.ctl.clone(), t.secret.clone(), t.groups.clone())
    };
    // Сначала входы и участники, главная группа — последней (выберет по свежим замерам).
    groups.sort_by_key(|g| (g == GROUP, !g.ends_with("ENTRY")));
    let url = percent_encoding::utf8_percent_encode(CHECK_URL, percent_encoding::NON_ALPHANUMERIC).to_string();
    for g in &groups {
        let _ = controller::raw(&ctl, &secret, "GET", &format!("/group/{g}/delay?url={url}&timeout=8000"), Duration::from_secs(12)).await;
    }
    Ok(status().await)
}

/// Отдельное окно браузера через пробный движок (свой профиль браузера,
/// чтобы не смешивать с обычным).
pub fn browser() -> Result<String, String> {
    let port = TRIAL.lock().unwrap().as_ref().map(|t| t.port).ok_or("Пробный запуск не идёт")?;
    let pf = |v: &str| std::env::var(v).unwrap_or_default();
    // Любой браузер на Chromium понимает --proxy-server и свой профиль.
    let mut candidates = vec![];
    for root in [pf("ProgramFiles"), pf("ProgramFiles(x86)"), pf("LOCALAPPDATA")] {
        for rel in [
            r"BraveSoftware\Brave-Browser\Application\brave.exe",
            r"Google\Chrome\Application\chrome.exe",
            r"Microsoft\Edge\Application\msedge.exe",
            r"Yandex\YandexBrowser\Application\browser.exe",
            r"Vivaldi\Application\vivaldi.exe",
            r"Programs\Opera\opera.exe",
        ] {
            candidates.push(format!(r"{root}\{rel}"));
        }
    }
    let exe = candidates
        .iter()
        .find(|p| std::path::Path::new(p).exists())
        .ok_or("Не нашёл браузер на Chromium (Brave, Chrome, Edge, Яндекс, Vivaldi, Opera)")?;
    let profile = dir().join("browser");
    Command::new(exe)
        .arg(format!("--proxy-server=http://127.0.0.1:{port}"))
        .arg(format!("--user-data-dir={}", profile.display()))
        .args(["--no-first-run", "--no-default-browser-check", "--new-window", "https://ipinfo.io/"])
        .spawn()
        .map_err(|e| format!("браузер: {e}"))?;
    Ok(exe.rsplit('\\').next().unwrap_or("браузер").to_string())
}

/// Для монитора в лаборатории: конфиг, API и подписи точек пробного движка.
pub struct Source {
    pub config: PathBuf,
    pub ctl: String,
    pub secret: String,
    pub profile: String,
    /// (имя в конфиге, подпись)
    pub labels: Vec<(String, String)>,
    pub creds: Vec<(String, crate::config::Creds)>,
}

pub fn source() -> Option<Source> {
    let g = TRIAL.lock().unwrap();
    let t = g.as_ref()?;
    Some(Source {
        config: dir().join("config.yaml"),
        ctl: t.ctl.clone(),
        secret: t.secret.clone(),
        profile: t.profile.clone(),
        labels: t.points.iter().map(|p| (p.name.clone(), p.label.clone())).collect(),
        creds: t.creds.clone(),
    })
}

pub fn port() -> Option<u16> {
    TRIAL.lock().unwrap().as_ref().map(|t| t.port)
}

// ─── Команды окна ────────────────────────────────────────────────

#[tauri::command]
pub async fn trial_start(id: String) -> Result<TrialStatus, String> {
    start(&id).await
}

#[tauri::command]
pub async fn trial_status() -> TrialStatus {
    status().await
}

#[tauri::command]
pub async fn trial_check() -> Result<TrialStatus, String> {
    check().await
}

#[tauri::command]
pub fn trial_stop() {
    stop();
}

#[tauri::command]
pub fn trial_browser() -> Result<String, String> {
    browser()
}

#[tauri::command]
pub async fn trial_speed() -> Result<crate::monitor::speedtest::SpeedResult, String> {
    let port = port().ok_or("Пробный запуск не идёт")?;
    tokio::task::spawn_blocking(move || crate::monitor::speedtest::run_via(Some(port))).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stripped_config_keeps_shape_without_secrets() {
        let mut c = json!({
            "secret": "api-s3cret", "mixed-port": 7890,
            "proxies": [
                {"name": "wpx-0", "type": "vless", "server": "203.0.113.7", "port": 443, "uuid": "uuid-1", "reality-opts": {"public-key": "pbk"}},
                {"name": "wpx-1", "type": "wireguard", "server": "203.0.113.7", "port": 51820, "private-key": "privkey", "pre-shared-key": "psk", "public-key": "spub"},
                {"name": "wpx-http", "type": "http", "server": "203.0.113.50", "port": 59100, "username": "proxyuser", "password": "pw-1"}
            ],
            "proxy-groups": [{"name": "PROXY", "proxies": ["wpx-0", "wpx-1"]}]
        });
        strip_secrets(&mut c);
        let t = c.to_string();
        for s in ["api-s3cret", "uuid-1", "privkey", "psk", "proxyuser", "pw-1"] {
            assert!(!t.contains(s), "{s} остался: {t}");
        }
        // Монитору нужны адреса, протоколы, открытые параметры и группы.
        assert_eq!(c["proxies"][0]["server"], "203.0.113.7");
        assert_eq!(c["proxies"][0]["reality-opts"]["public-key"], "pbk");
        assert_eq!(c["proxies"][1]["public-key"], "spub");
        assert_eq!(c["proxies"][2]["type"], "http");
        assert_eq!(c["proxy-groups"][0]["name"], "PROXY");
        assert_eq!(c["mixed-port"], 7890);
        assert!(c.get("secret").is_none());
        // Не объект — не падаем.
        strip_secrets(&mut json!([1, 2]));
    }
}
