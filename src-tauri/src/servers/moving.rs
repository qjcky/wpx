//! Переезд в один клик: всё с сервера A на чистый сервер B — протоколы с
//! прежними ключами и портами, доступы людей, файрвол, каскады. Профили
//! сохраняют свои id (правила, маршруты, резерв на них ссылаются) — в них
//! меняется только адрес. Ссылки и QR у людей придётся выдать заново: в них
//! адрес сервера.

use super::*;

#[derive(Serialize, Clone, Debug, Default)]
pub struct MovePlan {
    pub from: String,
    pub to: String,
    /// Что будет сделано — по шагам, для окна подтверждения.
    pub steps: Vec<String>,
    /// Людям с доступом нужен новый QR.
    pub guests: usize,
    /// Причина, почему переезд невозможен.
    pub error: Option<String>,
}

/// План переезда (без изменений) — что и куда.
pub fn plan(st: &Store, from: &str, to: &str) -> MovePlan {
    let mut p = MovePlan::default();
    let (Some(a), Some(b)) = (st.servers.iter().find(|x| x.id == from), st.servers.iter().find(|x| x.id == to)) else {
        p.error = Some("сервер не найден".into());
        return p;
    };
    p.from = a.name.clone();
    p.to = b.name.clone();
    let protos: Vec<&str> = [
        a.vless.as_ref().map(|_| "VLESS+Reality"),
        a.hy2.as_ref().map(|_| "Hysteria2"),
        a.awg.as_ref().map(|_| "AmneziaWG"),
        a.xhttp.as_ref().map(|_| "XHTTP+Reality"),
        a.mtproxy.as_ref().map(|_| "MTProxy"),
    ]
    .into_iter()
    .flatten()
    .collect();
    p.error = if a.id == b.id {
        Some("Это один и тот же сервер".into())
    } else if b.vless.is_some() || b.hy2.is_some() || b.awg.is_some() || b.xhttp.is_some() || b.mtproxy.is_some() || !b.pipes.is_empty() {
        Some(format!("На «{}» уже стоит VPN от wpx — для переезда нужен чистый сервер (или «Убрать с сервера»)", b.name))
    } else if protos.is_empty() && a.pipes.is_empty() {
        Some(format!("На «{}» нечего переносить", a.name))
    } else if a.awg.is_some() && b.facts.as_ref().is_some_and(|f| !f.arch.is_empty() && f.arch != "x86_64") {
        Some(format!("AmneziaWG пока только для x86_64, а «{}» — {}", b.name, b.facts.as_ref().map(|f| f.arch.as_str()).unwrap_or("")))
    } else {
        None
    };
    if !protos.is_empty() {
        p.steps.push(format!("На «{}» ставлю {} — с прежними ключами и портами, плюс защита сервера", b.name, protos.join(", ")));
        p.steps.push(format!("Профиль «{}» переедет на {} — правила, маршруты и резерв продолжат работать", a.name, b.host));
    }
    let entries: Vec<&Server> = st.servers.iter().filter(|e| e.pipes.iter().any(|x| x.to == a.id)).collect();
    for e in &entries {
        p.steps.push(format!("Каскад «{} → {}» станет «{} → {}»", e.name, a.name, e.name, b.name));
    }
    let mut exits: Vec<&str> = a.pipes.iter().map(|x| x.to.as_str()).collect();
    exits.dedup();
    for x in exits {
        let n = st.servers.iter().find(|s| s.id == x).map(|s| s.name.as_str()).unwrap_or("выход");
        p.steps.push(format!("Вход каскада: «{} → {}» станет «{} → {}»", a.name, n, b.name, n));
    }
    if a.fw.is_some() {
        p.steps.push(format!("Файрвол на «{}» — как был на «{}»", b.name, a.name));
    }
    p.guests = a.guests.len();
    if p.guests > 0 {
        p.steps.push(format!("Доступы ({}) переедут с прежними ключами — людям нужен новый QR: в нём адрес сервера", p.guests));
    }
    p
}

/// Профиль `origin_old` получает точки профиля `origin_new` (и его origin),
/// а сам новый удаляется: id старого остаётся — ссылки на него живы.
fn adopt_profile(origin_old: &str, origin_new: &str) -> Result<Option<String>, String> {
    let mut ps = profiles::load();
    let (Some(i), Some(j)) = (ps.profiles.iter().position(|p| p.origin == origin_old), ps.profiles.iter().position(|p| p.origin == origin_new)) else {
        return Ok(None);
    };
    let (eps, name, mode) = (ps.profiles[j].endpoints.clone(), ps.profiles[j].name.clone(), ps.profiles[j].mode.clone());
    let new_id = ps.profiles[j].id.clone();
    let old = &mut ps.profiles[i];
    old.endpoints = eps;
    old.origin = origin_new.to_string();
    old.mode = mode;
    // Название — по новому серверу («Франкфурт», «Франкфурт через каскад»).
    if !name.is_empty() {
        old.name = name;
    }
    let id = old.id.clone();
    ps.profiles.retain(|p| p.id != new_id);
    if ps.active.as_deref() == Some(&new_id) {
        ps.active = Some(id.clone());
    }
    profiles::save(&ps)?;
    Ok(Some(id))
}

pub(super) async fn run(from: &str, to: &str, clean_old: bool, log: &Log) -> Result<OpResult, String> {
    let mut st = load();
    let pl = plan(&st, from, to);
    if let Some(e) = pl.error {
        return Err(e);
    }
    let a = st.servers.iter().find(|x| x.id == from).cloned().ok_or("сервер не найден")?;
    let b_id = to.to_string();
    // 1. Ключи, порты и доступы — на B; ставим те же протоколы. Прежние
    // секреты B (ключ SSH wpx и др.) — на случай отката.
    let b_secrets = st.servers.iter().find(|x| x.id == b_id).map(|b| b.secrets_enc.clone()).unwrap_or_default();
    if let Some(b) = st.servers.iter_mut().find(|x| x.id == b_id) {
        b.vless = a.vless.clone();
        b.hy2 = a.hy2.clone();
        b.awg = a.awg.clone();
        b.xhttp = a.xhttp.clone();
        b.mtproxy = a.mtproxy.clone();
        b.guests = a.guests.clone();
        b.fw = a.fw.clone();
        b.secrets_enc = a.secrets_enc.clone();
    }
    save(&st)?;
    let mut probe = vec![];
    if a.vless.is_some() || a.hy2.is_some() || a.awg.is_some() || a.xhttp.is_some() || a.mtproxy.is_some() {
        log("step", format!("Переезд «{}» → «{}»: ставлю VPN с прежними ключами", pl.from, pl.to));
        let r = install(&b_id, Want { vless: a.vless.is_some(), hy2: a.hy2.is_some(), awg: a.awg.is_some(), xhttp: a.xhttp.is_some(), mtproxy: a.mtproxy.is_some(), harden: true, runtime: None, cover: None }, log).await;
        let r = match r {
            Ok(r) => r,
            Err(e) => {
            // Не встало — B снова «чистый» в wpx, A не тронут.
            let mut st = load();
            if let Some(b) = st.servers.iter_mut().find(|x| x.id == b_id) {
                b.vless = None;
                b.hy2 = None;
                b.awg = None;
                b.xhttp = None;
                b.mtproxy = None;
                b.guests.clear();
                b.fw = None;
                b.secrets_enc = b_secrets.clone();
            }
            let _ = save(&st);
            return Err(format!("{e} — прежний сервер не тронут"));
            }
        };
        probe = r.probe;
        if let Some(id) = adopt_profile(&format!("server:{from}"), &format!("server:{to}"))? {
            log("ok", format!("Профиль ({id}) теперь ведёт на новый сервер"));
        }
    }
    // 2. A был выходом каскада: входы → на B, маршрут сохраняет свой id.
    let mut entries: Vec<(String, Option<String>)> = load()
        .servers
        .iter()
        .filter_map(|e| e.pipes.iter().find(|x| x.to == from).map(|p| (e.id.clone(), p.hop.clone())))
        .collect();
    entries.sort_by_key(|(_, h)| h.is_some());
    for (e, h) in &entries {
        cascade(e, &b_id, h.as_deref(), log).await?;
    }
    if !entries.is_empty() {
        adopt_profile(&format!("route:{from}"), &format!("route:{to}"))?;
    }
    for (e, _) in entries.iter().rev() {
        cascade_remove(e.clone(), from.to_string(), log).await?;
    }
    // 3. A был входом: те же трубы — на B (цепочки — через тот же промежуточный).
    let mut exits: Vec<(String, Option<String>)> = a.pipes.iter().filter(|x| !x.to.is_empty()).map(|x| (x.to.clone(), x.hop.clone())).collect();
    exits.dedup();
    for (x, h) in &exits {
        cascade(&b_id, x, h.as_deref(), log).await?;
    }
    // 3б. A был промежуточным звеном цепочек: их входы — через B.
    let chains: Vec<(String, String)> = load()
        .servers
        .iter()
        .flat_map(|e| e.pipes.iter().filter(|p| p.hop.as_deref() == Some(from)).map(|p| (e.id.clone(), p.to.clone())).collect::<Vec<_>>())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    for (e, x) in &chains {
        cascade(e, x, Some(&b_id), log).await?;
    }
    // 4. Старый сервер.
    if clean_old {
        let a_now = load().servers.into_iter().find(|x| x.id == from);
        match a_now {
            Some(a_now) => match uninstall(&a_now, log).await {
                Ok(_) => log("ok", format!("С «{}» убрано всё, что ставил wpx", pl.from)),
                Err(e) => log("warn", format!("Старый сервер не почистил ({e}) — можно позже «Убрать с сервера»")),
            },
            None => {}
        }
    }
    let note = (pl.guests > 0).then(|| format!("Доступам ({}) нужен новый QR: «Поделиться» на «{}» → «QR и ссылки».", pl.guests, pl.to));
    let ps = profiles::load();
    let active_moved = ps.active.as_ref().and_then(|id| ps.profiles.iter().find(|p| &p.id == id)).is_some_and(|p| p.origin == format!("server:{to}") || p.origin == format!("route:{to}"));
    let note = match (note, active_moved) {
        (n, true) => Some(format!("{}Рабочий профиль переехал — нажмите «Сделать рабочим» ещё раз, чтобы движок взял новый адрес.", n.map(|n| format!("{n} ")).unwrap_or_default())),
        (n, false) => n,
    };
    log("ok", format!("Переезд на «{}» готов", pl.to));
    st = load();
    Ok(OpResult { state: state(&st), probe, profile: None, note })
}

#[tauri::command]
pub fn server_move_plan(from: String, to: String) -> MovePlan {
    plan(&load(), &from, &to)
}

#[tauri::command]
pub async fn server_move(app: AppHandle, from: String, to: String, clean_old: bool) -> Result<OpResult, String> {
    let _g = BUSY.try_lock().map_err(|_| "Уже идёт операция с сервером")?;
    let log = logger(&app);
    let r = run(&from, &to, clean_old, &log).await;
    if let Err(e) = &r {
        log("fail", e.clone());
    }
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn move_plan_checks_and_steps() {
        let pipe = |to: &str| Pipe { to: to.into(), to_host: "x".into(), listen: 8443, to_port: 443, ..Default::default() };
        let a = Server {
            id: "a".into(),
            name: "Сингапур".into(),
            host: "1.1.1.1".into(),
            vless: Some(Vless { port: 443, dest: "d".into(), public_key: "k".into(), short_id: "s".into() }),
            awg: Some(Awg { port: 5000, server_public: "k".into(), obf: vec![] }),
            pipes: vec![pipe("x")],
            guests: vec![Default::default(), Default::default()],
            ..Default::default()
        };
        let b = Server { id: "b".into(), name: "Франкфурт".into(), host: "2.2.2.2".into(), ..Default::default() };
        let e = Server { id: "e".into(), name: "Вход".into(), pipes: vec![pipe("a")], ..Default::default() };
        let x = Server { id: "x".into(), name: "Хельсинки".into(), vless: a.vless.clone(), ..Default::default() };
        let st = Store { servers: vec![a.clone(), b.clone(), e, x] };
        let p = plan(&st, "a", "b");
        assert!(p.error.is_none(), "{:?}", p.error);
        assert_eq!(p.guests, 2);
        assert!(p.steps.iter().any(|s| s.contains("VLESS+Reality, AmneziaWG")));
        assert!(p.steps.iter().any(|s| s == "Каскад «Вход → Сингапур» станет «Вход → Франкфурт»"));
        assert!(p.steps.iter().any(|s| s == "Вход каскада: «Сингапур → Хельсинки» станет «Франкфурт → Хельсинки»"));
        // На занятый сервер и на себя — нельзя.
        assert!(plan(&st, "a", "x").error.unwrap().contains("уже стоит VPN"));
        assert!(plan(&st, "a", "a").error.is_some());
    }
}
