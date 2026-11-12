// Вкладки «Профили» и «Движок».

import type { Api } from "../core/api";
import type { PointHistory, ApplyResult, EngineInfo, NetSettings, ParsedItem, ProbeResult, ProfileInput, MemberProbe, ProfileView, ProfilesState, RouterCheck, RouterRule, Snapshot, TrialStatus } from "../core/types";
import { $, esc, modal, onOpChange, opRunning, probeBadge, runEngineOp, STEPS_RESTART } from "../core/ui";
import { chooseOwnServer } from "./servers";
import { TYPE_ICON } from "../core/icons";

let api: Api;
let snap: Snapshot | null = null;
let profiles: ProfilesState = { profiles: [], active: null };
let editing: ProfileView | null = null;
let primary: "http" | "socks5" = "http";
let info: EngineInfo | null = null;

const two = (n: number) => String(n).padStart(2, "0");
const hhmm = (t: number) => { const d = new Date(t); return `${two(d.getHours())}:${two(d.getMinutes())}`; };

// ─── Общие операции ──────────────────────────────────────────────

const STEPS_INSTALL = [
  "Проверка сервера напрямую и сборка конфига (mihomo -t)",
  "Подтверждение прав администратора",
  "Установка движка: mihomo, задача wpx-engine, правила kill switch",
  "Запуск туннеля — интернет может пропасть на 2–5 с",
  "Проверка туннеля, при неудаче — установка отменится сама",
];
const STEPS_SWITCH = ["Проверка сервера напрямую и сборка конфига (mihomo -t)", ...STEPS_RESTART];

async function activate(p: ProfileView) {
  const fresh = snap?.engine_kind !== "wpx";
  const where = esc(p.cascade ? `${p.cascade.entry_name} → ${p.cascade.exit_name}` : p.server);
  const intro = fresh
    ? `<p>wpx установит свой движок (mihomo) и поднимет туннель с профилем <b>${esc(p.name)}</b> (${where}). Дальше при включении ПК туннель будет подниматься сам — ещё до входа в систему.</p>
       <p>Если туннель не поднимется, установка отменится сама.</p>`
    : `<p>Весь ПК начнёт выходить через <b>${esc(p.name)}</b> (${where}). Если туннель не поднимется — вернётся прежний профиль.</p>`;
  const r = await runEngineOp({
    title: fresh ? "Установить движок wpx" : `Переключиться на «${p.name}»`,
    intro,
    confirm: fresh ? "Установить" : "Переключить",
    steps: fresh ? STEPS_INSTALL : STEPS_SWITCH,
    call: () => api.profileActivate(p.id),
  });
  if (r) await loadProfiles();
  if (r?.ok) void loadEngine();
}

/** Снять с работы: движок останавливается, рабочего профиля нет — его, сервер и каскад можно удалить. */
async function deactivate(p: ProfileView) {
  const r = await runEngineOp({
    title: `Снять «${p.name}» с работы`,
    intro: (info?.net.kill_switch
      ? "<p>Движок остановится. <b>Интернета на этом ПК не будет</b> до выбора другого рабочего профиля — kill switch не пускает трафик мимо туннеля.</p>"
      : "<p>Движок остановится, интернет пойдёт напрямую, без VPN, пока не сделаете рабочим другой профиль.</p>")
      + "<p>После этого профиль, его сервер и каскад можно удалить.</p>",
    confirm: "Снять с работы", steps: ["Подтверждение прав администратора", "Остановка движка"],
    call: () => api.profileDeactivate(), danger: true,
  });
  if (r) await loadProfiles();
  if (r?.ok) void loadEngine();
}

// ─── Профили ─────────────────────────────────────────────────────

async function loadProfiles() {
  try { profiles = await api.profiles(); } catch { /* окно покажет пустой список */ }
  renderProfiles();
}

/**
 * Строка точки на карточке: протокол и особенности → адрес:порт, без повторов.
 * Для путей каскада впереди — через какой сервер («Сингапур → Хельсинки»).
 */
function epLine(e: ProfileView["endpoints"][number], i: number) {
  const bits = e.summary.split(" · ");
  const addr = bits.pop() ?? "";
  const udp = e.kind === "hysteria2" || e.kind === "awg" ? "/udp" : "";
  const path = e.label.includes(" → ") ? e.label.split(" · ")[0] : "";
  return `<span title="${esc(e.label)}"><b>${i + 1}.</b> ${path ? `<i>${esc(path)}:</i> ` : ""}${esc(bits.join(" · "))} <em>${esc(addr)}${udp}</em></span>`;
}

function renderProfiles() {
  const box = $("profileCards");
  if (!profiles.profiles.length) {
    box.innerHTML = `<div class="pcard empty"><div class="nm">Профилей пока нет</div><div class="srv">Добавьте подключение кнопкой «Добавить профиль»: по ссылке, свой сервер или прокси</div></div>`;
    return;
  }
  box.innerHTML = profiles.profiles.map((p) => {
    const tag = (label: string, port: number | null, main: boolean) =>
      port ? `<span class="tag${main ? " main" : ""}">${label} :${port}${main ? " · основной" : ""}</span>` : "";
    const vpn = p.endpoints.length > 0;
    const c = p.cascade;
    const rt = p.route.length > 0;
    const body = rt
      ? `<div class="ep-list">${p.route.map((m, i) => `<span><b>${i + 1}.</b> <em>${esc(m.name)}</em></span>`).join("")}</div>
         <div class="tags"><span class="tag main">${p.mode === "fallback" ? "по порядку" : "самый быстрый путь"}</span></div>`
      : c
      ? `<div class="srv ca-route">ПК → <b>${esc(c.entry_name)}</b> → <b>${esc(c.exit_name)}</b> → интернет</div>`
      : vpn
      ? `<div class="tags">${[...new Set(p.endpoints.map((e) => e.summary.split(" · ")[0]))].map((k) => `<span class="tag">${esc(k)}</span>`).join("")}
           <span class="tag main">${MODE_TAG[p.mode] ?? "по порядку"}</span></div>
         <div class="ep-list" hidden>${p.endpoints.map((e, i) => epLine(e, i)).join("")}</div>`
      : `<div class="srv">${esc(p.server)}${p.username ? ` · ${esc(p.username)}` : ""}${p.has_password ? " · ••••" : ""}</div>
         <div class="tags">${tag(p.https ? "HTTPS" : "HTTP", p.http_port, p.primary === "http")}${tag("SOCKS5", p.socks_port, p.primary === "socks5")}${p.fallback ? '<span class="tag">резерв вкл</span>' : ""}</div>`;
    const kind = rt ? "маршрут" : c ? "каскад" : vpn ? "VPN" : "прокси";
    const icon = TYPE_ICON[rt ? "route" : c ? "cascade" : vpn ? "vpn" : "proxy"];
    const from = p.origin.startsWith("pipe:") || p.origin.startsWith("route:") ? "каскад своих серверов" : p.origin.startsWith("server:") ? "свой сервер" : "";
    return `<div class="pcard${p.active ? " active" : ""}">
      <span class="ptype" title="${kind}">${icon}</span>
      <div class="pmain">
      <div class="top"><span class="nm">${esc(p.name)}</span>${p.active ? '<span class="badge">в работе</span>' : ""}</div>
      <div class="kind-row"><span class="kind">${kind}</span>${from ? `<span class="kind from" title="Создан на вкладке «Серверы»">${from}</span>` : ""}</div>
      ${body}
      </div>
      <div class="acts">
        ${p.active ? "" : `<button class="btn primary" data-act="use" data-id="${p.id}">Сделать рабочим</button>`}
        <button class="btn" data-act="try" data-id="${p.id}" title="Пробный запуск без TUN: система не меняется">Попробовать</button>
        <span class="acts-x"><button type="button" class="btn icon acts-more" aria-expanded="false" title="Ещё действия" aria-label="Ещё действия">⋯</button><span class="acts-pop" hidden>
        ${c ? `<button class="btn" data-act="cedit" data-id="${p.id}">Изменить</button>
               <button class="btn" data-act="swap" data-id="${p.id}" title="Поменять вход и выход местами">⇄ Поменять</button>` : ""}
        ${vpn ? `<button class="btn" data-act="vedit" data-id="${p.id}">Изменить</button>` : ""}
        ${rt ? `<button class="btn" data-act="redit" data-id="${p.id}">Изменить</button>` : ""}
        ${vpn || c || rt ? "" : `<button class="btn" data-act="edit" data-id="${p.id}">Изменить</button>`}
        ${p.active
          ? `<button class="btn" data-act="off" data-id="${p.id}" title="Остановить движок и оставить ПК без рабочего профиля — когда ни один профиль не отвечает">Снять с работы</button>`
          : `<button class="btn danger" data-act="del" data-id="${p.id}">Удалить</button>`}</span></span>
      </div>
    </div>`;
  }).join("");
}

/** HTTPS: подписи порта и основного выхода, поля сертификата. */
function syncHttps() {
  const on = $<HTMLInputElement>("peHttps").checked;
  $("peHttpLbl").textContent = on ? "Порт HTTPS" : "Порт HTTP";
  $("pePrimHttp").textContent = on ? "HTTPS" : "HTTP";
  $("peTlsRow").hidden = !on;
}

function setPrimary(v: "http" | "socks5") {
  primary = v;
  document.querySelectorAll<HTMLButtonElement>("#pePrimary button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === v)));
}

function openEditor(p: ProfileView | null) {
  editing = p;
  hidePanels();
  $("profileEditor").hidden = false;
  $("peTitle").textContent = p ? `Прокси «${p.name}»` : "Новый HTTP(S)/SOCKS5-прокси";
  $<HTMLInputElement>("peHttps").checked = p?.https ?? false;
  $<HTMLInputElement>("peSni").value = p?.tls_sni ?? "";
  $<HTMLInputElement>("peInsecure").checked = p?.tls_insecure ?? false;
  syncHttps();
  $<HTMLInputElement>("peName").value = p?.name ?? "";
  $<HTMLInputElement>("peServer").value = p?.server ?? "";
  $<HTMLInputElement>("peHttp").value = p?.http_port ? String(p.http_port) : "";
  $<HTMLInputElement>("peSocks").value = p?.socks_port ? String(p.socks_port) : "";
  $<HTMLInputElement>("peUser").value = p?.username ?? "";
  const pass = $<HTMLInputElement>("pePass");
  pass.value = "";
  pass.type = "password";
  pass.placeholder = p?.has_password ? "•••• сохранён" : "";
  pass.title = p?.has_password ? "Оставьте пустым, чтобы не менять" : "";
  $<HTMLInputElement>("peFallback").checked = p?.fallback ?? true;
  setPrimary(p?.primary ?? "http");
  $("peTest").innerHTML = "";
  $("peErr").hidden = true;
  $<HTMLInputElement>("peName").focus();
}

function formInput(): ProfileInput {
  const num = (id: string) => { const v = Number($<HTMLInputElement>(id).value); return v > 0 && v < 65536 ? v : null; };
  const pw = $<HTMLInputElement>("pePass").value;
  return {
    id: editing?.id ?? null,
    name: $<HTMLInputElement>("peName").value.trim(),
    server: $<HTMLInputElement>("peServer").value.trim(),
    http_port: num("peHttp"),
    socks_port: num("peSocks"),
    username: $<HTMLInputElement>("peUser").value.trim(),
    password: pw ? pw : editing ? null : "",
    primary,
    fallback: $<HTMLInputElement>("peFallback").checked,
    https: $<HTMLInputElement>("peHttps").checked,
    tls_sni: $<HTMLInputElement>("peSni").value.trim(),
    tls_insecure: $<HTMLInputElement>("peInsecure").checked,
  };
}

function formError(e: unknown) {
  const el = $("peErr");
  el.textContent = String(e);
  el.hidden = false;
}

async function testForm() {
  $("peErr").hidden = true;
  $("peTest").innerHTML = `<span>проверяю…</span>`;
  try {
    const t = await api.profileTest(formInput());
    const line = (label: string, r: typeof t.http) => !r ? "" :
      r.ok ? `<span class="ok">✓ ${label}: готов за ${r.ready_ms} мс (TCP ${r.connect_ms} мс)</span>`
           : `<span class="bad">✗ ${label}: ${esc(r.err ?? "ошибка")}</span>`;
    $("peTest").innerHTML = line($<HTMLInputElement>("peHttps").checked ? "HTTPS" : "HTTP", t.http) + line("SOCKS5", t.socks);
  } catch (e) {
    $("peTest").innerHTML = "";
    formError(e);
  }
}

async function saveForm(ev: Event) {
  ev.preventDefault();
  $("peErr").hidden = true;
  try {
    profiles = await api.profileSave(formInput());
    $("profileEditor").hidden = true;
    $<HTMLInputElement>("pePass").value = "";
    editing = null;
    renderProfiles();
  } catch (e) {
    formError(e);
  }
}

// ─── Импорт ссылок ───────────────────────────────────────────────

let imParsed: ParsedItem[] = [];
let imProbe: ProbeResult[] | null = null;
let imTimer: number | undefined;
/** Номера запросов: ответ на устаревший (текст поменяли, запустили новый) — не нужен. */
let imParseSeq = 0, imProbeSeq = 0;

function openImporter() {
  hidePanels();
  $("cascader").hidden = true;
  $("importer").hidden = false;
  $<HTMLTextAreaElement>("imText").value = "";
  $<HTMLInputElement>("imName").value = "";
  imParsed = [];
  imProbe = null;
  imParseSeq++;
  imProbeSeq++;
  $("imProbe").textContent = "Подобрать";
  renderImport();
  $<HTMLTextAreaElement>("imText").focus();
}

/** Порядок сохранения: после проверки — по рангу (рабочие сверху), иначе как вставлено. */
function imOrder(): number[] {
  const okIdx = imParsed.map((p, i) => [p, i] as const).filter(([p]) => p.ok).map(([, i]) => i);
  // Индексы в результатах проверки — по списку распознанных (только ok).
  if (!imProbe) return okIdx.map((_, j) => j);
  const ranked = [...imProbe].sort((a, b) => (b.ok - a.ok) || ((a.median_ms ?? 1e9) - (b.median_ms ?? 1e9)));
  return ranked.map((r) => r.index);
}

function renderImport() {
  const ok = imParsed.filter((p) => p.ok);
  const order = imOrder();
  const probeByIdx = new Map((imProbe ?? []).map((r) => [r.index, r]));
  let j = -1;
  $("imList").innerHTML = imParsed.map((p) => {
    if (!p.ok) return `<li class="bad"><span class="n">✗</span><span class="s"><b>${esc(p.error ?? "не распознано")}</b></span><span></span></li>`;
    j += 1;
    const r = probeByIdx.get(j);
    const place = imProbe ? order.indexOf(j) : -1;
    const res = !r ? (p.udp ? "UDP ✓" : "")
      : r.ok ? `<span class="r ok">${r.ok}/${r.rounds} · ${r.median_ms} мс</span>`
      : `<span class="r fail">${esc(r.error ?? "нет ответа")}</span>`;
    return `<li class="${place === 0 && r?.ok ? "best" : ""}"><span class="n">${imProbe && r?.ok ? `#${place + 1}` : j + 1}</span>
      <span class="s"><b>${esc(p.label)}</b><small>${esc(p.summary)}</small></span><span class="r">${res}</span></li>`;
  }).join("");
  $<HTMLButtonElement>("imProbe").disabled = ok.length === 0;
  $<HTMLButtonElement>("imSave").disabled = ok.length === 0;
  if (ok.length && !$<HTMLInputElement>("imName").value) $<HTMLInputElement>("imName").value = ok[0].label.slice(0, 40);
}

async function parseImport() {
  const text = $<HTMLTextAreaElement>("imText").value;
  const seq = ++imParseSeq;
  // Текст другой — идущая проверка уже не о нём.
  imProbeSeq++;
  imProbe = null;
  $("imProbe").textContent = "Подобрать";
  $("imErr").hidden = true;
  let parsed: ParsedItem[] = [];
  let err = "";
  try { parsed = text.trim() ? await api.linksParse(text) : []; } catch (e) { err = String(e); }
  if (seq !== imParseSeq) return;
  imParsed = parsed;
  if (err) { $("imErr").textContent = err; $("imErr").hidden = false; }
  renderImport();
}

async function probeImport() {
  const b = $<HTMLButtonElement>("imProbe");
  const seq = ++imProbeSeq;
  b.disabled = true;
  b.textContent = "Проверяю…";
  $("imErr").hidden = true;
  let res: ProbeResult[] | null = null;
  let err = "";
  try { res = await api.linksProbe($<HTMLTextAreaElement>("imText").value, $<HTMLInputElement>("imDirect").checked); }
  catch (e) { err = String(e); }
  if (seq !== imProbeSeq) return;
  if (res) imProbe = res;
  if (err) { $("imErr").textContent = err; $("imErr").hidden = false; }
  b.textContent = "Подобрать";
  renderImport();
}

// ─── VPN-профиль ─────────────────────────────────────────────────

let veProfile: ProfileView | null = null;
/** Текущий порядок: индексы точек сохранённого профиля. */
let veOrder: number[] = [];
let veProbeRes: ProbeResult[] | null = null;
let veHist: PointHistory[] = [];
/** Номер проверки: открыли другой профиль — ответ на прежнюю не нужен. */
let veSeq = 0;
const MODE_TAG: Record<string, string> = { auto: "самая быстрая", smart: "умная — по истории" };

/** «обычно сейчас ~420 мс · 99% · лучше всего около 4 ч». */
function histLine(h: PointHistory | undefined) {
  const s = h?.score;
  if (!s) return "";
  const bits = [`${s.by_hour ? "обычно в это время" : "обычно"} ~${s.ms ?? "—"} мс · ${Math.round(s.rate * 100)}% проверок`];
  if (s.stall_rate > 0.05) bits.push(`замерзает в ${Math.round(s.stall_rate * 100)}%`);
  if (h?.best_hour !== null && h?.best_hour !== undefined) bits.push(`лучше всего около ${h.best_hour} ч`);
  return `<small class="hist">${esc(bits.join(" · "))}</small>`;
}
let veTimer: number | undefined;

function hidePanels() {
  for (const id of ["addChooser", "importer", "cascader", "profileEditor", "vpnEditor", "routeEditor"]) $(id).hidden = true;
  $<HTMLInputElement>("pePass").value = "";
}

function openVpnEditor(p: ProfileView) {
  hidePanels();
  veProfile = p;
  veOrder = p.endpoints.map((_, i) => i);
  veProbeRes = null;
  veSeq++;
  $("veProbe").textContent = "Проверить";
  $<HTMLButtonElement>("veProbe").disabled = false;
  $("vpnEditor").hidden = false;
  $("veTitle").textContent = `VPN-профиль «${p.name}»`;
  $("veHint").textContent = p.origin ? "создан на вкладке «Серверы»: «Изменить VPN» там пересоберёт точки" : "";
  $<HTMLInputElement>("veName").value = p.name;
  $<HTMLSelectElement>("veMode").value = p.mode === "auto" || p.mode === "smart" ? p.mode : "fallback";
  veHist = [];
  void api.profileHistory(p.id).then((h) => { if (veProfile?.id === p.id) { veHist = h; renderVe(); } }).catch(() => {});
  $<HTMLTextAreaElement>("veAdd").value = "";
  $("veAddInfo").textContent = "";
  $("veErr").hidden = true;
  renderVe();
  $("vpnEditor").scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function renderVe() {
  const p = veProfile!;
  const res = new Map((veProbeRes ?? []).map((r) => [r.index, r]));
  $("veList").innerHTML = veOrder.map((i, pos) => {
    const e = p.endpoints[i];
    const r = res.get(i);
    const st = !r ? "" : probeBadge(r);
    return `<li><span class="n">${pos + 1}</span>
      <span class="s"><b>${esc(e.label)}</b><small>${esc(e.summary)}</small>${histLine(veHist[i])}</span>
      <span class="ve-acts">${st}
        <button type="button" class="btn sm" data-ve="up" data-pos="${pos}" ${pos === 0 ? "disabled" : ""} title="Выше">↑</button>
        <button type="button" class="btn sm" data-ve="down" data-pos="${pos}" ${pos === veOrder.length - 1 ? "disabled" : ""} title="Ниже">↓</button>
        <button type="button" class="btn sm danger" data-ve="del" data-pos="${pos}" title="Убрать точку">✕</button></span></li>`;
  }).join("") || '<li class="bad"><span class="n">!</span><span class="s"><b>Нет точек — добавьте ссылки ниже</b></span><span></span></li>';
}

async function veAddChanged() {
  const text = $<HTMLTextAreaElement>("veAdd").value;
  if (!text.trim()) { $("veAddInfo").textContent = ""; return; }
  try {
    const items = await api.linksParse(text);
    const ok = items.filter((x) => x.ok).length, bad = items.length - ok;
    $("veAddInfo").textContent = `Будет добавлено: ${ok}${bad ? ` · не распознано: ${bad}` : ""}`;
  } catch { /* ошибку покажет сохранение */ }
}

/** Проверка: удачные точки — сверху, быстрые — первыми. */
async function veProbe() {
  const b = $<HTMLButtonElement>("veProbe");
  const seq = ++veSeq;
  b.disabled = true;
  b.textContent = "Проверяю…";
  $("veErr").hidden = true;
  try {
    const res = await api.profileProbe(veProfile!.id, $<HTMLInputElement>("veDirect").checked);
    if (seq !== veSeq) return;
    veProbeRes = res;
    // Замерзающие — после рабочих, но перед молчащими.
    const score = (i: number) => { const r = veProbeRes!.find((x) => x.index === i); return r?.ok ? (r.bulk?.stalled ? 0 : 1e8) + r.ok * 1e6 - (r.median_ms ?? 0) : -1e9; };
    veOrder = [...veOrder].sort((a, c) => score(c) - score(a));
  } catch (e) {
    if (seq !== veSeq) return;
    $("veErr").textContent = String(e);
    $("veErr").hidden = false;
  }
  b.textContent = "Проверить";
  b.disabled = false;
  renderVe();
}

async function veSave() {
  $("veErr").hidden = true;
  try {
    profiles = await api.profileEditVpn({
      id: veProfile!.id, name: $<HTMLInputElement>("veName").value, mode: $<HTMLSelectElement>("veMode").value,
      order: veOrder, add: $<HTMLTextAreaElement>("veAdd").value,
    });
    $("vpnEditor").hidden = true;
    $<HTMLTextAreaElement>("veAdd").value = "";
    renderProfiles();
    const p = profiles.profiles.find((x) => x.id === veProfile!.id);
    // Рабочий профиль: движок до перезапуска идёт по старому — применить сразу.
    if (p?.active) {
      await runEngineOp({
        title: "Профиль сохранён",
        intro: "<p>Профиль сейчас в работе — движок до перезапуска идёт по старому порядку точек. Применить сейчас? Если туннель не поднимется, всё вернётся как было.</p>",
        confirm: "Применить",
        steps: STEPS_RESTART,
        call: () => api.engineApplyNet(),
      });
    }
  } catch (e) {
    $("veErr").textContent = String(e);
    $("veErr").hidden = false;
  }
}

// ─── Маршрут из профилей ─────────────────────────────────────────

let roEditing: string | null = null;
/** Порядок всех кандидатов (id) и отмеченные. */
let roOrder: string[] = [];
let roOn = new Set<string>();
let roProbeRes = new Map<string, MemberProbe>();

function openRouteEditor(p: ProfileView | null) {
  hidePanels();
  roEditing = p?.id ?? null;
  const cands = profiles.profiles.filter((x) => x.route.length === 0 && x.id !== p?.id);
  const chosen = p?.route.map((m) => m.id) ?? [];
  roOrder = [...chosen.filter((id) => cands.some((c) => c.id === id)), ...cands.map((c) => c.id).filter((id) => !chosen.includes(id))];
  roOn = new Set(chosen);
  roProbeRes = new Map();
  $("routeEditor").hidden = false;
  $("roTitle").textContent = p ? `Маршрут «${p.name}»` : "Новый маршрут";
  $<HTMLInputElement>("roName").value = p?.name ?? "";
  $<HTMLSelectElement>("roMode").value = p?.mode === "fallback" ? "fallback" : "auto";
  $("roErr").hidden = true;
  renderRo();
  $("routeEditor").scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function renderRo() {
  const by = (id: string) => profiles.profiles.find((x) => x.id === id);
  $("roList").innerHTML = roOrder.map((id, pos) => {
    const p = by(id);
    if (!p) return "";
    const on = roOn.has(id);
    const r = roProbeRes.get(id);
    const kind = p.cascade ? "каскад" : p.endpoints.length ? "VPN" : "прокси";
    const st = !r ? "" : r.ok ? `<span class="r ok">${r.best_ms} мс</span>` : `<span class="r fail">${esc(r.detail)}</span>`;
    return `<li class="${on ? "" : "off"}"><label class="n"><input type="checkbox" data-ro="on" data-id="${id}" ${on ? "checked" : ""}></label>
      <span class="s"><b>${esc(p.name)}</b><small>${kind}${r ? ` · ${esc(r.detail)}` : ""}</small></span>
      <span class="ve-acts">${st}
        <button type="button" class="btn sm" data-ro="up" data-pos="${pos}" ${pos === 0 ? "disabled" : ""} title="Выше">↑</button>
        <button type="button" class="btn sm" data-ro="down" data-pos="${pos}" ${pos === roOrder.length - 1 ? "disabled" : ""} title="Ниже">↓</button></span></li>`;
  }).join("");
}

const roMembers = () => roOrder.filter((id) => roOn.has(id));

async function roProbe() {
  const b = $<HTMLButtonElement>("roProbe");
  b.disabled = true;
  b.textContent = "Проверяю…";
  $("roErr").hidden = true;
  try {
    const res = await api.routeProbe(roMembers(), $<HTMLInputElement>("roDirect").checked);
    roProbeRes = new Map(res.map((r) => [r.id, r]));
  } catch (e) { $("roErr").textContent = String(e); $("roErr").hidden = false; }
  b.textContent = "Проверить участников";
  b.disabled = false;
  renderRo();
}

async function roSave() {
  $("roErr").hidden = true;
  try {
    profiles = await api.routeSave(roEditing, $<HTMLInputElement>("roName").value, roMembers(), $<HTMLSelectElement>("roMode").value);
    $("routeEditor").hidden = true;
    renderProfiles();
  } catch (e) { $("roErr").textContent = String(e); $("roErr").hidden = false; }
}

function wireRoute() {
  $("roList").addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const cb = t.closest<HTMLInputElement>("input[data-ro=on]");
    if (cb) {
      if (cb.checked) roOn.add(cb.dataset.id!); else roOn.delete(cb.dataset.id!);
      // Порядок — приоритет: отмеченные наверх, в прежнем порядке.
      roOrder = [...roOrder.filter((id) => roOn.has(id)), ...roOrder.filter((id) => !roOn.has(id))];
      renderRo();
      return;
    }
    const b = t.closest<HTMLButtonElement>("button[data-ro]");
    if (!b) return;
    const pos = Number(b.dataset.pos);
    const sw = (a: number, c: number) => { [roOrder[a], roOrder[c]] = [roOrder[c], roOrder[a]]; };
    if (b.dataset.ro === "up" && pos > 0) sw(pos, pos - 1);
    if (b.dataset.ro === "down" && pos < roOrder.length - 1) sw(pos, pos + 1);
    renderRo();
  });
  $("roProbe").addEventListener("click", () => void roProbe());
  $("roSave").addEventListener("click", () => void roSave());
  $("roCancel").addEventListener("click", () => { $("routeEditor").hidden = true; });
}

// ─── Пробный запуск ──────────────────────────────────────────────

let trial: TrialStatus | null = null;
let trialTimer: number | undefined;

function renderTrial() {
  const t = trial;
  $("trialBox").hidden = !t || (!t.running && !t.error);
  if (!t) return;
  $("trTitle").textContent = t.running ? `Пробный запуск «${t.profile}»` : "Пробный запуск остановлен";
  const m = Math.floor(t.uptime_s / 60);
  $("trHint").textContent = t.running ? `работает ${m ? `${m} мин` : `${t.uptime_s} с`} · ${t.mode === "auto" ? "самая быстрая точка" : t.mode === "smart" ? "умный выбор по истории" : "по порядку"}` : "";
  $("trAddr").textContent = t.running ? `127.0.0.1:${t.port}` : "";
  $("trPoints").innerHTML = t.points.map((p) => `<li class="${p.active ? "best" : ""}${p.alive ? "" : " bad"}">
      <span class="n">${p.active ? "▶" : p.role === "entry" ? "вх" : ""}</span>
      <span class="s"><b>${esc(p.label)}</b><small>${esc(p.summary)}</small></span>
      <span class="r ${p.alive ? "ok" : "fail"}">${p.alive ? (p.delay_ms ? `${p.delay_ms} мс` : "жива") : "нет ответа"}${p.active ? " · активна" : ""}</span></li>`).join("");
  $("trErr").textContent = t.error ?? "";
  $("trErr").hidden = !t.error;
  for (const id of ["trCheck", "trSpeedBtn", "trBrowser", "trStop"]) $<HTMLButtonElement>(id).disabled = !t.running;
}

async function pollTrial() {
  clearTimeout(trialTimer);
  try { trial = await api.trialStatus(); } catch { /* окно покажет прежнее */ }
  renderTrial();
  if (trial?.running && !$("pageProfiles").hidden) trialTimer = window.setTimeout(() => void pollTrial(), 5000);
}

async function startTrial(p: ProfileView) {
  hidePanels();
  trial = { running: true, profile_id: p.id, profile: p.name, mode: p.mode, port: 0, uptime_s: 0, points: [], error: null };
  renderTrial();
  $("trHint").textContent = "запускаю движок и проверяю точки…";
  $("trialBox").scrollIntoView({ block: "nearest", behavior: "smooth" });
  try { trial = await api.trialStart(p.id); }
  catch (e) { trial = { ...trial, running: false, error: String(e) }; }
  $("trSpeed").innerHTML = "";
  renderTrial();
  void pollTrial();
}

async function trialBusy(id: string, label: string, f: () => Promise<void>) {
  const b = $<HTMLButtonElement>(id);
  const was = b.textContent;
  b.disabled = true;
  b.textContent = label;
  try { await f(); } catch (e) { $("trErr").textContent = String(e); $("trErr").hidden = false; }
  b.textContent = was;
  b.disabled = !trial?.running;
}

function wireTrial() {
  $("trCheck").addEventListener("click", () => void trialBusy("trCheck", "Проверяю…", async () => { trial = await api.trialCheck(); renderTrial(); }));
  $("trSpeedBtn").addEventListener("click", () => void trialBusy("trSpeedBtn", "Меряю…", async () => {
    const r = await api.trialSpeed();
    $("trSpeed").innerHTML = r.error && !r.down_mbps
      ? `<span class="bad">${esc(r.error)}</span>`
      : `<span>пинг <b>${r.ping_ms ?? "—"} мс</b></span><span>↓ <b>${r.down_mbps ?? "—"} Мбит/с</b></span><span>↑ <b>${r.up_mbps ?? "—"} Мбит/с</b></span><span class="hint">через профиль, мимо рабочего туннеля</span>`;
  }));
  $("trBrowser").addEventListener("click", () => void trialBusy("trBrowser", "Открываю…", async () => { await api.trialBrowser(); }));
  $("trStop").addEventListener("click", async () => {
    try { await api.trialStop(); trial = null; renderTrial(); }
    catch (e) { $("trErr").textContent = String(e); $("trErr").hidden = false; }
  });
}

// ─── Каскад ──────────────────────────────────────────────────────

let caEditing: string | null = null;
let caAutoName = "";

/** Профили, из которых можно собрать каскад (каскад из каскада — нельзя). */
const caSources = () => profiles.profiles.filter((p) => !p.cascade);
const caPick = () => ({ entry: $<HTMLSelectElement>("caEntry").value, exit: $<HTMLSelectElement>("caExit").value });

function openCascader(p: ProfileView | null) {
  hidePanels();
  $("importer").hidden = true;
  $("cascader").hidden = false;
  caEditing = p?.id ?? null;
  $("caTitle").textContent = p ? `Каскад «${p.name}»` : "Новый каскад";
  const src = caSources();
  const opts = src.map((s) => `<option value="${s.id}">${esc(s.name)}${s.server ? ` · ${esc(s.server)}` : ""}</option>`).join("");
  $("caEntry").innerHTML = opts;
  $("caExit").innerHTML = opts;
  $<HTMLSelectElement>("caEntry").value = p?.cascade?.entry ?? src[0]?.id ?? "";
  $<HTMLSelectElement>("caExit").value = p?.cascade?.exit ?? src.find((s) => s.id !== $<HTMLSelectElement>("caEntry").value)?.id ?? "";
  caAutoName = "";
  $<HTMLInputElement>("caName").value = p?.name ?? "";
  caChanged();
}

/** Новая пара — старая проверка уже не о ней; автоназвание следует за выбором. */
function caChanged() {
  const { entry, exit } = caPick();
  const nm = (id: string) => profiles.profiles.find((p) => p.id === id)?.name ?? "?";
  const name = $<HTMLInputElement>("caName");
  const auto = `${nm(entry)} → ${nm(exit)}`;
  if (!name.value || name.value === caAutoName) name.value = auto;
  caAutoName = auto;
  $("caList").innerHTML = "";
  $("caErr").hidden = true;
  const same = !!entry && entry === exit;
  if (same) { $("caErr").textContent = "Вход и выход — один и тот же профиль"; $("caErr").hidden = false; }
  $<HTMLButtonElement>("caProbe").disabled = same || !entry;
  $<HTMLButtonElement>("caSave").disabled = same || !entry;
}

function caRow(role: string, rs: ProbeResult[]) {
  const ok = rs.find((r) => r.ok > 0);
  const r = ok ?? rs[0];
  const res = !r ? "" : ok ? `<span class="r ok">${r.ok}/${r.rounds} · ${r.median_ms} мс</span>` : `<span class="r fail">${esc(r.error ?? "нет ответа")}</span>`;
  return `<li class="${ok ? "" : "bad"}"><span class="n">${ok ? "✓" : "✗"}</span><span class="s"><b>${role}</b><small>${esc(rs.map((x) => x.label).join(", "))}</small></span><span class="r">${res}</span></li>`;
}

async function probeCascade() {
  const b = $<HTMLButtonElement>("caProbe");
  const { entry, exit } = caPick();
  b.disabled = true;
  b.textContent = "Проверяю…";
  $("caErr").hidden = true;
  $("caList").innerHTML = `<li><span class="n">…</span><span class="s"><b>Песочница</b><small>вход отдельно, затем выход через вход</small></span><span></span></li>`;
  try {
    const r = await api.cascadeProbe(entry, exit, $<HTMLInputElement>("caDirect").checked);
    $("caList").innerHTML = caRow("Вход", r.entry) + caRow("Выход через вход", r.exit);
  } catch (e) {
    $("caList").innerHTML = "";
    $("caErr").textContent = String(e);
    $("caErr").hidden = false;
  }
  b.textContent = "Проверить";
  b.disabled = false;
}

async function saveCascade() {
  const { entry, exit } = caPick();
  $("caErr").hidden = true;
  try {
    profiles = await api.cascadeSave(caEditing, $<HTMLInputElement>("caName").value, entry, exit);
    $("cascader").hidden = true;
    renderProfiles();
  } catch (e) {
    $("caErr").textContent = String(e);
    $("caErr").hidden = false;
  }
}

/** ⇄ на карточке: поменять вход и выход. Рабочий каскад сразу переподнимаем. */
async function swapCascade(p: ProfileView) {
  const c = p.cascade!;
  const autoName = p.name === `${c.entry_name} → ${c.exit_name}`;
  try {
    profiles = await api.cascadeSave(p.id, autoName ? `${c.exit_name} → ${c.entry_name}` : p.name, c.exit, c.entry);
    renderProfiles();
  } catch (e) {
    await modal("Не поменялось", `<div class="result bad">${esc(String(e))}</div>`, "Понятно", null);
    return;
  }
  const np = profiles.profiles.find((x) => x.id === p.id);
  if (np?.active) await activate(np);
}

async function saveImport() {
  $("imErr").hidden = true;
  try {
    profiles = await api.profileImport($<HTMLInputElement>("imName").value, $<HTMLTextAreaElement>("imText").value,
      $<HTMLSelectElement>("imMode").value, imOrder());
    $("importer").hidden = true;
    // Ссылки с ключами в поле не держим.
    $<HTMLTextAreaElement>("imText").value = "";
    $("imList").innerHTML = "";
    imParsed = [];
    imProbe = null;
    renderProfiles();
  } catch (e) {
    $("imErr").textContent = String(e);
    $("imErr").hidden = false;
  }
}

function wireProfiles() {
  $("btnAddProfile").addEventListener("click", () => {
    hidePanels();
    $("addChooser").hidden = false;
    $("addChooser").scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
  $("acClose").addEventListener("click", () => { $("addChooser").hidden = true; });
  $("veList").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-ve]");
    if (!b) return;
    const pos = Number(b.dataset.pos);
    const swap = (a: number, c: number) => { [veOrder[a], veOrder[c]] = [veOrder[c], veOrder[a]]; };
    if (b.dataset.ve === "up" && pos > 0) swap(pos, pos - 1);
    if (b.dataset.ve === "down" && pos < veOrder.length - 1) swap(pos, pos + 1);
    if (b.dataset.ve === "del") veOrder.splice(pos, 1);
    renderVe();
  });
  $("veAdd").addEventListener("input", () => { clearTimeout(veTimer); veTimer = window.setTimeout(() => void veAddChanged(), 300); });
  $("veProbe").addEventListener("click", () => void veProbe());
  $("veSave").addEventListener("click", () => void veSave());
  $("veCancel").addEventListener("click", () => { $("vpnEditor").hidden = true; });
  $("addChooser").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-add]");
    if (!b) return;
    const what = b.dataset.add;
    if (what === "links") openImporter();
    if (what === "cascade") openCascader(null);
    if (what === "route") openRouteEditor(null);
    if (what === "proxy") openEditor(null);
    if (what === "server") {
      $("addChooser").hidden = true;
      void chooseOwnServer().then((made) => { if (made) void loadProfiles(); });
    }
  });
  $("caEntry").addEventListener("change", caChanged);
  $("caExit").addEventListener("change", caChanged);
  $("caSwap").addEventListener("click", () => {
    const { entry, exit } = caPick();
    $<HTMLSelectElement>("caEntry").value = exit;
    $<HTMLSelectElement>("caExit").value = entry;
    caChanged();
  });
  $("caProbe").addEventListener("click", () => void probeCascade());
  $("caSave").addEventListener("click", () => void saveCascade());
  $("caCancel").addEventListener("click", () => { $("cascader").hidden = true; });
  $("imText").addEventListener("input", () => { clearTimeout(imTimer); imTimer = window.setTimeout(() => void parseImport(), 300); });
  $("imProbe").addEventListener("click", () => void probeImport());
  $("imSave").addEventListener("click", () => void saveImport());
  $("imCancel").addEventListener("click", () => { $("importer").hidden = true; });
  $("peCancel").addEventListener("click", () => { $("profileEditor").hidden = true; $<HTMLInputElement>("pePass").value = ""; editing = null; });
  $("peTestBtn").addEventListener("click", () => void testForm());
  $("peHttps").addEventListener("change", syncHttps);
  $("peForm").addEventListener("submit", (e) => void saveForm(e));
  $("pePassEye").addEventListener("click", () => {
    const i = $<HTMLInputElement>("pePass");
    i.type = i.type === "password" ? "text" : "password";
  });
  document.querySelectorAll<HTMLButtonElement>("#pePrimary button").forEach((b) =>
    b.addEventListener("click", () => setPrimary(b.dataset.v as "http" | "socks5")));
  $("profileCards").addEventListener("click", async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-act]");
    if (!b) return;
    const p = profiles.profiles.find((x) => x.id === b.dataset.id);
    if (!p) return;
    if (b.dataset.act === "edit") openEditor(p);
    if (b.dataset.act === "cedit") openCascader(p);
    if (b.dataset.act === "vedit") openVpnEditor(p);
    if (b.dataset.act === "redit") openRouteEditor(p);
    if (b.dataset.act === "try") await startTrial(p);
    if (b.dataset.act === "swap") await swapCascade(p);
    if (b.dataset.act === "use") await activate(p);
    if (b.dataset.act === "off") await deactivate(p);
    if (b.dataset.act === "del") {
      const what = p.cascade
        ? `<p>Каскад «${esc(p.name)}» будет удалён. Профили входа и выхода останутся.</p>`
        : `<p>«${esc(p.name)}» (${esc(p.server)}) будет удалён вместе с сохранёнными паролями и ключами.</p>`;
      if (!(await modal(p.cascade ? "Удалить каскад?" : "Удалить профиль?", what, "Удалить", "Отмена"))) return;
      try { profiles = await api.profileDelete(p.id); renderProfiles(); }
      catch (err) { await modal("Не удалилось", `<div class="result bad">${esc(String(err))}</div>`, "Понятно", null); }
    }
  });
}


// ─── Правила роутера ─────────────────────────────────────────────

async function loadRouter() {
  const sel = $<HTMLSelectElement>("rtProfile");
  const keep = sel.value;
  sel.innerHTML = profiles.profiles.map((p) => `<option value="${p.id}">${esc(p.name)}${p.active ? " — в работе" : ""}</option>`).join("");
  sel.value = profiles.profiles.some((p) => p.id === keep) ? keep : profiles.active ?? profiles.profiles[0]?.id ?? "";
  await showRouterRules();
}

async function showRouterRules(checks: RouterCheck[] = []) {
  const id = $<HTMLSelectElement>("rtProfile").value;
  if (!id) { $("rtRules").innerHTML = ""; return; }
  let rules: RouterRule[] = [];
  try { rules = await api.routerRules(id); } catch (e) { $("rtRules").innerHTML = `<li class="bad">${esc(String(e))}</li>`; return; }
  $("rtRules").innerHTML = rules.map((r) => {
    const c = checks.find((x) => x.server === r.server);
    const ports = [r.tcp.length ? `TCP ${r.tcp.join(", ")}` : "", r.udp.length || r.udp_ranges?.length ? `UDP ${[...r.udp, ...(r.udp_ranges ?? [])].join(", ")}` : ""].filter(Boolean).join(" · ");
    return `<li class="${c ? (c.ok ? "ok" : "bad") : ""}"><span class="mk">${c ? (c.ok ? "✓" : "✗") : "›"}</span>
      <span><b class="mono">${esc(r.server)}</b> — ${esc(ports)} <span class="hint">(${esc(r.what.join(", "))})</span>
      ${c ? `<small>${c.ok ? "роутер пускает" : "роутер не пускает или сервер не отвечает"}: ${esc(c.detail)}</small>` : ""}</span></li>`;
  }).join("");
}

// ─── Движок ──────────────────────────────────────────────────────

async function loadEngine() {
  try { info = await api.engineInfo(); } catch { info = null; }
  if (!info) return;
  const sel = $<HTMLSelectElement>("netIface");
  const list = [...new Set([info.net.interface, ...info.interfaces].filter(Boolean))];
  sel.innerHTML = list.map((n) => `<option ${n === info!.net.interface ? "selected" : ""}>${esc(n)}</option>`).join("");
  $<HTMLSelectElement>("netUdpMode").value = info.net.udp || "auto";
  try {
    const ps = await api.profiles();
    const cur = ps.profiles.find((p) => p.active);
    $<HTMLSelectElement>("netReserve").innerHTML = `<option value="">без резерва</option>` +
      ps.profiles.filter((p) => p.id !== cur?.id).map((p) => `<option value="${p.id}" ${p.id === info!.net.reserve ? "selected" : ""}>перейти на «${esc(p.name)}», потом вернуться</option>`).join("");
  } catch { /* список профилей подождёт */ }
  $<HTMLInputElement>("netQuic").checked = info.net.block_quic;
  $<HTMLSelectElement>("netIpv6").value = info.net.ipv6 || "tunnel";
  $<HTMLInputElement>("netKs").checked = !!info.net.kill_switch;
  $<HTMLInputElement>("netRealIp").checked = !!info.net.real_ip;
  $<HTMLTextAreaElement>("netLan").value = info.net.lan.join("\n");
  $<HTMLTextAreaElement>("netDirect").value = info.net.direct.join("\n");
  $<HTMLInputElement>("netTele").checked = info.net.block_telemetry;
  $<HTMLTextAreaElement>("netBlock").value = info.net.block_domains.join("\n");
  $("netTeleHint").title = info.telemetry_list.join("\n");
  $("netStale").hidden = info.kind !== "wpx" || info.config_current;
  $("netErr").hidden = true;
  void loadRouter();
  renderEngine();
}


function netFromForm(base: NetSettings) {
  const lines = (id: string) => $<HTMLTextAreaElement>(id).value.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  return {
    ...base,
    interface: $<HTMLSelectElement>("netIface").value,
    udp: $<HTMLSelectElement>("netUdpMode").value as NetSettings["udp"],
    block_quic: $<HTMLInputElement>("netQuic").checked,
    ipv6: $<HTMLSelectElement>("netIpv6").value as NetSettings["ipv6"],
    kill_switch: $<HTMLInputElement>("netKs").checked,
    real_ip: $<HTMLInputElement>("netRealIp").checked,
    reserve: $<HTMLSelectElement>("netReserve").value,
    lan: lines("netLan"),
    direct: lines("netDirect"),
    block_telemetry: $<HTMLInputElement>("netTele").checked,
    block_domains: lines("netBlock"),
  };
}

async function saveNet(apply: boolean) {
  if (!info) return;
  $("netErr").hidden = true;
  // Поверх свежих настроек: правила могли поменяться на вкладке «Правила».
  const save = async () => api.netSave(netFromForm((await api.engineInfo()).net));
  if (!apply) {
    try { await save(); }
    catch (e) { $("netErr").textContent = String(e); $("netErr").hidden = false; return; }
    await modal("Сохранено", `<div class="result ok">Настройки сохранены. Применятся при следующем перезапуске движка или смене профиля.</div>`, "Понятно", null);
    return;
  }
  // Сохраняем только после подтверждения: отказ ничего не меняет.
  const r = await runEngineOp({
    title: "Применить сетевые настройки",
    intro: "<p>Движок перезапустится с новыми настройками сети.</p>",
    confirm: "Применить",
    steps: STEPS_SWITCH,
    call: async () => { await save(); return api.engineApplyNet(); },
  });
  if (r) void loadEngine();
}

let ownerKey = "";

function renderOwner() {
  const box = $("engOwner");
  const wpx = snap?.engine_kind === "wpx";
  const active = profiles.profiles.find((p) => p.active);
  // Перерисовываем только при изменениях — иначе кнопка «теряет» клики.
  const key = [wpx, snap?.profile, active?.id, active?.name, info?.wpx_dir, profiles.profiles.map((p) => p.id + p.name).join()].join("|");
  if (key === ownerKey) return;
  ownerKey = key;
  if (wpx) {
    box.innerHTML = `<div class="owner"><div class="ico">wpx</div>
      <div><div class="big">Туннелем управляет wpx</div>
      <div class="sub" title="задача wpx-engine · ${esc(info?.wpx_dir ?? "C:\\ProgramData\\wpx\\engine")}">профиль «${esc(snap?.profile ?? active?.name ?? "—")}» · движок работает в фоне, даже когда окно закрыто</div></div>
      <span></span></div>`;
  } else {
    // Профили есть, рабочий не выбран — выбор тут же, без похода на «Профили».
    const pick = !active && profiles.profiles.length
      ? `<label class="eng-pick">Профиль: <select id="engPick">${profiles.profiles.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("")}</select></label>`
      : "";
    box.innerHTML = `<div class="owner missing"><div class="ico">wpx</div>
      <div><div class="big">Движок ещё не установлен</div>
      <div class="sub">${active ? `wpx только наблюдает. Установите движок — и туннель поднимется с профилем «${esc(active.name)}».`
        : pick ? "Выберите профиль — с ним поднимется туннель." : "Сначала добавьте профиль на вкладке «Профили» — или разверните свой сервер на вкладке «Серверы»."}</div>
      ${pick}
      <ol class="install-steps">
        <li>движок (mihomo) — с запуском при включении ПК</li>
        <li>kill switch и настройки профиля — с проверкой заранее</li>
        <li>если туннель не поднимется — всё вернётся как было</li>
      </ol></div>
      <button class="btn primary" id="engInstall" ${active || pick ? "" : "disabled"}>Установить движок</button></div>`;
    $("engInstall")?.addEventListener("click", () => {
      const id = document.querySelector<HTMLSelectElement>("#engPick")?.value;
      const p = active ?? profiles.profiles.find((x) => x.id === id);
      if (p) void activate(p);
    });
  }
}

function renderEngine() {
  if (!snap) return;
  const wpx = snap.engine_kind === "wpx";
  $("engineDot").hidden = wpx;
  renderOwner();
  const busy = snap.busy || opRunning();
  ["engStart", "engRestart", "engStop", "engDeep", "netApply", "engUninstall", "engUpdateBtn"].forEach((id) => { $<HTMLButtonElement>(id).disabled = busy; });
  // Без движка запускать нечего: туннель поднимет «Установить движок».
  ["engStart", "engRestart", "engDeep"].forEach((id) => { $<HTMLButtonElement>(id).disabled = busy || !wpx; });
  $<HTMLButtonElement>("engStart").disabled = busy || !wpx || snap.engine.running;
  $<HTMLButtonElement>("engStop").disabled = busy || !snap.engine.running;
  $("engTaskHint").textContent = `${wpx ? "задача wpx-engine" : "движок не установлен"} · ${snap.engine.running ? `mihomo работает (PID ${snap.engine.pid})` : "mihomo остановлен"}`;
  const boot = $<HTMLInputElement>("engBoot");
  boot.disabled = !wpx || busy;
  boot.checked = wpx ? snap.boot !== false : true;
  $("engBootHint").textContent = wpx ? "ещё до входа в Windows" : "станет доступно после установки движка";
  const heal = $<HTMLInputElement>("engHeal");
  heal.disabled = !wpx || busy;
  heal.checked = wpx && snap.heal;

  const ul = $("engGuard");
  ul.innerHTML = !wpx
    ? `<li class="empty">Движок не установлен — интернет идёт напрямую. Kill switch и проверки заработают после установки.</li>`
    : snap.guard.length
    ? snap.guard.map((g) => {
        const cls = g.ok === true ? "ok" : g.ok === false ? "bad" : "unk";
        const mk = g.ok === true ? "✓" : g.ok === false ? "!" : "?";
        return `<li class="${cls}"><span class="mk">${mk}</span><span class="lbl">${esc(g.label)} <span class="hint">— <span>${esc(g.detail)}</span></span></span></li>`;
      }).join("")
    : `<li class="empty">проверяем…</li>`;
  $("engGuardAt").textContent = wpx && snap.guard_at ? `проверено ${hhmm(snap.guard_at)}` : "";
  $("engRemove").hidden = !wpx;
  $("engUpdate").hidden = !wpx || !info?.engine_outdated;
}

function deepBody(r: ApplyResult) {
  type Hop = { s?: string; p?: number; l?: string; ok: boolean; ms?: number | null };
  let d: { direct1?: boolean; direct2?: boolean; ipv6?: boolean; dns?: boolean; proxy?: boolean | null; hops?: Hop[] | Hop; udp?: Hop[] } = {};
  try { d = JSON.parse(r.info ?? "{}"); } catch { /* пусто */ }
  const row = (ok: boolean, text: string) => `<div class="${ok ? "ok" : "bad"}">${ok ? "✓" : "✗"} ${text}</div>`;
  // PowerShell отдаёт одиночный элемент без массива.
  const hops: Hop[] = d.hops ? (Array.isArray(d.hops) ? d.hops : [d.hops]) : [];
  const udp = d.udp ?? [];
  const reach = [
    ...hops.map((h) => row(h.ok, `${esc(h.s ?? "")}:${h.p} напрямую — ${h.ok ? "доступен" : "недоступен (роутер не пускает?)"}`)),
    ...udp.map((h) => row(h.ok, `${esc(h.l ?? "")} — ${h.ok ? `роутер пускает${h.ms ? ` · ${h.ms} мс` : ""}` : "не отвечает"}`)),
  ];
  const rows = [
    row(d.direct1 === false, "1.1.1.1:443 напрямую — закрыто"),
    row(d.direct2 === false, "8.8.8.8:443 напрямую — закрыто"),
    row(d.ipv6 === false, "IPv6 напрямую — закрыт"),
    row(d.dns === false, "DNS 8.8.8.8 напрямую — закрыт"),
    ...(reach.length ? reach : [row(d.proxy === true, "сервер доступен")]),
  ];
  // Держит, если напрямую не выйти, а хотя бы один сервер рабочего пути доступен.
  const anyReach = hops.some((h) => h.ok) || udp.some((h) => h.ok) || d.proxy === true;
  const all = d.direct1 === false && d.direct2 === false && d.ipv6 === false && d.dns === false && anyReach;
  $("engDeepResult").innerHTML = `<div class="deep-res">${rows.join("")}<div class="hint">проверено ${hhmm(Date.now())}</div></div>`;
  return `<div class="result ${all ? "ok" : "bad"}">${all ? "Kill switch держит: мимо туннеля выйти нельзя. Туннель снова работает." : "Есть дыры в защите — см. ниже."}</div><div class="deep-res">${rows.join("")}</div>`;
}

function wireEngine() {
  $("engRestart").addEventListener("click", () => void runEngineOp({
    title: "Перезапустить движок", intro: "<p>Движок перезапустится с текущим конфигом.</p>",
    confirm: "Перезапустить", steps: STEPS_RESTART, call: () => api.restart(),
  }));
  $("engStart").addEventListener("click", () => void runEngineOp({
    title: "Запустить движок", intro: "<p>Туннель поднимется, интернет на ПК вернётся.</p>",
    confirm: "Запустить", steps: ["Подтверждение прав администратора", "Запуск движка", "Проверка туннеля"], call: () => api.start(),
  }));
  $("engStop").addEventListener("click", () => void runEngineOp({
    title: "Остановить движок",
    intro: info?.net.kill_switch
      ? "<p><b>Интернет на этом ПК пропадёт</b> до повторного запуска — kill switch не пустит трафик мимо туннеля. Локальная сеть и SSH-исключения останутся.</p>"
      : "<p>Туннель выключится — интернет пойдёт напрямую, без VPN, до повторного запуска.</p>",
    confirm: "Остановить", steps: ["Подтверждение прав администратора", "Остановка движка"], call: () => api.stop(), danger: true,
  }));
  $("engBoot").addEventListener("change", async () => {
    const box = $<HTMLInputElement>("engBoot");
    const on = box.checked;
    const r = await runEngineOp({
      title: on ? "Включить автозапуск туннеля" : "Выключить автозапуск туннеля",
      intro: on ? "<p>Туннель будет подниматься при включении ПК, ещё до входа в систему.</p>"
                : "<p>После перезагрузки туннель не поднимется сам — <b>интернета не будет</b>, пока не запустите его из wpx.</p>",
      confirm: on ? "Включить" : "Выключить",
      steps: ["Подтверждение прав администратора", "Изменение автозапуска wpx-engine"],
      call: () => api.setBoot(on),
    });
    if (!r?.ok) box.checked = !on;
  });
  $("engHeal").addEventListener("change", async () => {
    const box = $<HTMLInputElement>("engHeal");
    const on = box.checked;
    const r = await runEngineOp({
      title: on ? "Включить самовосстановление" : "Выключить самовосстановление",
      intro: on
        ? "<p>Появится системная задача <b>wpx-watchdog</b>: раз в минуту она проверяет туннель. Если он не отвечает ~25 секунд, а прокси при этом доступен напрямую, движок перезапускается — без окон и подтверждений. Если не отвечает сам прокси, перезапуск не поможет и не делается. Не чаще раза в 5 минут; остановленный вручную движок не трогает.</p>"
        : "<p>Задача wpx-watchdog будет удалена. Зависший движок придётся перезапускать вручную.</p>",
      confirm: on ? "Включить" : "Выключить",
      steps: ["Подтверждение прав администратора", on ? "Включение задачи wpx-watchdog" : "Выключение задачи wpx-watchdog"],
      call: () => api.setHeal(on),
    });
    if (!r?.ok) box.checked = !on;
  });
  $("engDeep").addEventListener("click", () => void runEngineOp({
    title: "Глубокая проверка kill switch",
    intro: "<p>Движок остановится примерно на 15 секунд. За это время wpx попробует выйти в интернет напрямую (IPv4, IPv6, DNS) — всё должно быть закрыто, а серверы рабочего профиля и резерва — доступны (UDP-точки проверит песочница). Потом туннель поднимется сам.</p>",
    confirm: "Проверить",
    steps: ["Подтверждение прав администратора", "Страховка: туннель поднимется в любом случае", "Остановка движка и попытки выйти напрямую", "Запуск движка и проверка туннеля"],
    call: () => api.deepTest(),
    okBody: deepBody,
  }));
  $("engToRules").addEventListener("click", () => document.querySelector<HTMLButtonElement>('[data-page="rules"]')?.click());
  $("rtProfile").addEventListener("change", () => void showRouterRules());
  $("rtCheck").addEventListener("click", async () => {
    const b = $<HTMLButtonElement>("rtCheck");
    b.disabled = true;
    b.textContent = "Проверяю…";
    try { await showRouterRules(await api.routerCheck($<HTMLSelectElement>("rtProfile").value)); }
    catch (e) { $("rtRules").insertAdjacentHTML("beforeend", `<li class="bad"><span class="mk">!</span><span>${esc(String(e))}</span></li>`); }
    b.textContent = "Проверить, что роутер пускает";
    b.disabled = false;
  });
  $("engUpdateBtn").addEventListener("click", async () => {
    const r = await runEngineOp({
      title: "Обновить движок",
      intro: "<p>wpx заменит mihomo версией из этой сборки и перезапустит движок — интернет пропадёт на несколько секунд. Если туннель не поднимется, вернётся прежняя версия.</p>",
      confirm: "Обновить",
      steps: ["Подтверждение прав администратора", "Замена mihomo с проверкой подлинности", "Проверка туннеля, при неудаче — откат"],
      call: () => api.engineUpdate(),
    });
    if (r) void loadEngine();
  });
  $("netSave").addEventListener("click", () => void saveNet(false));
  $("netApply").addEventListener("click", () => void saveNet(true));
  $("engUninstall").addEventListener("click", async () => {
    const r = await runEngineOp({
      title: "Удалить движок",
      intro: "<p>Туннель выключится. Будут удалены задачи и службы wpx, правила файрвола wpx (kill switch — с возвратом прежних настроек) и папка движка. Профили и настройки wpx останутся — движок можно поставить снова.</p>",
      confirm: "Удалить", steps: ["Подтверждение прав администратора", "Остановка движка, удаление задач и правил", "Удаление папки движка"],
      call: () => api.engineUninstall(), danger: true,
    });
    if (r?.ok) void loadEngine();
  });
}

// ─── Вход ────────────────────────────────────────────────────────

export function initPages(a: Api) {
  api = a;
  wireProfiles();
  wireTrial();
  wireRoute();
  wireEngine();
  onOpChange(() => renderEngine());
  void loadProfiles();
}

export function onPageShown(page: string) {
  if (page === "profiles") { void loadProfiles(); void pollTrial(); }
  if (page === "engine") { void loadProfiles().then(loadEngine); }
}

export function onSnapshot(s: Snapshot) {
  const kindChanged = snap && snap.engine_kind !== s.engine_kind;
  snap = s;
  if (kindChanged) { void loadProfiles(); void loadEngine(); }
  if (!$("pageEngine").hidden) renderEngine();
  else $("engineDot").hidden = s.engine_kind === "wpx";
}
