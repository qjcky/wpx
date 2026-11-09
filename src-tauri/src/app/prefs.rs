//! Настройки, которые меняются из окна wpx: автозапуск, уведомления, порог.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_autostart::ManagerExt;

use crate::config;
use crate::monitor::Shared;

pub const AUTOSTART_ARG: &str = "--autostart";

#[derive(Serialize, Deserialize)]
pub struct Prefs {
    pub autostart: bool,
    pub notify: bool,
    pub slow_ms: u32,
    /// Откуда будет запускаться wpx при входе в Windows.
    #[serde(default)]
    pub exe: String,
}

fn is_dev_build(exe: &std::path::Path) -> bool {
    exe.components().any(|c| c.as_os_str().eq_ignore_ascii_case("target"))
}

/// При старте: первый запуск — включить автозапуск;
/// дальше — обновлять путь, если exe переехал (например, после установки).
pub fn on_startup(app: &AppHandle, shared: &Shared) {
    let al = app.autolaunch();
    let exe = std::env::current_exe().unwrap_or_default();
    let mut s = shared.settings();
    if config::LAB || is_dev_build(&exe) {
        return; // лаборатория и сборка из target\ — автозапуск не трогаем
    }
    if !s.autostart_seeded {
        if al.enable().is_ok() {
            s.autostart_seeded = true;
            let _ = config::save_settings(&s);
            shared.set_settings(s);
        }
    } else if al.is_enabled().unwrap_or(false) {
        let _ = al.enable(); // перезапишет путь на текущий exe
    }
}

#[tauri::command]
pub fn get_prefs(app: AppHandle, shared: tauri::State<'_, Shared>) -> Prefs {
    let s = shared.settings();
    Prefs {
        autostart: app.autolaunch().is_enabled().unwrap_or(false),
        notify: s.notify,
        slow_ms: s.slow_ms,
        exe: std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default(),
    }
}

#[tauri::command]
pub fn set_prefs(app: AppHandle, shared: tauri::State<'_, Shared>, prefs: Prefs) -> Result<Prefs, String> {
    if config::LAB && prefs.autostart {
        return Err("В лабораторной сборке автозапуск не включается".into());
    }
    if !config::LAB {
        let al = app.autolaunch();
        let r = if prefs.autostart { al.enable() } else { al.disable() };
        r.map_err(|e| format!("автозапуск: {e}"))?;
    }
    let mut s = shared.settings();
    s.notify = prefs.notify;
    s.slow_ms = prefs.slow_ms.clamp(500, 10_000);
    s.autostart_seeded = true;
    config::save_settings(&s)?;
    shared.set_settings(s);
    Ok(get_prefs(app, shared))
}
