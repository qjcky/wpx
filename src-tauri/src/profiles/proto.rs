//! Протоколы подключения: модель «точки подключения», разбор ссылок
//! (`vless://`, `hysteria2://`, `trojan://`, `ss://`, `http://`, `socks5://`)
//! и конфигов AmneziaWG, сборка секции прокси для mihomo.
//!
//! Всё здесь — чистые функции без ввода-вывода: их проверяют тесты, а
//! пригодность итогового конфига — `mihomo -t` (см. sandbox).
//!
//! Поля mihomo взяты из wiki.metacubex.one (proxies/vless, hysteria2, wg,
//! tls, transport). Секреты (uuid, пароли, ключи) лежат отдельно от
//! открытых параметров: в профиле они хранятся только зашифрованными.

use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Http,
    Socks5,
    Vless,
    Hysteria2,
    Trojan,
    Shadowsocks,
    /// AmneziaWG (обфусцированный WireGuard); без параметров — обычный WireGuard.
    Awg,
}

impl Kind {
    pub fn label(self) -> &'static str {
        match self {
            Kind::Http => "HTTP",
            Kind::Socks5 => "SOCKS5",
            Kind::Vless => "VLESS",
            Kind::Hysteria2 => "Hysteria2",
            Kind::Trojan => "Trojan",
            Kind::Shadowsocks => "Shadowsocks",
            Kind::Awg => "AmneziaWG",
        }
    }
    /// Пропускает UDP (звонки, игры, QUIC).
    pub fn udp(self) -> bool {
        !matches!(self, Kind::Http | Kind::Socks5)
    }
    /// Сам ходит к серверу по UDP: в каскаде такому выходу нужен вход,
    /// который передаёт UDP.
    pub fn over_udp(self) -> bool {
        matches!(self, Kind::Hysteria2 | Kind::Awg)
    }
}

/// Одна точка подключения: протокол + сервер + параметры.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Endpoint {
    pub kind: Kind,
    /// Подпись для людей (из `#имени` ссылки или сгенерированная).
    pub label: String,
    pub server: String,
    pub port: u16,
    /// Открытые параметры — уже в терминах mihomo (`servername`, `reality-opts`…).
    #[serde(default)]
    pub params: Map<String, Value>,
    /// Секреты в терминах mihomo (`uuid`, `password`, `private-key`…).
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub secrets: Map<String, Value>,
}

impl Endpoint {
    fn new(kind: Kind, server: &str, port: u16) -> Self {
        Self {
            kind,
            label: String::new(),
            server: server.trim_matches(|c| c == '[' || c == ']').to_string(),
            port,
            params: Map::new(),
            secrets: Map::new(),
        }
    }

    /// Человеческое описание: «VLESS · Reality · 1.2.3.4:443».
    pub fn summary(&self) -> String {
        let tls = self.params.get("tls").and_then(|v| v.as_bool()).unwrap_or(false);
        let mut bits = vec![match self.kind {
            Kind::Http if tls => "HTTPS".to_string(),
            Kind::Socks5 if tls => "SOCKS5+TLS".to_string(),
            k => k.label().to_string(),
        }];
        if self.params.contains_key("reality-opts") {
            bits.push("Reality".into());
        }
        if let Some(n) = self.params.get("network").and_then(|v| v.as_str()) {
            if n != "tcp" {
                bits.push(n.to_string());
            }
        }
        if self.params.contains_key("amnezia-wg-option") {
            bits.push("обфускация".into());
        } else if self.kind == Kind::Awg {
            bits.push("без обфускации".into());
        }
        bits.push(format!("{}:{}", self.server, self.port));
        bits.join(" · ")
    }
}

// ─── Разбор ──────────────────────────────────────────────────────

fn dec(s: &str) -> String {
    percent_decode_str(s).decode_utf8_lossy().into_owned()
}

fn q(u: &url::Url, k: &str) -> Option<String> {
    u.query_pairs().find(|(a, _)| a == k).map(|(_, v)| v.into_owned()).filter(|v| !v.is_empty())
}

fn truthy(v: Option<String>) -> bool {
    matches!(v.as_deref(), Some("1") | Some("true") | Some("yes"))
}

fn host_port(u: &url::Url) -> Result<(String, u16), String> {
    let host = u.host_str().ok_or("в ссылке нет адреса сервера")?.to_string();
    let port = u.port_or_known_default().ok_or("в ссылке нет порта")?;
    Ok((host, port))
}

fn label_of(u: &url::Url, ep: &Endpoint) -> String {
    u.fragment().map(dec).filter(|s| !s.trim().is_empty()).unwrap_or_else(|| ep.summary())
}

/// Разобрать одну ссылку или конфиг AmneziaWG (по содержимому).
pub fn parse(input: &str) -> Result<Endpoint, String> {
    let s = input.trim();
    if s.contains("[Interface]") {
        return parse_awg_conf(s);
    }
    let scheme = s.split("://").next().unwrap_or("").to_ascii_lowercase();
    match scheme.as_str() {
        "vless" => parse_vless(s),
        "hysteria2" | "hy2" => parse_hy2(s),
        "trojan" => parse_trojan(s),
        "ss" => parse_ss(s),
        "http" | "https" | "socks5" | "socks5h" | "socks" => parse_basic(s),
        "vpn" => parse_amnezia(s).into_iter().next().unwrap_or_else(|| Err("пустая ссылка vpn://".into())),
        "" => Err("Не похоже на ссылку: нет схемы вида vless://".into()),
        other => Err(format!("Протокол «{other}» не поддерживается")),
    }
}

/// Разобрать сразу много ссылок (по строке на ссылку; конфиг AWG — целиком).
pub fn parse_many(input: &str) -> Vec<Result<Endpoint, String>> {
    if input.contains("[Interface]") {
        return vec![parse_awg_conf(input)];
    }
    input
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .flat_map(|l| if l.starts_with("vpn://") { parse_amnezia(l) } else { vec![parse(l)] })
        .collect()
}

// ─── Ссылки AmneziaVPN ───────────────────────────────────────────

/// `vpn://…` из AmneziaVPN («Поделиться доступом»): base64url(qCompress(JSON)).
/// Внутри — контейнеры сервера с готовыми клиентскими конфигами; из каждого
/// получается своя точка подключения.
pub fn parse_amnezia(s: &str) -> Vec<Result<Endpoint, String>> {
    let j = match amnezia_json(s) {
        Ok(j) => j,
        Err(e) => return vec![Err(e)],
    };
    let host = j["hostName"].as_str().unwrap_or("").to_string();
    let desc = j["description"].as_str().filter(|d| !d.trim().is_empty()).unwrap_or("AmneziaVPN").to_string();
    let mut out = vec![];
    for c in j["containers"].as_array().cloned().unwrap_or_default() {
        let name = c["container"].as_str().unwrap_or("?").to_string();
        for (key, p) in c.as_object().into_iter().flatten() {
            let Some(last) = p.get("last_config").and_then(Value::as_str) else { continue };
            let r = match key.as_str() {
                "awg" | "wireguard" => amnezia_wg(last, &host),
                "xray" => amnezia_xray(last),
                other => Err(format!("{name}: протокол «{other}» из AmneziaVPN пока не поддерживается")),
            };
            out.push(r.map(|mut e| {
                e.label = format!("{desc} · {}", e.kind.label());
                e
            }));
        }
    }
    if out.is_empty() {
        out.push(Err("в ссылке AmneziaVPN нет клиентских конфигов — поделитесь доступом в приложении Amnezia заново".into()));
    }
    out
}

fn amnezia_json(s: &str) -> Result<Value, String> {
    use base64::Engine as _;
    let body = s.trim().trim_start_matches("vpn://").trim_end_matches('=');
    let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(body)
        .map_err(|_| "ссылка vpn:// повреждена (не base64)")?;
    // qCompress: 4 байта длины (big-endian) + поток zlib; бывает и без сжатия.
    let mut data = vec![];
    let unzipped = raw.len() > 4 && std::io::Read::read_to_end(&mut flate2::read::ZlibDecoder::new(&raw[4..]), &mut data).is_ok();
    serde_json::from_slice(if unzipped { &data } else { &raw }).map_err(|_| "ссылка vpn:// не распознана".into())
}

fn amnezia_wg(last: &str, host: &str) -> Result<Endpoint, String> {
    let j: Value = serde_json::from_str(last).map_err(|_| "конфиг AmneziaWG в ссылке не прочитан")?;
    let conf = j["config"].as_str().ok_or("в ссылке нет конфига AmneziaWG")?;
    // Подстановки, которые Amnezia заполняет при подключении: DNS у wpx свой.
    let conf = conf
        .replace("$PRIMARY_DNS", "1.1.1.1")
        .replace("$SECONDARY_DNS", "1.0.0.1")
        .replace("$SERVER_IP_ADDRESS", host);
    parse_awg_conf(&conf)
}

fn amnezia_xray(last: &str) -> Result<Endpoint, String> {
    let j: Value = serde_json::from_str(last).map_err(|_| "конфиг Xray в ссылке не прочитан")?;
    let ob = j["outbounds"]
        .as_array()
        .and_then(|a| a.iter().find(|o| o["protocol"] == "vless"))
        .ok_or("в конфиге Xray нет VLESS")?;
    let v = &ob["settings"]["vnext"][0];
    let u = &v["users"][0];
    let st = &ob["streamSettings"];
    let rs = &st["realitySettings"];
    let e = |x: &Value| percent_encoding::utf8_percent_encode(x.as_str().unwrap_or(""), percent_encoding::NON_ALPHANUMERIC).to_string();
    let link = format!(
        "vless://{}@{}:{}?security={}&sni={}&fp={}&pbk={}&sid={}&type={}&flow={}",
        e(&u["id"]),
        v["address"].as_str().unwrap_or(""),
        v["port"].as_u64().unwrap_or(443),
        e(&st["security"]),
        e(&rs["serverName"]),
        e(&rs["fingerprint"]),
        e(&rs["publicKey"]),
        e(&rs["shortId"]),
        if st["network"].is_string() { e(&st["network"]) } else { "tcp".into() },
        e(&u["flow"]),
    );
    parse_vless(&link)
}

fn parse_vless(s: &str) -> Result<Endpoint, String> {
    let u = url::Url::parse(s).map_err(|e| format!("ссылка vless: {e}"))?;
    let (host, port) = host_port(&u)?;
    let uuid = dec(u.username());
    if uuid.is_empty() {
        return Err("в ссылке vless нет UUID".into());
    }
    let mut ep = Endpoint::new(Kind::Vless, &host, port);
    ep.secrets.insert("uuid".into(), json!(uuid));
    let security = q(&u, "security").unwrap_or_default();
    let network = q(&u, "type").unwrap_or_else(|| "tcp".into());
    ep.params.insert("network".into(), json!(network));
    if let Some(flow) = q(&u, "flow") {
        ep.params.insert("flow".into(), json!(flow));
    }
    if security == "tls" || security == "reality" {
        ep.params.insert("tls".into(), json!(true));
        if let Some(sni) = q(&u, "sni") {
            ep.params.insert("servername".into(), json!(sni));
        }
        ep.params.insert("client-fingerprint".into(), json!(q(&u, "fp").unwrap_or_else(|| "chrome".into())));
        if let Some(alpn) = q(&u, "alpn") {
            ep.params.insert("alpn".into(), json!(alpn.split(',').collect::<Vec<_>>()));
        }
        if truthy(q(&u, "allowInsecure")) || truthy(q(&u, "insecure")) {
            ep.params.insert("skip-cert-verify".into(), json!(true));
        }
    }
    if security == "reality" {
        let pbk = q(&u, "pbk").ok_or("Reality без публичного ключа (pbk)")?;
        let mut ro = Map::new();
        ro.insert("public-key".into(), json!(pbk));
        if let Some(sid) = q(&u, "sid") {
            ro.insert("short-id".into(), json!(sid));
        }
        ep.params.insert("reality-opts".into(), Value::Object(ro));
    }
    match network.as_str() {
        "xhttp" | "splithttp" => {
            ep.params.insert("network".into(), json!("xhttp"));
            let mut o = Map::new();
            o.insert("path".into(), json!(q(&u, "path").unwrap_or_else(|| "/".into())));
            if let Some(h) = q(&u, "host") {
                o.insert("host".into(), json!(h));
            }
            if let Some(m) = q(&u, "mode") {
                o.insert("mode".into(), json!(m));
            }
            ep.params.insert("xhttp-opts".into(), Value::Object(o));
        }
        "ws" => {
            let mut o = Map::new();
            o.insert("path".into(), json!(q(&u, "path").unwrap_or_else(|| "/".into())));
            if let Some(h) = q(&u, "host") {
                o.insert("headers".into(), json!({ "Host": h }));
            }
            ep.params.insert("ws-opts".into(), Value::Object(o));
        }
        "grpc" => {
            let sn = q(&u, "serviceName").unwrap_or_default();
            ep.params.insert("grpc-opts".into(), json!({ "grpc-service-name": sn }));
        }
        _ => {}
    }
    ep.label = label_of(&u, &ep);
    Ok(ep)
}

fn parse_hy2(s: &str) -> Result<Endpoint, String> {
    // hy2:// — синоним hysteria2://; Url разбирает только «настоящие» схемы одинаково.
    let norm = if s.to_ascii_lowercase().starts_with("hy2://") { format!("hysteria2://{}", &s[6..]) } else { s.to_string() };
    let u = url::Url::parse(&norm).map_err(|e| format!("ссылка hysteria2: {e}"))?;
    let (host, port) = host_port(&u)?;
    // Пароль может быть «user:pass» (userpass-авторизация) — склеиваем обратно.
    let auth = match u.password() {
        Some(p) => format!("{}:{}", dec(u.username()), dec(p)),
        None => dec(u.username()),
    };
    if auth.is_empty() {
        return Err("в ссылке hysteria2 нет пароля".into());
    }
    let mut ep = Endpoint::new(Kind::Hysteria2, &host, port);
    ep.secrets.insert("password".into(), json!(auth));
    if let Some(sni) = q(&u, "sni") {
        ep.params.insert("sni".into(), json!(sni));
    }
    if truthy(q(&u, "insecure")) {
        ep.params.insert("skip-cert-verify".into(), json!(true));
    }
    if let Some(o) = q(&u, "obfs") {
        ep.params.insert("obfs".into(), json!(o));
        if let Some(op) = q(&u, "obfs-password") {
            ep.secrets.insert("obfs-password".into(), json!(op));
        }
    }
    if let Some(mport) = q(&u, "mport") {
        // Смена портов: клиент сам переходит на другой порт диапазона каждые 30 с.
        ep.params.insert("ports".into(), json!(mport));
        ep.params.insert("hop-interval".into(), json!(30));
    }
    if let Some(pin) = q(&u, "pinSHA256") {
        ep.params.insert("fingerprint".into(), json!(pin));
    }
    ep.label = label_of(&u, &ep);
    Ok(ep)
}

fn parse_trojan(s: &str) -> Result<Endpoint, String> {
    let u = url::Url::parse(s).map_err(|e| format!("ссылка trojan: {e}"))?;
    let (host, port) = host_port(&u)?;
    let pass = dec(u.username());
    if pass.is_empty() {
        return Err("в ссылке trojan нет пароля".into());
    }
    let mut ep = Endpoint::new(Kind::Trojan, &host, port);
    ep.secrets.insert("password".into(), json!(pass));
    if let Some(sni) = q(&u, "sni").or_else(|| q(&u, "peer")) {
        ep.params.insert("sni".into(), json!(sni));
    }
    if truthy(q(&u, "allowInsecure")) || truthy(q(&u, "insecure")) {
        ep.params.insert("skip-cert-verify".into(), json!(true));
    }
    if let Some(fp) = q(&u, "fp") {
        ep.params.insert("client-fingerprint".into(), json!(fp));
    }
    ep.label = label_of(&u, &ep);
    Ok(ep)
}

fn b64_any(s: &str) -> Option<String> {
    use base64::Engine as _;
    let t = s.trim().trim_end_matches('=');
    for eng in [
        &base64::engine::general_purpose::STANDARD_NO_PAD,
        &base64::engine::general_purpose::URL_SAFE_NO_PAD,
    ] {
        if let Ok(b) = eng.decode(t) {
            if let Ok(x) = String::from_utf8(b) {
                return Some(x);
            }
        }
    }
    None
}

fn parse_ss(s: &str) -> Result<Endpoint, String> {
    // SIP002: ss://base64(method:password)@host:port#name  или  ss://method:password@host:port
    // Старый: ss://base64(method:password@host:port)#name
    if !s.get(..5).is_some_and(|p| p.eq_ignore_ascii_case("ss://")) {
        return Err("неполная ссылка ss://".into());
    }
    let body = &s[5..];
    let (main, frag) = body.split_once('#').map(|(a, b)| (a, Some(b))).unwrap_or((body, None));
    let main = main.split('?').next().unwrap_or(main).trim_end_matches('/');
    let (userinfo, hostport) = match main.rsplit_once('@') {
        Some((ui, hp)) => (b64_any(ui).unwrap_or_else(|| dec(ui)), hp.to_string()),
        None => {
            let all = b64_any(main).ok_or("ss:// не разобрать")?;
            let (ui, hp) = all.rsplit_once('@').ok_or("ss:// без адреса сервера")?;
            (ui.to_string(), hp.to_string())
        }
    };
    let (method, pass) = userinfo.split_once(':').ok_or("ss:// без метода шифрования")?;
    let (host, port) = hostport.rsplit_once(':').ok_or("ss:// без порта")?;
    let port: u16 = port.parse().map_err(|_| "ss:// неверный порт")?;
    let mut ep = Endpoint::new(Kind::Shadowsocks, host, port);
    ep.params.insert("cipher".into(), json!(method));
    ep.secrets.insert("password".into(), json!(pass));
    ep.label = frag.map(dec).filter(|x| !x.trim().is_empty()).unwrap_or_else(|| ep.summary());
    Ok(ep)
}

fn parse_basic(s: &str) -> Result<Endpoint, String> {
    let u = url::Url::parse(s).map_err(|e| format!("ссылка: {e}"))?;
    let (host, port) = host_port(&u)?;
    let kind = if u.scheme().starts_with("socks") { Kind::Socks5 } else { Kind::Http };
    let mut ep = Endpoint::new(kind, &host, port);
    if u.scheme() == "https" {
        ep.params.insert("tls".into(), json!(true));
    }
    if !u.username().is_empty() {
        ep.secrets.insert("username".into(), json!(dec(u.username())));
        ep.secrets.insert("password".into(), json!(dec(u.password().unwrap_or(""))));
    }
    ep.label = label_of(&u, &ep);
    Ok(ep)
}

/// Конфиг AmneziaWG / WireGuard (`[Interface]` + `[Peer]`).
pub fn parse_awg_conf(s: &str) -> Result<Endpoint, String> {
    let mut sect = String::new();
    let mut peers = 0;
    let mut i: Vec<(String, String)> = vec![];
    let mut p: Vec<(String, String)> = vec![];
    for line in s.lines() {
        let l = line.split('#').next().unwrap_or("").trim();
        if l.is_empty() {
            continue;
        }
        if l.starts_with('[') {
            sect = l.trim_matches(|c| c == '[' || c == ']').to_ascii_lowercase();
            if sect == "peer" {
                peers += 1;
            }
            continue;
        }
        // Значение может содержать «=» (ключи base64) — делим по первому.
        if let Some((k, v)) = l.split_once('=') {
            let kv = (k.trim().to_ascii_lowercase(), v.trim().to_string());
            match sect.as_str() {
                "interface" => i.push(kv),
                "peer" if peers == 1 => p.push(kv), // берём первый сервер
                _ => {}
            }
        }
    }
    let gi = |k: &str| i.iter().find(|(a, _)| a == k).map(|(_, b)| b.clone());
    let gp = |k: &str| p.iter().find(|(a, _)| a == k).map(|(_, b)| b.clone());
    let endpoint = gp("endpoint").ok_or("в [Peer] нет Endpoint")?;
    let (host, port) = endpoint.rsplit_once(':').ok_or("Endpoint без порта")?;
    let port: u16 = port.parse().map_err(|_| "Endpoint: неверный порт")?;
    let mut ep = Endpoint::new(Kind::Awg, host, port);
    ep.secrets.insert("private-key".into(), json!(gi("privatekey").ok_or("в [Interface] нет PrivateKey")?));
    ep.params.insert("public-key".into(), json!(gp("publickey").ok_or("в [Peer] нет PublicKey")?));
    if let Some(psk) = gp("presharedkey") {
        ep.secrets.insert("pre-shared-key".into(), json!(psk));
    }
    // Address: «10.8.1.2/32, fd00::2/128» → ip и ipv6 без маски.
    for a in gi("address").unwrap_or_default().split(',') {
        let a = a.trim().split('/').next().unwrap_or("");
        if a.contains(':') {
            ep.params.insert("ipv6".into(), json!(a));
        } else if !a.is_empty() {
            ep.params.insert("ip".into(), json!(a));
        }
    }
    if !ep.params.contains_key("ip") {
        return Err("в [Interface] нет IPv4-адреса (Address)".into());
    }
    let allowed: Vec<String> = gp("allowedips")
        .unwrap_or_else(|| "0.0.0.0/0".into())
        .split(',')
        .map(|x| x.trim().to_string())
        .filter(|x| !x.is_empty())
        .collect();
    ep.params.insert("allowed-ips".into(), json!(allowed));
    if let Some(mtu) = gi("mtu").and_then(|m| m.parse::<u32>().ok()) {
        ep.params.insert("mtu".into(), json!(mtu));
    }
    if let Some(ka) = gp("persistentkeepalive").and_then(|m| m.parse::<u32>().ok()) {
        ep.params.insert("persistent-keepalive".into(), json!(ka));
    }
    // Параметры обфускации AmneziaWG: числа — числами, I1…I5 — строками.
    let mut awg = Map::new();
    for k in ["jc", "jmin", "jmax", "s1", "s2", "s3", "s4", "h1", "h2", "h3", "h4", "i1", "i2", "i3", "i4", "i5"] {
        if let Some(v) = gi(k) {
            let val = match v.parse::<u64>() {
                Ok(n) if !k.starts_with('i') => json!(n),
                _ => json!(v),
            };
            awg.insert(k.into(), val);
        }
    }
    if !awg.is_empty() {
        ep.params.insert("amnezia-wg-option".into(), Value::Object(awg));
    }
    ep.label = ep.summary();
    Ok(ep)
}

// ─── Сборка для mihomo ───────────────────────────────────────────

/// Секция прокси для mihomo. `name` — уникальное имя в конфиге.
pub fn to_mihomo(ep: &Endpoint, name: &str) -> Value {
    let mut o = Map::new();
    o.insert("name".into(), json!(name));
    let ty = match ep.kind {
        Kind::Http => "http",
        Kind::Socks5 => "socks5",
        Kind::Vless => "vless",
        Kind::Hysteria2 => "hysteria2",
        Kind::Trojan => "trojan",
        Kind::Shadowsocks => "ss",
        Kind::Awg => "wireguard",
    };
    o.insert("type".into(), json!(ty));
    o.insert("server".into(), json!(ep.server));
    o.insert("port".into(), json!(ep.port));
    o.insert("udp".into(), json!(ep.kind.udp()));
    if ep.kind == Kind::Vless {
        o.insert("encryption".into(), json!(""));
        if ep.params.get("flow").is_some() {
            o.insert("packet-encoding".into(), json!("xudp"));
        }
    }
    if ep.kind == Kind::Awg {
        // WireGuard везёт IP-пакеты, а не имена: если резолвить на ПК, под
        // TUN с fake-ip получится адрес 198.18.x, которого на сервере нет.
        // Резолвим имена через сам туннель.
        o.insert("remote-dns-resolve".into(), json!(true));
        o.insert("dns".into(), json!(["1.1.1.1", "8.8.8.8"]));
    }
    for (k, v) in ep.params.iter().chain(ep.secrets.iter()) {
        o.insert(k.clone(), v.clone());
    }
    Value::Object(o)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vless_reality_link() {
        let l = "vless://0f9c2b1e-1111-4a3b-9c8d-123456789abc@203.0.113.7:443?encryption=none&security=reality&sni=www.microsoft.com&fp=chrome&pbk=SbVKOEMjK0sIlbwg4akyBg5mL5KZwwB-ed4eEE7YnRc&sid=6ba85179e30d4fc2&type=tcp&flow=xtls-rprx-vision#%D0%A1%D0%B8%D0%BD%D0%B3%D0%B0%D0%BF%D1%83%D1%80";
        let ep = parse(l).unwrap();
        assert_eq!(ep.kind, Kind::Vless);
        assert_eq!(ep.label, "Сингапур");
        assert_eq!(ep.server, "203.0.113.7");
        assert_eq!(ep.port, 443);
        assert_eq!(ep.secrets["uuid"], "0f9c2b1e-1111-4a3b-9c8d-123456789abc");
        assert_eq!(ep.params["reality-opts"]["short-id"], "6ba85179e30d4fc2");
        assert_eq!(ep.params["servername"], "www.microsoft.com");
        let m = to_mihomo(&ep, "x");
        assert_eq!(m["type"], "vless");
        assert_eq!(m["flow"], "xtls-rprx-vision");
        assert_eq!(m["tls"], true);
        assert_eq!(m["encryption"], "");
        assert_eq!(m["reality-opts"]["public-key"], "SbVKOEMjK0sIlbwg4akyBg5mL5KZwwB-ed4eEE7YnRc");
    }

    #[test]
    fn vless_xhttp() {
        let ep = parse("vless://u@a.example:443?security=tls&sni=a.example&type=xhttp&path=%2Fx&mode=packet-up#cdn").unwrap();
        assert_eq!(ep.params["network"], "xhttp");
        assert_eq!(ep.params["xhttp-opts"]["path"], "/x");
        assert_eq!(ep.params["xhttp-opts"]["mode"], "packet-up");
    }

    #[test]
    fn hy2_links() {
        let ep = parse("hy2://p%40ss@[2001:db8::1]:8443/?sni=x.com&insecure=1&obfs=salamander&obfs-password=zz&mport=20000-30000#h").unwrap();
        assert_eq!(ep.kind, Kind::Hysteria2);
        assert_eq!(ep.server, "2001:db8::1");
        assert_eq!(ep.secrets["password"], "p@ss");
        assert_eq!(ep.secrets["obfs-password"], "zz");
        assert_eq!(ep.params["ports"], "20000-30000");
        assert_eq!(to_mihomo(&ep, "h")["skip-cert-verify"], true);
    }

    #[test]
    fn trojan_and_ss() {
        let t = parse("trojan://secret@t.example:443?sni=t.example&allowInsecure=1#t").unwrap();
        assert_eq!(t.secrets["password"], "secret");
        assert_eq!(t.params["skip-cert-verify"], true);

        // SIP002 с base64 userinfo
        let s = parse("ss://Y2hhY2hhMjAtaWV0Zi1wb2x5MTMwNTpwYXNz@198.51.100.2:8388#ss").unwrap();
        assert_eq!(s.params["cipher"], "chacha20-ietf-poly1305");
        assert_eq!(s.secrets["password"], "pass");
        // SS-2022 с открытым userinfo (ключ в base64 сам содержит «=»)
        let s2 = parse("ss://2022-blake3-aes-128-gcm:YctPZ6U7xPPcU%2Bgp3u%2B0tx%3D%3D@198.51.100.2:8388").unwrap();
        assert_eq!(s2.params["cipher"], "2022-blake3-aes-128-gcm");
        assert_eq!(s2.secrets["password"], "YctPZ6U7xPPcU+gp3u+0tx==");
        // старый формат: всё в base64
        let s3 = parse("ss://YWVzLTI1Ni1nY206cHdkQDEuMi4zLjQ6ODA4OA#old").unwrap();
        assert_eq!(s3.server, "1.2.3.4");
        assert_eq!(s3.port, 8088);
    }

    #[test]
    fn awg_conf() {
        let c = "[Interface]\nPrivateKey = cPrivKey=\nAddress = 10.8.1.2/32, fd00::2/128\nDNS = 1.1.1.1\nJc = 4\nJmin = 40\nJmax = 70\nS1 = 52\nS2 = 18\nH1 = 1234\nH2 = 5678\nH3 = 9012\nH4 = 3456\nI1 = <b 0xf6ab3267fa>\n\n[Peer]\nPublicKey = sPubKey=\nPresharedKey = psk=\nAllowedIPs = 0.0.0.0/0, ::/0\nEndpoint = 203.0.113.9:51820\nPersistentKeepalive = 25\n";
        let ep = parse(c).unwrap();
        assert_eq!(ep.kind, Kind::Awg);
        assert_eq!(ep.port, 51820);
        assert_eq!(ep.params["ip"], "10.8.1.2");
        assert_eq!(ep.params["ipv6"], "fd00::2");
        assert_eq!(ep.params["amnezia-wg-option"]["jc"], 4);
        assert_eq!(ep.params["amnezia-wg-option"]["i1"], "<b 0xf6ab3267fa>");
        let m = to_mihomo(&ep, "a");
        assert_eq!(m["type"], "wireguard");
        assert_eq!(m["private-key"], "cPrivKey=");
        assert_eq!(m["pre-shared-key"], "psk=");
        assert_eq!(m["udp"], true);
    }

    /// Ссылка как у AmneziaVPN: JSON → qCompress (длина + zlib) → base64url.
    fn amnezia_link(j: &Value) -> String {
        use base64::Engine as _;
        use std::io::Write;
        let body = serde_json::to_vec(j).unwrap();
        let mut z = flate2::write::ZlibEncoder::new(vec![], flate2::Compression::default());
        z.write_all(&body).unwrap();
        let mut raw = (body.len() as u32).to_be_bytes().to_vec();
        raw.extend(z.finish().unwrap());
        format!("vpn://{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw))
    }

    #[test]
    fn amnezia_vpn_link() {
        let awg = json!({ "config": "[Interface]\nAddress = 10.8.1.5/32\nDNS = $PRIMARY_DNS, $SECONDARY_DNS\nPrivateKey = cPriv=\nJc = 3\nJmin = 10\nJmax = 50\nS1 = 117\nS2 = 34\nH1 = 11\nH2 = 22\nH3 = 33\nH4 = 44\n\n[Peer]\nPublicKey = sPub=\nPresharedKey = psk=\nAllowedIPs = 0.0.0.0/0, ::/0\nEndpoint = $SERVER_IP_ADDRESS:35248\nPersistentKeepalive = 25\n" });
        let xray = json!({ "outbounds": [{ "protocol": "vless",
            "settings": { "vnext": [{ "address": "203.0.113.10", "port": 443, "users": [{ "id": "u-1", "flow": "xtls-rprx-vision", "encryption": "none" }] }] },
            "streamSettings": { "network": "tcp", "security": "reality",
                "realitySettings": { "fingerprint": "chrome", "publicKey": "PBK", "serverName": "www.googletagmanager.com", "shortId": "ab12" } } }] });
        let link = amnezia_link(&json!({
            "hostName": "203.0.113.10", "description": "Сингапур",
            "containers": [
                { "container": "amnezia-awg2", "awg": { "last_config": awg.to_string(), "port": "35248" } },
                { "container": "amnezia-xray", "xray": { "last_config": xray.to_string() } },
                { "container": "amnezia-dns" }
            ]
        }));
        let eps = parse_many(&format!("{link}\nvless://u@1.2.3.4:443?security=tls"));
        assert_eq!(eps.len(), 3);
        let a = eps[0].as_ref().unwrap();
        assert_eq!((a.kind, a.server.as_str(), a.port), (Kind::Awg, "203.0.113.10", 35248));
        assert_eq!(a.params["amnezia-wg-option"]["s1"], 117);
        assert_eq!(a.label, "Сингапур · AmneziaWG");
        let v = eps[1].as_ref().unwrap();
        assert_eq!((v.kind, v.port), (Kind::Vless, 443));
        assert_eq!(v.params["reality-opts"]["public-key"], "PBK");
        assert_eq!(v.params["flow"], "xtls-rprx-vision");
        assert_eq!(v.secrets["uuid"], "u-1");
        assert!(parse("vpn://не-base64!").is_err());
    }

    #[test]
    fn basic_and_errors() {
        let h = parse("http://u:p%40ss@203.0.113.50:59100").unwrap();
        assert_eq!(h.kind, Kind::Http);
        assert_eq!(h.secrets["password"], "p@ss");
        assert!(parse("vmess://abc").is_err());
        assert!(parse("vless://@1.2.3.4:443").is_err());
        assert!(parse("просто текст").is_err());
        let many = parse_many("# мои\nvless://u@1.2.3.4:443?security=tls\n\nss://YWVzLTI1Ni1nY206cHdkQDEuMi4zLjQ6ODA4OA\n");
        assert_eq!(many.len(), 2);
        assert!(many.iter().all(|r| r.is_ok()));
    }
}
