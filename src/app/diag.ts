// Проверка утечек в один клик и отчёт для поддержки (оба считает Rust).

import type { Api } from "../core/api";
import type { LeakCheck } from "../core/types";
import { $, esc, modal } from "../core/ui";

let api: Api;
let running = false;

const MK = { ok: "✓", leak: "!", unknown: "?" } as const;
const CLS = { ok: "ok", leak: "bad", unknown: "unk" } as const;

function leaksHtml(r: LeakCheck) {
  return `<div class="result ${r.verdict === "leak" ? "bad" : "ok"}">${esc(r.summary)}</div>
    <ul class="guard leaks">${r.items.map((i) => `<li class="${CLS[i.verdict]}"><span class="mk">${MK[i.verdict]}</span>
      <span><b>${esc(i.title)}</b><span class="d">${esc(i.detail)}</span></span></li>`).join("")}</ul>
    <p class="note">Проверяет сам wpx, без сторонних сайтов проверки: IP — запросом к Cloudflare, DNS — запросом к 8.8.8.8, WebRTC — STUN-запросом, как это делает браузер.</p>`;
}

export async function checkLeaks() {
  if (running) return;
  running = true;
  void modal("Проверка утечек", `<ol class="oplog"><li class="step live"><span class="mk">…</span><span>IP, выход мимо туннеля, IPv6, DNS, WebRTC — до 10 секунд</span></li></ol>`, null, null);
  try {
    const r = await api.leakCheck();
    await modal(r.verdict === "leak" ? "Есть утечка" : "Проверка утечек", leaksHtml(r), "Понятно", null);
  } catch (e) {
    await modal("Не получилось", `<div class="result bad">${esc(String(e))}</div>`, "Понятно", null);
  } finally {
    running = false;
  }
}

async function report() {
  const b = $<HTMLButtonElement>("btnReport");
  b.disabled = true;
  $("repMsg").textContent = "Собираю отчёт (вместе с проверкой утечек)…";
  try {
    $("repMsg").textContent = `Сохранено: ${await api.supportReport($<HTMLInputElement>("repHide").checked)} — отправьте файл в поддержку.`;
  } catch (e) {
    $("repMsg").textContent = String(e);
  }
  b.disabled = false;
}

export function initDiag(a: Api) {
  api = a;
  $("btnLeaks").addEventListener("click", () => void checkLeaks());
  $("btnLeaks2").addEventListener("click", () => void checkLeaks());
  $("btnReport").addEventListener("click", () => void report());
}
