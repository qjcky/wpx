//! Локальный API mihomo (external-controller): активный выход группы,
//! соединения, закрепление точки, закрытие соединения и пауза (режим «всё напрямую»).

use serde_json::Value;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::timeout;

pub struct GroupState {
    /// Имя активного выхода.
    pub now: String,
}

async fn get(addr: &str, secret: &str, path: &str) -> Result<Value, String> {
    request(addr, secret, "GET", path).await
}

async fn request(addr: &str, secret: &str, method: &str, path: &str) -> Result<Value, String> {
    let (code, body) = raw(addr, secret, method, path, Duration::from_secs(3)).await?;
    match code {
        204 => Ok(Value::Null),
        200 => Ok(body),
        c => Err(format!("HTTP {c}")),
    }
}

/// Запрос к API: (код ответа, тело как JSON — или Null, если не JSON).
/// Ошибочные ответы тоже возвращаются — в них mihomo пишет причину.
pub async fn raw(addr: &str, secret: &str, method: &str, path: &str, wait: Duration) -> Result<(u16, Value), String> {
    raw_body(addr, secret, method, path, "", wait).await
}

/// То же с JSON-телом (PUT выбора точки).
pub async fn raw_body(addr: &str, secret: &str, method: &str, path: &str, body: &str, wait: Duration) -> Result<(u16, Value), String> {
    let run = async {
        let mut s = TcpStream::connect(addr).await.map_err(|e| e.to_string())?;
        let req = format!(
            "{method} {path} HTTP/1.1\r\nHost: {addr}\r\nAuthorization: Bearer {secret}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        s.write_all(req.as_bytes()).await.map_err(|e| e.to_string())?;
        let mut buf = Vec::new();
        s.read_to_end(&mut buf).await.map_err(|e| e.to_string())?;
        let i = buf.windows(4).position(|w| w == b"\r\n\r\n").ok_or("пустой ответ")?;
        let head = String::from_utf8_lossy(&buf[..i]).to_string();
        let code: u16 = head.split_whitespace().nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
        let mut body = buf[i + 4..].to_vec();
        if head.to_ascii_lowercase().contains("transfer-encoding: chunked") {
            body = dechunk(&body);
        }
        Ok::<_, String>((code, serde_json::from_slice(&body).unwrap_or(Value::Null)))
    };
    timeout(wait, run).await.map_err(|_| "таймаут".to_string())?
}

fn dechunk(b: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let Some(nl) = b[i..].windows(2).position(|w| w == b"\r\n") else { break };
        let size = usize::from_str_radix(String::from_utf8_lossy(&b[i..i + nl]).trim(), 16).unwrap_or(0);
        i += nl + 2;
        if size == 0 || i + size > b.len() {
            break;
        }
        out.extend_from_slice(&b[i..i + size]);
        i += size + 2;
    }
    out
}

/// Активный выход группы. Если выбрана другая группа (маршрут из
/// профилей: PROXY → R1 → точка), идём по цепочке до конкретной точки.
pub async fn group(addr: &str, secret: &str, group: &str) -> Result<GroupState, String> {
    let v = get(addr, secret, "/proxies").await?;
    let proxies = v.get("proxies").ok_or("нет proxies")?;
    Ok(GroupState { now: leaf(proxies, group).ok_or("нет группы")? })
}

/// Точка, до которой доходит выбор группы (через вложенные группы).
pub fn leaf(proxies: &Value, group: &str) -> Option<String> {
    let mut cur = proxies.get(group)?.get("now")?.as_str()?.to_string();
    for _ in 0..5 {
        match proxies.get(&cur).and_then(|p| p.get("now")).and_then(|n| n.as_str()).filter(|n| !n.is_empty()) {
            Some(next) => cur = next.to_string(),
            None => break,
        }
    }
    Some(cur)
}

/// Одно соединение через движок (поля, нужные окну).
#[derive(serde::Serialize, Clone, Debug)]
pub struct Conn {
    pub id: String,
    /// Имя процесса (из пути exe) или "—".
    pub process: String,
    /// Полный путь exe (если движок его знает).
    pub path: String,
    pub host: String,
    pub ip: String,
    pub port: u16,
    pub network: String,
    /// Порт приложения — по нему находится процесс (follow.rs).
    pub sport: u16,
    pub up: u64,
    pub down: u64,
    /// unix ms начала
    pub start: i64,
    /// Через какой выход (последнее звено цепочки), либо DIRECT.
    pub via: String,
    pub rule: String,
    /// "vpn" — через профиль, "direct" — напрямую, "block" — заблокировано.
    pub route: &'static str,
    /// Для людей: точка профиля («Сингапур · VLESS»), иначе пусто.
    pub label: String,
}

/// Куда ушло соединение по последнему звену цепочки.
pub fn route_of(via: &str) -> &'static str {
    match via {
        "" | "DIRECT" => "direct",
        "REJECT" | "REJECT-DROP" | "PASS" => "block",
        _ => "vpn",
    }
}

#[derive(serde::Serialize, Default)]
pub struct ConnList {
    pub conns: Vec<Conn>,
    pub up_total: u64,
    pub down_total: u64,
}

pub async fn connections(addr: &str, secret: &str) -> Result<ConnList, String> {
    let v = get(addr, secret, "/connections").await?;
    let s = |o: &Value, k: &str| o.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    let conns = v
        .get("connections")
        .and_then(|c| c.as_array())
        .into_iter()
        .flatten()
        .map(|c| {
            let m = c.get("metadata").cloned().unwrap_or(Value::Null);
            let path = s(&m, "processPath");
            let process = match (s(&m, "process"), path.rsplit(['\\', '/']).next().unwrap_or("")) {
                (p, _) if !p.is_empty() => p,
                (_, f) if !f.is_empty() => f.to_string(),
                _ => "—".into(),
            };
            let via = c.get("chains").and_then(|x| x.as_array()).and_then(|a| a.first()).and_then(|x| x.as_str()).unwrap_or("").to_string();
            Conn {
                id: s(c, "id"),
                process,
                path,
                host: s(&m, "host"),
                ip: s(&m, "destinationIP"),
                port: s(&m, "destinationPort").parse().unwrap_or(0),
                network: s(&m, "network"),
                sport: s(&m, "sourcePort").parse().unwrap_or(0),
                up: c.get("upload").and_then(|x| x.as_u64()).unwrap_or(0),
                down: c.get("download").and_then(|x| x.as_u64()).unwrap_or(0),
                start: chrono::DateTime::parse_from_rfc3339(&s(c, "start")).map(|d| d.timestamp_millis()).unwrap_or(0),
                route: route_of(&via),
                via,
                rule: s(c, "rule"),
                label: String::new(),
            }
        })
        .collect();
    Ok(ConnList {
        conns,
        up_total: v.get("uploadTotal").and_then(|x| x.as_u64()).unwrap_or(0),
        down_total: v.get("downloadTotal").and_then(|x| x.as_u64()).unwrap_or(0),
    })
}

/// Закрепить точку в группе (fallback/url-test держат её, пока она жива).
pub async fn pin(addr: &str, secret: &str, group: &str, name: &str) -> Result<(), String> {
    let body = serde_json::json!({ "name": name }).to_string();
    match raw_body(addr, secret, "PUT", &format!("/proxies/{group}"), &body, Duration::from_secs(3)).await? {
        (204 | 200, _) => Ok(()),
        (c, v) => Err(format!("HTTP {c} {}", v.get("message").and_then(|m| m.as_str()).unwrap_or(""))),
    }
}

/// Снять закрепление: группа снова выбирает точку сама.
pub async fn unpin(addr: &str, secret: &str, group: &str) -> Result<(), String> {
    request(addr, secret, "DELETE", &format!("/proxies/{group}")).await.map(|_| ())
}

/// Закрыть соединение (приложение обычно сразу откроет новое).
pub async fn close(addr: &str, secret: &str, id: &str) -> Result<(), String> {
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("неверный id".into());
    }
    request(addr, secret, "DELETE", &format!("/connections/{id}")).await.map(|_| ())
}

/// Режим движка: «rule» — по правилам, «direct» — всё напрямую (пауза).
pub async fn mode(addr: &str, secret: &str) -> Result<String, String> {
    let v = get(addr, secret, "/configs").await?;
    v.get("mode").and_then(Value::as_str).map(str::to_lowercase).ok_or_else(|| "движок не сообщил режим".into())
}

/// Сменить режим на лету (до перезапуска движка: в файле конфига — «rule»)
/// и закрыть открытые соединения — они переоткроются уже по новому режиму.
pub async fn set_mode(addr: &str, secret: &str, mode: &str) -> Result<(), String> {
    let body = serde_json::json!({ "mode": mode }).to_string();
    match raw_body(addr, secret, "PATCH", "/configs", &body, Duration::from_secs(3)).await? {
        (204 | 200, _) => {}
        (c, v) => return Err(format!("HTTP {c} {}", v.get("message").and_then(|m| m.as_str()).unwrap_or(""))),
    }
    request(addr, secret, "DELETE", "/connections").await.map(|_| ())
}

#[cfg(test)]
mod tests {
    #[test]
    fn dechunks() {
        assert_eq!(super::dechunk(b"4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n"), b"Wikipedia");
    }
}
