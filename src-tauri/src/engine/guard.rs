//! Состояние защиты (kill switch): правила файрвола, TUN-адаптер,
//! флаги движка и живой тест «можно ли выйти мимо туннеля».
//!
//! Только чтение. Ничего не включает и не выключает.

use serde::{Deserialize, Serialize};
use std::net::IpAddr;
use std::process::Command;

use crate::config::EngineFacts;
use crate::monitor::probes;

#[derive(Clone, Debug, Serialize)]
pub struct GuardItem {
    pub key: &'static str,
    pub label: &'static str,
    /// Some(true) — в порядке, Some(false) — проблема, None — не удалось проверить.
    pub ok: Option<bool>,
    pub detail: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct SysFacts {
    rules: Vec<String>,
    profiles_off: i32,
    tun: String,
    phys_ip: String,
}

/// Linux: правила — из rules.nft движка (их же поднимает служба
/// wpx-firewall), «файрвол включён» — служба активна; туннель — адаптер есть.
#[cfg(not(windows))]
fn sys_facts(phys_alias: &str, _fw_group: &str, tun: &str) -> Result<SysFacts, String> {
    let rules = std::fs::read_to_string(std::path::Path::new(crate::config::WPX_DIR).join("rules.nft")).unwrap_or_default();
    let mut names = vec![];
    if rules.contains("udp dport { 53, 853 } drop") {
        names.push("WPX-Block-DNS-UDP".to_string());
    }
    if rules.contains("tcp dport { 53, 853 } drop") {
        names.push("WPX-Block-DNS-TCP".to_string());
    }
    if rules.contains("meta nfproto ipv6 drop") {
        names.push("WPX-Block-IPv6".to_string());
    }
    let active = Command::new("systemctl").args(["is-active", "-q", "wpx-firewall"]).status().map(|s| s.success()).unwrap_or(false);
    let up = !tun.contains('/') && std::path::Path::new("/sys/class/net").join(tun).exists();
    Ok(SysFacts {
        rules: names,
        profiles_off: if active { 0 } else { 1 },
        tun: if up { "Up".into() } else { String::new() },
        phys_ip: crate::platform::iface_ipv4(phys_alias).map(|i| i.to_string()).unwrap_or_default(),
    })
}

/// Один вызов PowerShell раз в 30 с — дешевле, чем WMI/COM руками.
#[cfg(windows)]
fn sys_facts(phys_alias: &str, fw_group: &str, tun: &str) -> Result<SysFacts, String> {
    use crate::platform::Hidden;
    let q = crate::platform::ps_quote;
    let (alias, group, tun) = (q(phys_alias), q(fw_group), q(tun));
    let script = format!(
        "$ErrorActionPreference='SilentlyContinue';\
         [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);\
         $r=@(Get-NetFirewallRule -Group '{group}' | Where-Object {{ $_.Enabled -eq 'True' -and $_.Action -eq 'Block' }} | ForEach-Object Name);\
         $p=@(Get-NetFirewallProfile | Where-Object Enabled -ne 'True').Count;\
         $a=(Get-NetAdapter -Name '{tun}').Status;\
         $ip=(Get-NetIPAddress -InterfaceAlias '{alias}' -AddressFamily IPv4 | Select-Object -First 1).IPAddress;\
         @{{rules=$r;profiles_off=$p;tun=[string]$a;phys_ip=[string]$ip}} | ConvertTo-Json -Compress"
    );
    let out = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .hidden()
        .output()
        .map_err(|e| format!("powershell: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);
    serde_json::from_str(text.trim()).map_err(|e| format!("разбор ответа: {e}"))
}

pub async fn check(facts: Option<&EngineFacts>, phys_alias: &str, fw_group: &str, ip: Option<(&str, bool)>) -> Vec<GuardItem> {
    let alias = phys_alias.to_string();
    let group = fw_group.to_string();
    let tun = facts.map(|f| f.tun_device.clone()).unwrap_or_else(|| "wpx".into());
    let tun_name = tun.clone();
    let sys = tokio::task::spawn_blocking(move || sys_facts(&alias, &group, &tun))
        .await
        .unwrap_or_else(|e| Err(e.to_string()));

    let mut items = Vec::new();
    let unk = |e: &str| (None, e.to_string());

    // Прямой выход мимо туннеля — главный тест. Не там, где он соврёт: в
    // Linux привязка к адресу адаптера не уводит мимо туннеля (нужен root);
    // в Windows kill switch пропускает сам wpx — честно проверит «Глубокая».
    let ks = crate::engine::netcfg::load().kill_switch;
    let escape = match &sys {
        _ if cfg!(not(windows)) => unk("проверяет «Глубокая проверка» (на странице «Движок»)"),
        _ if ks => unk("kill switch пропускает сам wpx — проверяет «Глубокая проверка»"),
        Ok(s) => match s.phys_ip.parse::<IpAddr>() {
            Ok(local) => match probes::direct_escape(local).await {
                Ok(false) => (Some(true), format!("с {local} на 1.1.1.1:443 — закрыто")),
                Ok(true) => (Some(false), format!("с {local} есть прямой выход!")),
                Err(e) => unk(&e),
            },
            Err(_) => unk("нет адреса физического адаптера"),
        },
        Err(e) => unk(e),
    };
    items.push(GuardItem { key: "escape", label: "Прямой выход мимо туннеля", ok: escape.0, detail: escape.1 });

    let (tun_ok, tun_d) = match &sys {
        Ok(s) if s.tun == "Up" => (Some(true), format!("{tun_name} поднят")),
        Ok(s) if s.tun.is_empty() => (Some(false), format!("адаптер {tun_name} не найден")),
        Ok(s) => (Some(false), format!("{tun_name}: {}", s.tun)),
        Err(e) => unk(e),
    };
    items.push(GuardItem { key: "tun", label: "Туннель", ok: tun_ok, detail: tun_d });

    // Правила ищем по смыслу в имени: «WPX-Block-IPv6», «WPX-Block-DNS-…».
    let has = |parts: &[&str]| {
        sys.as_ref().ok().map(|s| {
            s.rules.iter().any(|r| parts.iter().all(|p| r.to_ascii_lowercase().contains(&p.to_ascii_lowercase())))
        })
    };
    items.push(GuardItem {
        key: "ipv6",
        label: "IPv6 закрыт",
        ok: has(&["block", "ipv6"]),
        detail: format!("правило группы {fw_group}"),
    });
    let dns = match (has(&["dns", "tcp"]), has(&["dns", "udp"])) {
        (Some(a), Some(b)) => Some(a && b),
        _ => None,
    };
    items.push(GuardItem { key: "dns", label: "DNS мимо туннеля закрыт", ok: dns, detail: "53/853 TCP+UDP".into() });
    items.push(GuardItem {
        key: "fw",
        label: if cfg!(windows) { "Файрвол Windows включён" } else { "Правила nftables wpx подняты" },
        ok: sys.as_ref().ok().map(|s| s.profiles_off == 0),
        detail: match &sys {
            Ok(s) if s.profiles_off > 0 => format!("выключено профилей: {}", s.profiles_off),
            Ok(_) => "все профили".into(),
            Err(e) => e.clone(),
        },
    });

    if let Some(f) = facts {
        items.push(GuardItem {
            key: "strict",
            label: "Строгая маршрутизация",
            ok: Some(f.strict_route && f.tun_enabled),
            detail: "strict-route в конфиге движка".into(),
        });
        items.push(GuardItem {
            key: "udp",
            label: if f.udp_rejected { "UDP заблокирован" } else { "UDP через туннель" },
            ok: Some(f.udp_rejected || f.udp_tunneled),
            detail: if f.udp_rejected {
                "WebRTC/QUIC не утекают".into()
            } else if f.udp_tunneled {
                "все выходы передают UDP — звонки и игры идут через VPN".into()
            } else {
                "UDP не заблокирован, а выход его не передаёт".into()
            },
        });
    }

    if let Some((ip, expected)) = ip {
        items.push(GuardItem {
            key: "ip",
            label: "Внешний IP — выход туннеля",
            ok: Some(expected),
            detail: ip.to_string(),
        });
    }
    items
}
