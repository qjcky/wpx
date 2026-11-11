// Вкладка «Правила»: что куда идёт. Подборщик (rulepick.ts): поиск по
// приложениям в сети, сайтам из соединений и наборам → плитки «куда» — два
// клика. Правила проверяются сверху вниз, первое совпавшее решает.
// «Применить» — сохранить и перезапустить движок с откатом.

import type { Api } from "../core/api";
import type { Conn, EngineInfo, NetSettings, ProfilesState, RouteRule, UserSet } from "../core/types";
import { $, esc, modal, runEngineOp, STEPS_RESTART } from "../core/ui";
import { ICON } from "../core/icons";
import { bytes, candidates, filter, KIND_ICON, KIND_LABEL, learnedLabel, presetsOf, ruleFor, setItem, targetOf, targets, upsert, widen, type Cand } from "./rulepick";

let api: Api;
let info: EngineInfo | null = null;
let profiles: ProfilesState = { profiles: [], active: null };
let rules: RouteRule[] = [];
let sets: UserSet[] = [];
let hidden: string[] = [];
let mode: NetSettings["mode"] = "strict";
let dirty = false;
/** Отмеченные правила (вид:значение) — сменить им путь разом. */
const chosen = new Set<string>();
const keyOf = (r: RouteRule) => `${r.kind}:${r.value.toLowerCase()}`;
let conns: Conn[] = [];
let picked: Cand | null = null;
let showAllApps = false;
let flash = "";

async function load() {
  try {
    [info, profiles] = await Promise.all([api.engineInfo(), api.profiles()]);
  } catch { return; }
  rules = info.net.rules.map((r) => ({ ...r }));
  sets = (info.net.sets ?? []).map((u) => ({ ...u, items: [...u.items] }));
  hidden = [...(info.net.hidden_presets ?? [])];
  mode = info.net.mode;
  dirty = false;
  render();
  try { conns = (await api.conns()).conns; } catch { conns = []; }
  renderPick();
}

const mainName = () => profiles.profiles.find((p) => p.id === profiles.active)?.name ?? "—";

/** Наборы для подборщика (без скрытых) или все — для названий и состава. */
const presets = (all = false) => presetsOf(info?.presets ?? [], { sets, hidden_presets: hidden }, all);

function what(r: RouteRule) {
  if (r.kind === "preset") return presets(true).find(([id]) => id === r.value)?.[1] ?? r.value;
  if (r.kind === "list") return info?.lists.find(([id]) => id === r.value)?.[1] ?? r.value;
  return r.kind === "app" ? r.value.replace(/\.exe$/i, "") : r.value;
}

const targetName = (x: ReturnType<typeof targets>[number]) =>
  x.cls === "main" ? `Рабочий «${x.sub}»` : x.cls === "exit" ? `Постоянный IP ${x.sub}` : x.cls === "prof" ? `${x.label} (${x.sub})` : x.label;

/** Выбор цели в строке правила — <select> в цветной метке. */
function targetSelect(i: number, cur: string) {
  const ts = targets(profiles, info);
  const t = targetOf(ts, cur);
  return `<label class="rr-to ${t?.cls ?? "prof"}"><select data-i="${i}">${ts.map((x) =>
    `<option value="${esc(x.v)}" ${x.v === cur ? "selected" : ""}>${esc(targetName(x))}</option>`).join("")}</select></label>`;
}

/** Над списком: «все» и путь для отмеченных разом. */
function renderBulk() {
  for (const k of [...chosen]) if (!rules.some((r) => keyOf(r) === k)) chosen.delete(k);
  const box = $("ruBulk");
  box.hidden = rules.length < 2;
  if (box.hidden) return;
  const n = chosen.size;
  const all = n === rules.length;
  box.innerHTML = `<label class="ru-all"><input type="checkbox" id="ruAll" ${all ? "checked" : ""}> все</label>` + (n
    ? `<span>выбрано ${n} →</span><label class="rr-to prof"><select id="ruBulkTo"><option value="" selected disabled>через что пускать…</option>${targets(profiles, info).map((x) =>
        `<option value="${esc(x.v)}">${esc(targetName(x))}</option>`).join("")}</select></label><button type="button" class="link" id="ruNone">снять выбор</button>`
    : `<span class="hint">отметьте правила, чтобы сменить им путь разом</span>`);
}

function render() {
  document.querySelectorAll<HTMLButtonElement>("#ruDefault button").forEach((b) => b.setAttribute("aria-checked", String((b.dataset.v === "strict") === (mode === "strict"))));
  $("ruMainName").textContent = `«${mainName()}»`;
  const toProfile = rules.some((r) => r.target !== "direct" && r.target !== "block");
  $("ruDefaultNote").textContent = mode === "strict"
    ? "Весь остальной трафик ПК идёт через рабочий профиль. Упал профиль — интернета нет: ничего не уходит мимо."
    : !toProfile
    ? "Пока ни одно правило не ведёт в профиль — весь трафик идёт напрямую. Добавляйте сайты и приложения, когда понадобится."
    : "Всё, что не попало в правила, идёт напрямую. Если на роутере kill switch, он прямой трафик не выпустит — тогда выберите «через рабочий профиль».";
  $("ruCount").textContent = rules.length ? `${rules.length}` : "";
  $("ruList").innerHTML = rules.length
    ? rules.map((r, i) => `<li class="rr${flash && `${r.kind}:${r.value}` === flash ? " new" : ""}${chosen.has(keyOf(r)) ? " chosen" : ""}">
        <input type="checkbox" class="rr-pick" data-pick="${i}" ${chosen.has(keyOf(r)) ? "checked" : ""} aria-label="Отметить правило">
        <span class="rr-ico ${r.kind}">${KIND_ICON[r.kind] ?? ICON.layers}</span>
        <span class="rr-what"><b title="${esc(r.value)}">${esc(what(r))}</b><small>${KIND_LABEL[r.kind] ?? r.kind}</small>${follows(r, i)}${insideBtn(r.kind, r.value)}</span>
        <span class="rr-arrow">→</span>
        ${targetSelect(i, r.target)}
        <span class="rr-acts">
          <button type="button" data-ru="up" data-i="${i}" ${i === 0 ? "disabled" : ""} title="Выше — проверяется раньше" aria-label="Выше">↑</button>
          <button type="button" data-ru="down" data-i="${i}" ${i === rules.length - 1 ? "disabled" : ""} title="Ниже" aria-label="Ниже">↓</button>
          <button type="button" class="del" data-ru="del" data-i="${i}" title="Убрать правило" aria-label="Убрать правило">✕</button></span></li>`).join("")
    : `<li class="empty">Правил пока нет — всё идёт по «Всё остальное». Выберите приложение или сайт выше.</li>`;
  renderBulk();
  $("ruSave").toggleAttribute("disabled", !dirty);
  $("ruApply").toggleAttribute("disabled", !dirty);
  $("ruDirty").hidden = !dirty;
}

/** У приложения — «и всё, что она запускает», у сайта, идущего в профиль, —
 *  «и что он подгружает»; рядом найденное (помощники, адреса). */
function follows(r: RouteRule, i: number) {
  const site = r.kind === "site";
  // Только для правил в туннель: «найденное» движок берёт по 127.0.0.1.
  if (!(r.kind === "app" || site) || r.target === "direct" || r.target === "block") return "";
  const found = (r.learned ?? []).filter((x) => !x.startsWith("skip:")).map((x) => `<span class="rr-found ${x.startsWith("site:") ? "site" : "app"}">${esc(learnedLabel(x))}<button type="button" data-forget="${esc(x)}" data-i="${i}" title="Убрать" aria-label="Убрать">✕</button></span>`).join("");
  const [label, title] = site
    ? ["и что он подгружает", "wpx сам найдёт адреса, с которых сайт грузит картинки и видео и которые напрямую не открываются (как cdninstagram.com у Instagram), — и поведёт их тем же путём, на лету"]
    : ["и всё, что она запускает", "wpx сам найдёт, что программа запускает (как Codex у ChatGPT), и сайты её помощников — и поведёт тем же путём, на лету"];
  return `<span class="rr-follow"><label title="${title}"><input type="checkbox" data-follow="${i}" ${r.follow ? "checked" : ""}> ${label}</label>${found}</span>`;
}

// ─── Что внутри набора ───

const insideBtn = (kind: string, id: string) =>
  kind === "preset" || kind === "list" ? `<button type="button" class="link rr-inside" data-inside="${kind}:${esc(id)}">что внутри</button>` : "";

/** Адреса набора и состав его списков (списки — с поиском: их сотни). */
async function inside(kind: string, id: string) {
  const preset = kind === "preset" ? presets(true).find(([p]) => p === id) : undefined;
  const listTitle = (l: string) => info?.lists.find(([x]) => x === l)?.[1] ?? l;
  const lists = kind === "list" ? [id] : preset?.[3] ?? [];
  const domains = preset?.[2] ?? [];
  const body = (domains.length ? `<div class="in-sec"><h3>Адреса — с поддоменами</h3><ol class="in-list">${domains.map((d) => `<li>${esc(d.includes(".") ? d : `.${d === "xn--p1ai" ? "рф" : d} — вся зона`)}</li>`).join("")}</ol></div>` : "")
    + lists.map((l) => `<div class="in-sec" data-list="${esc(l)}"><h3>${esc(listTitle(l))}</h3><p class="hint">загружаю…</p></div>`).join("");
  const done = modal(`Что внутри «${kind === "list" ? listTitle(id) : preset?.[1] ?? id}»`, body || "<p>Набор пуст.</p>", null, "Закрыть");
  const FROM = { engine: "копия движка — он обновляет список раз в сутки", cache: "скачан за последние сутки", fresh: "скачан сейчас" };
  await Promise.all(lists.map(async (l) => {
    const box = document.querySelector<HTMLElement>(`#modalBody [data-list="${CSS.escape(l)}"]`);
    if (!box) return;
    try {
      const r = await api.listItems(l);
      box.innerHTML = `<h3>${esc(listTitle(l))}</h3><p class="note">всего: ${r.items.length} · ${FROM[r.source]} · <span class="mono">${esc(r.url)}</span></p>
        <label class="field in-find"><span>Найти</span><input type="search" placeholder="например, youtube" spellcheck="false" autocomplete="off"></label><ol class="in-list"></ol>`;
      const ol = box.querySelector("ol")!, find = box.querySelector("input")!;
      const show = () => {
        const q = find.value.trim().toLowerCase();
        const hit = q ? r.items.filter((x) => x.toLowerCase().includes(q)) : r.items;
        ol.innerHTML = hit.map((x) => `<li title="${esc(x)}">${esc(x)}</li>`).join("") || "<li>ничего не нашлось</li>";
      };
      find.addEventListener("input", show);
      show();
    } catch (e) {
      box.innerHTML = `<h3>${esc(listTitle(l))}</h3><div class="result bad">${esc(String(e))}</div>`;
    }
  }));
  await done;
}

// ─── Свои наборы и скрытые готовые ───

/** Какой свой набор сейчас правится в окне «Наборы». */
let editing: string | null = null;

function setsHtml() {
  const inRules = (id: string) => rules.some((r) => r.kind === "preset" && r.value === id);
  const own = sets.map((u) => `<li><span><b>${esc(u.name)}</b><small>адресов: ${u.items.length}${inRules(u.id) ? " · в правилах" : ""}</small></span>
    <span class="acts-inline"><button type="button" class="btn sm" data-set-edit="${u.id}">Изменить</button>
      <button type="button" class="btn sm danger" data-set-del="${u.id}" title="Удалить набор" aria-label="Удалить набор">✕</button></span></li>`).join("");
  const cur = sets.find((u) => u.id === editing);
  const built = (info?.presets ?? []).map(([id, name, ds, ls]) => {
    const off = hidden.includes(id);
    return `<li class="${off ? "off" : ""}"><span><b>${esc(name)}</b><small>${off ? "скрыт из подборщика" : [ds?.length ? `адресов: ${ds.length}` : "", ls?.length ? "списки" : ""].filter(Boolean).join(" + ")}</small></span>
      <span class="acts-inline"><button type="button" class="btn sm" data-preset-toggle="${id}">${off ? "Вернуть" : "Скрыть"}</button></span></li>`;
  }).join("");
  return `<p>Свой набор — адреса (с поддоменами) и подсети под одним именем: одно правило на всё сразу. Готовые можно скрыть из подборщика — правила с ними продолжат работать.</p>
    <h3 class="set-h">Свои</h3>
    ${own ? `<ol class="set-list">${own}</ol>` : `<p class="note">Пока нет — добавьте ниже.</p>`}
    <div class="set-form">
      <label class="field"><span>Название</span><input id="setName" maxlength="40" placeholder="Например: Игры, Работа" value="${esc(cur?.name ?? "")}" autocomplete="off"></label>
      <label class="field"><span>Адреса и подсети — по одному на строку, можно вставить ссылки</span>
        <textarea id="setItems" class="mono" rows="5" spellcheck="false" placeholder="example.com&#10;cdn.example.net&#10;203.0.113.0/24">${esc(cur?.items.join("\n") ?? "")}</textarea></label>
      <p class="form-err" id="setErr" hidden></p>
      <div class="acts-inline">${cur ? `<button type="button" class="btn" data-set-cancel>Отмена</button>` : ""}
        <button type="button" class="btn primary" data-set-save>${cur ? "Сохранить набор" : "Добавить набор"}</button></div>
    </div>
    <h3 class="set-h">Готовые</h3>
    <ol class="set-list">${built}</ol>
    <p class="note">Всё это войдёт в силу после «Применить».</p>`;
}

/** Окно «Наборы»: свои — добавить, изменить, удалить; готовые — скрыть или вернуть. */
async function manageSets() {
  editing = null;
  const body = $("modalBody");
  const redraw = () => { body.innerHTML = setsHtml(); };
  const err = (m: string) => { const e = document.getElementById("setErr"); if (e) { e.textContent = m; e.hidden = false; } };
  const onClick = (ev: Event) => {
    const b = (ev.target as HTMLElement).closest<HTMLButtonElement>("button");
    if (!b || !body.contains(b)) return;
    const d = b.dataset;
    if (d.setEdit) { editing = d.setEdit; redraw(); $<HTMLInputElement>("setName").focus(); return; }
    if ("setCancel" in d) { editing = null; redraw(); return; }
    if (d.setDel) {
      const u = sets.find((x) => x.id === d.setDel);
      if (u && rules.some((r) => r.kind === "preset" && r.value === u.id)) { err(`«${u.name}» есть в правилах — сначала уберите правило`); return; }
      sets = sets.filter((x) => x.id !== d.setDel);
      if (editing === d.setDel) editing = null;
      change();
      redraw();
      return;
    }
    if (d.presetToggle) {
      const id = d.presetToggle;
      hidden = hidden.includes(id) ? hidden.filter((x) => x !== id) : [...hidden, id];
      change();
      redraw();
      return;
    }
    if ("setSave" in d) {
      const name = $<HTMLInputElement>("setName").value.trim();
      const lines = $<HTMLTextAreaElement>("setItems").value.split(/[\s,;]+/).filter(Boolean);
      const bad = lines.filter((l) => !setItem(l));
      const items = [...new Set(lines.map(setItem).filter((x): x is string => !!x))];
      if (!name) return err("Дайте набору название");
      if (bad.length) return err(`Не похоже на адрес или подсеть: ${bad.slice(0, 3).join(", ")}`);
      if (!items.length) return err("Добавьте хотя бы один адрес");
      if (sets.some((u) => u.name === name && u.id !== editing)) return err(`Набор «${name}» уже есть`);
      sets = editing ? sets.map((u) => (u.id === editing ? { ...u, name, items } : u)) : [...sets, { id: `u${Date.now().toString(36)}`, name, items }];
      editing = null;
      change();
      redraw();
    }
  };
  body.addEventListener("click", onClick);
  await modal("Наборы", setsHtml(), null, "Готово");
  body.removeEventListener("click", onClick);
  renderPick();
}

// ─── Подборщик: что → куда ───

function chip(c: Cand) {
  const r = ruleFor(rules, c);
  const t = r && targetOf(targets(profiles, info), r.target);
  const meta = c.fresh ? (c.kind === "app" ? "новое приложение" : "новый сайт") : t ? `→ ${t.cls === "main" ? "рабочий" : t.label}` : c.bytes ? bytes(c.bytes) : "";
  return `<button type="button" class="rp-chip ${c.kind}${c.sys ? " sys" : ""}${r ? " has" : ""}" data-k="${c.kind}" data-v="${esc(c.value)}" title="${esc(c.value)}">
    ${KIND_ICON[c.kind]}<span>${esc(c.label)}</span>${meta ? `<small>${esc(meta)}</small>` : ""}</button>`;
}

function renderPick() {
  const q = $<HTMLInputElement>("ruQuery").value;
  const box = $("ruPickWhat");
  $("ruPickTo").hidden = !picked;
  box.hidden = !!picked;
  if (picked) { renderTargets(); return; }
  const all = candidates(conns, presets(), rules);
  if (q.trim()) {
    const list = filter(all, q).slice(0, 14);
    box.innerHTML = list.length ? `<div class="rp-group"><div class="rp-chips">${list.map(chip).join("")}</div></div>`
      : `<p class="rp-empty">Ничего не нашлось. Введите имя программы (telegram.exe) или адрес сайта (chatgpt.com).</p>`;
    return;
  }
  const apps = all.filter((c) => c.kind === "app"), sites = all.filter((c) => c.kind === "site").slice(0, 10), sets = all.filter((c) => c.kind === "preset");
  const user = apps.filter((c) => !c.sys), sys = apps.filter((c) => c.sys);
  const shownApps = showAllApps ? [...user, ...sys] : user.slice(0, 10);
  const more = apps.length - shownApps.length;
  const group = (title: string, items: Cand[], extra = "") => items.length
    ? `<div class="rp-group"><div class="rp-label">${title}</div><div class="rp-chips">${items.map(chip).join("")}${extra}</div></div>` : "";
  box.innerHTML = group("Приложения в сети", shownApps, more > 0 ? `<button type="button" class="rp-more" id="ruMoreApps">ещё ${more}${sys.length && !showAllApps ? " · системные" : ""}</button>` : "")
    + group("Сайты из текущих соединений", sites)
    + `<div class="rp-group"><div class="rp-label">Наборы</div><div class="rp-chips">${sets.map(chip).join("")}<button type="button" class="rp-more" id="ruSets">+ свой набор · скрыть готовые</button></div></div>`;
}

function renderTargets() {
  if (!picked) return;
  const cur = ruleFor(rules, picked)?.target;
  $("ruPickName").innerHTML = `<span class="rr-ico ${picked.kind}">${KIND_ICON[picked.kind]}</span><b>${esc(picked.label)}</b><small>${KIND_LABEL[picked.kind]}${picked.kind !== "preset" && picked.label !== picked.value ? ` · ${esc(picked.value)}` : ""}</small><span class="rp-q">— куда пустить?</span>${insideBtn(picked.kind, picked.value)}`;
  $("ruTargets").innerHTML = targets(profiles, info).map((t) => `<button type="button" class="rp-t ${t.cls}${t.v === cur ? " cur" : ""}" data-t="${esc(t.v)}">
      <b>${esc(t.label)}</b><small>${esc(t.sub)}</small></button>`).join("")
    + (cur ? `<button type="button" class="rp-t none" data-t=""><b>Убрать правило</b><small>как всё остальное</small></button>` : "");
}

function pick(c: Cand | null) {
  picked = c;
  renderPick();
  if (c) $("ruTargets").querySelector<HTMLButtonElement>(".rp-t")?.focus();
}

function choose(target: string) {
  if (!picked) return;
  // Убирают правило — то, что выбрали; добавляют сайт из набора — весь набор.
  const w = target ? widen(presets(), picked.kind, picked.value) : { kind: picked.kind, value: picked.value, note: "" };
  rules = upsert(rules, w.kind, w.value, target);
  flash = target ? `${w.kind}:${w.value}` : "";
  picked = null;
  $<HTMLInputElement>("ruQuery").value = "";
  change();
  if (w.note) { $("ruNote").textContent = w.note; $("ruNote").hidden = false; }
  renderPick();
  window.setTimeout(() => { flash = ""; document.querySelector("#ruList .rr.new")?.classList.remove("new"); }, 1600);
}

function change() {
  dirty = true;
  $("ruErr").hidden = true;
  $("ruNote").hidden = true;
  $("ruCheckRes").textContent = "";
  render();
}

function netOf(fresh: NetSettings): NetSettings {
  // Найденное на лету (follow.rs) — не затирать, пока вкладка была открыта.
  const learned = (r: RouteRule) => fresh.rules.find((x) => x.kind === r.kind && x.value.toLowerCase() === r.value.toLowerCase())?.learned ?? [];
  return { ...fresh, mode, sets, hidden_presets: hidden, rules: rules.map((r) => (r.kind === "app" || r.kind === "site" ? { ...r, learned: [...new Set([...(r.learned ?? []), ...learned(r)])] } : r)) };
}

async function check() {
  $("ruErr").hidden = true;
  $("ruCheckRes").textContent = "проверяю…";
  try {
    const fresh = (await api.engineInfo()).net;
    const res = `✓ ${await api.netCheck(netOf(fresh))}`;
    $("ruCheckRes").textContent = res;
    $("ruCheckRes").title = res;
  } catch (e) {
    $("ruCheckRes").textContent = "";
    $("ruErr").textContent = String(e);
    $("ruErr").hidden = false;
  }
}

async function save(apply: boolean) {
  $("ruErr").hidden = true;
  // Свежие настройки движка — правила не затирают то, что поменяли на «Движке».
  const store = async () => {
    const fresh = (await api.engineInfo()).net;
    await api.netSave(netOf(fresh));
    dirty = false;
    render();
  };
  if (!apply) {
    try { await store(); }
    catch (e) { $("ruErr").textContent = String(e); $("ruErr").hidden = false; return; }
    await modal("Правила сохранены", `<div class="result ok">Движок возьмёт их при следующем перезапуске. Применить сразу — кнопка «Применить».</div>`, "Понятно", null);
    return;
  }
  // Сохраняем только после подтверждения: отказ ничего не меняет.
  await runEngineOp({
    title: "Применить правила",
    intro: "<p>Движок перезапустится с новыми правилами. Если туннель не поднимется — всё вернётся как было.</p>",
    confirm: "Применить",
    steps: STEPS_RESTART,
    call: async () => { await store(); return api.engineApplyNet(); },
  });
}

export function initRules(a: Api) {
  api = a;
  document.querySelectorAll<HTMLButtonElement>("#ruDefault button").forEach((b) => b.addEventListener("click", () => {
    mode = b.dataset.v === "strict" ? "strict" : "apps";
    change();
  }));
  const q = $<HTMLInputElement>("ruQuery");
  q.addEventListener("input", () => { picked = null; renderPick(); });
  q.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const first = $("ruPickWhat").querySelector<HTMLButtonElement>(".rp-chip");
      first?.click();
    }
    if (e.key === "Escape") { q.value = ""; pick(null); }
  });
  $("ruPickWhat").addEventListener("click", (e) => {
    const el = e.target as HTMLElement;
    if (el.closest("#ruMoreApps")) { showAllApps = true; renderPick(); return; }
    if (el.closest("#ruSets")) { void manageSets(); return; }
    const b = el.closest<HTMLButtonElement>(".rp-chip");
    if (!b) return;
    const all = filter(candidates(conns, presets(), rules), q.value);
    pick(all.find((c) => c.kind === b.dataset.k && c.value === b.dataset.v) ?? null);
  });
  $("ruPickBack").addEventListener("click", () => pick(null));
  $("ruTargets").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>(".rp-t");
    if (b) choose(b.dataset.t ?? "");
  });
  $("ruTargets").addEventListener("keydown", (e) => { if (e.key === "Escape") pick(null); });
  $("ruList").addEventListener("change", (e) => {
    const s = (e.target as HTMLElement).closest<HTMLSelectElement>("select[data-i]");
    if (s) { rules[Number(s.dataset.i)].target = s.value; change(); }
  });
  $("ruList").addEventListener("change", (e) => {
    const c = (e.target as HTMLElement).closest<HTMLInputElement>("input[data-follow]");
    if (c) { rules[Number(c.dataset.follow)].follow = c.checked; change(); }
    const p = (e.target as HTMLElement).closest<HTMLInputElement>("input[data-pick]");
    if (p) {
      const k = keyOf(rules[Number(p.dataset.pick)]);
      if (p.checked) chosen.add(k); else chosen.delete(k);
      render();
    }
  });
  $("ruBulk").addEventListener("change", (e) => {
    const el = e.target as HTMLElement;
    if (el.id === "ruAll") {
      chosen.clear();
      if ((el as HTMLInputElement).checked) rules.forEach((r) => chosen.add(keyOf(r)));
      render();
    }
    if (el.id === "ruBulkTo") {
      const to = (el as HTMLSelectElement).value;
      rules.forEach((r) => { if (chosen.has(keyOf(r))) r.target = to; });
      chosen.clear();
      change();
    }
  });
  $("ruBulk").addEventListener("click", (e) => {
    if ((e.target as HTMLElement).id === "ruNone") { chosen.clear(); render(); }
  });
  $("ruList").addEventListener("click", (e) => {
    // Найденное убирается сразу — и из движка (без «Применить»).
    const f = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-forget]");
    if (f) {
      const r = rules[Number(f.dataset.i)];
      const item = f.dataset.forget!;
      r.learned = (r.learned ?? []).filter((x) => x !== item);
      render();
      void api.followForget(r.value, item).catch(() => {});
      return;
    }
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-ru]");
    if (!b) return;
    const i = Number(b.dataset.i);
    if (b.dataset.ru === "up" && i > 0) [rules[i - 1], rules[i]] = [rules[i], rules[i - 1]];
    if (b.dataset.ru === "down" && i < rules.length - 1) [rules[i + 1], rules[i]] = [rules[i], rules[i + 1]];
    if (b.dataset.ru === "del") rules.splice(i, 1);
    change();
    renderPick();
  });
  $("pageRules").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-inside]");
    if (!b) return;
    e.stopPropagation();
    const [kind, ...id] = (b.dataset.inside ?? "").split(":");
    void inside(kind, id.join(":"));
  });
  $("ruCheck").addEventListener("click", () => void check());
  $("ruSave").addEventListener("click", () => void save(false));
  $("ruApply").addEventListener("click", () => void save(true));
  // Нашлось на лету (follow.rs) — сразу в строке правила.
  if ("__TAURI_INTERNALS__" in window) {
    void import("@tauri-apps/api/event").then(({ listen }) => listen<{ kind: string; app: string; item: string }>("follow-learned", (e) => {
      const r = rules.find((x) => x.kind === e.payload.kind && x.value.toLowerCase() === e.payload.app.toLowerCase());
      if (r && !(r.learned ?? []).includes(e.payload.item)) { r.learned = [...(r.learned ?? []), e.payload.item]; render(); }
    }));
  }
  // Из «Трафика»: «→ правило» у приложения или сайта — сразу к выбору «куда».
  window.addEventListener("wpx:rule", (e) => {
    const d = (e as CustomEvent<{ kind: "app" | "site"; value: string }>).detail;
    document.querySelector<HTMLButtonElement>('[data-page="rules"]')?.click();
    const c: Cand = { kind: d.kind, value: d.value, label: d.kind === "app" ? d.value.replace(/\.exe$/i, "") : d.value, bytes: 0 };
    // Несохранённые правки не затираем — сразу к выбору «куда».
    if (dirty) pick(c);
    else void load().then(() => pick(c));
  });
}

export function onRulesShown() {
  if (!dirty) void load();
}
