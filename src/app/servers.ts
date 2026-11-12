// Вкладка «Серверы»: свои VPS — подключение по SSH, установка VPN,
// каскад (вход-«труба» → выход), удаление. Ход операций приходит строками
// из Rust (событие server-log) и показывается вживую.

import type { Api } from "../core/api";
import type { Guest, GuestInput, GuestStat, HealEvent, HostKey, ProbeResult, ServerCheck, ServerLog, ServerOpResult, ServersState, ServerView, Share, ShareItem } from "../core/types";
import { $, esc, modal, probeBadge, when } from "../core/ui";
import { TYPE_ICON } from "../core/icons";
import { lang } from "../core/i18n";

let api: Api;
let st: ServersState = { servers: [], version: "", covers: [] };
let auth: "pass" | "key" = "pass";
let sink: ((l: ServerLog) => void) | null = null;
let busy = false;
const inTauri = "__TAURI_INTERNALS__" in window;

async function load() {
  try { st = await api.servers(); } catch { /* пустой список */ }
  render();
}

// ─── Карточки ────────────────────────────────────────────────────

const byId = (id: string) => st.servers.find((s) => s.id === id);

function card(s: ServerView) {
  const f = s.facts;
  const place = f ? [f.city, f.country].filter(Boolean).join(", ") : "";
  const others = (f?.containers ?? []).filter((c) => !c.startsWith("wpx-"));
  const installed = !!(s.vless || s.hy2 || s.awg || s.xhttp || s.mtproxy);
  const svc = [
    s.vless ? `<span class="tag main" title="Прикрытие: ${esc(s.vless.dest)}">VLESS+Reality :${s.vless.port}</span>` : "",
    s.hy2 ? `<span class="tag main" title="${s.hy2.hop ? `Смена портов: клиент прыгает по UDP ${s.hy2.hop[0]}–${s.hy2.hop[1]}` : ""}">Hysteria2 :${s.hy2.port}/udp${s.hy2.hop ? ` · ⇆ ${s.hy2.hop[0]}–${s.hy2.hop[1]}` : ""}</span>` : "",
    s.awg ? `<span class="tag main">AmneziaWG :${s.awg.port}/udp</span>` : "",
    s.xhttp ? `<span class="tag main" title="Xray · прикрытие: ${esc(s.xhttp.dest)}">XHTTP+Reality :${s.xhttp.port}</span>` : "",
    s.mtproxy ? `<span class="tag" title="Прокси для Telegram · FakeTLS под ${esc(s.mtproxy.domain)}">MTProxy :${s.mtproxy.port}</span>` : "",
  ].join("");
  // Выход трубы не добавлен на этом ПК (сервер настраивали с другого) — без него
  // ни профиля каскада, ни действий с трубой.
  const pipes = s.pipes.map((p) => `
    <div class="srv-pipe"><span>каскад: <b>${esc(s.name)}</b> :${p.listen} → ${p.hop_name ? `<b>${esc(p.hop_name)}</b> → ` : ""}<b>${esc(p.to_name)}</b> :${p.to_port}${p.to_host.includes(":") ? ' <span class="tag" title="Со входа до выхода по IPv4 не доходит — труба идёт по IPv6">IPv6</span>' : ""}${p.to ? "" : `
        <span class="hint">— выход не добавлен на этом ПК: «Добавить сервер» ${esc(p.to_host)} через «${esc(s.name)}», и появится профиль каскада</span>`}</span>
      ${p.to ? `<span class="acts-inline">
        <button class="btn sm" data-act="cswap" data-id="${s.id}" data-to="${p.to}" title="Поменять вход и выход местами">⇄</button>
        <button class="btn sm danger" data-act="cdel" data-id="${s.id}" data-to="${p.to}">Убрать</button>
      </span>` : ""}</div>`).join("");
  return `<div class="pcard srv-card">
    <span class="ptype">${TYPE_ICON.server}</span>
    <div class="pmain">
    <div class="top"><span class="nm">${esc(s.name)}</span>${s.via_name ? `<span class="tag" title="SSH только через этот сервер">через ${esc(s.via_name)}</span>` : ""}</div>
    <div class="srv" title="${f ? esc(`${f.os} · ${f.cpus} ядр. · ${f.ram_mb} МБ${f.swap_mb ? ` + swap ${f.swap_mb}` : ""} · свободно ${Math.round(f.disk_free_mb / 1024)} ГБ`) : ""}">${esc(s.host)}${place ? ` · ${esc(place)}` : ""}${f?.org ? ` · ${esc(f.org)}` : ""}</div>
    ${f && f.uptime_s ? `<div class="srv-facts">${health(f, s)}</div>` : ""}
    <div class="tags">${svc || '<span class="tag">VPN не установлен</span>'}
      ${s.runtime ? `<span class="tag">${s.runtime === "docker" ? "Docker" : "systemd"}</span>` : ""}
      ${others.length ? `<span class="tag" title="Чужие контейнеры — wpx их не трогает">рядом: ${esc(others.join(", "))}</span>` : ""}</div>
    ${pipes}
    ${s.entries.length ? `<div class="srv-pipe srv-route"><span>маршрут: через <b>${s.entries.map(esc).join("</b>, <b>")}</b>${s.via ? "" : " · напрямую"} — движок держит быстрый живой путь</span></div>` : ""}
    </div>
    <div class="acts">
      ${installed ? "" : `<button class="btn primary" data-act="install" data-id="${s.id}">Установить VPN</button>`}
      ${needsProfile(s) ? `<button class="btn primary" data-act="profile" data-id="${s.id}" title="VPN на сервере уже стоит — wpx соберёт профиль для этого ПК, сервер не меняется">Профиль на этом ПК</button>` : ""}
      ${installed ? `<button class="btn" data-act="access" data-id="${s.id}" title="Личный доступ для телефона или друга: QR-код и ссылка, срок, отключить в один клик">Поделиться${s.guests.some(live) ? ` · ${s.guests.filter(live).length}` : ""}</button>` : ""}
      ${s.mtproxy ? `<button class="btn" data-act="tg" data-id="${s.id}" title="Ссылка и QR для Telegram">Telegram</button>` : ""}
      ${installed || s.pipes.length ? `<button class="btn" data-act="check" data-id="${s.id}" title="Где рвётся: ПК → сервер → службы VPN → интернет сервера → протоколы с ПК">Где рвётся?</button>` : ""}
      <button class="btn" data-act="care" data-id="${s.id}" title="Состояние сервера и усиление: BBR, автообновления, защита SSH">Обслуживание</button>
      <span class="acts-x"><button type="button" class="btn icon acts-more" aria-expanded="false" title="Ещё действия" aria-label="Ещё действия">⋯</button><span class="acts-pop" hidden>
      ${installed ? `<button class="btn" data-act="install" data-id="${s.id}">Изменить VPN</button>` : ""}
      ${s.profile && !needsProfile(s) && (s.vless || s.hy2 || s.xhttp || s.awg) ? `<button class="btn" data-act="profile" data-id="${s.id}" title="Вернуть в профиль все точки сервера и заново проверить их с этого ПК — сервер не меняется">Обновить профиль</button>` : ""}
      <button class="btn" data-act="inspect" data-id="${s.id}">Осмотреть</button>
      ${installed || s.pipes.length ? `<button class="btn danger" data-act="uninstall" data-id="${s.id}">Убрать с сервера</button>` : ""}
      <button class="btn" data-act="forget" data-id="${s.id}">Забыть</button></span></span>
    </div>
  </div>`;
}

/** VPN на сервере есть, а профиля на этом ПК нет — сервер настраивали с другого ПК или профиль удалили. */
const needsProfile = (s: ServerView) => !s.profile && !!(s.vless || s.hy2 || s.xhttp || s.awg);

/** Строка состояния: аптайм, нагрузка, обновления, защита. */
function health(f: NonNullable<ServerView["facts"]>, s: ServerView) {
  const bits = [`работает ${Math.floor(f.uptime_s / 86400) ? `${Math.floor(f.uptime_s / 86400)} д ` : ""}${Math.floor((f.uptime_s % 86400) / 3600)} ч`, `нагрузка ${esc(f.load.split(" ")[0] ?? "")}`];
  if (f.apt) bits.push(f.updates ? `<span class="warn">обновлений ${f.updates}${f.sec_updates ? ` (безопасности ${f.sec_updates})` : ""}</span>` : "обновления поставлены");
  if (f.reboot) bits.push('<span class="warn">ждёт перезагрузки</span>');
  const fell = f.heal_log.filter((e) => e.at > Date.now() - 86_400_000);
  if (fell.length) bits.push(`<span class="warn" title="${esc(fell.map((e) => `в ${when(e.at)} — ${e.svc}: ${e.what}`).join(" · "))}">самовосстановление: ${esc([...new Set(fell.map((e) => e.svc))].join(", "))}</span>`);
  else if (!f.heal && (s.vless || s.hy2 || s.awg || s.xhttp || s.mtproxy || s.pipes.length)) bits.push(`<span class="warn" title="${healHow(s)}">без самовосстановления</span>`);
  if (s.updates.length) bits.push(`<span class="warn">обновить: ${esc(s.updates.join(", "))}</span>`);
  const prot = [f.cc === "bbr" ? "BBR" : "", f.autoupd ? "автообновления" : "", f.f2b ? "fail2ban" : "", f.fw ? "файрвол" : ""].filter(Boolean);
  bits.push(prot.length ? `защита: ${prot.join(", ")}` : '<span class="warn">не усилен</span>');
  return bits.join(" · ");
}

/** Чем включить самовосстановление: на сервере с VPN — «Изменить VPN», у входа каскада без своего VPN — повторный «Каскад». */
const healHow = (s: ServerView) => (s.vless || s.hy2 || s.awg || s.xhttp || s.mtproxy ? "«Изменить VPN» включит" : "включит повторный «Каскад»");

/** Журнал самовосстановления: последние пять записей, свежие сверху. */
const healLog = (log: HealEvent[]) => log.length
  ? log.slice(-5).reverse().map((e) => `${when(e.at)} <b>${esc(e.svc)}</b> ${esc(e.what)}`).join("<br>")
  : "включено · чинить ничего не пришлось";

let moveAsked = false;

async function care(s: ServerView) {
  // «Переезд…» внутри окна обслуживания: закрыть его и открыть переезд.
  const onMove = (ev: Event) => {
    if ((ev.target as HTMLElement).closest("#hMove")) { moveAsked = true; $<HTMLButtonElement>("modalCancel").click(); }
  };
  $("modalBody").addEventListener("click", onMove);
  try { await careDialog(s); } finally { $("modalBody").removeEventListener("click", onMove); }
}

async function careDialog(s: ServerView) {
  const f = s.facts;
  if (!f) return;
  const mb = (b: number) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} ГБ` : `${Math.round(b / 1e6)} МБ`);
  const row = (k: string, v: string) => `<tr><td>${k}</td><td>${v}</td></tr>`;
  const chk = (id: string, on: boolean, done: boolean, title: string, d: string) =>
    `<label class="chk${done ? " off" : ""}"><input type="checkbox" id="${id}" ${on && !done ? "checked" : ""} ${done ? "disabled" : ""}><span><b>${title}</b>${done ? " — уже включено" : ` — ${d}`}</span></label>`;
  const go = await modal(`Обслуживание «${s.name}»`, `
    <table class="kv">
      ${row("Работает", `${Math.floor(f.uptime_s / 3600)} ч · нагрузка ${esc(f.load)}`)}
      ${row("Трафик с загрузки", `↓ ${mb(f.net_rx)} · ↑ ${mb(f.net_tx)}`)}
      ${row("TCP", `${esc(f.cc)}${f.cc !== "bbr" && f.bbr_avail ? " (можно BBR)" : ""}`)}
      ${f.apt ? row("Обновления", f.updates ? `${f.updates}, из них безопасности ${f.sec_updates}` : "всё поставлено") : ""}
      ${f.reboot ? row("Перезагрузка", "система ждёт перезагрузки после обновлений") : ""}
      ${row("Самовосстановление", f.heal ? healLog(f.heal_log) : `не включено — ${healHow(s)}`)}
      ${row("sing-box", f.sb_ver ? `${esc(f.sb_ver)}${f.sb_ver !== st.version ? ` → в wpx ${esc(st.version)}: «Изменить VPN» обновит` : " — актуальный"}` : "не установлен")}
    </table>
    ${chk("hBbr", f.bbr_avail, f.cc === "bbr", "BBR", "быстрее TCP на дальних и загруженных каналах (VLESS, трубы)")}
    ${chk("hUpd", f.apt, f.autoupd, "Автообновления безопасности", "unattended-upgrades ставит заплатки сам")}
    ${chk("hF2b", f.apt, f.f2b, "Защита SSH от перебора", "fail2ban банит подбор пароля на час; адрес wpx — в исключениях")}
    ${s.updates.length ? `<label class="chk"><input type="checkbox" id="hCore" checked><span><b>Обновить ядра</b> — ${esc(s.updates.join(", "))}; не поднимется новая версия — сервер вернёт прежнюю</span></label>` : ""}
    <label class="chk"><input type="checkbox" id="hFw" ${s.fw ? "checked" : ""}><span><b>Файрвол</b>${s.fw ? " — включён" : ""} — снаружи открыты только SSH и VPN. Если после включения wpx не войдёт по SSH, правила снимутся сами через 90 с</span></label>
    <div class="fw-plan">
      <div><span class="g-sub">Открыто:</span> ${s.fw_plan.open.map(esc).join(" · ")}</div>
      ${s.fw_plan.close.length ? `<div><span class="g-sub">${s.fw ? "Закрыто" : "Закроется"} (слушает снаружи, но VPN не нужно):</span>
        ${s.fw_plan.close.map(([k, w]) => `<label class="keep"><input type="checkbox" data-keep="${esc(k)}"> оставить ${esc(k.replace("/", " :"))}${w ? ` (${esc(w)})` : ""}</label>`).join("")}</div>` : ""}
    </div>
    <p class="note">Вход по паролю не отключаю — им пользуется AmneziaVPN. Правила Docker и контейнеров (AmneziaVPN) файрвол не трогает. Перезагрузку и ручные обновления не делаю — решите сами (обновления безопасности поставит «Автообновления»).</p>
    ${s.vless || s.hy2 || s.awg ? `<p class="note"><button type="button" class="btn sm" id="hMove">Переезд на другой VPS…</button> — если этот сервер заблокировали или он не устраивает: wpx перенесёт протоколы, ключи и доступы.</p>` : ""}`,
    "Применить", "Закрыть");
  if (moveAsked) { moveAsked = false; await moveServer(s.id); return; }
  if (!go) return;
  const v = (id: string) => { const i = document.getElementById(id) as HTMLInputElement | null; return !!i && i.checked && !i.disabled; };
  const [bbr, upd, f2b] = [v("hBbr"), v("hUpd"), v("hF2b")];
  const fwOn = v("hFw");
  // Всё из окна — до первой операции: она заменит его содержимое.
  const keep = [...document.querySelectorAll<HTMLInputElement>("[data-keep]:checked")].map((i) => i.dataset.keep!);
  if (v("hCore")) {
    const r = await runOp(`Обновление ядер «${s.name}»`, () => api.serverUpdate(s.id));
    if (r) { st = r; render(); } else return;
  }
  if (bbr || upd || f2b) {
    const r = await runOp(`Усиление «${s.name}»`, () => api.serverHarden(s.id, bbr, upd, f2b));
    if (r) { st = r; render(); } else return;
  }
  if (fwOn !== s.fw || (fwOn && keep.length)) {
    const r = await runOp(`Файрвол «${s.name}»`, () => api.serverFirewall(s.id, fwOn, keep));
    if (r) { st = r; render(); }
  }
}

function render() {
  const box = $("srvCards");
  box.innerHTML = st.servers.length
    ? st.servers.map(card).join("")
    : `<div class="pcard empty"><div class="nm">Серверов пока нет</div><div class="srv">Арендуйте VPS (Debian или Ubuntu, от 1 ГБ памяти) и нажмите «Добавить сервер»</div></div>`;
  $<HTMLButtonElement>("btnSrvCascade").disabled = st.servers.length < 2;
}

// ─── Ход операции ────────────────────────────────────────────────

const MK: Record<ServerLog["kind"], string> = { step: "›", ok: "✓", warn: "!", fail: "✗" };

function logHtml(lines: ServerLog[], live: boolean) {
  return `<ol class="oplog">${lines.map((l) => `<li class="${l.kind}"><span class="mk">${MK[l.kind]}</span><span>${esc(l.text)}</span></li>`).join("")}
    ${live ? '<li class="step live"><span class="mk">…</span><span>выполняю</span></li>' : ""}</ol>`;
}

/** Операция с живым ходом в модальном окне; `okBody: null` — при успехе без итогового окна. */
async function runOp<T>(title: string, call: () => Promise<T>, okBody: ((r: T) => string) | null = () => ""): Promise<T | null> {
  if (busy) return null;
  busy = true;
  const lines: ServerLog[] = [];
  const draw = () => {
    $("modalBody").innerHTML = logHtml(lines, true);
    const ol = $("modalBody").querySelector(".oplog");
    ol?.lastElementChild?.scrollIntoView({ block: "nearest" });
  };
  sink = (l) => { lines.push(l); draw(); };
  void modal(title, "", null, null);
  draw();
  let res: T | null = null;
  let err: string | null = null;
  try { res = await call(); } catch (e) { err = String(e); }
  sink = null;
  busy = false;
  if (!err && okBody === null) return res;
  const shown = lines.filter((l) => !(err && l.kind === "fail"));
  await modal(err ? "Не получилось" : "Готово",
    logHtml(shown, false) + (err ? `<div class="result bad">${esc(err)}</div>` : okBody?.(res as T) ?? ""), "Понятно", null);
  return res;
}

function probeHtml(r: ServerOpResult) {
  const rows = r.probe.map((p: ProbeResult) => p.ok
    ? `<li${p.bulk?.stalled ? ' class="bad"' : ""}><span class="n">${p.bulk?.stalled ? "!" : "✓"}</span><span class="s"><b>${esc(p.label)}</b></span>${probeBadge(p)}</li>`
    : `<li class="bad"><span class="n">✗</span><span class="s"><b>${esc(p.label)}</b></span><span class="r fail">${esc(p.error ?? "нет ответа")}</span></li>`).join("");
  return `${rows ? `<ol class="im-list">${rows}</ol>` : ""}
    ${r.note ? `<div class="result bad">${esc(r.note)}</div>` : ""}
    ${r.profile ? '<p class="note">Профиль создан или обновлён. Чтобы ПК пошёл через него — «Профили» → «Сделать рабочим»; если движка ещё нет, wpx тут же его установит.</p>' : ""}`;
}

// ─── Добавить сервер ─────────────────────────────────────────────

/** Сверка ключа сервера: что он показал и где взять настоящий. */
function fingerprintHtml(host: string, fp: string, via: string | null) {
  const jump = via ? byId(via)?.name : null;
  return `${jump ? `<p class="note">Напрямую с этого ПК сервер не отвечает — подключусь через «${esc(jump)}».</p>` : ""}
    <p>Сервер ${esc(host)} показал ключ:</p>
    <p><code class="mono">${esc(fp)}</code></p>
    <p>Сверьте его с настоящим — так видно, что между ПК и сервером никто не встал. Где смотреть: в панели хостинга или VNC-консоли сервера выполните
      <code class="mono">for f in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf "$f"; done</code> — одна из строк должна содержать этот отпечаток.</p>
    <p class="note">Проверить негде? Можно подключиться и так — риск тот же, что у обычного ssh при первом входе: пароль получит тот, кто сейчас отвечает по этому адресу.</p>`;
}

function setAuth(v: "pass" | "key") {
  auth = v;
  document.querySelectorAll<HTMLButtonElement>("#saAuth button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === v)));
  $("saPassBox").hidden = v !== "pass";
  $("saKeyBox").hidden = v !== "key";
  if (v !== "pass") $<HTMLInputElement>("saPass").value = "";
}

export function openAdd() {
  $("srvCascade").hidden = true;
  $("srvAdd").hidden = false;
  for (const id of ["saHost", "saName", "saPass", "saKey"]) $<HTMLInputElement>(id).value = "";
  $<HTMLSelectElement>("saVia").innerHTML = `<option value="">Напрямую, мимо туннеля</option>` +
    st.servers.filter((s) => !s.via).map((s) => `<option value="${s.id}">Через «${esc(s.name)}» (${esc(s.host)})</option>`).join("");
  $("saErr").hidden = true;
  setAuth("pass");
  $<HTMLInputElement>("saHost").focus();
}

async function submitAdd(ev: Event) {
  ev.preventDefault();
  $("saErr").hidden = true;
  const pass = $<HTMLInputElement>("saPass").value;
  const input = {
    name: $<HTMLInputElement>("saName").value.trim(),
    host: $<HTMLInputElement>("saHost").value.trim(),
    port: Number($<HTMLInputElement>("saPort").value) || 22,
    user: $<HTMLInputElement>("saUser").value.trim() || "root",
    password: auth === "pass" ? pass : null,
    key_path: auth === "key" ? $<HTMLInputElement>("saKey").value.trim() : null,
    via: $<HTMLSelectElement>("saVia").value || null,
  };
  if (!input.host) return;
  // Сначала ключ сервера — без пароля: сверить с панелью хостинга, и только
  // потом вход. Иначе пароль ушёл бы тому, кто первым ответил по адресу.
  const title = `Подключение ${input.host}`;
  void modal(title, logHtml([{ kind: "step", text: "Запрашиваю ключ сервера — пароль пока не отправляется. Напрямую не ответит — поищу путь через ваши серверы, это до минуты" }], true), null, null);
  let key: HostKey;
  try { key = await api.serverFingerprint(input.host, input.port, input.via); }
  catch (e) { await modal(title, `<div class="result bad">${esc(String(e))}</div>`, "Понятно", null); return; }
  // Напрямую не открылся — wpx нашёл путь через свой сервер: так и подключаемся.
  input.via = key.via;
  if (!(await modal("Ключ сервера", fingerprintHtml(input.host, key.fingerprint, key.via), "Ключ совпадает — подключиться", "Отмена"))) return;
  // Пароль в поле не держим дольше нужного.
  $<HTMLInputElement>("saPass").value = "";
  const r = await runOp(title, () => api.serverAdd({ ...input, fingerprint: key.fingerprint }));
  if (r) {
    st = r;
    $("srvAdd").hidden = true;
    render();
    const s = st.servers.find((x) => x.host === input.host);
    if (s && !s.vless && !s.hy2 && !s.awg) await install(s);
  }
}

// ─── Установка ───────────────────────────────────────────────────

async function install(s: ServerView) {
  const f = s.facts;
  const others = (f?.containers ?? []).filter((c) => !c.startsWith("wpx-"));
  const fresh = !s.vless && !s.hy2 && !s.awg && !s.xhttp && !s.mtproxy;
  // XHTTP и MTProxy — в Docker (образы под все архитектуры); нет Docker — поставим.
  const boxOk = !!f?.docker || !!f?.apt;
  // AWG — в Docker; нет Docker — wpx поставит его сам (Debian/Ubuntu).
  const awgOk = f?.arch === "x86_64" && (!!f?.docker || !!f?.apt);
  const guarded = !!f && f.cc === "bbr" && (f.autoupd || !f.apt) && (f.f2b || !f.apt);
  // Сайт-прикрытие VLESS и XHTTP: заблокируют его в России — VLESS перестанет проходить.
  const cover = s.vless?.dest ?? s.xhttp?.dest ?? "";
  const covers = (st.covers ?? []).filter((d) => d !== cover);
  const go = await modal(`VPN на «${s.name}»`, `
    <p>wpx поставит sing-box ${esc(st.version)} (${f?.docker ? "в Docker" : "служба systemd, бинарник с проверкой sha256"}) и AmneziaWG в отдельном контейнере, соберёт конфиги и проверит их до запуска. Если что-то пойдёт не так — вернёт прежнее.</p>
    <label class="chk"><input type="checkbox" id="miVless" ${fresh || s.vless ? "checked" : ""}><span><b>VLESS + Reality</b> — основной: маскируется под обычный HTTPS к крупному сайту (TCP)</span></label>
    <label class="chk"><input type="checkbox" id="miHy2" ${fresh || s.hy2 ? "checked" : ""}><span><b>Hysteria2</b> — быстрый на плохих каналах (UDP; у части провайдеров режут)</span></label>
    <label class="chk${boxOk ? "" : " off"}"><input type="checkbox" id="miXhttp" ${boxOk && (fresh || s.xhttp) ? "checked" : ""} ${boxOk ? "" : "disabled"}><span><b>VLESS + XHTTP + Reality</b> — самый стойкий к DPI транспорт: запрос и ответ разными потоками, без рисунка «TLS в TLS» (TCP, Xray)</span></label>
    <label class="chk${awgOk ? "" : " off"}"><input type="checkbox" id="miAwg" ${awgOk && (fresh || s.awg) ? "checked" : ""} ${awgOk ? "" : "disabled"}><span><b>AmneziaWG</b> — WireGuard с обфускацией, очень быстрый (UDP)${!awgOk ? " — пока только для x86_64" : f?.docker ? "" : ". Docker на сервере нет — wpx поставит его сам"}</span></label>
    <label class="chk${boxOk ? "" : " off"}"><input type="checkbox" id="miMtg" ${boxOk && s.mtproxy ? "checked" : ""} ${boxOk ? "" : "disabled"}><span><b>MTProxy для Telegram</b> — ссылка открывается прямо в Telegram, без VPN-приложения; маскируется под обычный HTTPS (FakeTLS)</span></label>
    <label class="field mi-cover"><span>Сайт-прикрытие VLESS и XHTTP — под соединение с ним маскируется VPN</span>
      <select id="miCover">${cover ? `<option value="">оставить ${esc(cover)}</option>` : '<option value="">подобрать самый быстрый с сервера</option>'}
        ${cover ? '<option value="auto">подобрать другой — самый быстрый с сервера</option>' : ""}
        ${covers.map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join("")}</select></label>
    ${cover ? `<p class="note">Если ${esc(cover)} заблокируют в России, VLESS и XHTTP перестанут проходить — смените сайт здесь. После смены профиль на этом ПК обновится сам; на других ПК — «Обновить профиль», гостям — новые ссылки.</p>` : ""}
    <label class="chk${guarded ? " off" : ""}"><input type="checkbox" id="miHarden" ${guarded ? "disabled" : "checked"}><span><b>Рекомендуемая защита сервера</b>${guarded ? " — уже включена" : " — BBR (быстрее TCP), автообновления безопасности, защита SSH от перебора"}</span></label>
    <p class="note">Снятая галочка у уже установленного протокола — он будет убран. Потом wpx проверит всё с этого ПК и поставит в профиле первым то, что лучше проходит.${others.length ? ` Чужое на сервере (${esc(others.join(", "))}) не трогаю.` : ""}</p>`,
    fresh ? "Установить" : "Применить", "Отмена");
  if (!go) return;
  const vless = $<HTMLInputElement>("miVless").checked, hy2 = $<HTMLInputElement>("miHy2").checked, awg = $<HTMLInputElement>("miAwg").checked;
  const xhttp = $<HTMLInputElement>("miXhttp").checked, mtg = $<HTMLInputElement>("miMtg").checked;
  const hard = $<HTMLInputElement>("miHarden");
  const cov = $<HTMLSelectElement>("miCover").value;
  const r = await runOp(`Установка на «${s.name}»`, () => api.serverInstall(s.id, vless, hy2, awg, xhttp, mtg, hard.checked && !hard.disabled, cov), probeHtml);
  if (r) { st = r.state; render(); }
}

// ─── Профиль на этом ПК ──────────────────────────────────────────

async function makeProfile(s: ServerView) {
  const r = await runOp(`Профиль из «${s.name}»`, () => api.serverProfile(s.id), probeHtml);
  if (r) { st = r.state; render(); }
  return !!r;
}

/** «Профили» → «Свой сервер»: уже добавленный сервер без профиля на этом ПК
 *  или новый сервер. true — профиль создан. */
export async function chooseOwnServer(): Promise<boolean> {
  try { st = await api.servers(); } catch { /* пустой список */ }
  const ready = st.servers.filter(needsProfile);
  const goAdd = () => {
    document.querySelector<HTMLButtonElement>('[data-page="servers"]')?.click();
    openAdd();
  };
  if (!ready.length) { goAdd(); return false; }
  const pick = await new Promise<string | null>((res) => {
    let id: string | null = null;
    const body = $("modalBody");
    const onClick = (ev: Event) => {
      const b = (ev.target as HTMLElement).closest<HTMLButtonElement>("button[data-own]");
      if (!b) return;
      id = b.dataset.own ?? null;
      $<HTMLButtonElement>("modalCancel").click();
    };
    body.addEventListener("click", onClick);
    void modal("Свой сервер", `
      <p>VPN на этих серверах уже стоит — wpx соберёт профиль для этого ПК, сервер не меняется.</p>
      <div class="own-list">${ready.map((s) => `<button type="button" class="choice" data-own="${s.id}">
        <b>${esc(s.name)}</b><span>${esc(s.host)}${s.facts?.city ? ` · ${esc(s.facts.city)}` : ""} — сделать профиль</span></button>`).join("")}
        <button type="button" class="choice" data-own="new"><b>Новый сервер</b><span>подключиться к VPS по SSH и поставить VPN</span></button></div>`,
      null, "Отмена").then(() => {
      body.removeEventListener("click", onClick);
      res(id);
    });
  });
  if (!pick) return false;
  if (pick === "new") { goAdd(); return false; }
  const s = byId(pick);
  return s ? makeProfile(s) : false;
}

// ─── Каскад ──────────────────────────────────────────────────────

function openCascade() {
  $("srvAdd").hidden = true;
  $<HTMLInputElement>("saPass").value = "";
  $("srvCascade").hidden = false;
  const opt = (s: ServerView) => `<option value="${s.id}">${esc(s.name)} · ${esc(s.host)}${s.vless || s.hy2 || s.awg ? "" : " (VPN не установлен)"}</option>`;
  $("scEntry").innerHTML = st.servers.map(opt).join("");
  $("scExit").innerHTML = st.servers.map(opt).join("");
  $("scVia").innerHTML = `<option value="">подобрать, если нужен</option>` + st.servers.map(opt).join("");
  // По умолчанию: вход — доступный с ПК напрямую, выход — с VPN.
  const entry = st.servers.find((s) => !s.via) ?? st.servers[0];
  const exit = st.servers.find((s) => s.id !== entry?.id && (s.vless || s.hy2 || s.awg)) ?? st.servers.find((s) => s.id !== entry?.id);
  $<HTMLSelectElement>("scEntry").value = entry?.id ?? "";
  $<HTMLSelectElement>("scExit").value = exit?.id ?? "";
  $<HTMLSelectElement>("scVia").value = "";
  checkCascade();
}

function checkCascade() {
  const e = byId($<HTMLSelectElement>("scEntry").value), x = byId($<HTMLSelectElement>("scExit").value);
  const m = $<HTMLSelectElement>("scVia").value;
  const why = !e || !x ? "Нужно два сервера"
    : e.id === x.id ? "Первый прыжок и конечный — один и тот же сервер"
    : m && (m === e.id || m === x.id) ? "Промежуточный должен отличаться от первого прыжка и конечного"
    : !x.vless && !x.hy2 && !x.awg ? `На конечном «${x.name}» ещё не установлен VPN`
    : e.via ? `«${e.name}» — SSH только через другой сервер; ПК должен доставать первый прыжок напрямую` : "";
  $("scErr").textContent = why;
  $("scErr").hidden = !why;
  $<HTMLButtonElement>("scGo").disabled = !!why && !why.startsWith("«");
}

async function cascade(entry: string, exit: string, via: string | null = null) {
  const e = byId(entry), x = byId(exit), m = via ? byId(via) : undefined;
  if (!e || !x) return null;
  const r = await runOp(`Каскад ${e.name} → ${m ? `${m.name} → ` : ""}${x.name}`, () => api.serverCascade(entry, exit, via), probeHtml);
  if (r) { st = r.state; render(); }
  return r;
}

// ─── Поделиться доступом ─────────────────────────────────────────

const live = (g: Guest) => !g.off && (g.expires === null || g.expires > Date.now());
const day = (ms: number) => new Date(ms).toLocaleDateString(lang() === "ru" ? "ru-RU" : lang(), { day: "numeric", month: "long" });
const size = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} ГБ` : b >= 1e6 ? `${Math.round(b / 1e6)} МБ` : `${Math.round(b / 1e3)} КБ`);
function seen(sec: number) {
  const d = Date.now() / 1000 - sec;
  return d < 180 ? '<span class="on">в сети</span>' : d < 3600 ? `был ${Math.round(d / 60)} мин назад` : d < 86400 ? `был ${Math.round(d / 3600)} ч назад` : `был ${Math.round(d / 86400)} д назад`;
}
const TERMS: [number, string][] = [[0, "бессрочно"], [1, "1 день"], [7, "неделя"], [30, "месяц"], [90, "3 месяца"], [365, "год"]];
const termAt = (days: number) => (days ? Date.now() + days * 86_400_000 : null);

function guestRow(g: Guest, stat: GuestStat | undefined) {
  const on = live(g);
  const protos = [g.awg_ip ? "AmneziaWG" : "", g.vless ? "VLESS" : "", g.hy2 ? "Hysteria2" : ""].filter(Boolean).join(" · ");
  const expired = g.expires !== null && g.expires <= Date.now();
  const term = g.off ? (expired ? `срок истёк ${day(g.expires!)}` : "отключён")
    : expired ? '<span class="warn">срок истёк — отключу в ближайшие минуты</span>' : g.expires === null ? "бессрочно" : `до ${day(g.expires)}`;
  const net = stat ? (stat.handshake ? `${seen(stat.handshake)} · ↓ ${size(stat.tx)} ↑ ${size(stat.rx)}` : "ещё не подключался") : "";
  return `<li class="${on ? "" : "off"}">
    <div class="g-main"><b>${esc(g.name)}</b>
      <span class="g-sub">${protos}${g.via ? ` · через «${esc(byId(g.via)?.name ?? "вход")}»` : ""} · ${term}</span>
      ${net ? `<span class="g-sub">AmneziaWG: ${net}</span>` : ""}</div>
    <div class="acts-inline">
      ${on ? `<button class="btn sm" data-g="show" data-gid="${g.id}">QR и ссылки</button>` : ""}
      <button class="btn sm" data-g="${on ? "off" : "on"}" data-gid="${g.id}">${on ? "Отключить" : "Включить"}</button>
      <button class="btn sm danger" data-g="del" data-gid="${g.id}" title="Удалить доступ и его ключи">✕</button>
    </div></li>`;
}

function accessHtml(s: ServerView, stats: GuestStat[] | null) {
  const entries = st.servers.filter((e) => e.pipes.some((p) => p.to === s.id));
  const chk = (id: string, on: boolean, title: string, d: string) => on ? `<label class="chk"><input type="checkbox" id="${id}" checked><span><b>${title}</b> — ${d}</span></label>` : "";
  const rows = s.guests.map((g) => guestRow(g, stats?.find((x) => x.id === g.id))).join("");
  return `<p>Свой ключ для каждого: телефон, ноутбук, друг. Отключить одного — остальные и вы не заметите. Для другого ПК с wpx отметьте все протоколы — потом «Копировать всё для wpx».</p>
    ${rows ? `<ol class="g-list" id="gList">${rows}</ol>` : ""}
    <div class="g-new">
      <div class="row2">
        <label class="field"><span>Кому</span><input id="gName" maxlength="40" placeholder="Например: iPhone, Маша" autocomplete="off"></label>
        <label class="field"><span>Срок</span><select id="gTerm">${TERMS.map(([d, t]) => `<option value="${d}">${t}</option>`).join("")}</select></label>
      </div>
      ${chk("gAwg", !!s.awg, "AmneziaWG", "проще всего для телефона: приложение AmneziaWG, «+» → QR-код")}
      ${chk("gVless", !!s.vless, "VLESS + Reality", "v2RayTun, Happ, Streisand, Hiddify, Shadowrocket")}
      ${chk("gHy2", !!s.hy2, "Hysteria2", "быстрый на плохих каналах (UDP)")}
      ${entries.length ? `<div class="field"><span>Как человек будет подключаться</span>
        <label class="chk"><input type="radio" name="gVia" value="" checked><span><b>Напрямую к ${esc(s.name)}</b> — ${esc(s.host)}</span></label>
        ${entries.map((e) => `<label class="chk"><input type="radio" name="gVia" value="${e.id}"><span><b>Через каскад: ${esc(e.name)} → ${esc(s.name)}</b> — если ${esc(s.name)} у человека не открывается или его режут; сайты всё равно увидят IP ${esc(s.name)}</span></label>`).join("")}</div>` : ""}
      <div class="result bad" id="gErr" hidden></div>
      <button class="btn primary" data-g="new">Создать доступ</button>
    </div>`;
}

type GAct = { k: "new"; input: GuestInput } | { k: "show" | "off" | "on" | "del"; gid: string };

/** Окно доступа; закрывается выбранным действием (или null — «Закрыть»). */
function pickAccess(s: ServerView): Promise<GAct | null> {
  return new Promise((res) => {
    let act: GAct | null = null;
    let open = true;
    const body = $("modalBody");
    const onClick = (ev: Event) => {
      const b = (ev.target as HTMLElement).closest<HTMLButtonElement>("button[data-g]");
      if (!b) return;
      const k = b.dataset.g as GAct["k"];
      if (k === "new") {
        const v = (id: string) => !!document.querySelector<HTMLInputElement>(`#${id}:checked`);
        const input: GuestInput = {
          name: $<HTMLInputElement>("gName").value.trim(),
          vless: v("gVless"), hy2: v("gHy2"), awg: v("gAwg"),
          expires: termAt(Number($<HTMLSelectElement>("gTerm").value)),
          via: document.querySelector<HTMLInputElement>('input[name="gVia"]:checked')?.value || null,
        };
        const why = !input.vless && !input.hy2 && !input.awg ? "Выберите хотя бы один протокол"
          : s.guests.some((g) => g.name === input.name) ? `Доступ «${input.name}» уже есть — дайте другое имя` : "";
        if (why) { $("gErr").textContent = why; $("gErr").hidden = false; return; }
        act = { k, input };
      } else {
        act = { k, gid: b.dataset.gid ?? "" } as GAct;
      }
      $<HTMLButtonElement>("modalCancel").click();
    };
    body.addEventListener("click", onClick);
    void modal(`Поделиться «${s.name}»`, accessHtml(s, null), null, "Закрыть").then(() => {
      open = false;
      body.removeEventListener("click", onClick);
      res(act);
    });
    $<HTMLInputElement>("gName").focus();
    // Кто был в сети (AmneziaWG) — подгружается следом, по SSH.
    if (s.awg && s.guests.some((g) => g.awg_ip)) {
      api.guestStats(s.id).then((stats) => {
        const list = document.getElementById("gList");
        if (open && list) list.innerHTML = s.guests.map((g) => guestRow(g, stats.find((x) => x.id === g.id))).join("");
      }).catch(() => {});
    }
  });
}

const HOW: Record<ShareItem["kind"], string> = {
  awg: "Телефон: AmneziaWG → «+» → «Создать из QR-кода». ПК и Mac: AmneziaWG или AmneziaVPN → импорт файла .conf.",
  vless: "Приложение AmneziaWG этот QR не примет. iPhone и Android: v2RayTun, Happ или Streisand (бесплатно) → «+» → «Сканировать QR» или «Из буфера» после копирования.",
  hy2: "Приложение AmneziaWG этот QR не примет. Hiddify, Streisand, Happ или Shadowrocket → «+» → «Сканировать QR» или «Из буфера».",
  xhttp: "Приложение AmneziaWG этот QR не примет. v2RayTun, Happ, Hiddify или v2rayNG → «+» → «Сканировать QR» или «Из буфера».",
};

/** Всё сразу — для wpx на другом ПК: ссылки построчно, конфиг AWG — своим
 *  блоком через «---». Импорт сделает из этого один профиль. */
const forWpx = (sh: Share) =>
  [sh.items.filter((x) => x.kind !== "awg").map((x) => x.text).join("\n"), ...sh.items.filter((x) => x.kind === "awg").map((x) => x.text)]
    .filter(Boolean).join("\n---\n");

function shareHtml(sh: Share, i: number) {
  const it = sh.items[i];
  return `<p>Для <b>${esc(sh.guest.name)}</b> на «${esc(sh.server)}» (${esc(sh.host)}). Покажите QR камере телефона или скопируйте и отправьте.</p>
    ${sh.items.length > 1 ? `<div class="seg wide" id="shTabs">${sh.items.map((x, j) => `<button type="button" role="radio" data-i="${j}" aria-checked="${i === j}">${esc(x.title)}</button>`).join("")}</div>
      <p class="note">Каждый QR — для своего приложения: AmneziaWG — в приложении AmneziaWG, VLESS и Hysteria2 — в v2RayTun, Happ, Streisand.</p>` : ""}
    <div class="share">
      <div class="qr">${it.qr}</div>
      <div class="share-side">
        <b>${esc(it.title)}</b>
        <span class="g-sub">${esc(it.apps)}</span>
        <p class="note">${HOW[it.kind]}</p>
        <div class="acts-inline">
          <button class="btn sm" data-sh="copy">${it.kind === "awg" ? "Копировать конфиг" : "Копировать ссылку"}</button>
          ${it.kind === "awg" && inTauri ? '<button class="btn sm" data-sh="save">Сохранить .conf</button>' : ""}
        </div>
        <span class="note" id="shMsg"></span>
      </div>
    </div>
    ${sh.items.length > 1 ? `<div class="share-wpx"><div><b>На другой ПК с wpx — всё сразу</b>
      <span class="g-sub">«Профили» → «Добавить профиль» → «VPN по ссылке или конфигу» → вставить. Получится один профиль со всеми протоколами — wpx сам выберет лучший.</span>
      <span class="note" id="shAllMsg"></span></div>
      <button class="btn sm" data-sh="all">Копировать всё для wpx</button></div>` : ""}
    <p class="note">Это личный ключ: у кого QR — тот и подключится. Отключить можно в любой момент здесь же.</p>`;
}

async function showShare(id: string, sh: Share) {
  let i = 0;
  const body = $("modalBody");
  const onClick = async (ev: Event) => {
    const t = ev.target as HTMLElement;
    const tab = t.closest<HTMLButtonElement>("#shTabs button");
    if (tab) { i = Number(tab.dataset.i); body.innerHTML = shareHtml(sh, i); return; }
    const b = t.closest<HTMLButtonElement>("button[data-sh]");
    if (!b) return;
    const msg = (m: string) => { const el = document.getElementById("shMsg"); if (el) el.textContent = m; };
    try {
      if (b.dataset.sh === "copy") { await navigator.clipboard.writeText(sh.items[i].text); msg("Скопировано"); }
      if (b.dataset.sh === "all") {
        await navigator.clipboard.writeText(forWpx(sh));
        $("shAllMsg").textContent = `Скопировано: ${sh.items.map((x) => x.title).join(", ")}. Вставьте в wpx на другом ПК — это ключи, не публикуйте их.`;
      }
      if (b.dataset.sh === "save") msg(`Сохранено: ${await api.guestSaveConf(id, sh.guest.id)}`);
    } catch (e) { msg(String(e)); }
  };
  body.addEventListener("click", onClick);
  await modal(`Доступ «${sh.guest.name}»`, shareHtml(sh, i), null, "Готово");
  body.removeEventListener("click", onClick);
}

/** Новый срок для истёкшего доступа, который включают снова. */
async function askTerm(g: Guest): Promise<number | null | undefined> {
  const go = await modal(`Включить «${g.name}»`, `<p>Срок прошлого доступа истёк. На сколько включить?</p>
    <label class="field"><span>Срок</span><select id="gTerm2">${TERMS.map(([d, t]) => `<option value="${d}" ${d === 30 ? "selected" : ""}>${t}</option>`).join("")}</select></label>`, "Включить", "Отмена");
  return go ? termAt(Number($<HTMLSelectElement>("gTerm2").value)) : undefined;
}

/** MTProxy: ссылка и QR для Telegram — одна на сервер. */
async function telegram(s: ServerView) {
  try {
    const l = await api.serverMtproxyLink(s.id);
    const done = modal(`Telegram через «${s.name}»`, `
      <div class="share-item"><div class="qr">${l.qr}</div>
        <div><p>Отсканируйте камерой телефона или откройте ссылку — Telegram сам предложит подключить прокси. Работает только для Telegram; маскируется под обычный HTTPS к ${esc(s.mtproxy?.domain ?? "")}.</p>
        <p class="mono share-link">${esc(l.web)}</p>
        <button type="button" class="btn sm" id="tgCopy">Скопировать ссылку</button></div></div>
      <p class="note">Ссылка одна на всех: кому дали — у того работает. Чтобы отозвать, снимите и снова поставьте MTProxy в «Изменить VPN» — секрет сменится.</p>`,
      null, "Закрыть");
    const copied = (t: string) => { const b = document.getElementById("tgCopy"); if (b) b.textContent = t; };
    $("tgCopy").addEventListener("click", () => void navigator.clipboard.writeText(l.web).then(() => copied("Скопировано"), () => copied("Не скопировалось")));
    await done;
  } catch (e) {
    await modal("Telegram", `<div class="result bad">${esc(String(e))}</div>`, null, "Закрыть");
  }
}

async function access(id: string) {
  for (;;) {
    const s = byId(id);
    if (!s) return;
    const a = await pickAccess(s);
    if (!a) return;
    if (a.k === "new") {
      const r = await runOp(`Доступ на «${s.name}»`, () => api.guestAdd(id, a.input), null);
      if (r) { st = r.state; render(); }
      if (r?.share) await showShare(id, r.share);
      continue;
    }
    const g = s.guests.find((x) => x.id === a.gid);
    if (!g) continue;
    if (a.k === "show") {
      try { await showShare(id, await api.guestShare(id, g.id)); }
      catch (e) { await modal("Не получилось", `<div class="result bad">${esc(String(e))}</div>`, "Понятно", null); }
      continue;
    }
    if (a.k === "del" && !(await modal("Удалить доступ?", `<p>«${esc(g.name)}» больше не подключится, ключи удалятся. Вернуть можно только новым доступом с новым QR.</p>`, "Удалить", "Отмена"))) continue;
    let expires = g.expires;
    if (a.k === "on" && g.expires !== null && g.expires <= Date.now()) {
      const t = await askTerm(g);
      if (t === undefined) continue;
      expires = t;
    }
    const r = await runOp(`«${g.name}»`, () => a.k === "del" ? api.guestRemove(id, g.id) : api.guestUpdate(id, g.id, a.k === "off", expires));
    if (r) { st = r; render(); }
  }
}

// ─── Где рвётся ──────────────────────────────────────────────────

const VMK = { ok: "✓", bad: "!", warn: "!", skip: "·" } as const;
const VCLS = { ok: "ok", bad: "bad", warn: "unk", skip: "unk" } as const;

function checkHtml(r: ServerCheck) {
  return `<div class="result ${r.verdict === "ok" ? "ok" : "bad"}">${esc(r.summary)}</div>
    <ul class="guard leaks">${r.steps.map((x) => `<li class="${VCLS[x.verdict]}"><span class="mk">${VMK[x.verdict]}</span>
      <span><b>${esc(x.title)}</b><span class="d">${esc(x.detail)}</span></span></li>`).join("")}</ul>
    ${r.advice.length ? `<div class="advice"><b>Что сделать</b>${r.advice.map((a, i) => a.kind === "hoster"
      ? `<p class="note">• ${esc(a.text)}</p>`
      : `<button type="button" class="btn${i === 0 ? " primary" : ""}" data-adv="${i}">${esc(a.text)}</button>`).join("")}</div>` : ""}`;
}

/** Проверка пути до своего сервера и (по желанию) что сделать. */
export async function checkServer(id: string) {
  if (!st.servers.length) { try { st = await api.servers(); } catch { /* пусто */ } }
  const s = byId(id);
  if (!s) return;
  void modal(`Где рвётся: «${s.name}»`, `<ol class="oplog"><li class="step live"><span class="mk">…</span><span>SSH, службы VPN на сервере, его интернет, протоколы с ПК (с проверкой на заморозку) — до 30 секунд</span></li></ol>`, null, null);
  let r: ServerCheck;
  try { r = await api.serverCheck(id); } catch (e) { await modal("Не получилось", `<div class="result bad">${esc(String(e))}</div>`, "Понятно", null); return; }
  let pick: number | null = null;
  const body = $("modalBody");
  const onClick = (ev: Event) => {
    const b = (ev.target as HTMLElement).closest<HTMLButtonElement>("[data-adv]");
    if (b) { pick = Number(b.dataset.adv); $<HTMLButtonElement>("modalCancel").click(); }
  };
  body.addEventListener("click", onClick);
  await modal(`Где рвётся: «${s.name}»`, checkHtml(r), null, "Закрыть");
  body.removeEventListener("click", onClick);
  const a = pick === null ? null : r.advice[pick];
  if (!a) return;
  if (a.kind === "cascade" && a.entry) await cascade(a.entry, id);
  if (a.kind === "move") await moveServer(id);
  if (a.kind === "redeploy") {
    const x = await runOp(`Перезапуск VPN на «${s.name}»`, () => api.serverInstall(id, !!s.vless, !!s.hy2, !!s.awg, !!s.xhttp, !!s.mtproxy, false), probeHtml);
    if (x) { st = x.state; render(); }
  }
}

// ─── Переезд ─────────────────────────────────────────────────────

async function moveServer(id: string) {
  const s = byId(id);
  if (!s) return;
  const free = st.servers.filter((x) => x.id !== id && !x.vless && !x.hy2 && !x.awg && !x.pipes.length);
  const entries = st.servers.filter((x) => x.id !== id && !x.via && !x.pipes.some((p) => p.to === id));
  const alt = entries.length ? `<p class="note">Если сервер просто заблокировали — можно не переезжать, а пустить через вход:
    ${entries.map((e) => `<button type="button" class="btn sm" data-alt="${e.id}">Каскад через «${esc(e.name)}»</button>`).join(" ")}</p>` : "";
  let altPick: string | null = null;
  const body = $("modalBody");
  const onAlt = (ev: Event) => {
    const b = (ev.target as HTMLElement).closest<HTMLButtonElement>("[data-alt]");
    if (b) { altPick = b.dataset.alt!; $<HTMLButtonElement>("modalCancel").click(); }
  };
  body.addEventListener("click", onAlt);
  try {
    if (!free.length) {
      await modal(`Переезд «${s.name}»`, `<p>Нужен новый сервер: «Добавить сервер» → IP и пароль. Установку VPN на нём можно пропустить — при переезде wpx поставит всё сам, с прежними ключами.</p>${alt}`, null, "Понятно");
    } else {
      // План к последнему выбранному серверу; ответ на прежний выбор — не нужен.
      let planSeq = 0;
      const draw = async (to: string) => {
        const seq = ++planSeq;
        let err: string | null;
        let html: string;
        try {
          const p = await api.serverMovePlan(id, to);
          err = p.error;
          html = p.error ? "" : `<ol class="mv-steps">${p.steps.map((x) => `<li>${esc(x)}</li>`).join("")}</ol>`;
        } catch (e) { err = String(e); html = ""; }
        if (seq !== planSeq) return;
        // Окно переезда уже закрыто — его кнопки не трогаем.
        const el = document.getElementById("mvPlan");
        if (!el || $("modal").hidden) return;
        el.innerHTML = err ? `<div class="result bad">${esc(err)}</div>` : html;
        $<HTMLButtonElement>("modalOk").disabled = !!err;
      };
      const go = modal(`Переезд «${s.name}»`, `
        <label class="field"><span>Куда</span><select id="mvTo">${free.map((x) => `<option value="${x.id}">${esc(x.name)} · ${esc(x.host)}</option>`).join("")}</select></label>
        <div id="mvPlan" class="note">Составляю план…</div>
        <label class="chk"><input type="checkbox" id="mvClean"><span><b>Убрать всё со старого сервера</b> после переезда (если он доступен); иначе он продолжит работать, как работал</span></label>
        ${alt}`, "Переехать", "Отмена");
      $<HTMLSelectElement>("mvTo").addEventListener("change", (e) => void draw((e.target as HTMLSelectElement).value));
      void draw(free[0].id);
      const yes = await go;
      $<HTMLButtonElement>("modalOk").disabled = false;
      if (yes) {
        const to = $<HTMLSelectElement>("mvTo").value, clean = $<HTMLInputElement>("mvClean").checked;
        const r = await runOp(`Переезд «${s.name}»`, () => api.serverMove(id, to, clean), probeHtml);
        if (r) { st = r.state; render(); }
        return;
      }
    }
  } finally {
    body.removeEventListener("click", onAlt);
  }
  if (altPick) await cascade(altPick, id);
}

// ─── Действия на карточках ───────────────────────────────────────

async function onCard(ev: Event) {
  const b = (ev.target as HTMLElement).closest<HTMLButtonElement>("button[data-act]");
  if (!b) return;
  const s = byId(b.dataset.id ?? "");
  if (!s) return;
  const act = b.dataset.act;
  if (act === "install") await install(s);
  if (act === "profile") await makeProfile(s);
  if (act === "care") await care(s);
  if (act === "access") await access(s.id);
  if (act === "tg") await telegram(s);
  if (act === "check") await checkServer(s.id);
  if (act === "inspect") {
    const r = await runOp(`Осмотр «${s.name}»`, () => api.serverInspect(s.id));
    if (r) { st = r; render(); }
  }
  if (act === "uninstall") {
    if (!(await modal("Убрать с сервера?", `<p>С «${esc(s.name)}» будет удалено всё, что ставил wpx: sing-box и папка /opt/wpx. Профили этого сервера тоже удалятся. Чужое (AmneziaVPN и др.) не трогаю.</p>`, "Убрать", "Отмена"))) return;
    const r = await runOp(`Удаление с «${s.name}»`, () => api.serverUninstall(s.id));
    if (r) { st = r; render(); }
  }
  if (act === "forget") {
    if (!(await modal("Забыть сервер?", `<p>wpx уберёт свой ключ с «${esc(s.name)}» и забудет сервер. Установленное на нём продолжит работать, профили останутся.</p>`, "Забыть", "Отмена"))) return;
    const r = await runOp(`«${s.name}»`, () => api.serverForget(s.id));
    if (r) { st = r; render(); }
  }
  const to = b.dataset.to ?? "";
  if (act === "cdel") {
    const x = byId(to);
    if (!(await modal("Убрать каскад?", `<p>Труба на «${esc(s.name)}» к «${esc(x?.name ?? to)}» будет удалена вместе с профилем каскада.</p>`, "Убрать", "Отмена"))) return;
    const r = await runOp("Убираю каскад", () => api.serverCascadeRemove(s.id, to));
    if (r) { st = r; render(); }
  }
  if (act === "cswap") {
    // Сначала новый каскад, потом старый убираем — без момента «ничего не работает».
    const r = await cascade(to, s.id);
    if (r) {
      const rr = await runOp("Убираю прежний каскад", () => api.serverCascadeRemove(s.id, to));
      if (rr) { st = rr; render(); }
    }
  }
}

// ─── Вход ────────────────────────────────────────────────────────

export function initServers(a: Api) {
  api = a;
  api.onServerLog((l) => sink?.(l));
  api.onServersChanged(() => void load());
  $("btnSrvAdd").addEventListener("click", openAdd);
  $("btnSrvCascade").addEventListener("click", openCascade);
  $("saCancel").addEventListener("click", () => { $("srvAdd").hidden = true; $<HTMLInputElement>("saPass").value = ""; });
  $("saForm").addEventListener("submit", (e) => void submitAdd(e));
  document.querySelectorAll<HTMLButtonElement>("#saAuth button").forEach((b) => b.addEventListener("click", () => setAuth(b.dataset.v as "pass" | "key")));
  $("scEntry").addEventListener("change", checkCascade);
  $("scExit").addEventListener("change", checkCascade);
  $("scVia").addEventListener("change", checkCascade);
  $("scSwap").addEventListener("click", () => {
    const e = $<HTMLSelectElement>("scEntry"), x = $<HTMLSelectElement>("scExit");
    [e.value, x.value] = [x.value, e.value];
    checkCascade();
  });
  $("scCancel").addEventListener("click", () => { $("srvCascade").hidden = true; });
  $("scGo").addEventListener("click", async () => {
    const r = await cascade($<HTMLSelectElement>("scEntry").value, $<HTMLSelectElement>("scExit").value, $<HTMLSelectElement>("scVia").value || null);
    if (r) $("srvCascade").hidden = true;
  });
  $("srvCards").addEventListener("click", (e) => void onCard(e));
  void load();
}

export function onServersShown() {
  void load();
}

/** Ушли с вкладки — пароль SSH в поле не оставляем. */
export function onServersLeft() {
  $<HTMLInputElement>("saPass").value = "";
}
