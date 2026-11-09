//! Linux: адаптеры — из /sys/class/net и таблицы маршрутов /proc/net/route.

use std::fs;

/// Включённые физические адаптеры: у них есть `device` в /sys/class/net.
pub fn physical_adapters() -> Vec<String> {
    let Ok(rd) = fs::read_dir("/sys/class/net") else { return vec![] };
    let mut out: Vec<String> = rd
        .flatten()
        .filter(|e| e.path().join("device").exists())
        .filter(|e| fs::read_to_string(e.path().join("operstate")).map(|s| s.trim() == "up").unwrap_or(false))
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    out.sort();
    out
}

/// Адаптер с маршрутом по умолчанию (через него ходит ПК), кроме туннеля.
pub fn default_interface() -> Option<String> {
    let routes = fs::read_to_string("/proc/net/route").ok()?;
    let phys = physical_adapters();
    let default: Vec<String> = routes
        .lines()
        .skip(1)
        .filter_map(|l| {
            let f: Vec<&str> = l.split_whitespace().collect();
            (f.len() > 2 && f[1] == "00000000").then(|| f[0].to_string())
        })
        .collect();
    default.iter().find(|d| phys.contains(d)).cloned().or_else(|| phys.into_iter().next())
}

/// Открыть файл программой по умолчанию.
pub fn open_file(path: &std::path::Path) {
    let _ = std::process::Command::new("xdg-open").arg(path).spawn();
}

/// IPv4 адаптера (`ip -4 -o addr show dev …`).
pub fn iface_ipv4(alias: &str) -> Option<std::net::IpAddr> {
    let out = std::process::Command::new("ip").args(["-4", "-o", "addr", "show", "dev", alias]).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let w: Vec<&str> = text.split_whitespace().collect();
    let i = w.iter().position(|x| *x == "inet")?;
    w.get(i + 1)?.split('/').next()?.parse().ok()
}

/// Глобальные IPv6 адаптера (/proc/net/if_inet6, scope 00).
pub fn iface_ipv6(alias: &str) -> Vec<String> {
    let Ok(t) = fs::read_to_string("/proc/net/if_inet6") else { return vec![] };
    t.lines()
        .filter_map(|l| {
            let c: Vec<&str> = l.split_whitespace().collect();
            (c.len() >= 6 && c[5] == alias && c[3] == "00" && c[0].len() == 32).then(|| {
                c[0].as_bytes().chunks(4).map(|g| String::from_utf8_lossy(g).to_string()).collect::<Vec<_>>().join(":")
            })
        })
        .collect()
}
