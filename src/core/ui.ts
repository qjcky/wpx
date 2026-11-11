// Общие помощники окна: DOM, модальные окна, запуск операций с движком.

import type { ApplyResult, NotchAnchor, ProbeResult } from "./types";

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** Края и углы экрана для выреза. */
export const NOTCH_AT: [NotchAnchor, string][] = [
  ["top", "Сверху по центру"], ["top-left", "Сверху слева"], ["top-right", "Сверху справа"],
  ["left", "Слева"], ["right", "Справа"],
  ["bottom", "Снизу по центру"], ["bottom-left", "Снизу слева"], ["bottom-right", "Снизу справа"],
];

const two = (n: number) => String(n).padStart(2, "0");
/** «12.11 18:11» — местное время. */
export const when = (t: number) => { const d = new Date(t); return `${two(d.getDate())}.${two(d.getMonth() + 1)} ${two(d.getHours())}:${two(d.getMinutes())}`; };

export const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function modal(title: string, body: string, ok: string | null, cancel: string | null): Promise<boolean> {
  $("modalTitle").textContent = title;
  $("modalBody").innerHTML = body;
  const okB = $<HTMLButtonElement>("modalOk"), noB = $<HTMLButtonElement>("modalCancel");
  okB.hidden = ok === null;
  noB.hidden = cancel === null;
  if (ok) okB.textContent = ok;
  if (cancel) noB.textContent = cancel;
  $("modal").hidden = false;
  (ok ? okB : noB).focus();
  return new Promise((res) => {
    const done = (v: boolean) => {
      $("modal").hidden = true; okB.onclick = noB.onclick = null; res(v);
      // Закрытое окно не держит в DOM ссылки, ключи и QR. Чистим после того,
      // как ждавший код прочитал поля (синхронно сразу после await), и только
      // если следом не открылось новое окно.
      window.setTimeout(() => { if ($("modal").hidden) $("modalBody").innerHTML = ""; }, 0);
    };
    okB.onclick = () => done(true);
    noB.onclick = () => done(false);
  });
}

/** Итог проверки точки: задержка и (если была) загрузка 256 КБ — заморозка. */
export function probeBadge(r: ProbeResult) {
  if (!r.ok) return `<span class="r fail">${esc(r.error ?? "нет ответа")}</span>`;
  const base = `${r.ok}/${r.rounds} · ${r.median_ms} мс`;
  const b = r.bulk;
  if (!b) return `<span class="r ok">${base}</span>`;
  if (!b.stalled) return `<span class="r ok" title="256 КБ через точку за ${(b.ms / 1000).toFixed(1)} с — данные идут">${base} · 256 КБ ✓</span>`;
  const kb = Math.round(b.bytes / 1024);
  const why = b.bytes === 0 ? "данные не идут" : kb <= 64 ? `замерзает после ~${kb} КБ` : `оборвалась на ${kb} КБ`;
  return `<span class="r warn" title="Пинг проходит, а загрузка встаёт — похоже на заморозку ТСПУ. Такая точка ставится в конец.">${base} · ${why}</span>`;
}

export function stepsHtml(cur: number, list: string[]) {
  return `<ol class="steps">${list.map((t, i) =>
    `<li class="${i < cur ? "done" : i === cur ? "cur" : ""}"><span class="n">${i < cur ? "✓" : i + 1}</span><span>${t}</span></li>`).join("")}</ol>`;
}

/** Шаги «с перезапуском и проверкой» — общие для большинства операций. */
export const STEPS_RESTART = [
  "Подтверждение прав администратора",
  "Страховка: автоматический откат, если что-то пойдёт не так",
  "Перезапуск движка — интернет пропадёт на 2–5 с",
  "Проверка туннеля, при неудаче — откат",
];

let running = false;
export const opRunning = () => running;
const listeners: (() => void)[] = [];
export const onOpChange = (f: () => void) => listeners.push(f);

/**
 * Подтверждение → ход по шагам → итог. `call` — сама операция (Rust).
 * Возвращает результат или null, если пользователь отказался.
 */
export async function runEngineOp(o: {
  title: string;
  intro: string;
  confirm: string;
  steps: string[];
  call: () => Promise<ApplyResult>;
  danger?: boolean;
  /** Своё оформление успешного результата (например, глубокой проверки). */
  okBody?: (r: ApplyResult) => string;
}): Promise<ApplyResult | null> {
  if (running) return null;
  const go = await modal(o.title, `${o.intro}${stepsHtml(-1, o.steps)}`, o.confirm, "Отмена");
  if (!go) return null;
  running = true;
  listeners.forEach((f) => f());
  let cur = 0;
  void modal("Выполняю…", stepsHtml(cur, o.steps), null, null);
  const timer = setInterval(() => {
    cur = Math.min(cur + 1, o.steps.length - 1);
    $("modalBody").innerHTML = stepsHtml(cur, o.steps);
  }, 2800);
  let r: ApplyResult;
  try { r = await o.call(); }
  catch (e) { r = { ok: false, outcome: "error", message: String(e), info: null }; }
  clearInterval(timer);
  running = false;
  listeners.forEach((f) => f());
  const title = r.ok ? "Готово" : r.outcome === "cancelled" ? "Отменено" : r.outcome === "rolled_back" ? "Откатил изменения" : "Не получилось";
  const body = r.ok && o.okBody ? o.okBody(r) : `<div class="result ${r.ok ? "ok" : "bad"}">${esc(r.message)}</div>`;
  await modal(title, body, "Понятно", null);
  return r;
}
