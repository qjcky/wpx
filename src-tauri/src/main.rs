#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `wpx --probe` — один прогон всех проверок с выводом JSON в консоль,
    // без окна. Нужен для диагностики и проверки сборки.
    if std::env::args().any(|a| a == "--probe") {
        wpx_lib::probe_once();
        return;
    }
    // `wpx --dry-run` — собрать конфиг рабочего профиля и проверить его
    // `mihomo -t`, ничего не применяя.
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--dry-run") {
        let links = args.iter().position(|a| a == "--links").and_then(|j| args.get(j + 1).cloned());
        let cascade = args.iter().position(|a| a == "--cascade").and_then(|j| Some((args.get(j + 1)?.clone(), args.get(j + 2)?.clone())));
        wpx_lib::dry_run(links, cascade);
        return;
    }
    // `wpx --probe-links <файл> [--via <файл>] [--iface <адаптер>]` —
    // проверить точки подключения из файла в песочнице (без TUN и без прав);
    // `--via` — через вход каскада.
    if let Some(i) = args.iter().position(|a| a == "--probe-links") {
        let file = args.get(i + 1).cloned().unwrap_or_default();
        let opt = |name: &str| args.iter().position(|a| a == name).and_then(|j| args.get(j + 1).cloned());
        wpx_lib::probe_links(&file, opt("--via"), opt("--via-profile"), opt("--iface"), args.iter().any(|a| a == "--bulk"));
        return;
    }
    // `wpx --trial <профиль> [--speed]` — пробный запуск профиля без TUN.
    if let Some(i) = args.iter().position(|a| a == "--trial") {
        wpx_lib::trial_cli(args.get(i + 1).map(String::as_str).unwrap_or(""), args.iter().any(|a| a == "--speed"));
        return;
    }
    // `wpx --make cascade|route …` — каскад или маршрут из профилей.
    if let Some(i) = args.iter().position(|a| a == "--make") {
        wpx_lib::make_cli(&args[i + 1..]);
        return;
    }
    // `wpx --leaks` — проверка утечек; `wpx --report` — отчёт для поддержки.
    if args.iter().any(|a| a == "--leaks" || a == "--report") {
        wpx_lib::diag_cli(args.iter().any(|a| a == "--report"));
        return;
    }
    // `wpx --server …` — свои серверы (см. servers::cli).
    if let Some(i) = args.iter().position(|a| a == "--server") {
        wpx_lib::server_cli(&args[i + 1..]);
        return;
    }
    // `wpx --import <файл> <название>` — сохранить профиль из ссылок.
    if let Some(i) = args.iter().position(|a| a == "--import") {
        match (args.get(i + 1), args.get(i + 2)) {
            (Some(f), Some(n)) => wpx_lib::import_links(f, n),
            _ => println!("wpx --import <файл> <название>"),
        }
        return;
    }
    #[cfg(target_os = "linux")]
    {
        // Капсуле нужны положение окна и «клики насквозь» — Wayland их не
        // даёт, через XWayland работает. Выбор пользователя не трогаем:
        // GDK_BACKEND задан — как есть; WPX_WAYLAND=1 — родной Wayland.
        if std::env::var_os("GDK_BACKEND").is_none() && std::env::var_os("WPX_WAYLAND").is_none() {
            std::env::set_var("GDK_BACKEND", "x11");
        }
        // WebKitGTK на части видеокарт рисует пустое окно с DMA-BUF.
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }
    wpx_lib::run();
}
