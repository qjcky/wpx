//! Тест скорости через туннель: Cloudflare speed endpoints, запросы идут
//! обычной маршрутизацией ПК (то есть через TUN и прокси).
//!
//! HTTPS делает системный curl (в Windows — `curl.exe` со Schannel).
//! Тратит трафик прокси: до ~25 МБ вниз и ~6 МБ вверх за прогон.

use serde::{Deserialize, Serialize};
use std::process::Command;

use crate::config;
use crate::platform::Hidden;

const DOWN_BYTES: u64 = 25_000_000;
const UP_BYTES: usize = 6_000_000;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SpeedResult {
    pub at: i64,
    pub ping_ms: Option<u32>,
    pub down_mbps: Option<f64>,
    pub up_mbps: Option<f64>,
    pub down_mb: f64,
    pub up_mb: f64,
    pub error: Option<String>,
}

/// curl → (http_code, скорость Б/с, байт, время до первого байта, с).
/// `proxy` — локальный прокси (пробный запуск профиля); иначе обычным путём ПК.
fn curl(proxy: Option<u16>, args: &[&str]) -> Result<(u16, f64, f64, f64), String> {
    let via: Vec<String> = match proxy {
        Some(p) => vec!["-x".into(), format!("http://127.0.0.1:{p}")],
        None => vec!["--noproxy".into(), "*".into()],
    };
    let out = Command::new(crate::platform::CURL)
        .args(&via)
        .args(["-s", "-o", crate::platform::NULL_DEV, "-w", "%{http_code} %{speed_download} %{speed_upload} %{size_download} %{size_upload} %{time_starttransfer}"])
        .args(args)
        .hidden()
        .output()
        .map_err(|e| format!("curl: {e}"))?;
    let t = String::from_utf8_lossy(&out.stdout);
    let f: Vec<f64> = t.split_whitespace().map(|x| x.parse().unwrap_or(0.0)).collect();
    if f.len() < 6 {
        return Err("curl не вернул результат".into());
    }
    let code = f[0] as u16;
    // скорость/объём — что из двух ненулевое (download или upload)
    let (speed, size) = if f[2] > 0.0 { (f[2], f[4]) } else { (f[1], f[3]) };
    Ok((code, speed, size, f[5]))
}

fn mbps(bytes_per_s: f64) -> f64 {
    (bytes_per_s * 8.0 / 1_000_000.0 * 10.0).round() / 10.0
}

pub fn run() -> SpeedResult {
    run_via(None)
}

pub fn run_via(proxy: Option<u16>) -> SpeedResult {
    let at = chrono::Utc::now().timestamp_millis();
    let mut r = SpeedResult { at, ping_ms: None, down_mbps: None, up_mbps: None, down_mb: 0.0, up_mb: 0.0, error: None };

    // Задержка: лучший из трёх маленьких запросов (время до первого байта).
    let mut best: Option<f64> = None;
    for _ in 0..3 {
        if let Ok((200, _, _, ttfb)) = curl(proxy, &["-m", "8", "https://speed.cloudflare.com/__down?bytes=0"]) {
            best = Some(best.map_or(ttfb, |b: f64| b.min(ttfb)));
        }
    }
    r.ping_ms = best.map(|s| (s * 1000.0) as u32);
    if r.ping_ms.is_none() {
        r.error = Some("тестовый сервер не отвечает через туннель".into());
        return r;
    }

    // Вниз: не дольше 12 с — сколько успеет.
    let down_url = format!("https://speed.cloudflare.com/__down?bytes={DOWN_BYTES}");
    match curl(proxy, &["-m", "12", &down_url]) {
        Ok((_, speed, size, _)) if size > 0.0 => {
            r.down_mbps = Some(mbps(speed));
            r.down_mb = (size / 1e6 * 10.0).round() / 10.0;
        }
        Ok((code, ..)) => r.error = Some(format!("скачивание: ответ {code}")),
        Err(e) => r.error = Some(e),
    }

    // Вверх: временный файл из нулей.
    let tmp = config::data_dir().join("speed-up.bin");
    if std::fs::write(&tmp, vec![0u8; UP_BYTES]).is_ok() {
        let arg = format!("@{}", tmp.display());
        match curl(proxy, &["-m", "12", "--data-binary", &arg, "https://speed.cloudflare.com/__up"]) {
            Ok((_, speed, size, _)) if size > 0.0 => {
                r.up_mbps = Some(mbps(speed));
                r.up_mb = (size / 1e6 * 10.0).round() / 10.0;
            }
            Ok((code, ..)) => r.error = r.error.take().or(Some(format!("загрузка: ответ {code}"))),
            Err(e) => r.error = r.error.take().or(Some(e)),
        }
        let _ = std::fs::remove_file(&tmp);
    }
    r
}

pub fn history() -> Vec<SpeedResult> {
    std::fs::read_to_string(config::data_dir().join("speed.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

pub fn remember(r: &SpeedResult) {
    let mut h = history();
    h.insert(0, r.clone());
    h.truncate(20);
    let _ = config::write_json("speed.json", &h);
}
