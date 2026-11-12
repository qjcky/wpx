// Подборщик правил «что → куда» — общий для вкладки «Правила» и выреза.
// Что: приложения в сети (по трафику; системные — в конце), сайты из текущих
// соединений (по домену), готовые наборы. Ввод фильтрует; домен или .exe,
// которых нет в списке, предлагаются как есть. Куда: рабочий профиль, другие
// профили, постоянный IP, напрямую, блок.

import type { Conn, EngineInfo, Preset, ProfilesState, RouteRule, UserSet } from "../core/types";
import { ICON } from "../core/icons";

export type CandKind = "app" | "site" | "preset";
export interface Cand { kind: CandKind; value: string; label: string; bytes: number; sys?: boolean; fresh?: boolean }
export interface Target { v: string; label: string; sub: string; cls: "main" | "prof" | "exit" | "direct" | "block" }

export const KIND_LABEL: Record<string, string> = { app: "приложение", site: "сайт", preset: "набор", list: "список" };
export const KIND_ICON: Record<string, string> = { app: ICON.app, site: ICON.globe, preset: ICON.layers, list: ICON.layers };

/** Системные процессы Windows — в подсказках в конце (обычно правила им не нужны). */
const SYS = /^(svchost|system|lsass|services|wininit|smss|csrss|msmpeng|mpdefendercoreservice|searchhost|searchapp|searchindexer|backgroundtaskhost|runtimebroker|compattelrunner|nvcontainer|nvdisplay\.container|spoolsv|dashost|sihost|taskhostw|wudfhost|audiodg|msedgewebview2|smartscreen|wmiprvse)\.exe$/i;
const SELF = /^(wpx|wpx-lab|wpx-probe|wpx-trial|mihomo)\.exe$/i;

/** «www.youtube.com:443» → «youtube.com»; IP и одиночные имена — null. */
export function domainOf(host: string): string | null {
  const h = host.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "").replace(/\.$/, "");
  if (!h || !h.includes(".") || /^[\d.]+$/.test(h) || h.includes(":") || /\s/.test(h)) return null;
  const p = h.split(".");
  const n = p.length >= 3 && /^(co|com|net|org|gov|edu|ac|or|ne|go|msk|spb)$/.test(p[p.length - 2]) ? 3 : 2;
  return p.slice(-n).join(".");
}

export function bytes(b: number) {
  if (b < 1024 ** 2) return `${Math.max(1, Math.round(b / 1024))} КБ`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(b < 10 * 1024 ** 2 ? 1 : 0)} МБ`;
  return `${(b / 1024 ** 3).toFixed(1)} ГБ`;
}

/** Наборы: готовые (без скрытых, `all` — со скрытыми) и свои. */
export function presetsOf(builtin: Preset[], net: { sets?: UserSet[]; hidden_presets?: string[] }, all = false): Preset[] {
  const hidden = new Set(net.hidden_presets ?? []);
  return [...builtin.filter(([id]) => all || !hidden.has(id)), ...(net.sets ?? []).map((u): Preset => [u.id, u.name, u.items, []])];
}

/** Строка своего набора: подсеть — как есть, ссылка или адрес — имя хоста
 *  без «www.»; не похоже ни на что — null. */
export function setItem(line: string): string | null {
  const raw = line.trim();
  if (/^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test(raw)) return raw;
  const h = raw.toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "").replace(/^[*+]?\./, "").replace(/^www\./, "").replace(/\.$/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h) ? h : null;
}

/** Все кандидаты: приложения, сайты, наборы — в таком порядке. Приложения и
 *  сайты, для которых уже есть правило, — тоже (даже если сейчас не в сети). */
export function candidates(conns: Conn[], presets: Preset[], rules: RouteRule[] = []): Cand[] {
  const apps = new Map<string, number>(), sites = new Map<string, number>();
  for (const r of rules) {
    if (r.kind === "app" && ![...apps.keys()].some((k) => k.toLowerCase() === r.value.toLowerCase())) apps.set(r.value, 0);
    if (r.kind === "site") sites.set(r.value, 0);
  }
  for (const c of conns) {
    const v = c.up + c.down;
    if (c.process && /\.exe$/i.test(c.process) && !SELF.test(c.process)) {
      const k = [...apps.keys()].find((x) => x.toLowerCase() === c.process.toLowerCase()) ?? c.process;
      apps.set(k, (apps.get(k) ?? 0) + v);
    }
    const d = domainOf(c.host || "");
    if (d) sites.set(d, (sites.get(d) ?? 0) + v);
  }
  const a = [...apps].map(([value, b]) => ({ kind: "app" as const, value, label: value.replace(/\.exe$/i, ""), bytes: b, sys: SYS.test(value) }))
    .sort((x, y) => Number(x.sys) - Number(y.sys) || y.bytes - x.bytes);
  const s = [...sites].map(([value, b]) => ({ kind: "site" as const, value, label: value, bytes: b })).sort((x, y) => y.bytes - x.bytes);
  const p = presets.map(([value, label]) => ({ kind: "preset" as const, value, label, bytes: 0 }));
  return [...a, ...s, ...p];
}

/** Отбор по вводу; домен или .exe, которых нет, — первой строкой «как есть». */
export function filter(all: Cand[], q: string): Cand[] {
  const t = q.trim().toLowerCase();
  if (!t) return all;
  const hit = all.filter((c) => c.label.toLowerCase().includes(t) || c.value.toLowerCase().includes(t));
  const extra: Cand[] = [];
  const isExe = /\.exe$/i.test(t) || /[\\/]/.test(t);
  const dom = isExe ? null : domainOf(t);
  if (isExe && !all.some((c) => c.kind === "app" && c.value.toLowerCase() === t.split(/[\\/]/).pop()))
    extra.push({ kind: "app", value: q.trim(), label: q.trim().split(/[\\/]/).pop()!.replace(/\.exe$/i, ""), bytes: 0, fresh: true });
  const zone = /^\.([a-z][a-z0-9-]{1,23})$/.exec(t)?.[1];
  if (zone) extra.push({ kind: "site", value: zone, label: `.${zone} — вся зона`, bytes: 0, fresh: true });
  else if (dom && !all.some((c) => c.kind === "site" && c.value === dom)) extra.push({ kind: "site", value: dom, label: dom, bytes: 0, fresh: true });
  // Просто слово без совпадений — может, это программа: «telegram» → telegram.exe.
  if (!hit.length && !extra.length && /^[\w-]+$/.test(t)) {
    extra.push({ kind: "app", value: `${t}.exe`, label: t, bytes: 0, fresh: true });
    extra.push({ kind: "site", value: `${t}.com`, label: `${t}.com`, bytes: 0, fresh: true });
  }
  return [...extra, ...hit];
}

/** Цели правила: рабочий, другие профили, постоянный IP, напрямую, блок. */
export function targets(profiles: ProfilesState | null, info: EngineInfo | null): Target[] {
  const ps = profiles?.profiles ?? [];
  const main = ps.find((p) => p.active);
  const kindOf = (p: (typeof ps)[number]) => (p.route.length ? "маршрут" : p.cascade ? "каскад" : p.endpoints.length ? "VPN" : "прокси");
  return [
    { v: "main", label: "Рабочий профиль", sub: main?.name ?? "—", cls: "main" as const },
    ...ps.filter((p) => !p.active).map((p) => ({ v: `profile:${p.id}`, label: p.name, sub: kindOf(p), cls: "prof" as const })),
    ...(info?.exits ?? []).map((x) => ({ v: `exit:${x.ip}`, label: `Постоянный IP`, sub: `${x.name} · ${x.ip} · ${x.ways.join(", ")}`, cls: "exit" as const })),
    { v: "direct", label: "Напрямую", sub: "мимо VPN", cls: "direct" as const },
    { v: "block", label: "Блокировать", sub: "без доступа", cls: "block" as const },
  ];
}

export const targetOf = (ts: Target[], v: string) => ts.find((t) => t.v === v);

/** Правило для кандидата, если уже есть (приложение — без учёта регистра). */
export function ruleFor(rules: RouteRule[], c: { kind: string; value: string }) {
  return rules.find((r) => r.kind === c.kind && (c.kind === "app" ? r.value.toLowerCase() === c.value.toLowerCase() : r.value === c.value));
}

/** Поставить правило наверх (прежнее для того же — убрать); target "" — только убрать.
 *  Новое правило для приложения — сразу «и всё, что она запускает», для
 *  сайта — «и что он подгружает»; у прежнего найденное и этот выбор сохраняются. */
export function upsert(rules: RouteRule[], kind: RouteRule["kind"], value: string, target: string): RouteRule[] {
  const same = (r: RouteRule) => r.kind === kind && (kind === "app" ? r.value.toLowerCase() === value.toLowerCase() : r.value === value);
  const old = rules.find(same);
  const rest = rules.filter((r) => !same(r));
  if (!target) return rest;
  const extra = kind === "app" || kind === "site" ? { follow: old?.follow ?? true, learned: old?.learned ?? [] } : {};
  return [{ kind, value, target, ...extra }, ...rest];
}

/** Сайт из готового набора (instagram.com) — правило на весь набор: сервисы
 *  грузят картинки и видео с других адресов (cdninstagram.com, fbcdn.net), и
 *  одно правило на сайт их не захватит. `note` — что сказать человеку. */
export function widen(presets: Preset[], kind: RouteRule["kind"], value: string): { kind: RouteRule["kind"]; value: string; note: string } {
  const host = value.toLowerCase().replace(/^www\./, "");
  // Зоны целиком (.ru) не расширяют: сайт из зоны — не весь набор.
  const p = kind === "site" ? presets.find(([, , ds]) => ds?.some((d) => d.includes(".") && (host === d || host.endsWith(`.${d}`)))) : undefined;
  if (!p) return { kind, value, note: "" };
  const other = (p[2] ?? []).filter((d) => d !== host).slice(0, 3).join(", ");
  return { kind: "preset", value: p[0], note: `«${value}» — часть набора «${p[1]}»: сервис грузит содержимое и с других адресов (${other}), поэтому правило на весь набор.` };
}

/** «app:codex.exe» → «codex.exe», «site:oaistatic.com» → «oaistatic.com». */
export const learnedLabel = (x: string) => x.replace(/^(app|site):/, "");
