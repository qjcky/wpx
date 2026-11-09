//! Файлы, перетащенные в окно wpx (ярлык, exe, папка). Перетаскивание ловит
//! сама страница: приёмник wry в прозрачном окне выреза попадает не на то
//! окно WebView2, и файл не бросить. Пути страница не видит — она передаёт файлы в
//! `chrome.webview.postMessageWithAdditionalObjects("wpx-drop", files)`, а
//! WebView2 здесь отдаёт их полные пути; окну уходит событие `wpx-drop`.

use tauri::{Emitter, WebviewWindow};
use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2File, ICoreWebView2WebMessageReceivedEventArgs2};
use webview2_com::{take_pwstr, WebMessageReceivedEventHandler};
use windows_core::{Interface, PWSTR};

/// Сообщение страницы с перетащенными файлами.
const MESSAGE: &str = "wpx-drop";

/// Подключить к окну приём путей перетащенных файлов.
pub fn hook(win: &WebviewWindow) {
    let target = win.clone();
    let _ = win.with_webview(move |pv| {
        // SAFETY: вызовы COM WebView2 в потоке окна (with_webview выполняет
        // замыкание в главном потоке), объекты живут, пока живо окно.
        unsafe {
            let Ok(core) = pv.controller().CoreWebView2() else { return };
            let handler = WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut msg = PWSTR::null();
                if args.TryGetWebMessageAsString(&mut msg).is_err() || take_pwstr(msg) != MESSAGE {
                    return Ok(());
                }
                let Ok(objs) = args.cast::<ICoreWebView2WebMessageReceivedEventArgs2>().and_then(|a| a.AdditionalObjects()) else { return Ok(()) };
                let mut n = 0u32;
                objs.Count(&mut n)?;
                let mut paths = Vec::new();
                for i in 0..n {
                    let Ok(file) = objs.GetValueAtIndex(i).and_then(|o| o.cast::<ICoreWebView2File>()) else { continue };
                    let mut p = PWSTR::null();
                    if file.Path(&mut p).is_ok() {
                        paths.push(take_pwstr(p));
                    }
                }
                let _ = target.emit_to(target.label(), MESSAGE, paths);
                Ok(())
            }));
            let mut token = 0i64;
            let _ = core.add_WebMessageReceived(&handler, &mut token);
        }
    });
}
