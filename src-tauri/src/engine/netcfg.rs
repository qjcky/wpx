//! Сетевые настройки движка и сборка конфига mihomo из профиля.
//!
//! Схема конфига: TUN + strict-route, fake-ip DNS через прокси (DoH), UDP —
//! через туннель или REJECT (если выход его не передаёт), локальные сети и
//! явные исключения — DIRECT мимо туннеля.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::config;
use crate::profiles::Chain;
#[cfg(test)]
use crate::profiles::Profile;

pub const GROUP: &str = "PROXY";
/// С резервом: рабочий профиль — в группе MAIN, резервный — в RESERVE,
/// а PROXY выбирает между ними «по порядку» (резерв — только если MAIN мёртв).
pub const MAIN_GROUP: &str = "MAIN";
/// Группа игрового режима «только UDP-точки».
pub const GAME_GROUP: &str = "GAME";
/// DNS через туннель (настоящие адреса): рабочая группа, а упала — напрямую,
/// чтобы на паузе с упавшим VPN сайты открывались.
pub const DNS_GROUP: &str = "DNS-OUT";
pub const RESERVE_GROUP: &str = "RESERVE";
pub const NAME_HTTP: &str = "wpx-http";
pub const NAME_SOCKS: &str = "wpx-socks";
/// Метка трафика самого движка (Linux, SO_MARK): правила nftables wpx
/// пропускают его мимо kill switch и блока прямого DNS.
pub const ROUTING_MARK: u32 = 6666;
pub const CONTROLLER: &str = "127.0.0.1:9097";
/// Отсюда движок берёт правила «найденного на лету» (их отдаёт окно wpx):
/// в папке движка нет места, куда может писать пользователь.
pub const FOLLOW_ADDR: &str = "127.0.0.1:9098";

/// Проверки IPv6 у Windows (NCSI): IPv6 закрыт, прокси отвечает на них 502,
/// а mihomo считает это сбоем выхода и без конца гоняет health-check.
/// Отклоняем всегда. IPv4-проверка (www.msftconnecttest.com) работает.
pub const NOISE_EXACT: &[&str] = &["ipv6.msftconnecttest.com", "ipv6.msftncsi.com"];

/// Телеметрия, которая без пользы гоняет трафик через платный прокси.
/// Только адреса сбора событий — обновления и сервисы не трогаем.
pub const TELEMETRY: &[&str] = &[
    // Windows / Microsoft
    "events.data.microsoft.com",
    "vortex.data.microsoft.com",
    "watson.telemetry.microsoft.com",
    "telemetry.microsoft.com",
    "browser.events.data.msn.com",
    // NVIDIA
    "telemetry.data.nvidia.com",
    "telemetry.gfe.nvidia.com",
];

/// Списки для режима «только заблокированное»: (id, название, адрес,
/// поведение rule-provider mihomo). Обновляются движком раз в сутки.
pub const LISTS: &[(&str, &str, &str, &str)] = &[
    ("ru-inside", "Заблокированное и замедленное в РФ — домены (itdoginfo, ~1200: YouTube, Instagram, Discord, ИИ-сервисы…)",
     "https://raw.githubusercontent.com/itdoginfo/allow-domains/main/Russia/inside-clashx.lst", "classical"),
    ("telegram-ip", "Telegram — подсети", "https://raw.githubusercontent.com/itdoginfo/allow-domains/main/Subnets/IPv4/telegram.lst", "ipcidr"),
    ("meta-ip", "Meta (Instagram, WhatsApp, Facebook) — подсети", "https://raw.githubusercontent.com/itdoginfo/allow-domains/main/Subnets/IPv4/meta.lst", "ipcidr"),
    ("discord-ip", "Discord — свои подсети (голос)", "", "ipcidr"),
    ("twitter-ip", "X (Twitter) — подсети", "https://raw.githubusercontent.com/itdoginfo/allow-domains/main/Subnets/IPv4/twitter.lst", "ipcidr"),
    ("antifilter-ip", "antifilter: подсети от сообщества (~900)", "https://community.antifilter.download/list/community.lst", "ipcidr"),
    // Не для туннеля, а наоборот — напрямую: в «только заблокированное» не входит.
    ("ru-outside", "Российские сайты, которые не открываются из-за границы (itdoginfo)",
     "https://raw.githubusercontent.com/itdoginfo/allow-domains/main/Russia/outside-clashx.lst", "classical"),
];

pub const MODES: &[&str] = &["strict", "apps", "blocked"];

/// Подсети, заданные прямо в wpx, без внешнего списка. У Discord это его
/// собственная сеть (AS49544): в списке itdoginfo к ней добавлены весь Cloudflare
/// и куски Google Cloud, и набор «Discord» утаскивал на свой путь чужие сайты
/// и игры (лаунчер Riot — весь на Cloudflare).
pub const INLINE: &[(&str, &[&str])] = &[("discord-ip", &["66.22.192.0/18", "138.128.136.0/21", "5.200.14.128/25"])];

/// Готовые наборы для правил: (id, название, домены с поддоменами, списки из LISTS).
pub const PRESETS: &[(&str, &str, &[&str], &[&str])] = &[
    ("ai", "ИИ-сервисы (ChatGPT, Claude, Gemini, Perplexity, Grok, Copilot)", &[
        "openai.com", "chatgpt.com", "oaistatic.com", "oaiusercontent.com", "anthropic.com", "claude.ai", "claude.com",
        "gemini.google.com", "aistudio.google.com", "generativelanguage.googleapis.com", "perplexity.ai", "x.ai", "grok.com",
        "copilot.microsoft.com", "mistral.ai", "deepseek.com",
    ], &[]),
    ("youtube", "YouTube", &["youtube.com", "youtu.be", "googlevideo.com", "ytimg.com", "ggpht.com", "youtube-nocookie.com", "youtubei.googleapis.com"], &[]),
    ("telegram", "Telegram", &["telegram.org", "t.me", "telegram.me", "telesco.pe", "tdesktop.com", "telegra.ph"], &["telegram-ip"]),
    ("meta", "Instagram, WhatsApp, Facebook", &["instagram.com", "cdninstagram.com", "facebook.com", "fbcdn.net", "fb.com", "whatsapp.com", "whatsapp.net", "threads.net"], &["meta-ip"]),
    ("discord", "Discord", &["discord.com", "discord.gg", "discordapp.com", "discordapp.net", "discord.media", "discordcdn.com"], &["discord-ip"]),
    ("twitter", "X (Twitter)", &["x.com", "twitter.com", "twimg.com", "t.co"], &["twitter-ip"]),
    ("blocked", "Заблокированное и замедленное в РФ (itdoginfo, ~1200 сайтов)", &[], &["ru-inside"]),
    // Зоны целиком: российским сайтам незачем видеть IP VPN-сервера.
    ("ru", "Российские сайты (.ru, .рф, .su)", &["ru", "xn--p1ai", "su"], &["ru-outside"]),
];

/// Правило «что куда»: первое совпавшее решает.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct RouteRule {
    /// "app" — приложение (имя exe или путь), "site" — домен с поддоменами,
    /// "preset" — готовый набор из PRESETS, "list" — список из LISTS.
    pub kind: String,
    pub value: String,
    /// "main" — рабочий профиль, "profile:<id>" — другой профиль,
    /// "direct" — напрямую, "block" — блокировать.
    pub target: String,
    /// Приложение — и всё, что оно запускает; сайт — и что он подгружает
    /// (follow.rs находит само).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub follow: bool,
    /// Найденное: "app:codex.exe" — помощник, "site:oaistatic.com" — сайт.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub learned: Vec<String>,
}

/// Правило дополняется найденным на лету (follow.rs): приложение — своими
/// помощниками и их сайтами, сайт — адресами, которые он подгружает. Только
/// для правил в туннель: список правил движок берёт по 127.0.0.1, и чужой
/// список (порт заняли до wpx) сможет лишь загнать трафик в туннель.
pub fn follows(r: &RouteRule) -> bool {
    r.follow && (r.kind == "app" || r.kind == "site") && r.target != "direct" && r.target != "block"
}

/// Найденное на лету: «app:имя.exe» или «site:домен». Попадает в файл правил
/// движка построчно — без запятых, путей и управляющих символов.
pub fn valid_learned(x: &str) -> bool {
    // «skip:site:…» — убрано вручную, больше не находить.
    if let Some(inner) = x.strip_prefix("skip:") {
        return !inner.starts_with("skip:") && valid_learned(inner);
    }
    match x.split_once(':') {
        Some(("app", v)) => !v.is_empty() && v.len() <= 128 && !v.contains([',', '\\', '/']) && !v.chars().any(char::is_control),
        Some(("site", v)) => valid_domain(v),
        _ => false,
    }
}

/// Имя адаптера уходит в скрипты с правами администратора (PowerShell,
/// nftables): без управляющих символов и кавычек любого вида; в Linux — как
/// имя интерфейса ядра.
pub fn valid_iface(s: &str) -> bool {
    if cfg!(windows) {
        !s.trim().is_empty() && s.chars().count() <= 128 && !s.chars().any(|c| c.is_control() || "'\"`\u{2018}\u{2019}\u{201A}\u{201B}\u{201C}\u{201D}\u{201E}\u{201F}".contains(c))
    } else {
        (1..=15).contains(&s.len()) && s.chars().all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c))
    }
}

/// Имя TUN-адаптера: латиница, цифры, «_» и «-», до 15 символов.
pub fn valid_tun(s: &str) -> bool {
    (1..=15).contains(&s.len()) && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Имя файла правил движка для найденного на лету.
pub fn follow_key(value: &str) -> String {
    let base = value.rsplit(['\\', '/']).next().unwrap_or(value).to_ascii_lowercase();
    let slug: String = base.trim_end_matches(".exe").chars().filter(|c| c.is_ascii_alphanumeric()).take(24).collect();
    // FNV-1a от полного значения — у одноимённых exe из разных папок файлы разные.
    let h = value.to_lowercase().bytes().fold(0x811c9dc5u32, |h, b| (h ^ b as u32).wrapping_mul(0x0100_0193));
    format!("follow-{slug}-{:04x}", h & 0xffff)
}

/// Строки файла правил: найденные помощники и сайты.
pub fn follow_lines(r: &RouteRule) -> String {
    r.learned
        .iter()
        .filter_map(|x| match x.split_once(':') {
            Some(("app", v)) if valid_learned(x) => Some(format!("PROCESS-NAME,{v}")),
            Some(("site", v)) if valid_learned(x) => Some(format!("DOMAIN-SUFFIX,{v}")),
            _ => None,
        })
        .map(|l| l + "\n")
        .collect()
}

/// Свой набор для правил: адреса (с поддоменами) и подсети под одним именем.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct UserSet {
    /// "u" + время создания.
    pub id: String,
    pub name: String,
    /// Домены (с поддоменами) и подсети IPv4.
    pub items: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct NetSettings {
    /// Режим защиты: "strict" — весь ПК через туннель; "apps" — только
    /// выбранные приложения; "blocked" — только заблокированное (списки).
    pub mode: String,
    /// Приложения, которые всегда идут через туннель (в режимах apps и
    /// blocked): имя `chrome.exe` или полный путь. Упал туннель — их трафик
    /// блокируется, напрямую не уходит.
    pub apps: Vec<String>,
    /// Свои домены через туннель (в режимах apps и blocked), с поддоменами.
    pub tunnel_domains: Vec<String>,
    /// Включённые списки из LISTS (режим blocked).
    pub lists: Vec<String>,
    /// Правила «что куда» (вкладка «Правила»). Прежние apps / tunnel_domains /
    /// lists при загрузке переезжают сюда.
    pub rules: Vec<RouteRule>,
    /// Свои наборы (правило — kind "preset" с их id).
    pub sets: Vec<UserSet>,
    /// Готовые наборы, скрытые из подборщика (правила с ними работают).
    pub hidden_presets: Vec<String>,
    /// Блокировать телеметрию из списка TELEMETRY.
    pub block_telemetry: bool,
    /// Свои домены в блок (по суффиксу).
    pub block_domains: Vec<String>,
    /// Физический адаптер, через который движок ходит к прокси.
    pub interface: String,
    /// Локальные сети — напрямую (роутер, VirtualBox, WSL…).
    pub lan: Vec<String>,
    /// Явные исключения — напрямую (например, SSH-серверы).
    pub direct: Vec<String>,
    /// Устарело: прежний переключатель «Блокировать UDP» (читается для
    /// перехода на `udp`).
    pub block_udp: bool,
    /// UDP: "auto" — блокировать, только если выход его не передаёт
    /// (HTTP/SOCKS); "block" — всегда; "allow" — никогда.
    pub udp: String,
    /// При пропущенном UDP — всё же отклонять QUIC (UDP 443): браузеры уйдут
    /// на TCP, через некоторые выходы так стабильнее.
    pub block_quic: bool,
    /// IPv6: "tunnel" — через туннель (у TUN свой IPv6-адрес, мимо туннеля
    /// IPv6 закрыт только на физическом адаптере, `::1` работает); "block" —
    /// закрыт везде.
    #[serde(default = "ipv6_default")]
    pub ipv6: String,
    pub tun_device: String,
    pub mixed_port: u16,
    /// Секрет локального API mihomo (генерируется один раз).
    pub secret: String,
    /// Резервный профиль (id): если рабочий VPN не отвечает, движок сам
    /// уходит на него и сам возвращается, когда VPN оживёт. Пусто — без резерва.
    pub reserve: String,
    /// Игровой режим: игра (и её вход) — выбранным путём, впереди всех правил.
    pub game: GameMode,
    /// Kill switch в брандмауэре Windows (без роутера): исходящие по умолчанию
    /// запрещены, разрешены только движок, туннель, локальная сеть и DHCP —
    /// остановился движок, мимо не уйдёт ничего.
    pub kill_switch: bool,
    /// Настоящие адреса сайтов вместо fake-ip (198.18.x.x), по умолчанию:
    /// ускорители игр (ExitLag и т.п.) и часть античитов перехватывают игру
    /// раньше движка и с подменными адресами не работают. Сайт для правил —
    /// по самому соединению (TLS/HTTP), адреса узнаются тем же путём, что и
    /// трафик сайта (через туннель — DNS-сервис напрямую их не видит).
    pub real_ip: bool,
}

/// Игровой режим. Игра — её exe; «перенаправление входа» ведёт тем же путём
/// лаунчер и серверы входа: без этого часть онлайн-игр не пускает в игру
/// (вход видит один адрес, игровой сервер — другой).
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct GameMode {
    pub on: bool,
    /// Игра из каталога (`dota2`, `valorant`…) или `custom`.
    pub game: String,
    pub name: String,
    /// exe самой игры.
    pub apps: Vec<String>,
    /// Папка игры: всё, что запускается из неё (вход, античит, помощники), —
    /// тем же путём. Пусто — только exe.
    pub dir: String,
    /// Перенаправление входа.
    pub login: bool,
    /// Лаунчер и его службы (exe).
    pub launchers: Vec<String>,
    /// Серверы входа и обновлений (домены с поддоменами).
    pub domains: Vec<String>,
    /// "main" — рабочий профиль или "profile:<id>".
    pub target: String,
    /// Игра — только через точки, которые сами ходят по UDP (AmneziaWG,
    /// Hysteria2): у TCP-точек (VLESS) при потерях пакетов игра подлагивает.
    pub udp_only: bool,
}

/// Экранировать путь для регулярного выражения движка.
fn re_escape(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        if "\\.+*?()|[]{}^$".contains(c) {
            o.push('\\');
        }
        o.push(c);
    }
    o
}

/// Правила игрового режима: игра, при «перенаправлении входа» — лаунчер и домены входа.
pub fn game_rules(n: &NetSettings) -> Vec<RouteRule> {
    let g = &n.game;
    if !g.on || g.apps.is_empty() {
        return vec![];
    }
    let target = if g.target.is_empty() { "main".to_string() } else { g.target.clone() };
    let rule = |kind: &str, value: &String| RouteRule { kind: kind.into(), value: value.trim().into(), target: target.clone(), ..Default::default() };
    let mut v: Vec<RouteRule> = g.apps.iter().filter(|a| !a.trim().is_empty()).map(|a| rule("app", a)).collect();
    // Запятая в пути сломала бы строку правила движка — такую папку не берём.
    if !g.dir.trim().is_empty() && !g.dir.contains(',') {
        v.push(rule("dir", &g.dir));
    }
    if g.login {
        v.extend(g.launchers.iter().filter(|a| !a.trim().is_empty()).map(|a| rule("app", a)));
        v.extend(g.domains.iter().filter(|d| !d.trim().is_empty()).map(|d| rule("site", d)));
    }
    v
}

/// Выходы профиля игры, которые сами ходят по UDP (имена, как в конфиге).
fn game_points(ch: &Chain, extras: &[Extra], target: &str) -> Vec<String> {
    let pick = |pts: Vec<(String, &crate::profiles::proto::Endpoint, bool)>| -> Vec<String> {
        pts.into_iter().filter(|(_, e, entry)| !entry && e.kind.over_udp()).map(|(n, ..)| n).collect()
    };
    match extras.iter().find(|x| Some(x.chain.id.as_str()) == target.strip_prefix("profile:")) {
        Some(x) => pick(extra_points(x)),
        // «main» и ссылка на рабочий профиль.
        None => pick(ch.points().into_iter().map(|(n, e, entry, _)| (n, e, entry)).collect()),
    }
}

/// Все правила по порядку: игровой режим впереди, потом «что куда».
pub fn all_rules(n: &NetSettings) -> Vec<RouteRule> {
    let mut v = game_rules(n);
    v.extend(n.rules.iter().cloned());
    v
}

impl Default for NetSettings {
    fn default() -> Self {
        Self {
            mode: "strict".into(),
            rules: vec![],
            sets: vec![],
            hidden_presets: vec![],
            apps: vec![],
            tunnel_domains: vec![],
            lists: LISTS.iter().filter(|l| l.0 != "antifilter-ip" && l.0 != "ru-outside").map(|l| l.0.to_string()).collect(),
            block_telemetry: true,
            block_domains: vec![],
            interface: String::new(),
            lan: vec!["10.0.0.0/8".into(), "172.16.0.0/12".into(), "192.168.0.0/16".into()],
            direct: vec![],
            block_udp: true,
            udp: "auto".into(),
            block_quic: false,
            ipv6: ipv6_default(),
            tun_device: "wpx".into(),
            mixed_port: 7890,
            secret: String::new(),
            reserve: String::new(),
            game: GameMode::default(),
            kill_switch: false,
            real_ip: true,
        }
    }
}

fn ipv6_default() -> String {
    "tunnel".into()
}

/// IPv6-адрес TUN (ULA, внутри ПК): с ним Windows ведёт `::/0` в туннель.
pub const TUN_INET6: &str = "fdfe:dcba:9876::1/126";

pub fn valid_cidr(s: &str) -> bool {
    let (ip, len) = s.split_once('/').unwrap_or((s, "32"));
    ip.parse::<std::net::Ipv4Addr>().is_ok() && len.parse::<u8>().map(|l| l <= 32).unwrap_or(false)
}

fn norm(s: &str) -> String {
    let s = s.trim();
    if s.contains('/') { s.to_string() } else { format!("{s}/32") }
}

pub fn load() -> NetSettings {
    let mut s: NetSettings = std::fs::read_to_string(config::data_dir().join("engine.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| NetSettings { interface: crate::platform::default_interface().unwrap_or_else(|| "Ethernet".into()), ..NetSettings::default() });
    // Старый файл без `udp`: снятый переключатель «Блокировать UDP» = «пропускать».
    if !std::fs::read_to_string(config::data_dir().join("engine.json")).map(|t| t.contains("\"udp\"")).unwrap_or(true) && !s.block_udp {
        s.udp = "allow".into();
    }
    // Прежние «приложения / свои домены / списки» — в правила на рабочий профиль.
    if s.rules.is_empty() && (!s.apps.is_empty() || !s.tunnel_domains.is_empty() || (s.mode == "blocked" && !s.lists.is_empty())) {
        let main = |kind: &str, v: &String| RouteRule { kind: kind.into(), value: v.trim().into(), target: "main".into(), ..Default::default() };
        let mut r: Vec<RouteRule> = s.apps.iter().map(|a| main("app", a)).collect();
        r.extend(s.tunnel_domains.iter().map(|d| main("site", d)));
        if s.mode == "blocked" {
            r.extend(s.lists.iter().map(|l| main("list", l)));
        }
        s.rules = r;
        s.apps.clear();
        s.tunnel_domains.clear();
    }
    // Файл может поправить любая программа от имени пользователя, а имена
    // адаптеров попадают в скрипты администратора: недопустимые не берём.
    let bad_names = (!s.interface.is_empty() && !valid_iface(&s.interface)) || !valid_tun(&s.tun_device);
    if !s.interface.is_empty() && !valid_iface(&s.interface) {
        s.interface = crate::platform::default_interface().filter(|i| valid_iface(i)).unwrap_or_default();
    }
    if !valid_tun(&s.tun_device) {
        s.tun_device = "wpx".into();
    }
    for r in &mut s.rules {
        r.learned.retain(|x| valid_learned(x));
    }
    s.lan.retain(|c| valid_cidr(c.trim()));
    s.direct.retain(|c| valid_cidr(c.trim()));
    if bad_names {
        let _ = save(&s);
    }
    if s.secret.is_empty() {
        s.secret = crate::engine::ops::random_hex(32);
        let _ = save(&s);
    }
    s
}

/// Домен с поддоменами или целая зона («io», «ai», «xn--p1ai»): правило по суффиксу.
pub fn valid_domain(s: &str) -> bool {
    !s.is_empty()
        && s.len() < 254
        && s.split('.').all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
        && (s.contains('.') || (s.len() >= 2 && s.starts_with(|c: char| c.is_ascii_alphabetic())))
}

pub fn save(s: &NetSettings) -> Result<(), String> {
    validate(s)?;
    config::write_json("engine.json", s)
}

/// Проверки настроек (без записи).
pub fn validate(s: &NetSettings) -> Result<(), String> {
    for c in s.lan.iter().chain(&s.direct) {
        if !valid_cidr(c) {
            return Err(format!("Не похоже на адрес или подсеть: «{c}»"));
        }
    }
    for d in s.block_domains.iter().chain(&s.tunnel_domains) {
        if !valid_domain(d) {
            return Err(format!("Не похоже на домен: «{d}»"));
        }
    }
    if !["auto", "block", "allow"].contains(&s.udp.as_str()) {
        return Err(format!("UDP: «{}» — нужно auto, block или allow", s.udp));
    }
    if !s.interface.is_empty() && !valid_iface(&s.interface) {
        return Err(format!("Адаптер «{}»: недопустимые символы в имени", s.interface));
    }
    if !valid_tun(&s.tun_device) {
        return Err(format!("Имя TUN «{}»: только латиница, цифры, «_» и «-», до 15 символов", s.tun_device));
    }
    if let Some(x) = s.rules.iter().flat_map(|r| &r.learned).find(|x| !valid_learned(x)) {
        return Err(format!("Найденное на лету «{x}» — не похоже на программу или сайт"));
    }
    if !MODES.contains(&s.mode.as_str()) {
        return Err(format!("Неизвестный режим защиты «{}»", s.mode));
    }
    for a in &s.apps {
        if a.trim().is_empty() || a.contains([',', '\n', '"']) {
            return Err(format!("Приложение: имя файла (chrome.exe) или полный путь, без запятых — «{a}»"));
        }
    }
    if let Some(l) = s.lists.iter().find(|l| !LISTS.iter().any(|d| d.0 == l.as_str())) {
        return Err(format!("Неизвестный список «{l}»"));
    }
    for (i, u) in s.sets.iter().enumerate() {
        if u.name.trim().is_empty() {
            return Err("Свой набор без названия".into());
        }
        let id_ok = u.id.len() > 1 && u.id.starts_with('u') && u.id[1..].chars().all(|c| c.is_ascii_alphanumeric());
        if !id_ok || s.sets[..i].iter().any(|x| x.id == u.id) || PRESETS.iter().any(|p| p.0 == u.id) {
            return Err(format!("Набор «{}»: неверный id", u.name));
        }
        if u.items.is_empty() {
            return Err(format!("Набор «{}» пуст — добавьте хотя бы один адрес", u.name));
        }
        if let Some(x) = u.items.iter().find(|x| !(valid_domain(x) || valid_cidr(x))) {
            return Err(format!("Набор «{}»: «{x}» — не похоже на домен или подсеть", u.name));
        }
    }
    for r in &s.rules {
        let ok_value = match r.kind.as_str() {
            "app" => !r.value.trim().is_empty() && !r.value.contains([',', '\n', '"', '(', ')']),
            "site" => valid_domain(r.value.trim()),
            "preset" => PRESETS.iter().any(|p| p.0 == r.value) || s.sets.iter().any(|u| u.id == r.value),
            "list" => LISTS.iter().any(|l| l.0 == r.value),
            _ => false,
        };
        if !ok_value {
            return Err(format!("Правило: «{}» — не похоже на {}", r.value, match r.kind.as_str() {
                "app" => "приложение (chrome.exe или полный путь)",
                "site" => "сайт (example.com)",
                _ => "известный набор",
            }));
        }
        let exit_ok = r.target.strip_prefix("exit:").is_some_and(|ip| ip.parse::<std::net::IpAddr>().is_ok());
        if !(r.target == "main" || r.target == "direct" || r.target == "block" || r.target.starts_with("profile:") || exit_ok) {
            return Err(format!("Правило «{}»: неизвестно, куда направить", r.value));
        }
    }
    Ok(())
}

/// Группа выбора точки: одна — select; несколько — url-test («самая
/// быстрая», mode == "auto") или fallback («по порядку»).
pub fn group_json(name: &str, members: &[&String], mode: &str) -> Value {
    if members.len() > 1 && (mode == "auto" || mode == "smart") {
        // Самый быстрый; переключаться, только если выигрыш заметный.
        json!({"name": name, "type": "url-test", "proxies": members,
               "url": "http://www.gstatic.com/generate_204", "interval": 120,
               "tolerance": 150, "timeout": 5000, "lazy": false})
    } else if members.len() > 1 {
        json!({"name": name, "type": "fallback", "proxies": members,
               "url": "http://www.gstatic.com/generate_204", "interval": 30,
               "timeout": 5000, "lazy": false, "max-failed-times": 2})
    } else {
        json!({"name": name, "type": "select", "proxies": members})
    }
}

pub const ENTRY_GROUP: &str = "ENTRY";

/// Группа входа, через которую подключается точка выхода: у участника
/// маршрута (`wpx-r1-…`) — `R1-ENTRY`, иначе — общая `ENTRY`.
pub fn entry_group_for(exit_point: &str) -> String {
    exit_point
        .strip_prefix("wpx-r")
        .and_then(|rest| rest.split('-').next())
        .filter(|i| !i.is_empty() && i.chars().all(|c| c.is_ascii_digit()))
        .map(|i| format!("R{i}-ENTRY"))
        .unwrap_or_else(|| ENTRY_GROUP.to_string())
}

/// Прокси и группы одной цепочки (обычный профиль — цепочка без входа):
/// `group` — группа выхода, `entry_group` — группа входа каскада; `rename` —
/// итоговые имена точек (у участника маршрута — с префиксом). Каскад: каждая
/// точка выхода подключается через группу входа (`dialer-proxy`); серверам
/// пересылка не нужна, порядок меняется только на клиенте.
fn chain_parts(ch: &Chain, group: &str, entry_group: &str, rename: &dyn Fn(&str) -> String) -> Result<(Vec<Value>, Vec<Value>), String> {
    if ch.exit.is_empty() {
        return Err("в профиле нет ни одной точки подключения".into());
    }
    let cascade = !ch.entry.is_empty();
    let mut proxies: Vec<Value> = ch.entry.iter().map(|(name, ep)| crate::profiles::proto::to_mihomo(ep, &rename(name))).collect();
    for (name, ep) in &ch.exit {
        let mut v = crate::profiles::proto::to_mihomo(ep, &rename(name));
        if cascade {
            v["dialer-proxy"] = json!(entry_group);
        }
        proxies.push(v);
    }
    let exit_names: Vec<String> = ch.exit.iter().map(|(name, _)| rename(name)).collect();
    let mut groups = vec![group_json(group, &exit_names.iter().collect::<Vec<_>>(), &ch.exit_mode)];
    if cascade {
        let entry_names: Vec<String> = ch.entry.iter().map(|(name, _)| rename(name)).collect();
        groups.push(group_json(entry_group, &entry_names.iter().collect::<Vec<_>>(), &ch.entry_mode));
    }
    Ok((proxies, groups))
}

/// Группы и прокси любой цепочки под своим именем группы и меткой точек
/// (профили из правил: `X{j}`, точки `wpx-x{j}-…`).
fn tagged_parts(ch: &Chain, group: &str, tag: &str) -> Result<(Vec<Value>, Vec<Value>), String> {
    if ch.members.is_empty() {
        return chain_parts(ch, group, &format!("{group}-ENTRY"), &|s| crate::profiles::tagged(tag, s));
    }
    let (mut proxies, mut groups, mut tops) = (vec![], vec![], vec![]);
    for (i, (_, m)) in ch.members.iter().enumerate() {
        let g = format!("{group}-R{i}");
        let (p, gr) = chain_parts(m, &g, &format!("{g}-ENTRY"), &|s| crate::profiles::tagged(&format!("{tag}r{i}"), s))?;
        proxies.extend(p);
        groups.extend(gr);
        tops.push(g);
    }
    groups.insert(0, group_json(group, &tops.iter().collect::<Vec<_>>(), &ch.exit_mode));
    Ok((proxies, groups))
}

/// Профиль из правил в конфиге: группа, метка точек, название, цепочка.
pub struct Extra {
    pub group: String,
    pub tag: String,
    pub name: String,
    pub chain: Chain,
}

/// Профили, на которые ссылаются правила (кроме рабочего), — по порядку.
pub fn extras(n: &NetSettings, main_id: &str) -> Result<Vec<Extra>, String> {
    let rules = all_rules(n);
    let ids: Vec<&str> = {
        let mut v: Vec<&str> = vec![];
        for r in &rules {
            if let Some(id) = r.target.strip_prefix("profile:") {
                if id != main_id && !v.contains(&id) {
                    v.push(id);
                }
            }
        }
        v
    };
    if ids.is_empty() {
        return Ok(vec![]);
    }
    let st = crate::profiles::load();
    ids.iter()
        .enumerate()
        .map(|(j, id)| {
            let p = st.profiles.iter().find(|p| p.id == *id).ok_or("профиль из правил удалён — поправьте правила")?;
            Ok(Extra { group: format!("X{j}"), tag: format!("x{j}"), name: p.name.clone(), chain: crate::profiles::chain_of(&st, p)? })
        })
        .collect()
}

/// Резервный профиль (если задан и это не сам рабочий).
pub fn reserve_of(n: &NetSettings, main_id: &str) -> Result<Option<Extra>, String> {
    if n.reserve.is_empty() || n.reserve == main_id {
        return Ok(None);
    }
    let st = crate::profiles::load();
    let Some(p) = st.profiles.iter().find(|p| p.id == n.reserve) else { return Ok(None) };
    Ok(Some(Extra { group: RESERVE_GROUP.into(), tag: "rsv".into(), name: p.name.clone(), chain: crate::profiles::chain_of(&st, p)? }))
}

/// «Постоянный IP»: все известные точки, которые выходят в интернет с одного
/// адреса (разные протоколы одного сервера, трубы каскада к нему). Правило с
/// целью `exit:<ip>` держится этого адреса: точки меняются, IP — нет.
pub struct Sticky {
    pub group: String,
    pub ip: String,
    pub name: String,
    pub eps: Vec<(String, crate::profiles::proto::Endpoint)>,
}

/// Выход точки: у трубы своего сервера — сервер на том конце, иначе — сама точка.
pub fn exit_ip(ep: &crate::profiles::proto::Endpoint, servers: &[crate::servers::Server]) -> String {
    servers
        .iter()
        .filter(|s| s.host == ep.server)
        .find_map(|s| s.pipes.iter().find(|p| p.listen == ep.port).map(|p| p.to_host.clone()))
        .unwrap_or_else(|| ep.server.clone())
}

#[derive(Serialize, Clone, Debug)]
pub struct ExitView {
    pub ip: String,
    pub name: String,
    /// Через что можно выйти с этого адреса: «VLESS», «Hysteria2 через Сингапур»…
    pub ways: Vec<String>,
}

/// Все адреса выхода, известные по профилям (без каскадов-цепочек и маршрутов).
pub fn exits() -> Vec<(ExitView, Vec<crate::profiles::proto::Endpoint>)> {
    let st = crate::profiles::load();
    let servers = crate::servers::load().servers;
    let mut out: Vec<(ExitView, Vec<crate::profiles::proto::Endpoint>)> = vec![];
    for p in st.profiles.iter().filter(|p| p.cascade.is_none() && p.route.is_empty()) {
        let Ok(eps) = crate::profiles::endpoints_of(p) else { continue };
        for (_, e) in eps {
            let ip = exit_ip(&e, &servers);
            let via = (ip != e.server).then(|| servers.iter().find(|s| s.host == e.server).map(|s| s.name.clone()).unwrap_or(e.server.clone()));
            let way = format!("{}{}", e.kind.label(), via.map(|v| format!(" через {v}")).unwrap_or_default());
            let name = servers.iter().find(|s| s.host == ip).map(|s| s.name.clone()).unwrap_or_else(|| p.name.clone());
            match out.iter_mut().find(|(v, _)| v.ip == ip) {
                Some((v, list)) => {
                    if !list.iter().any(|x| x.server == e.server && x.port == e.port && x.kind == e.kind) {
                        if !v.ways.contains(&way) {
                            v.ways.push(way);
                        }
                        list.push(e);
                    }
                }
                None => out.push((ExitView { ip, name, ways: vec![way] }, vec![e])),
            }
        }
    }
    out
}

/// Группы «постоянного IP» для правил с целью `exit:<ip>`.
pub fn stickies(n: &NetSettings) -> Result<Vec<Sticky>, String> {
    let rules = all_rules(n);
    let ips: Vec<&str> = {
        let mut v: Vec<&str> = vec![];
        for r in &rules {
            if let Some(ip) = r.target.strip_prefix("exit:") {
                if !v.contains(&ip) {
                    v.push(ip);
                }
            }
        }
        v
    };
    if ips.is_empty() {
        return Ok(vec![]);
    }
    let all = exits();
    ips.iter()
        .enumerate()
        .map(|(k, ip)| {
            let (v, eps) = all.iter().find(|(v, _)| v.ip == *ip).ok_or(format!("Постоянный IP {ip}: нет ни одной точки с этим выходом — поправьте правила"))?;
            Ok(Sticky {
                group: format!("IP{k}"),
                ip: ip.to_string(),
                name: v.name.clone(),
                eps: eps.iter().enumerate().map(|(i, e)| (format!("wpx-ip{k}-{i}"), e.clone())).collect(),
            })
        })
        .collect()
}

/// Подписи точек, которые в конфиге кроме рабочего профиля: профили из
/// правил, резерв, постоянный IP — для монитора и пробного запуска.
pub fn side_labels(n: &NetSettings, main_id: &str) -> Vec<(String, String, bool)> {
    let mut out = vec![];
    for x in extras(n, main_id).unwrap_or_default() {
        out.extend(extra_points(&x).into_iter().map(|(name, e, entry)| (name, format!("{}: {}", x.name, e.label), entry)));
    }
    if let Ok(Some(r)) = reserve_of(n, main_id) {
        out.extend(extra_points(&r).into_iter().map(|(name, e, entry)| (name, format!("резерв {}: {}", r.name, e.label), entry)));
    }
    for s in stickies(n).unwrap_or_default() {
        out.extend(s.eps.iter().map(|(name, e)| (name.clone(), format!("постоянный IP {}: {}", s.name, e.label), false)));
    }
    out
}

/// Точки профиля из правил с именами, как в конфиге: (имя, точка, это вход).
pub fn extra_points(x: &Extra) -> Vec<(String, &crate::profiles::proto::Endpoint, bool)> {
    if x.chain.members.is_empty() {
        return x.chain.points().into_iter().map(|(n, e, entry, _)| (crate::profiles::tagged(&x.tag, &n), e, entry)).collect();
    }
    x.chain
        .members
        .iter()
        .enumerate()
        .flat_map(|(i, (_, m))| m.points().into_iter().map(move |(n, e, entry, _)| (crate::profiles::tagged(&format!("{}r{i}", x.tag), &n), e, entry)))
        .collect()
}

pub fn build(ch: &Chain, n: &NetSettings) -> Result<Value, String> {
    build_with(ch, n, &extras(n, &ch.id)?, reserve_of(n, &ch.id)?.as_ref(), &stickies(n)?)
}

pub fn build_with(ch: &Chain, n: &NetSettings, extras: &[Extra], reserve: Option<&Extra>, sticky: &[Sticky]) -> Result<Value, String> {
    let main = if reserve.is_some() { MAIN_GROUP } else { GROUP };
    let (proxies, groups) = if ch.members.is_empty() {
        chain_parts(ch, main, ENTRY_GROUP, &|s| s.to_string())?
    } else {
        // Маршрут: у каждого участника своя группа R{i} (и R{i}-ENTRY для
        // каскада), главная группа выбирает между участниками.
        let (mut proxies, mut groups, mut tops) = (vec![], vec![], vec![]);
        for (i, (_, m)) in ch.members.iter().enumerate() {
            let (p, g) = chain_parts(m, &format!("R{i}"), &format!("R{i}-ENTRY"), &|s| crate::profiles::member_name(i, s))?;
            proxies.extend(p);
            groups.extend(g);
            tops.push(format!("R{i}"));
        }
        groups.insert(0, group_json(main, &tops.iter().collect::<Vec<_>>(), &ch.exit_mode));
        (proxies, groups)
    };
    let (mut proxies, mut groups) = (proxies, groups);
    if let Some(r) = reserve {
        let (p, g) = tagged_parts(&r.chain, &r.group, &r.tag)?;
        proxies.extend(p);
        groups.extend(g);
        // Резерв — только когда рабочий не отвечает; ожил — движок вернётся сам.
        groups.insert(0, json!({"name": GROUP, "type": "fallback", "proxies": [MAIN_GROUP, RESERVE_GROUP],
            "url": "http://www.gstatic.com/generate_204", "interval": 30, "timeout": 5000, "lazy": false, "max-failed-times": 2}));
    }
    for x in extras {
        let (p, g) = tagged_parts(&x.chain, &x.group, &x.tag)?;
        proxies.extend(p);
        groups.extend(g);
    }
    for s in sticky {
        proxies.extend(s.eps.iter().map(|(name, e)| crate::profiles::proto::to_mihomo(e, name)));
        let names: Vec<String> = s.eps.iter().map(|(name, _)| name.clone()).collect();
        // Все точки выходят с одного адреса — берём самую быструю.
        groups.push(group_json(&s.group, &names.iter().collect::<Vec<_>>(), "auto"));
    }
    // Напрямую ПК ходит только к первым звеньям: входу каскада или выходу
    // (рабочего профиля, резерва, профилей из правил, постоянного IP).
    let mut first_hop = ch.first_hop();
    for x in extras.iter().chain(reserve) {
        first_hop.extend(x.chain.first_hop());
    }
    for s in sticky {
        first_hop.extend(s.eps.iter().map(|(name, e)| (name.clone(), e)));
    }
    let servers: Vec<&str> = first_hop.iter().map(|(_, e)| e.server.as_str()).collect();
    let any_domain = servers.iter().any(|s| s.parse::<std::net::IpAddr>().is_err());

    let lan: Vec<String> = n.lan.iter().map(|c| norm(c)).collect();
    let direct: Vec<String> = n.direct.iter().map(|c| norm(c)).collect();
    // Блок — первым: отклонённое не тратит прокси и не считается сбоем выхода.
    let mut rules: Vec<String> = NOISE_EXACT.iter().map(|d| format!("DOMAIN,{d},REJECT")).collect();
    if n.block_telemetry {
        rules.extend(TELEMETRY.iter().map(|d| format!("DOMAIN-SUFFIX,{d},REJECT")));
    }
    rules.extend(n.block_domains.iter().map(|d| format!("DOMAIN-SUFFIX,{},REJECT", d.trim().to_ascii_lowercase())));
    rules.extend(lan.iter().chain(&direct).map(|c| format!("IP-CIDR,{c},DIRECT,no-resolve")));
    // UDP: «авто» — блок, только если какой-то выход его не передаёт.
    let carries_udp = ch.points().iter().all(|(_, e, ..)| e.kind.udp());
    let block_udp = match n.udp.as_str() {
        "block" => true,
        "allow" => false,
        _ => !carries_udp,
    };
    let selective = n.mode == "apps" || n.mode == "blocked";
    let mut providers = serde_json::Map::new();
    // Настоящие адреса: имя из правила — тем же путём, что и его трафик
    // (ключ nameserver-policy, через туннель ли). Первое совпавшее решает.
    let mut dns_policy: Vec<(String, bool)> = vec![];
    // Игровой режим «только UDP-точки»: своя группа из выходов профиля игры,
    // которые сами ходят по UDP. Таких нет — игра идёт обычной группой профиля.
    let game_n = game_rules(n).len();
    let to_profile = matches!(n.game.target.as_str(), "" | "main") || n.game.target.starts_with("profile:");
    let game_pts = if game_n > 0 && n.game.udp_only && to_profile { game_points(ch, extras, &n.game.target) } else { vec![] };
    if !game_pts.is_empty() {
        groups.push(group_json(GAME_GROUP, &game_pts.iter().collect::<Vec<_>>(), "auto"));
    }
    // Правила «что куда» — в обоих режимах, первое совпавшее решает. Правило,
    // ведущее в профиль, при упавшем профиле не уходит напрямую.
    for (i, r) in all_rules(n).iter().enumerate() {
        let (target, udp_ok) = match r.target.as_str() {
            _ if i < game_n && !game_pts.is_empty() => (GAME_GROUP.to_string(), true),
            "direct" => ("DIRECT".to_string(), true),
            "block" => ("REJECT".to_string(), true),
            "main" => (GROUP.to_string(), carries_udp),
            t if t.starts_with("exit:") => match sticky.iter().find(|s| Some(s.ip.as_str()) == t.strip_prefix("exit:")) {
                Some(s) => (s.group.clone(), s.eps.iter().all(|(_, e)| e.kind.udp())),
                None => return Err(format!("Постоянный IP {}: нет точек", &t[5..])),
            },
            t => match extras.iter().find(|x| Some(x.chain.id.as_str()) == t.strip_prefix("profile:")) {
                Some(x) => (x.group.clone(), x.chain.points().iter().all(|(_, e, ..)| e.kind.udp())),
                // Ссылка на рабочий профиль — то же, что «main».
                None => (GROUP.to_string(), carries_udp),
            },
        };
        let block_rule_udp = target != "DIRECT" && target != "REJECT" && match n.udp.as_str() {
            "block" => true,
            "allow" => false,
            _ => !udp_ok,
        };
        let v = r.value.trim();
        let mut matchers: Vec<(String, bool)> = vec![];
        let mut add_list = |id: &str, matchers: &mut Vec<(String, bool)>| {
            if let Some((_, _, url, behavior)) = LISTS.iter().find(|l| l.0 == id) {
                let provider = match INLINE.iter().find(|(i, _)| *i == id) {
                    Some((_, payload)) => json!({ "type": "inline", "behavior": behavior, "payload": payload }),
                    None => json!({
                        "type": "http", "behavior": behavior, "format": "text", "url": url,
                        "path": format!("./rules/{id}.txt"), "interval": 86400, "proxy": GROUP
                    }),
                };
                providers.insert(id.to_string(), provider);
                matchers.push((format!("RULE-SET,{id}"), *behavior == "ipcidr"));
            }
        };
        match r.kind.as_str() {
            "app" => {
                matchers.push((format!("{},{v}", if v.contains(['\\', '/']) { "PROCESS-PATH" } else { "PROCESS-NAME" }), false));
            }
            // Всё, что запущено из папки (игра и её помощники).
            "dir" => matchers.push((
                if v.starts_with('/') {
                    format!("PROCESS-PATH-REGEX,^{}/.+", re_escape(v.trim_end_matches('/')))
                } else {
                    format!("PROCESS-PATH-REGEX,(?i)^{}\\\\.+", re_escape(v.trim_end_matches(['\\', '/'])))
                },
                false,
            )),
            "site" => matchers.push((format!("DOMAIN-SUFFIX,{}", v.to_ascii_lowercase()), false)),
            "list" => add_list(v, &mut matchers),
            "preset" => {
                if let Some((_, _, domains, lists)) = PRESETS.iter().find(|p| p.0 == v) {
                    matchers.extend(domains.iter().map(|d| (format!("DOMAIN-SUFFIX,{d}"), false)));
                    for l in lists.iter() {
                        add_list(l, &mut matchers);
                    }
                } else if let Some(u) = n.sets.iter().find(|u| u.id == v) {
                    // Свой набор: подсети — по IP, остальное — домены с поддоменами.
                    for x in u.items.iter().map(|x| x.trim().to_ascii_lowercase()) {
                        matchers.push(match (valid_cidr(&x), x.contains('/')) {
                            (true, true) => (format!("IP-CIDR,{x}"), true),
                            (true, false) => (format!("IP-CIDR,{x}/32"), true),
                            _ => (format!("DOMAIN-SUFFIX,{x}"), false),
                        });
                    }
                }
            }
            _ => {}
        }
        // И найденное на лету: правила отдаёт окно wpx по 127.0.0.1, движок
        // скачивает их к себе (в свою папку) и перечитывает по API — без
        // перезапуска. Папки, куда пишет пользователь, у движка нет: mihomo
        // проверяет пути только по тексту, и ссылка в такой папке пустила бы
        // его запись от SYSTEM куда угодно.
        if follows(r) {
            let key = follow_key(v);
            providers.insert(key.clone(), json!({
                "type": "http", "behavior": "classical", "format": "text", "url": format!("http://{FOLLOW_ADDR}/{key}.txt"),
                "path": format!("./rules/{key}.txt"), "interval": 86400, "proxy": "DIRECT"
            }));
            matchers.push((format!("RULE-SET,{key}"), false));
        }
        if target != "REJECT" {
            for (m, _) in &matchers {
                let key = if let Some(d) = m.strip_prefix("DOMAIN-SUFFIX,") {
                    format!("+.{d}")
                } else if let Some(id) = m.strip_prefix("RULE-SET,") {
                    match providers.get(id).and_then(|p| p["behavior"].as_str()) {
                        Some("classical" | "domain") => format!("rule-set:{id}"),
                        _ => continue,
                    }
                } else {
                    continue;
                };
                if !dns_policy.iter().any(|(k, _)| *k == key) {
                    dns_policy.push((key, target != "DIRECT"));
                }
            }
        }
        for (m, ip) in matchers {
            if block_rule_udp {
                rules.push(format!("AND,(({m}),(NETWORK,udp)),REJECT"));
            }
            rules.push(format!("{m},{target}{}", if ip { ",no-resolve" } else { "" }));
        }
    }
    if selective {
        rules.push("MATCH,DIRECT".into());
    } else {
        if block_udp {
            rules.push("NETWORK,udp,REJECT".into());
        } else if n.block_quic {
            rules.push("AND,((NETWORK,udp),(DST-PORT,443)),REJECT".into());
        }
        rules.push(format!("MATCH,{GROUP}"));
    }
    let mut exclude: Vec<String> = lan.iter().chain(&direct).cloned().collect();
    for s in &servers {
        let c = match s.parse::<std::net::IpAddr>() {
            Ok(std::net::IpAddr::V4(a)) => format!("{a}/32"),
            Ok(std::net::IpAddr::V6(a)) => format!("{a}/128"),
            Err(_) => continue,
        };
        if !exclude.contains(&c) {
            exclude.push(c);
        }
    }

    if n.real_ip {
        groups.push(json!({"name": DNS_GROUP, "type": "fallback", "proxies": [GROUP, "DIRECT"],
            "url": "http://www.gstatic.com/generate_204", "interval": 30, "timeout": 5000, "lazy": false}));
    }

    let v6 = n.ipv6 == "tunnel";
    if v6 {
        // Свои адреса в локальной сети (fe80::, fc00::) — мимо туннеля, как LAN.
        exclude.extend(["fe80::/10".to_string(), "fc00::/7".to_string()]);
    }
    let mut cfg = json!({
        "mode": "rule",
        "log-level": "warning",
        "ipv6": v6,
        "allow-lan": false,
        "bind-address": "127.0.0.1",
        "mixed-port": n.mixed_port,
        "interface-name": n.interface,
        // Имя процесса у соединений — для «Кто ест туннель».
        "find-process-mode": "always",
        // Закрепление точки (умный выбор, удержание при скачках) живёт до
        // перезапуска: иначе после «Применить» с новым порядком точек движок
        // держал бы прежнюю.
        "profile": { "store-selected": false },
        "external-controller": CONTROLLER,
        "secret": n.secret,
        "proxies": proxies,
        "proxy-groups": groups,
        "rules": rules,
        "dns": {
            "enable": true,
            "listen": "127.0.0.1:1053",
            "ipv6": false,
            "enhanced-mode": if n.real_ip { "redir-host" } else { "fake-ip" },
            "fake-ip-range": "198.18.0.1/16",
            "nameserver": [format!("https://1.1.1.1/dns-query#{GROUP}"), format!("https://8.8.8.8/dns-query#{GROUP}")],
            // Прямые соединения (правила «напрямую», пауза) резолвятся мимо
            // туннеля: на паузе сайты открываются, даже если профиль упал.
            "direct-nameserver": ["https://77.88.8.8/dns-query", "https://1.1.1.1/dns-query"]
        },
        "tun": {
            "enable": true,
            "device": n.tun_device,
            "stack": "gvisor",
            "auto-route": true,
            "auto-detect-interface": true,
            "strict-route": true,
            "dns-hijack": ["any:53", "tcp://any:53"],
            "route-exclude-address": exclude
        }
    });
    if cfg!(not(windows)) {
        cfg["routing-mark"] = json!(ROUTING_MARK);
    }
    if v6 {
        // Имена — через fake-ip IPv4 (DNS без AAAA); IPv6-адреса,
        // которые приложения набирают напрямую, идут в туннель, а не в блок.
        cfg["tun"]["inet6-address"] = json!([TUN_INET6]);
    }
    if selective || !providers.is_empty() {
        cfg["rule-providers"] = Value::Object(providers);
    }
    if selective {
        // Прямой трафик резолвится напрямую (российский DoH даёт ближние CDN);
        // туннельному DNS не нужен — имя уходит на сервер, тот резолвит сам.
        cfg["dns"]["nameserver"] = json!(["https://77.88.8.8/dns-query", "https://1.1.1.1/dns-query"]);
    }
    if n.real_ip {
        let tunnel = json!([format!("https://1.1.1.1/dns-query#{DNS_GROUP}"), format!("https://8.8.8.8/dns-query#{DNS_GROUP}")]);
        let direct = json!(["https://77.88.8.8/dns-query", "https://1.1.1.1/dns-query"]);
        // Имена без правила — путём «всего остального»: через туннель, на
        // «только выбранном» — напрямую.
        if !selective {
            cfg["dns"]["nameserver"] = tunnel.clone();
        }
        let policy: serde_json::Map<String, Value> = dns_policy.into_iter().map(|(k, t)| (k, if t { tunnel.clone() } else { direct.clone() })).collect();
        if !policy.is_empty() {
            cfg["dns"]["nameserver-policy"] = Value::Object(policy);
        }
        // Сайт для правил — по самому соединению: у разных сайтов на одном
        // CDN общий IP, и запись DNS не скажет, какой из них открывают.
        cfg["sniffer"] = json!({
            "enable": true, "force-dns-mapping": true, "parse-pure-ip": true, "override-destination": false,
            "sniff": {"TLS": {"ports": [443, 8443]}, "HTTP": {"ports": [80, 8080]}, "QUIC": {"ports": [443]}}
        });
    }
    if any_domain {
        // Имена серверов движок резолвит сам, мимо туннеля и fake-ip — DoH.
        // При роутерном kill switch нужен IP: до 1.1.1.1 роутер не пустит.
        cfg["dns"]["proxy-server-nameserver"] = json!(["https://1.1.1.1/dns-query", "https://8.8.8.8/dns-query"]);
    }
    Ok(cfg)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prof(primary: &str, fallback: bool) -> Profile {
        Profile {
            id: "a".into(), name: "A".into(), server: "1.2.3.4".into(),
            http_port: Some(100), socks_port: Some(101), username: "u".into(),
            password_enc: crate::profiles::encrypt("pw").unwrap(), primary: primary.into(), fallback,
            ..Default::default()
        }
    }

    fn chain(st: &crate::profiles::Store, p: &Profile) -> Chain {
        crate::profiles::chain_of(st, p).unwrap()
    }

    /// Настоящие адреса: имя сайта из правила узнаётся тем же путём, что и
    /// его трафик; без правила — путём «всего остального»; VPN упал — DNS
    /// напрямую (группа DNS-OUT), сайт для правил — по соединению.
    #[test]
    fn real_ip_dns_follows_rules() {
        let st = crate::profiles::Store::default();
        let rule = |kind: &str, value: &str, target: &str| RouteRule { kind: kind.into(), value: value.into(), target: target.into(), ..Default::default() };
        let mut n = NetSettings { secret: "s".into(), lists: vec![], ..Default::default() };
        n.rules = vec![rule("site", "Example.ORG", "direct"), rule("site", "example.org", "main"), rule("site", "vpn.example", "main"), rule("list", "ru-inside", "main"), rule("site", "ads.example", "block")];
        let c = build(&chain(&st, &prof("http", true)), &n).unwrap();
        let pol = c["dns"]["nameserver-policy"].as_object().unwrap();
        let via = |k: &str| pol[k][0].as_str().unwrap().to_string();
        assert!(via("+.example.org").contains("77.88.8.8"), "первое правило решает");
        assert!(via("+.vpn.example").ends_with(&format!("#{DNS_GROUP}")));
        assert!(via("rule-set:ru-inside").ends_with(&format!("#{DNS_GROUP}")));
        assert!(!pol.contains_key("+.ads.example"));
        assert!(c["dns"]["nameserver"][0].as_str().unwrap().ends_with(&format!("#{DNS_GROUP}")));
        let g = c["proxy-groups"].as_array().unwrap().iter().find(|g| g["name"] == DNS_GROUP).unwrap();
        assert_eq!((g["type"].as_str(), g["proxies"][1].as_str()), (Some("fallback"), Some("DIRECT")));
        assert_eq!(c["sniffer"]["enable"], true);
        // «Только выбранное»: без правила — напрямую.
        let c = build(&chain(&st, &prof("http", true)), &NetSettings { mode: "apps".into(), ..n.clone() }).unwrap();
        assert!(c["dns"]["nameserver"][0].as_str().unwrap().contains("77.88.8.8"));
    }

    #[test]
    fn builds_fallback_group_http_first() {
        let n = NetSettings { direct: vec!["5.6.7.8".into()], secret: "s".into(), ..Default::default() };
        let st = crate::profiles::Store::default();
        let c = build(&chain(&st, &prof("http", true)), &n).unwrap();
        assert_eq!(c["proxy-groups"][0]["type"], "fallback");
        assert_eq!(c["proxy-groups"][0]["proxies"][0], NAME_HTTP);
        assert_eq!(c["proxies"][1]["password"], "pw");
        let rules: Vec<&str> = c["rules"].as_array().unwrap().iter().map(|r| r.as_str().unwrap()).collect();
        assert!(rules.contains(&"IP-CIDR,5.6.7.8/32,DIRECT,no-resolve"));
        assert_eq!(rules[0], "DOMAIN,ipv6.msftconnecttest.com,REJECT");
        assert!(rules.contains(&"DOMAIN-SUFFIX,events.data.microsoft.com,REJECT"));
        assert_eq!(c["find-process-mode"], "always");
        // Закрепление точки не переживает перезапуск движка.
        assert_eq!(c["profile"]["store-selected"], false);
        // По умолчанию — настоящие адреса (ExitLag, античиты); выключено — fake-ip.
        assert_eq!(c["dns"]["enhanced-mode"], "redir-host");
        let c = build(&chain(&st, &prof("http", true)), &NetSettings { real_ip: false, ..n.clone() }).unwrap();
        assert_eq!(c["dns"]["enhanced-mode"], "fake-ip");
        assert!(c.get("sniffer").is_none() && c["dns"].get("nameserver-policy").is_none());
        assert_eq!(*rules.last().unwrap(), "MATCH,PROXY");
        let ex = c["tun"]["route-exclude-address"].as_array().unwrap();
        assert!(ex.iter().any(|x| x == "1.2.3.4/32"));
        assert_eq!(c["tun"]["strict-route"], true);
    }

    #[test]
    fn protection_modes() {
        let st = crate::profiles::Store::default();
        let ch = chain(&st, &prof("http", true));
        let rules = |c: &Value| -> Vec<String> { c["rules"].as_array().unwrap().iter().map(|r| r.as_str().unwrap().to_string()).collect() };
        let rule = |kind: &str, value: &str, target: &str| RouteRule { kind: kind.into(), value: value.into(), target: target.into(), ..Default::default() };
        // Всё остальное напрямую: в рабочий профиль — только приложения из правил.
        let n = NetSettings {
            mode: "apps".into(),
            rules: vec![rule("app", "chrome.exe", "main"), rule("app", r"C:\Apps\Claude\claude.exe", "main"), rule("site", "Example.org", "direct")],
            secret: "s".into(),
            ..Default::default()
        };
        let c = build(&ch, &n).unwrap();
        let r = rules(&c);
        assert!(r.contains(&"PROCESS-NAME,chrome.exe,PROXY".to_string()));
        assert!(r.contains(&r"PROCESS-PATH,C:\Apps\Claude\claude.exe,PROXY".to_string()));
        // HTTP-прокси UDP не передаёт — UDP этого приложения отклоняется, а не уходит напрямую.
        assert!(r.contains(&"AND,((PROCESS-NAME,chrome.exe),(NETWORK,udp)),REJECT".to_string()));
        assert!(r.contains(&"DOMAIN-SUFFIX,example.org,DIRECT".to_string()));
        assert_eq!(r.last().unwrap(), "MATCH,DIRECT");
        assert_eq!(c["rule-providers"].as_object().unwrap().len(), 0);
        // Наборы: домены и списки; списки движок качает через туннель.
        let n = NetSettings { mode: "blocked".into(), rules: vec![rule("preset", "blocked", "main"), rule("preset", "telegram", "main")], secret: "s".into(), ..Default::default() };
        let c = build(&ch, &n).unwrap();
        let r = rules(&c);
        assert!(r.contains(&"RULE-SET,ru-inside,PROXY".to_string()));
        assert!(r.contains(&"RULE-SET,telegram-ip,PROXY,no-resolve".to_string()));
        assert!(r.contains(&"DOMAIN-SUFFIX,t.me,PROXY".to_string()));
        assert_eq!(c["rule-providers"]["telegram-ip"]["behavior"], "ipcidr");
        assert_eq!(c["rule-providers"]["ru-inside"]["proxy"], "PROXY");
        assert_eq!(r.last().unwrap(), "MATCH,DIRECT");
        // Discord — только его собственные сети, без Cloudflare и Google Cloud из чужого списка.
        let n = NetSettings { rules: vec![rule("preset", "discord", "main")], secret: "s".into(), ..Default::default() };
        let c = build(&ch, &n).unwrap();
        assert!(rules(&c).contains(&"RULE-SET,discord-ip,PROXY,no-resolve".to_string()));
        let p = &c["rule-providers"]["discord-ip"];
        assert_eq!((p["type"].as_str(), p["payload"].as_array().map(|a| a.len())), (Some("inline"), Some(3)));
        assert!(!p["payload"].to_string().contains("104.16.0.0"));
        // Строгий: всё через туннель.
        let c = build(&ch, &NetSettings { secret: "s".into(), ..Default::default() }).unwrap();
        assert_eq!(rules(&c).last().unwrap(), "MATCH,PROXY");
        assert!(c.get("rule-providers").is_none());
    }

    #[test]
    fn rules_send_apps_to_other_profiles() {
        let p = |l: &str| crate::profiles::proto::parse(l).unwrap();
        let mut st = crate::profiles::Store::default();
        let vpn = crate::profiles::import_endpoints(&mut st, "Хельсинки", &[p("vless://u@1.1.1.1:443?security=reality&pbk=K")], "auto").unwrap();
        let main = chain(&st, &prof("http", true));
        let x = Extra {
            group: "X0".into(),
            tag: "x0".into(),
            name: "Хельсинки".into(),
            chain: chain(&st, &st.profiles.iter().find(|q| q.id == vpn).unwrap().clone()),
        };
        let rule = |kind: &str, value: &str, target: &str| RouteRule { kind: kind.into(), value: value.into(), target: target.into(), ..Default::default() };
        let n = NetSettings {
            rules: vec![rule("app", "brave.exe", &format!("profile:{vpn}")), rule("preset", "ai", &format!("profile:{vpn}")), rule("app", "torrent.exe", "block")],
            secret: "s".into(),
            ..Default::default()
        };
        let c = build_with(&main, &n, &[x], None, &[]).unwrap();
        let r: Vec<String> = c["rules"].as_array().unwrap().iter().map(|r| r.as_str().unwrap().to_string()).collect();
        assert!(r.contains(&"PROCESS-NAME,brave.exe,X0".to_string()));
        assert!(r.contains(&"DOMAIN-SUFFIX,claude.ai,X0".to_string()));
        assert!(r.contains(&"PROCESS-NAME,torrent.exe,REJECT".to_string()));
        // VLESS передаёт UDP — для brave UDP не отклоняется.
        assert!(!r.iter().any(|x| x.contains("brave.exe),(NETWORK,udp")));
        assert_eq!(r.last().unwrap(), "MATCH,PROXY");
        // Игровой режим: игра впереди правил; вход — тем же путём, только если включён.
        let ex = || Extra { group: "X0".into(), tag: "x0".into(), name: "Хельсинки".into(), chain: chain(&st, &st.profiles.iter().find(|q| q.id == vpn).unwrap().clone()) };
        let game = |login: bool| GameMode { on: true, game: "dota2".into(), name: "Dota 2".into(), apps: vec!["dota2.exe".into()], dir: r"D:\Games\Aion 2".into(), login, launchers: vec!["steam.exe".into()], domains: vec!["steampowered.com".into()], target: format!("profile:{vpn}"), udp_only: false };
        let g = NetSettings { game: game(true), ..n.clone() };
        let c = build_with(&main, &g, &[ex()], None, &[]).unwrap();
        let r: Vec<String> = c["rules"].as_array().unwrap().iter().map(|r| r.as_str().unwrap().to_string()).collect();
        let at = |s: &str| r.iter().position(|x| x == s);
        assert!(at("PROCESS-NAME,dota2.exe,X0").unwrap() < at("PROCESS-NAME,brave.exe,X0").unwrap());
        assert!(at("PROCESS-NAME,steam.exe,X0").is_some() && at("DOMAIN-SUFFIX,steampowered.com,X0").is_some());
        assert!(at(r"PROCESS-PATH-REGEX,(?i)^D:\\Games\\Aion 2\\.+,X0").is_some(), "папка игры");
        let g = NetSettings { game: game(false), ..n.clone() };
        let r: Vec<String> = build_with(&main, &g, &[ex()], None, &[]).unwrap()["rules"].as_array().unwrap().iter().map(|r| r.as_str().unwrap().to_string()).collect();
        assert!(r.contains(&"PROCESS-NAME,dota2.exe,X0".to_string()) && !r.iter().any(|x| x.contains("steam.exe")));
        let g: Vec<&str> = c["proxy-groups"].as_array().unwrap().iter().map(|g| g["name"].as_str().unwrap()).collect();
        assert_eq!(g, vec!["PROXY", "X0", DNS_GROUP]);
        assert!(c["proxies"].as_array().unwrap().iter().any(|p| p["name"] == "wpx-x0-0" && p["server"] == "1.1.1.1"));
        // Сервер VPN из правил — тоже первое звено: мимо туннеля.
        assert!(c["tun"]["route-exclude-address"].as_array().unwrap().iter().any(|x| x == "1.1.1.1/32"));
    }

    #[test]
    fn game_udp_only_uses_udp_points() {
        let p = |l: &str| crate::profiles::proto::parse(l).unwrap();
        let mut st = crate::profiles::Store::default();
        let id = crate::profiles::import_endpoints(&mut st, "H", &[p("vless://u@1.1.1.1:443?security=reality&pbk=K"), p("hysteria2://pw@1.1.1.1:8443?sni=x")], "auto").unwrap();
        let tcp = crate::profiles::import_endpoints(&mut st, "T", &[p("vless://u@2.2.2.2:443?security=reality&pbk=K")], "auto").unwrap();
        let prof = |id: &str| st.profiles.iter().find(|x| x.id == id).unwrap().clone();
        let mut n = NetSettings { secret: "s".into(), ..Default::default() };
        n.game = GameMode { on: true, game: "aa".into(), name: "ArcheAge".into(), apps: vec!["archeage.exe".into()], target: "main".into(), udp_only: true, ..Default::default() };
        let c = build(&chain(&st, &prof(&id)), &n).unwrap();
        let g = c["proxy-groups"].as_array().unwrap().iter().find(|g| g["name"] == GAME_GROUP).expect("группа игры");
        let names: Vec<&str> = g["proxies"].as_array().unwrap().iter().filter_map(|x| x.as_str()).collect();
        // Только Hysteria2: VLESS сам ходит по TCP.
        assert_eq!(names.len(), 1);
        assert_eq!(c["proxies"].as_array().unwrap().iter().find(|x| x["name"] == names[0]).unwrap()["type"], "hysteria2");
        assert!(c["rules"].as_array().unwrap().iter().any(|r| r == "PROCESS-NAME,archeage.exe,GAME"));
        // В профиле нет UDP-точек — игра идёт обычной группой.
        let c = build(&chain(&st, &prof(&tcp)), &n).unwrap();
        assert!(!c["proxy-groups"].as_array().unwrap().iter().any(|g| g["name"] == GAME_GROUP));
        assert!(c["rules"].as_array().unwrap().iter().any(|r| r == "PROCESS-NAME,archeage.exe,PROXY"));
        // Игра напрямую — мимо VPN, UDP-точки ни при чём.
        n.game.target = "direct".into();
        let c = build(&chain(&st, &prof(&id)), &n).unwrap();
        assert!(c["rules"].as_array().unwrap().iter().any(|r| r == "PROCESS-NAME,archeage.exe,DIRECT"));
    }

    #[test]
    fn route_builds_group_of_groups() {
        let p = |l: &str| crate::profiles::proto::parse(l).unwrap();
        let mut st = crate::profiles::Store::default();
        let a = crate::profiles::import_endpoints(&mut st, "A", &[p("vless://u@1.1.1.1:443?security=reality&pbk=K")], "auto").unwrap();
        let b = crate::profiles::import_endpoints(&mut st, "B", &[p("hysteria2://pw@2.2.2.2:443?sni=x")], "auto").unwrap();
        let c = crate::profiles::upsert_cascade(&mut st, None, "A → B", &a, &b).unwrap();
        let r = crate::profiles::upsert_route(&mut st, None, "R", &[c, b], "auto").unwrap();
        let rp = st.profiles.iter().find(|x| x.id == r).unwrap().clone();
        let cfg = build(&chain(&st, &rp), &NetSettings { secret: "s".into(), ..Default::default() }).unwrap();
        let g = cfg["proxy-groups"].as_array().unwrap();
        assert_eq!(g[0]["name"], GROUP);
        assert_eq!(g[0]["type"], "url-test");
        assert_eq!(g[0]["proxies"], json!(["R0", "R1"]));
        let px = cfg["proxies"].as_array().unwrap();
        let hy = px.iter().find(|x| x["name"] == "wpx-r0-0").unwrap();
        assert_eq!(hy["dialer-proxy"], "R0-ENTRY");
        assert!(px.iter().any(|x| x["name"] == "wpx-r1-0" && x.get("dialer-proxy").is_none()));
        let ex = cfg["tun"]["route-exclude-address"].as_array().unwrap();
        assert!(ex.iter().any(|x| x == "1.1.1.1/32") && ex.iter().any(|x| x == "2.2.2.2/32"));
    }

    #[test]
    fn reserve_and_sticky_ip() {
        let p = |l: &str| crate::profiles::proto::parse(l).unwrap();
        let mut st = crate::profiles::Store::default();
        let v = crate::profiles::import_endpoints(&mut st, "V", &[p("vless://u@1.1.1.1:443?security=reality&pbk=K"), p("hysteria2://pw@1.1.1.1:443?sni=x")], "auto").unwrap();
        let x = crate::profiles::import_endpoints(&mut st, "X", &[p("socks5://u:p@3.3.3.3:1080")], "auto").unwrap();
        let get = |id: &str| st.profiles.iter().find(|q| q.id == id).unwrap().clone();
        let main = chain(&st, &get(&v));
        let rsv = Extra { group: RESERVE_GROUP.into(), tag: "rsv".into(), name: "X".into(), chain: chain(&st, &get(&x)) };
        let sticky = vec![Sticky { group: "IP0".into(), ip: "1.1.1.1".into(), name: "V".into(), eps: main.exit.iter().enumerate().map(|(i, (_, e))| (format!("wpx-ip0-{i}"), e.clone())).collect() }];
        let n = NetSettings {
            secret: "s".into(),
            rules: vec![RouteRule { kind: "preset".into(), value: "ai".into(), target: "exit:1.1.1.1".into(), ..Default::default() }],
            ..Default::default()
        };
        let c = build_with(&main, &n, &[], Some(&rsv), &sticky).unwrap();
        let g = c["proxy-groups"].as_array().unwrap();
        // PROXY: рабочий, а если он мёртв — резерв; первой группой (по ней монитор).
        assert_eq!((g[0]["name"].as_str(), g[0]["type"].as_str()), (Some(GROUP), Some("fallback")));
        assert_eq!(g[0]["proxies"], json!([MAIN_GROUP, RESERVE_GROUP]));
        assert!(g.iter().any(|x| x["name"] == MAIN_GROUP && x["type"] == "url-test"));
        assert!(g.iter().any(|x| x["name"] == RESERVE_GROUP && x["proxies"] == json!(["wpx-rsv-0"])));
        let ip0 = g.iter().find(|x| x["name"] == "IP0").unwrap();
        assert_eq!(ip0["proxies"], json!(["wpx-ip0-0", "wpx-ip0-1"]));
        let rules: Vec<&str> = c["rules"].as_array().unwrap().iter().map(|r| r.as_str().unwrap()).collect();
        assert!(rules.contains(&"DOMAIN-SUFFIX,openai.com,IP0") || rules.iter().any(|r| r.ends_with(",IP0")));
        assert!(rules.contains(&"MATCH,PROXY"));
        let ex = c["tun"]["route-exclude-address"].as_array().unwrap();
        assert!(ex.iter().any(|x| x == "3.3.3.3/32") && ex.iter().any(|x| x == "1.1.1.1/32"));
        // Без резерва рабочая группа называется PROXY.
        let c = build_with(&main, &NetSettings { secret: "s".into(), ..Default::default() }, &[], None, &[]).unwrap();
        assert_eq!(c["proxy-groups"][0]["name"], GROUP);
        assert!(!c["proxy-groups"].as_array().unwrap().iter().any(|x| x["name"] == MAIN_GROUP));
    }

    #[test]
    fn udp_follows_exits() {
        let mut st = crate::profiles::Store::default();
        let id = crate::profiles::import_endpoints(&mut st, "V", &[crate::profiles::proto::parse("vless://u@1.2.3.4:443?security=reality&pbk=K").unwrap()], "auto").unwrap();
        let p = st.profiles.iter().find(|p| p.id == id).unwrap().clone();
        let ch = chain(&st, &p);
        let rules = |n: &NetSettings| -> Vec<String> { build(&ch, n).unwrap()["rules"].as_array().unwrap().iter().map(|r| r.as_str().unwrap().to_string()).collect() };
        let base = NetSettings { secret: "s".into(), ..Default::default() };
        // VPN передаёт UDP — «авто» не блокирует.
        assert!(!rules(&base).iter().any(|r| r.contains("udp")));
        let quic = rules(&NetSettings { block_quic: true, ..base.clone() });
        assert!(quic.contains(&"AND,((NETWORK,udp),(DST-PORT,443)),REJECT".to_string()));
        assert!(rules(&NetSettings { udp: "block".into(), ..base.clone() }).contains(&"NETWORK,udp,REJECT".to_string()));
        // HTTP-прокси UDP не передаёт — «авто» блокирует.
        let px = build(&chain(&st, &prof("http", true)), &base).unwrap();
        assert!(px["rules"].as_array().unwrap().iter().any(|r| r == "NETWORK,udp,REJECT"));
    }

    #[test]
    fn names_for_admin_scripts_validated() {
        let mut n = NetSettings::default();
        for bad in ["Wi-Fi\u{2019}; calc", "eth0\nadd rule", "a\"b"] {
            n.interface = bad.into();
            assert!(validate(&n).is_err(), "{bad:?}");
        }
        n.interface = if cfg!(windows) { "Беспроводная сеть 2".into() } else { "wlp2s0".into() };
        validate(&n).unwrap();
        n.tun_device = "wpx\nx".into();
        assert!(validate(&n).is_err());
        n.tun_device = "wpx".into();
        // Найденное на лету — строкой в файл правил движка: перевод строки нельзя.
        n.rules.push(RouteRule { kind: "app".into(), value: "a.exe".into(), target: "main".into(), follow: true, learned: vec!["app:b.exe\nMATCH,DIRECT".into()] });
        assert!(validate(&n).is_err());
        assert_eq!(follow_lines(&n.rules[0]), "");
    }

    #[test]
    fn russian_sites_go_direct() {
        let st = crate::profiles::Store::default();
        let mut n = NetSettings::default();
        assert!(!n.lists.iter().any(|l| l == "ru-outside"), "российские сайты — не в туннель");
        n.rules.push(RouteRule { kind: "preset".into(), value: "ru".into(), target: "direct".into(), ..Default::default() });
        validate(&n).unwrap();
        let c = build(&chain(&st, &prof("socks5", false)), &n).unwrap();
        let rules: Vec<&str> = c["rules"].as_array().unwrap().iter().filter_map(|r| r.as_str()).collect();
        for want in ["DOMAIN-SUFFIX,ru,DIRECT", "DOMAIN-SUFFIX,xn--p1ai,DIRECT", "RULE-SET,ru-outside,DIRECT"] {
            assert!(rules.contains(&want), "{want}: {rules:?}");
        }
    }

    #[test]
    fn user_set_becomes_rules() {
        let st = crate::profiles::Store::default();
        let mut n = NetSettings { mode: "apps".into(), ..NetSettings::default() };
        n.sets.push(UserSet { id: "u1".into(), name: "Игра".into(), items: vec!["game.example".into(), "203.0.113.0/24".into(), "198.51.100.7".into()] });
        n.rules.push(RouteRule { kind: "preset".into(), value: "u1".into(), target: "main".into(), ..Default::default() });
        validate(&n).unwrap();
        let c = build(&chain(&st, &prof("socks5", false)), &n).unwrap();
        let rules: Vec<&str> = c["rules"].as_array().unwrap().iter().filter_map(|r| r.as_str()).collect();
        for want in ["DOMAIN-SUFFIX,game.example,PROXY", "IP-CIDR,203.0.113.0/24,PROXY,no-resolve", "IP-CIDR,198.51.100.7/32,PROXY,no-resolve"] {
            assert!(rules.iter().any(|r| r.ends_with(want)), "{want}: {rules:?}");
        }
        n.sets[0].items.push("не адрес".into());
        assert!(validate(&n).unwrap_err().contains("не адрес"));
        n.sets[0].items.pop();
        n.sets[0].id = "youtube".into();
        assert!(validate(&n).is_err());
    }

    #[test]
    fn single_proxy_uses_select() {
        let st = crate::profiles::Store::default();
        let c = build(&chain(&st, &prof("socks5", false)), &NetSettings::default()).unwrap();
        assert_eq!(c["proxies"].as_array().unwrap().len(), 1);
        assert_eq!(c["proxies"][0]["type"], "socks5");
        assert_eq!(c["proxy-groups"][0]["type"], "select");
    }

    #[test]
    fn vpn_profile_auto_mode_and_domain_server() {
        let eps = vec![
            crate::profiles::proto::parse("vless://u@vpn.example:443?security=reality&pbk=K&sid=1&sni=www.microsoft.com#v").unwrap(),
            crate::profiles::proto::parse("hy2://p@203.0.113.9:8443/?insecure=1#h").unwrap(),
        ];
        let mut st = crate::profiles::Store::default();
        let id = crate::profiles::import_endpoints(&mut st, "VPN", &eps, "auto").unwrap();
        let p = st.profiles.iter().find(|p| p.id == id).unwrap();
        let c = build(&chain(&st, p), &NetSettings::default()).unwrap();
        assert_eq!(c["proxy-groups"][0]["type"], "url-test");
        assert_eq!(c["proxies"][0]["type"], "vless");
        assert_eq!(c["proxies"][1]["type"], "hysteria2");
        // Домен сервера — DoH для его адреса; IP — в route-exclude.
        assert!(c["dns"]["proxy-server-nameserver"].is_array());
        let ex = c["tun"]["route-exclude-address"].as_array().unwrap();
        assert!(ex.iter().any(|x| x == "203.0.113.9/32"));
    }

    #[test]
    fn cascade_uses_dialer_proxy_and_excludes_only_entry() {
        let mut st = crate::profiles::Store::default();
        let sg = crate::profiles::import_endpoints(&mut st, "SG", &[crate::profiles::proto::parse("vless://a@203.0.113.10:443?security=reality&pbk=K#sg").unwrap()], "fallback").unwrap();
        let ex = crate::profiles::import_endpoints(&mut st, "EX", &[crate::profiles::proto::parse("vless://b@198.51.100.20:443?security=reality&pbk=K#ex").unwrap()], "fallback").unwrap();
        let c = crate::profiles::upsert_cascade(&mut st, None, "SG → EX", &sg, &ex).unwrap();
        let p = st.profiles.iter().find(|p| p.id == c).unwrap();
        let cfg = build(&chain(&st, p), &NetSettings::default()).unwrap();
        let proxies = cfg["proxies"].as_array().unwrap();
        assert_eq!(proxies[0]["name"], "wpx-in-0");
        assert!(proxies[0].get("dialer-proxy").is_none());
        assert_eq!(proxies[1]["name"], "wpx-0");
        assert_eq!(proxies[1]["dialer-proxy"], ENTRY_GROUP);
        assert_eq!(cfg["proxy-groups"][1]["name"], ENTRY_GROUP);
        let ex_list = cfg["tun"]["route-exclude-address"].as_array().unwrap();
        assert!(ex_list.iter().any(|x| x == "203.0.113.10/32"));
        assert!(!ex_list.iter().any(|x| x == "198.51.100.20/32"));
    }

    #[test]
    fn cidr_validation() {
        assert!(valid_cidr("192.168.1.0/24") && valid_cidr("8.8.8.8"));
        assert!(valid_domain("io") && valid_domain("xn--p1ai") && valid_domain("example.org"));
        assert!(!valid_domain("a") && !valid_domain("42") && !valid_domain("ex ample.org"));
        assert!(!valid_cidr("192.168.1.0/33") && !valid_cidr("host.local"));
    }
}
