use sha2::{Digest, Sha256};

fn main() {
    // SHA-256 mihomo из поставки — в программу: установка движка (с правами
    // администратора) сверяет с ним скопированный файл, подмену в папке
    // пользователя не пропустит. Файл кладёт scripts/fetch-mihomo.mjs.
    let target = std::env::var("TARGET").unwrap_or_default();
    let ext = if target.contains("windows") { ".exe" } else { "" };
    let path = format!("binaries/wpx-mihomo-{target}{ext}");
    println!("cargo:rerun-if-changed={path}");
    let bin = std::fs::read(&path).unwrap_or_else(|_| panic!("нет {path} — выполните `npm run fetch-mihomo`"));
    let hash: String = Sha256::digest(&bin).iter().map(|b| format!("{b:02X}")).collect();
    println!("cargo:rustc-env=WPX_MIHOMO_SHA256={hash}");
    tauri_build::build()
}
