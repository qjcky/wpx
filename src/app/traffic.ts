// Вкладка «Трафик»: тест скорости и «кто ест туннель» — по умолчанию только
// то, что идёт через VPN; у каждой строки — через какую точку (или напрямую).

import type { Api } from "../core/api";
import type { Conn, SpeedResult } from "../core/types";
import { $, esc, modal } from "../core/ui";

let api: Api;
let visible = false;
let view: "apps" | "hosts" = "apps";
let route: "vpn" | "direct" | "all" = "vpn";
let timer: number | undefined;
let prev = new Map<string, { up: number; down: number; t: number }>();
let rates = new Map<string, { up: number; down: number }>();
let conns: Conn[] = [];
const open = new Set<string>();

const two = (n: number) => String(n).padStart(2, "0");
const when = (t: number) => { const d = new Date(t); return `${two(d.getDate())}.${two(d.getMonth() + 1)} ${two(d.getHours())}:${two(d.getMinutes())}`; };
function bytes(b: number) {
  if (b < 1024) return `${b} Б`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(0)} КБ`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} МБ`;
  return `${(b / 1024 ** 3).toFixed(2)} ГБ`;
}
function rate(bps: number) {
  if (bps < 1) return "—";
  if (bps < 1024) return `${bps.toFixed(0)} Б/с`;
  if (bps < 1024 ** 2) return `${(bps / 1024).toFixed(bps < 10240 ? 1 : 0)} КБ/с`;
  return `${(bps / 1024 ** 2).toFixed(1)} МБ/с`;
}

// ─── Скорость ────────────────────────────────────────────────────

function showSpeed(r: SpeedResult | undefined) {
  $("spDown").textContent = r?.down_mbps != null ? String(r.down_mbps) : "—";
  $("spUp").textContent = r?.up_mbps != null ? String(r.up_mbps) : "—";
  $("spPing").textContent = r?.ping_ms != null ? String(r.ping_ms) : "—";
}

async function loadSpeedHistory() {
  let h: SpeedResult[] = [];
  try { h = await api.speedHistory(); } catch { /* пусто */ }
  showSpeed(h[0]);
  $("spNote").textContent = h[0] ? `последний тест ${when(h[0].at)}${h[0].error ? ` · ${h[0].error}` : ""}` : "тестов ещё не было";
  $("spHist").innerHTML = h.slice(0, 6).map((r) =>
    `<li><span>${when(r.at)}</span><span>↓ ${r.down_mbps ?? "—"}</span><span>↑ ${r.up_mbps ?? "—"}</span><span>${r.ping_ms ?? "—"} мс</span></li>`).join("");
}

async function runSpeed() {
  const b = $<HTMLButtonElement>("spRun");
  b.disabled = true;
  b.textContent = "Идёт тест…";
  const t0 = Date.now();
  const tick = setInterval(() => { $("spNote").textContent = `отклик → загрузка → отдача · ${Math.round((Date.now() - t0) / 1000)} с`; }, 500);
  try {
    const r = await api.speedTest();
    if (r.error && r.down_mbps == null) await modal("Тест не удался", `<div class="result bad">${esc(r.error)}</div>`, "Понятно", null);
  } catch (e) {
    await modal("Тест не удался", `<div class="result bad">${esc(String(e))}</div>`, "Понятно", null);
  }
  clearInterval(tick);
  b.disabled = false;
  b.textContent = "Запустить тест";
  await loadSpeedHistory();
}

// ─── Соединения ──────────────────────────────────────────────────

/** Запрос соединений в пути — следующий не шлём, пока не ответит этот. */
let polling = false;

async function poll() {
  // Окно свёрнуто или в трее — не опрашиваем.
  if (!visible || polling || document.hidden) return;
  polling = true;
  try {
    const list = await api.conns();
    const now = Date.now();
    const next = new Map<string, { up: number; down: number; t: number }>();
    rates = new Map();
    for (const c of list.conns) {
      const p = prev.get(c.id);
      if (p && now > p.t) {
        const dt = (now - p.t) / 1000;
        rates.set(c.id, { up: Math.max(0, (c.up - p.up) / dt), down: Math.max(0, (c.down - p.down) / dt) });
      }
      next.set(c.id, { up: c.up, down: c.down, t: now });
    }
    prev = next;
    conns = list.conns;
    const noNames = conns.length > 0 && conns.every((c) => c.process === "—");
    $("cnNote").hidden = !noNames;
    $("cnNote").textContent = "Имена приложений появятся после «Сохранить и применить» на вкладке «Движок» (нужно включить определение процессов в движке).";
    render();
    totals(list.down_total, list.up_total);
  } catch (e) {
    $("cnTotals").textContent = "";
    $("cnList").innerHTML = `<div class="empty">${esc(String(e))}</div>`;
  } finally {
    polling = false;
  }
}

/** Сводка: сколько через VPN и напрямую сейчас; счётчик движка — общий на всё. */
function totals(down: number, up: number) {
  const sum = (cs: Conn[]) => cs.reduce((a, c) => [a[0] + (rates.get(c.id)?.down ?? 0), a[1] + (rates.get(c.id)?.up ?? 0)], [0, 0]);
  const vpn = conns.filter((c) => c.route === "vpn"), direct = conns.filter((c) => c.route === "direct");
  const [vd, vu] = sum(vpn), [dd, du] = sum(direct);
  $("cnTotals").textContent = `через VPN: ${vpn.length} соед. · ↓ ${rate(vd)} ↑ ${rate(vu)}  ·  напрямую: ${direct.length} соед. · ↓ ${rate(dd)} ↑ ${rate(du)}`
    + `  ·  за сессию движка (VPN и напрямую вместе) ↓ ${bytes(down)} ↑ ${bytes(up)}`;
}

const VIA: Record<Conn["route"], string> = { vpn: "VPN", direct: "напрямую", block: "блок" };

/** Метки «куда»: VPN · точка, напрямую, блок — без повторов. */
function vias(cs: Conn[]) {
  const seen = new Map<string, Conn>();
  for (const c of cs) seen.set(`${c.route}|${c.label}`, c);
  return [...seen.values()].slice(0, 2).map((c) =>
    `<i class="cn-via ${c.route}" title="${c.route === "vpn" ? `через ${esc(c.label || c.via)}` : VIA[c.route]}">${c.route === "vpn" ? esc(c.label ? `VPN · ${short(c.label)}` : "VPN") : VIA[c.route]}</i>`).join("");
}

/** «Сингапур · Hysteria2» → «Hysteria2»: имя профиля и так видно на «Обзоре». */
const short = (l: string) => l.split(" · ").pop() ?? l;

interface Group { key: string; conns: Conn[]; up: number; down: number; ru: number; rd: number; sub: string; }

function group(list: Conn[], by: (c: Conn) => string, sub: (c: Conn[]) => string): Group[] {
  const m = new Map<string, Conn[]>();
  for (const c of list) { const k = by(c); m.set(k, [...(m.get(k) ?? []), c]); }
  return [...m.entries()].map(([key, cs]) => ({
    key, conns: cs,
    up: cs.reduce((a, c) => a + c.up, 0), down: cs.reduce((a, c) => a + c.down, 0),
    ru: cs.reduce((a, c) => a + (rates.get(c.id)?.up ?? 0), 0), rd: cs.reduce((a, c) => a + (rates.get(c.id)?.down ?? 0), 0),
    sub: sub(cs),
  })).sort((a, b) => (b.rd + b.ru) - (a.rd + a.ru) || (b.down + b.up) - (a.down + a.up));
}

const hostOf = (c: Conn) => c.host || c.ip || "—";

function render() {
  const list = route === "all" ? conns : conns.filter((c) => c.route === route);
  const groups = view === "apps"
    ? group(list, (c) => c.process, (cs) => [...new Set(cs.map(hostOf))].slice(0, 3).join(", ") + (new Set(cs.map(hostOf)).size > 3 ? "…" : ""))
    : group(list, hostOf, (cs) => [...new Set(cs.map((c) => c.process))].join(", "));
  if (!groups.length) {
    $("cnList").innerHTML = `<div class="empty">${route === "vpn" ? "через VPN сейчас ничего не идёт" : route === "direct" ? "напрямую сейчас ничего не идёт" : "соединений нет"}</div>`;
    return;
  }
  $("cnList").innerHTML = groups.slice(0, 80).map((g) => {
    const isOpen = open.has(view + g.key);
    const inner = isOpen ? group(g.conns, view === "apps" ? hostOf : (c) => c.process, () => "").map((h) => {
      const cs = h.conns;
      const up = cs.reduce((a, c) => a + c.up, 0), down = cs.reduce((a, c) => a + c.down, 0);
      const ru = cs.reduce((a, c) => a + (rates.get(c.id)?.up ?? 0), 0), rd = cs.reduce((a, c) => a + (rates.get(c.id)?.down ?? 0), 0);
      return `<div class="cn-row sub"><span class="who">${vias(cs)}${esc(h.key)}</span><span>${cs.length}</span><span>${rate(rd)}</span><span>${rate(ru)}</span><span>${bytes(down)}</span><span>${bytes(up)}</span>
        <button class="x" data-close="${esc(cs.map((c) => c.id).join(","))}" title="Закрыть эти соединения">×</button></div>`;
    }).join("") : "";
    return `<div class="cn-group${isOpen ? " open" : ""}">
      <div class="cn-row" data-toggle="${esc(view + g.key)}"><span class="who"><b>${esc(g.key)}</b><small>${vias(g.conns)}${esc(g.sub)}</small>
        ${g.key !== "—" ? `<button class="rule-btn" data-rule-kind="${view === "apps" ? "app" : "site"}" data-rule-value="${esc(g.key)}" title="Куда пускать: правило для ${view === "apps" ? "приложения" : "сайта"}">→ правило</button>` : ""}</span>
        <span>${g.conns.length}</span><span class="${g.rd > 0 ? "hot" : ""}">${rate(g.rd)}</span><span class="${g.ru > 0 ? "hot" : ""}">${rate(g.ru)}</span>
        <span>${bytes(g.down)}</span><span>${bytes(g.up)}</span>
        <button class="x" data-close="${esc(g.conns.map((c) => c.id).join(","))}" title="Закрыть все соединения">×</button></div>
      ${inner}</div>`;
  }).join("");
}

function wire() {
  $("spRun").addEventListener("click", () => void runSpeed());
  document.querySelectorAll<HTMLButtonElement>("#cnView button").forEach((b) =>
    b.addEventListener("click", () => {
      view = b.dataset.cview as "apps" | "hosts";
      document.querySelectorAll("#cnView button").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
      render();
    }));
  document.querySelectorAll<HTMLButtonElement>("#cnRoute button").forEach((b) =>
    b.addEventListener("click", () => {
      route = b.dataset.croute as typeof route;
      document.querySelectorAll("#cnRoute button").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
      render();
    }));
  $("cnList").addEventListener("click", async (e) => {
    const el = e.target as HTMLElement;
    const rule = el.closest<HTMLButtonElement>("button[data-rule-kind]");
    if (rule) {
      e.stopPropagation();
      window.dispatchEvent(new CustomEvent("wpx:rule", { detail: { kind: rule.dataset.ruleKind, value: rule.dataset.ruleValue } }));
      return;
    }
    const close = el.closest<HTMLButtonElement>("button[data-close]");
    if (close) {
      e.stopPropagation();
      const ids = (close.dataset.close ?? "").split(",").filter(Boolean);
      close.disabled = true;
      try { await api.connsClose(ids); } catch { /* приложение переоткроет */ }
      void poll();
      return;
    }
    const row = el.closest<HTMLElement>("[data-toggle]");
    if (row) {
      const k = row.dataset.toggle!;
      if (open.has(k)) open.delete(k); else open.add(k);
      render();
    }
  });
}

export function initTraffic(a: Api) {
  api = a;
  wire();
}

export function showTraffic(on: boolean) {
  visible = on;
  if (timer) { clearInterval(timer); timer = undefined; }
  if (on) {
    void loadSpeedHistory();
    void poll();
    timer = window.setInterval(() => void poll(), 2000);
  }
}
