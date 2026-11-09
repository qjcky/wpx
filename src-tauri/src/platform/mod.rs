//! Различия Windows и Linux, которые нужны всему приложению: служебные
//! процессы без окна, сетевые адаптеры, имя curl. Операции с движком
//! (установка, kill switch) — в `engine::ops` по системам.

use std::process::Command;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::*;

#[cfg(not(windows))]
mod linux;
#[cfg(not(windows))]
pub use linux::*;

/// Запуск служебной программы без окна консоли (в Windows; в Linux окна и
/// так нет).
pub trait Hidden {
    fn hidden(&mut self) -> &mut Self;
}

impl Hidden for Command {
    #[cfg(windows)]
    fn hidden(&mut self) -> &mut Self {
        use std::os::windows::process::CommandExt;
        self.creation_flags(0x0800_0000)
    }
    #[cfg(not(windows))]
    fn hidden(&mut self) -> &mut Self {
        self
    }
}

/// curl из системы: в Windows 10+ встроен как curl.exe.
pub const CURL: &str = if cfg!(windows) { "curl.exe" } else { "curl" };

/// «Никуда» для вывода curl.
pub const NULL_DEV: &str = if cfg!(windows) { "NUL" } else { "/dev/null" };

/// Имя исполняемого файла: в Windows — с .exe.
pub fn exe(name: &str) -> String {
    if cfg!(windows) { format!("{name}.exe") } else { name.to_string() }
}
