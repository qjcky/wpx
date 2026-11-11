//! Песочница: временная копия движка для проверки точек подключения.
//!
//! - Своё имя процесса (`wpx-probe.exe`) — ни монитор wpx, ни самовосстановление
//!   самовосстановления не спутают её с рабочим движком.
//! - Без TUN, без входящих портов, без прав администратора: только
//!   локальный API на случайном порту. Систему не меняет.
//! - Задержку по каждой точке меряет сам движок (`/proxies/:name/delay`),
//!   поэтому проверка честная для любого протокола (VLESS, Hysteria2, AWG…).
//!
//! Это фундамент автоподбора: поставили на сервер несколько протоколов —
//! песочница выясняет, какие проходят через провайдера и какой быстрее.

use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use crate::config;
use crate::engine::controller;
use crate::profiles::proto::{self, Endpoint, Kind};
use crate::platform::Hidden;

const PROBE_URL: &str = "http://www.gstatic.com/generate_204";
/// Проверка на «заморозку»: 256 КБ — больше порога ~16–20 КБ, после которого
/// ТСПУ замораживает соединения к части зарубежных хостингов.
const BULK_URL: &str = "https://speed.cloudflare.com/__down?bytes=262144";
pub const BULK_BYTES: u64 = 262_144;

#[derive(Serialize, Clone, Debug)]
pub struct Bulk {
    /// Сколько байт пришло из 256 КБ и за сколько.
    pub bytes: u64,
    pub ms: u32,
    /// Загрузка встала, не дойдя до конца.
    pub stalled: bool,
}

impl Bulk {
    /// Для людей: «замерзает после ~16 КБ» и т.п.; `None` — всё дошло.
    pub fn note(&self) -> Option<String> {
        let kb = self.bytes / 1024;
        match (self.stalled, self.bytes) {
            (false, _) => None,
            (true, 0) => Some("данные не идут — соединение есть, а загрузка стоит".into()),
            (true, b) if b <= 64 * 1024 => Some(format!("замерзает после ~{kb} КБ — похоже на ТСПУ")),
            (true, _) => Some(format!("загрузка оборвалась на {kb} КБ")),
        }
    }
}

/// Скачать 256 КБ через локальный HTTP-прокси (`port`) или обычным путём ПК.
pub fn bulk(port: Option<u16>) -> Bulk {
    let via: Vec<String> = match port {
        Some(p) => vec!["-x".into(), format!("http://127.0.0.1:{p}")],
        None => vec!["--noproxy".into(), "*".into()],
    };
    let out = Command::new(crate::platform::CURL)
        .args(&via)
        // Встала на 6 с (меньше 2 КБ/с) — значит, заморожена.
        .args(["-s", "-o", crate::platform::NULL_DEV, "--max-time", "25", "--speed-time", "6", "--speed-limit", "2048", "-w", "%{size_download} %{time_total}", BULK_URL])
        .hidden()
        .output();
    let t = out.map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap_or_default();
    let f: Vec<f64> = t.split_whitespace().map(|x| x.parse().unwrap_or(0.0)).collect();
    let bytes = f.first().copied().unwrap_or(0.0) as u64;
    Bulk { bytes, ms: (f.get(1).copied().unwrap_or(0.0) * 1000.0) as u32, stalled: bytes < BULK_BYTES }
}

#[derive(Serialize, Clone, Debug)]
pub struct ProbeResult {
    pub index: usize,
    pub label: String,
    pub kind: Kind,
    pub summary: String,
    /// Сколько замеров из `rounds` прошло.
    pub ok: u32,
    pub rounds: u32,
    /// Медиана задержки удачных замеров, мс.
    pub median_ms: Option<u32>,
    pub best_ms: Option<u32>,
    pub error: Option<String>,
    /// Проверка на заморозку (при `Options::bulk`, если точка ответила).
    pub bulk: Option<Bulk>,
}

#[derive(Clone, Debug, Default)]
pub struct Options {
    /// Привязать исходящие соединения к физическому адаптеру — проверка
    /// «как без туннеля», мимо рабочего TUN. Для стенда на 127.0.0.1 — None.
    pub interface: Option<String>,
    /// Замеров на точку (медиана устойчивее единичного).
    pub rounds: u32,
    /// Таймаут одного замера, мс.
    pub timeout_ms: u32,
    /// Вход каскада: проверяемые точки подключаются через него
    /// (`dialer-proxy`), как в рабочем конфиге.
    pub via: Vec<Endpoint>,
    pub via_mode: String,
    /// Ещё и скачать 256 КБ через каждую ответившую точку (заморозка).
    pub bulk: bool,
}

const VIA_GROUP: &str = "VIA";

fn probe_exe() -> Result<PathBuf, String> {
    engine_copy("sandbox", &crate::platform::exe("wpx-probe"))
}

/// Копия mihomo под своим именем в папке данных wpx (обновляется, если
/// исходник сменился). Исходник — mihomo из поставки wpx, иначе движка.
/// Своё имя процесса — монитор и самовосстановление рабочего движка его не спутают.
pub fn engine_copy(sub: &str, name: &str) -> Result<PathBuf, String> {
    let src = [config::bundled_mihomo(), config::wpx().mihomo()]
        .into_iter()
        .find(|p| std::fs::File::open(p).is_ok())
        .ok_or("не найден mihomo (ни в поставке wpx, ни у движка) — переустановите wpx")?;
    let dir = config::data_dir().join(sub);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dst = dir.join(name);
    let same = match (std::fs::metadata(&src), std::fs::metadata(&dst)) {
        (Ok(a), Ok(b)) => a.len() == b.len() && a.modified().ok() <= b.modified().ok(),
        _ => false,
    };
    if !same {
        std::fs::copy(&src, &dst).map_err(|e| format!("копия движка: {e}"))?;
    }
    Ok(dst)
}

pub fn free_port() -> Result<u16, String> {
    let l = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    Ok(l.local_addr().map_err(|e| e.to_string())?.port())
}

/// Конфиг песочницы: только прокси и API, весь остальной трафик — никуда.
fn config_for(eps: &[Endpoint], ctl: &str, secret: &str, opt: &Options, listen: &[u16]) -> Value {
    let via: Vec<String> = (0..opt.via.len()).map(|i| format!("v{i}")).collect();
    let mut proxies: Vec<Value> = opt.via.iter().zip(&via).map(|(e, n)| proto::to_mihomo(e, n)).collect();
    for (i, e) in eps.iter().enumerate() {
        let mut v = proto::to_mihomo(e, &format!("p{i}"));
        if !via.is_empty() {
            v["dialer-proxy"] = json!(VIA_GROUP);
        }
        proxies.push(v);
    }
    let groups: Vec<Value> = if via.is_empty() {
        vec![]
    } else {
        vec![crate::engine::netcfg::group_json(VIA_GROUP, &via.iter().collect::<Vec<_>>(), &opt.via_mode)]
    };
    let mut cfg = json!({
        "mode": "rule",
        "log-level": "warning",
        "ipv6": false,
        "allow-lan": false,
        "bind-address": "127.0.0.1",
        "external-controller": ctl,
        "secret": secret,
        "proxies": proxies,
        "proxy-groups": groups,
        "rules": ["MATCH,REJECT"],
        "profile": { "store-selected": false, "store-fake-ip": false },
    });
    if let Some(i) = &opt.interface {
        cfg["interface-name"] = json!(i);
    }
    // Свой локальный вход на каждую точку — для загрузки через неё (мимо правил).
    if !listen.is_empty() {
        cfg["listeners"] = json!(listen
            .iter()
            .enumerate()
            .map(|(i, p)| json!({ "name": format!("in{i}"), "type": "http", "listen": "127.0.0.1", "port": p, "proxy": format!("p{i}") }))
            .collect::<Vec<_>>());
    }
    cfg
}

/// `mihomo -t` для конфига. При ошибке — пытается указать виновную точку.
fn validate(exe: &Path, dir: &Path, eps: &[Endpoint], opt: &Options) -> Result<(), String> {
    let test = |eps: &[Endpoint]| -> Result<(), String> {
        let p = dir.join("check.yaml");
        let cfg = config_for(eps, "127.0.0.1:0", "x", opt, &[]);
        std::fs::write(&p, serde_json::to_string_pretty(&cfg).unwrap_or_default()).map_err(|e| e.to_string())?;
        let out = Command::new(exe)
            .arg("-t").arg("-d").arg(dir).arg("-f").arg(&p)
            .hidden()
            .output()
            .map_err(|e| format!("mihomo -t: {e}"))?;
        let text = String::from_utf8_lossy(&out.stdout).to_string() + &String::from_utf8_lossy(&out.stderr);
        if out.status.success() && text.contains("test is successful") {
            Ok(())
        } else {
            Err(text.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("конфиг не принят").trim().to_string())
        }
    };
    match test(eps) {
        Ok(()) => Ok(()),
        Err(all) => {
            if !opt.via.is_empty() {
                if let Err(one) = test(&[]) {
                    return Err(format!("вход каскада: {one}"));
                }
            }
            for e in eps {
                if let Err(one) = test(std::slice::from_ref(e)) {
                    return Err(format!("«{}»: {one}", e.label));
                }
            }
            Err(all)
        }
    }
}

/// Папка одного запуска песочницы: проверки идут параллельно (активация,
/// роутер, серверы), у каждой — свои конфиги; после — удаляется (в
/// конфигах ключи точек).
struct RunDir(PathBuf);
impl Drop for RunDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Папка запусков песочницы.
fn runs_dir() -> PathBuf {
    config::data_dir().join("sandbox")
}

/// Проверка столько не живёт: папка `run-*` старше — остаток упавшего wpx.
const STALE: Duration = Duration::from_secs(15 * 60);

/// Убрать папки `run-*`, оставшиеся от упавшего wpx (в них конфиги с
/// ключами точек). Только старше `age` — параллельные проверки не задеть.
fn remove_stale(base: &Path, age: Duration, now: std::time::SystemTime) {
    let Ok(rd) = std::fs::read_dir(base) else { return };
    for e in rd.flatten() {
        if !e.file_name().to_string_lossy().starts_with("run-") {
            continue;
        }
        let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| now.duration_since(t).ok()).is_some_and(|a| a > age);
        if old {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

struct Guard(Child);
impl Drop for Guard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Проверить точки подключения: по `rounds` замеров задержки на каждую.
pub async fn probe(eps: Vec<Endpoint>, opt: Options) -> Result<Vec<ProbeResult>, String> {
    if eps.is_empty() {
        return Ok(vec![]);
    }
    let opt = Options { rounds: opt.rounds.clamp(1, 10), timeout_ms: opt.timeout_ms.clamp(1000, 15000), ..opt };
    let exe = probe_exe()?;
    remove_stale(&runs_dir(), STALE, std::time::SystemTime::now());
    let run = RunDir(runs_dir().join(format!("run-{}", crate::engine::ops::random_hex(10))));
    std::fs::create_dir_all(&run.0).map_err(|e| e.to_string())?;
    let dir = run.0.clone();
    {
        let (exe, dir, eps, opt) = (exe.clone(), dir.clone(), eps.clone(), opt.clone());
        tokio::task::spawn_blocking(move || validate(&exe, &dir, &eps, &opt))
            .await
            .map_err(|e| e.to_string())??;
    }

    let ctl = format!("127.0.0.1:{}", free_port()?);
    let secret = crate::engine::ops::random_hex(24);
    let listen: Vec<u16> = if opt.bulk { eps.iter().map(|_| free_port()).collect::<Result<_, _>>()? } else { vec![] };
    let cfg_path = dir.join("sandbox.yaml");
    std::fs::write(&cfg_path, serde_json::to_string_pretty(&config_for(&eps, &ctl, &secret, &opt, &listen)).unwrap_or_default())
        .map_err(|e| e.to_string())?;
    let child = Command::new(&exe)
        .arg("-d").arg(&dir).arg("-f").arg(&cfg_path)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .hidden()
        .spawn()
        .map_err(|e| format!("запуск песочницы: {e}"))?;
    let _guard = Guard(child);

    // Ждём API движка.
    let t0 = Instant::now();
    loop {
        if controller::raw(&ctl, &secret, "GET", "/version", Duration::from_secs(1)).await.map(|r| r.0) == Ok(200) {
            break;
        }
        if t0.elapsed() > Duration::from_secs(8) {
            return Err("песочница не запустилась за 8 с".into());
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }

    let url = percent_encoding::utf8_percent_encode(PROBE_URL, percent_encoding::NON_ALPHANUMERIC).to_string();
    let mut tasks = vec![];
    for (i, ep) in eps.iter().enumerate() {
        let (ctl, secret, url, opt, ep) = (ctl.clone(), secret.clone(), url.clone(), opt.clone(), ep.clone());
        let port = listen.get(i).copied();
        tasks.push(tokio::spawn(async move {
            let mut delays = vec![];
            let mut last_err = None;
            for _ in 0..opt.rounds {
                let path = format!("/proxies/p{i}/delay?timeout={}&url={url}", opt.timeout_ms);
                let wait = Duration::from_millis(opt.timeout_ms as u64 + 3000);
                match controller::raw(&ctl, &secret, "GET", &path, wait).await {
                    Ok((200, v)) => match v.get("delay").and_then(|d| d.as_u64()) {
                        Some(d) if d > 0 => delays.push(d as u32),
                        _ => last_err = Some("пустой ответ движка".to_string()),
                    },
                    Ok((code, v)) => {
                        last_err = Some(match v.get("message").and_then(|m| m.as_str()) {
                            Some(m) => humanize(m),
                            None => format!("ответ {code}"),
                        })
                    }
                    Err(e) => last_err = Some(e),
                }
            }
            delays.sort_unstable();
            let bulk = match port {
                Some(p) if !delays.is_empty() => tokio::task::spawn_blocking(move || bulk(Some(p))).await.ok(),
                _ => None,
            };
            ProbeResult {
                index: i,
                label: ep.label.clone(),
                kind: ep.kind,
                summary: ep.summary(),
                ok: delays.len() as u32,
                rounds: opt.rounds,
                median_ms: delays.get(delays.len() / 2).copied(),
                best_ms: delays.first().copied(),
                error: if delays.is_empty() { last_err } else { None },
                bulk,
            }
        }));
    }
    let mut out = vec![];
    for t in tasks {
        out.push(t.await.map_err(|e| e.to_string())?);
    }
    // История для «умного выбора» (проверка через вход — тоже путь к точке).
    if opt.via.is_empty() {
        for (r, e) in out.iter().zip(&eps) {
            let k = crate::monitor::history::key_of(e);
            crate::monitor::history::record(&k, r.rounds, r.ok, r.median_ms);
            if let Some(b) = &r.bulk {
                crate::monitor::history::record_bulk(&k, b.stalled);
            }
        }
    }
    Ok(out)
}

fn humanize(m: &str) -> String {
    let l = m.to_ascii_lowercase();
    if l.contains("timeout") || l.contains("deadline") {
        "нет ответа (таймаут)".into()
    } else if l.contains("refused") {
        "соединение отклонено".into()
    } else if l.contains("authentication") || l.contains("auth") {
        format!("ошибка авторизации ({m})")
    } else {
        m.to_string()
    }
}

/// Лучшая точка: не замерзает, больше удачных замеров, затем меньшая медиана.
/// Замерзающая отвечает на пинг, но данные по ней не идут — в хвост.
pub fn rank(results: &[ProbeResult]) -> Vec<usize> {
    let mut idx: Vec<usize> = (0..results.len()).filter(|&i| results[i].ok > 0).collect();
    let stalled = |i: usize| results[i].bulk.as_ref().is_some_and(|b| b.stalled);
    idx.sort_by_key(|&i| (stalled(i), std::cmp::Reverse(results[i].ok), results[i].median_ms.unwrap_or(u32::MAX)));
    idx
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(ok: u32, med: Option<u32>) -> ProbeResult {
        ProbeResult { index: 0, label: String::new(), kind: Kind::Vless, summary: String::new(), ok, rounds: 3, median_ms: med, best_ms: med, error: None, bulk: None }
    }

    #[test]
    fn ranks_reliability_then_speed() {
        let v = vec![r(2, Some(100)), r(3, Some(400)), r(0, None), r(3, Some(200))];
        assert_eq!(rank(&v), vec![3, 1, 0]);
    }

    #[test]
    fn stale_runs_removed_live_ones_kept() {
        let base = std::env::temp_dir().join(format!("wpx-sandbox-test-{}", crate::engine::ops::random_hex(8)));
        let (a, b, other) = (base.join("run-a"), base.join("run-b"), base.join("keep"));
        for d in [&a, &b, &other] {
            std::fs::create_dir_all(d).unwrap();
            std::fs::write(d.join("sandbox.yaml"), "k").unwrap();
        }
        let now = std::time::SystemTime::now();
        // Свежие — идущие проверки — не трогаем.
        remove_stale(&base, STALE, now);
        assert!(a.exists() && b.exists() && other.exists());
        // Постарели — убраны; чужие папки целы.
        remove_stale(&base, STALE, now + STALE * 2);
        assert!(!a.exists() && !b.exists() && other.exists());
        remove_stale(&base.join("нет-такой"), STALE, now);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn frozen_points_go_last() {
        let mut fast = r(3, Some(100));
        fast.bulk = Some(Bulk { bytes: 16_384, ms: 9000, stalled: true });
        let slow = Bulk { bytes: BULK_BYTES, ms: 1200, stalled: false };
        let v = vec![fast, ProbeResult { bulk: Some(slow), ..r(3, Some(900)) }, r(2, Some(300))];
        assert_eq!(rank(&v), vec![1, 2, 0]);
        assert_eq!(v[0].bulk.as_ref().unwrap().note().unwrap(), "замерзает после ~16 КБ — похоже на ТСПУ");
        assert!(v[1].bulk.as_ref().unwrap().note().is_none());
    }
}
