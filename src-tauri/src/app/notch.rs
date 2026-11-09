//! Вырез у края экрана: прозрачное окно без рамки поверх всех окон,
//! прижато к краю или углу выбранного экрана — по умолчанию к середине
//! верхнего. Форму рисует фронтенд (`?view=widget`):
//! капсула в покое, панель при наведении, «живая активность» при событиях.
//! Окно — постоянного размера под самую большую форму: смена размера
//! прозрачного окна даёт мигание. Клики проходят сквозь окно везде, кроме
//! текущей формы (`widget_shape`): фоновая задача сверяет курсор с её
//! прямоугольником. Вырез можно перетащить за шапку — по отпусканию он
//! встаёт к ближайшему краю или углу того экрана, где его отпустили.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, Monitor, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

use crate::config;
use crate::monitor::Shared;

pub const LABEL: &str = "widget";

/// Размер выреза в покое (логические пиксели, с «ушками» по бокам).
const CLOSED: (f64, f64) = (236.0, 36.0);

/// Окно — под самую большую форму (панель) с запасом под тень.
const FRAME: (f64, f64) = (540.0, 248.0);

/// Текущая форма (логические пиксели): где окно принимает мышь.
static SIZE: Mutex<(f64, f64)> = Mutex::new(CLOSED);

/// Края и углы экрана: (по горизонтали, по вертикали), -1 — лево/верх,
/// 0 — середина, 1 — право/низ.
const ANCHORS: [(&str, (i8, i8)); 8] = [
    ("top", (0, -1)),
    ("top-left", (-1, -1)),
    ("top-right", (1, -1)),
    ("bottom", (0, 1)),
    ("bottom-left", (-1, 1)),
    ("bottom-right", (1, 1)),
    ("left", (-1, 0)),
    ("right", (1, 0)),
];

fn anchor_of(name: &str) -> (i8, i8) {
    ANCHORS.iter().find(|(n, _)| *n == name).map_or((0, -1), |(_, a)| *a)
}

fn anchor_name(a: (i8, i8)) -> &'static str {
    ANCHORS.iter().find(|(_, x)| *x == a).map_or("top", |(n, _)| n)
}

/// Где сейчас вырез — для проверки курсора.
static AT: Mutex<(i8, i8)> = Mutex::new((0, -1));

/// Вырез тащат — курсор не сверяем (окно едет вместе с ним).
static DRAGGING: AtomicBool = AtomicBool::new(false);

/// Вырез уезжает в край перед закрытием — повторное нажатие не мешает.
static CLOSING: AtomicBool = AtomicBool::new(false);

/// Начало отрезка длиной `len` в отрезке `[start, start + room]`: у начала,
/// по середине или у конца.
fn align(a: i8, start: f64, room: f64, len: f64) -> f64 {
    match a {
        -1 => start,
        1 => start + room - len,
        _ => start + (room - len) / 2.0,
    }
}

/// Ближайший край или угол: каждая ось делится на три полосы; из середины
/// экрана — к ближайшему краю.
fn nearest(fx: f64, fy: f64) -> &'static str {
    let band = |f: f64| if f < 0.3 { -1 } else if f > 0.7 { 1 } else { 0 };
    let a = match (band(fx), band(fy)) {
        (0, 0) => [(fy, (0, -1)), (1.0 - fy, (0, 1)), (fx, (-1, 0)), (1.0 - fx, (1, 0))]
            .into_iter()
            .min_by(|a, b| a.0.total_cmp(&b.0))
            .map_or((0, -1), |d| d.1),
        a => a,
    };
    anchor_name(a)
}

fn lock<T: Copy>(m: &Mutex<T>) -> T {
    *m.lock().unwrap_or_else(|p| p.into_inner())
}

fn save_widget(shared: &Shared, f: impl FnOnce(&mut config::WidgetState)) {
    let mut s = shared.settings();
    f(&mut s.widget);
    let _ = config::save_settings(&s);
    shared.set_settings(s);
}

pub fn open(app: &AppHandle) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.show();
        return Ok(());
    }
    let shared = app.state::<Shared>().inner().clone();
    let pinned = shared.settings().widget.pinned;
    let win = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html?view=widget".into()))
        .title("wpx · вырез")
        .decorations(false)
        .transparent(true)
        .resizable(false)
        .shadow(false)
        .skip_taskbar(true)
        .always_on_top(pinned)
        .focused(false)
        .inner_size(FRAME.0, FRAME.1)
        .visible(false);
    // Windows: перетаскивание ловит страница (dropfiles.rs) — приёмник wry в
    // прозрачном окне не срабатывает. Linux: пути даёт сам Tauri.
    #[cfg(windows)]
    let win = win.disable_drag_drop_handler();
    let win = win.build()?;
    no_transitions(&win);
    #[cfg(windows)]
    crate::app::dropfiles::hook(&win);
    // Покажется, когда фронтенд нарисует капсулу и сообщит её размер.
    place(&win);
    let _ = win.set_ignore_cursor_events(true);
    hover_task(app.clone());
    let sh = shared.clone();
    win.on_window_event(move |e| match e {
        // Закрыли системно (Alt+F4) — при следующем запуске не открывать.
        WindowEvent::CloseRequested { .. } => save_widget(&sh, |ws| ws.open = false),
        WindowEvent::Moved(_) => LAST_MOVE.store(now_ms(), Ordering::SeqCst),
        _ => {}
    });
    save_widget(&shared, |ws| ws.open = true);
    Ok(())
}

/// Без системной анимации появления и закрытия окна: у прозрачного окна она
/// мигает прямоугольником; капсула сама выезжает из края и уезжает в него.
/// И без системной рамки: tao оставляет окну без рамки стили заголовка и
/// кнопок, а пока окно пропускает клики, оно «слоистое» — и Windows рисует
/// их поверх капсулы (при смене активного окна, наведении, перетаскивании).
#[cfg(not(windows))]
fn no_transitions(_win: &WebviewWindow) {}

#[cfg(windows)]
fn no_transitions(win: &WebviewWindow) {
    use windows_sys::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_TRANSITIONS_FORCEDISABLED};
    let Ok(h) = win.hwnd() else { return };
    let on: i32 = 1;
    // SAFETY: окно живо, атрибут — 4 байта BOOL по указателю на локальную переменную.
    unsafe {
        DwmSetWindowAttribute(h.0 as _, DWMWA_TRANSITIONS_FORCEDISABLED as u32, &on as *const i32 as *const _, 4);
    }
    // Подменить обработчик окна можно только из его потока — потока цикла событий.
    let hwnd = h.0 as usize;
    let _ = win.run_on_main_thread(move || {
        use windows_sys::Win32::UI::WindowsAndMessaging::*;
        let h = hwnd as windows_sys::Win32::Foundation::HWND;
        // SAFETY: окно принадлежит этому потоку; обработчик снимет система вместе с окном.
        unsafe {
            windows_sys::Win32::UI::Shell::SetWindowSubclass(h, Some(no_frame), 1, 0);
            // Стили, выставленные до подмены обработчика, — тоже без заголовка.
            SetWindowLongW(h, GWL_STYLE, GetWindowLongW(h, GWL_STYLE) & !(CAPTION as i32));
            SetWindowPos(h, std::ptr::null_mut(), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
        }
    });
}

/// Заголовок, рамка и кнопки окна — у выреза их нет ни в каком состоянии.
#[cfg(windows)]
const CAPTION: u32 = windows_sys::Win32::UI::WindowsAndMessaging::WS_CAPTION
    | windows_sys::Win32::UI::WindowsAndMessaging::WS_THICKFRAME
    | windows_sys::Win32::UI::WindowsAndMessaging::WS_MINIMIZEBOX
    | windows_sys::Win32::UI::WindowsAndMessaging::WS_MAXIMIZEBOX;

/// Рамки у выреза нет: стили заголовка срезаются при каждой их смене (tao
/// выставляет их заново), смену активности tao отметит сам, а lParam = -1
/// запрещает системе перерисовать заголовок.
#[cfg(windows)]
unsafe extern "system" fn no_frame(
    h: windows_sys::Win32::Foundation::HWND,
    msg: u32,
    wp: windows_sys::Win32::Foundation::WPARAM,
    lp: windows_sys::Win32::Foundation::LPARAM,
    _id: usize,
    _data: usize,
) -> windows_sys::Win32::Foundation::LRESULT {
    use windows_sys::Win32::UI::Shell::DefSubclassProc;
    use windows_sys::Win32::UI::WindowsAndMessaging::{GWL_STYLE, STYLESTRUCT, WM_NCACTIVATE, WM_NCPAINT, WM_STYLECHANGING};
    // Недокументированные: ими система рисует заголовок и рамку после смены текста или значка.
    const WM_NCUAHDRAWCAPTION: u32 = 0x00AE;
    const WM_NCUAHDRAWFRAME: u32 = 0x00AF;
    match msg {
        WM_STYLECHANGING if wp as i32 == GWL_STYLE => {
            // SAFETY: для WM_STYLECHANGING lParam — указатель на STYLESTRUCT, живой на время вызова.
            (*(lp as *mut STYLESTRUCT)).styleNew &= !CAPTION;
            DefSubclassProc(h, msg, wp, lp)
        }
        WM_NCACTIVATE => DefSubclassProc(h, msg, wp, -1),
        WM_NCPAINT | WM_NCUAHDRAWCAPTION | WM_NCUAHDRAWFRAME => 0,
        _ => DefSubclassProc(h, msg, wp, lp),
    }
}

/// Экран выреза: выбранный в настройках, если он подключён, иначе основной.
fn target_monitor(win: &WebviewWindow) -> Option<Monitor> {
    let want = win.app_handle().state::<Shared>().settings().widget.monitor;
    let all = win.available_monitors().unwrap_or_default();
    want.and_then(|n| all.into_iter().find(|m| m.name() == Some(&n)))
        .or_else(|| win.primary_monitor().ok().flatten())
        .or_else(|| win.current_monitor().ok().flatten())
}

/// Окно — у выбранного края или угла рабочей области экрана (без панели задач).
fn place(win: &WebviewWindow) {
    let Some(mon) = target_monitor(win) else { return };
    let at = anchor_of(&win.app_handle().state::<Shared>().settings().widget.anchor);
    *AT.lock().unwrap_or_else(|p| p.into_inner()) = at;
    let scale = mon.scale_factor();
    let _ = win.set_size(LogicalSize::new(FRAME.0, FRAME.1));
    let wa = mon.work_area();
    let x = align(at.0, wa.position.x as f64, wa.size.width as f64, FRAME.0 * scale);
    let y = align(at.1, wa.position.y as f64, wa.size.height as f64, FRAME.1 * scale);
    let _ = win.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
}

/// Прямоугольник формы на экране (физические пиксели): окно и выравнивание по краю.
fn shape_rect(win: &WebviewWindow) -> Option<(f64, f64, f64, f64)> {
    let (p, sz) = (win.outer_position().ok()?, win.outer_size().ok()?);
    let scale = win.scale_factor().unwrap_or(1.0);
    let (w, h) = lock(&SIZE);
    let at = lock(&AT);
    let (w, h) = (w * scale, h * scale);
    Some((align(at.0, p.x as f64, sz.width as f64, w), align(at.1, p.y as f64, sz.height as f64, h), w, h))
}

/// Переезд: фронтенд прячет капсулу в край (`notch-leave`), окно встаёт на
/// новое место, капсула выезжает из нового края (`notch-anchor`).
async fn relocate(app: &AppHandle) {
    let Some(win) = app.get_webview_window(LABEL) else { return };
    let _ = win.emit_to(LABEL, "notch-leave", ());
    tokio::time::sleep(Duration::from_millis(300)).await;
    place(&win);
    let anchor = app.state::<Shared>().settings().widget.anchor;
    let _ = win.emit_to(LABEL, "notch-anchor", anchor);
}

/// Когда окно двигалось в последний раз (мс) — конец перетаскивания в Linux.
static LAST_MOVE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Тащат ли ещё окно. Windows: нажата ли кнопка мыши (любая из двух — на
/// случай обменянных кнопок). Linux: окно двигалось в последние 0,6 с.
#[cfg(not(windows))]
fn mouse_down() -> bool {
    now_ms().saturating_sub(LAST_MOVE.load(Ordering::SeqCst)) < 600
}

#[cfg(windows)]
fn mouse_down() -> bool {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON};
    // SAFETY: чтение состояния клавиши, без указателей.
    let down = |k: u16| unsafe { GetAsyncKeyState(k as i32) as u16 & 0x8000 != 0 };
    down(VK_LBUTTON) || down(VK_RBUTTON)
}

/// Куда встать после перетаскивания: экран, где отпустили, и ближайший к
/// центру формы край или угол его рабочей области.
fn dock(win: &WebviewWindow) -> Option<(Option<String>, &'static str)> {
    let (x, y, w, h) = shape_rect(win)?;
    let (cx, cy) = (x + w / 2.0, y + h / 2.0);
    let inside = |m: &Monitor| {
        let (p, s) = (m.position(), m.size());
        cx >= p.x as f64 && cx < p.x as f64 + s.width as f64 && cy >= p.y as f64 && cy < p.y as f64 + s.height as f64
    };
    let mon = win.available_monitors().ok()?.into_iter().find(inside).or_else(|| win.current_monitor().ok().flatten())?;
    let wa = mon.work_area();
    let fx = (cx - wa.position.x as f64) / wa.size.width.max(1) as f64;
    let fy = (cy - wa.position.y as f64) / wa.size.height.max(1) as f64;
    Some((mon.name().cloned(), nearest(fx.clamp(0.0, 1.0), fy.clamp(0.0, 1.0))))
}

/// Курсор над формой — окно принимает мышь, иначе клики идут окнам ниже.
/// Раз в 40 мс; фронтенду — событие `notch-hover` (запасной путь для
/// наведения и ухода, если событие мыши потерялось).
fn hover_task(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut inside = false;
        loop {
            tokio::time::sleep(Duration::from_millis(40)).await;
            let Some(win) = app.get_webview_window(LABEL) else { break };
            if !win.is_visible().unwrap_or(false) || DRAGGING.load(Ordering::SeqCst) {
                continue;
            }
            let (Ok(c), Some((x, y, w, h))) = (win.cursor_position(), shape_rect(&win)) else { continue };
            let now = c.x >= x && c.x < x + w && c.y >= y && c.y < y + h;
            if now != inside {
                inside = now;
                let _ = win.set_ignore_cursor_events(!now);
                let _ = win.emit_to(LABEL, "notch-hover", now);
            }
        }
    });
}

/// Убрать вырез: капсула уезжает в край (`notch-leave`), потом окно закрывается.
pub async fn close(app: &AppHandle) {
    let Some(w) = app.get_webview_window(LABEL) else { return };
    if CLOSING.swap(true, Ordering::SeqCst) {
        return;
    }
    let _ = w.emit_to(LABEL, "notch-leave", ());
    tokio::time::sleep(Duration::from_millis(320)).await;
    let _ = w.destroy();
    CLOSING.store(false, Ordering::SeqCst);
    let shared = app.state::<Shared>().inner().clone();
    save_widget(&shared, |ws| ws.open = false);
}

pub async fn toggle(app: &AppHandle) {
    if CLOSING.load(Ordering::SeqCst) {
        return;
    }
    if app.get_webview_window(LABEL).is_some() {
        close(app).await;
    } else {
        let _ = open(app);
    }
}

// Команды, создающие/закрывающие окна, — только async: синхронная команда
// выполняется в главном потоке, а создание окна ждёт этот же поток —
// на Windows окно зависает пустым (известная ловушка Tauri/wry).

#[tauri::command]
pub async fn widget_toggle(app: AppHandle) {
    toggle(&app).await;
}

#[tauri::command]
pub async fn widget_close(app: AppHandle) {
    close(&app).await;
}

#[tauri::command]
pub async fn widget_pin(app: AppHandle, on: bool) -> bool {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.set_always_on_top(on);
    }
    let shared = app.state::<Shared>().inner().clone();
    save_widget(&shared, |ws| ws.pinned = on);
    on
}

/// Из обработчиков главного потока (меню трея) — через фоновую задачу.
pub fn toggle_async(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move { toggle(&app).await });
}

#[derive(serde::Serialize)]
pub struct MonitorInfo {
    /// Системное имя (\\.\DISPLAY1) — его и запоминаем.
    pub name: String,
    pub label: String,
    pub primary: bool,
    pub current: bool,
}

/// Экраны для выбора: «Экран 2 · 2560×1440», основной первым по порядку Windows.
#[tauri::command]
pub fn widget_monitors(app: AppHandle) -> Vec<MonitorInfo> {
    let Some(win) = app.get_webview_window("main") else { return vec![] };
    let want = app.state::<Shared>().settings().widget.monitor;
    let primary = win.primary_monitor().ok().flatten().and_then(|m| m.name().cloned());
    win.available_monitors()
        .unwrap_or_default()
        .iter()
        .enumerate()
        .filter_map(|(i, m)| {
            let name = m.name()?.clone();
            let s = m.size();
            let is_primary = primary.as_ref() == Some(&name);
            Some(MonitorInfo {
                label: format!("Экран {} · {}×{}{}", i + 1, s.width, s.height, if is_primary { " · основной" } else { "" }),
                primary: is_primary,
                current: want.as_ref().map_or(is_primary, |w| w == &name),
                name,
            })
        })
        .collect()
}

/// Перенести вырез на экран (`None` — основной); вырез переезжает сразу.
#[tauri::command]
pub async fn widget_set_monitor(app: AppHandle, name: Option<String>) {
    let shared = app.state::<Shared>().inner().clone();
    save_widget(&shared, |ws| ws.monitor = name);
    relocate(&app).await;
}

/// Поставить вырез к краю или углу: top, top-left, top-right, bottom,
/// bottom-left, bottom-right, left, right.
#[tauri::command]
pub async fn widget_set_anchor(app: AppHandle, anchor: String) -> Result<(), String> {
    if !ANCHORS.iter().any(|(n, _)| *n == anchor) {
        return Err(format!("нет такого места: {anchor}"));
    }
    let shared = app.state::<Shared>().inner().clone();
    save_widget(&shared, |ws| ws.anchor = anchor);
    relocate(&app).await;
    Ok(())
}

/// Перетаскивание за шапку: окно едет за курсором (системно), по отпусканию —
/// к ближайшему краю или углу того экрана, где вырез отпустили.
#[tauri::command]
pub async fn widget_drag(app: AppHandle) {
    let Some(win) = app.get_webview_window(LABEL) else { return };
    if DRAGGING.swap(true, Ordering::SeqCst) {
        return;
    }
    LAST_MOVE.store(now_ms(), Ordering::SeqCst);
    let _ = win.start_dragging();
    tokio::time::sleep(Duration::from_millis(120)).await;
    let t0 = Instant::now();
    while mouse_down() && t0.elapsed() < Duration::from_secs(120) {
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    if let Some((mon, anchor)) = dock(&win) {
        let primary = win.primary_monitor().ok().flatten().and_then(|m| m.name().cloned());
        let shared = app.state::<Shared>().inner().clone();
        save_widget(&shared, |ws| {
            ws.anchor = anchor.into();
            ws.monitor = mon.filter(|m| Some(m) != primary.as_ref());
        });
    }
    relocate(&app).await;
    DRAGGING.store(false, Ordering::SeqCst);
}

/// Фронтенд выреза: капсула, панель или активность — где окно принимает мышь.
#[tauri::command]
pub async fn widget_shape(app: AppHandle, w: f64, h: f64) {
    if let Some(win) = app.get_webview_window(LABEL) {
        *SIZE.lock().unwrap_or_else(|p| p.into_inner()) = (w.clamp(24.0, FRAME.0), h.clamp(24.0, FRAME.1));
        if !win.is_visible().unwrap_or(true) {
            let _ = win.show();
        }
    }
}

#[tauri::command]
pub fn widget_state(shared: tauri::State<'_, Shared>) -> config::WidgetState {
    shared.settings().widget
}

#[tauri::command]
pub fn show_main(app: AppHandle) {
    crate::app::tray::show_main(&app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nearest_edge_or_corner() {
        assert_eq!(nearest(0.5, 0.02), "top");
        assert_eq!(nearest(0.05, 0.05), "top-left");
        assert_eq!(nearest(0.95, 0.1), "top-right");
        assert_eq!(nearest(0.5, 0.98), "bottom");
        assert_eq!(nearest(0.1, 0.9), "bottom-left");
        assert_eq!(nearest(0.9, 0.9), "bottom-right");
        assert_eq!(nearest(0.02, 0.5), "left");
        assert_eq!(nearest(0.97, 0.5), "right");
        // Из середины — к ближайшему краю.
        assert_eq!(nearest(0.5, 0.4), "top");
        assert_eq!(nearest(0.32, 0.55), "left");
        for (n, a) in ANCHORS {
            assert_eq!(anchor_of(n), a);
            assert_eq!(anchor_name(a), n);
        }
        assert_eq!(anchor_of("где-то"), (0, -1));
    }

    #[test]
    fn align_on_axis() {
        assert_eq!(align(-1, 100.0, 1000.0, 200.0), 100.0);
        assert_eq!(align(0, 100.0, 1000.0, 200.0), 500.0);
        assert_eq!(align(1, 100.0, 1000.0, 200.0), 900.0);
    }
}
