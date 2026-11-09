import type { FullState, Health, LogEvent, NotchAnchor, Outage, Prefs, Snapshot } from "./core/types";
import type { Api } from "./core/api";
import { tauriApi } from "./core/api";
import { css, drawErrors, drawPulse, drawSpark } from "./core/charts";
import { initPages, onPageShown, onSnapshot } from "./app/pages";
import { checkServer, initServers, onServersLeft, onServersShown } from "./app/servers";
import { initRules, onRulesShown } from "./app/rules";
import { addDropped, initGames, onGamesLeft, onGamesShown, openGame } from "./app/games";
import { initDrop, resolveDrop } from "./core/drop";
import { initStreamer, setStreamer, streamerOn } from "./core/streamer";
import { initDiag } from "./app/diag";
import { initTraffic, showTraffic } from "./app/traffic";
import { $, esc, modal, NOTCH_AT, onOpChange, opRunning, runEngineOp, STEPS_RESTART } from "./core/ui";
import { ICON } from "./core/icons";
import { isProxy, PROTO, renderRoute, SHORT } from "./app/route";
import { protoId, showProtocols } from "./app/protocols";
import { autoCheckUpdate, setUpdateAuto, updateAuto, wireUpdateRow } from "./app/update";
import { initSpotlight } from "./core/fx";
import { navFx } from "./app/navfx";
import { ACCENTS, applyTheme, BASES, defaultTheme, initTheme, loadTheme, MOTIONS, PULSES, saveTheme, type Theme } from "./theme/theme";
import { feedScene, GROUPS, mountScene, SCENES, type Mounted } from "./theme/scenes";
import { backendLocale, initI18n, lang, LANGS, setLang } from "./core/i18n";

const inTauri = "__TAURI_INTERNALS__" in window;

// ─── Состояние на стороне окна ───────────────────────────────────
let snap: Snapshot | null = null;
let latency: [number, number | null][] = [];
let traffic: [number, number, number][] = [];
let errMinutes: [number, number][] = [];
let outages: Outage[] = [];
let range = 900_000;
let hoverX: number | null = null;

// ─── Форматирование ──────────────────────────────────────────────
const two = (n: number) => String(n).padStart(2, "0");
const hhmm = (t: number) => { const d = new Date(t); return `${two(d.getHours())}:${two(d.getMinutes())}`; };
const hhmmss = (t: number) => `${hhmm(t)}:${two(new Date(t).getSeconds())}`;
function dur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} с`;
  if (s < 3600) return `${Math.floor(s / 60)} мин ${s % 60} с`;
  const h = Math.floor(s / 3600);
  if (h < 48) return `${h} ч ${Math.floor((s % 3600) / 60)} мин`;
  return `${Math.floor(h / 24)} д ${h % 24} ч`;
}
function rate(bps: number): string {
  if (bps < 1024) return `${bps} Б/с`;
  if (bps < 1024 ** 2) return `${(bps / 1024).toFixed(bps < 10240 ? 1 : 0)} КБ/с`;
  return `${(bps / 1024 ** 2).toFixed(1)} МБ/с`;
}
function bytes(b: number): string {
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(0)} КБ`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(0)} МБ`;
  return `${(b / 1024 ** 3).toFixed(2)} ГБ`;
}
function dayLabel(t: number): string {
  const d = new Date(t), now = new Date();
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, now)) return `сегодня ${hhmm(t)}`;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (same(d, y)) return `вчера ${hhmm(t)}`;
  return `${two(d.getDate())}.${two(d.getMonth() + 1)} ${hhmm(t)}`;
}

const STATE_TEXT: Record<Health, string> = {
  starting: "Проверяем связь",
  online: "Подключено",
  slow: "Связь замедлена",
  down: "Нет связи",
  engine_off: "Движок остановлен",
};
const PILL_TEXT: Record<Health, string> = {
  starting: "Проверяем",
  online: "Стабильно",
  slow: "Медленно",
  down: "Нет ответа",
  engine_off: "Движок стоит",
};

// ─── Рендер ──────────────────────────────────────────────────────
function renderStatus(s: Snapshot) {
  const b = document.body;
  // На паузе — серый вид, как у остановленного движка: туннель не в работе.
  b.dataset.health = s.paused ? "engine_off" : s.health;
  if (s.on_reserve && s.reserve) b.dataset.reserve = "1"; else delete b.dataset.reserve;
  const reserve = !!(s.on_reserve && s.reserve);
  $("stateLabel").textContent = s.paused ? "VPN на паузе" : reserve ? "Работаем через резерв" : STATE_TEXT[s.health];
  $("stIco").innerHTML = s.health === "online" && !reserve && !s.paused ? ICON.check
    : s.health === "engine_off" || s.paused ? ICON.off : s.health === "starting" ? ICON.wait : ICON.alert;
  $("serverLabel").textContent = s.server ? `${s.server}${s.profile ? ` · ${s.profile}` : ""}` : "сервер не задан";

  const vpn = s.legs.length > 0 && !isProxy(s);
  const cascade = s.legs.some((l) => l.role === "entry");
  $("ovKicker").textContent = s.legs_trial ? "Пробный запуск" : !s.legs.length ? "wpx" : vpn ? (cascade ? "Каскад" : "Личный VPN") : "Прокси";
  const meta: string[] = [];
  if (s.profile) meta.push(`<span>Профиль: <b>${esc(s.profile)}</b></span>`);
  if (s.legs_trial) meta.push(`<span>пробный запуск <b>«${esc(s.legs_trial)}»</b></span>`);
  if (s.engine_kind !== "wpx") meta.push("<span>движок не установлен</span>");
  $("ovMeta").innerHTML = meta.join("");

  // Протокол в работе и что в запасе.
  const active = s.legs.find((l) => l.active && l.role === "exit") ?? s.legs.find((l) => l.active);
  const spare = s.legs.filter((l) => !l.active && l.role === "exit" && l.result.ok).length;
  const chips: string[] = [];
  if (active) chips.push(`<span class="pchip">${ICON.bolt}${PROTO[active.kind] ?? esc(active.kind)}</span>`);
  if (spare) chips.push(`<span class="pchip res" title="Движок сам перейдёт на живую точку, если эта перестанет отвечать">${ICON.cycle}${spare === 1 ? "ещё 1 точка" : `ещё ${spare} точки`}</span>`);
  if (s.reserve) chips.push(`<span class="pchip ${reserve ? "warn" : "res"}" title="Если VPN не отвечает, движок за секунды уходит на этот профиль и сам возвращается">${ICON.shield}${reserve ? "сейчас через" : "резерв"} «${esc(s.reserve[1])}»</span>`);
  $("ovChips").innerHTML = chips.length ? `<span class="lbl">Протокол:</span>${chips.join("")}` : "";

  const lat = $("latencyValue");
  const ms = s.health === "down" || s.health === "engine_off" ? null : s.last_ms;
  lat.textContent = ms !== null ? String(ms) : "—";
  lat.parentElement!.classList.toggle("none", ms === null);
  $("latPill").textContent = s.paused ? "Напрямую" : PILL_TEXT[s.health];

  const since = dur(s.t - s.health_since);
  let sub = "";
  switch (s.health) {
    case "online": sub = reserve ? `VPN не отвечает — трафик идёт через «${s.reserve![1]}», вернусь сам` : `Стабильно уже ${since}`; break;
    case "slow": sub = `Отклик выше ${s.slow_ms} мс или были потери · ${since}`; break;
    case "down": sub = `${s.cause ?? "Туннель не пропускает трафик"} · ${since}`; break;
    case "engine_off": sub = `mihomo не запущен · ${since}`; break;
    default: sub = s.config_err ?? "Первые замеры через пару секунд";
  }
  if (s.paused) sub = s.pause_until
    ? `Интернет идёт напрямую, мимо туннеля. VPN вернётся сам в ${hhmm(s.pause_until)} — или раньше по «Включить VPN»`
    : "Интернет идёт напрямую, мимо туннеля. VPN вернётся по «Включить VPN» или при перезапуске движка";
  $("stateSub").textContent = sub;
  // Всё в порядке — без лишней строки; при проблеме — причина.
  $("stateSub").hidden = s.health === "online" && !reserve && !s.paused;
  // Пауза — только у установленного и запущенного движка.
  const pb = $<HTMLButtonElement>("btnPause");
  pb.hidden = s.engine_kind !== "wpx" || (!s.engine.running && !s.paused);
  pb.textContent = s.paused ? "Включить VPN" : "Пауза";
  pb.title = s.paused ? "Вернуть трафик в туннель" : "Временно пустить весь трафик напрямую — без прав администратора, kill switch не мешает";
  pb.classList.toggle("primary", s.paused);
  pb.disabled = s.busy || opRunning();

  $<HTMLButtonElement>("btnRestart").disabled = s.busy || opRunning();
  $("btnWhere").hidden = !s.server_id;
  $("btnWhere").classList.toggle("primary", !!s.server_id && (s.health === "down" || s.on_reserve));
  // Одна кнопка — совсем перейти на резервный профиль (обычно прокси).
  const rb = $<HTMLButtonElement>("btnReserve");
  rb.hidden = !s.reserve;
  if (s.reserve) {
    rb.textContent = `На «${s.reserve[1]}»`;
    rb.title = `Сделать «${s.reserve[1]}» рабочим профилем — с проверкой туннеля и откатом`;
    rb.classList.toggle("primary", s.on_reserve || s.health === "down");
    rb.disabled = s.busy || opRunning();
  }
}

function renderMap(s: Snapshot) {
  renderRoute($("route"), s);
}

function renderLegs(s: Snapshot) {
  const max = Math.max(1500, ...s.legs.map((l) => l.result.ready_ms ?? 0));
  const proxy = isProxy(s);
  $("legsHint").textContent = proxy ? "рукопожатие с прокси" : "ping — до сервера напрямую · тест — запрос через точку";
  // ping — у сервера, а не у точки: где TCP мерить нельзя (UDP), берём у соседней.
  const pingOf = (server: string) => s.legs.find((x) => x.server === server && x.result.connect_ms != null)?.result.connect_ms ?? null;
  const rows = s.legs.map((l) => {
    const cls = !l.at ? "" : l.result.ok ? "ok" : "bad";
    const ready = l.result.ready_ms ?? 0, conn = l.result.connect_ms ?? 0;
    const ms = !l.at ? "…" : l.result.ok ? `${ready} мс` : "—";
    const sub = !l.at
      ? "ещё не проверялся"
      : l.result.ok
        ? `TCP ${conn} мс · готов ${ready} мс · ${hhmmss(l.at)}`
        : `${l.result.err ?? "ошибка"} · ${hhmmss(l.at)}`;
    const plain = l.name === "HTTP" || l.name === "SOCKS5";
    const ping = pingOf(l.server);
    const vsub = !l.at ? "ещё не проверялась" : l.result.ok
      ? `${ping !== null ? `ping ${ping} мс · ` : ""}тест ${ready} мс · ${hhmmss(l.at)}`
      : `${l.result.err ?? "ошибка"} · ${hhmmss(l.at)}`;
    return `<div class="leg-row ${cls}">
      <div class="leg-name" data-proto="${protoId(l.kind, l.net)}" title="${esc(l.label)} — что это за протокол"><span class="dot"></span>${plain ? (l.name === "SOCKS5" ? "SOCKS" : "HTTP") : `${l.role === "entry" ? "вх " : ""}${l.net === "xhttp" ? "XHTTP" : SHORT[l.kind] ?? esc(l.kind)}`}</div>
      <div class="bar"><i class="c" style="width:${l.result.ok ? (conn / max) * 100 : 0}%"></i><i style="width:${l.result.ok ? (ready / max) * 100 : l.at ? 100 : 0}%;opacity:.85"></i></div>
      <div class="leg-ms" title="${plain ? "рукопожатие с прокси" : "тест: запрос через эту точку — подключение и ответ; это не ping, а сравнение точек между собой"}">${ms}</div>
      <div class="leg-sub">${l.active ? '<span class="badge">в работе</span>' : ""}<span>${plain ? `:${l.port} · ${esc(sub)}` : `${esc(l.label)} · ${esc(vsub)}`}</span></div>
    </div>`;
  });
  const [h, so] = proxy ? s.legs : [];
  let note = "";
  if (h?.result.ok && so?.result.ok && h.result.ready_ms !== null && so.result.ready_ms !== null) {
    const d = so.result.ready_ms - h.result.ready_ms;
    if (Math.abs(d) > 80) note = `${d > 0 ? "HTTP" : "SOCKS"} быстрее на ${Math.abs(d)} мс`;
  }
  $("legs").innerHTML = rows.join("") + (note ? `<div class="legs-note">${note}</div>` : "") || `<div class="empty">точек пока нет</div>`;
}

function renderGuard(s: Snapshot) {
  const ul = $("guard");
  const bad = s.guard.filter((g) => g.ok === false).length;
  const unknown = s.guard.filter((g) => g.ok === null).length;
  const m = $("mProt");
  if (!s.guard.length) {
    ul.innerHTML = `<li class="empty">проверяем…</li>`;
    m.textContent = "Проверяем"; m.className = "unk";
  } else {
    ul.innerHTML = s.guard.map((g) => {
      const cls = g.ok === true ? "ok" : g.ok === false ? "bad" : "unk";
      const mk = g.ok === true ? "✓" : g.ok === false ? "!" : "?";
      return `<li class="${cls}" title="${esc(g.detail)}"><span class="mk">${mk}</span><span class="lbl">${esc(g.label)}</span></li>`;
    }).join("");
    m.textContent = bad ? `Проблем: ${bad}` : "Активна";
    m.className = bad ? "bad" : "ok";
  }
  $("mProtSub").parentElement!.parentElement!.title = s.guard_at ? `проверено ${hhmm(s.guard_at)}` : "";
  $("mProtSub").textContent = s.guard_at ? `проверено ${hhmm(s.guard_at)}${unknown && !bad ? ` · не проверить: ${unknown}` : ""}` : "";
  $("guardAt").textContent = bad ? `проблем: ${bad}` : s.guard_at ? `проверено ${hhmm(s.guard_at)}` : "";
}

function renderFlow(s: Snapshot) {
  $("rx").textContent = s.traffic.found ? rate(s.traffic.rx_bps) : "—";
  $("tx").textContent = s.traffic.found ? rate(s.traffic.tx_bps) : "—";
  $("rxTotal").textContent = s.traffic.found ? `всего ${bytes(s.traffic.rx_total)}` : "";
  $("txTotal").textContent = s.traffic.found ? `всего ${bytes(s.traffic.tx_total)}` : "";
  $("mIp").textContent = s.ip ?? "—";
  $("mIpSub").textContent = !s.ip ? "ещё не узнали" : s.on_reserve && s.reserve ? `через резерв «${s.reserve[1]}»` : s.ip_expected ? "этот IP видят сайты" : "⚠ не тот адрес, что ждали";
}

function evClass(e: LogEvent) {
  if (e.kind === "engine_start" || (e.kind === "link" && e.text.includes("подключён"))) return "ok";
  if (e.kind === "link" || e.kind === "net_startup" || e.kind === "engine_stop" || e.kind === "path_switch" || e.kind === "heal") return "info";
  return "err";
}

function renderEvents(s: Snapshot) {
  const ol = $("events");
  if (!s.events.length) { ol.innerHTML = `<li class="empty">событий нет — и это хорошо</li>`; return; }
  ol.innerHTML = s.events.slice(0, 60).map((e) => `
    <li class="${evClass(e)}">
      <time>${hhmm(e.t)}</time>
      <div><span class="ev-text">${esc(e.text)}</span>${e.count > 1 ? `<span class="ev-count">×${e.count}</span>` : ""}
      ${e.dest ? `<span class="ev-dest">${esc(e.dest)}</span>` : ""}</div>
    </li>`).join("");
}

function renderOutages(s: Snapshot) {
  const list = [...outages];
  if (s.current_outage && !list.some((o) => o.start === s.current_outage!.start)) list.unshift(s.current_outage);
  const day = Date.now() - 86_400_000;
  const total = list.filter((o) => o.start > day).reduce((a, o) => a + ((o.end ?? Date.now()) - o.start), 0);
  $("outageSum").textContent = list.length ? `за сутки ${dur(total)}` : "";
  const ol = $("outages");
  if (!list.length) { ol.innerHTML = `<li class="empty">пока не было</li>`; return; }
  ol.innerHTML = list.slice(0, 30).map((o) => `
    <li class="${o.end ? "" : "live"}">
      <span class="when">${dayLabel(o.start)}</span>
      <span class="dur">${o.end ? dur(o.end - o.start) : `идёт ${dur(Date.now() - o.start)}`}</span>
      <span class="why">${esc(o.cause)}</span>
    </li>`).join("");
}

function renderPulse() {
  if (!snap) return;
  const canvas = $<HTMLCanvasElement>("pulseChart");
  const view = drawPulse(canvas, latency, range, Date.now(), snap.slow_ms, hoverX);
  const tip = $("pulseTip");
  const p = hoverX !== null ? view.pick(hoverX) : null;
  if (p) {
    tip.hidden = false;
    tip.textContent = `${hhmmss(p[0])} · ${p[1] === null ? "нет ответа" : `${p[1]} мс`}`;
    tip.style.left = `${Math.min(Math.max(hoverX! - 50, 40), canvas.clientWidth - 140)}px`;
  } else tip.hidden = true;

  const vis = latency.filter(([t]) => t >= Date.now() - range);
  const ok = vis.filter(([, v]) => v !== null).map(([, v]) => v as number).sort((a, b) => a - b);
  const loss = vis.length ? ((vis.length - ok.length) / vis.length) * 100 : 0;
  const med = ok.length ? ok[Math.floor(ok.length / 2)] : null;
  const p95 = ok.length ? ok[Math.min(ok.length - 1, Math.floor(ok.length * 0.95))] : null;
  const stats = [
    ["медиана", med !== null ? `${med} мс` : "—"],
    ["p95", p95 !== null ? `${p95} мс` : "—"],
    ["потери", `${loss.toFixed(loss && loss < 10 ? 1 : 0)}%`],
    ["замеров", String(vis.length)],
  ];
  document.querySelector<HTMLElement>(".lat-side")!.title = stats.map(([k, v]) => `${k}: ${v}`).join("\n");
  $("pulseStats").innerHTML = stats.map(([k, v]) => `<span>${k}</span><b>${v}</b>`).join("");
}

function renderCharts() {
  renderPulse();
  drawSpark($<HTMLCanvasElement>("rxSpark"), traffic, 1, css("--rx"));
  drawSpark($<HTMLCanvasElement>("txSpark"), traffic, 2, css("--tx"));
  drawErrors($<HTMLCanvasElement>("errChart"), errMinutes, Date.now());
}

function apply(s: Snapshot) {
  snap = s;
  for (const p of s.latency_tail) if (!latency.length || p[0] > latency[latency.length - 1][0]) latency.push(p);
  for (const p of s.traffic_tail) if (!traffic.length || p[0] > traffic[traffic.length - 1][0]) traffic.push(p);
  if (latency.length > 900) latency = latency.slice(-900);
  if (traffic.length > 300) traffic = traffic.slice(-300);
  feedScene(s.traffic.found ? s.traffic.rx_bps : 0, s.traffic.found ? s.traffic.tx_bps : 0, s.last_ms);
  // Закрытый только что простой — в список.
  if (!s.current_outage && outages[0] && !outages[0].end) outages[0].end = s.t;
  if (s.current_outage && (!outages[0] || outages[0].start !== s.current_outage.start)) outages.unshift(s.current_outage);

  renderStatus(s);
  renderMap(s);
  renderLegs(s);
  renderGuard(s);
  renderFlow(s);
  renderEvents(s);
  renderOutages(s);
  renderCharts();
  onSnapshot(s);
}

function loadFull(f: FullState) {
  latency = f.latency;
  traffic = f.traffic;
  errMinutes = f.err_minutes;
  outages = f.outages;
  // Тик мог прийти раньше полного состояния — свежий снимок не откатываем.
  apply(snap && snap.t > f.snapshot.t ? snap : f.snapshot);
}

// ─── Настройки ───────────────────────────────────────────────────
// Разделы слева, справа — содержимое со своей прокруткой; «Сохранить» и
// «Отмена» всегда внизу окна. Тема: большое живое превью выбранной и
// галерея по группам; выбор применяется сразу (отмена — вернёт как было).

function themeHtml(t: Theme) {
  const cur = SCENES.find((x) => x.id === t.scene) ?? SCENES[0];
  return `<div class="th-hero" id="lkHeroBox" style="--sbg:${cur.bg}"><canvas id="lkHero" aria-hidden="true"></canvas>
      <div class="th-hero-t"><b id="lkName">${esc(cur.name)}</b><small id="lkSub">${esc(cur.sub)}</small></div></div>
    ${GROUPS.map(([g, n]) => `<div class="look-h">${n}</div>
      <div class="scenes" role="radiogroup" aria-label="${n}">${SCENES.filter((x) => x.group === g).map((x) =>
        `<button type="button" class="scn" role="radio" data-scene="${x.id}" style="--sbg:${x.bg}" aria-checked="${x.id === t.scene}" title="${esc(x.sub)}">
          <canvas data-prev="${x.id}"></canvas><b>${esc(x.name)}</b></button>`).join("")}</div>`).join("")}`;
}

function lookHtml(t: Theme) {
  const custom = !ACCENTS.some(([, c]) => c === t.accent);
  return `<div class="look-row"><span>Акцент</span><div class="swatches" role="radiogroup" aria-label="Акцент">
      ${ACCENTS.map(([n, c]) => `<button type="button" class="sw" role="radio" data-accent="${c}" style="--c:${c}" title="${n}" aria-label="${n}" aria-checked="${c === t.accent}"></button>`).join("")}
      <label class="sw-custom" title="Свой цвет" aria-checked="${custom}" style="${custom ? `background:${t.accent}` : ""}"><input type="color" id="lkCustom" value="${t.accent}" aria-label="Свой цвет акцента"></label>
    </div></div>
    <div class="look-row" data-only="prism"><span>Фон</span><div class="swatches" role="radiogroup" aria-label="Тон фона">
      ${Object.entries(BASES).map(([id, b]) => `<button type="button" class="sw base" role="radio" data-base="${id}" style="--c:${b.bg};--c2:${b.raised}" title="${b.name}" aria-label="${b.name}" aria-checked="${id === t.base}"></button>`).join("")}
    </div></div>
    <div class="look-row" data-only="prism"><span>Грани</span><div class="seg wide" role="radiogroup" id="lkPrism">
      ${([["bright", "ярко"], ["soft", "мягко"], ["off", "выключить"]] as const).map(([v, n]) => `<button type="button" role="radio" data-v="${v}" aria-checked="${v === t.prism}">${n}</button>`).join("")}
    </div></div>
    <div class="look-row"><span>График задержки</span><div class="seg wide" role="radiogroup" id="lkPulse">
      ${PULSES.map(([v, n]) => `<button type="button" role="radio" data-v="${v}" aria-checked="${v === t.pulse}">${n}</button>`).join("")}
    </div></div>
    <div class="look-row"><span>Анимация</span><div class="seg wide" role="radiogroup" id="lkMotion" title="Сцены, бегущий свет по маршруту, переходы. В RDP Windows просит анимацию выключить — «всегда» её оставит">
      ${MOTIONS.map(([v, n]) => `<button type="button" role="radio" data-v="${v}" aria-checked="${v === t.motion}">${n}</button>`).join("")}
    </div></div>
    <div class="look-row"><span></span><div class="swatches"><button type="button" class="btn sm" id="lkReset">Как было по умолчанию</button></div></div>`;
}

function wireLook(t: Theme, redraw: () => void, onScene: (id: Theme["scene"]) => void) {
  const body = $("modalBody");
  const mark = () => {
    body.querySelectorAll<HTMLElement>("[data-accent]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.accent === t.accent)));
    const custom = !ACCENTS.some(([, c]) => c === t.accent);
    const cl = body.querySelector<HTMLElement>(".sw-custom")!;
    cl.setAttribute("aria-checked", String(custom));
    cl.style.background = custom ? t.accent : "";
    body.querySelectorAll<HTMLElement>("[data-base]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.base === t.base)));
    body.querySelectorAll<HTMLElement>("#lkPrism button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === t.prism)));
    body.querySelectorAll<HTMLElement>("#lkPulse button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === t.pulse)));
    body.querySelectorAll<HTMLElement>("#lkMotion button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === t.motion)));
    body.querySelectorAll<HTMLElement>(".scn").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.scene === t.scene)));
  };
  const set = (p: Partial<Theme>) => { Object.assign(t, p); applyTheme(t); mark(); redraw(); if (p.scene) onScene(p.scene); };
  body.querySelector(".set-pane")!.addEventListener("click", (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("button");
    if (!el) return;
    if (el.dataset.accent) set({ accent: el.dataset.accent });
    else if (el.dataset.base) set({ base: el.dataset.base as Theme["base"] });
    else if (el.closest("#lkPrism")) set({ prism: el.dataset.v as Theme["prism"] });
    else if (el.closest("#lkPulse")) set({ pulse: el.dataset.v as Theme["pulse"] });
    else if (el.closest("#lkMotion")) set({ motion: el.dataset.v as Theme["motion"] });
    else if (el.dataset.scene) {
      // Тема приносит свой акцент (его можно поменять в «Оформлении») и свою палитру.
      const sc = SCENES.find((x) => x.id === el.dataset.scene)!;
      set({ scene: sc.id, accent: sc.accent });
    }
    else if (el.id === "lkReset") set(defaultTheme());
  });
  $<HTMLInputElement>("lkCustom").addEventListener("input", (e) => set({ accent: (e.target as HTMLInputElement).value.toLowerCase() }));
}

async function openSettings(api: Api) {
  let p: Prefs;
  try { p = await api.getPrefs(); } catch (e) { await modal("Настройки", `<div class="result bad">${esc(String(e))}</div>`, "Закрыть", null); return; }
  const mons = await api.widgetMonitors().catch(() => []);
  const ws = await api.widgetState().catch(() => null);
  const pinOn = ws?.pinned ?? true;
  const atNow = ws?.anchor ?? "top";
  const build = await api.buildInfo().catch(() => null);
  const was = loadTheme();
  const look = { ...was };
  const sw = (id: string, on: boolean) => `<label class="switch"><input type="checkbox" id="${id}" ${on ? "checked" : ""}><span></span></label>`;
  const secs: [string, string, string][] = [
    ["theme", "Тема", themeHtml(look)],
    ["look", "Оформление", lookHtml(look)],
    ["app", "Запуск и вырез", `<div class="prefs">
      <div class="pref"><span class="t">Язык · Language</span>
        <select class="num pick" id="pLang" data-no-tr>${LANGS.map(([c, n]) => `<option value="${c}" ${c === lang() ? "selected" : ""}>${esc(n)}</option>`).join("")}</select>
        <span class="d">интерфейс, трей и уведомления</span></div>
      <div class="pref"><span class="t">Обновления</span><button type="button" class="btn sm" id="pUpd">Проверить</button>
        <span class="d">${build ? `Установлена версия ${esc(build.version)}${build.lab ? " · лабораторная сборка" : ""}` : ""}</span>
        <div class="upd-res" id="pUpdRes" hidden></div></div>
      <div class="pref"><span class="t">Проверять автоматически</span>${sw("pUpdAuto", updateAuto())}
        <span class="d">раз в сутки; ставится только по вашей кнопке</span></div>
      <div class="pref"><span class="t">Запускать при входе в систему</span>${sw("pAuto", p.autostart)}
        <span class="d">свёрнутым в трей</span></div>
      <div class="pref"><span class="t">Режим стримера</span>${sw("pStream", streamerOn())}
        <span class="d">прячет IP, ссылки, ключи и QR-коды — для стримов и скриншотов</span></div>
      <div class="pref"><span class="t">Уведомления о сбоях</span>${sw("pNotify", p.notify)}
        <span class="d">«нет соединения» и «восстановлено» с длительностью простоя</span></div>
      ${mons.length ? `<div class="pref"><span class="t">Вырез — на каком экране</span>
        <select class="num pick" id="pMon">${mons.map((m) => `<option value="${esc(m.name)}" ${m.current ? "selected" : ""}>${esc(m.label)}</option>`).join("")}</select>
        <span class="d">капсула у края экрана, раскрывается при наведении</span></div>
      <div class="pref"><span class="t">Вырез — у какого края</span>
        <select class="num pick" id="pAt">${NOTCH_AT.map(([v, n]) => `<option value="${v}" ${v === atNow ? "selected" : ""}>${n}</option>`).join("")}</select>
        <span class="d">или перетащите вырез мышью</span></div>
      <div class="pref"><span class="t">Вырез поверх всех окон</span>${sw("pPin", pinOn)}
        <span class="d">выключите — вырез будет под развёрнутыми окнами</span></div>` : ""}
    </div>`],
    ["net", "Связь", `<div class="prefs">
      <div class="pref"><span class="t">Порог «медленно», мс</span><input class="num" id="pSlow" type="number" min="500" max="10000" step="100" value="${p.slow_ms}">
        <span class="d">выше этой задержки статус становится жёлтым</span></div>
    </div><div class="path">${esc(p.exe)}</div>`],
  ];
  const body = `<div class="set">
    <nav class="set-nav" role="tablist" aria-label="Разделы настроек">${secs.map(([id, n], i) => `<button type="button" role="tab" data-sec="${id}" aria-selected="${i === 0}">${n}</button>`).join("")}</nav>
    <div class="set-pane">${secs.map(([id, , html], i) => `<section data-sec="${id}" ${i ? "hidden" : ""}>${html}</section>`).join("")}</div>
  </div>`;
  const done = modal("Настройки", body, "Сохранить", "Отмена");
  // Большое превью выбранной темы — живое.
  const hero = mountScene($<HTMLCanvasElement>("lkHero"), look.scene, { small: true });
  const onScene = (id: Theme["scene"]) => {
    const sc = SCENES.find((x) => x.id === id)!;
    hero.set(id);
    $("lkName").textContent = sc.name; $("lkSub").textContent = sc.sub;
    $("lkHeroBox").style.setProperty("--sbg", sc.bg);
  };
  wireLook(look, () => { lastLookRedraw(); }, onScene);
  wireUpdateRow(api);
  document.querySelectorAll<HTMLButtonElement>(".set-nav button").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll(".set-nav button").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    document.querySelectorAll<HTMLElement>(".set-pane section").forEach((s) => { s.hidden = s.dataset.sec !== b.dataset.sec; });
    document.querySelector(".set-pane")!.scrollTop = 0;
  }));
  // Плитки тем — по одному кадру, живые при наведении.
  const prevs: Mounted[] = [hero];
  const stopLive: (() => void)[] = [];
  document.querySelectorAll<HTMLCanvasElement>(".scn canvas[data-prev]").forEach((c) => {
    const m = mountScene(c, c.dataset.prev as Theme["scene"], { small: true, still: 4.2 });
    prevs.push(m);
    let live: Mounted | null = null;
    const btn = c.parentElement!;
    btn.addEventListener("mouseenter", () => { live?.stop(); live = mountScene(c, c.dataset.prev as Theme["scene"], { small: true }); });
    btn.addEventListener("mouseleave", () => { live?.stop(); live = null; m.still(4.2); });
    stopLive.push(() => { live?.stop(); live = null; });
  });
  const ok = await done;
  // Закрыли (и кнопкой, и Enter/Esc) — живые превью больше не рисуют.
  for (const m of prevs) m.stop();
  for (const f of stopLive) f();
  if (!ok) { applyTheme(was); lastLookRedraw(); return; }
  // Всё из окна — сразу: после закрытия его содержимое очищается.
  const val = (id: string) => document.getElementById(id) as HTMLInputElement | null;
  const next: Prefs = {
    ...p,
    autostart: val("pAuto")!.checked,
    notify: val("pNotify")!.checked,
    slow_ms: Number(val("pSlow")!.value) || p.slow_ms,
  };
  const pin = val("pPin")?.checked;
  const lng = val("pLang")!.value;
  const mon = val("pMon")?.value;
  const at = val("pAt")?.value;
  const stream = val("pStream")!.checked;
  const updAuto = val("pUpdAuto")!.checked;
  saveTheme(look);
  setUpdateAuto(updAuto);
  if (pin !== undefined && pin !== pinOn) await api.widgetPin(pin).catch(() => {});
  const cur = mons.find((m) => m.current)?.name;
  if (mon !== undefined && mon !== cur) await api.widgetSetMonitor(mons.find((m) => m.name === mon)?.primary ? null : mon).catch(() => {});
  if (at !== undefined && at !== atNow) await api.widgetSetAnchor(at as NotchAnchor).catch(() => {});
  try { await api.setPrefs(next); }
  catch (e) { await modal("Не сохранилось", `<div class="result bad">${esc(String(e))}</div>`, "Понятно", null); }
  // Язык или режим стримера сменились — окно перезагружается один раз, когда
  // всё уже сохранено (вырез подхватит сам).
  let reload = false;
  if (lng !== lang()) { setLang(lng); reload = true; }
  if (stream !== streamerOn()) { setStreamer(stream); reload = true; }
  if (reload) location.reload();
}

/** Перетащили в окно ярлык игры, exe, папку или ссылку: две зоны —
 *  «в игровой режим» (вкладка «Игры» с этой игрой) и «в правила». */
function initWindowDrop(api: Api) {
  const ov = document.createElement("div");
  ov.className = "drop-ov";
  ov.hidden = true;
  ov.innerHTML = `<div class="dz" data-z="game">${ICON.game}<b>В игровой режим</b><small>ярлык, exe или папка игры</small></div>
    <div class="dz" data-z="rule">${ICON.fork}<b>В правила</b><small>программа, ярлык или ссылка на сайт</small></div>`;
  document.body.append(ov);
  const zoneAt = (x: number, y: number) => (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>(".drop-ov .dz") ?? null;
  // Открыто окно (настройки, ход операции) — перетаскивание не принимаем:
  // зоны не встают поверх окна, ошибка не подменяет его содержимое.
  const modalOpen = () => !$("modal").hidden;
  const fail = (text: string) => { if (!modalOpen()) void modal("Перетаскивание", `<div class="result bad">${esc(text)}</div>`, null, "Понятно"); };
  initDrop({
    enter: () => { if (!modalOpen()) ov.hidden = false; },
    over: (x, y) => { const z = zoneAt(x, y); ov.querySelectorAll(".dz").forEach((d) => d.classList.toggle("hot", d === z)); },
    leave: () => { ov.hidden = true; },
    drop: async (got, x, y) => {
      const z = ov.hidden || modalOpen() ? undefined : zoneAt(x, y)?.dataset.z;
      ov.hidden = true;
      if (!z) return;
      const d = await resolveDrop(api, await got);
      if (typeof d === "string") return fail(d);
      if (z === "game") {
        const g = d.site ? null : await addDropped(api, d);
        if (!g) return fail(d.site ? "Это ссылка на сайт — её в правила" : "Не похоже на игру");
        openGame(g.id);
      } else {
        const v = d.site ?? (d.exe ? d.exe.split(/[\\/]/).pop()! : "");
        if (!v) return fail("Нет программы — перетащите exe или ярлык программы");
        window.dispatchEvent(new CustomEvent("wpx:rule", { detail: { kind: d.site ? "site" : "app", value: v } }));
      }
    },
  });
}

/** Перерисовать то, что красится из JS (canvas, карта), после смены оформления. */
function lastLookRedraw() {
  const sc = document.documentElement.dataset.scene as Theme["scene"] | undefined;
  if (sc && scene) scene.set(sc);
  if (!snap) return;
  renderCharts();
  renderMap(snap);
}

// ─── Взаимодействие ──────────────────────────────────────────────
function wireUi(api: Api) {
  $("btnRefresh").addEventListener("click", () => {
    const b = $("btnRefresh");
    b.classList.remove("spin"); void b.offsetWidth; b.classList.add("spin");
    api.checkNow();
  });
  $("btnMin").addEventListener("click", () => api.minimize());
  $("btnClose").addEventListener("click", () => api.hide());
  $("btnLog").addEventListener("click", () => api.openLog());
  $("btnRestart").addEventListener("click", () => void runEngineOp({
    title: "Перезапустить движок",
    intro: "<p>Движок перезапустится с текущим конфигом.</p>",
    confirm: "Перезапустить",
    steps: STEPS_RESTART,
    call: () => api.restart(),
  }));
  $("btnWhere").addEventListener("click", () => { if (snap?.server_id) void checkServer(snap.server_id); });
  // Справка по протоколам: ссылка у «Путей» и клик по названию пути.
  $("legsFaq").addEventListener("click", () => showProtocols());
  $("legs").addEventListener("click", (e) => {
    const n = (e.target as HTMLElement).closest<HTMLElement>(".leg-name[data-proto]");
    if (n) showProtocols(n.dataset.proto);
  });
  $("btnPause").addEventListener("click", async () => {
    if (!snap) return;
    const on = !snap.paused;
    // На сколько: пауза на время не забудется — VPN вернётся сам.
    let minutes = 0;
    if (on) {
      const go = await modal("Пауза VPN", `<p>Весь трафик пойдёт напрямую, мимо туннеля.</p>
        <label class="field"><span>На сколько</span><select id="pauseFor">
          <option value="15">15 минут</option><option value="60" selected>1 час</option><option value="180">3 часа</option><option value="0">пока не включу</option></select></label>`, "Пауза", "Отмена");
      if (!go) return;
      minutes = Number($<HTMLSelectElement>("pauseFor").value);
    }
    const pb = $<HTMLButtonElement>("btnPause");
    pb.disabled = true;
    try {
      await api.enginePause(on, minutes);
      snap = { ...snap, paused: on, pause_until: on && minutes ? Date.now() + minutes * 60_000 : null };
      renderStatus(snap);
    } catch (e) {
      await modal("Не получилось", `<div class="result bad">${esc(String(e).replace(/^Error:\s*/, ""))}</div>`, "Понятно", null);
    }
    pb.disabled = false;
  });
  $("btnReserve").addEventListener("click", () => {
    const r = snap?.reserve;
    if (!r) return;
    void runEngineOp({
      title: `Перейти на «${r[1]}»`,
      intro: `<p>«${esc(r[1])}» станет рабочим профилем. Если туннель через него не поднимется — всё вернётся как было.</p>`,
      confirm: "Перейти",
      steps: STEPS_RESTART,
      call: () => api.profileActivate(r[0]),
    });
  });
  onOpChange(() => { if (snap) renderStatus(snap); });
  $("btnSettings").addEventListener("click", () => void openSettings(api));
  $("btnWidget").addEventListener("click", () => api.widgetToggle());
  document.querySelectorAll<HTMLElement>(".tabs button, .nav-foot").forEach((b) => { if (!b.title) b.title = b.textContent?.trim() ?? ""; });
  document.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((b) =>
    b.addEventListener("click", () => {
      const page = b.dataset.page!;
      document.querySelectorAll(".tabs button").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
      $("pageOverview").hidden = page !== "overview";
      $("pageTraffic").hidden = page !== "traffic";
      $("pageProfiles").hidden = page !== "profiles";
      $("pageServers").hidden = page !== "servers";
      $("pageRules").hidden = page !== "rules";
      $("pageGames").hidden = page !== "games";
      $("pageEngine").hidden = page !== "engine";
      $("main").scrollTop = 0;
      if (page === "overview") lastLookRedraw();
      showTraffic(page === "traffic");
      onPageShown(page);
      if (page === "servers") onServersShown(); else onServersLeft();
      if (page === "rules") onRulesShown();
      if (page === "games") void onGamesShown(); else onGamesLeft();
      navFx(b);
    }),
  );
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("modal").hidden && !$("modalCancel").hidden) $("modalCancel").click();
  });
  document.querySelectorAll<HTMLButtonElement>(".pulse .seg button").forEach((b) =>
    b.addEventListener("click", () => {
      range = Number(b.dataset.range);
      document.querySelectorAll(".pulse .seg button").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
      renderPulse();
    }),
  );
  // Меню «⋯» в строках профилей и серверов: открыть одно, закрыть по клику мимо.
  document.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const btn = t.closest<HTMLElement>(".acts-more");
    document.querySelectorAll<HTMLElement>(".acts-pop:not([hidden])").forEach((p) => {
      if (p.previousElementSibling !== btn) { p.hidden = true; p.previousElementSibling?.setAttribute("aria-expanded", "false"); }
    });
    if (btn) {
      const pop = btn.nextElementSibling as HTMLElement;
      pop.hidden = !pop.hidden;
      btn.setAttribute("aria-expanded", String(!pop.hidden));
    }
  });
  const more = (open: boolean) => {
    $("ovDetails").hidden = !open;
    $("btnMore").setAttribute("aria-expanded", String(open));
    try { localStorage.setItem("wpx.more", open ? "1" : ""); } catch { /* только на сеанс */ }
    if (open) lastLookRedraw();
  };
  let saved = false;
  try { saved = localStorage.getItem("wpx.more") === "1"; } catch { /* по умолчанию свёрнуто */ }
  more(saved);
  $("btnMore").addEventListener("click", () => more($("ovDetails").hidden));
  const pc = $<HTMLCanvasElement>("pulseChart");
  pc.addEventListener("mousemove", (e) => { hoverX = e.offsetX; renderPulse(); });
  pc.addEventListener("mouseleave", () => { hoverX = null; renderPulse(); });
  window.addEventListener("resize", () => lastLookRedraw());
  // Ошибки движка в минуту — пересобираем из ленты раз в 10 с (дёшево); окно скрыто — не нужно.
  setInterval(() => {
    if (document.hidden) return;
    api.refreshErrors().then((m) => { errMinutes = m; }).catch(() => { /* в следующий раз */ });
  }, 10_000);
}

let scene: Mounted | null = null;

async function main() {
  initI18n();
  initStreamer();
  initTheme(() => { lastLookRedraw(); scene?.set(loadTheme().scene); });
  const api: Api = inTauri ? await tauriApi() : (await import("./core/mock")).mockApi();
  const loc = backendLocale();
  void api.setLang(loc.lang, loc.dict).catch(() => {});
  if (new URLSearchParams(location.search).get("view") === "widget") {
    await (await import("./notch/notch")).runWidget(api);
    return;
  }
  wireUi(api);
  initSpotlight();
  scene = mountScene($<HTMLCanvasElement>("sceneBg"), loadTheme().scene);
  initPages(api);
  initServers(api);
  initRules(api);
  initGames(api);
  initWindowDrop(api);
  initDiag(api);
  initTraffic(api);
  // Лабораторная сборка — заметная метка, чтобы не спутать с рабочим wpx.
  void api.buildInfo().then((b) => {
    if (!b.lab) return;
    document.title = "wpx lab";
    const chip = document.createElement("span");
    chip.className = "lab-chip";
    chip.textContent = "LAB";
    chip.title = "Лабораторная сборка: систему не меняет";
    document.querySelector(".brand")?.appendChild(chip);
  }).catch(() => {});
  // Подписка — до первой загрузки: тики не теряются, пока ждём полное состояние.
  api.onTick(apply);
  try { loadFull(await api.full()); }
  catch (e) { console.warn("wpx: состояние не загрузилось, ждём тиков", e); }
  void autoCheckUpdate(api);
  if (!inTauri) demoOpen();
}

main();

/**
 * Демо в обычном браузере (без Tauri): `?page=servers&open=add` сразу
 * открывает экран и панель — для скриншотов.
 */
function demoOpen() {
  const q = new URLSearchParams(location.search);
  // Ждём, пока нужный элемент отрисуется (данные приходят асинхронно).
  const click = (sel: string, then?: () => void, tries = 40) => {
    const el = document.querySelector<HTMLElement>(sel);
    if (el) { el.click(); then?.(); } else if (tries > 0) setTimeout(() => click(sel, then, tries - 1), 100);
  };
  const page = q.get("page");
  if (page) click(`[data-page="${page}"]`);
  const open = q.get("open");
  if (open === "add") click("#btnAddProfile");
  if (open === "trial") click('[data-act="try"][data-id="p2"]');
  if (open === "route") click("#btnAddProfile", () => click('[data-add="route"]'));
  if (open === "srvadd") click("#btnSrvAdd");
  if (open === "cascade") click("#btnSrvCascade");
  if (open === "install") click('#srvCards [data-act="install"]');
  if (open === "care") click('#srvCards [data-act="care"]');
  if (open === "settings") click("#btnSettings");
  if (open === "rulepick") click("#ruPickWhat .rp-chip");
}
