//! История точек подключения по часам суток: сколько проверок прошло,
//! задержка, заморозки — для «умного выбора» (в это время обычно лучше …).
//!
//! Ключ точки — «тип сервер:порт»: переживает переименование профилей и
//! одинаков у монитора и песочницы. Пишется в память, на диск — не чаще
//! раза в минуту. Старое затухает: в часе больше 400 проверок — всё пополам.

use chrono::Timelike;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::config;

#[derive(Serialize, Deserialize, Clone, Default, Debug, PartialEq)]
pub struct Bucket {
    pub tries: u32,
    pub ok: u32,
    pub ms_sum: u64,
    /// Проверок на заморозку и сколько из них встали.
    pub bulk: u32,
    pub stalls: u32,
}

impl Bucket {
    fn add(&mut self, o: &Bucket) {
        self.tries += o.tries;
        self.ok += o.ok;
        self.ms_sum += o.ms_sum;
        self.bulk += o.bulk;
        self.stalls += o.stalls;
    }
    fn halve(&mut self) {
        self.tries /= 2;
        self.ok /= 2;
        self.ms_sum /= 2;
        self.bulk /= 2;
        self.stalls /= 2;
    }
}

#[derive(Serialize, Deserialize, Default)]
struct Store {
    /// ключ → 24 часа.
    points: HashMap<String, Vec<Bucket>>,
}

struct State {
    store: Store,
    saved: Instant,
    dirty: bool,
}

static H: Mutex<Option<State>> = Mutex::new(None);

fn path() -> std::path::PathBuf {
    config::data_dir().join("history.json")
}

fn with<R>(f: impl FnOnce(&mut State) -> R) -> R {
    let mut g = H.lock().unwrap_or_else(|p| p.into_inner());
    let st = g.get_or_insert_with(|| State {
        store: std::fs::read_to_string(path()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default(),
        saved: Instant::now(),
        dirty: false,
    });
    let r = f(st);
    if st.dirty && st.saved.elapsed() > Duration::from_secs(60) {
        if let Ok(t) = serde_json::to_string(&st.store) {
            let _ = std::fs::write(path(), t);
        }
        st.saved = Instant::now();
        st.dirty = false;
    }
    r
}

/// Ключ точки: тип движка (vless, hysteria2, wireguard, http…), сервер, порт.
pub fn key(kind: &str, server: &str, port: u16) -> String {
    format!("{kind}|{server}:{port}")
}

pub fn key_of(e: &crate::profiles::proto::Endpoint) -> String {
    let t = crate::profiles::proto::to_mihomo(e, "x");
    key(t["type"].as_str().unwrap_or("?"), &e.server, e.port)
}

fn hour() -> usize {
    chrono::Local::now().hour() as usize
}

fn bump(k: &str, f: impl FnOnce(&mut Bucket)) {
    let h = hour();
    with(|st| {
        let v = st.store.points.entry(k.to_string()).or_insert_with(|| vec![Bucket::default(); 24]);
        if v.len() != 24 {
            *v = vec![Bucket::default(); 24];
        }
        f(&mut v[h]);
        if v[h].tries > 400 {
            v[h].halve();
        }
        st.dirty = true;
    });
}

/// Проверки задержки: `tries` попыток, из них `ok` удачных с медианой `ms`.
pub fn record(k: &str, tries: u32, ok: u32, ms: Option<u32>) {
    if tries == 0 {
        return;
    }
    bump(k, |b| {
        b.tries += tries;
        b.ok += ok;
        b.ms_sum += ms.unwrap_or(0) as u64 * ok as u64;
    });
}

/// Проверка на заморозку (256 КБ через точку).
pub fn record_bulk(k: &str, stalled: bool) {
    bump(k, |b| {
        b.bulk += 1;
        b.stalls += stalled as u32;
    });
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Score {
    /// Проверок в расчёте, доля удачных, средняя задержка, доля заморозок.
    pub tries: u32,
    pub rate: f64,
    pub ms: Option<u32>,
    pub stall_rate: f64,
    /// Чем меньше, тем лучше: задержка с поправкой на сбои и заморозки.
    pub cost: f64,
    /// Посчитано по этому часу (±1) или, если данных мало, по всем суткам.
    pub by_hour: bool,
}

fn score_of(b: &Bucket, by_hour: bool) -> Option<Score> {
    if b.tries < 6 {
        return None;
    }
    // Для расчёта — сглаженная доля (мало проверок не дают 100%), людям — как есть.
    let smooth = (b.ok as f64 + 1.0) / (b.tries as f64 + 2.0);
    let ms = (b.ok > 0).then(|| (b.ms_sum / b.ok as u64) as u32);
    let stall_rate = if b.bulk > 0 { b.stalls as f64 / b.bulk as f64 } else { 0.0 };
    let cost = ms.unwrap_or(5000) as f64 * (1.0 + 3.0 * (1.0 - smooth)) * (1.0 + 4.0 * stall_rate);
    Some(Score { tries: b.tries, rate: b.ok as f64 / b.tries as f64, ms, stall_rate, cost, by_hour })
}

/// Оценка точки на час `h`: этот час и соседние (половинный вес); мало
/// данных — по всем суткам.
fn score_at(v: &[Bucket], h: usize) -> Option<Score> {
    let mut b = v[h].clone();
    for d in [23, 1] {
        let n = &v[(h + d) % 24];
        b.add(&Bucket { tries: n.tries / 2, ok: n.ok / 2, ms_sum: n.ms_sum / 2, bulk: n.bulk / 2, stalls: n.stalls / 2 });
    }
    score_of(&b, true).or_else(|| {
        let mut all = Bucket::default();
        v.iter().for_each(|x| all.add(x));
        score_of(&all, false)
    })
}

pub fn score(k: &str) -> Option<Score> {
    let h = hour();
    with(|st| st.store.points.get(k).and_then(|v| score_at(v, h)))
}

/// Лучший час для точки (по стоимости) — подсказка «лучше всего в 3 ч».
pub fn best_hour(k: &str) -> Option<usize> {
    with(|st| {
        let v = st.store.points.get(k)?;
        (0..24).filter_map(|h| score_of(&v[h], true).map(|s| (h, s.cost))).min_by(|a, b| a.1.total_cmp(&b.1)).map(|(h, _)| h)
    })
}

/// Сбросить на диск сейчас (при выходе).
pub fn flush() {
    if let Ok(mut g) = H.lock() {
        if let Some(st) = g.as_mut().filter(|s| s.dirty) {
            if let Ok(t) = serde_json::to_string(&st.store) {
                let _ = std::fs::write(path(), t);
            }
            st.dirty = false;
        }
    }
}

/// Кого выбрать из живых точек: (имя в конфиге, ключ истории). Переключать,
/// только если лучший заметно лучше текущего (на 20%+) — без дёрганья.
pub fn pick<'a>(alive: &'a [(String, String)], current: Option<&str>) -> Option<(&'a str, Score)> {
    let scored: Vec<(&str, Score)> = alive.iter().filter_map(|(n, k)| score(k).map(|s| (n.as_str(), s))).collect();
    let best = scored.iter().min_by(|a, b| a.1.cost.total_cmp(&b.1.cost))?;
    match current.and_then(|c| scored.iter().find(|(n, _)| *n == c)) {
        Some((n, cur)) if *n == best.0 || best.1.cost > cur.cost * 0.8 => None,
        _ if current == Some(best.0) => None,
        _ => Some((best.0, best.1.clone())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hour_scores_prefer_reliable_fast_and_not_frozen() {
        let b = |tries, ok, ms: u64, bulk, stalls| Bucket { tries, ok, ms_sum: ms * ok as u64, bulk, stalls };
        let mut v = vec![Bucket::default(); 24];
        v[20] = b(40, 40, 400, 0, 0);
        // Ночью мало данных по часу — считается по суткам.
        let s = score_at(&v, 3).unwrap();
        assert!(!s.by_hour && s.ms == Some(400));
        assert!(score_at(&v, 20).unwrap().by_hour);
        // Быстрая, но с заморозками — дороже медленной без них.
        let fast_frozen = score_of(&b(40, 40, 300, 4, 3), true).unwrap();
        let slow_ok = score_of(&b(40, 40, 700, 4, 0), true).unwrap();
        assert!(fast_frozen.cost > slow_ok.cost);
        // Частые сбои дороже лишних 200 мс.
        let flaky = score_of(&b(40, 20, 300, 0, 0), true).unwrap();
        let steady = score_of(&b(40, 40, 500, 0, 0), true).unwrap();
        assert!(flaky.cost > steady.cost);
        assert!(score_of(&b(3, 3, 100, 0, 0), true).is_none());
    }
}
