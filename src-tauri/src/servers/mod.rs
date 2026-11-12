//! Свои серверы: подключение по SSH, осмотр, установка VPN (sing-box),
//! вход каскада («труба» без ключей), удаление.
//!
//! Источник правды — wpx на ПК: конфиг sing-box целиком собирается здесь и
//! заливается транзакцией (`sing-box check` → замена → запуск → проверка
//! портов → при сбое возврат прежнего конфига). Секреты рождаются на ПК и
//! хранятся только зашифрованными. На сервере wpx пишет лишь в `/opt/wpx` (+ юнит
//! systemd, если нет Docker); чужое — AmneziaVPN, другие контейнеры, правила
//! Docker — не трогает, занятые порты обходит.

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use crate::config;
use crate::engine::netcfg;
use crate::profiles;
use crate::profiles::proto::{self, Endpoint};
use crate::engine::sandbox::{self, ProbeResult};
use ssh::{Auth, Route, Session};

pub mod check;
pub mod extra;
pub mod fw;
pub mod guests;
pub mod heal;
pub mod moving;
pub mod path;
pub mod rtt;
pub mod ssh;
pub mod update;
use guests::{Guest, GuestKeys};

pub const SB_VERSION: &str = "1.14.4";
/// Образ закреплён по digest — тег можно перевесить, digest нет.
const SB_IMAGE: &str = "ghcr.io/sagernet/sing-box@sha256:0788ffbddab2c68a99a2dd4780bbc50902f159af6f589df3ee74a8389d278279";
/// sha256 официальных архивов (сверено: скачано на ПК и на сервере).
const SB_SHA_AMD64: &str = "699a1b510aa4396b2176d32d1181920399ebf1e267835da6f3b598d0f7c24968";
const SB_SHA_ARM64: &str = "436441f76ee2f7fe21b5b2d426d3cb261a480455a704865789ad533e4273ec26";
const DIR: &str = "/opt/wpx/sing-box";
/// Сайты-прикрытия для Reality (TLS 1.3 + h2); берётся самый быстрый с сервера.
const REALITY_DEST: &[&str] = &["www.apple.com", "www.microsoft.com", "dl.google.com", "www.samsung.com", "www.nvidia.com", "addons.mozilla.org"];
const PORTS_MAIN: &[u16] = &[443, 8443, 2053, 2083, 2087, 2096];
const PORTS_PIPE: &[u16] = &[8443, 9443, 2053, 2083, 2087, 2096, 10443, 20443];
/// AmneziaWG: официальный образ (amneziawg-go 3.1.20260828, только amd64).
pub const AWG_VERSION: &str = "3.1.20260828";
const AWG_IMAGE: &str = "amneziavpn/amneziawg-go@sha256:cbafc02b8373a83f428272db6d8001b37bc02e6211cbd8c0cb4e2e3759b12b72";
/// Подсеть внутри контейнера AWG (сервер .1, клиент .2) — в своём сетевом
/// пространстве, с сетями хоста не пересекается.
const AWG_NET: &str = "10.66.0";
/// MTU AmneziaWG через вход каскада: пакет с обфускацией (до +20 байт на
/// пакет) по умолчанию выходит ~1500 байт, на пути вход → выход он дробится,
/// фрагменты теряются — рукопожатие проходит, а загрузка стоит.
const AWG_MTU_VIA: u16 = 1280;

/// Строка MTU в [Interface]: только через вход (напрямую — как в AmneziaVPN).
fn mtu_line(via: bool) -> String {
    if via { format!("MTU = {AWG_MTU_VIA}\n") } else { String::new() }
}

// ─── Модель ──────────────────────────────────────────────────────

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Server {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    /// base64(зашифрованный закрытый ключ wpx, OpenSSH) — свой ключ на каждый сервер.
    pub key_enc: String,
    /// Отпечаток ключа сервера, запомненный при первом входе.
    pub host_key: String,
    /// SSH только через другой свой сервер (напрямую с ПК не достать).
    #[serde(default)]
    pub via: Option<String>,
    #[serde(default)]
    pub facts: Option<Facts>,
    /// "docker" | "systemd" | "" (wpx на сервере ещё ничего не ставил).
    #[serde(default)]
    pub runtime: String,
    #[serde(default)]
    pub vless: Option<Vless>,
    #[serde(default)]
    pub hy2: Option<Hy2>,
    /// AmneziaWG — отдельный контейнер `wpx-awg` (только Docker, amd64).
    #[serde(default)]
    pub awg: Option<Awg>,
    /// VLESS + XHTTP + Reality — контейнер `wpx-xray` (Xray).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub xhttp: Option<extra::Xhttp>,
    /// MTProxy для Telegram — контейнер `wpx-mtg`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mtproxy: Option<extra::MtProxy>,
    /// Этот сервер — вход каскада: пересылает порты на выход, ключей не знает.
    #[serde(default)]
    pub pipes: Vec<Pipe>,
    /// base64(зашифрованный JSON `Secrets`).
    #[serde(default)]
    pub secrets_enc: String,
    /// Личный доступ для других людей (свои ключи у каждого).
    #[serde(default)]
    pub guests: Vec<Guest>,
    /// Файрвол wpx включён: снаружи только SSH и VPN (+ выбранное).
    #[serde(default)]
    pub fw: Option<fw::Firewall>,
    /// Свои пиры AmneziaWG для путей через входы каскада: у WireGuard один
    /// ключ — одно подключение, и путь напрямую с путём через вход на общем
    /// ключе выбивали бы друг друга.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub awg_paths: Vec<AwgPath>,
}

/// Путь AmneziaWG через вход `via` (id сервера-входа): свой адрес 10.66.0.`ip`.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct AwgPath {
    pub via: String,
    pub ip: u8,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Vless {
    pub port: u16,
    pub dest: String,
    pub public_key: String,
    pub short_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Hy2 {
    pub port: u16,
    pub sni: String,
    pub cert_sha256: String,
    /// Смена портов: UDP-диапазон, который nftables перенаправляет на `port`;
    /// клиент прыгает по нему — блокировка одного порта не рвёт связь.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hop: Option<(u16, u16)>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Awg {
    pub port: u16,
    pub server_public: String,
    /// Обфускация AmneziaWG (Jc, Jmin, Jmax, S1, S2, H1–H4) — одинаковая
    /// у сервера и клиента.
    pub obf: Vec<(String, String)>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Pipe {
    /// id сервера-выхода (пусто — найден на сервере, но в wpx не записан).
    pub to: String,
    pub to_host: String,
    /// Порт на входе (TCP и UDP) → порт на выходе.
    pub listen: u16,
    pub to_port: u16,
    /// Цепочка ПК → вход → промежуточный → выход: труба ведёт на трубу
    /// промежуточного сервера (его id), `to_host`/`to_port` — его адрес и порт.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hop: Option<String>,
    /// Порт на самом выходе (у цепочки `to_port` — порт трубы промежуточного).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_port: Option<u16>,
}

impl Pipe {
    /// Куда в итоге приходит трафик на выходе.
    pub fn final_port(&self) -> u16 {
        self.exit_port.unwrap_or(self.to_port)
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
struct Secrets {
    #[serde(default)]
    uuid: String,
    #[serde(default)]
    reality_private: String,
    #[serde(default)]
    hy2_password: String,
    #[serde(default)]
    hy2_obfs: String,
    #[serde(default)]
    awg_server_private: String,
    /// Ключ клиента есть только на ПК; на сервере — лишь его публичная часть.
    #[serde(default)]
    awg_client_private: String,
    #[serde(default)]
    awg_psk: String,
    /// Reality для Xray (XHTTP) — своя пара ключей.
    #[serde(default)]
    xhttp_private: String,
    /// Секрет FakeTLS MTProxy.
    #[serde(default)]
    mtg_secret: String,
    /// Ключи гостей — чтобы QR и ссылки можно было показать ещё раз.
    #[serde(default)]
    guests: Vec<GuestKeys>,
    /// Ключи клиента AmneziaWG для путей через входы (`Server::awg_paths`).
    #[serde(default)]
    awg_paths: Vec<AwgPathKey>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
struct AwgPathKey {
    via: String,
    private: String,
}

/// Свободный адрес AmneziaWG (10.66.0.N): не занят ни гостем, ни путём.
fn free_awg_ip(s: &Server) -> Result<u8, String> {
    (3..=254u8)
        .find(|n| !s.guests.iter().any(|g| g.awg_ip == *n) && !s.awg_paths.iter().any(|p| p.ip == *n))
        .ok_or_else(|| "адреса AmneziaWG закончились (250 доступов)".into())
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Facts {
    pub os: String,
    pub arch: String,
    pub cpus: u32,
    pub ram_mb: u32,
    pub avail_mb: u32,
    pub swap_mb: u32,
    pub disk_free_mb: u32,
    pub country: String,
    pub city: String,
    pub org: String,
    pub root: bool,
    pub docker: bool,
    pub systemd: bool,
    pub containers: Vec<String>,
    /// Занятые порты: (порт, процесс).
    pub tcp: Vec<(u16, String)>,
    pub udp: Vec<(u16, String)>,
    /// На сервере уже есть установка wpx (`/opt/wpx/sing-box/config.json`).
    pub wpx: bool,
    pub ufw: bool,
    pub at: i64,
    // Состояние и обслуживание.
    pub uptime_s: u64,
    pub load: String,
    /// Трафик основного интерфейса с загрузки, байт.
    pub net_rx: u64,
    pub net_tx: u64,
    /// Алгоритм управления перегрузкой TCP (bbr / cubic …) и доступен ли BBR.
    pub cc: String,
    pub bbr_avail: bool,
    pub autoupd: bool,
    pub f2b: bool,
    /// Обновления пакетов: всего и безопасности.
    pub updates: u32,
    pub sec_updates: u32,
    pub reboot: bool,
    /// Версия sing-box на сервере (сравнить с той, что в wpx).
    pub sb_ver: String,
    pub apt: bool,
    /// Что слушает снаружи (не 127.0.0.1): ("tcp"|"udp", порт, процесс).
    pub public: Vec<(String, u16, String)>,
    /// На сервере стоит таблица файрвола wpx.
    pub fw: bool,
    /// Образы контейнеров wpx (сравнить с закреплёнными в wpx).
    pub sb_img: String,
    pub awg_img: String,
    /// Глобальный IPv6-адрес сервера (пусто — нет).
    pub ipv6: String,
    /// Включено самовосстановление (wpx-heal.timer); его последние записи.
    pub heal: bool,
    pub heal_log: Vec<heal::HealEvent>,
}

#[derive(Default, Serialize, Deserialize)]
pub struct Store {
    pub servers: Vec<Server>,
}

pub fn load() -> Store {
    std::fs::read_to_string(config::data_dir().join("servers.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save(s: &Store) -> Result<(), String> {
    config::write_json("servers.json", s)
}

fn enc(text: &str) -> Result<String, String> {
    profiles::encrypt(text)
}

fn secrets_of(s: &Server) -> Result<Secrets, String> {
    let t = profiles::decrypt_str(&s.secrets_enc)?;
    if t.is_empty() {
        return Ok(Secrets::default());
    }
    serde_json::from_str(&t).map_err(|e| e.to_string())
}

// ─── Ключи и секреты ─────────────────────────────────────────────

fn rnd(n: usize) -> Vec<u8> {
    use rand_core::RngCore;
    let mut b = vec![0u8; n];
    rand_core::OsRng.fill_bytes(&mut b);
    b
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn uuid4() -> String {
    let mut b = rnd(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = hex(&b);
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

const B64URL: base64::engine::GeneralPurpose = base64::engine::general_purpose::URL_SAFE_NO_PAD;

/// Ключи Reality (X25519) в формате sing-box/Xray: base64url без `=`.
fn reality_keypair() -> (String, String) {
    let mut sk = [0u8; 32];
    sk.copy_from_slice(&rnd(32));
    let private = B64URL.encode(sk);
    let public = reality_public(&private).unwrap_or_default();
    (private, public)
}

fn reality_public(private: &str) -> Result<String, String> {
    let raw = B64URL.decode(private.trim().trim_end_matches('=')).map_err(|e| format!("ключ Reality: {e}"))?;
    let arr: [u8; 32] = raw.try_into().map_err(|_| "ключ Reality: не 32 байта")?;
    let pk = x25519_dalek::PublicKey::from(&x25519_dalek::StaticSecret::from(arr));
    Ok(B64URL.encode(pk.as_bytes()))
}

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// Ключи WireGuard/AWG (X25519, base64 с `=`), закрытый — «зажат» как у `wg genkey`.
fn wg_keypair() -> (String, String) {
    let mut k = [0u8; 32];
    k.copy_from_slice(&rnd(32));
    k[0] &= 248;
    k[31] &= 127;
    k[31] |= 64;
    let private = B64.encode(k);
    let public = wg_public(&private).unwrap_or_default();
    (private, public)
}

fn wg_public(private: &str) -> Result<String, String> {
    let raw = B64.decode(private.trim()).map_err(|e| format!("ключ AWG: {e}"))?;
    let arr: [u8; 32] = raw.try_into().map_err(|_| "ключ AWG: не 32 байта")?;
    Ok(B64.encode(x25519_dalek::PublicKey::from(&x25519_dalek::StaticSecret::from(arr)).as_bytes()))
}

fn rnd_in(lo: u32, hi: u32) -> u32 {
    let b = rnd(4);
    lo + u32::from_le_bytes([b[0], b[1], b[2], b[3]]) % (hi - lo + 1)
}

/// Обфускация AmneziaWG 1.5/2.0 (то, что понимает mihomo): мусорные пакеты
/// перед рукопожатием (Jc/Jmin/Jmax), сдвиги размеров всех четырёх типов
/// пакетов (S1–S4), свои заголовки (H1–H4, одиночные числа — их понимают все
/// версии) и I1 — первым уходит пакет, похожий на DNS-запрос.
/// Правила AWG: Jmin < Jmax ≤ 1280, H1–H4 разные и > 4, размеры пакетов
/// init 148+S1, response 92+S2, cookie 64+S3, data 32+S4 — все разные.
fn awg_obf() -> Vec<(String, String)> {
    let jc = rnd_in(4, 8);
    let jmin = rnd_in(40, 70);
    let jmax = rnd_in(jmin + 20, 160);
    let (mut s1, mut s2, mut s3, mut s4);
    loop {
        (s1, s2, s3, s4) = (rnd_in(15, 120), rnd_in(15, 120), rnd_in(10, 60), rnd_in(4, 20));
        let sizes = [148 + s1, 92 + s2, 64 + s3, 32 + s4];
        if (0..4).all(|i| (i + 1..4).all(|j| sizes[i] != sizes[j])) {
            break;
        }
    }
    let mut h: Vec<u32> = vec![];
    while h.len() < 4 {
        let v = rnd_in(5, 0x7fff_ffff);
        if !h.contains(&v) {
            h.push(v);
        }
    }
    let mut o: Vec<(String, String)> = [("Jc", jc), ("Jmin", jmin), ("Jmax", jmax), ("S1", s1), ("S2", s2), ("S3", s3), ("S4", s4)]
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    o.extend(h.iter().enumerate().map(|(i, v)| (format!("H{}", i + 1), v.to_string())));
    o.push(("I1".into(), dns_signature()));
    o
}

/// I1: заголовок DNS-запроса (id случайный) к обычному сайту — первый пакет
/// выглядит как DNS, а не как VPN.
fn dns_signature() -> String {
    const NAMES: &[&str] = &["www.apple.com", "www.google.com", "yandex.ru", "www.microsoft.com", "vk.com"];
    let name = NAMES[rnd_in(0, NAMES.len() as u32 - 1) as usize];
    let qname: String = name.split('.').map(|l| format!("{:02x}{}", l.len(), hex(l.as_bytes()))).collect();
    format!("<r 2><b 0x01000001000000000000{qname}0000010001>")
}

fn obf_lines(a: &Awg) -> String {
    a.obf.iter().map(|(k, v)| format!("{k} = {v}\n")).collect()
}

/// Конфиг AWG-сервера (внутри контейнера; NAT — в его сетевом пространстве).
fn awg_server_conf(s: &Server, a: &Awg, sec: &Secrets) -> Result<String, String> {
    let client_pub = wg_public(&sec.awg_client_private)?;
    let mut peers = String::new();
    for (g, k) in guests::live(s, sec, crate::monitor::now_ms()) {
        if g.awg_ip > 0 {
            peers.push_str(&format!("\n[Peer]\nPublicKey = {}\nPresharedKey = {}\nAllowedIPs = {AWG_NET}.{}/32\n", wg_public(&k.awg_private)?, k.awg_psk, g.awg_ip));
        }
    }
    for p in &s.awg_paths {
        if let Some(k) = sec.awg_paths.iter().find(|k| k.via == p.via) {
            peers.push_str(&format!("\n[Peer]\nPublicKey = {}\nPresharedKey = {}\nAllowedIPs = {AWG_NET}.{}/32\n", wg_public(&k.private)?, sec.awg_psk, p.ip));
        }
    }
    Ok(format!(
        "[Interface]\nPrivateKey = {}\nAddress = {AWG_NET}.1/24\nListenPort = {}\n{}\
         PostUp = iptables -t nat -A POSTROUTING -s {AWG_NET}.0/24 -o eth0 -j MASQUERADE; iptables -A FORWARD -i %i -o %i -j DROP; iptables -A FORWARD -i %i -j ACCEPT; iptables -A FORWARD -o %i -j ACCEPT\n\
         PostDown = iptables -t nat -D POSTROUTING -s {AWG_NET}.0/24 -o eth0 -j MASQUERADE; iptables -D FORWARD -i %i -o %i -j DROP; iptables -D FORWARD -i %i -j ACCEPT; iptables -D FORWARD -o %i -j ACCEPT\n\n\
         [Peer]\nPublicKey = {client_pub}\nPresharedKey = {}\nAllowedIPs = {AWG_NET}.2/32\n{peers}",
        sec.awg_server_private, a.port, obf_lines(a), sec.awg_psk
    ))
}

/// Адрес сервера — IPv4 или IPv6, в каноническом виде (IPv6 — без скобок).
fn server_ip(host: &str) -> Result<String, String> {
    host.trim()
        .trim_matches(|c| c == '[' || c == ']')
        .parse::<std::net::IpAddr>()
        .map(|ip| ip.to_string())
        .map_err(|_| "Адрес сервера — IP вида 203.0.113.10 или 2001:db8::10".into())
}

/// «адрес:порт» для ссылок и конфигов: IPv6 — в квадратных скобках.
fn host_port(host: &str, port: u16) -> String {
    if host.contains(':') { format!("[{host}]:{port}") } else { format!("{host}:{port}") }
}

/// Конфиг клиента (тот же формат, что экспорт AmneziaVPN).
fn awg_client_conf(a: &Awg, private: &str, psk: &str, ip: u8, host: &str, port: u16, via: bool) -> String {
    format!(
        "[Interface]\nPrivateKey = {private}\nAddress = {AWG_NET}.{ip}/32\nDNS = 1.1.1.1\n{}{}\n\
         [Peer]\nPublicKey = {}\nPresharedKey = {psk}\nEndpoint = {at}\nAllowedIPs = 0.0.0.0/0\nPersistentKeepalive = 25\n",
        mtu_line(via), obf_lines(a), a.server_public, at = host_port(host, port)
    )
}

/// Подхватить AWG-сервер, найденный на сервере: ключ сервера, порт и
/// обфускация сохраняются; ключа клиента там нет — выпустим новый.
fn adopt_awg(conf: &str, sec: &mut Secrets) -> Option<Awg> {
    let mut sect = "";
    let (mut port, mut obf, mut peers) = (0u16, vec![], 0);
    for line in conf.lines() {
        let l = line.trim();
        if l.starts_with('[') {
            sect = if l.eq_ignore_ascii_case("[interface]") { "i" } else { "p" };
            if sect == "p" {
                peers += 1;
            }
            continue;
        }
        let Some((k, v)) = l.split_once('=') else { continue };
        let (k, v) = (k.trim(), v.trim());
        match (sect, k.to_ascii_lowercase().as_str()) {
            ("i", "privatekey") => sec.awg_server_private = v.into(),
            ("i", "listenport") => port = v.parse().unwrap_or(0),
            ("i", "jc" | "jmin" | "jmax" | "s1" | "s2" | "s3" | "s4" | "h1" | "h2" | "h3" | "h4" | "i1" | "i2" | "i3" | "i4" | "i5") => obf.push((k.to_string(), v.to_string())),
            // Первый пир — ПК владельца, остальные — гости.
            ("p", "presharedkey") if peers == 1 => sec.awg_psk = v.into(),
            _ => {}
        }
    }
    if port == 0 || sec.awg_server_private.is_empty() {
        return None;
    }
    let server_public = wg_public(&sec.awg_server_private).ok()?;
    Some(Awg { port, server_public, obf })
}

/// sha256 сертификата (DER) из PEM — для закрепления в клиенте.
fn cert_sha256(pem: &str) -> Result<String, String> {
    let b64: String = pem
        .lines()
        .skip_while(|l| !l.starts_with("-----BEGIN CERTIFICATE"))
        .skip(1)
        .take_while(|l| !l.starts_with("-----END"))
        .map(str::trim)
        .collect();
    let der = base64::engine::general_purpose::STANDARD.decode(b64).map_err(|_| "сертификат Hysteria2 не прочитан")?;
    Ok(hex(&Sha256::digest(der)))
}

// ─── Конфиг sing-box ─────────────────────────────────────────────

fn singbox_config(s: &Server, sec: &Secrets) -> Value {
    let mut inbounds = vec![];
    let live = guests::live(s, sec, crate::monitor::now_ms());
    if let Some(v) = &s.vless {
        let mut users = vec![json!({ "name": "wpx", "uuid": sec.uuid, "flow": "xtls-rprx-vision" })];
        users.extend(live.iter().filter(|(g, _)| g.vless).map(|(g, k)| json!({ "name": g.id, "uuid": k.uuid, "flow": "xtls-rprx-vision" })));
        inbounds.push(json!({
            "type": "vless", "tag": "vless", "listen": "::", "listen_port": v.port,
            "users": users,
            "tls": { "enabled": true, "server_name": v.dest,
                "reality": { "enabled": true,
                    "handshake": { "server": v.dest, "server_port": 443,
                        "domain_resolver": { "server": "local", "strategy": "prefer_ipv4" } },
                    "private_key": sec.reality_private, "short_id": [v.short_id] } }
        }));
    }
    if let Some(h) = &s.hy2 {
        let mut users = vec![json!({ "name": "wpx", "password": sec.hy2_password })];
        users.extend(live.iter().filter(|(g, _)| g.hy2).map(|(g, k)| json!({ "name": g.id, "password": k.hy2_password })));
        inbounds.push(json!({
            "type": "hysteria2", "tag": "hy2", "listen": "::", "listen_port": h.port,
            "users": users,
            "obfs": { "type": "salamander", "password": sec.hy2_obfs },
            "tls": { "enabled": true, "server_name": h.sni, "alpn": ["h3"],
                "certificate_path": format!("{DIR}/hy2.crt"), "key_path": format!("{DIR}/hy2.key") }
        }));
    }
    for p in &s.pipes {
        // «Тупая труба»: TCP и UDP как есть на выход, без расшифровки.
        inbounds.push(json!({
            "type": "direct", "tag": format!("pipe-{}", p.listen), "listen": "::", "listen_port": p.listen,
            "override_address": p.to_host, "override_port": p.to_port
        }));
    }
    json!({
        "log": { "level": "warn" },
        "dns": { "servers": [{ "type": "local", "tag": "local" }] },
        "inbounds": inbounds,
        "outbounds": [{ "type": "direct", "tag": "direct" }],
        // У части хостеров IPv6 доходит не до всех сайтов — сначала IPv4.
        // Подключённым (и гостям) — не во внутренние адреса сервера: localhost,
        // сеть Docker, метаданные облака, локальная сеть хостера (как у Xray).
        // Трубы каскада ведут на публичный адрес выхода — их не трогаем.
        "route": {
            "rules": [
                { "inbound": ["vless", "hy2"], "action": "resolve" },
                { "inbound": ["vless", "hy2"], "ip_is_private": true, "action": "reject" }
            ],
            "final": "direct",
            "default_domain_resolver": { "server": "local", "strategy": "prefer_ipv4" }
        }
    })
}

/// Порты, которые слушает наш sing-box (для проверки после запуска).
fn our_ports(s: &Server) -> (Vec<u16>, Vec<u16>) {
    let mut tcp: Vec<u16> = s.vless.iter().map(|v| v.port).collect();
    let mut udp: Vec<u16> = s.hy2.iter().map(|h| h.port).collect();
    for p in &s.pipes {
        tcp.push(p.listen);
        udp.push(p.listen);
    }
    (tcp, udp)
}

/// Пользователь-владелец входа (`wpx`; у старых установок — первый).
fn owner(inbound: &Value) -> &Value {
    let users = &inbound["users"];
    users.as_array().and_then(|u| u.iter().find(|x| x["name"] == "wpx")).unwrap_or(&users[0])
}

/// Подхватить установку wpx, найденную на сервере (ключи сохраняются —
/// старые ссылки и профили продолжают работать).
fn adopt(s: &mut Server, cfg: &Value, cert: &str, runtime: &str, known: &[Server]) -> Result<Secrets, String> {
    let mut sec = secrets_of(s).unwrap_or_default();
    let ins = cfg.get("inbounds").and_then(Value::as_array).cloned().unwrap_or_default();
    for i in &ins {
        let port = i.get("listen_port").and_then(Value::as_u64).unwrap_or(0) as u16;
        match i.get("type").and_then(Value::as_str).unwrap_or("") {
            "vless" => {
                let tls = &i["tls"];
                let private = tls["reality"]["private_key"].as_str().unwrap_or("").to_string();
                sec.uuid = owner(i)["uuid"].as_str().unwrap_or("").to_string();
                s.vless = Some(Vless {
                    port,
                    dest: tls["reality"]["handshake"]["server"].as_str().or(tls["server_name"].as_str()).unwrap_or("www.apple.com").to_string(),
                    public_key: reality_public(&private)?,
                    short_id: tls["reality"]["short_id"][0].as_str().unwrap_or("").to_string(),
                });
                sec.reality_private = private;
            }
            "hysteria2" => {
                sec.hy2_password = owner(i)["password"].as_str().unwrap_or("").to_string();
                sec.hy2_obfs = i["obfs"]["password"].as_str().unwrap_or("").to_string();
                s.hy2 = Some(Hy2 { port, sni: i["tls"]["server_name"].as_str().unwrap_or("").to_string(), cert_sha256: cert_sha256(cert)?, hop: None });
            }
            "direct" => {
                if let Some(to_host) = i.get("override_address").and_then(Value::as_str) {
                    s.pipes.push(Pipe {
                        to: known.iter().find(|k| path::at(k, to_host)).map(|k| k.id.clone()).unwrap_or_default(),
                        to_host: to_host.into(),
                        listen: port,
                        to_port: i.get("override_port").and_then(Value::as_u64).unwrap_or(443) as u16,
                        ..Default::default()
                    });
                }
            }
            _ => {}
        }
    }
    s.pipes.dedup_by_key(|p| p.listen);
    s.runtime = runtime.into();
    Ok(sec)
}

// ─── Скрипты на сервере ──────────────────────────────────────────

/// Осмотр: только чтение.
const INSPECT: &str = r#"
. /etc/os-release 2>/dev/null; echo "os=${PRETTY_NAME:-unknown}"
echo "arch=$(uname -m)"; echo "uid=$(id -u)"; echo "cpus=$(nproc 2>/dev/null)"
free -m | awk 'NR==2{print "ram="$2; print "avail="$7} NR==3{print "swap="$2}'
df -Pm / | awk 'NR==2{print "disk_free="$4}'
[ -d /run/systemd/system ] && echo "systemd=1"
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then echo "docker=1"; docker ps --format 'container={{.Names}}'; fi
ss -tlnpH 2>/dev/null | awk '{print "tcp="$4" "$6}'
ss -ulnpH 2>/dev/null | awk '{print "udp="$4" "$6}'
{ [ -f /opt/wpx/sing-box/config.json ] || [ -f /opt/wpx/awg/wg0.conf ]; } && echo "wpx=1"
echo "uptime_s=$(cut -d. -f1 /proc/uptime)"
echo "ipv6=$(ip -6 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1)"
echo "load=$(cut -d' ' -f1-3 /proc/loadavg)"
i=$(ip route show default 2>/dev/null | awk '{print $5; exit}')
[ -n "$i" ] && awk -v i="$i:" '$1==i{print "net_rx="$2; print "net_tx="$10}' /proc/net/dev
echo "cc=$(sysctl -n net.ipv4.tcp_congestion_control 2>/dev/null)"
{ sysctl -n net.ipv4.tcp_available_congestion_control 2>/dev/null | grep -qw bbr || modinfo tcp_bbr >/dev/null 2>&1; } && echo "bbr_avail=1"
grep -qs 'Unattended-Upgrade "1"' /etc/apt/apt.conf.d/20auto-upgrades && command -v unattended-upgrade >/dev/null 2>&1 && echo "autoupd=1"
systemctl is-active --quiet fail2ban 2>/dev/null && echo "f2b=1"
if command -v apt-get >/dev/null 2>&1; then
  echo "apt=1"
  u=$(apt-get -s -o Debug::NoLocking=1 upgrade 2>/dev/null | grep '^Inst')
  echo "updates=$(printf '%s' "$u" | grep -c .)"; echo "sec_updates=$(printf '%s' "$u" | grep -ci security)"
fi
[ -f /var/run/reboot-required ] && echo "reboot=1"
v=$(docker exec wpx-singbox sing-box version 2>/dev/null | head -1 | awk '{print $3}')
[ -z "$v" ] && v=$(/opt/wpx/bin/sing-box version 2>/dev/null | head -1 | awk '{print $3}')
echo "sb_ver=$v"
echo "sb_img=$(docker inspect -f '{{.Config.Image}}' wpx-singbox 2>/dev/null)"
echo "awg_img=$(docker inspect -f '{{.Config.Image}}' wpx-awg 2>/dev/null)"
command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active' && echo "ufw=1"
command -v nft >/dev/null 2>&1 && nft list table inet wpx_fw >/dev/null 2>&1 && echo "fw=1"
echo "geo=$( (curl -s -m 5 https://ipinfo.io/json || wget -qO- -T 5 https://ipinfo.io/json) 2>/dev/null | tr -d '\n')"
true
"#;

fn parse_facts(out: &str) -> Facts {
    let mut f = Facts { at: chrono::Utc::now().timestamp_millis(), ..Default::default() };
    let port_proc = |v: &str| -> Option<(u16, String)> {
        let (addr, rest) = v.split_once(' ').unwrap_or((v, ""));
        let port = addr.rsplit(':').next()?.parse().ok()?;
        let proc = rest.split("((\"").nth(1).and_then(|r| r.split('"').next()).unwrap_or("").to_string();
        Some((port, proc))
    };
    for line in out.lines() {
        let Some((k, v)) = line.split_once('=') else { continue };
        let num = || v.trim().parse::<u32>().unwrap_or(0);
        match k {
            "os" => f.os = v.into(),
            "arch" => f.arch = v.into(),
            "uid" => f.root = v.trim() == "0",
            "cpus" => f.cpus = num(),
            "ram" => f.ram_mb = num(),
            "avail" => f.avail_mb = num(),
            "swap" => f.swap_mb = num(),
            "disk_free" => f.disk_free_mb = num(),
            "systemd" => f.systemd = true,
            "docker" => f.docker = true,
            "container" => f.containers.push(v.into()),
            "tcp" | "udp" => {
                let Some(pp) = port_proc(v) else { continue };
                let addr = v.split(' ').next().unwrap_or("");
                let local = addr.starts_with("127.") || addr.starts_with("[::1]") || addr.starts_with("::1") || addr.contains("%lo");
                if !local && !f.public.iter().any(|(p, n, _)| p == k && *n == pp.0) {
                    f.public.push((k.to_string(), pp.0, pp.1.clone()));
                }
                if k == "tcp" { f.tcp.push(pp) } else { f.udp.push(pp) }
            }
            "fw" => f.fw = true,
            "sb_img" => f.sb_img = v.trim().into(),
            "awg_img" => f.awg_img = v.trim().into(),
            "ipv6" => f.ipv6 = v.trim().into(),
            "heal_on" => f.heal = true,
            "heal" => f.heal_log.extend(heal::parse(v)),
            "wpx" => f.wpx = true,
            "ufw" => f.ufw = true,
            "uptime_s" => f.uptime_s = v.trim().parse().unwrap_or(0),
            "load" => f.load = v.trim().into(),
            "net_rx" => f.net_rx = v.trim().parse().unwrap_or(0),
            "net_tx" => f.net_tx = v.trim().parse().unwrap_or(0),
            "cc" => f.cc = v.trim().into(),
            "bbr_avail" => f.bbr_avail = true,
            "autoupd" => f.autoupd = true,
            "f2b" => f.f2b = true,
            "updates" => f.updates = num(),
            "sec_updates" => f.sec_updates = num(),
            "reboot" => f.reboot = true,
            "sb_ver" => f.sb_ver = v.trim().into(),
            "apt" => f.apt = true,
            "geo" => {
                if let Ok(g) = serde_json::from_str::<Value>(v) {
                    let s = |k: &str| g.get(k).and_then(Value::as_str).unwrap_or("").to_string();
                    (f.country, f.city) = (s("country"), s("city"));
                    // «AS210644 AEZA GROUP LLC» → «AEZA GROUP LLC»
                    let org = s("org");
                    f.org = org.split_once(' ').filter(|(a, _)| a.starts_with("AS")).map(|(_, b)| b.to_string()).unwrap_or(org);
                }
            }
            _ => {}
        }
    }
    f.tcp.sort();
    f.tcp.dedup();
    f.udp.sort();
    f.udp.dedup();
    f
}

/// Порт свободен (или занят нашим же sing-box).
fn free(busy: &[(u16, String)], port: u16) -> bool {
    !busy.iter().any(|(p, proc)| *p == port && proc != "sing-box")
}

const ENSURE_RUNTIME: &str = r#"
set -eu
if [ "$RT" = docker ]; then
  docker pull -q "$IMG" >/dev/null || { echo "не скачался образ $IMG" >&2; exit 3; }
  echo RT-OK; exit 0
fi
a=$(uname -m)
case "$a" in x86_64) A=amd64; S="$SHA_AMD64";; aarch64|arm64) A=arm64; S="$SHA_ARM64";; *) echo "архитектура $a не поддерживается" >&2; exit 3;; esac
if [ -x /opt/wpx/bin/sing-box ] && /opt/wpx/bin/sing-box version 2>/dev/null | head -1 | grep -q " $VER\$"; then :; else
  T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
  U="https://github.com/SagerNet/sing-box/releases/download/v$VER/sing-box-$VER-linux-$A.tar.gz"
  if command -v curl >/dev/null 2>&1; then curl -fsSL -m 300 -o "$T/sb.tgz" "$U"; else wget -q -T 300 -O "$T/sb.tgz" "$U"; fi
  echo "$S  $T/sb.tgz" | sha256sum -c --quiet - || { echo "контрольная сумма sing-box не совпала — не ставлю" >&2; exit 4; }
  tar -xzf "$T/sb.tgz" -C "$T"
  mkdir -p /opt/wpx/bin && chmod 700 /opt/wpx
  install -m 755 "$T/sing-box-$VER-linux-$A/sing-box" /opt/wpx/bin/sing-box
fi
cat > /etc/systemd/system/wpx-singbox.service <<'UNIT'
[Unit]
Description=wpx: sing-box
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/opt/wpx/bin/sing-box run -c /opt/wpx/sing-box/config.json
Restart=on-failure
RestartSec=3
LimitNOFILE=65535
MemoryMax=256M

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
echo RT-OK
"#;

/// Общие функции для скриптов, работающих с sing-box на сервере.
const SB_FUNCS: &str = r#"
D=/opt/wpx/sing-box
mkdir -p "$D" && chmod 700 /opt/wpx "$D"
sb() { if [ "$RT" = docker ]; then docker run --rm --network host -v "$D:$D" "$IMG" "$@"; else /opt/wpx/bin/sing-box "$@"; fi; }
sb_run() {
  docker rm -f wpx-singbox >/dev/null 2>&1
  docker run -d --name wpx-singbox --restart unless-stopped --network host --memory 200m \
    -v "$D:$D:ro" "$1" run -c "$D/config.json" >/dev/null
}
sb_up() {
  if [ "$RT" = docker ]; then [ "$(docker inspect -f '{{.State.Running}}' wpx-singbox 2>/dev/null)" = true ] || return 1
  else systemctl is-active --quiet wpx-singbox || return 1; fi
  for p in $TCP; do ss -tlnH "sport = :$p" | grep -q . || return 1; done
  for p in $UDP; do ss -ulnH "sport = :$p" | grep -q . || return 1; done
}
"#;

/// Запуск контейнера AmneziaWG (установка и обновление — одинаково). Память с запасом:
/// amneziawg-go под нагрузкой раздувает буферы, при 100 МБ его убивала система.
const AWG_FUNCS: &str = r#"
A=/opt/wpx/awg
awg_run() {
  p=$(sed -n 's/^ListenPort *= *//p' "$A/wg0.conf")
  docker rm -f wpx-awg >/dev/null 2>&1
  docker run -d --name wpx-awg --restart unless-stopped --cap-add NET_ADMIN --device /dev/net/tun \
    --sysctl net.ipv4.ip_forward=1 --sysctl net.ipv4.conf.all.src_valid_mark=1 --memory 384m -e GOMEMLIMIT=192MiB \
    -p "$p:$p/udp" -v "$A:$A:ro" --entrypoint sh "$1" "$A/start.sh" >/dev/null
}
awg_up() {
  [ "$(docker inspect -f '{{.State.Running}}' wpx-awg 2>/dev/null)" = true ] || return 1
  [ "$(docker exec wpx-awg awg show wg0 listen-port 2>/dev/null)" = "$PORT" ]
}
"#;

const PICK_DEST: &str = r#"
for h in $CANDS; do
  s=$(date +%s%N)
  if timeout 5 openssl s_client -4 -connect "$h:443" -servername "$h" -tls1_3 -alpn h2 </dev/null 2>/dev/null | grep -q 'ALPN protocol: h2'; then
    echo "dest=$h $(( ($(date +%s%N) - s) / 1000000 ))"
  fi
done
true
"#;

const HY2_CERT: &str = r#"
set -eu
if [ ! -s "$D/hy2.crt" ] || [ ! -s "$D/hy2.key" ]; then
  if command -v openssl >/dev/null 2>&1; then
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -days 3650 -nodes \
      -subj "/CN=$SNI" -addext "subjectAltName=DNS:$SNI" -keyout "$D/hy2.key" -out "$D/hy2.crt" >/dev/null 2>&1
  else
    sb generate tls-keypair "$SNI" -m 120 > "$D/kp.pem"
    awk '/BEGIN PRIVATE KEY/,/END PRIVATE KEY/' "$D/kp.pem" > "$D/hy2.key"
    awk '/BEGIN CERTIFICATE/,/END CERTIFICATE/' "$D/kp.pem" > "$D/hy2.crt"
    rm -f "$D/kp.pem"
  fi
  chmod 600 "$D/hy2.key"
fi
cat "$D/hy2.crt"
"#;

/// Транзакция: новый конфиг из stdin → check → замена → запуск → проверка
/// портов; при сбое — прежний конфиг обратно.
const DEPLOY: &str = r#"
set -u
cat > "$D/config.new.json"; chmod 600 "$D/config.new.json"
if ! out=$(sb check -c "$D/config.new.json" 2>&1); then rm -f "$D/config.new.json"; echo "конфиг не принят: $out" >&2; exit 2; fi
[ -f "$D/config.json" ] && cp -p "$D/config.json" "$D/config.prev.json"
mv "$D/config.new.json" "$D/config.json"
start() {
  if [ "$RT" = docker ]; then sb_run "$IMG"
  else
    docker rm -f wpx-singbox >/dev/null 2>&1 || true
    systemctl enable wpx-singbox >/dev/null 2>&1; systemctl restart wpx-singbox
  fi
}
up() { sb_up; }
logs() { if [ "$RT" = docker ]; then docker logs --tail 5 wpx-singbox 2>&1; else journalctl -u wpx-singbox -n 5 --no-pager 2>&1; fi; }
start; ok=0
for i in 1 2 3 4 5 6 7 8; do sleep 1; if up; then ok=1; break; fi; done
if [ $ok = 1 ]; then
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then
    for p in $TCP; do ufw allow "$p/tcp" >/dev/null; done; for p in $UDP; do ufw allow "$p/udp" >/dev/null; done
  fi
  # Перешли с systemd на Docker или наоборот — старое не оставляем.
  if [ "$RT" = docker ]; then systemctl disable --now wpx-singbox >/dev/null 2>&1 || true; fi
  echo "runtime=$RT" > /opt/wpx/state; rm -f "$D/config.prev.json"; echo DEPLOY-OK; exit 0
fi
l=$(logs)
if [ -f "$D/config.prev.json" ]; then mv "$D/config.prev.json" "$D/config.json"; start; echo "вернул прежний конфиг" >&2; fi
echo "sing-box не поднялся: $l" >&2; exit 1
"#;

/// Смена портов Hysteria2: своя таблица nftables `inet wpx_hop` — UDP-диапазон
/// перенаправляется на порт sing-box; при загрузке поднимает `wpx-hop.service`.
const HOP_APPLY: &str = r#"
set -u
command -v nft >/dev/null 2>&1 || { export DEBIAN_FRONTEND=noninteractive; apt-get -qq install -y nftables >/dev/null 2>&1; }
command -v nft >/dev/null 2>&1 || { echo "нет nftables и не удалось поставить" >&2; exit 3; }
mkdir -p /opt/wpx && chmod 700 /opt/wpx
{
  echo 'table inet wpx_hop'
  echo 'delete table inet wpx_hop'
  echo 'table inet wpx_hop {'
  echo '  chain prerouting {'
  echo '    type nat hook prerouting priority dstnat; policy accept;'
  echo "    udp dport $LO-$HI redirect to :$PORT"
  echo '  }'
  echo '}'
} > /opt/wpx/hop.new
nft -c -f /opt/wpx/hop.new 2>&1 || { rm -f /opt/wpx/hop.new; echo "правила смены портов не приняты" >&2; exit 2; }
mv /opt/wpx/hop.new /opt/wpx/hop.nft
nft -f /opt/wpx/hop.nft || exit 1
if [ -d /run/systemd/system ]; then
cat > /etc/systemd/system/wpx-hop.service <<'UNIT'
[Unit]
Description=wpx Hysteria2 port hopping
After=network-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'nft -f /opt/wpx/hop.nft'
ExecStop=/bin/sh -c 'nft delete table inet wpx_hop 2>/dev/null || true'

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload; systemctl enable wpx-hop >/dev/null 2>&1
fi
echo HOP-ON
"#;

const HOP_OFF: &str = r#"
systemctl disable wpx-hop >/dev/null 2>&1 || true
rm -f /etc/systemd/system/wpx-hop.service; systemctl daemon-reload 2>/dev/null || true
nft delete table inet wpx_hop 2>/dev/null || true
rm -f /opt/wpx/hop.nft
echo HOP-OFF
"#;

/// AmneziaWG в своём контейнере: конфиг из stdin → замена → запуск →
/// проверка, что интерфейс слушает порт; при сбое — прежний конфиг.
/// Сеть контейнера своя (NAT внутри него), наружу — один UDP-порт.
const DEPLOY_AWG: &str = r#"
set -u
mkdir -p "$A" && chmod 700 /opt/wpx "$A"
cat > "$A/wg0.new"; chmod 600 "$A/wg0.new"
cat > "$A/start.sh" <<'SH'
#!/bin/sh
set -e
mkdir -p /etc/amnezia/amneziawg
cp /opt/wpx/awg/wg0.conf /etc/amnezia/amneziawg/wg0.conf
chmod 600 /etc/amnezia/amneziawg/wg0.conf
awg-quick up wg0
trap 'awg-quick down wg0; exit 0' TERM INT
# amneziawg-go живёт в фоне: пропал интерфейс — выходим, Docker поднимет контейнер заново.
while awg show wg0 >/dev/null 2>&1; do sleep 10 & wait $!; done
echo "wg0 пропал — перезапуск контейнера" >&2
exit 1
SH
chmod 700 "$A/start.sh"
docker pull -q "$AWG_IMG" >/dev/null || { echo "не скачался образ $AWG_IMG" >&2; exit 3; }
[ -f "$A/wg0.conf" ] && cp -p "$A/wg0.conf" "$A/wg0.prev"
mv "$A/wg0.new" "$A/wg0.conf"
start() { awg_run "$AWG_IMG"; }
up() { awg_up; }
start; ok=0
for i in 1 2 3 4 5 6 7 8 9 10; do sleep 1; if up; then ok=1; break; fi; done
if [ $ok = 1 ]; then
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then ufw allow "$PORT/udp" >/dev/null; fi
  rm -f "$A/wg0.prev"; echo AWG-OK; exit 0
fi
l=$(docker logs --tail 5 wpx-awg 2>&1)
if [ -f "$A/wg0.prev" ]; then mv "$A/wg0.prev" "$A/wg0.conf"; start; echo "вернул прежний конфиг AWG" >&2
else docker rm -f wpx-awg >/dev/null 2>&1; fi
echo "AmneziaWG не поднялся: $l" >&2; exit 1
"#;

/// Убрать только AWG (остальное wpx на сервере остаётся).
const REMOVE_AWG: &str = r#"
docker rm -f wpx-awg >/dev/null 2>&1 || true
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then ufw delete allow "$PORT/udp" >/dev/null 2>&1; fi
rm -rf /opt/wpx/awg; echo AWG-REMOVED
"#;

/// Docker для AmneziaWG — пакет `docker.io` из репозитория Debian/Ubuntu.
const INSTALL_DOCKER: &str = r#"
set -e
export DEBIAN_FRONTEND=noninteractive
command -v apt-get >/dev/null 2>&1 || { echo "нет apt — поставьте Docker вручную" >&2; exit 3; }
apt-get -qq update >/dev/null
apt-get -qq install -y docker.io >/dev/null
systemctl enable --now docker >/dev/null 2>&1 || true
docker info >/dev/null 2>&1 && echo DOCKER-OK
"#;

/// Остановить sing-box wpx, когда в нём не осталось ни одного входа.
const STOP_SB: &str = r#"
docker rm -f wpx-singbox >/dev/null 2>&1 || true
systemctl disable --now wpx-singbox >/dev/null 2>&1 || true
rm -f /opt/wpx/sing-box/config.json; echo SB-STOPPED
"#;

/// Усиление сервера — каждое по флагу; вход по паролю не трогаем (им
/// пользуется AmneziaVPN). fail2ban не банит адрес, с которого зашёл wpx.
const HARDEN: &str = r#"
set -u
export DEBIAN_FRONTEND=noninteractive
if [ "$BBR" = 1 ]; then
  if sysctl -n net.ipv4.tcp_available_congestion_control | grep -qw bbr || modprobe tcp_bbr 2>/dev/null; then
    printf 'net.core.default_qdisc=fq\nnet.ipv4.tcp_congestion_control=bbr\n' > /etc/sysctl.d/99-wpx-bbr.conf
    sysctl -q -p /etc/sysctl.d/99-wpx-bbr.conf && echo "BBR-OK" || echo "BBR-FAIL"
  else echo "BBR-NO"; fi
fi
if [ "$AUTOUPD" = 1 ] || [ "$F2B" = 1 ]; then apt-get -qq update >/dev/null 2>&1; fi
if [ "$AUTOUPD" = 1 ]; then
  if apt-get -qq install -y unattended-upgrades >/dev/null 2>&1; then
    printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' > /etc/apt/apt.conf.d/20auto-upgrades
    echo "AUTOUPD-OK"
  else echo "AUTOUPD-FAIL"; fi
fi
if [ "$F2B" = 1 ]; then
  me="${WPX_ME:-}"
  if apt-get -qq install -y fail2ban >/dev/null 2>&1; then
    mkdir -p /etc/fail2ban/jail.d
    printf '[sshd]\nenabled = true\nbackend = systemd\nmaxretry = 6\nfindtime = 10m\nbantime = 1h\nignoreip = 127.0.0.1/8 ::1 %s\n' "$me" > /etc/fail2ban/jail.d/wpx-sshd.conf
    systemctl enable fail2ban >/dev/null 2>&1; systemctl restart fail2ban
    sleep 2; systemctl is-active --quiet fail2ban && echo "F2B-OK" || echo "F2B-FAIL"
  else echo "F2B-FAIL"; fi
fi
true
"#;

const EXPORT: &str = r#"
cat /opt/wpx/sing-box/config.json 2>/dev/null; echo; echo '#WPX-CERT'
cat /opt/wpx/sing-box/hy2.crt 2>/dev/null; echo '#WPX-AWG'
cat /opt/wpx/awg/wg0.conf 2>/dev/null; echo '#WPX-RT'
if [ -f /opt/wpx/state ]; then sed -n 's/^runtime=//p' /opt/wpx/state
elif docker inspect wpx-singbox >/dev/null 2>&1; then echo docker
elif [ -f /etc/systemd/system/wpx-singbox.service ]; then echo systemd; fi
"#;

const UNINSTALL: &str = r#"
systemctl disable --now wpx-heal.timer >/dev/null 2>&1 || true
rm -f /etc/systemd/system/wpx-heal.service /etc/systemd/system/wpx-heal.timer
docker rm -f wpx-singbox wpx-awg wpx-xray wpx-mtg >/dev/null 2>&1 || true
if [ -f /etc/systemd/system/wpx-singbox.service ]; then
  systemctl disable --now wpx-singbox >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/wpx-singbox.service; systemctl daemon-reload
fi
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then
  for p in $TCP; do ufw delete allow "$p/tcp" >/dev/null 2>&1; done; for p in $UDP; do ufw delete allow "$p/udp" >/dev/null 2>&1; done
fi
systemctl disable wpx-fw wpx-hop >/dev/null 2>&1 || true
rm -f /etc/systemd/system/wpx-fw.service /etc/systemd/system/wpx-hop.service; systemctl daemon-reload 2>/dev/null || true
nft delete table inet wpx_fw 2>/dev/null || true
nft delete table inet wpx_hop 2>/dev/null || true
rm -rf /opt/wpx
echo UNINSTALL-OK
"#;

// ─── Ход операции в окне ─────────────────────────────────────────

#[derive(Clone, Serialize)]
struct LogLine {
    kind: &'static str,
    text: String,
}

/// Строки хода операции: «step» — начато, «ok» — готово, «warn», «fail».
type Log = Arc<dyn Fn(&'static str, String) + Send + Sync>;

fn logger(app: &AppHandle) -> Log {
    let app = app.clone();
    Arc::new(move |kind, text| {
        let _ = app.emit("server-log", LogLine { kind, text });
    })
}

static BUSY: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

// ─── Подключение ─────────────────────────────────────────────────

struct Conn {
    s: Session,
    jump: Option<Session>,
    /// Вход не под root — скрипты wpx идут через `sudo -n`.
    sudo: bool,
}

impl Conn {
    async fn sh(&self, env: &[(&str, String)], script: &str, stdin: &[u8], secs: u64) -> Result<ssh::Output, String> {
        // Переменные — в начало скрипта; сам скрипт — аргументом `bash -c`:
        // stdin занят данными.
        // Адрес ПК, каким его видит сервер (SSH_CLIENT): sudo сбрасывает
        // окружение — передаём аргументом, скрипту — как WPX_ME.
        let mut head = String::from("WPX_ME=\"${1:-}\"\n");
        for (k, v) in env {
            head.push_str(&format!("{k}='{}'\n", v.replace('\'', "'\\''")));
        }
        let full = format!("{head}{script}");
        let cmd = format!("{}bash -c '{}' wpx \"${{SSH_CLIENT%% *}}\"", if self.sudo { "sudo -n " } else { "" }, full.replace('\'', "'\\''"));
        self.s.run(&cmd, stdin, Duration::from_secs(secs)).await
    }

    async fn close(self) {
        self.s.close().await;
        if let Some(j) = self.jump {
            j.close().await;
        }
    }
}

fn key_of(s: &Server) -> Result<Arc<russh::keys::PrivateKey>, String> {
    Ok(Arc::new(ssh::key_from_text(&profiles::decrypt_str(&s.key_enc)?)?))
}

async fn bind_ip() -> Option<std::net::IpAddr> {
    let iface = netcfg::load().interface;
    tokio::task::spawn_blocking(move || ssh::phys_ip(&iface)).await.ok().flatten()
}

async fn open(store: &Store, s: &Server, log: &Log) -> Result<Conn, String> {
    let bind = bind_ip().await;
    let key = key_of(s)?;
    match &s.via {
        None => {
            log("step", format!("SSH: {} напрямую", s.host));
            let c = ssh::connect(&s.host, s.port, &s.user, &Auth::Key(key), &s.host_key, Route::Direct { bind }).await?;
            Ok(Conn { s: c, jump: None, sudo: s.user != "root" })
        }
        Some(v) => {
            let j = store.servers.iter().find(|x| &x.id == v).ok_or("сервер-посредник удалён из wpx")?;
            log("step", format!("SSH: {} через {}", s.host, j.name));
            let js = ssh::connect(&j.host, j.port, &j.user, &Auth::Key(key_of(j)?), &j.host_key, Route::Direct { bind }).await?;
            let c = ssh::connect(&s.host, s.port, &s.user, &Auth::Key(key), &s.host_key, Route::Jump(&js)).await?;
            Ok(Conn { s: c, jump: Some(js), sudo: s.user != "root" })
        }
    }
}

async fn inspect(c: &Conn) -> Result<Facts, String> {
    let o = c.sh(&[], &format!("{INSPECT}{}", heal::READ), b"", 60).await?;
    Ok(parse_facts(&o.out))
}

/// Если на сервере уже есть установка wpx, а в wpx она не записана —
/// подхватить её (ключи и порты сохраняются).
async fn adopt_existing(c: &Conn, s: &mut Server, known: &[Server], log: &Log) -> Result<(), String> {
    if !s.facts.as_ref().map(|f| f.wpx).unwrap_or(false) || s.vless.is_some() || s.hy2.is_some() || s.awg.is_some() || !s.pipes.is_empty() {
        return Ok(());
    }
    let o = c.sh(&[], EXPORT, b"", 20).await?;
    let (cfg, rest) = o.out.split_once("#WPX-CERT").unwrap_or((&o.out, ""));
    let (cert, rest) = rest.split_once("#WPX-AWG").unwrap_or((rest, ""));
    let (awg, rt) = rest.split_once("#WPX-RT").unwrap_or((rest, ""));
    let mut sec = if cfg.trim().is_empty() {
        secrets_of(s).unwrap_or_default()
    } else {
        let cfg: Value = serde_json::from_str(cfg.trim()).map_err(|e| format!("конфиг на сервере не прочитан: {e}"))?;
        adopt(s, &cfg, cert, rt.trim(), known)?
    };
    s.awg = adopt_awg(awg, &mut sec);
    s.secrets_enc = enc(&serde_json::to_string(&sec).map_err(|e| e.to_string())?)?;
    let what: Vec<String> = s
        .vless
        .iter()
        .map(|v| format!("VLESS+Reality :{}", v.port))
        .chain(s.hy2.iter().map(|h| format!("Hysteria2 :{}", h.port)))
        .chain(s.awg.iter().map(|a| format!("AmneziaWG :{} (ключ клиента выпущу новый)", a.port)))
        .chain(s.pipes.iter().map(|p| format!("труба :{} → {}", p.listen, p.to_host)))
        .collect();
    log("ok", format!("Подхватил установку wpx на сервере: {}", what.join(", ")));
    Ok(())
}

fn rt_env(rt: &str) -> Vec<(&'static str, String)> {
    vec![("RT", rt.into()), ("IMG", SB_IMAGE.into())]
}

async fn ensure_runtime(c: &Conn, s: &mut Server, log: &Log) -> Result<(), String> {
    let f = s.facts.clone().unwrap_or_default();
    if s.runtime.is_empty() {
        s.runtime = if f.docker {
            "docker".into()
        } else if f.systemd {
            "systemd".into()
        } else {
            return Err("На сервере нет ни Docker, ни systemd — поставить некуда".into());
        };
    }
    log("step", format!(
        "sing-box {SB_VERSION}: {}",
        if s.runtime == "docker" { "образ Docker (закреплён по digest)" } else { "бинарник с проверкой sha256 + служба systemd" }
    ));
    let mut env = rt_env(&s.runtime);
    env.extend([("VER", SB_VERSION.into()), ("SHA_AMD64", SB_SHA_AMD64.into()), ("SHA_ARM64", SB_SHA_ARM64.into())]);
    let o = c.sh(&env, ENSURE_RUNTIME, b"", 420).await?;
    if o.code != 0 || !o.out.contains("RT-OK") {
        return Err(format!("sing-box не установился: {}", o.reason()));
    }
    log("ok", "sing-box на месте".into());
    Ok(())
}

async fn deploy(c: &Conn, s: &Server, sec: &Secrets, log: &Log) -> Result<(), String> {
    let (tcp, udp) = our_ports(s);
    let list = |v: &[u16]| v.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(" ");
    log("step", "Конфиг: проверка, замена, запуск (при сбое — откат)".into());
    let mut env = rt_env(&s.runtime);
    env.extend([("TCP", list(&tcp)), ("UDP", list(&udp))]);
    let cfg = serde_json::to_vec_pretty(&singbox_config(s, sec)).map_err(|e| e.to_string())?;
    let o = c.sh(&env, &format!("{SB_FUNCS}{DEPLOY}"), &cfg, 180).await?;
    if o.code != 0 || !o.out.contains("DEPLOY-OK") {
        return Err(o.reason());
    }
    log("ok", format!("Запущено: TCP {} · UDP {}", list(&tcp), list(&udp)));
    Ok(())
}

// ─── Профили из сервера ──────────────────────────────────────────

/// Куда подключаться к каждому протоколу: сам сервер или трубы входа.
#[derive(Clone, Copy, Default)]
struct Ports {
    vless: Option<u16>,
    hy2: Option<u16>,
    awg: Option<u16>,
    /// XHTTP — только напрямую (трубы каскада его не пересылают).
    xhttp: Option<u16>,
}

impl Ports {
    fn of(s: &Server) -> Self {
        Ports { vless: s.vless.as_ref().map(|v| v.port), hy2: s.hy2.as_ref().map(|h| h.port), awg: s.awg.as_ref().map(|a| a.port), xhttp: s.xhttp.as_ref().map(|x| x.port) }
    }
    /// Порты выхода → порты труб на входе.
    fn via(s: &Server, pipes: &[Pipe]) -> Self {
        let m = |p: Option<u16>| p.and_then(|p| pipes.iter().find(|x| x.final_port() == p).map(|x| x.listen));
        let o = Ports::of(s);
        Ports { vless: m(o.vless), hy2: m(o.hy2), awg: m(o.awg), xhttp: None }
    }
}

/// Точки подключения: `host`/порты — сам сервер или вход каскада `via`
/// (id сервера-входа: у AmneziaWG через него — свой ключ пути).
fn endpoints(s: &Server, sec: &Secrets, host: &str, ports: Ports, label: &str, via: Option<&str>) -> Vec<Endpoint> {
    let (vless_port, hy2_port) = (ports.vless, ports.hy2);
    let mut links = vec![];
    if let (Some(v), Some(port)) = (&s.vless, vless_port) {
        links.push(format!(
            "vless://{}@{at}?security=reality&sni={}&fp=chrome&pbk={}&sid={}&type=tcp&flow=xtls-rprx-vision#{}",
            sec.uuid, v.dest, v.public_key, v.short_id,
            percent_encoding::utf8_percent_encode(&format!("{label} · VLESS"), percent_encoding::NON_ALPHANUMERIC),
            at = host_port(host, port)
        ));
    }
    if let (Some(x), Some(port)) = (&s.xhttp, ports.xhttp) {
        links.push(format!(
            "vless://{}@{at}?security=reality&sni={}&fp=chrome&pbk={}&sid={}&type=xhttp&path={}&mode=auto#{}",
            sec.uuid, x.dest, x.public_key, x.short_id,
            percent_encoding::utf8_percent_encode(&x.path, percent_encoding::NON_ALPHANUMERIC),
            percent_encoding::utf8_percent_encode(&format!("{label} · XHTTP"), percent_encoding::NON_ALPHANUMERIC),
            at = host_port(host, port)
        ));
    }
    if let (Some(h), Some(port)) = (&s.hy2, hy2_port) {
        // Смена портов — только напрямую к серверу (труба входа пересылает один порт).
        let mport = h.hop.filter(|_| port == h.port).map(|(lo, hi)| format!("&mport={lo}-{hi}")).unwrap_or_default();
        links.push(format!(
            "hysteria2://{}@{at}?sni={}&obfs=salamander&obfs-password={}&pinSHA256={}{mport}#{}",
            sec.hy2_password, h.sni, sec.hy2_obfs, h.cert_sha256,
            percent_encoding::utf8_percent_encode(&format!("{label} · Hysteria2"), percent_encoding::NON_ALPHANUMERIC),
            at = host_port(host, port)
        ));
    }
    let mut eps: Vec<Endpoint> = links.iter().filter_map(|l| proto::parse(l).ok()).collect();
    if let (Some(a), Some(port)) = (&s.awg, ports.awg) {
        // Через вход — только своим ключом пути: на ключе владельца путь
        // выбивал бы подключение напрямую (и наоборот). Ключа ещё нет — без AWG.
        let key = match via {
            None => (!sec.awg_client_private.is_empty()).then_some((sec.awg_client_private.as_str(), 2)),
            Some(v) => s.awg_paths.iter().find(|p| p.via == v).and_then(|p| sec.awg_paths.iter().find(|k| k.via == v).map(|k| (k.private.as_str(), p.ip))),
        };
        if let Some((private, ip)) = key {
            if let Ok(mut e) = proto::parse_awg_conf(&awg_client_conf(a, private, &sec.awg_psk, ip, host, port, via.is_some())) {
                e.label = format!("{label} · AmneziaWG");
                eps.push(e);
            }
        }
    }
    eps
}

/// Проверить точки с ПК мимо туннеля и расставить по рангу.
async fn rank_endpoints(eps: Vec<Endpoint>, log: &Log) -> (Vec<Endpoint>, Vec<ProbeResult>) {
    log("step", "Проверка с этого ПК через провайдера (песочница, мимо туннеля)".into());
    let opt = sandbox::Options { interface: Some(netcfg::load().interface), rounds: 3, timeout_ms: 8000, bulk: true, ..Default::default() };
    match sandbox::probe(eps.clone(), opt).await {
        Ok(r) => {
            for x in &r {
                match x.median_ms {
                    Some(ms) if x.ok > 0 => match x.bulk.as_ref().and_then(|b| b.note()) {
                        Some(n) => log("warn", format!("{}: {}/{} · {ms} мс, но {n}", x.label, x.ok, x.rounds)),
                        None => log("ok", format!("{}: {}/{} · {ms} мс{}", x.label, x.ok, x.rounds, x.bulk.as_ref().map(|b| format!(" · 256 КБ за {:.1} с", b.ms as f64 / 1000.0)).unwrap_or_default())),
                    },
                    _ => log("warn", format!("{}: {}", x.label, x.error.clone().unwrap_or_else(|| "нет ответа".into()))),
                }
            }
            let order = sandbox::rank(&r);
            let mut out: Vec<Endpoint> = order.iter().map(|&i| eps[i].clone()).collect();
            // Не ответившие — в хвост резервом (провайдер мог «моргнуть»).
            out.extend(eps.iter().enumerate().filter(|(i, _)| !order.contains(i)).map(|(_, e)| e.clone()));
            (out, r)
        }
        Err(e) => {
            log("warn", format!("Проверка не удалась: {e}"));
            (eps, vec![])
        }
    }
}

// ─── Окно ────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct ServerView {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub host_key: String,
    pub via: Option<String>,
    pub via_name: Option<String>,
    pub facts: Option<Facts>,
    pub runtime: String,
    pub vless: Option<Vless>,
    pub hy2: Option<Hy2>,
    pub awg: Option<Awg>,
    pub xhttp: Option<extra::Xhttp>,
    pub mtproxy: Option<extra::MtProxy>,
    pub pipes: Vec<PipeView>,
    /// Профиль, созданный из этого сервера.
    pub profile: Option<String>,
    /// Входы каскада, которые ведут на этот сервер (пути маршрута).
    pub entries: Vec<String>,
    /// Профиль маршрута к этому серверу (все пути).
    pub route: Option<String>,
    pub guests: Vec<Guest>,
    pub fw: bool,
    pub fw_plan: fw::FwPlan,
    /// Что можно обновить: «sing-box 1.14.3 → 1.14.4», «AmneziaWG → …».
    pub updates: Vec<String>,
}

#[derive(Serialize)]
pub struct PipeView {
    pub to: String,
    pub to_name: String,
    pub to_host: String,
    pub listen: u16,
    pub to_port: u16,
    pub profile: Option<String>,
    /// Цепочка: промежуточный сервер.
    pub hop: Option<String>,
    pub hop_name: Option<String>,
}

#[derive(Serialize)]
pub struct ServersState {
    pub servers: Vec<ServerView>,
    pub version: &'static str,
    /// Сайты-прикрытия, из которых wpx выбирает для Reality.
    pub covers: &'static [&'static str],
}

fn state(st: &Store) -> ServersState {
    let pr = profiles::load();
    let prof = |origin: String| pr.profiles.iter().find(|p| p.origin == origin).map(|p| p.id.clone());
    let name = |id: &str| st.servers.iter().find(|x| x.id == id).map(|x| x.name.clone());
    ServersState {
        servers: st
            .servers
            .iter()
            .map(|s| ServerView {
                id: s.id.clone(),
                name: s.name.clone(),
                host: s.host.clone(),
                port: s.port,
                user: s.user.clone(),
                host_key: s.host_key.clone(),
                via: s.via.clone(),
                via_name: s.via.as_deref().and_then(name),
                facts: s.facts.clone(),
                runtime: s.runtime.clone(),
                vless: s.vless.clone(),
                hy2: s.hy2.clone(),
                awg: s.awg.clone(),
                xhttp: s.xhttp.clone(),
                mtproxy: s.mtproxy.clone(),
                pipes: s
                    .pipes
                    .iter()
                    .map(|p| PipeView {
                        to: p.to.clone(),
                        to_name: name(&p.to).unwrap_or_else(|| p.to_host.clone()),
                        to_host: p.to_host.clone(),
                        listen: p.listen,
                        to_port: p.final_port(),
                        hop: p.hop.clone(),
                        hop_name: p.hop.as_deref().and_then(name),
                        profile: prof(format!("route:{}", p.to)),
                    })
                    .collect(),
                profile: prof(format!("server:{}", s.id)),
                entries: st.servers.iter().filter(|e| e.pipes.iter().any(|p| p.to == s.id)).map(|e| e.name.clone()).collect(),
                route: prof(format!("route:{}", s.id)),
                guests: s.guests.clone(),
                fw: s.fw.is_some(),
                fw_plan: fw::plan(s),
                updates: update::pending(s).into_iter().map(|(_, t)| t).collect(),
            })
            .collect(),
        version: SB_VERSION,
        covers: REALITY_DEST,
    }
}

#[derive(Serialize)]
pub struct OpResult {
    pub state: ServersState,
    pub probe: Vec<ProbeResult>,
    pub profile: Option<String>,
    pub note: Option<String>,
}

#[tauri::command]
pub fn servers_list() -> ServersState {
    state(&load())
}

#[derive(Deserialize)]
pub struct ServerInput {
    pub name: String,
    pub host: String,
    pub port: Option<u16>,
    pub user: String,
    /// Пароль — один раз, чтобы поставить ключ wpx; нигде не сохраняется.
    pub password: Option<String>,
    /// Или свой ключ (файл OpenSSH без парольной фразы).
    pub key_path: Option<String>,
    pub via: Option<String>,
    /// Отпечаток ключа сервера (`SHA256:…`), который пользователь сверил с
    /// панелью хостинга (`server_fingerprint`). Пусто (консоль) — берётся тот,
    /// что сервер показывает сейчас: доверие при первом входе, как у ssh.
    #[serde(default)]
    pub fingerprint: Option<String>,
}

/// Ключ нового сервера и через какой свой сервер к нему ходить.
#[derive(Serialize)]
pub struct HostKey {
    pub fingerprint: String,
    /// Напрямую с ПК не открылся — нашёлся путь через этот свой сервер.
    pub via: Option<String>,
}

/// Отпечаток ключа нового сервера — до любого входа: пароль и ключ wpx не
/// отправляются, пока пользователь его не сверит. `via` — через свой сервер;
/// без него напрямую, а не открылся — через свой сервер, с которого путь до
/// него держится (адрес могут резать по пути от ПК, а со своего сервера —
/// пропускать «волнами», и тогда установка рвалась бы посередине).
#[tauri::command]
pub async fn server_fingerprint(host: String, port: Option<u16>, via: Option<String>) -> Result<HostKey, String> {
    let host = server_ip(&host)?;
    let port = port.unwrap_or(22);
    let st = load();
    let quiet: Log = Arc::new(|_, _| {});
    if let Some(v) = via.filter(|v| !v.is_empty()) {
        let j = st.servers.iter().find(|x| x.id == v).ok_or("сервер-посредник не найден")?;
        let c = open(&st, j, &quiet).await?;
        let r = ssh::fingerprint(&host, port, Route::Jump(&c.s)).await;
        c.close().await;
        return Ok(HostKey { fingerprint: r?, via: Some(v) });
    }
    let direct = ssh::fingerprint(&host, port, Route::Direct { bind: bind_ip().await }).await;
    if let Ok(fingerprint) = direct {
        return Ok(HostKey { fingerprint, via: None });
    }
    let target = Server { host: host.clone(), port, ..Default::default() };
    for j in st.servers.iter().filter(|j| j.via.is_none()) {
        let Ok(c) = open(&st, j, &quiet).await else { continue };
        let holds = match path::probe(&c, &target).await {
            Ok(r) if path::pick(&r, &target).is_some() => path::steady(&c, &target, &host).await.is_ok_and(path::holds),
            _ => false,
        };
        let fp = if holds { ssh::fingerprint(&host, port, Route::Jump(&c.s)).await.ok() } else { None };
        c.close().await;
        if let Some(fingerprint) = fp {
            return Ok(HostKey { fingerprint, via: Some(j.id.clone()) });
        }
    }
    direct.map(|fingerprint| HostKey { fingerprint, via: None })
}

#[tauri::command]
pub async fn server_add(app: AppHandle, input: ServerInput) -> Result<ServersState, String> {
    let _g = BUSY.try_lock().map_err(|_| "Уже идёт операция с сервером")?;
    let log = logger(&app);
    let r = add(input, &log).await;
    if let Err(e) = &r {
        log("fail", e.clone());
    }
    r
}

async fn add(input: ServerInput, log: &Log) -> Result<ServersState, String> {
    let host = server_ip(&input.host)?;
    let mut st = load();
    if st.servers.iter().any(|s| s.host == host) {
        return Err(format!("{host} уже есть в списке серверов"));
    }
    let user = if input.user.trim().is_empty() { "root".to_string() } else { input.user.trim().to_string() };
    let port = input.port.unwrap_or(22);
    let auth = match (&input.password, &input.key_path) {
        (Some(p), _) if !p.is_empty() => Auth::Password(p.clone()),
        (_, Some(k)) if !k.trim().is_empty() => Auth::Key(Arc::new(
            russh::keys::load_secret_key(k.trim(), None).map_err(|e| format!("ключ {k}: {e} (с парольной фразой пока не поддерживается)"))?,
        )),
        _ => return Err("Нужен пароль или файл ключа".into()),
    };
    let bind = bind_ip().await;
    let jump = match &input.via {
        Some(v) if !v.is_empty() => {
            let j = st.servers.iter().find(|x| &x.id == v).ok_or("сервер-посредник не найден")?;
            log("step", format!("Подключаюсь к посреднику {}", j.name));
            Some(ssh::connect(&j.host, j.port, &j.user, &Auth::Key(key_of(j)?), &j.host_key, Route::Direct { bind }).await?)
        }
        _ => None,
    };
    let route = || match &jump {
        Some(j) => Route::Jump(j),
        None => Route::Direct { bind },
    };
    let hint = |e: String| {
        if jump.is_none() && e.contains("нет ответа") {
            format!("{e}. Проверьте в панели хостинга, что сервер запущен и TCP {port} открыт (файрвол хостинга). Если на роутере kill switch — разрешите {host} TCP {port}, или выберите «через сервер».")
        } else {
            e
        }
    };
    // Ключ сервера — до пароля: подтверждённый в окне отпечаток; из консоли
    // без --fingerprint — тот, что сервер показывает сейчас (как у ssh).
    let expected = match input.fingerprint.as_deref().map(str::trim).filter(|f| !f.is_empty()) {
        Some(f) => ssh::norm_fingerprint(f).ok_or("Отпечаток ключа сервера — вида SHA256:…")?,
        None => {
            let fp = ssh::fingerprint(&host, port, route()).await.map_err(&hint)?;
            log("warn", format!("Ключ сервера не сверен — доверяю при первом входе: {fp}"));
            fp
        }
    };
    log("step", format!("Подключаюсь к {user}@{}{}", host_port(&host, port), if jump.is_some() { " через посредника" } else { " напрямую (мимо туннеля)" }));
    let first = ssh::connect(&host, port, &user, &auth, &expected, route()).await.map_err(&hint)?;
    log("ok", format!("Ключ сервера совпал: {}", first.host_key));

    log("step", "Ставлю отдельный ключ wpx (пароль не сохраняется)".into());
    let key = ssh::new_key()?;
    let line = ssh::public_line(&key)?;
    let o = first
        .run(
            "umask 077; mkdir -p ~/.ssh; k=$(cat | tr -d '\\r'); touch ~/.ssh/authorized_keys; grep -qxF \"$k\" ~/.ssh/authorized_keys || printf '%s\\n' \"$k\" >> ~/.ssh/authorized_keys; echo KEY-OK",
            format!("{line}\n").as_bytes(),
            Duration::from_secs(20),
        )
        .await?;
    if !o.out.contains("KEY-OK") {
        return Err(format!("ключ не встал: {}", o.reason()));
    }
    let host_key = first.host_key.clone();
    first.close().await;

    let mut s = Server {
        // id от адреса: «Забыть» и добавить снова — тот же сервер, его профили
        // обновятся, а не задвоятся.
        id: format!("s{}", host.replace(['.', ':'], "-")),
        name: input.name.trim().to_string(),
        host: host.clone(),
        port,
        user,
        key_enc: enc(&ssh::key_to_text(&key)?)?,
        host_key,
        via: jump.as_ref().and(input.via.clone()),
        ..Default::default()
    };
    if let Some(j) = jump {
        j.close().await;
    }
    log("step", "Вход по ключу wpx и осмотр сервера".into());
    let c = open(&st, &s, log).await?;
    let f = inspect(&c).await?;
    if !f.root {
        c.close().await;
        return Err("Нужен root или пользователь с sudo без пароля (NOPASSWD)".into());
    }
    if s.name.is_empty() {
        s.name = if f.city.is_empty() { host.clone() } else { f.city.clone() };
    }
    log("ok", facts_line(&f));
    s.facts = Some(f);
    let known = st.servers.clone();
    let r = adopt_existing(&c, &mut s, &known, log).await;
    c.close().await;
    r?;
    // Трубы, найденные на входах раньше выхода, теперь знают, куда ведут.
    for p in st.servers.iter_mut().flat_map(|e| e.pipes.iter_mut()) {
        if p.to.is_empty() && p.hop.is_none() && path::at(&s, &p.to_host) {
            p.to = s.id.clone();
        }
    }
    st.servers.push(s.clone());
    save(&st)?;
    log("ok", "Сервер добавлен".into());
    // Уже настроен wpx (например, с другого ПК) — профили для этого ПК сразу.
    let linked = st.servers.iter().any(|e| e.pipes.iter().any(|p| p.to == s.id));
    if s.vless.is_some() || s.hy2.is_some() || s.xhttp.is_some() || !s.pipes.is_empty() || linked {
        if let Err(e) = local_profiles(&st, &s, log).await {
            log("warn", format!("Профиль не создан: {e}. Повторить — «Профиль на этом ПК» на карточке сервера"));
        }
    }
    Ok(state(&st))
}

fn facts_line(f: &Facts) -> String {
    let place = [f.city.as_str(), f.country.as_str(), f.org.as_str()].iter().filter(|x| !x.is_empty()).cloned().collect::<Vec<_>>().join(", ");
    let others: Vec<&str> = f.containers.iter().map(String::as_str).filter(|c| !c.starts_with("wpx-")).collect();
    format!(
        "{} · {} · {} ядр. · {} МБ ОЗУ{}{}",
        f.os,
        if place.is_empty() { "?".into() } else { place },
        f.cpus,
        f.ram_mb,
        if f.docker { " · Docker" } else { "" },
        if others.is_empty() { String::new() } else { format!(" · не трогаю: {}", others.join(", ")) }
    )
}

#[tauri::command]
pub async fn server_inspect(app: AppHandle, id: String) -> Result<ServersState, String> {
    let _g = BUSY.try_lock().map_err(|_| "Уже идёт операция с сервером")?;
    let log = logger(&app);
    let r: Result<ServersState, String> = async {
        let mut st = load();
        let mut s = st.servers.iter().find(|x| x.id == id).cloned().ok_or("сервер не найден")?;
        let c = open(&st, &s, &log).await?;
        let f = inspect(&c).await;
        let r = match f {
            Ok(f) => {
                log("ok", facts_line(&f));
                s.facts = Some(f);
                let known = st.servers.clone();
                adopt_existing(&c, &mut s, &known, &log).await
            }
            Err(e) => Err(e),
        };
        c.close().await;
        r?;
        if let Some(x) = st.servers.iter_mut().find(|x| x.id == id) {
            *x = s;
        }
        save(&st)?;
        Ok(state(&st))
    }
    .await;
    if let Err(e) = &r {
        log("fail", e.clone());
    }
    r
}

#[tauri::command]
pub async fn server_harden(app: AppHandle, id: String, bbr: bool, autoupd: bool, f2b: bool) -> Result<ServersState, String> {
    let _g = BUSY.try_lock().map_err(|_| "Уже идёт операция с сервером")?;
    let log = logger(&app);
    let r = harden(&id, bbr, autoupd, f2b, &log).await;
    if let Err(e) = &r {
        log("fail", e.clone());
    }
    r
}

/// Включить выбранную защиту на открытом соединении; итог — в ход операции.
async fn harden_on(c: &Conn, bbr: bool, autoupd: bool, f2b: bool, log: &Log) {
    let flag = |b: bool| if b { "1".to_string() } else { "0".to_string() };
    let what: Vec<&str> = [(bbr, "BBR"), (autoupd, "автообновления безопасности"), (f2b, "защита SSH от перебора")].iter().filter(|x| x.0).map(|x| x.1).collect();
    log("step", format!("Защита сервера: {} (может занять пару минут — ставятся пакеты)", what.join(", ")));
    let o = match c.sh(&[("BBR", flag(bbr)), ("AUTOUPD", flag(autoupd)), ("F2B", flag(f2b))], HARDEN, b"", 600).await {
        Ok(o) => o,
        Err(e) => {
            log("warn", format!("защита не включилась: {e}"));
            return;
        }
    };
    for (tag, ok, no) in [
        ("BBR", "BBR включён", "BBR не включился"),
        ("AUTOUPD", "автообновления безопасности включены", "автообновления не встали"),
        ("F2B", "fail2ban стережёт SSH (адрес wpx — в исключениях)", "fail2ban не встал"),
    ] {
        if o.out.contains(&format!("{tag}-OK")) {
            log("ok", ok.into());
        } else if o.out.contains(&format!("{tag}-FAIL")) || o.out.contains(&format!("{tag}-NO")) {
            log("warn", if o.out.contains("BBR-NO") && tag == "BBR" { "ядро без BBR".into() } else { no.into() });
        }
    }
}

async fn harden(id: &str, bbr: bool, autoupd: bool, f2b: bool, log: &Log) -> Result<ServersState, String> {
    if !bbr && !autoupd && !f2b {
        return Err("Ничего не выбрано".into());
    }
    let mut st = load();
    let s = st.servers.iter().find(|x| x.id == id).cloned().ok_or("сервер не найден")?;
    let c = open(&st, &s, log).await?;
    harden_on(&c, bbr, autoupd, f2b, log).await;
    let f = inspect(&c).await.ok();
    c.close().await;
    if let (Some(f), Some(x)) = (f, st.servers.iter_mut().find(|x| x.id == id)) {
        x.facts = Some(f);
    }
    save(&st)?;
    Ok(state(&st))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn server_install(app: AppHandle, id: String, vless: bool, hy2: bool, awg: bool, xhttp: Option<bool>, mtproxy: Option<bool>, harden: bool, cover: Option<String>) -> Result<OpResult, String> {
    let _g = BUSY.try_lock().map_err(|_| "Уже идёт операция с сервером")?;
    let log = logger(&app);
    let r = install(&id, Want { vless, hy2, awg, xhttp: xhttp.unwrap_or(false), mtproxy: mtproxy.unwrap_or(false), harden, runtime: None, cover }, &log).await;
    if let Err(e) = &r {
        log("fail", e.clone());
    }
    r
}

async fn deploy_awg(c: &Conn, s: &Server, a: &Awg, sec: &Secrets, log: &Log) -> Result<(), String> {
    log("step", format!("AmneziaWG {AWG_VERSION}: свой контейнер wpx-awg, UDP {} (при сбое — откат)", a.port));
    let conf = awg_server_conf(s, a, sec)?;
    let o = c.sh(&[("AWG_IMG", AWG_IMAGE.into()), ("PORT", a.port.to_string())], &format!("{AWG_FUNCS}{DEPLOY_AWG}"), conf.as_bytes(), 300).await?;
    if o.code != 0 || !o.out.contains("AWG-OK") {
        return Err(o.reason());
    }
    log("ok", format!("AmneziaWG слушает UDP {}", a.port));
    Ok(())
}

/// Сайт-прикрытие для Reality и FakeTLS: TLS 1.3 + h2, быстрее всех с сервера.
async fn pick_dest(c: &Conn, log: &Log) -> Result<String, String> {
    pick_from(c, log, REALITY_DEST, "").await
}

/// Новое прикрытие для VLESS и XHTTP: «auto» — самое быстрое из списка,
/// кроме нынешнего (его могли заблокировать); адрес — если с сервера у него
/// есть TLS 1.3 с HTTP/2 (без этого Reality не работает).
async fn new_cover(c: &Conn, log: &Log, want: Option<&str>, cur: &str) -> Result<Option<String>, String> {
    match want.map(str::trim) {
        None | Some("") => Ok(None),
        Some("auto") => pick_from(c, log, REALITY_DEST, cur).await.map(Some),
        Some(d) if netcfg::valid_domain(d) => {
            let d = d.to_ascii_lowercase();
            log("step", format!("Проверяю прикрытие {d}: TLS 1.3 + h2 с сервера"));
            let o = c.sh(&[("CANDS", d.clone())], PICK_DEST, b"", 60).await?;
            if o.out.lines().any(|l| l.starts_with("dest=")) {
                Ok(Some(d))
            } else {
                Err(format!("«{d}» не подходит для прикрытия: с сервера у него нет TLS 1.3 с HTTP/2"))
            }
        }
        Some(d) => Err(format!("«{d}» — не похоже на адрес сайта")),
    }
}

/// Самое быстрое с сервера прикрытие из `cands` (TLS 1.3 + h2), кроме `avoid`.
async fn pick_from(c: &Conn, log: &Log, cands: &[&str], avoid: &str) -> Result<String, String> {
    log("step", "Подбираю сайт-прикрытие (TLS 1.3 + h2, быстрее всех с сервера)".into());
    let list: Vec<&str> = cands.iter().copied().filter(|h| *h != avoid).collect();
    let o = c.sh(&[("CANDS", list.join(" "))], PICK_DEST, b"", 60).await?;
    let mut best: Vec<(u32, String)> = o
        .out
        .lines()
        .filter_map(|l| l.strip_prefix("dest="))
        .filter_map(|l| l.split_once(' ').and_then(|(h, ms)| Some((ms.trim().parse().ok()?, h.to_string()))))
        .collect();
    best.sort();
    let d = best.first().map(|(_, h)| h.clone()).unwrap_or_else(|| list.first().unwrap_or(&REALITY_DEST[0]).to_string());
    log("ok", format!("Прикрытие: {d}"));
    Ok(d)
}

/// Что ставить: протоколы, рекомендуемая защита; `runtime` — принудительно
/// docker/systemd (лаборатория: проверить путь без Docker).
struct Want {
    vless: bool,
    hy2: bool,
    awg: bool,
    xhttp: bool,
    mtproxy: bool,
    harden: bool,
    runtime: Option<String>,
    /// Сменить сайт-прикрытие VLESS и XHTTP: "auto" или адрес; нет — оставить.
    cover: Option<String>,
}

async fn install(id: &str, want: Want, log: &Log) -> Result<OpResult, String> {
    let (want_vless, want_hy2, want_awg) = (want.vless, want.hy2, want.awg);
    if !want_vless && !want_hy2 && !want_awg && !want.xhttp {
        return Err("Выберите хотя бы один протокол".into());
    }
    let mut st = load();
    let mut s = st.servers.iter().find(|x| x.id == id).cloned().ok_or("сервер не найден")?;
    let c = open(&st, &s, log).await?;
    let res = async {
        let f = inspect(&c).await?;
        log("ok", facts_line(&f));
        s.facts = Some(f.clone());
        let known = st.servers.clone();
        adopt_existing(&c, &mut s, &known, log).await?;
        if want_awg && f.arch != "x86_64" {
            return Err(format!("AmneziaWG пока только для x86_64, а здесь {} — снимите галочку AmneziaWG", f.arch));
        }
        if (want_awg || want.xhttp || want.mtproxy) && !f.docker {
            if !f.apt {
                return Err("Для AmneziaWG, XHTTP и MTProxy нужен Docker, а поставить его сам wpx умеет только на Debian/Ubuntu".into());
            }
            log("step", "Для AmneziaWG, XHTTP и MTProxy нужен Docker — ставлю пакет docker.io из репозитория системы".into());
            let o = c.sh(&[], INSTALL_DOCKER, b"", 600).await?;
            if !o.out.contains("DOCKER-OK") {
                return Err(format!("Docker не встал: {}", o.reason()));
            }
            log("ok", "Docker установлен".into());
        }
        if let Some(rt) = &want.runtime {
            s.runtime = rt.clone();
        }
        // sing-box нужен для VLESS/Hysteria2 и для труб каскада.
        let sb = want_vless || want_hy2 || !s.pipes.is_empty();
        if sb {
            ensure_runtime(&c, &mut s, log).await?;
        }

        let mut sec = secrets_of(&s)?;
        let pipe_ports: Vec<u16> = s.pipes.iter().map(|p| p.listen).collect();
        let cur = s.vless.as_ref().map(|v| v.dest.clone()).or_else(|| s.xhttp.as_ref().map(|x| x.dest.clone())).unwrap_or_default();
        let cover = new_cover(&c, log, want.cover.as_deref(), &cur).await?;
        if let Some(d) = &cover {
            log("ok", format!("Прикрытие: {d}"));
            if let Some(x) = s.xhttp.as_mut() {
                x.dest = d.clone();
            }
        }
        if want_vless {
            let dest = match (&cover, &s.vless) {
                (Some(d), _) => d.clone(),
                (None, Some(v)) => v.dest.clone(),
                (None, None) => pick_dest(&c, log).await?,
            };
            let port = match &s.vless {
                Some(v) => v.port,
                None => *PORTS_MAIN.iter().find(|&&p| free(&f.tcp, p) && !pipe_ports.contains(&p)).ok_or("нет свободного TCP-порта для VLESS")?,
            };
            if sec.uuid.is_empty() || sec.reality_private.is_empty() {
                sec.uuid = uuid4();
                sec.reality_private = reality_keypair().0;
            }
            let short_id = s.vless.as_ref().map(|v| v.short_id.clone()).filter(|x| !x.is_empty()).unwrap_or_else(|| hex(&rnd(8)));
            s.vless = Some(Vless { port, dest, public_key: reality_public(&sec.reality_private)?, short_id });
        } else {
            s.vless = None;
        }
        if want_hy2 {
            let port = match &s.hy2 {
                Some(h) => h.port,
                None => *PORTS_MAIN.iter().find(|&&p| free(&f.udp, p) && !pipe_ports.contains(&p)).ok_or("нет свободного UDP-порта для Hysteria2")?,
            };
            if sec.hy2_password.is_empty() {
                sec.hy2_password = hex(&rnd(16));
                sec.hy2_obfs = hex(&rnd(16));
            }
            let sni = s.hy2.as_ref().map(|h| h.sni.clone()).or_else(|| s.vless.as_ref().map(|v| v.dest.clone())).unwrap_or_else(|| REALITY_DEST[0].into());
            log("step", "Сертификат Hysteria2 (свой, закрепляется в профиле)".into());
            let mut env = rt_env(&s.runtime);
            env.push(("SNI", sni.clone()));
            let o = c.sh(&env, &format!("{SB_FUNCS}{HY2_CERT}"), b"", 60).await?;
            if o.code != 0 {
                return Err(format!("сертификат не создан: {}", o.reason()));
            }
            let hop = s.hy2.as_ref().and_then(|h| h.hop);
            s.hy2 = Some(Hy2 { port, sni, cert_sha256: cert_sha256(&o.out)?, hop });
        } else if let Some(h) = s.hy2.take() {
            if h.hop.is_some() {
                c.sh(&[], HOP_OFF, b"", 60).await?;
            }
        }
        if sb {
            deploy(&c, &s, &sec, log).await?;
        }
        if let Some(h) = s.hy2.as_mut() {
            // Диапазон в 1000 портов среди свободных; AWG и трубы туда не попадут.
            let taken: Vec<u16> = s.pipes.iter().map(|p| p.listen).chain(s.awg.iter().map(|a| a.port)).chain([h.port]).collect();
            let range = h.hop.or_else(|| {
                (0..64).map(|_| (rnd_in(200, 589) * 100) as u16).map(|lo| (lo, lo + 999))
                    .find(|&(lo, hi)| f.udp.iter().all(|(p, _)| *p < lo || *p > hi) && taken.iter().all(|p| *p < lo || *p > hi))
            });
            match range {
                Some((lo, hi)) => {
                    log("step", format!("Смена портов Hysteria2: UDP {lo}–{hi} → :{}", h.port));
                    let o = c.sh(&[("LO", lo.to_string()), ("HI", hi.to_string()), ("PORT", h.port.to_string())], HOP_APPLY, b"", 120).await?;
                    if o.out.contains("HOP-ON") {
                        h.hop = Some((lo, hi));
                        log("ok", "Клиент прыгает по портам — блокировка одного порта не рвёт связь".into());
                    } else {
                        h.hop = None;
                        log("warn", format!("Смена портов не включилась ({}) — Hysteria2 работает на одном порту", o.reason()));
                    }
                }
                None => log("warn", "Нет свободного диапазона для смены портов — Hysteria2 на одном порту".into()),
            }
        }
        if !sb && !s.runtime.is_empty() {
            log("step", "VLESS и Hysteria2 не нужны — останавливаю sing-box wpx".into());
            c.sh(&[], STOP_SB, b"", 60).await?;
            s.runtime.clear();
        }
        if want_awg {
            let taken: Vec<u16> = s.pipes.iter().map(|p| p.listen).chain(s.hy2.iter().map(|h| h.port)).collect();
            let port = match &s.awg {
                Some(a) => a.port,
                // Случайный высокий порт, как у AmneziaVPN: стандартный 51820 DPI знает.
                None => (0..64)
                    .map(|_| rnd_in(20000, 60000) as u16)
                    .find(|&p| free(&f.udp, p) && !taken.contains(&p) && !s.hy2.as_ref().and_then(|h| h.hop).is_some_and(|(lo, hi)| (lo..=hi).contains(&p)))
                    .ok_or("нет свободного UDP-порта для AmneziaWG")?,
            };
            if sec.awg_server_private.is_empty() {
                sec.awg_server_private = wg_keypair().0;
            }
            if sec.awg_client_private.is_empty() {
                sec.awg_client_private = wg_keypair().0;
            }
            if sec.awg_psk.is_empty() {
                sec.awg_psk = B64.encode(rnd(32));
            }
            let obf = s.awg.as_ref().map(|a| a.obf.clone()).filter(|o| !o.is_empty()).unwrap_or_else(awg_obf);
            let a = Awg { port, server_public: wg_public(&sec.awg_server_private)?, obf };
            deploy_awg(&c, &s, &a, &sec, log).await?;
            s.awg = Some(a);
        } else if let Some(a) = s.awg.take() {
            log("step", "Убираю AmneziaWG wpx".into());
            c.sh(&[("PORT", a.port.to_string())], REMOVE_AWG, b"", 60).await?;
        }
        let dest = match s.vless.as_ref().map(|v| v.dest.clone()).or_else(|| s.xhttp.as_ref().map(|x| x.dest.clone())).or_else(|| s.mtproxy.as_ref().map(|m| m.domain.clone())) {
            Some(d) => d,
            None if want.xhttp || want.mtproxy => pick_dest(&c, log).await?,
            None => String::new(),
        };
        extra::apply(&c, &mut s, &mut sec, &f, &dest, want.xhttp, want.mtproxy, log).await?;
        s.secrets_enc = enc(&serde_json::to_string(&sec).map_err(|e| e.to_string())?)?;
        // Порты могли смениться — файрвол открывает новые.
        if s.fw.is_some() {
            fw::apply(&st, &c, &s, log).await?;
        }
        heal::install(&c, log).await;
        if want.harden {
            let (bbr, upd, f2b) = (f.bbr_avail && f.cc != "bbr", f.apt && !f.autoupd, f.apt && !f.f2b);
            if bbr || upd || f2b {
                harden_on(&c, bbr, upd, f2b, log).await;
            } else {
                log("ok", "Защита сервера уже включена: BBR, автообновления, fail2ban".into());
            }
        }
        // Сведения для «Обслуживания» — уже после установки (версии ядер, порты).
        if let Ok(f) = inspect(&c).await {
            s.facts = Some(f);
        }
        Ok::<Secrets, String>(sec)
    }
    .await;
    c.close().await;
    let sec = res?;
    if let Some(x) = st.servers.iter_mut().find(|x| x.id == id) {
        *x = s.clone();
    }
    save(&st)?;

    let (pid, probe, note) = own_profile(&s, &sec, log).await?;
    Ok(OpResult { state: state(&st), probe, profile: pid, note })
}

/// Профиль сервера на этом ПК: точки проверяются с ПК и встают по рангу.
async fn own_profile(s: &Server, sec: &Secrets, log: &Log) -> Result<(Option<String>, Vec<ProbeResult>, Option<String>), String> {
    let eps = endpoints(s, sec, &s.host, Ports::of(s), &s.name, None);
    if eps.is_empty() {
        return Ok((None, vec![], None));
    }
    if s.via.is_some() {
        return Ok((None, vec![], Some(format!("С этого ПК «{}» доступен только через посредника — его профиль на этом ПК — каскад с выходом «{}».", s.name, s.name))));
    }
    let (eps, probe) = rank_endpoints(eps, log).await;
    let note = (!probe.is_empty() && probe.iter().all(|x| x.ok == 0))
        .then(|| format!("С этого ПК сервер не ответил. Если на роутере kill switch — разрешите {} (TCP и UDP).", s.host));
    let mut ps = profiles::load();
    let pid = profiles::upsert_origin(&mut ps, &format!("server:{}", s.id), &s.name, &eps, "fallback")?;
    profiles::save(&ps)?;
    log("ok", format!("Профиль «{}» готов — его можно сделать рабочим на вкладке «Профили»", s.name));
    Ok((Some(pid), probe, note))
}

/// Профили этого ПК из уже настроенного сервера (добавлен с другого ПК или
/// профиль удалили): свой профиль и маршруты каскадов, где он вход или выход.
/// Ключи wpx прочитал при добавлении — сервер не трогаем.
async fn local_profiles(st: &Store, s: &Server, log: &Log) -> Result<(Option<String>, Vec<ProbeResult>, Option<String>), String> {
    let sec = secrets_of(s)?;
    let (pid, mut probe, mut note) = own_profile(s, &sec, log).await?;
    if s.awg.is_some() && sec.awg_client_private.is_empty() {
        let awg = "AmneziaWG в профиль не вошёл: у каждого устройства свой ключ, а для этого ПК его на сервере нет. Нужен — «Поделиться» → AmneziaWG, конфиг добавьте как профиль.".to_string();
        log("warn", awg.clone());
        note = Some(note.map_or(awg.clone(), |n| format!("{n} {awg}")));
    }
    // Выходы, к которым ведут трубы: сам сервер и те, куда ведут его трубы.
    let mut exits: Vec<&str> = vec![s.id.as_str()];
    exits.extend(s.pipes.iter().map(|p| p.to.as_str()).filter(|t| !t.is_empty()));
    exits.dedup();
    let mut route = None;
    for id in exits {
        let Some(x) = st.servers.iter().find(|x| x.id == id) else { continue };
        if st.servers.iter().any(|e| e.pipes.iter().any(|p| p.to == x.id)) {
            let (r, p) = rebuild_route(st, x, Some(log)).await?;
            probe.extend(p);
            route = route.or(r);
        }
    }
    Ok((pid.or(route), probe, note))
}

/// «Профиль на этом ПК» на карточке сервера.
#[tauri::command]
pub async fn server_profile(app: AppHandle, id: String) -> Result<OpResult, String> {
    let _g = BUSY.try_lock().map_err(|_| "Уже идёт операция с сервером")?;
    let log = logger(&app);
    let r = async {
        let st = load();
        let s = st.servers.iter().find(|x| x.id == id).ok_or("сервер не найден")?;
        let (pid, probe, note) = local_profiles(&st, s, &log).await?;
        if pid.is_none() {
            return Err(match note {
                Some(n) if s.via.is_some() => format!("{n} Сделайте его: «Каскад» вверху страницы."),
                _ => "На сервере нет VPN от wpx — сначала «Установить VPN»".to_string(),
            });
        }
        Ok(OpResult { state: state(&st), probe, profile: pid, note })
    }
    .await;
    if let Err(e) = &r {
        log("fail", e.clone());
    }
    r
}

#[tauri::command]
pub async fn server_cascade(app: AppHandle, entry: String, exit: String, via: Option<String>) -> Result<OpResult, String> {
    let _g = BUSY.try_lock().map_err(|_| "Уже идёт операция с сервером")?;
    let log = logger(&app);
    let r = cascade(&entry, &exit, via.as_deref().filter(|v| !v.is_empty()), &log).await;
    if let Err(e) = &r {
        log("fail", e.clone());
    }
    r
}

/// Каскад: вход — «тупая труба» (пересылает TCP+UDP на выход,
/// ключей не знает), шифрованный туннель идёт от ПК прямо до выхода.
/// `via` — цепочка ПК → вход → промежуточный → выход: вход пересылает на
/// трубы промежуточного, тот — на выход; ключей не знает ни один из них.
async fn cascade(entry_id: &str, exit_id: &str, via: Option<&str>, log: &Log) -> Result<OpResult, String> {
    if entry_id == exit_id {
        return Err("Вход и выход — один и тот же сервер".into());
    }
    if let Some(m) = via {
        if m == entry_id || m == exit_id {
            return Err("Промежуточный сервер должен отличаться от входа и выхода".into());
        }
        // Своя труба промежуточного на выход — нужна до цепочки.
        let ready = load().servers.iter().find(|s| s.id == m).is_some_and(|s| s.pipes.iter().any(|p| p.to == exit_id && p.hop.is_none()));
        if !ready {
            log("step", "Сначала труба промежуточного сервера на выход".into());
            Box::pin(cascade(m, exit_id, None, log)).await?;
        }
    }
    let mut st = load();
    let x = st.servers.iter().find(|s| s.id == exit_id).cloned().ok_or("сервер-выход не найден")?;
    let mut e = st.servers.iter().find(|s| s.id == entry_id).cloned().ok_or("сервер-вход не найден")?;
    if x.vless.is_none() && x.hy2.is_none() && x.awg.is_none() {
        return Err(format!("На «{}» ещё не установлен VPN — сначала «Установить VPN»", x.name));
    }
    // Куда пересылает труба входа: на промежуточный или сразу на выход —
    // (порт там, порт на самом выходе).
    let mid = match via {
        Some(m) => Some(st.servers.iter().find(|s| s.id == m).cloned().ok_or("промежуточный сервер не найден")?),
        None => None,
    };
    let target = mid.as_ref().unwrap_or(&x);
    let ports: Vec<(u16, u16)> = match &mid {
        Some(m) => m.pipes.iter().filter(|p| p.to == x.id && p.hop.is_none()).map(|p| (p.listen, p.to_port)).collect(),
        None => {
            let o = Ports::of(&x);
            let mut t: Vec<u16> = [o.vless, o.hy2, o.awg].into_iter().flatten().collect();
            t.sort();
            t.dedup();
            t.into_iter().map(|p| (p, p)).collect()
        }
    };
    if ports.is_empty() {
        return Err("У промежуточного сервера нет труб на выход".into());
    }
    let c = open(&st, &e, log).await?;
    let to_addr = match path::choose(&c, &e, target, log).await {
        Ok(a) => a,
        // Напрямую не держится, а промежуточный не задан — wpx ищет его среди своих серверов.
        Err(why) if via.is_none() => {
            log("warn", why.clone());
            log("step", "Ищу промежуточный среди ваших серверов".into());
            let m = path::middle(&st, &c, &e, &x, log).await;
            c.close().await;
            let Some(m) = m else {
                return Err(format!("{why} Ни через один ваш сервер путь до «{}» тоже не держится — похоже на блокировку у его провайдера: напишите хостеру или переезжайте на другой VPS.", x.name));
            };
            log("ok", format!("Каскад пойдёт так: ПК → «{}» → «{}» → «{}»", e.name, m.name, x.name));
            return Box::pin(cascade(entry_id, exit_id, Some(m.id.as_str()), log)).await;
        }
        Err(why) => {
            c.close().await;
            return Err(why);
        }
    };
    let targets: Vec<(String, u16, u16)> = ports.into_iter().map(|(to, fin)| (to_addr.clone(), to, fin)).collect();
    let res = async {
        let f = inspect(&c).await?;
        s_facts(&mut e, f.clone(), log);
        let known = st.servers.clone();
        adopt_existing(&c, &mut e, &known, log).await?;
        ensure_runtime(&c, &mut e, log).await?;
        // Свои занятые порты входа: его VPN и уже существующие трубы.
        let mut taken: Vec<u16> = e.vless.iter().map(|v| v.port).chain(e.hy2.iter().map(|h| h.port)).chain(e.awg.iter().map(|a| a.port)).collect();
        taken.extend(e.pipes.iter().filter(|p| p.to != x.id).map(|p| p.listen));
        let mut pipes = vec![];
        let hop = via.map(String::from);
        for (to_host, to_port, fin) in &targets {
            if let Some(p) = e.pipes.iter().find(|p| p.to == x.id && p.final_port() == *fin && p.hop == hop && &p.to_host == to_host) {
                pipes.push(p.clone());
                taken.push(p.listen);
                continue;
            }
            let listen = *PORTS_PIPE
                .iter()
                .find(|&&p| !taken.contains(&p) && free(&f.tcp, p) && free(&f.udp, p))
                .ok_or("на входе нет свободного порта для трубы")?;
            taken.push(listen);
            pipes.push(Pipe { to: x.id.clone(), to_host: to_host.clone(), listen, to_port: *to_port, hop: hop.clone(), exit_port: hop.as_ref().map(|_| *fin) });
        }
        e.pipes.retain(|p| p.to != x.id);
        e.pipes.extend(pipes.iter().cloned());
        log("step", format!(
            "Труба на «{}»: {} → {}{} (без ключей шифрования)",
            e.name,
            pipes.iter().map(|p| format!(":{}", p.listen)).collect::<Vec<_>>().join(", "),
            mid.as_ref().map(|m| format!("{} → ", m.host)).unwrap_or_default(),
            x.host
        ));
        let esec = secrets_of(&e)?;
        deploy(&c, &e, &esec, log).await?;
        if e.fw.is_some() {
            fw::apply(&st, &c, &e, log).await?;
        }
        heal::install(&c, log).await;
        // Сведения для «Обслуживания» — уже с трубой (sing-box, порты).
        if let Ok(f) = inspect(&c).await {
            e.facts = Some(f);
        }
        Ok::<Vec<Pipe>, String>(pipes)
    }
    .await;
    c.close().await;
    res?;
    if let Some(s) = st.servers.iter_mut().find(|s| s.id == e.id) {
        *s = e.clone();
    }
    save(&st)?;
    // AmneziaWG через вход — своим ключом пути (пир на выходе, без перезапуска).
    if x.awg.is_some() {
        if let Err(err) = guests::path_key(&x.id, &e.id, log).await {
            log("warn", format!("AmneziaWG через «{}»: ключ пути на «{}» не добавлен ({err}) — путь пойдёт без AmneziaWG", e.name, x.name));
        }
    }
    let st = load();
    let x = st.servers.iter().find(|s| s.id == exit_id).cloned().ok_or("сервер-выход не найден")?;

    let (pid, probe) = rebuild_route(&st, &x, Some(log)).await?;
    let new_ok = probe.iter().any(|r| r.ok > 0 && r.label.starts_with(&format!("{} → ", e.name)));
    let note = (!probe.is_empty() && !new_ok)
        .then(|| format!("Через «{}» выход не ответил. Проверьте, что роутер пускает {} (TCP и UDP) и что выход работает.", e.name, e.host));
    Ok(OpResult { state: state(&st), probe, profile: pid, note })
}

/// Маршрут к выходу: один профиль со всеми путями — трубы на любых входах
/// и прямой путь (если выход достижим с ПК). Движок держит самый быстрый
/// живой путь (url-test) и сам уходит на другой, если вход упал.
/// `log` — проверить пути в песочнице и расставить по рангу.
async fn rebuild_route(st: &Store, x: &Server, log: Option<&Log>) -> Result<(Option<String>, Vec<ProbeResult>), String> {
    let xsec = secrets_of(x)?;
    let origin = format!("route:{}", x.id);
    let mut via_pipes = vec![];
    for e in st.servers.iter().filter(|e| e.id != x.id) {
        let pipes: Vec<Pipe> = e.pipes.iter().filter(|p| p.to == x.id).cloned().collect();
        if !pipes.is_empty() {
            let hop = pipes[0].hop.as_deref().and_then(|h| st.servers.iter().find(|s| s.id == h)).map(|m| format!("{} → ", m.name)).unwrap_or_default();
            via_pipes.extend(endpoints(x, &xsec, &e.host, Ports::via(x, &pipes), &format!("{} → {hop}{}", e.name, x.name), Some(&e.id)));
            // Каскад до своих ключей путей: AmneziaWG через вход пропущен — сказать как вернуть.
            let no_key = x.awg.is_some() && Ports::via(x, &pipes).awg.is_some() && !x.awg_paths.iter().any(|p| p.via == e.id);
            if let (true, Some(l)) = (no_key, log) {
                l("warn", format!("AmneziaWG через «{}» не вошёл: нужен свой ключ пути — запустите «Каскад» {} → {} ещё раз (труба останется, на «{}» добавится только ключ)", e.name, e.name, x.name, x.name));
            }
        }
    }
    let mut ps = profiles::load();
    let active = ps.active.clone().unwrap_or_default();
    if via_pipes.is_empty() {
        if let Some(p) = ps.profiles.iter().find(|p| p.origin == origin && p.id == active) {
            return Err(format!("Профиль «{}» сейчас в работе — {}", p.name, profiles::BUSY_HINT));
        }
        if let Some(p) = ps.profiles.iter().find(|p| p.origin == origin) {
            let users = profiles::used_by_cascades(&ps, &p.id);
            if !users.is_empty() {
                return Err(format!("Профиль «{}» входит в {} — сначала уберите его оттуда", p.name, users.join(", ")));
            }
        }
        ps.profiles.retain(|p| p.origin != origin);
        profiles::save(&ps)?;
        return Ok((None, vec![]));
    }
    let (mut eps, probe) = match log {
        Some(l) => rank_endpoints(via_pipes, l).await,
        None => (via_pipes, vec![]),
    };
    if x.via.is_none() {
        eps.extend(endpoints(x, &xsec, &x.host, Ports::of(x), &format!("{} напрямую", x.name), None));
    }
    let pid = profiles::upsert_origin(&mut ps, &origin, &format!("{} через каскад", x.name), &eps, "auto")?;
    profiles::save(&ps)?;
    if let Some(l) = log {
        l("ok", format!("Маршрут к «{}»: {} точек, движок выберет быстрый живой путь", x.name, eps.len()));
    }
    Ok((Some(pid), probe))
}

fn s_facts(s: &mut Server, f: Facts, log: &Log) {
    log("ok", facts_line(&f));
    s.facts = Some(f);
}

/// Убрать трубу входа на выход (и профиль каскада, если он не рабочий).
#[tauri::command]
pub async fn server_cascade_remove(app: AppHandle, entry: String, exit: String) -> Result<ServersState, String> {
    let _g = BUSY.try_lock().map_err(|_| "Уже идёт операция с сервером")?;
    let log = logger(&app);
    let r = cascade_remove(entry, exit, &log).await;
    if let Err(e) = &r {
        log("fail", e.clone());
    }
    r
}

async fn cascade_remove(entry: String, exit: String, log: &Log) -> Result<ServersState, String> {
    let log = log.clone();
    let r: Result<ServersState, String> = async {
        let mut st = load();
        // Последний путь к выходу нельзя убрать, пока его маршрут в работе.
        let paths = st.servers.iter().filter(|s| s.pipes.iter().any(|p| p.to == exit)).count();
        let ps = profiles::load();
        if let Some(p) = ps.profiles.iter().find(|p| p.origin == format!("route:{exit}")) {
            if paths <= 1 && ps.active.as_deref() == Some(&p.id) {
                return Err(format!("Профиль «{}» сейчас в работе, а это его последний путь — {}", p.name, profiles::BUSY_HINT));
            }
            let users = profiles::used_by_cascades(&ps, &p.id);
            if paths <= 1 && !users.is_empty() {
                return Err(format!("Профиль «{}» входит в {} — сначала уберите его оттуда", p.name, users.join(", ")));
            }
        }
        if let Some(a) = st.servers.iter().find(|a| a.pipes.iter().any(|p| p.to == exit && p.hop.as_deref() == Some(entry.as_str()))) {
            return Err(format!("Через этот путь идёт цепочка с входом «{}» — сначала уберите её", a.name));
        }
        let mut e = st.servers.iter().find(|s| s.id == entry).cloned().ok_or("сервер-вход не найден")?;
        e.pipes.retain(|p| p.to != exit);
        let c = open(&st, &e, &log).await?;
        let r = if e.vless.is_none() && e.hy2.is_none() && e.pipes.is_empty() {
            log("step", "На входе sing-box больше не нужен — останавливаю".into());
            if e.awg.is_some() {
                c.sh(&[], STOP_SB, b"", 60).await.map(|_| ())
            } else {
                c.sh(&[("TCP", String::new()), ("UDP", String::new())], UNINSTALL, b"", 120).await.map(|_| ())
            }
        } else {
            match secrets_of(&e) {
                Ok(sec) => deploy(&c, &e, &sec, &log).await,
                Err(err) => Err(err),
            }
        };
        c.close().await;
        r?;
        if e.vless.is_none() && e.hy2.is_none() && e.pipes.is_empty() {
            e.runtime.clear();
        }
        if let Some(s) = st.servers.iter_mut().find(|s| s.id == entry) {
            *s = e;
        }
        save(&st)?;
        if let Some(x) = st.servers.iter().find(|s| s.id == exit) {
            rebuild_route(&st, x, None).await?;
        }
        log("ok", "Путь убран".into());
        Ok(state(&st))
    }
    .await;
    r
}

/// Убрать с сервера всё, что ставил wpx (`/opt/wpx`, контейнер/служба).
#[tauri::command]
pub async fn server_uninstall(app: AppHandle, id: String) -> Result<ServersState, String> {
    let _g = BUSY.try_lock().map_err(|_| "Уже идёт операция с сервером")?;
    let log = logger(&app);
    let s = load().servers.into_iter().find(|x| x.id == id).ok_or("сервер не найден")?;
    let r = uninstall(&s, &log).await;
    if let Err(e) = &r {
        log("fail", e.clone());
    }
    r
}

async fn uninstall(s: &Server, log: &Log) -> Result<ServersState, String> {
    let id = s.id.clone();
    let log = log.clone();
    let r: Result<ServersState, String> = async {
        let mut st = load();
        if let Some(e) = st.servers.iter().find(|e| e.pipes.iter().any(|p| p.to == id)) {
            return Err(format!("«{}» — выход каскада с входом «{}». Сначала уберите каскад", s.name, e.name));
        }
        if let Some(e) = st.servers.iter().find(|e| e.pipes.iter().any(|p| p.hop.as_deref() == Some(id.as_str()))) {
            return Err(format!("Через «{}» идёт цепочка с входом «{}». Сначала уберите её", s.name, e.name));
        }
        let mut ps = profiles::load();
        let mine = |o: &str| o == format!("server:{id}");
        if let Some(p) = ps.profiles.iter().find(|p| mine(&p.origin) && ps.active.as_deref() == Some(&p.id)) {
            return Err(format!("Профиль «{}» сейчас в работе — {}", p.name, profiles::BUSY_HINT));
        }
        for p in ps.profiles.iter().filter(|p| mine(&p.origin)) {
            let users = profiles::used_by_cascades(&ps, &p.id);
            if !users.is_empty() {
                return Err(format!("Профиль «{}» этого сервера входит в {} — сначала уберите его оттуда", p.name, users.join(", ")));
            }
        }
        let c = open(&st, s, &log).await?;
        let (tcp, mut udp) = our_ports(s);
        udp.extend(s.awg.iter().map(|a| a.port));
        let list = |v: &[u16]| v.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(" ");
        log("step", "Удаляю sing-box и /opt/wpx (чужое не трогаю)".into());
        let o = c.sh(&[("TCP", list(&tcp)), ("UDP", list(&udp))], UNINSTALL, b"", 120).await;
        c.close().await;
        let o = o?;
        if !o.out.contains("UNINSTALL-OK") {
            return Err(o.reason());
        }
        if let Some(x) = st.servers.iter_mut().find(|x| x.id == id) {
            x.runtime.clear();
            x.vless = None;
            x.hy2 = None;
            x.awg = None;
            x.xhttp = None;
            x.mtproxy = None;
            x.pipes.clear();
            x.guests.clear();
            x.fw = None;
            x.secrets_enc.clear();
            if let Some(f) = x.facts.as_mut() {
                f.wpx = false;
            }
        }
        save(&st)?;
        ps.profiles.retain(|p| !mine(&p.origin));
        profiles::save(&ps)?;
        for x in st.servers.iter().filter(|x| s.pipes.iter().any(|p| p.to == x.id)) {
            rebuild_route(&st, x, None).await?;
        }
        log("ok", "С сервера убрано всё, что ставил wpx".into());
        Ok(state(&st))
    }
    .await;
    r
}

/// Забыть сервер: убрать ключ wpx с сервера и запись в wpx. Установленное
/// на сервере остаётся работать (профили тоже).
#[tauri::command]
pub async fn server_forget(app: AppHandle, id: String) -> Result<ServersState, String> {
    let _g = BUSY.try_lock().map_err(|_| "Уже идёт операция с сервером")?;
    let log = logger(&app);
    let r = forget(&id, &log).await;
    if let Err(e) = &r {
        log("fail", e.clone());
    }
    r
}

async fn forget(id: &str, log: &Log) -> Result<ServersState, String> {
    let mut st = load();
    let s = st.servers.iter().find(|x| x.id == id).cloned().ok_or("сервер не найден")?;
    if let Some(o) = st.servers.iter().find(|o| o.via.as_deref() == Some(id)) {
        return Err(format!("Через «{}» wpx ходит на «{}» — сначала забудьте его", s.name, o.name));
    }
    if let Some(e) = st.servers.iter().find(|e| e.pipes.iter().any(|p| p.to == id)) {
        return Err(format!("«{}» — выход каскада с входом «{}». Сначала уберите каскад", s.name, e.name));
    }
    if let Some(e) = st.servers.iter().find(|e| e.pipes.iter().any(|p| p.hop.as_deref() == Some(id))) {
        return Err(format!("Через «{}» идёт цепочка с входом «{}». Сначала уберите её", s.name, e.name));
    }
    match open(&st, &s, log).await {
        Ok(c) => {
            let line = key_of(&s).and_then(|k| ssh::public_line(&k)).unwrap_or_default();
            let _ = c
                .s
                .run(
                    "k=$(cat | tr -d '\\r'); f=~/.ssh/authorized_keys; [ -f \"$f\" ] && grep -vxF \"$k\" \"$f\" > \"$f.wpx\"; cat \"$f.wpx\" > \"$f\" && rm -f \"$f.wpx\"",
                    format!("{line}\n").as_bytes(),
                    Duration::from_secs(20),
                )
                .await;
            c.close().await;
            log("ok", "Ключ wpx убран с сервера".into());
        }
        Err(e) => log("warn", format!("Не достучался, ключ wpx остался на сервере: {e}")),
    }
    st.servers.retain(|x| x.id != id);
    save(&st)?;
    Ok(state(&st))
}

// ─── Консоль (лаборатория) ───────────────────────────────────────

/// `wpx --server list | add <ip> --key <файл> [--via <сервер>] [--name <имя>]
/// | inspect <сервер> | install <сервер> [--no-vless] [--no-hy2]
/// | cascade <вход> <выход> | uncascade <вход> <выход>` — те же операции,
/// что кнопки окна; ход печатается в консоль.
pub fn cli(args: &[String]) {
    let log: Log = Arc::new(|kind, text| {
        let mk = match kind { "ok" => "✓", "warn" => "!", "fail" => "✗", _ => "›" };
        println!("{mk} {text}");
    });
    let opt = |k: &str| args.iter().position(|a| a == k).and_then(|i| args.get(i + 1).cloned());
    let flag = |k: &str| args.iter().any(|a| a == k);
    let find = |key: &str| -> Result<String, String> {
        load().servers.iter().find(|s| s.id == key || s.name == key || s.host == key).map(|s| s.id.clone()).ok_or(format!("нет сервера «{key}»"))
    };
    let arg = |i: usize| args.get(i).cloned().unwrap_or_default();
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("tokio");
    let res: Result<String, String> = rt.block_on(async {
        match arg(0).as_str() {
            "list" => Ok(serde_json::to_string_pretty(&state(&load())).unwrap_or_default()),
            "fingerprint" => server_fingerprint(arg(1), None, opt("--via")).await.map(|k| format!("{} через {}", k.fingerprint, k.via.as_deref().unwrap_or("—"))),
            "add" => {
                let via = match opt("--via") { Some(v) => Some(find(&v)?), None => None };
                let input = ServerInput { name: opt("--name").unwrap_or_default(), host: arg(1), port: None, user: "root".into(), password: None, key_path: opt("--key"), via, fingerprint: opt("--fingerprint") };
                add(input, &log).await.map(|_| "добавлен".into())
            }
            "inspect" => {
                let id = find(&arg(1))?;
                let st = load();
                let s = st.servers.iter().find(|x| x.id == id).ok_or("нет")?;
                let c = open(&st, s, &log).await?;
                let f = inspect(&c).await;
                c.close().await;
                let f = f?;
                Ok(format!(
                    "{}\nаптайм {} ч · нагрузка {} · трафик ↓{} ↑{} МБ · TCP {} (BBR {}) · автообновления {} · fail2ban {} · обновлений {} (безопасности {}){} · sing-box {}",
                    facts_line(&f), f.uptime_s / 3600, f.load, f.net_rx / 1_000_000, f.net_tx / 1_000_000, f.cc,
                    if f.bbr_avail { "есть" } else { "нет" }, if f.autoupd { "да" } else { "нет" }, if f.f2b { "да" } else { "нет" },
                    f.updates, f.sec_updates, if f.reboot { " · нужна перезагрузка" } else { "" }, f.sb_ver
                ))
            }
            "harden" => harden(&find(&arg(1))?, !flag("--no-bbr"), !flag("--no-autoupd"), !flag("--no-f2b"), &log).await.map(|_| "готово".into()),
            "install" => install(&find(&arg(1))?, Want { vless: !flag("--no-vless"), hy2: !flag("--no-hy2"), awg: !flag("--no-awg"), xhttp: flag("--xhttp"), mtproxy: flag("--mtproxy"), harden: !flag("--no-harden"), runtime: opt("--runtime"), cover: opt("--cover") }, &log).await.map(|r| format!("профиль {:?} {}", r.profile, r.note.unwrap_or_default())),
            "cascade" => cascade(&find(&arg(1))?, &find(&arg(2))?, opt("--via").map(|v| find(&v)).transpose()?.as_deref(), &log).await.map(|r| format!("профиль {:?} {}", r.profile, r.note.unwrap_or_default())),
            "uncascade" => cascade_remove(find(&arg(1))?, find(&arg(2))?, &log).await.map(|_| "путь убран".into()),
            "uninstall" => {
                let id = find(&arg(1))?;
                let st = load();
                let s = st.servers.iter().find(|x| x.id == id).cloned().ok_or("нет")?;
                uninstall(&s, &log).await.map(|_| "убрано".into())
            }
            "forget" => {
                let id = find(&arg(1))?;
                forget(&id, &log).await.map(|_| "забыт".into())
            }
            "guests" | "share" | "unshare" | "guest-off" | "guest-on" => guests::cli(args, &log).await,
            "firewall" => fw::cli(args, &log).await,
            "update" => update::run(&find(&arg(1))?, flag("--break"), &log).await.map(|_| "готово".into()),
            "check" => {
                let id = find(&arg(1))?;
                check::run(&id).await.map(|r| {
                    let mk = |v: &str| match v { "ok" => "✓", "bad" => "✗", "warn" => "!", _ => "·" };
                    let mut t = format!("{} {}", mk(r.verdict), r.summary);
                    for s in &r.steps {
                        t.push_str(&format!("\n  {} {} — {}", mk(s.verdict), s.title, s.detail));
                    }
                    for a in &r.advice {
                        t.push_str(&format!("\n  → {}", a.text));
                    }
                    t
                })
            }
            _ => Err("wpx --server list|fingerprint|add|inspect|install|harden|cascade|uncascade|uninstall|forget|guests|share|unshare …".into()),
        }
    });
    match res {
        Ok(s) => println!("{s}"),
        Err(e) => println!("ОШИБКА: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn srv() -> (Server, Secrets) {
        let (private, public) = reality_keypair();
        let s = Server {
            id: "s1".into(),
            name: "Хельсинки".into(),
            host: "198.51.100.20".into(),
            vless: Some(Vless { port: 443, dest: "www.apple.com".into(), public_key: public, short_id: "0123456789abcdef".into() }),
            hy2: Some(Hy2 { port: 443, sni: "www.apple.com".into(), cert_sha256: "ab".repeat(32), hop: Some((20000, 20999)) }),
            ..Default::default()
        };
        let sec = Secrets { uuid: uuid4(), reality_private: private, hy2_password: "pw".into(), hy2_obfs: "ob".into(), ..Default::default() };
        (s, sec)
    }

    #[test]
    fn awg_configs_and_adopt() {
        let (mut s, mut sec) = srv();
        sec.awg_server_private = wg_keypair().0;
        sec.awg_client_private = wg_keypair().0;
        sec.awg_psk = B64.encode(rnd(32));
        let obf = awg_obf();
        let get = |k: &str| obf.iter().find(|(a, _)| a == k).unwrap().1.parse::<u32>().unwrap();
        assert!(get("Jmin") < get("Jmax") && get("S1") + 56 != get("S2") && get("H1") > 4);
        let sizes = [148 + get("S1"), 92 + get("S2"), 64 + get("S3"), 32 + get("S4")];
        assert!((0..4).all(|i| (i + 1..4).all(|j| sizes[i] != sizes[j])));
        let i1 = &obf.iter().find(|(a, _)| a == "I1").unwrap().1;
        assert!(i1.starts_with("<r 2><b 0x0100000100") && i1.ends_with("0000010001>"));
        let a = Awg { port: 34567, server_public: wg_public(&sec.awg_server_private).unwrap(), obf: obf.clone() };
        s.awg = Some(a.clone());
        let conf = awg_server_conf(&s, &a, &sec).unwrap();
        assert!(conf.contains("ListenPort = 34567") && conf.contains("MASQUERADE") && conf.contains(&format!("AllowedIPs = {AWG_NET}.2/32")));
        // Сервер подхватывается обратно; ключ клиента — только с ПК.
        let mut back = Secrets::default();
        assert_eq!(adopt_awg(&conf, &mut back), Some(a.clone()));
        assert_eq!((back.awg_server_private.as_str(), back.awg_psk.as_str()), (sec.awg_server_private.as_str(), sec.awg_psk.as_str()));
        assert!(back.awg_client_private.is_empty());
        // Клиент: тот же разбор, что у импортированного .conf.
        let piped = Ports { awg: Some(20443), ..Default::default() };
        // Через вход без ключа пути — без AWG (ключ владельца выбивал бы прямой путь).
        assert!(endpoints(&s, &sec, "203.0.113.10", piped, "SG → FI", Some("e1")).is_empty());
        s.awg_paths.push(AwgPath { via: "e1".into(), ip: free_awg_ip(&s).unwrap() });
        sec.awg_paths.push(AwgPathKey { via: "e1".into(), private: wg_keypair().0 });
        assert_eq!(free_awg_ip(&s).unwrap(), 4, "адрес пути занят");
        let conf = awg_server_conf(&s, &a, &sec).unwrap();
        assert!(conf.contains(&format!("AllowedIPs = {AWG_NET}.3/32")) && conf.contains(&wg_public(&sec.awg_paths[0].private).unwrap()));
        let eps = endpoints(&s, &sec, "203.0.113.10", piped, "SG → FI", Some("e1"));
        assert_eq!(eps.len(), 1);
        let e = &eps[0];
        assert_eq!((e.kind, e.server.as_str(), e.port), (proto::Kind::Awg, "203.0.113.10", 20443));
        // Свой ключ и адрес у пути — не те, что у подключения напрямую.
        let direct = endpoints(&s, &sec, &s.host, Ports { awg: Some(34567), ..Default::default() }, "FI", None);
        assert_ne!(direct[0].secrets["private-key"], e.secrets["private-key"]);
        assert_eq!((direct[0].params["ip"].as_str(), e.params["ip"].as_str()), (Some(format!("{AWG_NET}.2").as_str()), Some(format!("{AWG_NET}.3").as_str())));
        // Через вход — пакеты поменьше (иначе дробятся на пути вход → выход).
        assert_eq!((direct[0].params.get("mtu"), e.params["mtu"].as_u64()), (None, Some(u64::from(AWG_MTU_VIA))));
        assert_eq!(e.params["public-key"], json!(a.server_public));
        assert_eq!(e.params["amnezia-wg-option"]["jc"], json!(get("Jc")));
        assert_eq!(e.label, "SG → FI · AmneziaWG");
    }

    #[test]
    fn reality_public_matches_private() {
        let (private, public) = reality_keypair();
        assert_eq!(reality_public(&private).unwrap(), public);
        assert_eq!(public.len(), 43);
        let u = uuid4();
        assert_eq!(u.len(), 36);
        assert_eq!(&u[14..15], "4");
    }

    #[test]
    fn config_and_adopt_roundtrip() {
        let (mut s, sec) = srv();
        s.pipes.push(Pipe { to: "s2".into(), to_host: "1.2.3.4".into(), listen: 8443, to_port: 443, ..Default::default() });
        let cfg = singbox_config(&s, &sec);
        assert_eq!(cfg["inbounds"].as_array().unwrap().len(), 3);
        assert_eq!(cfg["inbounds"][2]["override_address"], "1.2.3.4");
        let pem = "-----BEGIN CERTIFICATE-----\nAAEC\n-----END CERTIFICATE-----\n";
        let known = vec![Server { id: "s2".into(), host: "1.2.3.4".into(), ..Default::default() }];
        let mut back = Server { id: "s1".into(), ..Default::default() };
        let got = adopt(&mut back, &cfg, pem, "docker", &known).unwrap();
        assert_eq!(got.uuid, sec.uuid);
        assert_eq!(got.reality_private, sec.reality_private);
        assert_eq!(back.vless, s.vless);
        assert_eq!(back.pipes, s.pipes);
        assert_eq!(back.hy2.unwrap().cert_sha256, hex(&Sha256::digest([0u8, 1, 2])));
        assert_eq!(back.runtime, "docker");
    }

    /// `WPX_SB_OUT=<файл> cargo test dump_singbox -- --ignored` — конфиг sing-box
    /// для `sing-box check` (той же версией, что на сервере).
    #[test]
    #[ignore]
    fn dump_singbox() {
        let (mut s, sec) = srv();
        s.pipes.push(Pipe { to: "s2".into(), to_host: "1.2.3.4".into(), listen: 8443, to_port: 443, ..Default::default() });
        let out = std::env::var("WPX_SB_OUT").expect("WPX_SB_OUT");
        std::fs::write(out, serde_json::to_vec_pretty(&singbox_config(&s, &sec)).unwrap()).unwrap();
    }

    #[test]
    fn endpoints_from_server_and_via_pipe() {
        let (s, sec) = srv();
        let direct = endpoints(&s, &sec, &s.host, Ports::of(&s), &s.name, None);
        assert_eq!(direct.len(), 2);
        assert_eq!(direct[0].kind, proto::Kind::Vless);
        assert_eq!(direct[0].params["reality-opts"]["public-key"], json!(s.vless.as_ref().unwrap().public_key));
        assert_eq!(direct[1].params["fingerprint"], json!("ab".repeat(32)));
        assert_eq!(direct[1].secrets["obfs-password"], json!("ob"));
        let pipes = [Pipe { to: "s1".into(), to_host: s.host.clone(), listen: 8443, to_port: 443, ..Default::default() }];
        let piped = endpoints(&s, &sec, "203.0.113.10", Ports::via(&s, &pipes), "SG → FI", Some("e1"));
        assert_eq!((piped[0].server.as_str(), piped[0].port), ("203.0.113.10", 8443));
        assert!(piped[0].label.contains("SG → FI"));
        // Цепочка: вход шлёт на трубу промежуточного (:9443), выход — тот же 443.
        let chain = [Pipe { to: "s1".into(), to_host: "198.51.100.7".into(), listen: 2053, to_port: 9443, hop: Some("mid".into()), exit_port: Some(443) }];
        let via = endpoints(&s, &sec, "203.0.113.5", Ports::via(&s, &chain), "RU → SG → FI", Some("e2"));
        assert_eq!((via[0].server.as_str(), via[0].port), ("203.0.113.5", 2053));
        assert_eq!(chain[0].final_port(), 443);
    }

    #[test]
    fn ipv6_server_address() {
        assert_eq!(server_ip(" [2001:DB8:503D::2] ").unwrap(), "2001:db8:503d::2");
        assert_eq!(server_ip("203.0.113.10").unwrap(), "203.0.113.10");
        assert!(server_ip("vpn.example.com").is_err());
        assert_eq!(host_port("2001:db8:503d::2", 443), "[2001:db8:503d::2]:443");
        assert_eq!(host_port("203.0.113.10", 443), "203.0.113.10:443");
        let (mut s, sec) = srv();
        s.host = "2001:db8:503d::2".into();
        let eps = endpoints(&s, &sec, &s.host, Ports::of(&s), &s.name, None);
        assert!(eps.iter().all(|e| e.server == "2001:db8:503d::2"), "ссылки с IPv6 читаются обратно без скобок");
        let a = Awg { port: 41064, server_public: "k".into(), obf: vec![] };
        assert!(awg_client_conf(&a, "p", "q", 2, &s.host, 41064, false).contains("Endpoint = [2001:db8:503d::2]:41064"));
    }

    #[test]
    fn facts_parse_and_free_ports() {
        let out = "os=Debian GNU/Linux 13 (trixie)\nuid=0\ncpus=1\nram=1973\nsystemd=1\ndocker=1\ncontainer=amnezia-awg2\n\
                   tcp=0.0.0.0:22 users:((\"sshd\",pid=746,fd=6))\ntcp=*:443 users:((\"sing-box\",pid=9,fd=3))\n\
                   udp=0.0.0.0:35387 users:((\"docker-proxy\",pid=3001,fd=4))\nwpx=1\n\
                   geo={\"city\":\"Helsinki\",\"country\":\"FI\",\"org\":\"AS210644 AEZA GROUP LLC\"}\n";
        let f = parse_facts(out);
        assert!(f.root && f.docker && f.wpx && f.systemd);
        assert_eq!((f.city.as_str(), f.org.as_str()), ("Helsinki", "AEZA GROUP LLC"));
        assert_eq!(f.containers, vec!["amnezia-awg2"]);
        assert!(!free(&f.tcp, 22) && free(&f.tcp, 443) && free(&f.tcp, 8443));
        assert!(!free(&f.udp, 35387));
    }
}
