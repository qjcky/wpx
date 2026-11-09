//! Профили. Хранятся в `profiles.json` в папке данных wpx (`%APPDATA%\wpx`
//! в Windows); пароли и ключи — только зашифрованными (см. «Хранилище
//! секретов»). В интерфейс пароль не отдаётся никогда.

pub mod proto;

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::net::Ipv4Addr;

use crate::config;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Profile {
    pub id: String,
    pub name: String,
    /// IPv4 сервера. Имя хоста не годится: на ПК работает fake-ip DNS, а
    /// роутеру и route-exclude нужен именно адрес.
    pub server: String,
    pub http_port: Option<u16>,
    pub socks_port: Option<u16>,
    pub username: String,
    /// base64(зашифрованный пароль)
    #[serde(default)]
    pub password_enc: String,
    /// "http" | "socks5"
    pub primary: String,
    /// Порт HTTP говорит по TLS — HTTPS-прокси.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub https: bool,
    /// Имя для сертификата HTTPS-прокси (SNI); пусто — адрес сервера.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub tls_sni: String,
    /// Не проверять сертификат (свой прокси с самоподписанным).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub tls_insecure: bool,
    /// Второй протокол как резерв (если задан его порт).
    pub fallback: bool,
    /// Точки подключения любых протоколов (VLESS, Hysteria2, AWG…) в порядке
    /// приоритета. Если пусто — прокси-профиль из полей HTTP/SOCKS выше.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub endpoints: Vec<StoredEndpoint>,
    /// "fallback" — по порядку, следующий при сбое; "auto" — самый быстрый.
    #[serde(default)]
    pub mode: String,
    /// Каскад: этот профиль — цепочка из двух других (вход → выход).
    /// Своих точек у него нет; меняешь серверы во входе/выходе — каскад
    /// подхватывает сам, «поменять местами» — обмен двух ссылок.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cascade: Option<Cascade>,
    /// Профиль создан wpx из своего сервера: `server:<id>`. Переустановка
    /// обновляет этот же профиль.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub origin: String,
    /// Маршрут: несколько профилей-участников (VPN, каскад, прокси…); движок
    /// держит лучший живой — самый быстрый (`mode` auto) или по порядку.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub route: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Cascade {
    /// id профиля-входа (к нему подключается ПК).
    pub entry: String,
    /// id профиля-выхода (через него трафик уходит в интернет).
    pub exit: String,
}

/// Цепочка, готовая к сборке конфига: вход (может быть пустым) и выход.
/// Маршрут — `members` (у каждого участника своя цепочка), `exit_mode` —
/// как выбирать между участниками.
#[derive(Default)]
pub struct Chain {
    /// id профиля, из которого собрана цепочка.
    pub id: String,
    pub entry: Vec<(String, crate::profiles::proto::Endpoint)>,
    pub entry_mode: String,
    pub exit: Vec<(String, crate::profiles::proto::Endpoint)>,
    pub exit_mode: String,
    pub members: Vec<(String, Chain)>,
}

/// Имя точки участника маршрута в конфиге: `wpx-0` → `wpx-r1-0`,
/// `wpx-in-0` → `wpx-in-r1-0` (префикс входа сохраняется для монитора).
pub fn member_name(i: usize, name: &str) -> String {
    tagged(&format!("r{i}"), name)
}

/// Имя точки с меткой: `wpx-0` → `wpx-{tag}-0`, `wpx-in-0` → `wpx-in-{tag}-0`.
pub fn tagged(tag: &str, name: &str) -> String {
    match name.strip_prefix("wpx-in-") {
        Some(rest) => format!("wpx-in-{tag}-{rest}"),
        None => format!("wpx-{tag}-{}", name.trim_start_matches("wpx-")),
    }
}

impl Chain {
    /// Все точки с итоговыми именами конфига: (имя, точка, это вход, участник).
    pub fn points(&self) -> Vec<(String, &crate::profiles::proto::Endpoint, bool, String)> {
        if self.members.is_empty() {
            return self
                .entry
                .iter()
                .map(|(n, e)| (n.clone(), e, true, String::new()))
                .chain(self.exit.iter().map(|(n, e)| (n.clone(), e, false, String::new())))
                .collect();
        }
        self.members
            .iter()
            .enumerate()
            .flat_map(|(i, (title, m))| m.points().into_iter().map(move |(n, e, inn, _)| (member_name(i, &n), e, inn, title.clone())))
            .collect()
    }

    /// Первые звенья — к ним ПК ходит напрямую (вход каскада или сами точки).
    pub fn first_hop(&self) -> Vec<(String, &crate::profiles::proto::Endpoint)> {
        if self.members.is_empty() {
            let hop = if self.entry.is_empty() { &self.exit } else { &self.entry };
            return hop.iter().map(|(n, e)| (n.clone(), e)).collect();
        }
        self.members
            .iter()
            .enumerate()
            .flat_map(|(i, (_, m))| m.first_hop().into_iter().map(move |(n, e)| (member_name(i, &n), e)))
            .collect()
    }
}

/// Обычный профиль — цепочка без входа; каскад — вход и выход из
/// профилей-источников. Каскад из каскадов не допускается.
pub fn chain_of(store: &Store, p: &Profile) -> Result<Chain, String> {
    if !p.route.is_empty() {
        let mut members = vec![];
        for id in &p.route {
            let m = store.profiles.iter().find(|x| &x.id == id).ok_or("профиль-участник маршрута удалён")?;
            if !m.route.is_empty() {
                return Err(format!("«{}» сам является маршрутом", m.name));
            }
            members.push((m.name.clone(), chain_of(store, m)?));
        }
        return Ok(Chain { id: p.id.clone(), exit_mode: p.mode.clone(), members, ..Default::default() });
    }
    let Some(c) = &p.cascade else {
        return Ok(Chain { id: p.id.clone(), exit: endpoints_of(p)?, exit_mode: p.mode.clone(), ..Default::default() });
    };
    let find = |id: &str, role: &str| -> Result<&Profile, String> {
        let q = store.profiles.iter().find(|x| x.id == id).ok_or(format!("профиль-{role} каскада удалён"))?;
        if q.cascade.is_some() || !q.route.is_empty() {
            return Err(format!("{role} каскада сам является каскадом или маршрутом"));
        }
        Ok(q)
    };
    let (ep, xp) = (find(&c.entry, "вход")?, find(&c.exit, "выход")?);
    if ep.id == xp.id {
        return Err("вход и выход каскада — один и тот же профиль".into());
    }
    let entry: Vec<_> = endpoints_of(ep)?
        .into_iter()
        .map(|(n, e)| (n.replacen("wpx-", "wpx-in-", 1), e))
        .collect();
    let mut exit = endpoints_of(xp)?;
    // Вход без UDP (HTTP/SOCKS) не донесёт UDP-точки выхода (Hysteria2, AWG) —
    // берём только TCP-точки; нет таких — каскад невозможен.
    if let Some((_, e)) = entry.iter().find(|(_, e)| !e.kind.udp()) {
        let kinds: Vec<&str> = exit.iter().filter(|(_, x)| x.kind.over_udp()).map(|(_, x)| x.kind.label()).collect();
        exit.retain(|(_, x)| !x.kind.over_udp());
        if exit.is_empty() {
            return Err(format!(
                "Выход «{}» работает только по UDP ({}), а вход «{}» ({}) UDP не передаёт — выберите другой вход или выход",
                xp.name,
                kinds.join(", "),
                ep.name,
                e.kind.label()
            ));
        }
    }
    Ok(Chain { id: p.id.clone(), entry, entry_mode: ep.mode.clone(), exit, exit_mode: xp.mode.clone(), members: vec![] })
}

/// Создать или изменить маршрут из профилей (порядок = приоритет при «по порядку»).
pub fn upsert_route(s: &mut Store, id: Option<String>, name: &str, members: &[String], mode: &str) -> Result<String, String> {
    if name.trim().is_empty() {
        return Err("Укажите название маршрута".into());
    }
    if members.len() < 2 {
        return Err("В маршруте должно быть хотя бы два профиля".into());
    }
    let id = id.unwrap_or_else(|| fresh_id(s, 'r'));
    if members.iter().any(|m| *m == id) {
        return Err("Маршрут не может включать сам себя".into());
    }
    let p = Profile {
        id: id.clone(),
        name: name.trim().into(),
        route: members.to_vec(),
        mode: if mode == "fallback" { "fallback".into() } else { "auto".into() },
        ..Default::default()
    };
    chain_of(s, &p)?; // проверка участников до сохранения
    match s.profiles.iter_mut().find(|x| x.id == id) {
        Some(x) => *x = p,
        None => s.profiles.push(p),
    }
    Ok(id)
}

/// Создать или изменить каскад.
pub fn upsert_cascade(s: &mut Store, id: Option<String>, name: &str, entry: &str, exit: &str) -> Result<String, String> {
    if name.trim().is_empty() {
        return Err("Укажите название каскада".into());
    }
    let id = id.unwrap_or_else(|| fresh_id(s, 'c'));
    let p = Profile {
        id: id.clone(),
        name: name.trim().into(),
        cascade: Some(Cascade { entry: entry.into(), exit: exit.into() }),
        ..Default::default()
    };
    chain_of(s, &p)?; // проверка ссылок до сохранения
    match s.profiles.iter_mut().find(|x| x.id == id) {
        Some(x) => *x = p,
        None => s.profiles.push(p),
    }
    Ok(id)
}

/// Какие каскады и маршруты используют профиль (чтобы не удалить источник).
pub fn used_by_cascades(s: &Store, id: &str) -> Vec<String> {
    s.profiles
        .iter()
        .filter(|p| p.cascade.as_ref().map(|c| c.entry == id || c.exit == id).unwrap_or(false) || p.route.iter().any(|m| m == id))
        .map(|p| p.name.clone())
        .collect()
}

/// Точка подключения на диске: открытые параметры как есть, секреты — зашифрованы.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StoredEndpoint {
    #[serde(flatten)]
    pub ep: crate::profiles::proto::Endpoint,
    /// base64(зашифрованный JSON секретов)
    pub secret_enc: String,
}

/// Точки подключения профиля с расшифрованными секретами и именами для
/// конфига. Прокси-профиль (без `endpoints`) превращается в HTTP/SOCKS-точки
/// `wpx-http` и `wpx-socks` — по этим именам их узнаёт монитор.
pub fn endpoints_of(p: &Profile) -> Result<Vec<(String, crate::profiles::proto::Endpoint)>, String> {
    use crate::profiles::proto::{Endpoint, Kind};
    if !p.endpoints.is_empty() {
        return p
            .endpoints
            .iter()
            .enumerate()
            .map(|(i, s)| {
                let mut ep = s.ep.clone();
                if !s.secret_enc.is_empty() {
                    let raw = base64::engine::general_purpose::STANDARD.decode(&s.secret_enc).map_err(|e| e.to_string())?;
                    let plain = dpapi::unprotect(&raw).ok_or("не удалось расшифровать секреты точки (профиль от другого пользователя или ПК?)")?;
                    ep.secrets = serde_json::from_slice(&plain).map_err(|e| e.to_string())?;
                }
                Ok((format!("wpx-{i}"), ep))
            })
            .collect();
    }
    let pass = decrypt(p)?;
    let mk = |kind: Kind, port: u16| {
        let mut ep = Endpoint {
            kind,
            label: kind.label().into(),
            server: p.server.clone(),
            port,
            params: Default::default(),
            secrets: Default::default(),
        };
        if !p.username.is_empty() {
            ep.secrets.insert("username".into(), serde_json::json!(p.username));
            ep.secrets.insert("password".into(), serde_json::json!(pass));
        }
        if kind == Kind::Http && p.https {
            ep.params.insert("tls".into(), serde_json::json!(true));
            if !p.tls_sni.trim().is_empty() {
                ep.params.insert("sni".into(), serde_json::json!(p.tls_sni.trim()));
            }
            if p.tls_insecure {
                ep.params.insert("skip-cert-verify".into(), serde_json::json!(true));
            }
        }
        ep
    };
    let http = p.http_port.map(|port| (crate::engine::netcfg::NAME_HTTP.to_string(), mk(Kind::Http, port)));
    let socks = p.socks_port.map(|port| (crate::engine::netcfg::NAME_SOCKS.to_string(), mk(Kind::Socks5, port)));
    let (first, second) = if p.primary == "socks5" { (socks, http) } else { (http, socks) };
    Ok([first, if p.fallback { second } else { None }].into_iter().flatten().collect())
}

fn store_endpoint(ep: &crate::profiles::proto::Endpoint) -> Result<StoredEndpoint, String> {
    let mut open = ep.clone();
    let secrets = std::mem::take(&mut open.secrets);
    let secret_enc = if secrets.is_empty() {
        String::new()
    } else {
        let raw = serde_json::to_vec(&secrets).map_err(|e| e.to_string())?;
        base64::engine::general_purpose::STANDARD.encode(dpapi::protect(&raw).ok_or("не удалось зашифровать секреты")?)
    };
    Ok(StoredEndpoint { ep: open, secret_enc })
}

/// Новый профиль из точек подключения (порядок = приоритет).
pub fn import_endpoints(s: &mut Store, name: &str, eps: &[crate::profiles::proto::Endpoint], mode: &str) -> Result<String, String> {
    if name.trim().is_empty() {
        return Err("Укажите название профиля".into());
    }
    if eps.is_empty() {
        return Err("Нет ни одной точки подключения".into());
    }
    let stored = eps.iter().map(store_endpoint).collect::<Result<Vec<_>, _>>()?;
    let id = fresh_id(s, 'p');
    s.profiles.push(Profile {
        id: id.clone(),
        name: name.trim().into(),
        server: eps[0].server.clone(),
        endpoints: stored,
        mode: norm_mode(mode),
        ..Default::default()
    });
    Ok(id)
}

/// Изменить VPN-профиль: название, способ выбора, порядок точек (`order` —
/// индексы прежних точек; не попавшие — удаляются) и новые точки в конец.
/// Секреты не расшифровываются — точки просто переставляются.
pub fn edit_endpoints(s: &mut Store, id: &str, name: &str, mode: &str, order: &[usize], add: &[crate::profiles::proto::Endpoint]) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("Укажите название профиля".into());
    }
    let p = s.profiles.iter_mut().find(|p| p.id == id).ok_or("Профиль не найден")?;
    if p.endpoints.is_empty() {
        return Err("Это не VPN-профиль".into());
    }
    let mut seen = vec![];
    let mut list = vec![];
    for &i in order {
        if seen.contains(&i) {
            continue;
        }
        seen.push(i);
        list.push(p.endpoints.get(i).cloned().ok_or("Порядок точек устарел — откройте профиль заново")?);
    }
    for e in add {
        list.push(store_endpoint(e)?);
    }
    if list.is_empty() {
        return Err("В профиле должна остаться хотя бы одна точка подключения".into());
    }
    p.server = list[0].ep.server.clone();
    p.endpoints = list;
    p.name = name.trim().into();
    p.mode = norm_mode(mode);
    Ok(())
}

/// Профиль из своего сервера: создать или обновить точки того же профиля
/// (по `origin`). Название при обновлении не трогаем — его мог поменять
/// пользователь.
/// Как выбирать точку: «auto» — самая быстрая, «smart» — по истории и
/// времени суток (в движке — как «auto», выбор делает wpx), иначе — по порядку.
pub fn norm_mode(mode: &str) -> String {
    if mode == "auto" || mode == "smart" { mode.into() } else { "fallback".into() }
}

pub fn upsert_origin(s: &mut Store, origin: &str, name: &str, eps: &[crate::profiles::proto::Endpoint], mode: &str) -> Result<String, String> {
    if eps.is_empty() {
        return Err("Нет ни одной точки подключения".into());
    }
    let stored = eps.iter().map(store_endpoint).collect::<Result<Vec<_>, _>>()?;
    if let Some(p) = s.profiles.iter_mut().find(|p| p.origin == origin) {
        p.endpoints = stored;
        p.server = eps[0].server.clone();
        return Ok(p.id.clone());
    }
    let id = fresh_id(s, 'p');
    s.profiles.push(Profile {
        id: id.clone(),
        name: name.trim().into(),
        server: eps[0].server.clone(),
        endpoints: stored,
        mode: mode.into(),
        origin: origin.into(),
        ..Default::default()
    });
    Ok(id)
}

/// Новый id по времени; если в эту миллисекунду уже создан — следующий.
fn fresh_id(s: &Store, prefix: char) -> String {
    let mut t = chrono::Utc::now().timestamp_millis();
    while s.profiles.iter().any(|p| p.id == format!("{prefix}{t}")) {
        t += 1;
    }
    format!("{prefix}{t}")
}

#[derive(Serialize, Deserialize, Default)]
pub struct Store {
    pub profiles: Vec<Profile>,
    pub active: Option<String>,
}

/// Профиль для окна — без пароля.
#[derive(Serialize)]
pub struct ProfileView {
    pub id: String,
    pub name: String,
    pub server: String,
    pub http_port: Option<u16>,
    pub socks_port: Option<u16>,
    pub username: String,
    pub has_password: bool,
    pub primary: String,
    pub fallback: bool,
    pub https: bool,
    pub tls_sni: String,
    pub tls_insecure: bool,
    pub active: bool,
    /// Точки подключения (без секретов); у прокси-профиля пусто.
    pub endpoints: Vec<EndpointView>,
    pub mode: String,
    /// Для каскада: вход и выход (id и названия профилей-источников).
    pub cascade: Option<CascadeView>,
    /// `server:<id>` — профиль создан из своего сервера.
    pub origin: String,
    /// Маршрут: участники (id и названия) по порядку.
    pub route: Vec<RouteMember>,
}

#[derive(Serialize)]
pub struct RouteMember {
    pub id: String,
    pub name: String,
}

#[derive(Serialize)]
pub struct CascadeView {
    pub entry: String,
    pub exit: String,
    pub entry_name: String,
    pub exit_name: String,
}

#[derive(Serialize)]
pub struct EndpointView {
    pub kind: crate::profiles::proto::Kind,
    pub label: String,
    pub summary: String,
}

#[derive(Deserialize, Default)]
pub struct ProfileInput {
    pub id: Option<String>,
    pub name: String,
    pub server: String,
    pub http_port: Option<u16>,
    pub socks_port: Option<u16>,
    pub username: String,
    /// None — оставить прежний пароль.
    pub password: Option<String>,
    pub primary: String,
    pub fallback: bool,
    /// Порт HTTP — по TLS (HTTPS-прокси); имя для сертификата; не проверять его.
    #[serde(default)]
    pub https: bool,
    #[serde(default)]
    pub tls_sni: String,
    #[serde(default)]
    pub tls_insecure: bool,
}

// ─── Хранилище секретов ──────────────────────────────────────────
// Windows — DPAPI (ключ — у учётной записи Windows). Linux — ChaCha20-Poly1305
// с ключом пользователя в папке данных wpx (файл 0600): секреты не лежат
// открытым текстом; от того, кто читает всю домашнюю папку, спасает только
// шифрование диска.

#[cfg(not(windows))]
mod dpapi {
    use rand_core::{OsRng, RngCore};
    use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, CHACHA20_POLY1305, NONCE_LEN};
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    /// Ключ пользователя: один на процесс; файл создаётся атомарно
    /// (`create_new`), чтобы два потока не завели два разных ключа.
    fn key() -> Option<LessSafeKey> {
        static KEY: std::sync::OnceLock<Option<Vec<u8>>> = std::sync::OnceLock::new();
        let k = KEY.get_or_init(|| {
            let p = crate::config::data_dir().join("vault.key");
            if let Ok(k) = std::fs::read(&p) {
                return (k.len() == 32).then_some(k);
            }
            let mut k = vec![0u8; 32];
            OsRng.fill_bytes(&mut k);
            match std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&p) {
                Ok(mut f) => f.write_all(&k).ok().map(|_| k),
                Err(_) => std::fs::read(&p).ok().filter(|k| k.len() == 32),
            }
        });
        Some(LessSafeKey::new(UnboundKey::new(&CHACHA20_POLY1305, k.as_deref()?).ok()?))
    }

    pub fn protect(data: &[u8]) -> Option<Vec<u8>> {
        let mut nonce = [0u8; NONCE_LEN];
        OsRng.fill_bytes(&mut nonce);
        let mut buf = data.to_vec();
        key()?.seal_in_place_append_tag(Nonce::assume_unique_for_key(nonce), Aad::empty(), &mut buf).ok()?;
        Some([nonce.as_slice(), &buf].concat())
    }

    pub fn unprotect(data: &[u8]) -> Option<Vec<u8>> {
        if data.len() < NONCE_LEN {
            return None;
        }
        let (n, c) = data.split_at(NONCE_LEN);
        let mut buf = c.to_vec();
        let nonce = Nonce::try_assume_unique_for_key(n).ok()?;
        let plain = key()?.open_in_place(nonce, Aad::empty(), &mut buf).ok()?;
        Some(plain.to_vec())
    }
}

#[cfg(windows)]
mod dpapi {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    fn run(data: &[u8], protect: bool) -> Option<Vec<u8>> {
        let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        // SAFETY: входной буфер живёт до конца вызова; выходной освобождаем LocalFree.
        unsafe {
            let ok = if protect {
                CryptProtectData(&input, std::ptr::null(), std::ptr::null(), std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out)
            } else {
                CryptUnprotectData(&input, std::ptr::null_mut(), std::ptr::null(), std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out)
            };
            if ok == 0 || out.pbData.is_null() {
                return None;
            }
            let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
            LocalFree(out.pbData as _);
            Some(v)
        }
    }

    pub fn protect(data: &[u8]) -> Option<Vec<u8>> {
        run(data, true)
    }
    pub fn unprotect(data: &[u8]) -> Option<Vec<u8>> {
        run(data, false)
    }
}

pub fn encrypt(pass: &str) -> Result<String, String> {
    let enc = dpapi::protect(pass.as_bytes()).ok_or("не удалось зашифровать пароль")?;
    Ok(base64::engine::general_purpose::STANDARD.encode(enc))
}

pub fn decrypt(p: &Profile) -> Result<String, String> {
    decrypt_str(&p.password_enc)
}

/// base64(зашифрованный текст) → текст; пустое → пустое.
pub fn decrypt_str(enc: &str) -> Result<String, String> {
    if enc.is_empty() {
        return Ok(String::new());
    }
    let raw = base64::engine::general_purpose::STANDARD.decode(enc).map_err(|e| e.to_string())?;
    let plain = dpapi::unprotect(&raw).ok_or("не удалось расшифровать пароль (профиль от другого пользователя или ПК?)")?;
    String::from_utf8(plain).map_err(|e| e.to_string())
}

// ─── Хранилище ───────────────────────────────────────────────────

pub fn load() -> Store {
    std::fs::read_to_string(config::data_dir().join("profiles.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

pub fn save(s: &Store) -> Result<(), String> {
    config::write_json("profiles.json", s)
}

pub fn views(s: &Store) -> Vec<ProfileView> {
    s.profiles
        .iter()
        .map(|p| ProfileView {
            id: p.id.clone(),
            name: p.name.clone(),
            server: p.server.clone(),
            http_port: p.http_port,
            socks_port: p.socks_port,
            username: p.username.clone(),
            has_password: !p.password_enc.is_empty(),
            primary: p.primary.clone(),
            fallback: p.fallback,
            https: p.https,
            tls_sni: p.tls_sni.clone(),
            tls_insecure: p.tls_insecure,
            active: s.active.as_deref() == Some(&p.id),
            endpoints: p
                .endpoints
                .iter()
                .map(|e| EndpointView { kind: e.ep.kind, label: e.ep.label.clone(), summary: e.ep.summary() })
                .collect(),
            mode: p.mode.clone(),
            origin: p.origin.clone(),
            route: p
                .route
                .iter()
                .map(|id| RouteMember { id: id.clone(), name: s.profiles.iter().find(|x| &x.id == id).map(|x| x.name.clone()).unwrap_or_else(|| "удалён".into()) })
                .collect(),
            cascade: p.cascade.as_ref().map(|c| {
                let name = |id: &str| s.profiles.iter().find(|x| x.id == id).map(|x| x.name.clone()).unwrap_or_else(|| "— удалён —".into());
                CascadeView { entry: c.entry.clone(), exit: c.exit.clone(), entry_name: name(&c.entry), exit_name: name(&c.exit) }
            }),
        })
        .collect()
}

pub fn validate(i: &ProfileInput) -> Result<(), String> {
    if i.name.trim().is_empty() {
        return Err("Укажите название".into());
    }
    i.server
        .trim()
        .parse::<Ipv4Addr>()
        .map_err(|_| "Сервер — IPv4-адрес вида 203.0.113.50 (имя хоста не подходит: роутеру и туннелю нужен адрес)".to_string())?;
    if i.http_port.is_none() && i.socks_port.is_none() {
        return Err("Нужен хотя бы один порт: HTTP или SOCKS5".into());
    }
    if i.https && !i.tls_sni.trim().is_empty() && i.tls_sni.trim().parse::<std::net::IpAddr>().is_err()
        && !i.tls_sni.trim().chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    {
        return Err("Имя для сертификата — домен вида proxy.example.com".into());
    }
    match i.primary.as_str() {
        "http" if i.http_port.is_none() => Err("Основной HTTP, но порт HTTP не указан".into()),
        "socks5" if i.socks_port.is_none() => Err("Основной SOCKS5, но порт SOCKS5 не указан".into()),
        "http" | "socks5" => Ok(()),
        _ => Err("Основной протокол: http или socks5".into()),
    }
}

pub fn upsert(s: &mut Store, i: ProfileInput) -> Result<String, String> {
    validate(&i)?;
    let id = i.id.clone().unwrap_or_else(|| fresh_id(s, 'p'));
    if s.profiles.iter().any(|p| p.id == id && (p.cascade.is_some() || !p.route.is_empty())) {
        return Err("Это каскад или маршрут — он меняется в своей панели".into());
    }
    let old_enc = s.profiles.iter().find(|p| p.id == id).map(|p| p.password_enc.clone());
    let password_enc = match (&i.password, old_enc) {
        (Some(pw), _) if !pw.is_empty() => encrypt(pw)?,
        (Some(_), _) => String::new(),
        (None, Some(old)) => old,
        (None, None) => String::new(),
    };
    let p = Profile {
        id: id.clone(),
        name: i.name.trim().into(),
        server: i.server.trim().into(),
        http_port: i.http_port,
        socks_port: i.socks_port,
        username: i.username.trim().into(),
        password_enc,
        primary: i.primary,
        fallback: i.fallback && i.http_port.is_some() && i.socks_port.is_some(),
        https: i.https,
        tls_sni: if i.https { i.tls_sni.trim().to_string() } else { String::new() },
        tls_insecure: i.https && i.tls_insecure,
        // Точки подключения форма не редактирует — сохраняем.
        endpoints: s.profiles.iter().find(|x| x.id == id).map(|x| x.endpoints.clone()).unwrap_or_default(),
        mode: s.profiles.iter().find(|x| x.id == id).map(|x| x.mode.clone()).unwrap_or_default(),
        cascade: None,
        origin: s.profiles.iter().find(|x| x.id == id).map(|x| x.origin.clone()).unwrap_or_default(),
        route: vec![],
    };
    match s.profiles.iter_mut().find(|x| x.id == id) {
        Some(x) => *x = p,
        None => s.profiles.push(p),
    }
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dpapi_roundtrip() {
        let enc = encrypt("p@ss:wörd").unwrap();
        let p = Profile {
            id: "x".into(), name: "x".into(), server: "1.2.3.4".into(), http_port: Some(1), socks_port: None,
            username: "u".into(), password_enc: enc, primary: "http".into(), fallback: false,
            ..Default::default()
        };
        assert_eq!(decrypt(&p).unwrap(), "p@ss:wörd");
    }

    #[test]
    fn endpoints_roundtrip_encrypted() {
        let ep = crate::profiles::proto::parse("trojan://s3cret@203.0.113.5:443?sni=x#t").unwrap();
        let mut st = Store::default();
        let id = import_endpoints(&mut st, "Новый", &[ep], "auto").unwrap();
        let p = st.profiles.iter().find(|p| p.id == id).unwrap();
        // На диске секрета в открытом виде нет.
        let disk = serde_json::to_string(p).unwrap();
        assert!(!disk.contains("s3cret"));
        assert!(disk.contains("203.0.113.5"));
        let eps = endpoints_of(p).unwrap();
        assert_eq!(eps[0].0, "wpx-0");
        assert_eq!(eps[0].1.secrets["password"], "s3cret");
        assert_eq!(p.mode, "auto");
    }

    #[test]
    fn route_of_profiles() {
        let p = |l: &str| crate::profiles::proto::parse(l).unwrap();
        let mut st = Store::default();
        let a = import_endpoints(&mut st, "A", &[p("vless://u@1.1.1.1:443?security=reality&pbk=K#a")], "auto").unwrap();
        let b = import_endpoints(&mut st, "B", &[p("trojan://t@2.2.2.2:443#b")], "auto").unwrap();
        let c = upsert_cascade(&mut st, None, "A → B", &a, &b).unwrap();
        let r = upsert_route(&mut st, None, "Все пути", &[c.clone(), a.clone()], "auto").unwrap();
        let rp = st.profiles.iter().find(|x| x.id == r).unwrap().clone();
        let ch = chain_of(&st, &rp).unwrap();
        assert_eq!(ch.members.len(), 2);
        let names: Vec<String> = ch.points().into_iter().map(|(n, ..)| n).collect();
        assert_eq!(names, vec!["wpx-in-r0-0", "wpx-r0-0", "wpx-r1-0"]);
        // Напрямую ПК ходит ко входу каскада и к самому A.
        let hop: Vec<&str> = ch.first_hop().iter().map(|(_, e)| e.server.as_str()).collect::<Vec<_>>();
        assert_eq!(hop, vec!["1.1.1.1", "1.1.1.1"]);
        // Защита: один участник, маршрут в маршруте, удаление участника.
        assert!(upsert_route(&mut st, None, "x", &[a.clone()], "auto").is_err());
        assert!(upsert_route(&mut st, None, "x", &[r.clone(), a.clone()], "auto").is_err());
        assert!(used_by_cascades(&st, &a).contains(&"Все пути".to_string()));
    }

    #[test]
    fn edit_vpn_profile_reorders_removes_adds() {
        let p = |l: &str| crate::profiles::proto::parse(l).unwrap();
        let mut st = Store::default();
        let id = import_endpoints(&mut st, "A", &[p("trojan://a@1.1.1.1:443#a"), p("trojan://b@2.2.2.2:443#b"), p("trojan://c@3.3.3.3:443#c")], "auto").unwrap();
        // Поменять порядок, убрать «a», добавить «d».
        edit_endpoints(&mut st, &id, "Б", "fallback", &[2, 1], &[p("trojan://d@4.4.4.4:443#d")]).unwrap();
        let pr = st.profiles.iter().find(|x| x.id == id).unwrap();
        let eps = endpoints_of(pr).unwrap();
        let hosts: Vec<&str> = eps.iter().map(|(_, e)| e.server.as_str()).collect();
        assert_eq!(hosts, vec!["3.3.3.3", "2.2.2.2", "4.4.4.4"]);
        assert_eq!(eps[0].1.secrets["password"], "c");
        assert_eq!((pr.name.as_str(), pr.mode.as_str(), pr.server.as_str()), ("Б", "fallback", "3.3.3.3"));
        assert!(edit_endpoints(&mut st, &id, "Б", "auto", &[], &[]).is_err());
        assert!(edit_endpoints(&mut st, &id, "Б", "auto", &[7], &[]).is_err());
    }

    #[test]
    fn proxy_profile_becomes_http_socks_endpoints() {
        let p = Profile {
            id: "x".into(), name: "x".into(), server: "1.2.3.4".into(), http_port: Some(1), socks_port: Some(2),
            username: "u".into(), password_enc: encrypt("pw").unwrap(), primary: "socks5".into(), fallback: true,
            ..Default::default()
        };
        let eps = endpoints_of(&p).unwrap();
        assert_eq!(eps[0].0, crate::engine::netcfg::NAME_SOCKS);
        assert_eq!(eps[1].0, crate::engine::netcfg::NAME_HTTP);
        assert_eq!(eps[1].1.secrets["password"], "pw");
    }

    #[test]
    fn cascade_chain_swap_and_guards() {
        let mut st = Store::default();
        let sg = import_endpoints(&mut st, "SG", &[crate::profiles::proto::parse("vless://a@203.0.113.10:443?security=reality&pbk=K#sg").unwrap()], "fallback").unwrap();
        let ex = import_endpoints(&mut st, "EX", &[crate::profiles::proto::parse("vless://b@198.51.100.20:443?security=reality&pbk=K#ex").unwrap()], "fallback").unwrap();
        let c = upsert_cascade(&mut st, None, "SG → EX", &sg, &ex).unwrap();
        let p = st.profiles.iter().find(|p| p.id == c).unwrap().clone();
        let ch = chain_of(&st, &p).unwrap();
        assert_eq!(ch.entry[0].0, "wpx-in-0");
        assert_eq!(ch.entry[0].1.server, "203.0.113.10");
        assert_eq!(ch.exit[0].1.server, "198.51.100.20");
        // Поменять местами — тот же id, обмен ссылок.
        upsert_cascade(&mut st, Some(c.clone()), "EX → SG", &ex, &sg).unwrap();
        let p = st.profiles.iter().find(|p| p.id == c).unwrap().clone();
        assert_eq!(chain_of(&st, &p).unwrap().entry[0].1.server, "198.51.100.20");
        // Защита: вход = выход, каскад из каскада, используемый профиль.
        assert!(upsert_cascade(&mut st, None, "x", &sg, &sg).is_err());
        assert!(upsert_cascade(&mut st, None, "x", &c, &sg).is_err());
        assert_eq!(used_by_cascades(&st, &sg), vec!["EX → SG".to_string()]);
        // Выход по UDP (Hysteria2) нельзя пустить через HTTP-прокси, VLESS — можно.
        let px = import_endpoints(&mut st, "PX", &[crate::profiles::proto::parse("http://u:p@203.0.113.50:59100#px").unwrap()], "fallback").unwrap();
        let hy = import_endpoints(&mut st, "HY", &[crate::profiles::proto::parse("hysteria2://pw@198.51.100.20:443?sni=a.b#hy").unwrap()], "fallback").unwrap();
        assert!(upsert_cascade(&mut st, None, "x", &px, &hy).unwrap_err().contains("UDP"));
        assert!(upsert_cascade(&mut st, None, "PX → EX", &px, &ex).is_ok());
        assert!(upsert_cascade(&mut st, None, "SG → HY", &sg, &hy).is_ok());
    }

    #[test]
    fn validates() {
        let mut i = ProfileInput {
            id: None, name: "SG".into(), server: "proxy.example.com".into(), http_port: Some(1), socks_port: None,
            username: "".into(), password: None, primary: "http".into(), fallback: false, ..Default::default()
        };
        assert!(validate(&i).is_err());
        i.server = "1.2.3.4".into();
        assert!(validate(&i).is_ok());
        i.primary = "socks5".into();
        assert!(validate(&i).is_err());
    }
}
