//! Окно, вырез и трей: команды для фронтенда и всё, что связано с показом.

pub mod cmd;
#[cfg(windows)]
pub mod dropfiles;
pub mod gameroute;
pub mod games;
pub mod lang;
pub mod notch;
pub mod prefs;
pub mod tray;
pub mod update;
