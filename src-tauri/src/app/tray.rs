//! Иконка в трее — кот-маскот: цвет и глаза = состояние, подсказка = задержка. Рисуется в коде.

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

use crate::monitor::Health;

const TRAY_ID: &str = "wpx";

fn color(h: Health) -> [u8; 3] {
    match h {
        Health::Online => [0x78, 0xEE, 0x9A],
        Health::Slow => [0xF4, 0xBA, 0x60],
        Health::Down => [0xFF, 0x77, 0x7D],
        Health::EngineOff | Health::Starting => [0x8F, 0x9A, 0xAF],
    }
}

/// Кот-маскот: голова 16×16 клеток (×2 = 32 px). Тело чёрное, контур и глаза —
/// цвет состояния; по глазам видно, что со связью: открыты — на связи,
/// сонные — медленно, крестики — нет связи, закрыты — движок стоит.
fn icon(h: Health) -> Image<'static> {
    cat(h, 2)
}

/// Кот размером 16·`s` px: `s` = 2 — трей, 4 — значок окна на панели задач.
fn cat(h: Health, s: usize) -> Image<'static> {
    const G: usize = 16;
    let n = G * s;
    let [r, g, b] = color(h);
    // 0 — пусто, 1 — тело, 2 — контур, 3 — глаз, 4 — ухо изнутри.
    let mut cell = [[0u8; G]; G];
    let body: &[(usize, usize, usize)] = &[
        (2, 3, 3), (2, 12, 12), (3, 3, 4), (3, 11, 12), (4, 3, 5), (4, 10, 12), (5, 3, 12),
        (6, 2, 13), (7, 2, 13), (8, 2, 13), (9, 2, 13), (10, 2, 13), (11, 3, 12), (12, 4, 11),
    ];
    for &(y, a, z) in body {
        for x in a..=z {
            cell[y][x] = 1;
        }
    }
    let mut out = cell;
    for y in 0..G {
        for x in 0..G {
            if cell[y][x] != 0 {
                continue;
            }
            let near = (-1i32..=1).any(|dy| {
                (-1i32..=1).any(|dx| {
                    let (nx, ny) = (x as i32 + dx, y as i32 + dy);
                    nx >= 0 && ny >= 0 && (nx as usize) < G && (ny as usize) < G && cell[ny as usize][nx as usize] == 1
                })
            });
            if near {
                out[y][x] = 2;
            }
        }
    }
    out[4][4] = 4;
    out[4][11] = 4;
    let eyes: &[(usize, usize)] = match h {
        Health::Online | Health::Starting => &[(5, 7), (6, 7), (5, 8), (6, 8), (9, 7), (10, 7), (9, 8), (10, 8)],
        Health::Slow => &[(5, 8), (6, 8), (6, 7), (9, 8), (10, 8), (9, 7)],
        Health::Down => &[(4, 7), (6, 7), (5, 8), (4, 9), (6, 9), (9, 7), (11, 7), (10, 8), (9, 9), (11, 9)],
        Health::EngineOff => &[(4, 8), (5, 8), (6, 8), (9, 8), (10, 8), (11, 8)],
    };
    for &(x, y) in eyes {
        out[y][x] = 3;
    }
    let lite = |c: u8, k: f32| (c as f32 + (255.0 - c as f32) * k) as u8;
    let mut px = vec![0u8; n * n * 4];
    for y in 0..n {
        for x in 0..n {
            let rgba = match out[y / s][x / s] {
                1 => [0x05, 0x05, 0x08, 255],
                2 => [lite(r, 0.35), lite(g, 0.35), lite(b, 0.35), 255],
                3 => [r, g, b, 255],
                4 => [lite(r, 0.6), lite(g, 0.6), lite(b, 0.6), 255],
                _ => [0, 0, 0, 0],
            };
            let i = (y * n + x) * 4;
            px[i..i + 4].copy_from_slice(&rgba);
        }
    }
    Image::new_owned(px, n as u32, n as u32)
}

fn tooltip(h: Health, ms: Option<u32>) -> String {
    let t = crate::app::lang::tr(&tooltip_core(h, ms));
    if crate::config::LAB { t.replacen("wpx", "wpx lab", 1) } else { t }
}

fn tooltip_core(h: Health, ms: Option<u32>) -> String {
    match h {
        Health::Online => format!("wpx — на связи · {} мс", ms.unwrap_or(0)),
        Health::Slow => format!("wpx — медленно · {} мс", ms.unwrap_or(0)),
        Health::Down => "wpx — нет соединения".into(),
        Health::EngineOff => "wpx — движок остановлен".into(),
        Health::Starting => "wpx — проверяем…".into(),
    }
}

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Меню трея на языке окна.
fn menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    use crate::app::lang::tr;
    let open = MenuItem::with_id(app, "open", tr("Открыть wpx"), true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", tr("Выход (туннель продолжит работу)"), true, None::<&str>)?;
    let widget = MenuItem::with_id(app, "widget", tr("Вырез у края экрана"), true, None::<&str>)?;
    Menu::with_items(app, &[&open, &widget, &quit])
}

/// Окно сменило язык — подписи трея следом.
pub fn relabel(app: &AppHandle) {
    if let (Some(t), Ok(m)) = (app.tray_by_id(TRAY_ID), menu(app)) {
        let _ = t.set_menu(Some(m));
    }
}

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let menu = menu(app)?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon(Health::Starting))
        .tooltip("wpx — проверяем…")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| match e.id.as_ref() {
            "open" => show_main(app),
            "widget" => crate::app::notch::toggle_async(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    set_window_icon(app, Health::Starting);
    Ok(())
}

pub fn update(app: &AppHandle, h: Health, ms: Option<u32>) {
    if let Some(t) = app.tray_by_id(TRAY_ID) {
        let _ = t.set_icon(Some(icon(h)));
        let _ = t.set_tooltip(Some(tooltip(h, ms)));
    }
    set_window_icon(app, h);
}

/// Значок окна на панели задач — тот же кот; меняется только со сменой состояния.
pub fn set_window_icon(app: &AppHandle, h: Health) {
    use std::sync::Mutex;
    static LAST: Mutex<Option<Health>> = Mutex::new(None);
    let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
    if *last == Some(h) {
        return;
    }
    if let Some(w) = app.get_webview_window("main") {
        if w.set_icon(cat(h, 4)).is_ok() {
            *last = Some(h);
        }
    }
}
