//! Операции с движком. Всё, что меняет систему, — одна транзакция:
//!
//! 1. новый конфиг собирается и проверяется `mihomo -t` (без прав);
//! 2. одно окно прав администратора (UAC в Windows, polkit в Linux)
//!    запускает скрипт (аргументом, без файла);
//! 3. скрипт ставит страховку от имени системы с отменой изменений через
//!    несколько минут → меняет → проверяет туннель;
//! 4. туннель жив — страховка снимается; нет — отмена сразу.
//!
//! Если wpx или сам скрипт упадут посередине, страховка всё вернёт.
//! Скрипты по системам: `windows.rs` (PowerShell, Планировщик, брандмауэр
//! Windows), `linux.rs` (bash, systemd, nftables).

use rand_core::{OsRng, RngCore};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::config::{self, EngineKind};
use crate::engine::netcfg::{self, NetSettings};
use crate::platform::Hidden;
use crate::profiles::Profile;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as sys;
#[cfg(not(windows))]
mod linux;
#[cfg(not(windows))]
use linux as sys;

#[derive(Serialize, Clone, Debug)]
pub struct ApplyResult {
    pub ok: bool,
    /// "applied" | "rolled_back" | "error" | "cancelled"
    pub outcome: String,
    pub message: String,
    /// Доп. данные операции (например, JSON глубокой проверки).
    pub info: Option<String>,
}

impl ApplyResult {
    pub fn fail(m: impl Into<String>) -> Self {
        Self { ok: false, outcome: "error".into(), message: m.into(), info: None }
    }
}

/// Случайная строка из `n` шестнадцатеричных знаков (секреты API движка,
/// песочницы, пробного запуска) — из системного генератора.
pub fn random_hex(n: usize) -> String {
    let mut b = vec![0u8; n.div_ceil(2)];
    OsRng.fill_bytes(&mut b);
    let mut s: String = b.iter().map(|x| format!("{x:02x}")).collect();
    s.truncate(n);
    s
}

/// SHA-256 файла (заглавными, как Get-FileHash).
fn sha256_file(p: &Path) -> Result<String, String> {
    let bytes = std::fs::read(p).map_err(|e| e.to_string())?;
    Ok(Sha256::digest(&bytes).iter().map(|b| format!("{b:02X}")).collect())
}

/// SHA-256 mihomo из поставки (считает build.rs при сборке).
const MIHOMO_SHA256: &str = env!("WPX_MIHOMO_SHA256");

// ─── Итог скрипта ────────────────────────────────────────────────

/// «Туннель не поднялся» + последние строки журнала движка, если есть.
fn no_tunnel(prefix: &str, msg: &str) -> String {
    let tail = msg.strip_prefix("LOG:").unwrap_or("").trim();
    if tail.is_empty() {
        format!("{prefix}.")
    } else {
        format!("{prefix}. Журнал движка: {tail}")
    }
}

fn humanize(code: &str) -> String {
    match code.trim() {
        "E_CANDIDATE_CHANGED" => "файл нового конфига изменился после проверки".into(),
        "E_NO_MIHOMO" => "не найден mihomo из поставки wpx — переустановите wpx".into(),
        "E_NOT_WPX" | "E_NOT_INSTALLED" => "движок ещё не установлен".into(),
        "E_MIHOMO_HASH" => "mihomo из поставки wpx не прошёл проверку подлинности — переустановите wpx".into(),
        "E_TASK_MISSING" => "задача движка не найдена".into(),
        "E_ACL" => "не удалось выставить права на папку движка".into(),
        "E_WPX_DIR_LINK" => "папка движка оказалась ссылкой на другую папку — операция остановлена; удалите папку wpx в ProgramData и повторите".into(),
        "E_NO_SYSTEMD" => "нет systemd — движок wpx в Linux работает как служба systemd".into(),
        "E_NO_NFT" => "нет nft (nftables) — поставьте пакет nftables".into(),
        "E_FAILED" => "команда завершилась с ошибкой".into(),
        other => other.to_string(),
    }
}

/// Итог скрипта (последняя строка «ИТОГ|данные|сообщение») → результат для окна.
/// `cancelled` — окно прав закрыли без подтверждения.
fn outcome(text: &str, cancelled: bool) -> ApplyResult {
    let line = text.lines().rev().map(str::trim).find(|l| l.contains('|')).unwrap_or("");
    let mut parts = line.splitn(3, '|');
    let (tag, info, msg) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    let info = (!info.is_empty()).then(|| info.to_string());
    let r = |ok: bool, outcome: &str, message: String| ApplyResult { ok, outcome: outcome.into(), message, info: info.clone() };
    match tag {
        "OK" => r(true, "applied", "Готово, туннель работает".into()),
        "NOTUNNEL" => r(false, "error", no_tunnel("Выполнено, но туннель не отвечает", msg)),
        "ROLLEDBACK" => r(
            false,
            "rolled_back",
            if msg.is_empty() || msg.starts_with("LOG:") {
                no_tunnel("Туннель не поднялся — всё вернул как было", msg)
            } else {
                format!("Ошибка, всё вернул как было: {}", humanize(msg))
            },
        ),
        "ERR" => r(false, "error", format!("Ничего не изменено: {}", humanize(msg))),
        _ if cancelled => r(false, "cancelled", "Отменено в окне подтверждения — ничего не изменено".into()),
        _ => r(false, "error", "Скрипт не вернул результат. Если изменения были, страховка их отменит".into()),
    }
}

const LAB_OFF: &str = "Лабораторная сборка: системные операции отключены — рабочий туннель не трогаю";

// ─── Проверка конфига ────────────────────────────────────────────

/// mihomo для `-t`: установленного движка, иначе из поставки wpx — первый,
/// который реально открывается (файл может существовать, но быть недоступен).
fn mihomo_exe() -> PathBuf {
    [config::wpx().mihomo(), config::bundled_mihomo()]
        .into_iter()
        .find(|p| std::fs::File::open(p).is_ok())
        .unwrap_or_else(config::bundled_mihomo)
}

pub fn test_config(path: &Path) -> Result<(), String> {
    let work = config::data_dir().join("mihomo-test");
    let _ = std::fs::create_dir_all(&work);
    let out = Command::new(mihomo_exe())
        .arg("-t").arg("-d").arg(&work).arg("-f").arg(path)
        .hidden()
        .output()
        .map_err(|e| format!("не запустился mihomo -t: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout).to_string() + &String::from_utf8_lossy(&out.stderr);
    if out.status.success() && text.contains("test is successful") {
        Ok(())
    } else {
        Err(text.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("проверка не пройдена").to_string())
    }
}

/// Собрать конфиг профиля во временную папку, проверить, вернуть (путь, sha256).
pub fn stage(ch: &crate::profiles::Chain, n: &NetSettings) -> Result<(PathBuf, String), String> {
    let cfg = netcfg::build(ch, n)?;
    let dir = config::data_dir().join("staged");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("config.yaml");
    std::fs::write(&path, serde_json::to_string_pretty(&cfg).unwrap_or_default()).map_err(|e| e.to_string())?;
    // Прежние копии файлов правил (их теперь отдаёт окно по 127.0.0.1).
    let _ = std::fs::remove_dir_all(dir.join("user"));
    let _ = std::fs::remove_dir_all(config::data_dir().join("mihomo-test").join("user"));
    test_config(&path).map_err(|e| format!("mihomo отверг конфиг: {e}"))?;
    let hash = sha256_file(&path)?;
    Ok((path, hash))
}

/// mihomo из поставки — откуда его возьмёт скрипт с правами администратора.
/// Linux: AppImage смонтирован через FUSE, а такая папка недоступна даже
/// root — сначала копия в папку данных (скрипт всё равно сверит её хэш).
fn mihomo_source() -> Result<PathBuf, String> {
    let src = config::bundled_mihomo();
    if cfg!(windows) {
        return Ok(src);
    }
    let dir = config::data_dir().join("staged");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dst = dir.join(config::MIHOMO);
    std::fs::copy(&src, &dst).map_err(|e| format!("mihomo из поставки: {e}"))?;
    Ok(dst)
}

/// Конфиг с паролями и ключами не лежит в папке данных дольше операции.
fn clean_staged() {
    let _ = std::fs::remove_dir_all(config::data_dir().join("staged"));
}

// ─── Операции ────────────────────────────────────────────────────

fn need_engine() -> Result<(), ApplyResult> {
    if config::active().kind != EngineKind::Wpx {
        return Err(ApplyResult::fail("Сначала установите движок"));
    }
    Ok(())
}

/// Сделать профиль рабочим: установка движка (если его ещё нет) или замена конфига.
pub fn activate(p: &Profile, n: &NetSettings) -> ApplyResult {
    let ch = match crate::profiles::chain_of(&crate::profiles::load(), p) {
        Ok(c) => c,
        Err(e) => return ApplyResult::fail(e),
    };
    let (staged, hash) = match stage(&ch, n) {
        Ok(x) => x,
        Err(e) => return ApplyResult::fail(e),
    };
    let r = match config::active().kind {
        EngineKind::Missing => match mihomo_source() {
            Ok(src) => sys::install(&staged, &hash, &src, MIHOMO_SHA256, n),
            Err(e) => ApplyResult::fail(e),
        },
        EngineKind::Wpx => sys::apply(&staged, &hash, n),
    };
    clean_staged();
    r
}

pub fn restart() -> ApplyResult {
    let mut r = sys::restart(&config::active());
    old_follow_hint(&mut r);
    r
}

/// Конфиг ещё прежней схемы (файлы правил в папке движка): после перехода на
/// `home` правила «найденного на лету» заработают с первым «Применить».
fn old_follow_hint(r: &mut ApplyResult) {
    let old = std::fs::read_to_string(std::path::Path::new(config::WPX_DIR).join("config.yaml")).is_ok_and(|t| t.contains("./user/follow-"));
    if r.ok && old && r.info.is_none() {
        r.info = Some("Правила «и всё, что она запускает» заработают после «Применить» на вкладке «Правила»".into());
    }
}

pub fn start() -> ApplyResult {
    sys::start(&config::active())
}

pub fn stop() -> ApplyResult {
    sys::stop(&config::active())
}

pub fn set_boot(on: bool) -> ApplyResult {
    need_engine().map_or_else(|e| e, |_| sys::set_boot(on))
}

pub fn set_heal(on: bool) -> ApplyResult {
    need_engine().map_or_else(|e| e, |_| sys::set_heal(on))
}

/// Глубокая проверка kill switch: движок останавливается на ~15 с, прямые
/// подключения и DNS мимо туннеля должны НЕ пройти, прокси — пройти.
pub fn deep_test(hops: &[(String, u16)]) -> ApplyResult {
    sys::deep_test(&config::active(), hops)
}

/// Удалить движок: службу/задачи, правила файрвола (kill switch — с возвратом
/// прежних умолчаний), папку движка. Профили и настройки wpx остаются.
pub fn uninstall() -> ApplyResult {
    sys::uninstall()
}

/// mihomo движка отличается от того, что пришёл с этой версией wpx.
pub fn engine_outdated() -> bool {
    if config::active().kind != EngineKind::Wpx {
        return false;
    }
    let (a, b) = (config::wpx().mihomo(), config::bundled_mihomo());
    match (std::fs::metadata(&a), std::fs::metadata(&b)) {
        (Ok(x), Ok(y)) if x.len() != y.len() => true,
        (Ok(_), Ok(_)) => sha256_file(&a).map(|h| h != MIHOMO_SHA256).unwrap_or(false),
        _ => false,
    }
}

/// Поставить движку mihomo из этой версии wpx (с проверкой туннеля и откатом).
pub fn update_engine() -> ApplyResult {
    if let Err(e) = need_engine() {
        return e;
    }
    let mut r = match mihomo_source() {
        Ok(src) => sys::update_engine(&src, MIHOMO_SHA256),
        Err(e) => ApplyResult::fail(e),
    };
    clean_staged();
    old_follow_hint(&mut r);
    r
}
