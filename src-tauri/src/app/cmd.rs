//! Команды окна: профили прокси и управление движком.

use serde::Serialize;
use tauri::AppHandle;

use crate::config::{self, EngineKind};
use crate::monitor::{engine_op, Shared};
use crate::engine::netcfg::{self, NetSettings};
use crate::engine::ops::{self, ApplyResult};
use crate::monitor::probes::{self, LegResult};
use crate::profiles::{self, Profile, ProfileInput, ProfileView};

#[derive(Serialize)]
pub struct ProfilesState {
    pub profiles: Vec<ProfileView>,
    pub active: Option<String>,
}

fn state(s: &profiles::Store) -> ProfilesState {
    ProfilesState { profiles: profiles::views(s), active: s.active.clone() }
}

#[tauri::command]
pub fn profiles_list() -> ProfilesState {
    state(&profiles::load())
}

#[tauri::command]
pub fn profile_save(input: ProfileInput) -> Result<ProfilesState, String> {
    let mut s = profiles::load();
    profiles::upsert(&mut s, input)?;
    profiles::save(&s)?;
    Ok(state(&s))
}

#[tauri::command]
pub fn profile_delete(id: String) -> Result<ProfilesState, String> {
    let mut s = profiles::load();
    if s.active.as_deref() == Some(&id) {
        return Err(format!("Профиль сейчас в работе — {}", profiles::BUSY_HINT));
    }
    let users = profiles::used_by_cascades(&s, &id);
    if !users.is_empty() {
        return Err(format!("Профиль используется в каскаде: {}. Сначала удалите или измените каскад", users.join(", ")));
    }
    s.profiles.retain(|p| p.id != id);
    profiles::save(&s)?;
    Ok(state(&s))
}

#[derive(Serialize)]
pub struct ProfileTest {
    pub http: Option<LegResult>,
    pub socks: Option<LegResult>,
}

/// Профиль из формы (пароль — из формы или сохранённый).
fn resolve(input: &ProfileInput) -> Result<(Profile, String), String> {
    profiles::validate(input)?;
    let store = profiles::load();
    let saved = input.id.as_ref().and_then(|id| store.profiles.iter().find(|p| &p.id == id));
    let pass = match (&input.password, saved) {
        (Some(p), _) => p.clone(),
        (None, Some(sp)) => profiles::decrypt(sp)?,
        (None, None) => String::new(),
    };
    let p = Profile {
        id: input.id.clone().unwrap_or_default(),
        name: input.name.clone(),
        server: input.server.trim().into(),
        http_port: input.http_port,
        socks_port: input.socks_port,
        username: input.username.trim().into(),
        password_enc: String::new(),
        primary: input.primary.clone(),
        fallback: input.fallback,
        https: input.https,
        tls_sni: input.tls_sni.trim().into(),
        tls_insecure: input.tls_insecure,
        ..Default::default()
    };
    Ok((p, pass))
}

async fn test_profile(p: &Profile, pass: &str) -> ProfileTest {
    let creds = config::Creds { user: p.username.clone(), pass: pass.to_string() };
    let http = match p.http_port {
        Some(port) => {
            let tls = p.https.then(|| probes::Tls { sni: p.tls_sni.clone(), insecure: p.tls_insecure });
            Some(probes::leg_http(&p.server, port, &creds, tls.as_ref()).await)
        }
        None => None,
    };
    let socks = match p.socks_port {
        Some(port) => Some(probes::leg_socks(&p.server, port, &creds).await),
        None => None,
    };
    ProfileTest { http, socks }
}

/// Прямое рукопожатие по портам профиля (до сохранения тоже можно).
#[tauri::command]
pub async fn profile_test(input: ProfileInput) -> Result<ProfileTest, String> {
    let (p, pass) = resolve(&input)?;
    Ok(test_profile(&p, &pass).await)
}

/// Снять рабочий профиль с работы: движок останавливается (без kill switch —
/// интернет напрямую), рабочего профиля нет. Нужно, когда ни один профиль не
/// отвечает: переключиться не на что, а рабочий профиль, его сервер и каскад
/// не удалить.
#[tauri::command]
pub async fn profile_deactivate(app: AppHandle, shared: tauri::State<'_, Shared>) -> Result<ApplyResult, ()> {
    let res = if config::active().kind == EngineKind::Wpx {
        engine_op(app, shared.inner().clone(), ops::stop).await
    } else {
        ApplyResult { ok: true, outcome: "applied".into(), message: "Готово".into(), info: None }
    };
    if res.ok {
        let mut s = profiles::load();
        s.active = None;
        let _ = profiles::save(&s);
    }
    Ok(res)
}

/// Сделать профиль рабочим. Сначала проверяем, что основной выход отвечает
/// напрямую: иначе (новый сервер не разрешён на роутере, неверный пароль)
/// туннель заведомо не поднимется — и трогать систему незачем.
#[tauri::command]
pub async fn profile_activate(app: AppHandle, shared: tauri::State<'_, Shared>, id: String) -> Result<ApplyResult, ()> {
    let store = profiles::load();
    let Some(p) = store.profiles.iter().find(|p| p.id == id).cloned() else {
        return Ok(ApplyResult::fail("Профиль не найден"));
    };
    if !p.endpoints.is_empty() || p.cascade.is_some() || !p.route.is_empty() {
        // Профиль с VPN-протоколами или каскад: проверяем цепочку в песочнице
        // «как без туннеля» (через физический адаптер) — хотя бы одна точка
        // выхода должна ответить, для каскада — через вход.
        let ch = match profiles::chain_of(&store, &p) {
            Ok(c) => c,
            Err(e) => return Ok(ApplyResult::fail(e)),
        };
        if let Err(e) = check_route(&ch).await {
            return Ok(ApplyResult::fail(format!("{e} Систему не трогал.")));
        }
        let mut net = netcfg::load();
        // Защита по умолчанию: уходя с прокси на VPN, прокси становится резервом —
        // VPN упал, движок сам уйдёт на прокси и сам вернётся.
        if net.reserve.is_empty() {
            if let Some(cur) = store.active.as_ref().and_then(|id| store.profiles.iter().find(|x| &x.id == id)) {
                if cur.id != p.id && cur.endpoints.is_empty() && cur.cascade.is_none() && cur.route.is_empty() {
                    net.reserve = cur.id.clone();
                    let _ = netcfg::save(&net);
                }
            }
        }
        let pc = p.clone();
        let mut res = engine_op(app, shared.inner().clone(), move || ops::activate(&pc, &net)).await;
        if res.ok {
            // Файлы правил «найденного на лету» — движку сразу, не дожидаясь fswatch.
            crate::engine::follow::push(&netcfg::load()).await;
            let mut s = profiles::load();
            s.active = Some(p.id.clone());
            let _ = profiles::save(&s);
            // Туннель поднялся, но, может, через резерв — сказать честно.
            if let Ok((addr, secret)) = controller() {
                if let Ok(g) = crate::engine::controller::group(&addr, &secret, netcfg::GROUP).await {
                    if g.now.starts_with("wpx-rsv-") {
                        res.message = format!("«{}» включён, но VPN пока не отвечает — интернет идёт через резерв. Как только VPN оживёт, движок вернётся на него сам.", p.name);
                    }
                }
            }
        }
        return Ok(res);
    }
    let pass = match profiles::decrypt(&p) {
        Ok(x) => x,
        Err(e) => return Ok(ApplyResult::fail(e)),
    };
    let t = test_profile(&p, &pass).await;
    let primary = if p.primary == "socks5" { &t.socks } else { &t.http };
    if let Some(r) = primary {
        if !r.ok {
            let port = if p.primary == "socks5" { p.socks_port } else { p.http_port }.unwrap_or(0);
            return Ok(ApplyResult::fail(format!(
                "{}:{} не отвечает напрямую ({}). Если это новый сервер — разрешите его на роутере (правило LAN→Internet для {} TCP {}). Систему не трогал.",
                p.server, port, r.err.clone().unwrap_or_default(), p.server, port
            )));
        }
    }
    let net = netcfg::load();
    let pc = p.clone();
    let res = engine_op(app, shared.inner().clone(), move || ops::activate(&pc, &net)).await;
    if res.ok {
        crate::engine::follow::push(&netcfg::load()).await;
        let mut s = profiles::load();
        s.active = Some(p.id.clone());
        let _ = profiles::save(&s);
    }
    Ok(res)
}

// ─── Импорт ссылок и автоподбор ──────────────────────────────────

#[derive(Serialize)]
pub struct ParsedItem {
    pub ok: bool,
    pub kind: Option<crate::profiles::proto::Kind>,
    pub label: String,
    pub summary: String,
    pub udp: bool,
    pub error: Option<String>,
}

fn parse_text(text: &str) -> Vec<Result<crate::profiles::proto::Endpoint, String>> {
    // Несколько блоков через «---»: ссылки построчно и/или конфиги AWG.
    text.split("\n---").flat_map(crate::profiles::proto::parse_many).collect()
}

/// Что распознано во вставленном тексте (без секретов).
#[tauri::command]
pub fn links_parse(text: String) -> Vec<ParsedItem> {
    parse_text(&text)
        .into_iter()
        .map(|r| match r {
            Ok(e) => ParsedItem { ok: true, kind: Some(e.kind), label: e.label.clone(), summary: e.summary(), udp: e.kind.udp(), error: None },
            Err(err) => ParsedItem { ok: false, kind: None, label: String::new(), summary: String::new(), udp: false, error: Some(err) },
        })
        .collect()
}

/// Проверить распознанные точки в песочнице. `direct` — «как без туннеля»
/// (через физический адаптер; роутер должен пускать сервер), иначе — обычным
/// путём ПК (для стенда на 127.0.0.1 или через рабочий туннель).
#[tauri::command]
pub async fn links_probe(text: String, direct: bool) -> Result<Vec<crate::engine::sandbox::ProbeResult>, String> {
    let eps: Vec<_> = parse_text(&text).into_iter().filter_map(Result::ok).collect();
    if eps.is_empty() {
        return Err("Нет ни одной распознанной точки подключения".into());
    }
    crate::engine::sandbox::probe(eps, crate::engine::sandbox::Options { timeout_ms: 6000, ..opts(direct, 3) }).await
}

/// Сохранить профиль из вставленного текста. `order` — индексы распознанных
/// точек в нужном порядке (обычно результат автоподбора); пусто — как есть.
#[tauri::command]
pub fn profile_import(name: String, text: String, mode: String, order: Vec<usize>) -> Result<ProfilesState, String> {
    let eps: Vec<_> = parse_text(&text).into_iter().filter_map(Result::ok).collect();
    let ordered: Vec<_> = if order.is_empty() {
        eps
    } else {
        order.iter().filter_map(|&i| eps.get(i).cloned()).collect()
    };
    let mut s = profiles::load();
    profiles::import_endpoints(&mut s, &name, &ordered, &mode)?;
    profiles::save(&s)?;
    Ok(state(&s))
}

#[derive(serde::Deserialize)]
pub struct VpnEdit {
    pub id: String,
    pub name: String,
    pub mode: String,
    /// Индексы прежних точек в новом порядке (не попавшие — удаляются).
    pub order: Vec<usize>,
    /// Новые ссылки/конфиги — в конец списка.
    pub add: String,
}

#[tauri::command]
pub fn profile_edit_vpn(input: VpnEdit) -> Result<ProfilesState, String> {
    let add: Vec<_> = parse_text(&input.add).into_iter().filter_map(Result::ok).collect();
    let mut s = profiles::load();
    profiles::edit_endpoints(&mut s, &input.id, &input.name, &input.mode, &input.order, &add)?;
    profiles::save(&s)?;
    Ok(state(&s))
}

#[derive(Serialize)]
pub struct PointHistory {
    /// Сейчас (этот час) или по суткам: задержка, доля удачных, заморозки.
    pub score: Option<crate::monitor::history::Score>,
    /// В какой час точка обычно лучше всего.
    pub best_hour: Option<usize>,
}

/// История точек профиля (по индексам, как в профиле) — для «умного выбора».
#[tauri::command]
pub fn profile_history(id: String) -> Result<Vec<PointHistory>, String> {
    let st = profiles::load();
    let p = st.profiles.iter().find(|p| p.id == id).ok_or("Профиль не найден")?;
    Ok(profiles::endpoints_of(p)?
        .iter()
        .map(|(_, e)| {
            let k = crate::monitor::history::key_of(e);
            PointHistory { score: crate::monitor::history::score(&k), best_hour: crate::monitor::history::best_hour(&k) }
        })
        .collect())
}

/// Проверить точки сохранённого VPN-профиля в песочнице (индексы — как в профиле).
#[tauri::command]
pub async fn profile_probe(id: String, direct: bool) -> Result<Vec<crate::engine::sandbox::ProbeResult>, String> {
    let st = profiles::load();
    let p = st.profiles.iter().find(|p| p.id == id).ok_or("Профиль не найден")?;
    // «Проверить точки»: и задержка, и заморозка (256 КБ через каждую точку).
    crate::engine::sandbox::probe(eps(&profiles::endpoints_of(p)?), crate::engine::sandbox::Options { timeout_ms: 8000, bulk: true, ..opts(direct, 3) }).await
}

// ─── Правила роутера ─────────────────────────────────────────────

/// Что должен пропускать роутерный kill switch для профиля: только первые
/// звенья (к остальным ПК напрямую не ходит).
#[derive(Serialize)]
pub struct RouterRule {
    pub server: String,
    pub tcp: Vec<u16>,
    pub udp: Vec<u16>,
    /// Диапазоны UDP (смена портов Hysteria2): "20000-20999".
    pub udp_ranges: Vec<String>,
    pub what: Vec<String>,
}


fn rules_of(ch: &profiles::Chain) -> Vec<RouterRule> {
    let mut out: Vec<RouterRule> = vec![];
    for (_, e) in ch.first_hop() {
        let i = match out.iter().position(|r| r.server == e.server) {
            Some(i) => i,
            None => {
                out.push(RouterRule { server: e.server.clone(), tcp: vec![], udp: vec![], udp_ranges: vec![], what: vec![] });
                out.len() - 1
            }
        };
        let r = &mut out[i];
        let ports = if e.kind.over_udp() { &mut r.udp } else { &mut r.tcp };
        if !ports.contains(&e.port) {
            ports.push(e.port);
        }
        if let Some(range) = e.params.get("ports").and_then(|v| v.as_str()) {
            if !r.udp_ranges.iter().any(|x| x == range) {
                r.udp_ranges.push(range.to_string());
            }
        }
        if !r.what.contains(&e.kind.label().to_string()) {
            r.what.push(e.kind.label().to_string());
        }
    }
    for r in &mut out {
        r.tcp.sort();
        r.udp.sort();
    }
    out
}

#[tauri::command]
pub fn router_rules(id: String) -> Result<Vec<RouterRule>, String> {
    let st = profiles::load();
    let p = st.profiles.iter().find(|p| p.id == id).ok_or("Профиль не найден")?;
    Ok(rules_of(&profiles::chain_of(&st, p)?))
}

#[derive(Serialize)]
pub struct RouterCheck {
    pub server: String,
    pub ok: bool,
    pub detail: String,
}

/// Проверить, что роутер пускает ПК к первым звеньям напрямую (песочница
/// через физический адаптер): по серверу — «проходит», если ответила хоть
/// одна его точка.
#[tauri::command]
pub async fn router_check(id: String) -> Result<Vec<RouterCheck>, String> {
    let st = profiles::load();
    let p = st.profiles.iter().find(|p| p.id == id).ok_or("Профиль не найден")?;
    let ch = profiles::chain_of(&st, p)?;
    let hop: Vec<(String, crate::profiles::proto::Endpoint)> = ch.first_hop().into_iter().map(|(n, e)| (n, e.clone())).collect();
    let res = crate::engine::sandbox::probe(eps(&hop), opts(true, 1)).await?;
    let mut out: Vec<RouterCheck> = vec![];
    for (r, (_, e)) in res.iter().zip(&hop) {
        let bit = format!(
            "{} :{}{} {}",
            e.kind.label(),
            e.port,
            if e.kind.over_udp() { "/udp" } else { "" },
            match r.median_ms {
                Some(ms) if r.ok > 0 => format!("✓ {ms} мс"),
                _ => format!("✗ {}", r.error.clone().unwrap_or_else(|| "нет ответа".into())),
            }
        );
        match out.iter_mut().find(|c| c.server == e.server) {
            Some(c) => {
                c.ok |= r.ok > 0;
                c.detail = format!("{} · {bit}", c.detail);
            }
            None => out.push(RouterCheck { server: e.server.clone(), ok: r.ok > 0, detail: bit }),
        }
    }
    Ok(out)
}

// ─── Каскад ──────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct ChainProbe {
    /// Вход сам по себе (пусто для обычного профиля).
    pub entry: Vec<crate::engine::sandbox::ProbeResult>,
    /// Выход — через вход, как в рабочем конфиге.
    pub exit: Vec<crate::engine::sandbox::ProbeResult>,
}

fn opts(direct: bool, rounds: u32) -> crate::engine::sandbox::Options {
    crate::engine::sandbox::Options {
        interface: direct.then(|| netcfg::load().interface),
        rounds,
        timeout_ms: 8000,
        ..Default::default()
    }
}

fn eps(v: &[(String, crate::profiles::proto::Endpoint)]) -> Vec<crate::profiles::proto::Endpoint> {
    v.iter().map(|(_, e)| e.clone()).collect()
}

async fn probe_chain(ch: &profiles::Chain, direct: bool, rounds: u32) -> Result<ChainProbe, String> {
    let entry = if ch.entry.is_empty() {
        vec![]
    } else {
        crate::engine::sandbox::probe(eps(&ch.entry), opts(direct, rounds)).await?
    };
    let via = crate::engine::sandbox::Options { via: eps(&ch.entry), via_mode: ch.entry_mode.clone(), ..opts(direct, rounds) };
    let exit = crate::engine::sandbox::probe(eps(&ch.exit), via).await?;
    Ok(ChainProbe { entry, exit })
}

fn why(r: &[crate::engine::sandbox::ProbeResult]) -> String {
    r.iter().map(|x| format!("{}: {}", x.label, x.error.clone().unwrap_or_default())).collect::<Vec<_>>().join("; ")
}

/// Перед включением: выход должен ответить (для каскада — через вход).
/// Если не ответил, уточняем, на каком звене обрыв.
/// Маршрут — хватит одного живого участника; иначе — как у цепочки.
async fn check_route(ch: &profiles::Chain) -> Result<(), String> {
    if ch.members.is_empty() {
        return check_chain(ch).await;
    }
    let mut why = vec![];
    for (name, m) in &ch.members {
        match check_chain(m).await {
            Ok(()) => return Ok(()),
            Err(e) => why.push(format!("«{name}»: {e}")),
        }
    }
    Err(format!("Ни один участник маршрута не отвечает. {}", why.join(" ")))
}

async fn check_chain(ch: &profiles::Chain) -> Result<(), String> {
    let via = crate::engine::sandbox::Options { via: eps(&ch.entry), via_mode: ch.entry_mode.clone(), ..opts(true, 1) };
    let exit = crate::engine::sandbox::probe(eps(&ch.exit), via).await.map_err(|e| format!("Проверка в песочнице: {e}."))?;
    if exit.iter().any(|x| x.ok > 0) {
        return Ok(());
    }
    if ch.entry.is_empty() {
        return Err(format!(
            "Ни одна точка подключения не отвечает с этого ПК ({}). Если это новый сервер — разрешите его IP на роутере.",
            why(&exit)
        ));
    }
    let entry = crate::engine::sandbox::probe(eps(&ch.entry), opts(true, 1)).await.map_err(|e| format!("Проверка в песочнице: {e}."))?;
    if entry.iter().any(|x| x.ok > 0) {
        Err(format!("Вход отвечает, но выход через него — нет ({}).", why(&exit)))
    } else {
        Err(format!(
            "Вход каскада не отвечает напрямую ({}). Если это новый сервер — разрешите его IP на роутере.",
            why(&entry)
        ))
    }
}

fn draft(entry: &str, exit: &str) -> Profile {
    Profile {
        name: "каскад".into(),
        cascade: Some(profiles::Cascade { entry: entry.into(), exit: exit.into() }),
        ..Default::default()
    }
}

/// Проверить цепочку «вход → выход» до сохранения: вход отдельно и выход
/// через вход.
#[tauri::command]
pub async fn cascade_probe(entry: String, exit: String, direct: bool) -> Result<ChainProbe, String> {
    let ch = profiles::chain_of(&profiles::load(), &draft(&entry, &exit))?;
    probe_chain(&ch, direct, 3).await
}

#[tauri::command]
pub fn route_save(id: Option<String>, name: String, members: Vec<String>, mode: String) -> Result<ProfilesState, String> {
    let mut s = profiles::load();
    profiles::upsert_route(&mut s, id, &name, &members, &mode)?;
    profiles::save(&s)?;
    Ok(state(&s))
}

#[derive(Serialize)]
pub struct MemberProbe {
    pub id: String,
    pub name: String,
    pub ok: bool,
    pub best_ms: Option<u32>,
    pub detail: String,
}

/// Проверить участников будущего маршрута по отдельности (для каскада —
/// выход через вход), чтобы было видно, какой путь жив и какой быстрее.
#[tauri::command]
pub async fn route_probe(members: Vec<String>, direct: bool) -> Result<Vec<MemberProbe>, String> {
    let st = profiles::load();
    let mut out = vec![];
    for id in members {
        let p = st.profiles.iter().find(|p| p.id == id).ok_or("Профиль не найден")?;
        let r = match profiles::chain_of(&st, p) {
            Ok(ch) if ch.members.is_empty() => probe_chain(&ch, direct, 2).await.map(|c| c.exit),
            Ok(_) => Err("маршрут в маршруте не поддерживается".into()),
            Err(e) => Err(e),
        };
        out.push(match r {
            Ok(res) => {
                let best = res.iter().filter(|x| x.ok > 0).filter_map(|x| x.median_ms).min();
                let ok = res.iter().filter(|x| x.ok > 0).count();
                MemberProbe { id, name: p.name.clone(), ok: best.is_some(), best_ms: best, detail: format!("отвечают {ok} из {} точек", res.len()) }
            }
            Err(e) => MemberProbe { id, name: p.name.clone(), ok: false, best_ms: None, detail: e },
        });
    }
    Ok(out)
}

#[tauri::command]
pub fn cascade_save(id: Option<String>, name: String, entry: String, exit: String) -> Result<ProfilesState, String> {
    let mut s = profiles::load();
    profiles::upsert_cascade(&mut s, id, &name, &entry, &exit)?;
    profiles::save(&s)?;
    Ok(state(&s))
}

// ─── Движок ──────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct EngineInfo {
    pub kind: EngineKind,
    pub boot: Option<bool>,
    pub heal: bool,
    /// Какие домены блокируются как телеметрия (для подсказки в окне).
    pub telemetry_list: Vec<&'static str>,
    /// Списки для «только заблокированное»: (id, название).
    pub lists: Vec<(&'static str, &'static str)>,
    /// Готовые наборы для правил: (id, название).
    /// Наборы: id, название, домены (окно расширяет сайт до набора).
    /// (id, название, домены, списки из `lists`).
    pub presets: Vec<(&'static str, &'static str, &'static [&'static str], &'static [&'static str])>,
    /// Адреса выхода для «постоянного IP» в правилах.
    pub exits: Vec<netcfg::ExitView>,
    /// Конфиг движка уже содержит текущие правила блокировки и
    /// определение процессов (иначе нужно «Сохранить и применить»).
    pub config_current: bool,
    pub net: NetSettings,
    pub interfaces: Vec<String>,
    pub wpx_dir: String,
    /// mihomo движка — не тот, что пришёл с этой версией wpx.
    pub engine_outdated: bool,
}

#[tauri::command]
pub async fn engine_info() -> EngineInfo {
    let mut net = netcfg::load();
    net.secret.clear(); // в окно не отдаём
    let interfaces = tokio::task::spawn_blocking(crate::platform::physical_adapters).await.unwrap_or_default();
    let config_current = config::read_engine_config()
        .map(|c| {
            let rules = c.raw.get("rules").map(|r| r.to_string()).unwrap_or_default();
            c.raw.get("find-process-mode").is_some()
                && netcfg::NOISE_EXACT.iter().all(|d| rules.contains(d))
                && (!net.block_telemetry || netcfg::TELEMETRY.iter().all(|d| rules.contains(d)))
                && net.block_domains.iter().all(|d| rules.contains(d.as_str()))
        })
        .unwrap_or(false);
    EngineInfo {
        kind: config::active().kind,
        boot: config::wpx_boot_enabled(),
        heal: config::wpx_heal_enabled(),
        telemetry_list: netcfg::TELEMETRY.to_vec(),
        lists: netcfg::LISTS.iter().map(|l| (l.0, l.1)).collect(),
        presets: netcfg::PRESETS.to_vec(),
        exits: netcfg::exits().into_iter().map(|(v, _)| v).collect(),
        config_current,
        net,
        interfaces,
        wpx_dir: config::WPX_DIR.into(),
        engine_outdated: tokio::task::spawn_blocking(ops::engine_outdated).await.unwrap_or(false),
    }
}

#[tauri::command]
pub fn net_save(net: NetSettings) -> Result<(), String> {
    netcfg::save(&tidy(net))
}

/// Нормализовать настройки из окна (секрет — прежний, пробелы, префиксы доменов).
fn tidy(net: NetSettings) -> NetSettings {
    let mut n = net;
    let old = netcfg::load();
    n.secret = old.secret; // секрет не меняется из окна
    n.lan = n.lan.into_iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    n.direct = n.direct.into_iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    n.block_domains = n
        .block_domains
        .into_iter()
        .map(|s| s.trim().trim_start_matches("*.").trim_start_matches('.').to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    for r in &mut n.rules {
        r.value = r.value.trim().to_string();
        if r.kind == "site" {
            r.value = r.value.trim_start_matches("*.").trim_start_matches('.').to_ascii_lowercase();
        }
    }
    n
}

/// Проверить настройки до сохранения: те же проверки, что при сохранении, и
/// `mihomo -t` для конфига рабочего профиля с этими правилами. Систему не меняет.
#[tauri::command]
pub async fn net_check(net: NetSettings) -> Result<String, String> {
    let n = tidy(net);
    netcfg::validate(&n)?;
    let store = profiles::load();
    let p = store.active.as_ref().and_then(|id| store.profiles.iter().find(|p| &p.id == id)).ok_or("Нет рабочего профиля")?;
    let ch = profiles::chain_of(&store, p)?;
    tokio::task::spawn_blocking(move || ops::stage(&ch, &n).map(|(_, h)| format!("Движок принял конфиг (sha256 {})", &h[..12])))
        .await
        .map_err(|e| e.to_string())?
}

macro_rules! op_cmd {
    ($name:ident, $call:expr) => {
        #[tauri::command]
        pub async fn $name(app: AppHandle, shared: tauri::State<'_, Shared>) -> Result<ApplyResult, ()> {
            Ok(engine_op(app, shared.inner().clone(), $call).await)
        }
    };
}

/// Как `op_cmd`, но только при рабочем профиле: снятый с работы профиль ещё
/// лежит в конфиге движка — без проверки он поднялся бы снова.
macro_rules! op_cmd_working {
    ($name:ident, $call:expr) => {
        #[tauri::command]
        pub async fn $name(app: AppHandle, shared: tauri::State<'_, Shared>) -> Result<ApplyResult, ()> {
            if profiles::load().active.is_none() {
                return Ok(ApplyResult::fail("Нет рабочего профиля — сделайте рабочим один из профилей"));
            }
            Ok(engine_op(app, shared.inner().clone(), $call).await)
        }
    };
}

op_cmd_working!(engine_restart, ops::restart);
op_cmd_working!(engine_start, ops::start);
op_cmd!(engine_stop, ops::stop);
op_cmd!(engine_uninstall, ops::uninstall);
op_cmd!(engine_update, ops::update_engine);

#[tauri::command]
pub async fn engine_set_boot(app: AppHandle, shared: tauri::State<'_, Shared>, on: bool) -> Result<ApplyResult, ()> {
    Ok(engine_op(app, shared.inner().clone(), move || ops::set_boot(on)).await)
}

/// Применить сетевые настройки к рабочему профилю (перезапуск движка).
#[tauri::command]
pub async fn engine_apply_net(app: AppHandle, shared: tauri::State<'_, Shared>) -> Result<ApplyResult, ()> {
    let store = profiles::load();
    let Some(p) = store.active.as_ref().and_then(|id| store.profiles.iter().find(|p| &p.id == id)).cloned() else {
        return Ok(ApplyResult::fail("Нет рабочего профиля"));
    };
    if config::active().kind != EngineKind::Wpx {
        return Ok(ApplyResult::fail("Сначала перенесите движок в wpx (кнопка выше)"));
    }
    let net = netcfg::load();
    let res = engine_op(app, shared.inner().clone(), move || ops::activate(&p, &net)).await;
    if res.ok {
        crate::engine::follow::push(&netcfg::load()).await;
    }
    Ok(res)
}

#[tauri::command]
pub async fn engine_set_heal(app: AppHandle, shared: tauri::State<'_, Shared>, on: bool) -> Result<ApplyResult, ()> {
    Ok(engine_op(app, shared.inner().clone(), move || ops::set_heal(on)).await)
}

// ─── Соединения ──────────────────────────────────────────────────

pub(crate) fn controller() -> Result<(String, String), String> {
    let cfg = config::read_engine_config()?;
    let addr = cfg.facts.controller.clone().ok_or("у движка не включён локальный API — нужен движок wpx")?;
    let secret = cfg.secret.clone().unwrap_or_default();
    Ok((addr, secret))
}

/// Состав списка из «Готовых наборов» (адреса или подсети).
#[derive(Serialize)]
pub struct ListItems {
    pub items: Vec<String>,
    /// Откуда взят: встроен в wpx, копия движка, своя копия или скачан сейчас.
    pub source: &'static str,
    pub url: &'static str,
}

/// «DOMAIN-SUFFIX,youtube.com» → «youtube.com», «+.x.com» → «x.com»,
/// «.ua» — вся зона, подсети — как есть; комментарии и пустые строки — мимо.
fn list_lines(text: &str) -> Vec<String> {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(|l| {
            let v = match l.split_once(',') {
                Some((kind, rest)) if kind.chars().all(|c| c.is_ascii_uppercase() || c == '-') => rest.split(',').next().unwrap_or(rest),
                _ => l,
            };
            v.trim_start_matches("+.").to_string()
        })
        .filter(|v| !v.is_empty())
        .collect()
}

/// Что внутри списка: копия движка (он качает списки из правил раз в
/// сутки), иначе своя копия не старше суток, иначе скачать обычным путём ПК.
#[tauri::command]
pub async fn list_items(id: String) -> Result<ListItems, String> {
    let (_, _, url, _) = *netcfg::LISTS.iter().find(|l| l.0 == id).ok_or("нет такого списка")?;
    if let Some((_, payload)) = netcfg::INLINE.iter().find(|(i, _)| *i == id) {
        return Ok(ListItems { items: payload.iter().map(|s| s.to_string()).collect(), source: "builtin", url });
    }
    // Копия движка: в домашней папке mihomo (прежние установки — в папке движка).
    let engine = [config::WPX_HOME, config::WPX_DIR].iter().map(|d| std::path::PathBuf::from(d).join("rules").join(format!("{id}.txt"))).find(|p| p.is_file()).unwrap_or_default();
    if let Ok(t) = std::fs::read_to_string(&engine).map(|t| list_lines(&t)).map_err(|_| ()).and_then(|v| if v.is_empty() { Err(()) } else { Ok(v) }) {
        return Ok(ListItems { items: t, source: "engine", url });
    }
    let own = config::data_dir().join("lists").join(format!("{id}.txt"));
    let fresh = own.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|a| a.as_secs() < 86_400);
    if fresh {
        if let Ok(t) = std::fs::read_to_string(&own) {
            return Ok(ListItems { items: list_lines(&t), source: "cache", url });
        }
    }
    let path = own.clone();
    tauri::async_runtime::spawn_blocking(move || {
        use crate::platform::Hidden;
        std::fs::create_dir_all(path.parent().unwrap_or(&path)).map_err(|e| e.to_string())?;
        let out = std::process::Command::new(crate::platform::CURL)
            .args(["-sS", "-L", "--fail", "--max-time", "25", "-o"])
            .arg(&path)
            .arg(url)
            .hidden()
            .output()
            .map_err(|e| format!("curl: {e}"))?;
        if out.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&out.stderr).trim().to_string()) }
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("Не удалось скачать список ({e}). Адрес: {url}"))?;
    let t = std::fs::read_to_string(&own).map_err(|e| e.to_string())?;
    Ok(ListItems { items: list_lines(&t), source: "fresh", url })
}

/// Соединения движка; у идущих через профиль — подпись точки.
#[tauri::command]
pub async fn conns_list(shared: tauri::State<'_, Shared>) -> Result<crate::engine::controller::ConnList, String> {
    let (addr, secret) = controller()?;
    let mut list = crate::engine::controller::connections(&addr, &secret).await?;
    let labels = shared.with(|i| i.labels.clone());
    for c in list.conns.iter_mut().filter(|c| c.route == "vpn") {
        c.label = labels.iter().find(|(n, _)| n == &c.via).map(|(_, l)| l.clone()).unwrap_or_else(|| c.via.clone());
    }
    Ok(list)
}

#[tauri::command]
pub async fn conns_close(ids: Vec<String>) -> Result<usize, String> {
    let (addr, secret) = controller()?;
    let mut n = 0;
    for id in ids.iter().take(500) {
        if crate::engine::controller::close(&addr, &secret, id).await.is_ok() {
            n += 1;
        }
    }
    Ok(n)
}

/// Пауза VPN: движок работает, но весь трафик идёт напрямую — без прав
/// администратора и без снятия kill switch (наружу ходит сам движок).
/// Держится до «Включить VPN» или перезапуска движка.
#[tauri::command]
pub async fn engine_pause(shared: tauri::State<'_, Shared>, on: bool, minutes: Option<u32>) -> Result<(), String> {
    if config::LAB {
        return Err("Лабораторная сборка: рабочий туннель не трогаю".into());
    }
    let (addr, secret) = controller()?;
    crate::engine::controller::set_mode(&addr, &secret, if on { "direct" } else { "rule" }).await?;
    // Пауза на время — монитор сам вернёт VPN; без срока — до «Включить VPN».
    let until = minutes.filter(|m| on && *m > 0).map(|m| chrono::Utc::now().timestamp_millis() + i64::from(m.min(24 * 60)) * 60_000);
    shared.with(|i| {
        i.paused = on;
        i.pause_until = until;
        i.settings.pause_until = until;
        let _ = config::save_settings(&i.settings);
    });
    shared.wake_tunnel.notify_one();
    Ok(())
}

// ─── Тест скорости ───────────────────────────────────────────────

#[tauri::command]
pub async fn speed_test() -> crate::monitor::speedtest::SpeedResult {
    let r = tokio::task::spawn_blocking(crate::monitor::speedtest::run)
        .await
        .unwrap_or_else(|e| crate::monitor::speedtest::SpeedResult {
            at: crate::monitor::now_ms(),
            ping_ms: None,
            down_mbps: None,
            up_mbps: None,
            down_mb: 0.0,
            up_mb: 0.0,
            error: Some(e.to_string()),
        });
    crate::monitor::speedtest::remember(&r);
    r
}

#[tauri::command]
pub fn speed_history() -> Vec<crate::monitor::speedtest::SpeedResult> {
    crate::monitor::speedtest::history()
}

#[tauri::command]
pub async fn engine_deep_test(app: AppHandle, shared: tauri::State<'_, Shared>) -> Result<ApplyResult, ()> {
    let cfg = match config::read_engine_config() {
        Ok(c) => c,
        Err(e) => return Ok(ApplyResult::fail(e)),
    };
    // Первые звенья рабочего профиля и резерва: к ним ПК ходит напрямую.
    let st = profiles::load();
    let net = netcfg::load();
    let mut hop: Vec<(String, crate::profiles::proto::Endpoint)> = vec![];
    for id in st.active.iter().chain(std::iter::once(&net.reserve)).filter(|id| !id.is_empty()) {
        if let Some(ch) = st.profiles.iter().find(|p| &p.id == id).and_then(|p| profiles::chain_of(&st, p).ok()) {
            hop.extend(ch.first_hop().into_iter().map(|(n, e)| (n, e.clone())));
        }
    }
    let tcp: Vec<(String, u16)> = if hop.is_empty() {
        match cfg.proxies.first() {
            Some(f) => vec![(f.server.clone(), f.port)],
            None => return Ok(ApplyResult::fail("В конфиге нет прокси")),
        }
    } else {
        let mut v: Vec<(String, u16)> = hop.iter().filter(|(_, e)| !e.kind.over_udp()).map(|(_, e)| (e.server.clone(), e.port)).collect();
        v.sort();
        v.dedup();
        v
    };
    let mut res = engine_op(app, shared.inner().clone(), move || ops::deep_test(&tcp)).await;
    // UDP-точки (Hysteria2, AWG) TCP-коннектом не проверить — песочница через
    // физический адаптер (движок уже снова работает, ей он не нужен).
    let udp: Vec<(String, crate::profiles::proto::Endpoint)> = hop.into_iter().filter(|(_, e)| e.kind.over_udp()).collect();
    if res.ok && !udp.is_empty() {
        if let Ok(r) = crate::engine::sandbox::probe(eps(&udp), opts(true, 1)).await {
            let mut info: serde_json::Value = serde_json::from_str(res.info.as_deref().unwrap_or("{}")).unwrap_or_default();
            info["udp"] = serde_json::json!(r
                .iter()
                .zip(&udp)
                .map(|(x, (_, e))| serde_json::json!({ "l": format!("{} {}:{}/udp", e.kind.label(), e.server, e.port), "ok": x.ok > 0, "ms": x.median_ms }))
                .collect::<Vec<_>>());
            res.info = Some(info.to_string());
        }
    }
    Ok(res)
}

#[cfg(test)]
mod tests {
    use crate::profiles::proto::Kind;

    #[test]
    fn list_lines_read_both_formats() {
        assert_eq!(super::list_lines("DOMAIN-SUFFIX,.ua\nDOMAIN-SUFFIX,1337x.to\n# c\n\n+.x.com\n91.108.4.0/22\nIP-CIDR,1.2.3.0/24,no-resolve"), [".ua", "1337x.to", "x.com", "91.108.4.0/22", "1.2.3.0/24"]);
    }

    #[test]
    fn share_bundle_is_one_profile() {
        // «Копировать всё для wpx»: ссылки построчно, конфиг AWG — через «---».
        let t = "vless://u@203.0.113.10:443?security=reality&pbk=K&sni=www.apple.com#a\nhysteria2://pw@203.0.113.10:443?sni=www.apple.com#b\n---\n[Interface]\nPrivateKey = cPriv=\nAddress = 10.66.0.5/32\n\n[Peer]\nPublicKey = sPub=\nEndpoint = 203.0.113.10:50738\nAllowedIPs = 0.0.0.0/0\n";
        let eps = super::parse_text(t).into_iter().collect::<Result<Vec<_>, _>>().unwrap();
        assert_eq!(eps.iter().map(|e| e.kind).collect::<Vec<_>>(), [Kind::Vless, Kind::Hysteria2, Kind::Awg]);
    }
}
