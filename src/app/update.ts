// Обновление wpx: проверка (кнопкой в настройках и раз в сутки при запуске
// окна), заметка «Доступна версия …» в шапке и установка с перезапуском.
// Сами проверка, загрузка и установка — в Rust (update_check, update_install).

import type { Api } from "../core/api";
import type { UpdateInfo } from "../core/types";
import { $, esc, modal } from "../core/ui";

const AUTO = "wpx.update.auto";
const LAST = "wpx.update.last";
const DAY = 86_400_000;

/** Проверять ли самому (по умолчанию — да). */
export function updateAuto(): boolean {
  try { return localStorage.getItem(AUTO) !== "0"; } catch { return true; }
}
export function setUpdateAuto(on: boolean) {
  try { localStorage.setItem(AUTO, on ? "1" : "0"); } catch { /* приватный режим — только на сеанс */ }
}

/** Последняя версия уже стоит — следующая проверка через сутки. Нашлась
 *  новая — время не запоминаем: заметка в шапке будет и при следующем запуске. */
function upToDate() {
  try { localStorage.setItem(LAST, String(Date.now())); } catch { /* проверим в другой раз */ }
}

const errText = (e: unknown) => String(e).replace(/^Error:\s*/, "");

/** Дата выпуска («01.11.2026»), если её можно разобрать. */
function day(date: string | null) {
  const d = date ? new Date(date) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString("ru-RU") : "";
}

/** Заметка в шапке окна: по клику — что нового и «Обновить». */
function showChip(api: Api, u: UpdateInfo) {
  const chip = $<HTMLButtonElement>("updChip");
  chip.textContent = `Доступна версия ${u.version}`;
  chip.hidden = false;
  chip.onclick = () => void offer(api, u);
}

async function offer(api: Api, u: UpdateInfo) {
  const when = day(u.date);
  const body = `<p class="mono">wpx ${esc(u.current)} → ${esc(u.version)}</p>
    ${when ? `<p class="note">Выпущена ${esc(when)}</p>` : ""}
    ${u.notes ? `<div class="upd-notes">${esc(u.notes)}</div>` : `<p class="note">Описания изменений нет.</p>`}
    <p class="note">wpx скачает и установит обновление, затем перезапустится. Профили и настройки останутся.</p>`;
  if (!(await modal(`Доступна версия ${u.version}`, body, "Обновить и перезапустить", "Позже"))) return;
  void modal("Обновление", `<p>Устанавливаю обновление…</p>`, null, null);
  try {
    await api.updateInstall();
    await modal("Обновление", `<div class="result ok">Обновление установлено — wpx перезапускается</div>`, "Понятно", null);
  } catch (e) {
    await modal("Не получилось", `<div class="result bad">${esc(errText(e))}</div>`, "Понятно", null);
  }
}

/** Строка «Обновления» в настройках: «Проверить» и итог тут же. */
export function wireUpdateRow(api: Api) {
  const btn = $<HTMLButtonElement>("pUpd");
  const res = $("pUpdRes");
  // Окно настроек могли закрыть, пока шёл ответ, — пишем в свой узел, без поиска по id.
  const show = (html: string) => { res.innerHTML = html; res.hidden = false; };
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    show(`<span class="hint">Проверяю…</span>`);
    try {
      const u = await api.updateCheck();
      if (!u) { upToDate(); show(`<span class="ok">У вас последняя версия</span>`); }
      else {
        showChip(api, u);
        show(`<span>Доступна версия ${esc(u.version)}</span><button type="button" class="btn sm primary">Обновить и перезапустить</button>`);
        res.querySelector("button")!.addEventListener("click", async () => {
          show(`<span class="hint">Устанавливаю обновление…</span>`);
          try {
            await api.updateInstall();
            show(`<span class="ok">Обновление установлено — wpx перезапускается</span>`);
          } catch (e) { show(`<span class="bad">${esc(errText(e))}</span>`); }
        });
      }
    } catch (e) {
      show(`<span class="bad">${esc(errText(e))}</span>`);
    }
    btn.disabled = false;
  });
}

/** Запуск окна: раз в сутки тихо проверить и, если есть новая, показать заметку в шапке. */
export async function autoCheckUpdate(api: Api) {
  if (!updateAuto()) return;
  let last = 0;
  try { last = Number(localStorage.getItem(LAST)) || 0; } catch { /* нет хранилища — проверим */ }
  if (Date.now() - last < DAY) return;
  try {
    const u = await api.updateCheck();
    if (u) showChip(api, u); else upToDate();
  } catch { /* нет сети или лабораторная сборка — в другой раз */ }
}
