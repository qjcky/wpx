//! Игровой режим: найти запущенную игру (exe и папку), разобрать то, что
//! перетащили на вырез (ярлык, exe, папку, ярлык Steam или Epic, ссылку на
//! сайт), и показать значок. Только чтение — систему не меняет.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use crate::platform::Hidden;

#[derive(Serialize)]
pub struct RunningApp {
    pub name: String,
    pub path: String,
    /// Папка игры (без «bin», «Binaries\Win64») — правило на неё ведёт и
    /// вспомогательные процессы игры.
    pub dir: String,
    pub mem_mb: u64,
}

/// Браузеры, мессенджеры, системное и сам wpx — не игры.
const SKIP: &[&str] = &[
    "explorer.exe", "chrome.exe", "msedge.exe", "msedgewebview2.exe", "firefox.exe", "brave.exe", "opera.exe", "browser.exe", "vivaldi.exe",
    "Telegram.exe", "Discord.exe", "Code.exe", "Claude.exe", "node.exe", "powershell.exe", "pwsh.exe", "cmd.exe", "conhost.exe", "WindowsTerminal.exe",
    "OpenConsole.exe", "wpx.exe", "wpx-lab.exe", "mihomo.exe", "wpx-probe.exe", "wpx-trial.exe", "steamwebhelper.exe", "EpicWebHelper.exe",
];

/// Запущенные программы, похожие на игры: не из системных папок, крупные по памяти — сверху.
#[tauri::command]
pub fn games_running() -> Vec<RunningApp> {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::new().with_memory().with_exe(UpdateKind::Always));
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into()).to_lowercase();
    let mut out: Vec<RunningApp> = vec![];
    for p in sys.processes().values() {
        let Some(exe) = p.exe() else { continue };
        let path = exe.to_string_lossy().to_string();
        let low = path.to_lowercase();
        if low.starts_with(&root) || low.contains(r"\windowsapps\") || low.contains(r"\microsoft\") || low.contains(r"\nvidia corporation\") || low.contains(r"\amd\") {
            continue;
        }
        // Linux: системное и программы из пакетов — не игры (игры — в ~/.steam, /opt, ~/Games).
        if cfg!(not(windows)) && ["/usr/", "/bin/", "/sbin/", "/lib", "/snap/", "/proc/"].iter().any(|p| low.starts_with(p)) {
            continue;
        }
        let name = exe.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let stem = name.trim_end_matches(".exe");
        if name.is_empty() || SKIP.iter().any(|s| s.trim_end_matches(".exe").eq_ignore_ascii_case(stem)) {
            continue;
        }
        let mem = p.memory() / 1_048_576;
        match out.iter_mut().find(|o| o.path.eq_ignore_ascii_case(&path)) {
            Some(o) => o.mem_mb += mem,
            // Папка игры, а не exe: «Binaries\Win64» — ещё не вся игра.
            None => out.push(RunningApp { name, dir: path_str(&game_dir(exe)), path, mem_mb: mem }),
        }
    }
    out.sort_by(|a, b| b.mem_mb.cmp(&a.mem_mb));
    out.truncate(24);
    out
}

/// Значок exe или ico (PNG 32×32) как data-URL — для плитки игры.
#[tauri::command]
pub async fn exe_icon(path: String) -> Result<String, String> {
    let low = path.to_ascii_lowercase();
    if cfg!(not(windows)) {
        // Linux: значок из ярлыка .desktop — уже картинка.
        use base64::Engine as _;
        if low.ends_with(".png") && Path::new(&path).is_file() {
            let b = fs::read(&path).map_err(|e| e.to_string())?;
            return Ok(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(b)));
        }
        return Err("значок есть только у картинки .png".into());
    }
    if !(low.ends_with(".exe") || low.ends_with(".ico")) || !Path::new(&path).is_file() {
        return Err("нет такого exe".into());
    }
    let out = tauri::async_runtime::spawn_blocking(move || {
        Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command",
                "Add-Type -AssemblyName System.Drawing; $i = if ($env:WPX_EXE -like '*.ico') { New-Object System.Drawing.Icon($env:WPX_EXE, 32, 32) } else { [System.Drawing.Icon]::ExtractAssociatedIcon($env:WPX_EXE) }; $m = New-Object IO.MemoryStream; $i.ToBitmap().Save($m, [System.Drawing.Imaging.ImageFormat]::Png); [Convert]::ToBase64String($m.ToArray())"])
            .env("WPX_EXE", path)
            .hidden()
            .output()
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    let b64 = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if b64.is_empty() || !b64.chars().all(|c| c.is_ascii_alphanumeric() || "+/=".contains(c)) {
        return Err("значок не извлёкся".into());
    }
    Ok(format!("data:image/png;base64,{b64}"))
}

/// Что перетащили на вырез.
#[derive(Serialize, Default, Debug)]
pub struct Dropped {
    /// Как назвать: имя ярлыка, игры в Steam или Epic, папки игры.
    pub name: String,
    /// exe (полный путь), если нашёлся.
    pub exe: Option<String>,
    /// Папка игры — всё, что из неё запускается.
    pub dir: Option<String>,
    /// Откуда взять значок: exe или ico.
    pub icon: Option<String>,
    /// Сайт — из интернет-ярлыка со ссылкой.
    pub site: Option<String>,
    /// steam, epic, lnk, exe, folder, url.
    pub from: String,
}

/// Разобрать перетащенное: ярлык, exe, папку, ярлык Steam или Epic, ссылку.
#[tauri::command]
pub async fn drop_inspect(path: String) -> Result<Dropped, String> {
    tauri::async_runtime::spawn_blocking(move || inspect(Path::new(&path))).await.map_err(|e| e.to_string())?
}

fn inspect(p: &Path) -> Result<Dropped, String> {
    let ext = p.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    let label = p.file_stem().map(|s| s.to_string_lossy().trim().to_string()).filter(|s| !s.is_empty());
    if p.is_dir() {
        return Ok(from_dir(p, "folder"));
    }
    match ext.as_str() {
        "exe" => Ok(from_exe(p, None, "exe")),
        "desktop" => desktop(p, label),
        _ if cfg!(not(windows)) && is_executable(p) => Ok(from_exe(p, None, "exe")),
        "lnk" => {
            let (target, args, icon) = lnk(p)?;
            if let Some(id) = steam_id(&args) {
                return steam(&id, label);
            }
            let t = Path::new(&target);
            let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
            if target.is_empty() || target.to_ascii_lowercase().starts_with(&root.to_ascii_lowercase()) {
                return Err("это ярлык Windows, а не игры — перетащите exe игры или её папку".into());
            }
            let mut d = if t.is_dir() {
                from_dir(t, "lnk")
            } else if t.is_file() && target.to_ascii_lowercase().ends_with(".exe") {
                from_exe(t, None, "lnk")
            } else {
                return Err("ярлык ведёт не к программе".into());
            };
            d.name = label.unwrap_or(d.name);
            if let Some(i) = icon_file(&icon) {
                d.icon = Some(i);
            }
            Ok(d)
        }
        "url" => {
            let text = String::from_utf8_lossy(&fs::read(p).map_err(|e| e.to_string())?).to_string();
            let url = ini_val(&text, "URL").ok_or("в ярлыке нет ссылки")?;
            let icon = ini_val(&text, "IconFile").and_then(|i| icon_file(&i));
            let mut d = if let Some(id) = steam_id(&url) {
                steam(&id, label)?
            } else if url.to_ascii_lowercase().starts_with("com.epicgames.launcher:") {
                epic(&url, label)?
            } else if let Some(host) = url::Url::parse(&url).ok().filter(|u| u.scheme().starts_with("http")).and_then(|u| u.host_str().map(String::from)) {
                let host = host.trim_start_matches("www.").to_string();
                return Ok(Dropped { name: host.clone(), site: Some(host), from: "url".into(), ..Default::default() });
            } else {
                return Err("такой ярлык wpx не понимает".into());
            };
            if icon.is_some() {
                d.icon = icon;
            }
            Ok(d)
        }
        _ => Err("перетащите ярлык игры, exe или папку".into()),
    }
}

/// Значок из ярлыка: «путь,номер» → путь, если это exe или ico и он есть.
fn icon_file(s: &str) -> Option<String> {
    let p = s.rsplit_once(',').map_or(s, |(a, b)| if b.trim().parse::<i32>().is_ok() { a } else { s }).trim();
    let low = p.to_ascii_lowercase();
    ((low.ends_with(".exe") || low.ends_with(".ico")) && Path::new(p).is_file()).then(|| p.to_string())
}

fn path_str(p: &Path) -> String {
    p.to_string_lossy().to_string()
}

/// Имя папки; у корня диска — «Игра».
fn dir_name(d: &Path) -> String {
    d.file_name().map(|n| n.to_string_lossy().to_string()).filter(|n| !n.is_empty()).unwrap_or_else(|| "Игра".into())
}

fn from_dir(d: &Path, from: &str) -> Dropped {
    let exe = main_exe(d);
    Dropped { name: dir_name(d), icon: exe.clone(), exe, dir: Some(path_str(d)), from: from.into(), ..Default::default() }
}

fn from_exe(exe: &Path, name: Option<String>, from: &str) -> Dropped {
    let dir = game_dir(exe);
    Dropped {
        name: name.unwrap_or_else(|| dir_name(&dir)),
        exe: Some(path_str(exe)),
        icon: Some(path_str(exe)),
        dir: Some(path_str(&dir)),
        from: from.into(),
        ..Default::default()
    }
}

/// Библиотеки игр: игра — первая папка после них.
const LIBS: &[&str] = &[
    r"\steamapps\common\",
    r"\epic games\",
    r"\riot games\",
    r"\ubisoft game launcher\games\",
    r"\xboxgames\",
    r"\games\",
    r"\program files (x86)\",
    r"\program files\",
];

/// Служебные папки внутри игры (bin, Binaries\Win64 и т. п.) — выше них корень игры.
const INNER: &[&str] = &["bin", "bin32", "bin64", "binaries", "win32", "win64", "x64", "x86", "retail", "shipping"];

/// Папка игры по пути exe: в библиотеке («…\steamapps\common\Игра»,
/// «D:\Games\Игра») — первая папка после неё; иначе папка exe без служебных
/// («bin», «Binaries\Win64»).
fn game_dir(exe: &Path) -> PathBuf {
    let parent = exe.parent().unwrap_or(exe).to_path_buf();
    let comps: Vec<std::path::Component> = parent.components().collect();
    let low: Vec<String> = comps.iter().map(|c| c.as_os_str().to_string_lossy().to_ascii_lowercase()).collect();
    for m in LIBS {
        let parts: Vec<&str> = m.trim_matches('\\').split('\\').collect();
        let hit = (0..low.len()).find(|&i| i + parts.len() < low.len() && parts.iter().enumerate().all(|(k, p)| low[i + k] == *p));
        if let Some(i) = hit {
            return comps[..i + parts.len() + 1].iter().collect();
        }
    }
    let mut d = parent;
    while d.file_name().is_some_and(|n| INNER.contains(&n.to_string_lossy().to_ascii_lowercase().as_str())) && d.parent().and_then(Path::parent).is_some() {
        d = d.parent().map(Path::to_path_buf).unwrap_or(d);
    }
    d
}

/// Не основной exe игры: установщики, отчёты о сбоях, античит, помощники.
const NOT_GAME: &[&str] = &[
    "unins", "crash", "setup", "redist", "vcredist", "vc_redist", "dxsetup", "dotnet", "report", "install", "update", "patch", "easyanticheat", "battleye",
    "be_service", "cefprocess", "webhelper", "prereq", "helper",
];

/// Основной exe в папке игры: самый крупный (до трёх уровней вглубь).
fn main_exe(dir: &Path) -> Option<String> {
    let mut best: Option<(u64, PathBuf)> = None;
    let mut stack = vec![(dir.to_path_buf(), 0)];
    let mut seen = 0;
    while let Some((d, depth)) = stack.pop() {
        let Ok(rd) = fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            seen += 1;
            if seen > 5000 {
                return best.map(|(_, p)| path_str(&p));
            }
            let Ok(ft) = e.file_type() else { continue };
            let p = e.path();
            if ft.is_dir() {
                if depth < 3 {
                    stack.push((p, depth + 1));
                }
                continue;
            }
            let name = e.file_name().to_string_lossy().to_ascii_lowercase();
            if !name.ends_with(".exe") || NOT_GAME.iter().any(|s| name.contains(s)) {
                continue;
            }
            let len = e.metadata().map(|m| m.len()).unwrap_or(0);
            if best.as_ref().is_none_or(|(b, _)| len > *b) {
                best = Some((len, p));
            }
        }
    }
    best.map(|(_, p)| path_str(&p))
}

/// Исполняемый файл (Linux: есть право на запуск).
#[cfg(not(windows))]
fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(p).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

#[cfg(windows)]
fn is_executable(_p: &Path) -> bool {
    false
}

/// Ярлык Linux (.desktop): `Exec=steam steam://rungameid/…` — игра Steam;
/// иначе программа из Exec (первое слово, путь — как есть).
fn desktop(p: &Path, label: Option<String>) -> Result<Dropped, String> {
    let text = String::from_utf8_lossy(&fs::read(p).map_err(|e| e.to_string())?).to_string();
    let name = ini_val(&text, "Name").or(label);
    let exec = ini_val(&text, "Exec").ok_or("в ярлыке нет команды запуска")?;
    let icon = ini_val(&text, "Icon").filter(|i| i.starts_with('/') && i.ends_with(".png") && Path::new(i).is_file());
    let mut d = if let Some(id) = steam_id(&exec) {
        steam(&id, name.clone())?
    } else {
        let first = exec.split_whitespace().next().unwrap_or("").trim_matches('"');
        let t = Path::new(first);
        if !t.is_absolute() || !t.is_file() {
            return Err("ярлык запускает команду, а не программу из папки — перетащите саму программу или её папку".into());
        }
        from_exe(t, None, "desktop")
    };
    if let Some(n) = name {
        d.name = n;
    }
    if icon.is_some() {
        d.icon = icon;
    }
    Ok(d)
}

/// Ярлык .lnk: куда ведёт, с какими параметрами, значок.
#[cfg(not(windows))]
fn lnk(_p: &Path) -> Result<(String, String, String), String> {
    Err("ярлыки Windows (.lnk) в Linux не разбираются — перетащите программу или её папку".into())
}

/// Ярлык .lnk: куда ведёт, с какими параметрами, значок.
#[cfg(windows)]
fn lnk(p: &Path) -> Result<(String, String, String), String> {
    let out = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command",
            "[Console]::OutputEncoding = [Text.Encoding]::UTF8; $s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:WPX_LNK); $s.TargetPath; $s.Arguments; $s.IconLocation"])
        .env("WPX_LNK", p)
        .hidden()
        .output()
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let mut l = text.lines().map(|s| s.trim().to_string());
    Ok((l.next().unwrap_or_default(), l.next().unwrap_or_default(), l.next().unwrap_or_default()))
}

/// Значение из ярлыка .url (`URL=…`, `IconFile=…`).
fn ini_val(text: &str, key: &str) -> Option<String> {
    text.lines()
        .filter_map(|l| l.split_once('='))
        .find(|(k, _)| k.trim().eq_ignore_ascii_case(key))
        .map(|(_, v)| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// Номер игры Steam из ссылки `steam://rungameid/570`.
fn steam_id(s: &str) -> Option<String> {
    let i = s.find("steam://rungameid/")?;
    let id: String = s[i + 18..].chars().take_while(char::is_ascii_digit).collect();
    (!id.is_empty()).then_some(id)
}

/// Папка Steam: в Windows — из реестра, в Linux — в домашней папке (обычная
/// установка или Flatpak).
#[cfg(windows)]
fn steam_root() -> Option<PathBuf> {
    reg_value(r"HKCU\Software\Valve\Steam", "SteamPath")
        .or_else(|| reg_value(r"HKLM\SOFTWARE\WOW6432Node\Valve\Steam", "InstallPath"))
        .map(|p| PathBuf::from(p.replace('/', r"\")))
}

#[cfg(not(windows))]
fn steam_root() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    [".steam/steam", ".local/share/Steam", ".var/app/com.valvesoftware.Steam/.local/share/Steam"]
        .iter()
        .map(|p| home.join(p))
        .find(|p| p.join("steamapps").is_dir())
}

/// Строковое значение из реестра (`reg query`).
#[cfg(windows)]
fn reg_value(key: &str, val: &str) -> Option<String> {
    let out = Command::new("reg").args(["query", key, "/v", val]).hidden().output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    text.lines()
        .find(|l| l.trim_start().starts_with(val))
        .and_then(|l| l.split("REG_SZ").nth(1))
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// Значения ключа в файлах Steam (VDF, ACF): строки `"ключ"  "значение"`.
fn vdf_all(text: &str, key: &str) -> Vec<String> {
    text.lines()
        .filter_map(|l| {
            let p: Vec<&str> = l.split('"').collect();
            (p.len() >= 5 && p[1].eq_ignore_ascii_case(key)).then(|| p[3].replace(r"\\", r"\"))
        })
        .collect()
}

/// Игра Steam по номеру: папка из манифеста в любой из библиотек Steam.
fn steam(id: &str, label: Option<String>) -> Result<Dropped, String> {
    let root = steam_root().ok_or("Steam на этом ПК не найден")?;
    // Сначала пути из списка библиотек (в них верный регистр букв), корень Steam — последним.
    let mut libs: Vec<PathBuf> = fs::read_to_string(root.join("steamapps").join("libraryfolders.vdf")).map(|t| vdf_all(&t, "path").into_iter().map(PathBuf::from).collect()).unwrap_or_default();
    libs.push(root);
    for lib in libs {
        let Ok(acf) = fs::read_to_string(lib.join("steamapps").join(format!("appmanifest_{id}.acf"))) else { continue };
        let Some(inst) = vdf_all(&acf, "installdir").into_iter().next() else { continue };
        let dir = lib.join("steamapps").join("common").join(inst);
        let name = vdf_all(&acf, "name").into_iter().next().or(label).unwrap_or_else(|| dir_name(&dir));
        let exe = main_exe(&dir);
        return Ok(Dropped { name, icon: exe.clone(), exe, dir: Some(path_str(&dir)), from: "steam".into(), ..Default::default() });
    }
    Err("эта игра не установлена в Steam на этом ПК".into())
}

/// Игра Epic по ссылке `com.epicgames.launcher://apps/<ns>%3A<id>%3A<имя>?action=launch`.
fn epic(url: &str, label: Option<String>) -> Result<Dropped, String> {
    let tail = url.split("/apps/").nth(1).ok_or("непонятная ссылка Epic")?;
    let ids = percent_encoding::percent_decode_str(tail.split(['?', '#']).next().unwrap_or("")).decode_utf8_lossy().to_string();
    let keys: Vec<&str> = ids.split(':').filter(|s| !s.is_empty()).collect();
    let base = PathBuf::from(std::env::var("ProgramData").unwrap_or_else(|_| r"C:\ProgramData".into())).join(r"Epic\EpicGamesLauncher\Data\Manifests");
    for e in fs::read_dir(base).map_err(|_| "Epic Games на этом ПК не найден")?.flatten() {
        if !e.file_name().to_string_lossy().to_ascii_lowercase().ends_with(".item") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&fs::read_to_string(e.path()).unwrap_or_default()) else { continue };
        let f = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
        let ours = [f("AppName"), f("CatalogItemId")];
        if !keys.iter().any(|k| ours.iter().any(|x| !x.is_empty() && x.eq_ignore_ascii_case(k))) {
            continue;
        }
        let dir = PathBuf::from(f("InstallLocation"));
        let launch = dir.join(f("LaunchExecutable"));
        let exe = if launch.is_file() { Some(path_str(&launch)) } else { main_exe(&dir) };
        let name = Some(f("DisplayName")).filter(|s| !s.is_empty()).or(label).unwrap_or_else(|| dir_name(&dir));
        return Ok(Dropped { name, icon: exe.clone(), exe, dir: Some(path_str(&dir)), from: "epic".into(), ..Default::default() });
    }
    Err("эта игра не установлена в Epic Games на этом ПК".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(windows)]
    fn game_dir_from_exe() {
        let g = |p: &str| game_dir(Path::new(p)).to_string_lossy().to_string();
        assert_eq!(g(r"C:\Program Files (x86)\Steam\steamapps\common\dota 2 beta\game\bin\win64\dota2.exe"), r"C:\Program Files (x86)\Steam\steamapps\common\dota 2 beta");
        assert_eq!(g(r"D:\Games\Aion 2\Binaries\Win64\Aion2.exe"), r"D:\Games\Aion 2");
        assert_eq!(g(r"C:\Riot Games\VALORANT\live\VALORANT.exe"), r"C:\Riot Games\VALORANT");
        assert_eq!(g(r"E:\Игры\Моя игра\bin\x64\game.exe"), r"E:\Игры\Моя игра");
        assert_eq!(g(r"E:\Tarkov\EscapeFromTarkov.exe"), r"E:\Tarkov");
    }

    #[test]
    fn shortcut_values() {
        let url = "[{000214A0-0000-0000-C000-000000000046}]\r\nProp3=19,0\r\n[InternetShortcut]\r\nIDList=\r\nIconIndex=0\r\nURL=steam://rungameid/570\r\nIconFile=C:\\Steam\\steam\\games\\x.ico\r\n";
        assert_eq!(ini_val(url, "url").as_deref(), Some("steam://rungameid/570"));
        assert_eq!(steam_id("steam://rungameid/570").as_deref(), Some("570"));
        assert_eq!(steam_id("-silent steam://rungameid/1234567/").as_deref(), Some("1234567"));
        assert_eq!(steam_id("https://example.com"), None);
        let vdf = "\"libraryfolders\"\n{\n\t\"0\"\n\t{\n\t\t\"path\"\t\t\"C:\\\\Program Files (x86)\\\\Steam\"\n\t}\n\t\"1\"\n\t{\n\t\t\"path\"\t\t\"D:\\\\SteamLibrary\"\n\t}\n}";
        assert_eq!(vdf_all(vdf, "path"), vec![r"C:\Program Files (x86)\Steam".to_string(), r"D:\SteamLibrary".to_string()]);
    }

    #[test]
    #[cfg(not(windows))]
    fn game_dir_from_linux_path() {
        let g = |p: &str| game_dir(Path::new(p)).to_string_lossy().to_string();
        assert_eq!(g("/home/u/.steam/steam/steamapps/common/Dota 2/game/bin/linuxsteamrt64/dota2"), "/home/u/.steam/steam/steamapps/common/Dota 2");
        assert_eq!(g("/home/u/Games/Aion 2/Binaries/Win64/Aion2.exe"), "/home/u/Games/Aion 2");
        assert_eq!(g("/opt/mygame/bin/game"), "/opt/mygame");
    }

    /// Ручная проверка на ярлыках этого ПК: `WPX_DROP="a.lnk;b.url" cargo test drop_real -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn drop_real() {
        for p in std::env::var("WPX_DROP").unwrap_or_default().split(';').filter(|s| !s.is_empty()) {
            println!("{p} → {:?}", inspect(Path::new(p)));
        }
    }
}
