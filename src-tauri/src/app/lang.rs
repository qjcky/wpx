//! Язык трея и уведомлений — тот же, что у окна. Окно при старте и смене
//! языка передаёт словарь из `src/locales/<код>.json` (точные строки и
//! шаблоны с `{}`), поэтому новый язык не требует правок здесь. Пока окно не
//! сообщило язык — русский (исходный).

use std::collections::HashMap;
use std::sync::RwLock;

use serde::Deserialize;
use tauri::AppHandle;

#[derive(Deserialize, Default)]
pub struct Dict {
    #[serde(default)]
    exact: HashMap<String, String>,
    #[serde(default)]
    patterns: Vec<(String, String)>,
}

static DICT: RwLock<Option<Dict>> = RwLock::new(None);

/// Подставить по шаблону: литералы между `{}` ищутся по порядку (как `(.+?)`);
/// подстановка проходит через `sub` (русская переводится тоже).
fn by_pattern(pat: &str, out: &str, s: &str, sub: &dyn Fn(&str) -> String) -> Option<String> {
    let parts: Vec<&str> = pat.split("{}").collect();
    if parts.len() < 2 {
        return None;
    }
    let mut rest = s.strip_prefix(parts[0])?;
    let mut caps = vec![];
    for (i, lit) in parts.iter().enumerate().skip(1) {
        if i == parts.len() - 1 {
            // Последний литерал — конец строки.
            let cap = rest.strip_suffix(lit)?;
            if cap.is_empty() {
                return None;
            }
            caps.push(sub(cap));
        } else {
            let first = rest.chars().next()?.len_utf8();
            let at = rest[first..].find(lit)? + first;
            caps.push(sub(&rest[..at]));
            rest = &rest[at + lit.len()..];
        }
    }
    let mut res = String::new();
    let (mut k, mut chars) = (0, out.char_indices().peekable());
    while let Some((i, c)) = chars.next() {
        if c == '{' {
            if let Some(end) = out[i..].find('}') {
                let inner = &out[i + 1..i + end];
                if inner.is_empty() || inner.chars().all(|d| d.is_ascii_digit()) {
                    let idx = if inner.is_empty() { k += 1; k - 1 } else { inner.parse::<usize>().unwrap_or(1).saturating_sub(1) };
                    res.push_str(caps.get(idx).map(String::as_str).unwrap_or(""));
                    while chars.peek().is_some_and(|(j, _)| *j <= i + end) {
                        chars.next();
                    }
                    continue;
                }
            }
        }
        res.push(c);
    }
    Some(res)
}

/// Строка на языке окна (русская — как есть, если перевода нет).
pub fn tr(s: &str) -> String {
    let g = DICT.read().unwrap_or_else(|e| e.into_inner());
    match g.as_ref() {
        Some(d) => tr_in(d, s.trim(), 0),
        None => s.to_string(),
    }
}

fn cyr(s: &str) -> bool {
    s.chars().any(|c| matches!(c, 'А'..='я' | 'Ё' | 'ё'))
}

fn tr_in(d: &Dict, s: &str, depth: u8) -> String {
    if !cyr(s) {
        return s.to_string();
    }
    if let Some(v) = d.exact.get(s) {
        return v.clone();
    }
    let sub = |x: &str| if depth < 4 && cyr(x) { tr_in(d, x.trim(), depth + 1) } else { x.to_string() };
    let mut best: Option<(usize, String)> = None;
    for (p, o) in &d.patterns {
        if best.as_ref().is_some_and(|(l, _)| *l >= p.len()) {
            continue;
        }
        if let Some(r) = by_pattern(p, o, s, &sub) {
            best = Some((p.len(), r));
        }
    }
    if let Some((_, r)) = best {
        return r;
    }
    // Сводка из частей через « · » — по частям.
    if depth < 6 && s.contains(" · ") {
        return s.split(" · ").map(|x| tr_in(d, x.trim(), depth + 1)).collect::<Vec<_>>().join(" · ");
    }
    s.to_string()
}

#[tauri::command]
pub fn set_lang(app: AppHandle, lang: String, dict: Option<Dict>) {
    *DICT.write().unwrap_or_else(|e| e.into_inner()) = if lang == "ru" { None } else { dict };
    crate::app::tray::relabel(&app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patterns() {
        let id = |x: &str| x.to_string();
        assert_eq!(by_pattern("wpx — на связи · {} мс", "wpx — online · {} ms", "wpx — на связи · 583 мс", &id).as_deref(), Some("wpx — online · 583 ms"));
        assert_eq!(by_pattern("{} → {}", "{2} ← {1}", "A → B", &id).as_deref(), Some("B ← A"));
        assert_eq!(by_pattern("Простой длился {}", "Downtime: {}", "Соединение", &id).as_deref(), None);
        let d = Dict { exact: [("3 мин".to_string(), "3 min".to_string()), ("сейчас".into(), "now".into())].into(), patterns: vec![("Простой длился {}".into(), "Downtime: {}".into())] };
        assert_eq!(tr_in(&d, "Простой длился 3 мин", 0), "Downtime: 3 min");
        assert_eq!(tr_in(&d, "сейчас · 3 мин", 0), "now · 3 min");
    }
}
