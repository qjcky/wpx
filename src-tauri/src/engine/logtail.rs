//! Хвост журнала движка: читаем только новые байты, переводим строки mihomo
//! в понятные события и считаем частоту ошибок.
//!
//! Журнал — UTF-8 от mihomo; нулевые байты (бывают после перезаписи файла
//! на лету) просто выбрасываем.

use serde::Serialize;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    /// Не удалось достучаться до самого прокси-сервера.
    ProxyUnreachable,
    /// Соединение через прокси не уложилось в таймаут движка.
    Timeout,
    /// Прокси оборвал соединение.
    Dropped,
    /// Сеть ещё не поднялась (обычно старт ПК).
    NetStartup,
    /// Пропал/сменился сетевой интерфейс.
    Link,
    EngineStart,
    EngineStop,
    /// Действие сторожа самовосстановления.
    Heal,
    /// Движок перешёл на другую точку или вход (маршрут, резерв).
    PathSwitch,
    /// Данные по рабочему пути встают на первых килобайтах (заморозка ТСПУ).
    Slowdown,
    Other,
}

impl Kind {
    pub fn is_error(self) -> bool {
        matches!(self, Kind::ProxyUnreachable | Kind::Timeout | Kind::Dropped | Kind::Other)
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct LogEvent {
    /// unix ms
    pub t: i64,
    pub kind: Kind,
    /// Хост назначения без порта, если есть.
    pub dest: Option<String>,
    pub count: u32,
    pub text: String,
}

pub struct LogTail {
    path: PathBuf,
    pos: u64,
    partial: String,
}

impl LogTail {
    pub fn new(path: PathBuf) -> Self {
        Self { path, pos: 0, partial: String::new() }
    }

    /// Новые строки с прошлого вызова. На первом вызове — последние ~256 КБ.
    pub fn poll(&mut self) -> Vec<String> {
        let Ok(mut f) = std::fs::File::open(&self.path) else { return vec![] };
        let len = f.metadata().map(|m| m.len()).unwrap_or(0);
        if len < self.pos {
            self.pos = 0; // файл пересоздали
            self.partial.clear();
        }
        if self.pos == 0 && len > 256 * 1024 {
            self.pos = len - 256 * 1024;
        }
        if len == self.pos || f.seek(SeekFrom::Start(self.pos)).is_err() {
            return vec![];
        }
        let mut raw = Vec::new();
        if f.take(4 * 1024 * 1024).read_to_end(&mut raw).is_err() {
            return vec![];
        }
        self.pos += raw.len() as u64;
        raw.retain(|&b| b != 0 && b != b'\r');
        let text = String::from_utf8_lossy(&raw);
        let mut buf = std::mem::take(&mut self.partial);
        buf.push_str(&text);
        let mut lines: Vec<String> = buf.split('\n').map(str::to_string).collect();
        self.partial = lines.pop().unwrap_or_default();
        lines.retain(|l| !l.trim().is_empty());
        lines
    }
}

fn field<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    let start = line.find(&format!("{key}=\""))? + key.len() + 2;
    let rest = &line[start..];
    let end = rest.find('"')?;
    Some(&rest[..end])
}

/// Строка журнала mihomo → событие. `None` для неинтересного (info-шум).
pub fn parse_line(line: &str) -> Option<LogEvent> {
    let t = field(line, "time")
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.timestamp_millis())?;
    let level = line
        .split("level=")
        .nth(1)
        .and_then(|s| s.split_whitespace().next())
        .unwrap_or("");
    let msg = line.split("msg=\"").nth(1).unwrap_or("").trim_end_matches('"');

    let dest = msg
        .split("--> ")
        .nth(1)
        .and_then(|s| s.split_whitespace().next())
        .map(|hp| match hp.rsplit_once(':') {
            Some((h, p)) if p.chars().all(|c| c.is_ascii_digit()) => h.to_string(),
            _ => hp.to_string(),
        });

    let (kind, text) = if msg.contains("Start initial configuration") {
        (Kind::EngineStart, "Движок запущен".to_string())
    } else if msg.contains("shutting down") {
        (Kind::EngineStop, "Движок остановлен".to_string())
    } else if msg.contains("default interface lost") {
        (Kind::Link, "Пропал сетевой интерфейс".to_string())
    } else if msg.contains("default interface changed") {
        (Kind::Link, "Сетевой интерфейс подключён".to_string())
    } else if msg.contains("connect error") && msg.contains("timeout") {
        (Kind::ProxyUnreachable, "Сервер прокси не ответил на подключение".to_string())
    } else if msg.contains("not valid in its context") || msg.contains("forbidden by its access") {
        (Kind::NetStartup, "Сеть ещё не готова".to_string())
    } else if msg.contains("context deadline exceeded") {
        (Kind::Timeout, "Не дождались ответа через прокси".to_string())
    } else if msg.contains("EOF") || msg.contains("forcibly closed") || msg.contains("aborted") {
        (Kind::Dropped, "Прокси оборвал соединение".to_string())
    } else if level == "warning" || level == "error" {
        (Kind::Other, msg.chars().take(160).collect())
    } else {
        return None;
    };
    Some(LogEvent { t, kind, dest, count: 1, text })
}

/// Строка heal.log сторожа: `ISO-время|действие|причина`.
/// Возвращает событие и признак «стоит уведомить» (был перезапуск/запуск).
pub fn parse_heal(line: &str) -> Option<(LogEvent, bool)> {
    let mut p = line.splitn(3, '|');
    let t = chrono::DateTime::parse_from_rfc3339(p.next()?.trim()).ok()?.timestamp_millis();
    let (action, reason) = (p.next()?.trim(), p.next().unwrap_or("").trim());
    let (text, notify) = match (action, reason) {
        ("restart", _) => ("Самовосстановление: туннель лежал при живом прокси — движок перезапущен", true),
        ("start", _) => ("Самовосстановление: движок не работал — запущен", true),
        ("skip", "proxy unreachable") => ("Самовосстановление: прокси не отвечает — перезапуск не поможет", false),
        ("skip", "cooldown") => ("Самовосстановление: ждёт паузу между перезапусками", false),
        _ => return None,
    };
    Some((LogEvent { t, kind: Kind::Heal, dest: None, count: 1, text: text.into() }, notify))
}

/// Склейка подряд идущих одинаковых событий (в пределах 15 с) в одно с count.
pub fn coalesce(into: &mut Vec<LogEvent>, ev: LogEvent, cap: usize) {
    if let Some(last) = into.last_mut() {
        if last.kind == ev.kind && last.text == ev.text && (ev.t - last.t).abs() < 15_000 {
            last.count += 1;
            last.t = ev.t;
            if last.dest != ev.dest {
                last.dest = None; // разные цели — показываем без конкретики
            }
            return;
        }
    }
    into.push(ev);
    if into.len() > cap {
        let drop = into.len() - cap;
        into.drain(..drop);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_real_lines() {
        let l = r#"time="2026-11-03T08:02:50.400175500+08:00" level=warning msg="[TCP] dial Singapore (match Match/) 198.18.0.1:54627 --> api.anthropic.com:443 error: 203.0.113.50:59101 connect error: dial tcp 203.0.113.50:59101: i/o timeout""#;
        let e = parse_line(l).unwrap();
        assert_eq!(e.kind, Kind::ProxyUnreachable);
        assert_eq!(e.dest.as_deref(), Some("api.anthropic.com"));

        let l = r#"time="2026-11-03T08:01:20.560086400+08:00" level=warning msg="[TCP] dial Singapore (match Match/) 198.18.0.1:64300 --> 149.154.167.41:80 error: context deadline exceeded""#;
        assert_eq!(parse_line(l).unwrap().kind, Kind::Timeout);

        let l = r#"time="2026-11-03T02:31:02.773240000+08:00" level=error msg="[TUN] default interface lost by monitor""#;
        assert_eq!(parse_line(l).unwrap().kind, Kind::Link);

        let l = r#"time="2026-11-03T02:31:02.773240000+08:00" level=info msg="Geodata Loader mode: memconservative""#;
        assert!(parse_line(l).is_none());
    }

    #[test]
    fn coalesces() {
        let mk = |t, d: &str| LogEvent { t, kind: Kind::Timeout, dest: Some(d.into()), count: 1, text: String::new() };
        let mut v = Vec::new();
        coalesce(&mut v, mk(0, "a"), 10);
        coalesce(&mut v, mk(1000, "a"), 10);
        coalesce(&mut v, mk(2000, "b"), 10);
        coalesce(&mut v, mk(60_000, "b"), 10);
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].count, 3);
        assert_eq!(v[0].dest, None);
    }
}
