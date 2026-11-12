mod app;
mod config;
mod engine;
mod monitor;
mod platform;
mod profiles;
mod servers;

use app::{cmd, gameroute, games, lang, notch, prefs, tray};
use engine::{follow, netcfg, ops, sandbox, trial};
use monitor::{diag, history, speedtest};
use profiles::proto;

use tauri::{Manager, WindowEvent};

#[tauri::command]
fn hide_window(window: tauri::WebviewWindow) {
    let _ = window.hide();
}

#[derive(serde::Serialize)]
struct BuildInfo {
    lab: bool,
    version: &'static str,
    /// "windows" | "linux" — окно подстраивает подсказки (UAC / pkexec и т. п.).
    os: &'static str,
}

#[tauri::command]
fn build_info() -> BuildInfo {
    BuildInfo { lab: config::LAB, version: env!("CARGO_PKG_VERSION"), os: std::env::consts::OS }
}

#[tauri::command]
fn open_engine_log() {
    platform::open_file(&config::engine_log_path());
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // `wpx.exe --widget` при уже запущенном wpx — показать/спрятать виджет.
            if args.iter().any(|a| a == "--widget") {
                notch::toggle_async(app);
            } else {
                tray::show_main(app);
            }
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![prefs::AUTOSTART_ARG]),
        ))
        .setup(|app| {
            let shared = monitor::Shared::new();
            app.manage(shared.clone());
            tray::create(app.handle())?;
            prefs::on_startup(app.handle(), &shared);
            // Перетащенные в окно файлы — пути от WebView2 (dropfiles.rs).
            #[cfg(windows)]
            if let Some(main) = app.get_webview_window("main") {
                app::dropfiles::hook(&main);
            }
            let widget_open = shared.settings().widget.open;
            monitor::spawn_all(app.handle().clone(), shared);
            tauri::async_runtime::spawn(servers::guests::expiry_task(app.handle().clone()));
            // «Программа и всё, что она запускает» — помощники и сайты на лету.
            follow::spawn(app.handle().clone());
            // При входе в Windows — сразу в трей, без окна.
            if !std::env::args().any(|a| a == prefs::AUTOSTART_ARG) {
                tray::show_main(app.handle());
            }
            if widget_open {
                let _ = notch::open(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Крестик прячет окно в трей; выход — из меню трея.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            lang::set_lang,
            games::games_running,
            gameroute::game_servers,
            gameroute::game_measure,
            games::exe_icon,
            games::drop_inspect,
            follow::follow_forget,
            app::update::update_check,
            app::update::update_install,
            monitor::get_state,
            monitor::check_now,
            cmd::profiles_list,
            cmd::profile_save,
            cmd::profile_delete,
            cmd::profile_test,
            cmd::profile_activate,
            cmd::profile_deactivate,
            cmd::links_parse,
            cmd::links_probe,
            cmd::profile_import,
            cmd::profile_edit_vpn,
            cmd::profile_probe,
            cmd::profile_history,
            cmd::router_rules,
            cmd::net_check,
            cmd::router_check,
            cmd::cascade_probe,
            cmd::cascade_save,
            cmd::route_save,
            cmd::route_probe,
            servers::servers_list,
            servers::server_add,
            servers::server_inspect,
            servers::server_install,
            servers::server_profile,
            servers::server_fingerprint,
            servers::extra::server_mtproxy_link,
            servers::server_harden,
            servers::server_cascade,
            servers::server_cascade_remove,
            servers::server_uninstall,
            servers::server_forget,
            servers::fw::server_firewall,
            servers::check::server_check,
            servers::moving::server_move_plan,
            servers::moving::server_move,
            servers::update::server_update,
            servers::guests::guest_add,
            servers::guests::guest_update,
            servers::guests::guest_remove,
            servers::guests::guest_share,
            servers::guests::guest_save_conf,
            servers::guests::guest_stats,
            diag::leak_check,
            diag::support_report,
            cmd::engine_info,
            cmd::net_save,
            cmd::engine_apply_net,
            cmd::engine_restart,
            cmd::engine_start,
            cmd::engine_stop,
            cmd::engine_set_boot,
            cmd::engine_deep_test,
            cmd::engine_uninstall,
            cmd::engine_update,
            cmd::engine_pause,
            cmd::engine_set_heal,
            cmd::conns_list,
            cmd::list_items,
            cmd::conns_close,
            cmd::speed_test,
            cmd::speed_history,
            notch::widget_toggle,
            notch::widget_close,
            notch::widget_pin,
            notch::widget_state,
            notch::widget_shape,
            notch::widget_monitors,
            notch::widget_set_monitor,
            notch::widget_set_anchor,
            notch::widget_drag,
            notch::show_main,
            prefs::get_prefs,
            prefs::set_prefs,
            hide_window,
            open_engine_log,
            build_info,
            trial::trial_start,
            trial::trial_status,
            trial::trial_check,
            trial::trial_stop,
            trial::trial_browser,
            trial::trial_speed,
        ])
        .build(tauri::generate_context!())
        .expect("wpx: не удалось запустить приложение")
        // Пробный движок не переживает окно.
        .run(|_, e| {
            if let tauri::RunEvent::Exit = e {
                trial::stop();
                history::flush();
            }
        });
}

/// `wpx --dry-run`: собрать конфиг рабочего профиля и проверить `mihomo -t`.
/// Ничего не применяет.
pub fn dry_run(links: Option<String>, cascade: Option<(String, String)>) {
    let res = (|| -> Result<String, String> {
        let mut store = profiles::load();
        // `--links <файл>`: временный профиль из ссылок (в файл не пишется).
        if let Some(f) = &links {
            let text = std::fs::read_to_string(f).map_err(|e| e.to_string())?;
            let eps: Vec<_> = text.split("\n---").flat_map(proto::parse_many).filter_map(Result::ok).collect();
            let id = profiles::import_endpoints(&mut store, "dry-run", &eps, "auto")?;
            store.active = Some(id);
        }
        // `--profile <id|название>`: проверить этот профиль вместо рабочего.
        if let Some(k) = std::env::args().skip_while(|a| a != "--profile").nth(1) {
            store.active = Some(store.profiles.iter().find(|p| p.id == k || p.name == k).map(|p| p.id.clone()).ok_or(format!("нет профиля «{k}»"))?);
        }
        // `--cascade <вход> <выход>`: временный каскад из профилей (по id или названию).
        if let Some((e, x)) = &cascade {
            let find = |k: &str| store.profiles.iter().find(|p| p.id == k || p.name == k).map(|p| p.id.clone()).ok_or(format!("нет профиля «{k}»"));
            let (e, x) = (find(e)?, find(x)?);
            let id = profiles::upsert_cascade(&mut store, None, "dry-run", &e, &x)?;
            store.active = Some(id);
        }
        let p = store
            .active
            .as_ref()
            .and_then(|id| store.profiles.iter().find(|p| &p.id == id))
            .ok_or("нет рабочего профиля")?;
        let mut net = netcfg::load();
        // `--mode apps|blocked`: проверить конфиг в другом режиме защиты.
        if let Some(m) = std::env::args().skip_while(|a| a != "--mode").nth(1) {
            net.mode = m;
            if net.apps.is_empty() {
                net.apps = vec![crate::platform::exe("chrome"), crate::platform::exe("firefox")];
            }
        }
        let (path, hash) = ops::stage(&profiles::chain_of(&store, p)?, &net)?;
        let cfg = config::read_config_at(&path)?;
        let legs: Vec<String> = cfg.proxies.iter().map(|x| format!("{} {}:{}", x.name, x.kind, x.port)).collect();
        Ok(format!(
            "mihomo -t: OK\nпрофиль: {} ({})\nвыходы: {}\nгруппа: {:?}\nTUN: {} · адаптер: {}\nLAN: {:?}\nнапрямую: {:?}\nUDP блок: {}\nsha256: {}",
            p.name, p.server, legs.join(", "), cfg.facts.group, cfg.facts.tun_device, cfg.facts.interface,
            net.lan, net.direct, net.udp, &hash[..16]
        ))
    })();
    match res {
        Ok(s) => println!("{s}"),
        Err(e) => println!("ОШИБКА: {e}"),
    }
}

/// Точки подключения из файла: ссылки построчно и конфиги AWG, блоки
/// разделены строкой «---».
fn read_links(path: &str) -> Result<Vec<proto::Endpoint>, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?;
    let mut eps = vec![];
    for block in text.split("\n---") {
        for r in proto::parse_many(block) {
            match r {
                Ok(e) => eps.push(e),
                Err(e) => println!("пропущено: {e}"),
            }
        }
    }
    Ok(eps)
}

/// `wpx --import <файл> <название>`: профиль из ссылок без вставки в окно —
/// секреты сразу шифруются и никуда не выводятся.
pub fn import_links(path: &str, name: &str) {
    let res = (|| -> Result<String, String> {
        let eps = read_links(path)?;
        let mut s = profiles::load();
        let id = profiles::import_endpoints(&mut s, name, &eps, "fallback")?;
        profiles::save(&s)?;
        Ok(format!("профиль «{name}» ({id}): точек {} → {}", eps.len(), config::data_dir().display()))
    })();
    match res {
        Ok(s) => println!("{s}"),
        Err(e) => println!("ОШИБКА: {e}"),
    }
}

/// `wpx --trial <профиль> [--speed]`: пробный запуск профиля без TUN — точки,
/// активная, тест скорости; затем остановка. Систему не меняет.
pub fn trial_cli(key: &str, speed: bool) {
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("tokio");
    rt.block_on(async {
        let Some(id) = profiles::load().profiles.iter().find(|p| p.id == key || p.name == key).map(|p| p.id.clone()) else {
            return println!("ОШИБКА: нет профиля «{key}»");
        };
        match trial::start(&id).await {
            Ok(s) => {
                println!("пробный движок: 127.0.0.1:{} · {}", s.port, s.profile);
                for p in &s.points {
                    println!("  {} {:<5} {:<34} {}", if p.active { "▶" } else { " " }, p.role, p.label,
                        if p.alive { p.delay_ms.map(|d| format!("{d} мс")).unwrap_or_else(|| "жив".into()) } else { "нет ответа".into() });
                }
                println!("монитор:");
                let smart = std::env::args().any(|a| a == "--smart");
                let (legs, picked) = monitor::trial_legs(smart).await;
                for (label, role, kind, r) in legs {
                    println!("  {role:<5} {kind:<9} {label:<34} {}", if r.ok {
                        format!("путь {} мс{}", r.ready_ms.unwrap_or(0), r.connect_ms.map(|c| format!(" · TCP {c} мс")).unwrap_or_default())
                    } else { r.err.unwrap_or_default() });
                }
                if smart {
                    println!("{}", picked.unwrap_or_else(|| "умный выбор: менять нечего (текущая точка не хуже лучшей по истории на 20%+, или истории мало)".into()));
                    for p in trial::status().await.points.iter().filter(|p| p.active) {
                        println!("  теперь ▶ {}", p.label);
                    }
                }
                if std::env::args().any(|a| a == "--ip") {
                    // Внешний IP так, как его видит curl.exe через пробный движок
                    // (правила по приложению срабатывают и здесь).
                    let port = s.port;
                    let ip = tokio::task::spawn_blocking(move || {
                        std::process::Command::new(crate::platform::CURL)
                            .args(["-s", "-m", "15", "-x", &format!("http://127.0.0.1:{port}"), "https://ipinfo.io/ip"])
                            .output()
                            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                            .unwrap_or_default()
                    })
                    .await
                    .unwrap_or_default();
                    println!("внешний IP для curl.exe: {}", if ip.is_empty() { "нет ответа" } else { &ip });
                }
                if speed {
                    let r = tokio::task::spawn_blocking(move || speedtest::run_via(Some(s.port))).await.unwrap();
                    println!("скорость: пинг {:?} мс · ↓ {:?} Мбит/с · ↑ {:?} Мбит/с {}", r.ping_ms, r.down_mbps, r.up_mbps, r.error.unwrap_or_default());
                }
            }
            Err(e) => println!("ОШИБКА: {e}"),
        }
        trial::stop();
    });
}

/// `wpx --make cascade <название> <вход> <выход>` | `--make route <название> <профиль>…`:
/// создать каскад или маршрут из профилей (по id или названию) в хранилище.
pub fn make_cli(args: &[String]) {
    let mut st = profiles::load();
    let find = |st: &profiles::Store, k: &str| st.profiles.iter().find(|p| p.id == k || p.name == k).map(|p| p.id.clone()).ok_or(format!("нет профиля «{k}»"));
    let r = (|| -> Result<String, String> {
        let name = args.get(1).ok_or("нет названия")?;
        let ids: Vec<String> = args[2..].iter().map(|k| find(&st, k)).collect::<Result<_, _>>()?;
        let id = match args.first().map(String::as_str) {
            Some("cascade") if ids.len() == 2 => profiles::upsert_cascade(&mut st, None, name, &ids[0], &ids[1])?,
            Some("route") => profiles::upsert_route(&mut st, None, name, &ids, "auto")?,
            _ => return Err("wpx --make cascade <название> <вход> <выход> | route <название> <профиль>…".into()),
        };
        profiles::save(&st)?;
        Ok(id)
    })();
    match r {
        Ok(id) => println!("создан {id}"),
        Err(e) => println!("ОШИБКА: {e}"),
    }
}

/// `wpx --server …`: операции со своими серверами из консоли.
pub fn server_cli(args: &[String]) {
    servers::cli(args);
}

pub fn diag_cli(report: bool) {
    diag::cli(report);
}

/// Вход каскада для `--probe-links`: точки профиля (по id или названию).
fn profile_links(key: &str) -> Result<Vec<proto::Endpoint>, String> {
    let store = profiles::load();
    let p = store.profiles.iter().find(|p| p.id == key || p.name == key).ok_or(format!("нет профиля «{key}»"))?;
    Ok(profiles::endpoints_of(p)?.into_iter().map(|(_, e)| e).collect())
}

/// `wpx --probe-links <файл> [--via <файл> | --via-profile <профиль>]
/// [--iface Ethernet]`: проверить каждую точку в песочнице; с `--via…` —
/// через вход каскада. Систему не меняет.
pub fn probe_links(path: &str, via: Option<String>, via_profile: Option<String>, iface: Option<String>, bulk: bool) {
    let via = match (via, via_profile) {
        (Some(f), _) => read_links(&f).map(Some),
        (None, Some(p)) => profile_links(&p).map(Some),
        (None, None) => Ok(None),
    };
    // `profile:<имя>` — точки сохранённого профиля (ключи в консоль не печатаются).
    let eps = match path.strip_prefix("profile:") {
        Some(p) => profile_links(p),
        None => read_links(path),
    };
    let (eps, via) = match (eps, via) {
        (Ok(e), Ok(v)) => (e, v.unwrap_or_default()),
        (Err(e), _) | (_, Err(e)) => return println!("ОШИБКА: {e}"),
    };
    println!("точек: {}{}", eps.len(), if via.is_empty() { String::new() } else { format!(" (через вход из {} точек)", via.len()) });
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("tokio");
    let opt = sandbox::Options { interface: iface, rounds: 3, timeout_ms: 8000, via, via_mode: "fallback".into(), bulk };
    match rt.block_on(sandbox::probe(eps, opt)) {
        Ok(res) => {
            let order = sandbox::rank(&res);
            for r in &res {
                let place = order.iter().position(|&i| i == r.index).map(|p| format!("#{}", p + 1)).unwrap_or_else(|| "—".into());
                println!(
                    "{place:>3}  {:<11} {}/{}  медиана {:>6}  лучшая {:>6}  {}  {}",
                    r.kind.label(),
                    r.ok,
                    r.rounds,
                    r.median_ms.map(|m| format!("{m} мс")).unwrap_or_else(|| "—".into()),
                    r.best_ms.map(|m| format!("{m} мс")).unwrap_or_else(|| "—".into()),
                    r.label,
                    r.error.clone().unwrap_or_default()
                );
                if let Some(b) = &r.bulk {
                    println!("       256 КБ: {} КБ за {} мс{}", b.bytes / 1024, b.ms, b.note().map(|n| format!(" — {n}")).unwrap_or_default());
                }
            }
        }
        Err(e) => println!("ОШИБКА: {e}"),
    }
    history::flush();
}

/// `wpx --probe`: все проверки один раз, JSON в stdout.
pub fn probe_once() {
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("tokio");
    let report = rt.block_on(monitor::probe_report());
    println!("{}", serde_json::to_string_pretty(&report).unwrap_or_default());
}
