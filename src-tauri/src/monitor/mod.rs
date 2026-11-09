//! Сердце wpx: фоновые проверки, оценка состояния, история простоев,
//! уведомления и отдача снимка интерфейсу.

pub mod diag;
pub mod history;
pub mod netstat;
pub mod probes;
pub mod speedtest;

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;

use crate::config::{self, Creds, EngineConfig, EngineFacts, EngineKind, Settings};
use crate::engine::guard::{self, GuardItem};
use crate::engine::logtail::{self, Kind, LogEvent, LogTail};
use crate::engine::ops::ApplyResult;
use probes::LegResult;

const TUNNEL_EVERY: Duration = Duration::from_secs(4);
const LEGS_EVERY: Duration = Duration::from_secs(15);
const GUARD_EVERY: Duration = Duration::from_secs(30);
const LATENCY_CAP: usize = 900; // 1 час по 4 с
const TRAFFIC_CAP: usize = 300; // 5 минут по 1 с
const EVENTS_CAP: usize = 400;
const ERR_MINUTES: usize = 180;

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Health {
    Starting,
    Online,
    Slow,
    Down,
    EngineOff,
}

#[derive(Serialize, Clone, Debug)]
pub struct Leg {
    /// Имя в конфиге движка; у прокси-профиля — "HTTP" | "SOCKS5".
    pub name: String,
    /// Для людей: «HTTP», «Сингапур · Hysteria2».
    pub label: String,
    /// Протокол точки: http, socks5, vless, hysteria2, wireguard, trojan, ss.
    pub kind: String,
    /// Транспорт VLESS ("xhttp"…); пусто — обычный TCP.
    pub net: String,
    /// "exit" — выход, "entry" — вход каскада.
    pub role: &'static str,
    pub server: String,
    pub port: u16,
    /// Этот выход сейчас использует движок.
    pub active: bool,
    pub result: LegResult,
    pub at: i64,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct Engine {
    pub running: bool,
    pub pid: Option<u32>,
    pub uptime_s: u64,
    pub mem_mb: u64,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct Traffic {
    pub found: bool,
    pub rx_bps: u64,
    pub tx_bps: u64,
    pub rx_total: u64,
    pub tx_total: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Outage {
    pub start: i64,
    pub end: Option<i64>,
    pub cause: String,
}

/// Что проверять рукопожатием: (метка, сервер, порт, учётка, имя в конфиге).
#[derive(Clone)]
struct LegTarget {
    name: String,
    label: String,
    kind: String,
    net: String,
    role: &'static str,
    server: String,
    port: u16,
    creds: Option<Creds>,
    proxy_name: Option<String>,
    tls: Option<probes::Tls>,
}

pub struct Inner {
    pub settings: Settings,
    pub facts: Option<EngineFacts>,
    pub config_err: Option<String>,
    pub engine_kind: EngineKind,
    pub boot: Option<bool>,
    pub profile: Option<String>,

    pub health: Option<Health>,
    pub health_since: i64,
    pub last_ms: Option<u32>,
    pub last_err: Option<String>,
    /// Последние 10 результатов туннеля (true = ок).
    pub recent: VecDeque<bool>,
    pub latency: VecDeque<(i64, Option<u32>)>,

    pub legs: Vec<Leg>,
    pub engine: Engine,
    pub traffic: Traffic,
    pub traffic_series: VecDeque<(i64, u64, u64)>,

    pub guard: Vec<GuardItem>,
    pub guard_at: i64,
    pub ip: Option<String>,
    pub ip_expected: bool,

    pub events: Vec<LogEvent>,
    /// (минута unix ms, ошибок)
    pub err_minutes: VecDeque<(i64, u32)>,

    pub outages: Vec<Outage>,

    pub secret: Option<String>,
    /// Активный выход группы по данным API mihomo (имя прокси).
    pub group_now: Option<String>,
    /// Лаборатория: звенья взяты у пробного движка (название профиля).
    pub legs_trial: Option<String>,
    /// Идёт операция с движком — простой ожидаем, не тревожим.
    pub busy: bool,
    pub heal: bool,
    /// Резервный профиль (id, название), если он не сам рабочий.
    pub reserve: Option<(String, String)>,
    /// Рабочий VPN не отвечает — трафик идёт через резерв.
    pub on_reserve: bool,
    /// Свой сервер рабочего профиля (выход) — для «Где рвётся?».
    pub server_id: Option<String>,
    /// Пауза: движок работает, но весь трафик идёт напрямую (режим «direct»).
    pub paused: bool,
    /// Пауза до этого времени (unix ms); нет — до «Включить VPN».
    pub pause_until: Option<i64>,
    /// Подписи точек: имя в конфиге движка → «Сингапур · VLESS» (для «Трафика»).
    pub labels: Vec<(String, String)>,
}

#[derive(Clone)]
pub struct Shared {
    pub inner: Arc<Mutex<Inner>>,
    pub wake_tunnel: Arc<Notify>,
    pub wake_legs: Arc<Notify>,
    pub wake_guard: Arc<Notify>,
    /// Журнал движка сменился (перенос) — перечитать с начала.
    pub wake_log: Arc<Notify>,
}

impl Shared {
    pub fn new() -> Self {
        let settings = config::load_settings();
        let pause_until = settings.pause_until;
        let inner = Inner {
            settings,
            facts: None,
            config_err: None,
            engine_kind: config::active().kind,
            boot: config::wpx_boot_enabled(),
            profile: None,
            health: None,
            health_since: now_ms(),
            last_ms: None,
            last_err: None,
            recent: VecDeque::new(),
            latency: VecDeque::new(),
            legs: vec![],
            engine: Engine::default(),
            traffic: Traffic::default(),
            traffic_series: VecDeque::new(),
            guard: vec![],
            guard_at: 0,
            ip: None,
            ip_expected: false,
            events: vec![],
            err_minutes: VecDeque::new(),
            outages: load_outages(),
            secret: None,
            group_now: None,
            legs_trial: None,
            busy: false,
            heal: config::wpx_heal_enabled(),
            reserve: None,
            on_reserve: false,
            server_id: None,
            paused: false,
            pause_until,
            labels: vec![],
        };
        Self {
            inner: Arc::new(Mutex::new(inner)),
            wake_tunnel: Arc::new(Notify::new()),
            wake_legs: Arc::new(Notify::new()),
            wake_guard: Arc::new(Notify::new()),
            wake_log: Arc::new(Notify::new()),
        }
    }

    pub fn settings(&self) -> Settings {
        self.with(|i| i.settings.clone())
    }

    pub fn set_settings(&self, s: Settings) {
        self.with(|i| i.settings = s);
    }

    pub fn with<R>(&self, f: impl FnOnce(&mut Inner) -> R) -> R {
        let mut g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        f(&mut g)
    }

    pub fn wake_all(&self) {
        self.wake_tunnel.notify_one();
        self.wake_legs.notify_one();
        self.wake_guard.notify_one();
    }
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

// ─── Снимок для интерфейса ───────────────────────────────────────

#[derive(Serialize)]
pub struct Snapshot {
    pub t: i64,
    pub health: Health,
    pub health_since: i64,
    pub cause: Option<String>,
    pub last_ms: Option<u32>,
    pub last_err: Option<String>,
    pub server: String,
    pub active_kind: String,
    pub config_err: Option<String>,
    pub legs: Vec<Leg>,
    pub engine: Engine,
    pub traffic: Traffic,
    pub guard: Vec<GuardItem>,
    pub guard_at: i64,
    pub ip: Option<String>,
    pub ip_expected: bool,
    pub events: Vec<LogEvent>,
    pub latency_tail: Vec<(i64, Option<u32>)>,
    pub traffic_tail: Vec<(i64, u64, u64)>,
    pub current_outage: Option<Outage>,
    pub slow_ms: u32,
    /// Несколько выходов с автопереключением.
    pub dual: bool,
    /// Какой выход сейчас в работе (подпись точки).
    pub active_leg: Option<String>,
    /// Лаборатория: звенья и карта — пробного движка этого профиля.
    pub legs_trial: Option<String>,
    pub busy: bool,
    pub engine_kind: EngineKind,
    pub boot: Option<bool>,
    pub profile: Option<String>,
    pub tun_device: String,
    /// Самовосстановление включено.
    pub heal: bool,
    /// Резерв: (id, название) — кнопка «На резерв»; сейчас ли трафик через него.
    pub reserve: Option<(String, String)>,
    pub on_reserve: bool,
    pub server_id: Option<String>,
    pub paused: bool,
    pub pause_until: Option<i64>,
}

#[derive(Serialize)]
pub struct FullState {
    pub snapshot: Snapshot,
    pub latency: Vec<(i64, Option<u32>)>,
    pub traffic: Vec<(i64, u64, u64)>,
    pub err_minutes: Vec<(i64, u32)>,
    pub outages: Vec<Outage>,
}

pub fn snapshot(i: &Inner) -> Snapshot {
    let health = i.health.unwrap_or(Health::Starting);
    Snapshot {
        t: now_ms(),
        health,
        health_since: i.health_since,
        cause: (health == Health::Down || health == Health::EngineOff).then(|| cause(i)),
        last_ms: i.last_ms,
        last_err: i.last_err.clone(),
        server: i.facts.as_ref().map(|f| f.server.clone()).unwrap_or_default(),
        active_kind: i.facts.as_ref().map(|f| f.active_kind.clone()).unwrap_or_default(),
        config_err: i.config_err.clone(),
        legs: i.legs.clone(),
        engine: i.engine.clone(),
        traffic: i.traffic.clone(),
        guard: i.guard.clone(),
        guard_at: i.guard_at,
        ip: i.ip.clone(),
        ip_expected: i.ip_expected,
        events: i.events.iter().rev().take(80).cloned().collect(),
        latency_tail: i.latency.iter().rev().take(3).rev().cloned().collect(),
        traffic_tail: i.traffic_series.iter().rev().take(3).rev().cloned().collect(),
        current_outage: i.outages.last().filter(|o| o.end.is_none()).cloned(),
        slow_ms: i.settings.slow_ms,
        dual: i.facts.as_ref().map(|f| f.active_kind == "group").unwrap_or(false)
            && i.legs.iter().filter(|l| l.at > 0).count() > 1,
        active_leg: i.legs.iter().find(|l| l.active && l.role == "exit").map(|l| l.label.clone()),
        legs_trial: i.legs_trial.clone(),
        busy: i.busy,
        engine_kind: i.engine_kind,
        boot: i.boot,
        profile: i.profile.clone(),
        tun_device: i.facts.as_ref().map(|f| f.tun_device.clone()).unwrap_or_default(),
        heal: i.heal,
        reserve: i.reserve.clone(),
        on_reserve: i.on_reserve,
        server_id: i.server_id.clone(),
        paused: i.paused,
        pause_until: i.pause_until.filter(|_| i.paused),
    }
}

#[tauri::command]
pub fn get_state(shared: tauri::State<'_, Shared>) -> FullState {
    shared.with(|i| FullState {
        snapshot: snapshot(i),
        latency: i.latency.iter().cloned().collect(),
        traffic: i.traffic_series.iter().cloned().collect(),
        err_minutes: i.err_minutes.iter().cloned().collect(),
        outages: i.outages.iter().rev().take(100).cloned().collect(),
    })
}

#[tauri::command]
pub fn check_now(shared: tauri::State<'_, Shared>) {
    shared.wake_all();
}

// ─── Операции с движком ──────────────────────────────────────────

/// Выполнить операцию (в отдельном потоке — там окно UAC и ожидание),
/// не тревожить уведомлениями о плановом простое, потом всё перепроверить.
pub async fn engine_op<F>(app: AppHandle, shared: Shared, op: F) -> ApplyResult
where
    F: FnOnce() -> ApplyResult + Send + 'static,
{
    if shared.with(|i| std::mem::replace(&mut i.busy, true)) {
        return ApplyResult::fail("Уже выполняется другая операция");
    }
    let res = tokio::task::spawn_blocking(op)
        .await
        .unwrap_or_else(|e| ApplyResult::fail(e.to_string()));
    let kind = config::active().kind;
    let changed = shared.with(|i| {
        i.busy = false;
        i.recent.clear(); // состояние оцениваем заново, после операции
        i.boot = config::wpx_boot_enabled();
        i.heal = config::wpx_heal_enabled();
        let ch = i.engine_kind != kind;
        i.engine_kind = kind;
        ch
    });
    if changed {
        shared.wake_log.notify_one();
    }
    shared.wake_all();
    let _ = app.emit("engine-op", &res);
    res
}

// ─── Оценка состояния ────────────────────────────────────────────

fn cause(i: &Inner) -> String {
    if !i.engine.running {
        return "Движок (mihomo) не запущен".into();
    }
    let checked: Vec<&Leg> = i.legs.iter().filter(|l| l.at > 0).collect();
    if !checked.is_empty() && checked.iter().all(|l| !l.result.ok) {
        return "Сервер прокси не отвечает ни по одному порту".into();
    }
    if checked.iter().any(|l| l.result.ok) {
        return "Прокси отвечает, но туннель не пропускает трафик".into();
    }
    "Туннель не пропускает трафик".into()
}

fn evaluate(i: &Inner) -> Health {
    if !i.engine.running {
        return Health::EngineOff;
    }
    let tail_fails = i.recent.iter().rev().take_while(|ok| !**ok).count();
    if tail_fails >= 2 {
        return Health::Down;
    }
    if i.recent.is_empty() {
        return Health::Starting;
    }
    let fails = i.recent.iter().filter(|ok| !**ok).count();
    if fails >= 2 || i.last_ms.map(|m| m > i.settings.slow_ms).unwrap_or(false) {
        return Health::Slow;
    }
    Health::Online
}

fn human_dur(ms: i64) -> String {
    let s = ms / 1000;
    match s {
        0..=59 => format!("{s} с"),
        60..=3599 => format!("{} мин {} с", s / 60, s % 60),
        _ => format!("{} ч {} мин", s / 3600, (s % 3600) / 60),
    }
}

/// Пересчитать состояние; при смене — история простоев и уведомление.
fn transition(app: &AppHandle, shared: &Shared) {
    let note = shared.with(|i| {
        let new = evaluate(i);
        let old = i.health;
        if old == Some(new) {
            return None;
        }
        i.health = Some(new);
        i.health_since = now_ms();
        if i.busy {
            return None; // плановый перезапуск — не простой
        }
        let bad = |h: Health| matches!(h, Health::Down | Health::EngineOff);
        let mut note = None;
        if bad(new) && !old.map(bad).unwrap_or(false) {
            let c = cause(i);
            i.outages.push(Outage { start: now_ms(), end: None, cause: c.clone() });
            save_outages(&i.outages);
            note = Some(("Нет соединения".to_string(), c));
        } else if !bad(new) && old.map(bad).unwrap_or(false) {
            if let Some(o) = i.outages.last_mut().filter(|o| o.end.is_none()) {
                o.end = Some(now_ms());
                let d = human_dur(now_ms() - o.start);
                save_outages(&i.outages);
                note = Some(("Соединение восстановлено".to_string(), format!("Простой длился {d}")));
            }
        }
        if !i.settings.notify {
            note = None;
        }
        note
    });
    if let Some((title, body)) = note {
        use tauri_plugin_notification::NotificationExt;
        let _ = app.notification().builder().title(format!("wpx · {}", crate::app::lang::tr(&title))).body(crate::app::lang::tr(&body)).show();
    }
}

// ─── История простоев ────────────────────────────────────────────

fn history_path() -> std::path::PathBuf {
    config::data_dir().join("outages.json")
}

fn load_outages() -> Vec<Outage> {
    let mut v: Vec<Outage> = std::fs::read_to_string(history_path())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    // Незакрытый простой с прошлого запуска закрываем — wpx тогда не работал.
    if let Some(o) = v.last_mut().filter(|o| o.end.is_none()) {
        o.end = Some(o.start);
    }
    v
}

fn save_outages(v: &[Outage]) {
    let keep = &v[v.len().saturating_sub(300)..];
    if let Ok(t) = serde_json::to_string(keep) {
        let _ = std::fs::write(history_path(), t);
    }
}

// ─── Фоновые задачи ──────────────────────────────────────────────

pub fn spawn_all(app: AppHandle, shared: Shared) {
    tauri::async_runtime::spawn(engine_task(app.clone(), shared.clone()));
    tauri::async_runtime::spawn(tunnel_task(app.clone(), shared.clone()));
    tauri::async_runtime::spawn(legs_task(app.clone(), shared.clone()));
    tauri::async_runtime::spawn(guard_task(shared.clone()));
    tauri::async_runtime::spawn(log_task(app.clone(), shared.clone()));
    tauri::async_runtime::spawn(freeze_task(app.clone(), shared.clone()));
    tauri::async_runtime::spawn(emit_task(app, shared));
}

/// Детектор замедления: раз в 20 минут 256 КБ по рабочему пути (в
/// лаборатории — через пробный запуск, систему не трогаем). Пинг при
/// «заморозке» ТСПУ проходит, а загрузка встаёт на первых килобайтах —
/// это и ловим. Встала — повтор через 5 с; встала снова — событие.
async fn freeze_task(app: AppHandle, shared: Shared) {
    tokio::time::sleep(Duration::from_secs(180)).await;
    let mut last_alert = 0i64;
    loop {
        let path = if config::LAB {
            crate::engine::trial::port().map(Some)
        } else {
            let ok = shared.with(|i| !i.busy && i.engine_kind == EngineKind::Wpx && matches!(i.health, Some(Health::Online | Health::Slow)));
            ok.then_some(None)
        };
        if let Some(port) = path {
            let run = || tokio::task::spawn_blocking(move || crate::engine::sandbox::bulk(port));
            let mut b = run().await.ok();
            if b.as_ref().is_some_and(|b| b.stalled) {
                tokio::time::sleep(Duration::from_secs(5)).await;
                b = run().await.ok();
            }
            if let Some(note) = b.as_ref().and_then(|b| b.note()) {
                let t = now_ms();
                let via = shared.with(|i| i.legs.iter().find(|l| l.active && l.role == "exit").map(|l| l.label.clone()));
                let text = format!("Загрузка по рабочему пути {}: {note}", via.map(|v| format!("«{v}»")).unwrap_or_default());
                let notify = shared.with(|i| {
                    logtail::coalesce(&mut i.events, LogEvent { t, kind: Kind::Slowdown, dest: None, count: 1, text: text.clone() }, EVENTS_CAP);
                    i.settings.notify
                });
                // Не чаще раза в час — заморозка обычно держится долго.
                if notify && t - last_alert > 3_600_000 {
                    last_alert = t;
                    use tauri_plugin_notification::NotificationExt;
                    let _ = app
                        .notification()
                        .builder()
                        .title(crate::app::lang::tr("wpx · похоже на замедление"))
                        .body(crate::app::lang::tr(&format!("{note}. Попробуйте другой протокол или путь: «Профили» → «Проверить точки».")))
                        .show();
                }
            }
        }
        tokio::time::sleep(Duration::from_secs(20 * 60)).await;
    }
}

async fn wait(n: &Notify, d: Duration) {
    let _ = tokio::time::timeout(d, n.notified()).await;
}

/// Процесс движка и трафик TUN-адаптера (раз в секунду).
async fn engine_task(app: AppHandle, shared: Shared) {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
    let mut sys = System::new();
    let mut prev: Option<(Instant, u64, u64)> = None;
    let mut tick: u64 = 0;
    loop {
        if tick % 2 == 0 {
            sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::new().with_memory());
            let p = sys
                .processes()
                .values()
                .find(|p| p.name().eq_ignore_ascii_case(crate::config::MIHOMO));
            let engine = match p {
                Some(p) => Engine {
                    running: true,
                    pid: Some(p.pid().as_u32()),
                    // Время запуска движка от имени системы окну может быть не видно (0) —
                    // тогда run_time считался бы от 1970 года («20764 д»).
                    uptime_s: if p.start_time() > 0 { p.run_time() } else { 0 },
                    mem_mb: p.memory() / (1024 * 1024),
                },
                None => Engine::default(),
            };
            let changed = shared.with(|i| {
                let was = i.engine.running;
                i.engine = engine;
                was != i.engine.running
            });
            if changed {
                transition(&app, &shared);
            }
        }
        let dev = shared.with(|i| i.facts.as_ref().map(|f| f.tun_device.clone()).unwrap_or_else(|| "wpx".into()));
        let tun = crate::monitor::netstat::octets(&dev);
        let now = Instant::now();
        let t = now_ms();
        shared.with(|i| match tun {
            Some((rx, tx)) => {
                if let Some((pt, prx, ptx)) = prev {
                    let secs = now.duration_since(pt).as_secs_f64().max(0.2);
                    i.traffic.rx_bps = ((rx.saturating_sub(prx)) as f64 / secs) as u64;
                    i.traffic.tx_bps = ((tx.saturating_sub(ptx)) as f64 / secs) as u64;
                }
                i.traffic.found = true;
                i.traffic.rx_total = rx;
                i.traffic.tx_total = tx;
                prev = Some((now, rx, tx));
                i.traffic_series.push_back((t, i.traffic.rx_bps, i.traffic.tx_bps));
                if i.traffic_series.len() > TRAFFIC_CAP {
                    i.traffic_series.pop_front();
                }
            }
            None => {
                i.traffic = Traffic::default();
                prev = None;
            }
        });
        tick += 1;
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

/// Главный пульс: запрос через туннель раз в 4 с.
async fn tunnel_task(app: AppHandle, shared: Shared) {
    tokio::time::sleep(Duration::from_millis(600)).await;
    loop {
        let r = probes::tunnel().await;
        let t = now_ms();
        let went_bad = shared.with(|i| {
            let ok = r.is_ok();
            i.recent.push_back(ok);
            if i.recent.len() > 10 {
                i.recent.pop_front();
            }
            match &r {
                Ok(ms) => {
                    i.last_ms = Some(*ms);
                    i.last_err = None;
                }
                Err(e) => i.last_err = Some(e.clone()),
            }
            i.latency.push_back((t, r.as_ref().ok().copied()));
            if i.latency.len() > LATENCY_CAP {
                i.latency.pop_front();
            }
            !ok
        });
        transition(&app, &shared);
        if went_bad {
            // Сразу уточняем, жив ли сам прокси — для понятной причины.
            shared.wake_legs.notify_one();
        }
        wait(&shared.wake_tunnel, TUNNEL_EVERY).await;
    }
}

/// Какие выходы проверять — из конфига движка.
fn leg_targets(cfg: &EngineConfig, labels: &[(String, String)]) -> Vec<LegTarget> {
    let role = |name: &str| if name.starts_with("wpx-in-") { "entry" } else { "exit" };
    let label = |name: &str, dflt: &str| labels.iter().find(|(n, _)| n == name).map(|(_, l)| l.clone()).unwrap_or_else(|| dflt.to_string());
    let mut v = vec![];
    for (title, kind) in [("HTTP", "http"), ("SOCKS5", "socks5")] {
        if let Some(p) = cfg.by_kind(kind) {
            v.push(LegTarget {
                name: title.into(), label: label(&p.name, title), kind: kind.into(), net: String::new(), role: role(&p.name),
                server: p.server.clone(), port: p.port, creds: p.creds.clone(), proxy_name: Some(p.name.clone()), tls: p.tls.clone(),
            });
        }
    }
    // VPN-точки (VLESS, Hysteria2, AWG…): их протокол понимает только движок.
    for p in cfg.proxies.iter().filter(|p| p.kind != "http" && p.kind != "socks5") {
        v.push(LegTarget {
            name: p.name.clone(), label: label(&p.name, &p.name), kind: p.kind.clone(), net: p.network.clone(), role: role(&p.name),
            server: p.server.clone(), port: p.port, creds: None, proxy_name: Some(p.name.clone()), tls: None,
        });
    }
    v
}

/// Логины прокси пробного запуска — из памяти: в его файле конфига их нет.
fn with_creds(targets: &mut [LegTarget], creds: &[(String, Creds)]) {
    for t in targets.iter_mut().filter(|t| t.creds.is_none()) {
        t.creds = t.proxy_name.as_ref().and_then(|n| creds.iter().find(|(c, _)| c == n)).map(|(_, c)| c.clone());
    }
}

/// Проверка VPN-точки: задержка всего пути через движок (`/proxies/:name/delay`)
/// и, для первого звена по TCP, прямое соединение с сервером — чтобы отличить
/// «сервер недоступен» (роутер, провайдер) от «протокол режут».
async fn probe_vpn(t: &LegTarget, ctl: Option<&(String, String)>, first_hop: bool, bind: Option<std::net::IpAddr>) -> LegResult {
    let mut r = LegResult::default();
    if first_hop && matches!(t.kind.as_str(), "vless" | "trojan" | "ss") {
        if let Ok(ip) = t.server.parse::<std::net::IpAddr>() {
            let t0 = Instant::now();
            let sock = if ip.is_ipv4() { tokio::net::TcpSocket::new_v4() } else { tokio::net::TcpSocket::new_v6() };
            if let Ok(sock) = sock {
                if let Some(b) = bind.filter(|b| b.is_ipv4() == ip.is_ipv4()) {
                    let _ = sock.bind(std::net::SocketAddr::new(b, 0));
                }
                if let Ok(Ok(_)) = tokio::time::timeout(Duration::from_secs(4), sock.connect(std::net::SocketAddr::new(ip, t.port))).await {
                    r.connect_ms = Some(t0.elapsed().as_millis() as u32);
                }
            }
        }
    }
    let Some((addr, secret)) = ctl else {
        r.err = Some("нет API движка".into());
        return r;
    };
    let name = percent_encoding::utf8_percent_encode(t.proxy_name.as_deref().unwrap_or(&t.name), percent_encoding::NON_ALPHANUMERIC).to_string();
    let url = percent_encoding::utf8_percent_encode("http://www.gstatic.com/generate_204", percent_encoding::NON_ALPHANUMERIC).to_string();
    match crate::engine::controller::raw(addr, secret, "GET", &format!("/proxies/{name}/delay?url={url}&timeout=6000"), Duration::from_secs(9)).await {
        Ok((200, v)) => match v.get("delay").and_then(|d| d.as_u64()).filter(|d| *d > 0) {
            Some(d) => {
                r.ok = true;
                r.ready_ms = Some(d as u32);
            }
            None => r.err = Some("пустой ответ движка".into()),
        },
        Ok((_, v)) => {
            let m = v.get("message").and_then(|m| m.as_str()).unwrap_or("нет ответа").to_ascii_lowercase();
            r.err = Some(if m.contains("timeout") || m.contains("deadline") {
                if r.connect_ms.is_some() { "сервер доступен, но протокол не проходит".into() } else { "нет ответа (таймаут)".into() }
            } else {
                m
            });
        }
        Err(e) => r.err = Some(e),
    }
    if !r.ok && first_hop && r.connect_ms.is_none() && matches!(t.kind.as_str(), "vless" | "trojan" | "ss") {
        r.err = Some(format!("{}:{} недоступен напрямую (роутер или провайдер)", t.server, t.port));
    } else if !r.ok && first_hop && r.connect_ms.is_some() && t.kind == "vless" {
        r.err = Some("сервер отвечает, а VLESS не проходит — режут протокол или сайт-прикрытие; смените прикрытие: «Серверы» → «Изменить VPN»".into());
    }
    r
}

/// Подписи по самой точке: точка профиля (тип mihomo, адрес, порт, подпись)
/// → имя той же точки в работающем конфиге.
fn relabel(labels: &mut Vec<(String, String)>, pts: &[(String, &str, u16, String)], proxies: &[config::ProxyEntry]) {
    for p in proxies {
        let Some((.., l)) = pts.iter().find(|(t, s, port, _)| t == &p.kind && *s == p.server && *port == p.port) else { continue };
        match labels.iter_mut().find(|(n, _)| n == &p.name) {
            Some(x) => x.1 = l.clone(),
            None => labels.push((p.name.clone(), l.clone())),
        }
    }
}

/// Встроенные «точки» mihomo — есть в любом конфиге.
const BUILTIN_NAMES: &[&str] = &["DIRECT", "REJECT", "REJECT-DROP", "PASS", "PASS-RULE", "COMPATIBLE", "GLOBAL"];
/// Типы, которыми можно увести трафик: протоколы и группы. Неизвестный тип —
/// скорее новая встроенная «точка» будущего mihomo: тревогу не поднимаем.
const OUTBOUND_TYPES: &[&str] = &[
    "Direct", "Http", "Socks5", "Shadowsocks", "ShadowsocksR", "Snell", "Vmess", "Vless", "Trojan", "Hysteria", "Hysteria2", "WireGuard",
    "Tuic", "Ssh", "Mieru", "AnyTLS", "Relay", "Selector", "Fallback", "URLTest", "LoadBalance",
];

/// Работает ли движок по своему конфигу. API движка доступен любой программе
/// пользователя: подмену на лету (весь трафик через чужой сервер, TUN снят,
/// прокси открыт в сеть) видно по чужим точкам, правилам и флагам. Все
/// найденные отличия — пусто, если движок работает по своему конфигу.
fn mismatches(raw: &serde_json::Value, configs: &serde_json::Value, proxies: &serde_json::Value, rules: &serde_json::Value, providers: &serde_json::Value) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    // Источники правил — те же, что в конфиге (лишний — чужой список).
    if let Some(have) = providers["providers"].as_object() {
        let want: std::collections::BTreeSet<&str> = raw["rule-providers"].as_object().map(|o| o.keys().map(String::as_str).collect()).unwrap_or_default();
        if have.keys().map(String::as_str).collect::<std::collections::BTreeSet<_>>() != want {
            out.push("изменены источники правил".into());
        }
    }
    // Правила — по числу и цели каждого (mihomo отдаёт их по порядку):
    // «MATCH,DIRECT» первой строкой при тех же точках иначе не заметить.
    if let Some(have) = rules["rules"].as_array() {
        let want: Vec<&str> = raw["rules"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|r| r.as_str())
            .map(|r| {
                let mut it = r.rsplit(',');
                match it.next().unwrap_or("") {
                    "no-resolve" => it.next().unwrap_or(""),
                    t => t,
                }
            })
            .collect();
        let have: Vec<&str> = have.iter().map(|r| r["proxy"].as_str().unwrap_or("")).collect();
        if want != have {
            out.push("изменены правила".into());
        }
    }
    // Настройки, которые mihomo отдаёт как в конфиге (строки — без учёта
    // регистра: стек он пишет «Mixed»; списки — без учёта порядка: исключения
    // TUN он сортирует). Сверяем, только где есть с обеих сторон.
    for (path, what) in [
        (&["bind-address"][..], "адрес прокси"),
        (&["mixed-port"], "порт прокси"),
        (&["ipv6"], "IPv6"),
        (&["tun", "device"], "TUN"),
        (&["tun", "auto-route"], "маршруты TUN"),
        (&["tun", "strict-route"], "маршруты TUN"),
        (&["tun", "dns-hijack"], "перехват DNS"),
        (&["tun", "route-exclude-address"], "исключения TUN"),
    ] {
        let at = |v: &serde_json::Value| path.iter().fold(v.clone(), |v, k| v[*k].clone());
        let (want, have) = (at(raw), at(configs));
        if !want.is_null() && !have.is_null() && !same_value(&want, &have) {
            out.push(format!("изменено: {what}"));
        }
    }
    if configs["mode"].as_str().is_some_and(|m| !m.eq_ignore_ascii_case("rule") && !m.eq_ignore_ascii_case("direct")) {
        out.push("изменён режим движка".into());
    }
    let want_lan = raw["allow-lan"].as_bool().unwrap_or(false);
    if configs["allow-lan"].as_bool().is_some_and(|x| x != want_lan) {
        out.push("прокси открыт в локальную сеть".into());
    }
    let want_tun = raw["tun"]["enable"].as_bool().unwrap_or(false);
    if configs["tun"]["enable"].as_bool().is_some_and(|x| x != want_tun) {
        out.push(if want_tun { "TUN выключен" } else { "TUN включён" }.into());
    }
    let names = |k: &str| raw[k].as_array().into_iter().flatten().filter_map(|p| p["name"].as_str()).collect::<Vec<_>>();
    let known: std::collections::HashSet<&str> = names("proxies").into_iter().chain(names("proxy-groups")).chain(BUILTIN_NAMES.iter().copied()).collect();
    let outbound = |v: &serde_json::Value| v["type"].as_str().is_some_and(|t| OUTBOUND_TYPES.contains(&t));
    if let Some((n, _)) = proxies["proxies"].as_object().into_iter().flatten().find(|(n, v)| !known.contains(n.as_str()) && outbound(v)) {
        out.push(format!("в движке чужая точка «{n}»"));
    }
    out
}

/// Отличие, которое может дать сам движок (свой порядок, формат, новая
/// версия), а не только подмена: настройки, правила, их источники.
fn is_quirk_prone(why: &str) -> bool {
    why.starts_with("изменено: ") || why == "изменены правила" || why == "изменены источники правил"
}

/// Первое отличие (для проверок).
#[cfg(test)]
fn tampered(raw: &serde_json::Value, configs: &serde_json::Value, proxies: &serde_json::Value, rules: &serde_json::Value, providers: &serde_json::Value) -> Option<String> {
    mismatches(raw, configs, proxies, rules, providers).into_iter().next()
}

/// Одно и то же значение: строки — без учёта регистра, списки — без учёта
/// порядка (как множества).
fn same_value(a: &serde_json::Value, b: &serde_json::Value) -> bool {
    use serde_json::Value::{Array, String as S};
    match (a, b) {
        (S(x), S(y)) => x.eq_ignore_ascii_case(y),
        (Array(x), Array(y)) => x.len() == y.len() && x.iter().all(|p| y.iter().any(|q| same_value(p, q))) && y.iter().all(|q| x.iter().any(|p| same_value(p, q))),
        _ => a == b,
    }
}

/// Идёт операция с движком (своя или сторожа): конфиг на диске уже новый,
/// а движок ещё прежний — сверять рано.
fn engine_busy(shared: &Shared) -> bool {
    let maint = std::fs::metadata(std::path::Path::new(config::WPX_DIR).join("wpx-maint"))
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .is_some_and(|a| a < Duration::from_secs(360));
    maint || shared.with(|i| i.busy)
}

/// Проверить работающий движок: все отличия от его конфига (нет ответа — пусто).
async fn check_tamper(addr: &str, secret: &str, raw: &serde_json::Value) -> Vec<String> {
    let get = |p: &'static str| crate::engine::controller::raw(addr, secret, "GET", p, Duration::from_secs(3));
    let (Ok((200, configs)), Ok((200, proxies)), Ok((200, rules)), Ok((200, providers))) =
        (get("/configs").await, get("/proxies").await, get("/rules").await, get("/providers/rules").await)
    else {
        return vec![];
    };
    mismatches(raw, &configs, &proxies, &rules, &providers)
}

/// Вернуть движку его конфиг из файла — на лету, без перезапуска и окна UAC
/// (текстом: файл лежит вне домашней папки mihomo, путь он не примет).
async fn restore_config(addr: &str, secret: &str) -> bool {
    let Ok(text) = std::fs::read_to_string(std::path::Path::new(config::WPX_DIR).join("config.yaml")) else { return false };
    let body = serde_json::json!({ "payload": text }).to_string();
    matches!(crate::engine::controller::raw_body(addr, secret, "PUT", "/configs?force=true", &body, Duration::from_secs(10)).await, Ok((204 | 200, _)))
}

/// Отпечаток выбора пользователя: профиль, режим и точки с группами в
/// конфиге движка (меняются с «Применить»; правила — нет).
fn choice_of(profile: Option<(&str, &str)>, raw: Option<&serde_json::Value>) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    profile.hash(&mut h);
    if let Some(r) = raw {
        r["proxies"].to_string().hash(&mut h);
        r["proxy-groups"].to_string().hash(&mut h);
    }
    h.finish()
}

/// Точка рабочего профиля (`wpx-1`), не профиля из правил и не резерва.
fn main_point(n: &str) -> bool {
    n.strip_prefix("wpx-").is_some_and(|r| !r.is_empty() && r.chars().all(|c| c.is_ascii_digit()))
}

/// Группа точек рабочего профиля: MAIN, если есть резерв, иначе PROXY.
async fn main_group(addr: &str, secret: &str) -> &'static str {
    if crate::engine::controller::raw(addr, secret, "GET", "/proxies/MAIN", Duration::from_secs(2)).await.map(|r| r.0) == Ok(200) {
        crate::engine::netcfg::MAIN_GROUP
    } else {
        crate::engine::netcfg::GROUP
    }
}

const FLAP_WINDOW: i64 = 20 * 60_000;
const FLAP_HOLD: i64 = 60 * 60_000;

/// Скачки пути: точка то пропадает, то возвращается, и движок прыгает между
/// точками. Три ухода за 20 минут — держим живую точку, с которой не уходили.
#[derive(Default)]
struct Flaps {
    /// (когда, с какой точки ушли).
    left: VecDeque<(i64, String)>,
    /// Держим точку до этого времени.
    until: Option<i64>,
    /// «Нестабильны все» уже сказали.
    told: bool,
}

#[derive(Debug, PartialEq)]
enum Flap {
    /// Закрепить (имя в конфиге, подпись); скачущая точка, сколько уходов.
    Hold(String, String, String, usize),
    /// Скачут все точки — дело не в точке, а в канале.
    AllShaky(usize),
    Calm,
}

impl Flaps {
    /// Учесть уход с точки `from`. `alive` — живые точки: (имя, подпись, мс).
    fn left_from(&mut self, t: i64, from: &str, alive: &[(String, String, u32)]) -> Flap {
        self.left.push_back((t, from.to_string()));
        self.left.retain(|(x, _)| t - x < FLAP_WINDOW);
        let n = self.left.len();
        if n < 3 {
            self.told = false;
        }
        if self.until.is_some() || n < 3 {
            return Flap::Calm;
        }
        let shaky = |l: &str| self.left.iter().any(|(_, x)| x == l);
        let Some((name, label, _)) = alive.iter().filter(|(_, l, _)| !shaky(l)).min_by_key(|(_, _, ms)| *ms) else {
            if self.told {
                return Flap::Calm;
            }
            self.told = true;
            return Flap::AllShaky(n);
        };
        let worst = self.left.iter().map(|(_, l)| l).max_by_key(|l| self.left.iter().filter(|(_, x)| x == *l).count()).cloned().unwrap_or_default();
        self.until = Some(t + FLAP_HOLD);
        self.left.clear();
        Flap::Hold(name.clone(), label.clone(), worst, n)
    }
}

/// Умный выбор по истории: из живых точек рабочего профиля закрепить ту,
/// что в этот час обычно лучше (заметно — на 20%+). Текст для ленты, если
/// переключил. Закреплённая умерла — движок сам уйдёт на живую.
async fn smart_pick(addr: &str, secret: &str, legs: &[(&LegTarget, &LegResult)], now: Option<&str>) -> Option<String> {
    let alive: Vec<(String, String)> = legs
        .iter()
        .filter(|(tg, r)| r.ok && tg.role == "exit" && tg.proxy_name.as_deref().is_some_and(main_point))
        .map(|(tg, _)| (tg.proxy_name.clone().unwrap_or_default(), crate::monitor::history::key(&tg.kind, &tg.server, tg.port)))
        .collect();
    let (best, s) = crate::monitor::history::pick(&alive, now)?;
    crate::engine::controller::pin(addr, secret, main_group(addr, secret).await, best).await.ok()?;
    let label = legs.iter().find(|(x, _)| x.proxy_name.as_deref() == Some(best)).map(|(x, _)| x.label.clone()).unwrap_or(best.to_string());
    Some(format!(
        "Умный выбор: {} обычно лучше «{label}» (~{} мс, {:.0}% успеха) — переключил",
        if s.by_hour { "в это время" } else { "по истории" },
        s.ms.unwrap_or(0),
        s.rate * 100.0
    ))
}

/// Лаборатория: звенья пробного движка так, как их видит монитор
/// (подпись, роль, TCP до сервера, путь через движок); история пишется.
/// `smart` — сразу и умный выбор (текст, если переключил).
pub async fn trial_legs(smart: bool) -> (Vec<(String, &'static str, String, LegResult)>, Option<String>) {
    let Some(t) = crate::engine::trial::source() else { return (vec![], None) };
    let Ok(cfg) = config::read_config_at(&t.config) else { return (vec![], None) };
    let mut targets = leg_targets(&cfg, &t.labels);
    with_creds(&mut targets, &t.creds);
    let cascade = targets.iter().any(|x| x.role == "entry");
    let bind = phys_ip().await;
    let ctl = (t.ctl.clone(), t.secret.clone());
    let mut results = vec![];
    for x in &targets {
        let r = probe_vpn(x, Some(&ctl), x.role == "entry" || !cascade, bind).await;
        crate::monitor::history::record(&crate::monitor::history::key(&x.kind, &x.server, x.port), 1, r.ok as u32, r.ready_ms);
        results.push(r);
    }
    let picked = if smart {
        let now = crate::engine::controller::group(&ctl.0, &ctl.1, crate::engine::netcfg::GROUP).await.ok().map(|g| g.now);
        let legs: Vec<(&LegTarget, &LegResult)> = targets.iter().zip(&results).collect();
        smart_pick(&ctl.0, &ctl.1, &legs, now.as_deref()).await
    } else {
        None
    };
    crate::monitor::history::flush();
    (targets.into_iter().zip(results).map(|(x, r)| (x.label, x.role, x.kind, r)).collect(), picked)
}

static PHYS_IP: Mutex<Option<(Instant, Option<std::net::IpAddr>)>> = Mutex::new(None);

/// IP физического адаптера (кэш на 5 минут): прямые проверки идут мимо TUN.
async fn phys_ip() -> Option<std::net::IpAddr> {
    if let Some((t, ip)) = *PHYS_IP.lock().unwrap() {
        if t.elapsed() < Duration::from_secs(300) {
            return ip;
        }
    }
    let iface = crate::engine::netcfg::load().interface;
    let ip = tokio::task::spawn_blocking(move || crate::servers::ssh::phys_ip(&iface)).await.ok().flatten();
    *PHYS_IP.lock().unwrap() = Some((Instant::now(), ip));
    ip
}

/// Прямое рукопожатие с прокси по каждому выходу (раз в 15 с).
async fn legs_task(app: AppHandle, shared: Shared) {
    // Прошлый активный путь: (профиль/пробный запуск, выход, вход).
    let mut last: Option<(String, String, String)> = None;
    let mut cycle: u64 = 0;
    let mut flaps = Flaps::default();
    // Когда последний раз возвращали движку его конфиг (не чаще раза в 10 минут).
    let mut restored_at: i64 = 0;
    // Отличия, которые не ушли и после возврата своего конфига, — особенности
    // движка, а не подмена: их больше не сверяем.
    let mut not_tamper: std::collections::HashSet<String> = std::collections::HashSet::new();
    // Закрепление прошлого запуска (держали точку и закрылись) снято.
    let mut unfixed = false;
    // Выбор пользователя (профиль, режим, точки в движке): поменялся — снять
    // закрепление, умный выбор — заново.
    let mut last_choice: Option<u64> = None;
    loop {
        cycle += 1;
        let cfg = config::read_engine_config();
        let store = crate::profiles::load();
        let active = store.active.as_ref().and_then(|id| store.profiles.iter().find(|p| &p.id == id));
        let profile = active.map(|p| p.name.clone());
        // Подписи точек рабочего профиля (имя в конфиге → «Сингапур · VLESS»).
        let main = active.and_then(|p| crate::profiles::chain_of(&store, p).ok());
        let mut labels: Vec<(String, String)> = main
            .as_ref()
            .map(|c| c.points().into_iter().map(|(n, e, _, title)| (n, if title.is_empty() { e.label.clone() } else { format!("{title}: {}", e.label) })).collect())
            .unwrap_or_default();
        // Профили из правил, резерв, постоянный IP: их точки тоже в «Выходах».
        let net = crate::engine::netcfg::load();
        if let Some(c) = &main {
            labels.extend(crate::engine::netcfg::side_labels(&net, &c.id).into_iter().map(|(n, l, _)| (n, l)));
        }
        // Подпись — по самой точке (протокол, адрес, порт): после перестановки
        // точек в профиле имена в работающем движке до перезапуска прежние.
        if let (Some(c), Ok(cf)) = (&main, &cfg) {
            let pts: Vec<(String, &str, u16, String)> = c
                .points()
                .into_iter()
                .map(|(n, e, _, title)| {
                    let t = crate::profiles::proto::to_mihomo(e, &n)["type"].as_str().unwrap_or("").to_string();
                    (t, e.server.as_str(), e.port, if title.is_empty() { e.label.clone() } else { format!("{title}: {}", e.label) })
                })
                .collect();
            relabel(&mut labels, &pts, &cf.proxies);
        }
        let reserve = (!net.reserve.is_empty() && store.active.as_deref() != Some(net.reserve.as_str()))
            .then(|| store.profiles.iter().find(|p| p.id == net.reserve).map(|p| (p.id.clone(), p.name.clone())))
            .flatten();
        // Профиль из своего сервера: «server:<id>», маршрут — «route:<выход>».
        let server_id = active.and_then(|p| p.origin.strip_prefix("server:").or_else(|| p.origin.strip_prefix("route:")).map(String::from));
        // Лаборатория: пока идёт пробный запуск, звенья — его (систему не трогаем).
        let trial = if config::LAB { crate::engine::trial::source() } else { None };
        // Закреплять точку: у рабочего движка; в лаборатории — только у пробного.
        let can_pin = !config::LAB || trial.is_some();
        let trial_cfg = trial.as_ref().and_then(|t| config::read_config_at(&t.config).ok());
        if let Some(t) = &trial {
            labels = t.labels.clone();
        }
        let mut targets = match (&trial_cfg, &cfg) {
            (Some(c), _) | (None, Ok(c)) => leg_targets(c, &labels),
            _ => vec![],
        };
        if let Some(t) = &trial {
            with_creds(&mut targets, &t.creds);
        }
        // Сменили режим или порядок точек — выбор пользователя важнее
        // закрепления: «по порядку» должно сразу идти по порядку.
        let choice = choice_of(
            trial.as_ref().map(|t| (t.profile.as_str(), "")).or_else(|| active.map(|p| (p.id.as_str(), p.mode.as_str()))),
            trial_cfg.as_ref().or(cfg.as_ref().ok()).map(|c| &c.raw),
        );
        let repick = last_choice.is_some_and(|c| c != choice);
        if repick {
            unfixed = false;
            flaps = Flaps::default();
        }
        last_choice = Some(choice);
        shared.with(|i| {
            match &cfg {
                Ok(c) => {
                    i.facts = Some(c.facts.clone());
                    i.secret = c.secret.clone();
                    i.config_err = None;
                }
                Err(e) => i.config_err = Some(e.clone()),
            }
            i.engine_kind = config::active().kind;
            i.profile = profile;
        });

        // API движка, у которого спрашиваем точки: пробного или рабочего.
        let ctl: Option<(String, String)> = match &trial {
            Some(t) => Some((t.ctl.clone(), t.secret.clone())),
            None => shared.with(|i| i.facts.as_ref().and_then(|f| f.controller.clone()).zip(i.secret.clone())),
        };
        let group = match &trial {
            Some(_) => Some(crate::engine::netcfg::GROUP.to_string()),
            None => shared.with(|i| i.facts.as_ref().and_then(|f| f.group.clone())),
        };
        let cascade = targets.iter().any(|t| t.role == "entry");
        let bind = phys_ip().await;

        // Выходы проверяем параллельно.
        let handles: Vec<_> = targets
            .iter()
            .cloned()
            .map(|t| {
                let ctl = ctl.clone();
                let first = t.role == "entry" || !cascade;
                tauri::async_runtime::spawn(async move {
                    if t.kind == "http" || t.kind == "socks5" { probe_leg(&t).await } else { probe_vpn(&t, ctl.as_ref(), first, bind).await }
                })
            })
            .collect();
        let mut results = vec![];
        for h in handles {
            results.push(h.await.unwrap_or_default());
        }

        let (group_now, entry_now) = match (&ctl, &group) {
            (Some((addr, secret)), Some(g)) => (
                crate::engine::controller::group(addr, secret, g).await.ok().map(|g| g.now),
                None,
            ),
            _ => (None, None),
        };
        // Пауза — только у рабочего движка (у пробного режима не меняем).
        let mut paused = match (&ctl, &trial) {
            (Some((addr, secret)), None) => crate::engine::controller::mode(addr, secret).await.is_ok_and(|m| m == "direct"),
            _ => false,
        };
        // Пауза на время: вышло — VPN обратно (пауза не должна тянуться забытой).
        if let (true, Some((addr, secret))) = (paused, &ctl) {
            if shared.with(|i| i.pause_until).is_some_and(|u| now_ms() >= u) && crate::engine::controller::set_mode(addr, secret, "rule").await.is_ok() {
                paused = false;
                shared.with(|i| {
                    i.pause_until = None;
                    i.settings.pause_until = None;
                    let _ = config::save_settings(&i.settings);
                    logtail::coalesce(&mut i.events, LogEvent { t: now_ms(), kind: Kind::Heal, dest: None, count: 1, text: "Пауза закончилась — VPN снова работает".into() }, EVENTS_CAP);
                });
            }
        }
        if !paused {
            shared.with(|i| {
                if i.settings.pause_until.is_some_and(|u| now_ms() >= u) {
                    i.settings.pause_until = None;
                    i.pause_until = None;
                    let _ = config::save_settings(&i.settings);
                }
            });
        }
        // Подмена конфига через API — только у рабочего движка wpx.
        if let (Some((addr, secret)), None, false, Ok(c)) = (&ctl, &trial, config::LAB, &cfg) {
            if config::active().kind == EngineKind::Wpx && now_ms() - restored_at > 600_000 && !engine_busy(&shared) {
                let found: Vec<String> = check_tamper(addr, secret, &c.raw).await.into_iter().filter(|w| !not_tamper.contains(w)).collect();
                if !found.is_empty() {
                    restored_at = now_ms();
                    let back = restore_config(addr, secret).await;
                    // Свой конфиг вернули — отличие должно уйти. Осталось — это
                    // особенность движка, а не подмена: эту сверку больше не
                    // делаем (без уведомлений и новых перезагрузок).
                    tokio::time::sleep(Duration::from_secs(3)).await;
                    let after = if back { check_tamper(addr, secret, &c.raw).await } else { vec![] };
                    // Не вернули — сверять нечего: всё найденное считаем подменой.
                    // Чужая точка, LAN, TUN и режим особенностью не бывают: их
                    // не отключаем (иначе программа, успевшая подменить конфиг
                    // снова за эти 3 с, выключила бы сверку).
                    let (real, quirk): (Vec<String>, Vec<String>) = found.into_iter().partition(|w| !after.contains(w) || !is_quirk_prone(w));
                    let mut texts: Vec<(String, bool)> = vec![];
                    if !quirk.is_empty() {
                        texts.push((format!("Сверка движка: «{}» не уходит и после возврата своего конфига — это особенность движка, а не подмена; эту сверку отключаю до перезапуска wpx", quirk.join(", ")), false));
                        not_tamper.extend(quirk);
                    }
                    if !real.is_empty() {
                        let why = real.join(", ");
                        texts.push((format!(
                            "Движок работал не по своему конфигу ({why}) — похоже, его поменяла программа на этом ПК через локальный API. {}",
                            if back { "wpx вернул свой конфиг" } else { "Вернуть не удалось — перезапустите движок" }
                        ), true));
                    }
                    for (text, alarm) in texts {
                        let notify = shared.with(|i| {
                            logtail::coalesce(&mut i.events, LogEvent { t: now_ms(), kind: if alarm { Kind::Other } else { Kind::Heal }, dest: None, count: 1, text: text.clone() }, EVENTS_CAP);
                            i.settings.notify && alarm
                        });
                        if notify {
                            use tauri_plugin_notification::NotificationExt;
                            let _ = app.notification().builder().title(crate::app::lang::tr("wpx · движок подменён")).body(crate::app::lang::tr(&text)).show();
                        }
                    }
                }
            }
        }
        let entry_now = match (&ctl, &group_now, cascade) {
            (Some((addr, secret)), Some(leaf), true) => {
                crate::engine::controller::group(addr, secret, &crate::engine::netcfg::entry_group_for(leaf)).await.ok().map(|g| g.now).or(entry_now)
            }
            _ => entry_now,
        };
        let t = now_ms();
        // История каждой точки — для «умного выбора».
        for (tg, r) in targets.iter().zip(&results) {
            crate::monitor::history::record(&crate::monitor::history::key(&tg.kind, &tg.server, tg.port), 1, r.ok as u32, r.ready_ms);
        }
        // Умный выбор: профиль в режиме «smart» — раз в 5 минут закрепить точку,
        // которая в этот час обычно лучше. В лаборатории — только пробный движок.
        let smart_name = trial.as_ref().map(|t| t.profile.clone()).or_else(|| active.map(|p| p.name.clone()));
        let smart = smart_name.as_ref().and_then(|n| store.profiles.iter().find(|p| &p.name == n)).is_some_and(|p| p.mode == "smart");
        if let (Some((addr, secret)), true) = (&ctl, can_pin) {
            let held_out = flaps.until.is_some_and(|u| t >= u);
            if held_out || !unfixed {
                if crate::engine::controller::unpin(addr, secret, main_group(addr, secret).await).await.is_ok() {
                    unfixed = true;
                    flaps.until = None;
                }
            }
        }
        if smart && (cycle % 20 == 1 || repick) && can_pin && flaps.until.is_none() {
            if let Some((addr, secret)) = &ctl {
                let legs: Vec<(&LegTarget, &LegResult)> = targets.iter().zip(&results).collect();
                if let Some(text) = smart_pick(addr, secret, &legs, group_now.as_deref()).await {
                    shared.with(|i| logtail::coalesce(&mut i.events, LogEvent { t: now_ms(), kind: Kind::PathSwitch, dest: None, count: 1, text }, EVENTS_CAP));
                }
            }
        }
        let trial_name = trial.map(|t| t.profile);
        shared.with(|i| {
            let kind = i.facts.as_ref().map(|f| f.active_kind.clone()).unwrap_or_default();
            i.on_reserve = group_now.as_deref().is_some_and(|n| n.starts_with("wpx-rsv-"));
            i.paused = paused;
            i.labels = labels.clone();
            i.reserve = reserve.clone();
            i.server_id = server_id.clone();
            i.group_now = group_now.clone();
            i.legs_trial = trial_name;
            i.legs = targets
                .into_iter()
                .zip(results)
                .map(|(tg, res)| Leg {
                    active: match (if tg.role == "entry" { &entry_now } else { &group_now }, &tg.proxy_name) {
                        (Some(n), Some(pn)) => n == pn,
                        _ => (tg.name == "HTTP" && kind == "http") || (tg.name == "SOCKS5" && kind == "socks5"),
                    },
                    name: tg.name,
                    label: tg.label,
                    kind: tg.kind,
                    net: tg.net,
                    role: tg.role,
                    server: tg.server,
                    port: tg.port,
                    result: res,
                    at: t,
                })
                .collect();
        });
        // Переключение пути: тот же профиль, другая активная точка или вход.
        let now = shared.with(|i| {
            let pick = |role: &str| i.legs.iter().find(|l| l.active && l.role == role).map(|l| l.label.clone()).unwrap_or_default();
            (i.legs_trial.clone().or(i.profile.clone()).unwrap_or_default(), pick("exit"), pick("entry"))
        });
        if let Some(prev) = &last {
            if prev.0 != now.0 {
                flaps = Flaps { until: flaps.until, ..Default::default() };
            }
            if prev.0 == now.0 && !now.1.is_empty() && !prev.1.is_empty() && (prev.1 != now.1 || prev.2 != now.2) {
                let what = if prev.1 != now.1 { format!("{} → {}", prev.1, now.1) } else { format!("вход {} → {}", prev.2, now.2) };
                let text = format!("Переключился на другой путь: {what}");
                // Скачет — уведомление только о первом уходе, дальше лента.
                let calm = !flaps.left.iter().any(|(x, _)| t - x < FLAP_WINDOW);
                let notify = shared.with(|i| {
                    logtail::coalesce(&mut i.events, LogEvent { t, kind: Kind::PathSwitch, dest: None, count: 1, text: text.clone() }, EVENTS_CAP);
                    i.settings.notify && calm
                });
                if notify {
                    use tauri_plugin_notification::NotificationExt;
                    let _ = app.notification().builder().title(crate::app::lang::tr("wpx · другой путь")).body(crate::app::lang::tr(&what)).show();
                }
                if prev.1 != now.1 {
                    let alive: Vec<(String, String, u32)> = shared.with(|i| {
                        i.legs
                            .iter()
                            .filter(|l| l.role == "exit" && l.result.ok && main_point(&l.name))
                            .map(|l| (l.name.clone(), l.label.clone(), l.result.ready_ms.unwrap_or(u32::MAX)))
                            .collect()
                    });
                    let text = match (flaps.left_from(t, &prev.1, &alive), &ctl, can_pin) {
                        (Flap::Hold(name, label, worst, n), Some((addr, secret)), true) => {
                            match crate::engine::controller::pin(addr, secret, main_group(addr, secret).await, &name).await {
                                Ok(()) => Some(format!("Путь «{worst}» то пропадает, то возвращается (переключений за 20 мин: {n}) — держу «{label}», пока он работает. Через час снова выберу сам")),
                                Err(_) => {
                                    flaps.until = None;
                                    None
                                }
                            }
                        }
                        (Flap::AllShaky(n), ..) => Some(format!("Пути скачут (переключений за 20 мин: {n}), пропадают все точки — похоже, нестабилен сам канал: Wi-Fi, роутер или провайдер")),
                        (Flap::Hold(..), ..) => {
                            flaps.until = None;
                            None
                        }
                        _ => None,
                    };
                    if let Some(text) = text {
                        shared.with(|i| logtail::coalesce(&mut i.events, LogEvent { t: now_ms(), kind: Kind::PathSwitch, dest: None, count: 1, text }, EVENTS_CAP));
                    }
                }
            }
        }
        if !now.1.is_empty() {
            last = Some(now);
        }
        wait(&shared.wake_legs, LEGS_EVERY).await;
    }
}

async fn probe_leg(t: &LegTarget) -> LegResult {
    match (&t.creds, t.name.as_str()) {
        (Some(c), "HTTP") => probes::leg_http(&t.server, t.port, c, t.tls.as_ref()).await,
        (Some(c), _) => probes::leg_socks(&t.server, t.port, c).await,
        (None, _) => LegResult { ok: false, err: Some("нет учётных данных".into()), ..Default::default() },
    }
}

/// Внешний IP — один из выходов профиля (у выхода с доменом сверить нельзя —
/// не предупреждаем).
fn ip_matches(facts: Option<&EngineFacts>, ip: &str) -> bool {
    facts.is_some_and(|f| f.exits.iter().any(|s| s == ip || s.parse::<std::net::IpAddr>().is_err()))
}

/// Kill switch и внешний IP (раз в 30 с).
async fn guard_task(shared: Shared) {
    tokio::time::sleep(Duration::from_secs(2)).await;
    loop {
        let ip = probes::external_ip().await;
        let loc = config::active();
        let facts = shared.with(|i| i.facts.clone());
        let alias = facts.as_ref().map(|f| f.interface.clone()).filter(|a| !a.is_empty()).unwrap_or_else(|| crate::engine::netcfg::load().interface);
        let ip_pair = ip.as_ref().ok().map(|v| (v.as_str(), ip_matches(facts.as_ref(), v)));
        let items = guard::check(facts.as_ref(), &alias, loc.fw_group, ip_pair).await;
        shared.with(|i| {
            if let Ok(v) = &ip {
                i.ip_expected = ip_matches(facts.as_ref(), v);
                i.ip = Some(v.clone());
            }
            i.guard = items;
            i.guard_at = now_ms();
        });
        wait(&shared.wake_guard, GUARD_EVERY).await;
    }
}

/// Хвост журнала движка (раз в 2 с). При смене движка — новый файл.
/// Заодно — журнал сторожа самовосстановления (heal.log).
async fn log_task(app: AppHandle, shared: Shared) {
    let mut path = config::engine_log_path();
    let mut tail = LogTail::new(path.clone());
    let mut heal = LogTail::new(config::heal_log_path());
    let started = now_ms();
    loop {
        let heal_lines = heal.poll();
        if !heal_lines.is_empty() {
            let mut notes = vec![];
            shared.with(|i| {
                for l in &heal_lines {
                    if let Some((ev, notify)) = logtail::parse_heal(l) {
                        if notify && ev.t > started && i.settings.notify {
                            notes.push(ev.text.clone());
                        }
                        // В хронологическом порядке среди событий движка.
                        let pos = i.events.iter().rposition(|e| e.t <= ev.t).map(|p| p + 1).unwrap_or(0);
                        if pos == i.events.len() {
                            logtail::coalesce(&mut i.events, ev, EVENTS_CAP);
                        } else {
                            i.events.insert(pos, ev);
                        }
                    }
                }
            });
            for n in notes {
                use tauri_plugin_notification::NotificationExt;
                let _ = app.notification().builder().title(crate::app::lang::tr("wpx · самовосстановление")).body(crate::app::lang::tr(&n)).show();
            }
        }
        let now_path = config::engine_log_path();
        if now_path != path {
            path = now_path;
            tail = LogTail::new(path.clone());
        }
        let lines = tokio::task::spawn_blocking(move || {
            let l = tail.poll();
            (tail, l)
        })
        .await;
        let Ok((t, lines)) = lines else { return };
        tail = t;
        if !lines.is_empty() {
            shared.with(|i| {
                for l in &lines {
                    if let Some(ev) = logtail::parse_line(l) {
                        if ev.kind.is_error() {
                            let minute = ev.t - ev.t.rem_euclid(60_000);
                            match i.err_minutes.back_mut() {
                                Some((m, c)) if *m == minute => *c += 1,
                                _ => {
                                    i.err_minutes.push_back((minute, 1));
                                    if i.err_minutes.len() > ERR_MINUTES {
                                        i.err_minutes.pop_front();
                                    }
                                }
                            }
                        }
                        if ev.kind != Kind::Other || ev.text.len() > 3 {
                            logtail::coalesce(&mut i.events, ev, EVENTS_CAP);
                        }
                    }
                }
            });
        }
        wait(&shared.wake_log, Duration::from_secs(2)).await;
    }
}

/// Раз в секунду — снимок в окно и обновление трея.
async fn emit_task(app: AppHandle, shared: Shared) {
    let mut last_tray: Option<(Health, Option<u32>)> = None;
    loop {
        let snap = shared.with(|i| snapshot(i));
        let key = (snap.health, snap.last_ms.map(|m| m / 50));
        if last_tray != Some(key) {
            crate::app::tray::update(&app, snap.health, snap.last_ms);
            last_tray = Some(key);
        }
        let _ = app.emit("tick", &snap);
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

// ─── Однократный прогон для `wpx --probe` ────────────────────────

pub async fn probe_report() -> serde_json::Value {
    let loc = config::active();
    let cfg = config::read_engine_config();
    let facts = cfg.as_ref().ok().map(|c| c.facts.clone());
    let tunnel = probes::tunnel().await;
    let ip = probes::external_ip().await;
    let mut legs = serde_json::Map::new();
    if let Ok(c) = &cfg {
        let ctl = c.facts.controller.clone().zip(c.secret.clone());
        for t in leg_targets(c, &[]) {
            let r = if t.kind == "http" || t.kind == "socks5" { probe_leg(&t).await } else { probe_vpn(&t, ctl.as_ref(), t.role == "entry", None).await };
            legs.insert(format!("{}:{}", t.name, t.port), serde_json::to_value(r).unwrap_or_default());
        }
    }
    let alias = facts.as_ref().map(|f| f.interface.clone()).filter(|a| !a.is_empty()).unwrap_or_else(|| crate::engine::netcfg::load().interface);
    let ip_pair = ip.as_ref().ok().map(|v| (v.as_str(), ip_matches(facts.as_ref(), v)));
    let guard = guard::check(facts.as_ref(), &alias, loc.fw_group, ip_pair).await;
    let dev = facts.as_ref().map(|f| f.tun_device.clone()).unwrap_or_default();

    let mut tail = LogTail::new(loc.log());
    let mut events = Vec::new();
    for l in tail.poll() {
        if let Some(e) = logtail::parse_line(&l) {
            logtail::coalesce(&mut events, e, 400);
        }
    }
    serde_json::json!({
        "engine": loc.kind,
        "config": cfg.as_ref().map(|c| &c.facts).map_err(|e| e.clone()),
        "tunnel": tunnel,
        "ip": ip,
        "legs": legs,
        "guard": guard,
        "tun_octets": crate::monitor::netstat::octets(&dev),
        "events_tail": events.iter().rev().take(3).collect::<Vec<_>>(),
        "events_total": events.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pts() -> Vec<(String, String, u32)> {
        [("wpx-1", "Hy2", 83), ("wpx-2", "AWG", 176), ("wpx-3", "VLESS", 244)].iter().map(|(n, l, ms)| (n.to_string(), l.to_string(), *ms)).collect()
    }

    #[test]
    fn holds_steady_point_after_three_flaps() {
        let mut f = Flaps::default();
        assert_eq!(f.left_from(0, "Hy2", &pts()), Flap::Calm);
        assert_eq!(f.left_from(60_000, "AWG", &pts()), Flap::Calm);
        // Ушли с Hy2 и AWG — держим VLESS, хоть он и медленнее.
        assert_eq!(f.left_from(120_000, "Hy2", &pts()), Flap::Hold("wpx-3".into(), "VLESS".into(), "Hy2".into(), 3));
        // Пока держим — не дёргаем.
        assert_eq!(f.left_from(180_000, "VLESS", &pts()), Flap::Calm);
    }

    #[test]
    fn spots_engine_config_swapped_via_api() {
        use serde_json::json;
        let raw = json!({"allow-lan": false, "tun": {"enable": true}, "proxies": [{"name": "wpx-0"}], "proxy-groups": [{"name": "PROXY"}]});
        let ok_cfg = json!({"allow-lan": false, "tun": {"enable": true}, "mode": "direct"});
        // Встроенные — по типу, как их отдаёт mihomo 1.19 (PASS-RULE в том числе).
        let ok_px = json!({"proxies": {"wpx-0": {"type": "Vless"}, "PROXY": {"type": "Fallback"}, "DIRECT": {"type": "Direct"}, "GLOBAL": {"type": "Selector"},
            "REJECT": {"type": "Reject"}, "PASS-RULE": {"type": "PassRule"}, "COMPATIBLE": {"type": "Compatible"}}});
        assert_eq!(tampered(&raw, &ok_cfg, &ok_px, &json!({}), &json!({})), None, "пауза (direct) — не подмена");
        let evil_px = json!({"proxies": {"wpx-0": {"type": "Vless"}, "PROXY": {"type": "Selector"}, "attacker": {"type": "Socks5"}}});
        assert!(tampered(&raw, &ok_cfg, &evil_px, &json!({}), &json!({})).unwrap().contains("attacker"));
        assert!(tampered(&raw, &json!({"allow-lan": true, "tun": {"enable": true}}), &ok_px, &json!({}), &json!({})).is_some());
        assert!(tampered(&raw, &json!({"allow-lan": false, "tun": {"enable": false}}), &ok_px, &json!({}), &json!({})).is_some());
        // Те же точки, но маршруты TUN сняты или DNS не перехватывается — подмена.
        let raw = json!({"tun": {"enable": true, "stack": "mixed", "auto-route": true, "dns-hijack": ["any:53"]}, "proxies": [{"name": "wpx-0"}], "proxy-groups": [{"name": "PROXY"}]});
        let same = json!({"tun": {"enable": true, "stack": "Mixed", "auto-route": true, "dns-hijack": ["ANY:53"]}, "mode": "rule"});
        assert_eq!(tampered(&raw, &same, &ok_px, &json!({}), &json!({})), None, "регистр — не подмена");
        assert!(tampered(&raw, &json!({"tun": {"enable": true, "auto-route": false}}), &ok_px, &json!({}), &json!({})).is_some());
        assert!(tampered(&raw, &json!({"tun": {"enable": true, "dns-hijack": []}}), &ok_px, &json!({}), &json!({})).is_some());
        assert!(tampered(&raw, &json!({"mode": "global"}), &ok_px, &json!({}), &json!({})).is_some());
        // Правила: те же цели по порядку — в порядке; «MATCH,DIRECT» первой — подмена.
        let raw = json!({"rules": ["DOMAIN-SUFFIX,a.com,PROXY", "IP-CIDR,10.0.0.0/8,DIRECT,no-resolve", "AND,((DOMAIN,x),(NETWORK,udp)),REJECT", "MATCH,PROXY"]});
        let api = |t: &[&str]| json!({"rules": t.iter().map(|p| json!({"proxy": p})).collect::<Vec<_>>()});
        assert_eq!(tampered(&raw, &json!({}), &json!({"proxies": {}}), &api(&["PROXY", "DIRECT", "REJECT", "PROXY"]), &json!({})), None);
        assert!(tampered(&raw, &json!({}), &json!({"proxies": {}}), &api(&["DIRECT", "PROXY", "DIRECT", "REJECT", "PROXY"]), &json!({})).is_some());
        // Источники правил: лишний — подмена; те же — в порядке.
        let raw = json!({"rule-providers": {"ru-inside": {}, "follow-x-1a2b": {}}});
        let prov = |n: &[&str]| json!({"providers": n.iter().map(|k| (k.to_string(), json!({}))).collect::<serde_json::Map<_, _>>()});
        assert_eq!(tampered(&raw, &json!({}), &json!({"proxies": {}}), &json!({}), &prov(&["follow-x-1a2b", "ru-inside"])), None);
        assert!(tampered(&raw, &json!({}), &json!({"proxies": {}}), &json!({}), &prov(&["follow-x-1a2b", "ru-inside", "evil"])).is_some());
        // mihomo сортирует исключения TUN — другой порядок не подмена.
        let raw = json!({"tun": {"route-exclude-address": ["10.0.0.0/8", "fe80::/10", "fc00::/7"]}});
        let api = json!({"tun": {"route-exclude-address": ["10.0.0.0/8", "fc00::/7", "fe80::/10"]}});
        assert_eq!(tampered(&raw, &api, &json!({"proxies": {}}), &json!({}), &json!({})), None);
        let api = json!({"tun": {"route-exclude-address": ["10.0.0.0/8", "fc00::/7"]}});
        assert!(tampered(&raw, &api, &json!({"proxies": {}}), &json!({}), &json!({})).is_some());
        // Неизвестный тип (новая встроенная «точка» mihomo) — не тревога.
        assert_eq!(tampered(&json!({}), &json!({}), &json!({"proxies": {"NEW-BUILTIN": {"type": "Future"}}}), &json!({}), &json!({})), None);
    }

    #[test]
    fn labels_follow_points_not_order() {
        // В профиле точки переставили (AWG первой), движок ещё со старым порядком.
        let px = |name: &str, kind: &str, port: u16| config::ProxyEntry {
            name: name.into(), kind: kind.into(), server: "203.0.113.20".into(), port, network: String::new(), creds: None, tls: None,
        };
        let running = [px("wpx-0", "hysteria2", 443), px("wpx-1", "wireguard", 51820), px("wpx-2", "vless", 443)];
        let pts: Vec<(String, &str, u16, String)> = vec![
            ("wireguard".into(), "203.0.113.20", 51820, "AmneziaWG".into()),
            ("vless".into(), "203.0.113.20", 443, "VLESS".into()),
            ("hysteria2".into(), "203.0.113.20", 443, "Hysteria2".into()),
        ];
        let mut labels = vec![("wpx-0".to_string(), "AmneziaWG".to_string()), ("wpx-1".into(), "VLESS".into()), ("wpx-2".into(), "Hysteria2".into())];
        relabel(&mut labels, &pts, &running);
        assert_eq!(labels, vec![("wpx-0".to_string(), "Hysteria2".to_string()), ("wpx-1".into(), "AmneziaWG".into()), ("wpx-2".into(), "VLESS".into())]);
    }

    #[test]
    fn old_switches_expire() {
        let mut f = Flaps::default();
        f.left_from(0, "Hy2", &pts());
        f.left_from(60_000, "Hy2", &pts());
        assert_eq!(f.left_from(FLAP_WINDOW + 61_000, "Hy2", &pts()), Flap::Calm);
    }

    #[test]
    fn all_shaky_told_once() {
        let mut f = Flaps::default();
        f.left_from(0, "Hy2", &pts());
        f.left_from(1, "AWG", &pts());
        assert_eq!(f.left_from(2, "VLESS", &pts()), Flap::AllShaky(3));
        assert_eq!(f.left_from(3, "Hy2", &pts()), Flap::Calm);
    }
}
