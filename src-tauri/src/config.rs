//! Где живёт движок и что в его конфиге + собственные настройки wpx.
//!
//! Движок — mihomo из поставки wpx, поставленный в папку движка
//! (`C:\ProgramData\wpx\engine` в Windows, `/opt/wpx/engine` в Linux) и
//! запускаемый системой (задача `wpx-engine` / служба `wpx-engine.service`).
//! Установлен, если в папке есть маркер `wpx-active` — его ставит и снимает
//! только транзакция установки и удаления.
//!
//! Конфиг mihomo пишется в JSON-форме (валидный YAML). Пароль прокси в нём
//! открытым текстом — так требует mihomo; папка wpx закрыта ACL от записи.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[cfg(windows)]
pub const WPX_ROOT: &str = r"C:\ProgramData\wpx";
#[cfg(windows)]
pub const WPX_DIR: &str = r"C:\ProgramData\wpx\engine";
#[cfg(not(windows))]
pub const WPX_ROOT: &str = "/opt/wpx";
#[cfg(not(windows))]
pub const WPX_DIR: &str = "/opt/wpx/engine";
/// Домашняя папка mihomo (`-d`): сюда пишет только он сам (списки, правила
/// «найденного на лету», кэш). Ничего, что запускает SYSTEM или root, и папок
/// с записью для пользователя здесь нет — запись через API движка не доберётся
/// до его скриптов и exe.
#[cfg(windows)]
pub const WPX_HOME: &str = r"C:\ProgramData\wpx\engine\home";
#[cfg(not(windows))]
pub const WPX_HOME: &str = "/opt/wpx/engine/home";

/// Имя mihomo в папке движка.
pub const MIHOMO: &str = if cfg!(windows) { "mihomo.exe" } else { "mihomo" };

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EngineKind {
    /// Движок ещё не установлен: wpx только наблюдает.
    Missing,
    Wpx,
}

#[derive(Clone, Debug)]
pub struct EngineLoc {
    pub kind: EngineKind,
    pub dir: PathBuf,
    /// Задача Планировщика (Windows); в Linux — служба wpx-engine.
    #[cfg_attr(not(windows), allow(dead_code))]
    pub task: &'static str,
    pub fw_group: &'static str,
}

impl EngineLoc {
    pub fn config(&self) -> PathBuf {
        self.dir.join("config.yaml")
    }
    pub fn log(&self) -> PathBuf {
        self.dir.join("engine.log")
    }
    pub fn mihomo(&self) -> PathBuf {
        self.dir.join(MIHOMO)
    }
}

pub fn wpx() -> EngineLoc {
    EngineLoc { kind: EngineKind::Wpx, dir: WPX_DIR.into(), task: "wpx-engine", fw_group: "wpx" }
}

/// Движок установлен (маркер ставит транзакция установки).
pub fn installed() -> bool {
    PathBuf::from(WPX_DIR).join("wpx-active").exists()
}

/// Движок wpx; не установлен — тот же адрес, но `Missing`.
pub fn active() -> EngineLoc {
    let mut loc = wpx();
    if !installed() {
        loc.kind = EngineKind::Missing;
    }
    loc
}

/// mihomo из поставки wpx (рядом с исполняемым файлом): из него ставится и
/// обновляется движок, с ним работают песочница и пробный запуск.
pub fn bundled_mihomo() -> PathBuf {
    let name = if cfg!(windows) { "wpx-mihomo.exe" } else { "wpx-mihomo" };
    std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.join(name))).unwrap_or_else(|| PathBuf::from(name))
}

/// Автозапуск движка при включении ПК (маркер пишет транзакция).
pub fn wpx_boot_enabled() -> Option<bool> {
    let t = std::fs::read_to_string(PathBuf::from(WPX_DIR).join("wpx-boot")).ok()?;
    Some(t.trim() == "1")
}

/// Самовосстановление (задача wpx-watchdog) включено.
pub fn wpx_heal_enabled() -> bool {
    std::fs::read_to_string(PathBuf::from(WPX_DIR).join("wpx-heal"))
        .map(|t| t.trim() == "1")
        .unwrap_or(false)
}

pub fn heal_log_path() -> PathBuf {
    PathBuf::from(WPX_DIR).join("heal.log")
}

pub fn engine_config_path() -> PathBuf {
    active().config()
}

pub fn engine_log_path() -> PathBuf {
    active().log()
}

/// Учётные данные прокси. `Debug` намеренно не выводит пароль.
#[derive(Clone)]
pub struct Creds {
    pub user: String,
    pub pass: String,
}

impl std::fmt::Debug for Creds {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Creds({}:****)", self.user)
    }
}

/// Один прокси из конфига.
#[derive(Clone, Debug)]
pub struct ProxyEntry {
    pub name: String,
    /// "http" | "socks5" | …
    pub kind: String,
    pub server: String,
    pub port: u16,
    /// Транспорт VLESS: "xhttp", "grpc"…; пусто — обычный TCP.
    pub network: String,
    pub creds: Option<Creds>,
    /// HTTPS-прокси: TLS, имя для сертификата, без проверки сертификата.
    pub tls: Option<crate::monitor::probes::Tls>,
}

/// Что удалось понять из конфига движка (для отображения и проверок).
#[derive(Clone, Debug, Serialize, Default)]
pub struct EngineFacts {
    pub server: String,
    /// Адреса выходов (без входов каскада) — внешний IP должен быть одним из них.
    pub exits: Vec<String>,
    /// Протокол основного выхода ("socks5" / "http" / "group").
    pub active_kind: String,
    pub strict_route: bool,
    pub tun_enabled: bool,
    pub udp_rejected: bool,
    /// UDP не блокируется, но все выходы его передают — идёт через туннель.
    pub udp_tunneled: bool,
    pub ipv6_disabled: bool,
    pub fake_ip_dns: bool,
    pub controller: Option<String>,
    /// Имя первой группы (по ней спрашиваем API, какой выход активен).
    pub group: Option<String>,
    pub tun_device: String,
    pub interface: String,
}

#[derive(Clone, Debug)]
pub struct EngineConfig {
    pub facts: EngineFacts,
    pub proxies: Vec<ProxyEntry>,
    /// Секрет external-controller (в интерфейс не отдаётся).
    pub secret: Option<String>,
    pub raw: serde_json::Value,
}

impl EngineConfig {
    pub fn by_kind(&self, kind: &str) -> Option<&ProxyEntry> {
        self.proxies.iter().find(|p| p.kind == kind)
    }
}

pub fn read_engine_config() -> Result<EngineConfig, String> {
    read_config_at(&engine_config_path())
}

pub fn read_config_at(path: &std::path::Path) -> Result<EngineConfig, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("не читается {}: {e}", path.display()))?;
    parse_engine_config(text.trim_start_matches('\u{feff}'))
}

pub fn parse_engine_config(text: &str) -> Result<EngineConfig, String> {
    let v: serde_json::Value = serde_json::from_str(text)
        .map_err(|e| format!("конфиг не в JSON-форме: {e}"))?;
    let st = |o: &serde_json::Value, k: &str| o.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();

    let proxies: Vec<ProxyEntry> = v
        .get("proxies")
        .and_then(|p| p.as_array())
        .into_iter()
        .flatten()
        .map(|p| {
            let user = st(p, "username");
            ProxyEntry {
                name: st(p, "name"),
                kind: st(p, "type"),
                server: st(p, "server"),
                port: p.get("port").and_then(|x| x.as_u64()).unwrap_or(0) as u16,
                network: st(p, "network"),
                creds: (!user.is_empty()).then(|| Creds { user, pass: st(p, "password") }),
                tls: (st(p, "type") == "http" && p.get("tls").and_then(|x| x.as_bool()).unwrap_or(false)).then(|| crate::monitor::probes::Tls {
                    sni: st(p, "sni"),
                    insecure: p.get("skip-cert-verify").and_then(|x| x.as_bool()).unwrap_or(false),
                }),
            }
        })
        .collect();

    let secret = v.get("secret").and_then(|x| x.as_str()).filter(|x| !x.is_empty()).map(str::to_string);
    let group = v
        .get("proxy-groups")
        .and_then(|g| g.as_array())
        .and_then(|a| a.first())
        .map(|g| st(g, "name"));
    let active_kind = if group.is_some() {
        "group".to_string()
    } else {
        proxies.first().map(|p| p.kind.clone()).unwrap_or_default()
    };

    let tun = v.get("tun");
    let b = |o: Option<&serde_json::Value>, k: &str| {
        o.and_then(|x| x.get(k)).and_then(|x| x.as_bool()).unwrap_or(false)
    };
    let rules: Vec<String> = v
        .get("rules")
        .and_then(|r| r.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
        .unwrap_or_default();

    let facts = EngineFacts {
        server: proxies.first().map(|p| p.server.clone()).unwrap_or_default(),
        exits: proxies.iter().filter(|p| !p.name.starts_with("wpx-in-")).map(|p| p.server.clone()).collect(),
        active_kind,
        strict_route: b(tun, "strict-route"),
        tun_enabled: b(tun, "enable"),
        udp_rejected: rules
            .iter()
            .any(|r| r.replace(' ', "").eq_ignore_ascii_case("NETWORK,udp,REJECT")),
        udp_tunneled: v
            .get("proxies")
            .and_then(|p| p.as_array())
            .map(|a| !a.is_empty() && a.iter().all(|p| p.get("udp").and_then(|u| u.as_bool()).unwrap_or(false)))
            .unwrap_or(false),
        ipv6_disabled: !v.get("ipv6").and_then(|x| x.as_bool()).unwrap_or(true),
        fake_ip_dns: v
            .get("dns")
            .and_then(|d| d.get("enhanced-mode"))
            .and_then(|x| x.as_str())
            == Some("fake-ip"),
        controller: v
            .get("external-controller")
            .and_then(|x| x.as_str())
            .map(str::to_string),
        group,
        tun_device: tun.map(|t| st(t, "device")).filter(|d| !d.is_empty()).unwrap_or_else(|| "wpx".into()),
        interface: st(&v, "interface-name"),
    };
    Ok(EngineConfig { facts, proxies, secret, raw: v })
}

// ─── Настройки wpx ───────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// Задержка выше этого порога — «медленно».
    pub slow_ms: u32,
    pub notify: bool,
    /// Автозапуск уже включался по умолчанию (первый запуск). Дальше решает
    /// только пользователь — переключатель в настройках.
    pub autostart_seeded: bool,
    pub widget: WidgetState,
    /// Пауза VPN до этого времени (unix ms) — переживает перезапуск wpx.
    pub pause_until: Option<i64>,
}

/// Виджет: открыт ли, поверх всех окон ли, где и какого размера.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct WidgetState {
    pub open: bool,
    pub pinned: bool,
    /// Экран выреза (системное имя монитора); нет — основной.
    pub monitor: Option<String>,
    /// Край или угол экрана: top, top-left, top-right, bottom, bottom-left,
    /// bottom-right, left, right.
    pub anchor: String,
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub w: u32,
    pub h: u32,
}

impl Default for WidgetState {
    fn default() -> Self {
        Self { open: false, pinned: true, monitor: None, anchor: "top".into(), x: None, y: None, w: 240, h: 150 }
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            slow_ms: 2500,
            // В лаборатории не дублируем уведомления рабочего wpx.
            notify: !LAB,
            autostart_seeded: false,
            widget: WidgetState::default(),
            pause_until: None,
        }
    }
}

/// Лабораторная сборка (`--features lab`): изолирована от установленного wpx.
pub const LAB: bool = cfg!(feature = "lab");

pub fn data_dir() -> PathBuf {
    let d = dirs::data_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join(if LAB { "wpx-lab" } else { "wpx" });
    let _ = std::fs::create_dir_all(&d);
    d
}

/// Атомарная запись JSON в папку данных wpx.
pub fn write_json<T: Serialize>(name: &str, v: &T) -> Result<(), String> {
    let p = data_dir().join(name);
    let tmp = p.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(v).unwrap_or_default())
        .and_then(|_| std::fs::rename(&tmp, &p))
        .map_err(|e| format!("не сохранить {name}: {e}"))
}

pub fn save_settings(s: &Settings) -> Result<(), String> {
    write_json("settings.json", s)
}

pub fn load_settings() -> Settings {
    let p = data_dir().join("settings.json");
    match std::fs::read_to_string(&p) {
        Ok(t) => serde_json::from_str(&t).unwrap_or_default(),
        Err(_) => {
            let s = Settings::default();
            let _ = save_settings(&s);
            s
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_config_shape() {
        let text = r#"{
          "mode":"rule","ipv6":false,"interface-name":"Ethernet",
          "rules":["IP-CIDR,192.168.1.0/24,DIRECT,no-resolve","NETWORK,udp,REJECT","MATCH,Exit"],
          "proxies":[{"port":59101,"name":"Exit","server":"1.2.3.4","username":"u","type":"socks5","password":"p","udp":false}],
          "dns":{"enhanced-mode":"fake-ip"},
          "tun":{"strict-route":true,"enable":true,"device":"wpx"}
        }"#;
        let c = parse_engine_config(text).unwrap();
        assert_eq!(c.facts.server, "1.2.3.4");
        assert_eq!(c.facts.active_kind, "socks5");
        assert!(c.facts.strict_route && c.facts.tun_enabled && c.facts.udp_rejected);
        assert!(c.facts.ipv6_disabled && c.facts.fake_ip_dns);
        assert_eq!(c.facts.tun_device, "wpx");
        assert_eq!(c.facts.exits, vec!["1.2.3.4".to_string()]);
        assert_eq!(c.facts.interface, "Ethernet");
        let s = c.by_kind("socks5").unwrap();
        assert_eq!(s.port, 59101);
        assert_eq!(format!("{:?}", s.creds.as_ref().unwrap()), "Creds(u:****)");
        assert!(c.by_kind("http").is_none());
    }
}
