#!/usr/bin/env node
// Скачивает mihomo (движок туннеля) для текущей платформы, сверяет SHA-256
// с закреплённым и кладёт как sidecar Tauri: src-tauri/binaries/wpx-mihomo-<target>[.exe].
// Уже лежит нужная версия — ничего не делает. Запускается после `npm install`
// (postinstall) и в CI перед сборкой.
//
// Usage: node scripts/fetch-mihomo.mjs [--target <rust-triple>] [--force]
//
// Обновить mihomo: поменять VERSION и хэши ниже (они есть в релизе на GitHub:
// https://github.com/MetaCubeX/mihomo/releases), проверить сборку и туннель.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, inflateRawSync } from "node:zlib";

const VERSION = "v1.19.33";

/** Сборка mihomo для каждой цели Rust: архив и его SHA-256 из релиза. */
const ASSETS = {
  "x86_64-pc-windows-msvc": {
    file: `mihomo-windows-amd64-compatible-${VERSION}.zip`,
    sha256: "7aaf636a4f2172dcd8ec34ac4f52797b059195e5afd6409508c963e545f8864d",
  },
  "x86_64-unknown-linux-gnu": {
    file: `mihomo-linux-amd64-compatible-${VERSION}.gz`,
    sha256: "386508bfb1c72c43b6a0eda73708ecdce82546581b0ebcb16366c53757c622b6",
  },
  "aarch64-unknown-linux-gnu": {
    file: `mihomo-linux-arm64-${VERSION}.gz`,
    sha256: "ba408b317080ee265c46cb923a50018c1b82cbd708551cdd46a1e3e307396187",
  },
};

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const force = args.includes("--force");
const ti = args.indexOf("--target");

function hostTriple() {
  try {
    const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
    return /^host: (.+)$/m.exec(out)?.[1]?.trim();
  } catch {
    return null;
  }
}

const target = ti >= 0 ? args[ti + 1] : process.env.WPX_TARGET || hostTriple();
if (!target) {
  console.error("fetch-mihomo: не удалось узнать цель сборки (нет rustc?) — передайте --target <triple>");
  process.exit(1);
}
const asset = ASSETS[target];
if (!asset) {
  console.error(`fetch-mihomo: для ${target} нет закреплённой сборки mihomo (есть: ${Object.keys(ASSETS).join(", ")})`);
  process.exit(1);
}

const exe = target.includes("windows") ? ".exe" : "";
const outDir = join(root, "src-tauri", "binaries");
const out = join(outDir, `wpx-mihomo-${target}${exe}`);
const stamp = `${out}.version`;
const sha = (b) => createHash("sha256").update(b).digest("hex");

if (!force && existsSync(out) && existsSync(stamp) && readFileSync(stamp, "utf8").trim() === `${VERSION} ${asset.sha256}`) {
  process.exit(0);
}

const url = `https://github.com/MetaCubeX/mihomo/releases/download/${VERSION}/${asset.file}`;
console.log(`fetch-mihomo: ${asset.file} → ${out}`);
const res = await fetch(url, { redirect: "follow" });
if (!res.ok) {
  console.error(`fetch-mihomo: ${url} — HTTP ${res.status}`);
  process.exit(1);
}
const archive = Buffer.from(await res.arrayBuffer());
const got = sha(archive);
if (got !== asset.sha256) {
  console.error(`fetch-mihomo: контрольная сумма не совпала (${got}) — не ставлю`);
  process.exit(1);
}

/** Первый файл из zip (в архиве mihomo он один): заголовок файла → deflate. */
function unzipFirst(buf) {
  if (buf.readUInt32LE(0) !== 0x04034b50) throw new Error("не zip");
  const method = buf.readUInt16LE(8);
  const nameLen = buf.readUInt16LE(26);
  const extraLen = buf.readUInt16LE(28);
  let size = buf.readUInt32LE(18);
  const start = 30 + nameLen + extraLen;
  if (size === 0 || size === 0xffffffff) {
    // Размер — в центральном каталоге (флаг data descriptor).
    const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const cd = buf.readUInt32LE(eocd + 16);
    size = buf.readUInt32LE(cd + 20);
  }
  const data = buf.subarray(start, start + size);
  if (method === 0) return Buffer.from(data);
  if (method === 8) return inflateRawSync(data);
  throw new Error(`zip: метод сжатия ${method} не поддержан`);
}

const binary = asset.file.endsWith(".zip") ? unzipFirst(archive) : gunzipSync(archive);
mkdirSync(outDir, { recursive: true });
writeFileSync(out, binary);
if (!exe) chmodSync(out, 0o755);
writeFileSync(stamp, `${VERSION} ${asset.sha256}\n`);
console.log(`fetch-mihomo: mihomo ${VERSION} готов (${(binary.length / 1048576).toFixed(1)} МБ)`);
