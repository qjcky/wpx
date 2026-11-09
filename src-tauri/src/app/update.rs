//! Обновление wpx из GitHub Releases: подписанные сборки (minisign, открытый
//! ключ — в tauri.conf.json), проверка по кнопке и раз в сутки из окна. В
//! Windows установщик ставит новую версию поверх и перезапускает wpx; в
//! Linux обновляется AppImage (пакет .deb — через менеджер пакетов).
//! Движок (mihomo) обновляется отдельно — со страницы «Движок»: для этого
//! нужны права администратора.

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

use crate::config;

#[derive(Serialize)]
pub struct UpdateInfo {
    pub version: String,
    pub current: String,
    pub notes: Option<String>,
    pub date: Option<String>,
}

fn guard() -> Result<(), String> {
    if config::LAB {
        return Err("в лабораторной сборке обновлений нет".into());
    }
    Ok(())
}

/// Есть ли новая версия (None — у вас последняя).
#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    guard()?;
    let up = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    Ok(up.map(|u| UpdateInfo {
        version: u.version.clone(),
        current: u.current_version.clone(),
        notes: u.body.clone(),
        date: u.date.map(|d| d.to_string()),
    }))
}

/// Скачать, проверить подпись, установить и перезапустить wpx.
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), String> {
    guard()?;
    let up = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    let Some(up) = up else { return Err("у вас уже последняя версия".into()) };
    up.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    app.restart()
}
