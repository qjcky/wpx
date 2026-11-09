//! Windows: адаптеры — из PowerShell (Get-NetAdapter, Get-NetRoute).

use super::Hidden;
use std::process::Command;

fn ps_json(script: &str) -> Vec<String> {
    let out = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &format!("[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); {script}")])
        .hidden()
        .output();
    let text = out.map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
    serde_json::from_str::<Vec<String>>(&text)
        .or_else(|_| serde_json::from_str::<String>(&text).map(|s| vec![s]))
        .unwrap_or_default()
}

/// Включённые физические адаптеры (имена, как в «Сетевых подключениях»).
pub fn physical_adapters() -> Vec<String> {
    ps_json("@(Get-NetAdapter -Physical | Where-Object Status -eq 'Up' | ForEach-Object Name) | ConvertTo-Json -Compress")
}

/// Физический адаптер с маршрутом по умолчанию (через него ходит ПК).
pub fn default_interface() -> Option<String> {
    let phys = physical_adapters();
    let routed = ps_json("@(Get-NetRoute -DestinationPrefix 0.0.0.0/0 -ErrorAction SilentlyContinue | Sort-Object RouteMetric | ForEach-Object InterfaceAlias) | ConvertTo-Json -Compress");
    routed.into_iter().find(|a| phys.contains(a)).or_else(|| phys.into_iter().next())
}

/// Открыть файл: журналы — в Блокноте.
pub fn open_file(path: &std::path::Path) {
    let _ = Command::new("notepad.exe").arg(path).spawn();
}

/// Значение в одинарных кавычках PowerShell: удваиваются и ' и «типографские»
/// ‘ ’ ‚ ‛ — PowerShell считает их кавычками тоже.
pub fn ps_quote(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '\'' | '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}' => format!("{c}{c}"),
            _ => c.to_string(),
        })
        .collect()
}

fn ps_lines(script: &str) -> Vec<String> {
    Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .hidden()
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
        .unwrap_or_default()
}

/// IPv4 адаптера (для выхода мимо туннеля).
pub fn iface_ipv4(alias: &str) -> Option<std::net::IpAddr> {
    ps_lines(&format!(
        "(Get-NetIPAddress -InterfaceAlias '{}' -AddressFamily IPv4 -ErrorAction SilentlyContinue | Select-Object -First 1).IPAddress",
        ps_quote(alias)
    ))
    .first()?
    .parse()
    .ok()
}

/// Глобальные IPv6 адаптера (есть ли IPv6 у провайдера вообще).
pub fn iface_ipv6(alias: &str) -> Vec<String> {
    ps_lines(&format!(
        "(Get-NetIPAddress -InterfaceAlias '{}' -AddressFamily IPv6 -ErrorAction SilentlyContinue | Where-Object {{ $_.PrefixOrigin -ne 'WellKnown' -and $_.IPAddress -notlike 'fe80*' }}).IPAddress",
        ps_quote(alias)
    ))
}
