#!/bin/sh
# Копия исходников из /host (только чтение) → /work, сборка, пакеты → /out.
# WPX_STEP=test — только проверки (типы, тесты Rust), без пакетов.
set -eu
rsync -a --delete --exclude node_modules --exclude 'src-tauri/target' --exclude 'src-tauri/binaries' --exclude dist /host/ /work/
cd /work
# esbuild при установке иногда ловит ETXTBSY (гонка в контейнере) — второй раз проходит.
npm ci --no-audit --no-fund || { sleep 2; npm ci --no-audit --no-fund; }
npx tsc --noEmit
(cd src-tauri && cargo test --lib)
if [ "${WPX_STEP:-build}" = test ]; then exit 0; fi
npx tauri build
mkdir -p /out
cp -v "$CARGO_TARGET_DIR"/release/bundle/deb/*.deb "$CARGO_TARGET_DIR"/release/bundle/appimage/*.AppImage /out/ 2>/dev/null || true
