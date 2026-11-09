// Мок-данные для предпросмотра интерфейса в обычном браузере (npx vite).
// В приложении не используется: там данные идут из Rust.
// ?health=down|slow|engine_off — состояние, ?wpx — движок уже перенесён.

import type { Api } from "./api";
import type {
  ApplyResult, EngineInfo, FullState, Health, LogEvent, NetSettings, Prefs, ProbeResult, ProfileInput, ProfilesState, ProfileView, ProtoKind,
  ServerLog, ServersState, ServerView, Snapshot, TrialStatus, Guest, Share,
} from "./types";

let t = 1;
const later = <T>(v: T, ms = 600) => new Promise<T>((r) => setTimeout(() => r(v), ms));
const ok = (message = "Готово, туннель работает", info: string | null = null): ApplyResult => ({ ok: true, outcome: "applied", message, info });

export function mockApi(): Api {
  const q = new URLSearchParams(location.search);
  const now = Date.now();
  const prefs: Prefs = { autostart: true, notify: true, slow_ms: 2500, exe: "C:\\Users\\user\\AppData\\Local\\wpx\\wpx.exe" };
  let engineKind: "missing" | "wpx" = q.has("fresh") ? "missing" : "wpx";
  let boot = true;
  const health: Health = (q.get("health") as Health) ?? "online";
  let profiles: ProfileView[] = [
    { id: "singapore", name: "Singapore", server: "203.0.113.50", http_port: 59100, socks_port: 59101, username: "proxyuser", has_password: true, primary: "http", fallback: true, https: false, tls_sni: "", tls_insecure: false, active: true, endpoints: [], mode: "", cascade: null, origin: "", route: [] },
    { id: "p2", name: "Амстердам", server: "203.0.113.7", http_port: null, socks_port: null, username: "", has_password: false, primary: "http", fallback: false, https: false, tls_sni: "", tls_insecure: false, active: false, mode: "auto", cascade: null, origin: "", route: [],
      endpoints: [
        { kind: "vless", label: "ams-reality", summary: "VLESS · Reality · 203.0.113.7:443" },
        { kind: "awg", label: "ams-awg", summary: "AmneziaWG · обфускация · 203.0.113.7:51820" },
        { kind: "hysteria2", label: "ams-hy2", summary: "Hysteria2 · 203.0.113.7:8443" },
      ] },
    { id: "p3", name: "Хельсинки", server: "198.51.100.9", http_port: null, socks_port: null, username: "", has_password: false, primary: "http", fallback: false, https: false, tls_sni: "", tls_insecure: false, active: false, mode: "fallback", cascade: null, origin: "server:s2", route: [],
      endpoints: [{ kind: "vless", label: "fi-reality", summary: "VLESS · Reality · 198.51.100.9:443" }] },
  ];
  const cascadeOf = (id: string, name: string, entry: string, exit: string): ProfileView => ({
    id, name, server: "", http_port: null, socks_port: null, username: "", has_password: false, primary: "http", fallback: false, https: false, tls_sni: "", tls_insecure: false, active: false,
    endpoints: [], mode: "", origin: "", route: [], cascade: { entry, exit, entry_name: profiles.find((p) => p.id === entry)?.name ?? "?", exit_name: profiles.find((p) => p.id === exit)?.name ?? "?" },
  });
  profiles.push(cascadeOf("c1", "Амстердам → Хельсинки", "p2", "p3"));
  profiles.push({ id: "r1", name: "Хельсинки через каскад", server: "203.0.113.10", http_port: null, socks_port: null, username: "", has_password: false, primary: "http", fallback: false,
    https: false, tls_sni: "", tls_insecure: false, active: false, mode: "auto", cascade: null, origin: "route:s2", route: [], endpoints: [
      { kind: "hysteria2", label: "Сингапур → Хельсинки · Hysteria2", summary: "Hysteria2 · 203.0.113.10:8443" },
      { kind: "awg", label: "Сингапур → Хельсинки · AmneziaWG", summary: "AmneziaWG · обфускация · 203.0.113.10:9443" },
      { kind: "vless", label: "Сингапур → Хельсинки · VLESS", summary: "VLESS · Reality · 203.0.113.10:8443" },
    ] });

  const srv = (id: string, name: string, host: string, country: string, city: string): ServerView => ({
    id, name, host, port: 22, user: "root", host_key: "SHA256:mock", via: null, via_name: null, runtime: "", vless: null, hy2: null, awg: null, xhttp: null, mtproxy: null, pipes: [], profile: null, entries: [], route: null, guests: [], fw: false, updates: [],
    fw_plan: { open: ["SSH :22", "VLESS :443", "Hysteria2 :443/udp", "контейнер :35248/udp", "AmneziaWG :50738/udp"], close: [["tcp/111", "rpcbind"], ["udp/111", "rpcbind"]] },
    facts: { os: "Debian GNU/Linux 12 (bookworm)", arch: "x86_64", cpus: 1, ram_mb: 1024, avail_mb: 600, swap_mb: 1024, disk_free_mb: 20480, country, city, org: "Hosting LLC",
      root: true, docker: true, systemd: true, containers: ["amnezia-awg2", "wpx-singbox"], tcp: [], udp: [], wpx: true, ufw: false, at: Date.now(),
      uptime_s: 363600, load: "0.00 0.01 0.00", net_rx: 1_587_000_000, net_tx: 1_300_000_000, cc: "hybla", bbr_avail: true, autoupd: false, f2b: false,
      updates: 94, sec_updates: 38, reboot: true, sb_ver: "1.14.4", apt: true, public: [], fw: false },
  });
  let servers: ServerView[] = [
    { ...srv("s1", "Singapore", "203.0.113.10", "SG", "Singapore"), runtime: "docker", vless: { port: 443, dest: "www.apple.com", public_key: "k", short_id: "s" },
      hy2: { port: 443, sni: "www.apple.com", cert_sha256: "z" }, awg: { port: 50738, server_public: "k", obf: [["Jc", "5"]] },
      guests: [
        { id: "g1", name: "iPhone", created: Date.now() - 86_400_000 * 3, expires: null, vless: false, hy2: false, awg_ip: 3, via: null, off: false },
        { id: "g2", name: "Маша", created: Date.now() - 86_400_000 * 10, expires: Date.now() + 86_400_000 * 20, vless: true, hy2: true, awg_ip: 4, via: null, off: false },
        { id: "g3", name: "Коллега", created: Date.now() - 86_400_000 * 40, expires: Date.now() - 86_400_000 * 2, vless: true, hy2: false, awg_ip: 0, via: null, off: true },
      ] },
    { ...srv("s2", "Helsinki", "198.51.100.20", "FI", "Helsinki"), via: "s1", via_name: "Singapore", runtime: "docker", vless: { port: 443, dest: "www.apple.com", public_key: "k", short_id: "s" } },
    // ?free — чистый сервер для окна переезда.
    ...(q.has("free") ? [srv("s3", "Франкфурт", "198.51.100.20", "DE", "Frankfurt")] : []),
  ];
  /** Картинка вместо настоящего QR (в демо ключей нет). */
  const mockQr = (seed: number) => {
    let x = seed, cells = "";
    for (let r = 0; r < 25; r++) for (let c = 0; c < 25; c++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      const finder = [[0, 0], [0, 18], [18, 0]].some(([a, b]) => r >= a && r < a + 7 && c >= b && c < b + 7);
      const on = finder ? !((r % 18 === 1 || r % 18 === 5) && c % 18 >= 1 && c % 18 <= 5) && !((c % 18 === 1 || c % 18 === 5) && r % 18 >= 1 && r % 18 <= 5) : x % 3 === 0;
      if (on) cells += `<rect x="${c + 2}" y="${r + 2}" width="1" height="1"/>`;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 29 29" width="240" height="240" shape-rendering="crispEdges"><rect width="29" height="29" fill="#fff"/><g fill="#000">${cells}</g></svg>`;
  };
  const mockShare = (s: ServerView, g: Guest): Share => ({
    guest: g, server: s.name, host: s.host, items: [
      ...(g.awg_ip ? [{ kind: "awg" as const, title: "AmneziaWG", text: `[Interface]\nPrivateKey = …\nAddress = 10.66.0.${g.awg_ip}/32\nDNS = 1.1.1.1, 1.0.0.1\nJc = 5\n\n[Peer]\nPublicKey = …\nEndpoint = ${s.host}:50738\nAllowedIPs = 0.0.0.0/0, ::/0\n`, qr: mockQr(7), apps: "AmneziaWG, AmneziaVPN (iPhone, Android, Windows, macOS)" }] : []),
      ...(g.vless ? [{ kind: "vless" as const, title: "VLESS + Reality", text: `vless://…@${s.host}:443?security=reality&sni=www.apple.com#${encodeURIComponent(`${s.name} · ${g.name}`)}`, qr: mockQr(3), apps: "v2RayTun, Happ, Streisand, Hiddify, Shadowrocket, v2rayNG" }] : []),
      ...(g.hy2 ? [{ kind: "hy2" as const, title: "Hysteria2", text: `hysteria2://…@${s.host}:443?sni=www.apple.com&obfs=salamander&insecure=1#${encodeURIComponent(`${s.name} · ${g.name}`)}`, qr: mockQr(5), apps: "Hiddify, Streisand, Shadowrocket, v2RayTun, Happ" }] : []),
    ],
  });
  const srvState = (_id?: string): ServersState => ({ servers: servers.map((s) => ({ ...s, pipes: [...s.pipes] })), version: "1.14.4", covers: ["www.apple.com", "www.microsoft.com", "dl.google.com", "www.samsung.com", "www.nvidia.com", "addons.mozilla.org"] });
  let srvLog: ((l: ServerLog) => void) | null = null;
  const steps = async (list: [ServerLog["kind"], string][]) => {
    for (const [kind, text] of list) { await later(null, 450); srvLog?.({ kind, text }); }
  };
  let heal = false;
  let paused = false;
  let pauseUntil: number | null = null;
  let pinned = true;
  let net: NetSettings = {
    mode: "strict", rules: [{ kind: "app", value: "ChatGPT.exe", target: "profile:p3", follow: true, learned: ["app:codex.exe", "site:oaistatic.com"] }, { kind: "app", value: "brave.exe", target: "profile:p3" }, { kind: "preset", value: "ai", target: "profile:p3" }], apps: [], tunnel_domains: [], lists: ["ru-inside", "telegram-ip", "meta-ip", "discord-ip", "twitter-ip"],
    block_telemetry: true, block_domains: [],
    interface: "Ethernet", lan: ["192.168.1.0/24", "192.168.56.0/24", "172.21.192.0/20"],
    direct: ["198.51.100.40/32", "198.51.100.41/32"], block_udp: true, udp: "auto", block_quic: false, ipv6: "tunnel", kill_switch: false, real_ip: true, sets: [], hidden_presets: [], game: { on: false, game: "", name: "", apps: [], dir: "", login: true, launchers: [], domains: [], target: "main", udp_only: true }, tun_device: "wpx", mixed_port: 7890, secret: "", reserve: "singapore",
  };

  const lat: [number, number | null][] = [];
  for (let t = now - 3_600_000; t <= now; t += 4000) {
    const wave = 380 + 60 * Math.sin(t / 90_000) + Math.random() * 90;
    const bad = t > now - 2_300_000 && t < now - 2_150_000;
    const spike = Math.random() < 0.02 ? 1400 + Math.random() * 1500 : 0;
    lat.push([t, bad || Math.random() < 0.01 ? null : Math.round(wave + spike)]);
  }
  const trf: [number, number, number][] = [];
  for (let t = now - 300_000; t <= now; t += 1000) {
    trf.push([t, Math.round(40_000 + Math.random() * 260_000 * (Math.sin(t / 20_000) + 1.2)), Math.round(8000 + Math.random() * 30_000)]);
  }
  const errs: [number, number][] = [];
  for (let m = Math.floor((now - 10_800_000) / 60_000) * 60_000; m <= now; m += 60_000) {
    const burst = m > now - 2_400_000 && m < now - 2_100_000 ? 80 + Math.random() * 120 : Math.random() < 0.15 ? Math.random() * 6 : 0;
    if (burst >= 1) errs.push([m, Math.round(burst)]);
  }
  const events: LogEvent[] = [
    { t: now - 30_000, kind: "timeout", dest: "203.0.113.60", count: 3, text: "Не дождались ответа через прокси" },
    { t: now - 2_150_000, kind: "dropped", dest: "api.anthropic.com", count: 4, text: "Прокси оборвал соединение" },
    { t: now - 2_200_000, kind: "proxy_unreachable", dest: null, count: 142, text: "Сервер прокси не ответил на подключение" },
    { t: now - 20_005_000, kind: "engine_start", dest: null, count: 1, text: "Движок запущен" },
  ];

  const snap = (): Snapshot => {
    const t = Date.now();
    const down = health === "down";
    const v = down || health === "engine_off" ? null : Math.round(360 + Math.random() * 140);
    return {
      t, health, health_since: now - 4_000_000,
      cause: down ? "Сервер прокси не отвечает ни по одному порту" : health === "engine_off" ? "Движок (mihomo) не запущен" : null,
      last_ms: v, last_err: null, server: "203.0.113.50", active_kind: "group", config_err: null,
      legs: [
        ...(q.has("vpn") ? [
          ...(q.has("cascade") ? [{ name: "wpx-in-0", label: "Сингапур · Hysteria2", kind: "hysteria2", net: "", role: "entry" as const, server: "203.0.113.10", port: 443, active: true, result: { ok: true, connect_ms: null, ready_ms: 412, err: null }, at: t - 4000 }] : []),
          { name: "wpx-0", label: "Сингапур → Хельсинки · Hysteria2", kind: "hysteria2", net: "", role: "exit" as const, server: "203.0.113.10", port: 8443, active: true, result: { ok: true, connect_ms: null, ready_ms: 583, err: null }, at: t - 4000 },
          { name: "wpx-1", label: "Сингапур → Хельсинки · VLESS", kind: "vless", net: "", role: "exit" as const, server: "203.0.113.10", port: 8443, active: false, result: { ok: true, connect_ms: 301, ready_ms: 1959, err: null }, at: t - 4000 },
          { name: "wpx-3", label: "Сингапур → Хельсинки · XHTTP", kind: "vless", net: "xhttp", role: "exit" as const, server: "203.0.113.10", port: 2053, active: false, result: { ok: true, connect_ms: 299, ready_ms: 1720, err: null }, at: t - 4000 },
          { name: "wpx-2", label: "Сингапур → Хельсинки · AmneziaWG", kind: "wireguard", net: "", role: "exit" as const, server: "203.0.113.10", port: 9443, active: false, result: { ok: false, connect_ms: null, ready_ms: null, err: "нет ответа (таймаут)" }, at: t - 4000 },
        ] : [
          { name: "HTTP", label: "HTTP", kind: "http", net: "", role: "exit" as const, server: "203.0.113.50", port: 59100, active: true, result: { ok: !down, connect_ms: 352, ready_ms: 712, err: down ? "нет ответа (таймаут)" : null }, at: t - 4000 },
          { name: "SOCKS5", label: "SOCKS5", kind: "socks5", net: "", role: "exit" as const, server: "203.0.113.50", port: 59101, active: false, result: { ok: !down, connect_ms: 348, ready_ms: 1391, err: down ? "нет ответа (таймаут)" : null }, at: t - 4000 },
        ]),
      ],
      engine: { running: health !== "engine_off", pid: 3888, uptime_s: 22_340, mem_mb: 61 },
      traffic: { found: true, rx_bps: Math.round(Math.random() * 400_000), tx_bps: Math.round(Math.random() * 40_000), rx_total: 1_934_000_000, tx_total: 210_000_000 },
      guard: [
        { key: "escape", label: "Прямой выход мимо туннеля", ok: true, detail: "с 192.168.1.50 на 1.1.1.1:443 — закрыто" },
        { key: "tun", label: "Туннель", ok: true, detail: "wpx поднят" },
        { key: "ipv6", label: "IPv6 закрыт", ok: true, detail: "правило группы wpx" },
        { key: "dns", label: "DNS мимо туннеля закрыт", ok: true, detail: "53/853 TCP+UDP" },
        { key: "fw", label: "Файрвол Windows включён", ok: true, detail: "все профили" },
        { key: "strict", label: "Строгая маршрутизация", ok: true, detail: "strict-route в конфиге движка" },
        { key: "udp", label: "UDP заблокирован", ok: true, detail: "WebRTC/QUIC не утекают" },
        { key: "ip", label: "Внешний IP — выход туннеля", ok: true, detail: "203.0.113.50" },
      ],
      guard_at: t - 12_000, ip: "203.0.113.50", ip_expected: true,
      events, latency_tail: [[t, v]], traffic_tail: [[t, Math.round(Math.random() * 300_000), Math.round(Math.random() * 30_000)]],
      current_outage: null, slow_ms: prefs.slow_ms,
      dual: true, active_leg: q.has("vpn") ? "Сингапур → Хельсинки · Hysteria2" : "HTTP", legs_trial: q.has("vpn") ? "Хельсинки через каскад" : null, busy: false, engine_kind: engineKind, boot: engineKind === "wpx" ? boot : null,
      profile: profiles.find((p) => p.active)?.name ?? null, tun_device: engineKind === "wpx" ? "wpx" : "SG-TUN",
      heal,
      reserve: q.has("vpn") ? ["singapore", "Singapore"] : null, on_reserve: q.has("vpn") && down,
      server_id: q.has("vpn") ? "s1" : null,
      paused,
      pause_until: paused ? pauseUntil : null,
    };
  };
  const full: FullState = {
    snapshot: snap(), latency: lat, traffic: trf, err_minutes: errs,
    outages: [
      { start: now - 2_300_000, end: now - 2_150_000, cause: "Сервер прокси не отвечает ни по одному порту" },
      { start: now - 86_000_000, end: now - 85_400_000, cause: "Прокси отвечает, но туннель не пропускает трафик" },
    ],
  };
  const trialOf = (id: string): TrialStatus => {
    const p = profiles.find((x) => x.id === id)!;
    return { running: false, profile_id: id, profile: p.name, mode: p.mode, port: 58909, uptime_s: 0, error: null,
      points: (p.endpoints.length ? p.endpoints : [{ kind: "http" as ProtoKind, label: "HTTP", summary: "HTTP · 203.0.113.50:59100" }]).map((e, i) => ({
        name: `wpx-${i}`, label: e.label, summary: e.summary, role: "exit" as const, alive: i !== 1, delay_ms: i === 1 ? null : 700 + i * 300, active: i === 0 })) };
  };
  let trial: TrialStatus = { running: false, profile_id: "", profile: "", mode: "", port: 0, uptime_s: 0, points: [], error: null };
  const state = (): ProfilesState => ({ profiles: profiles.map((p) => ({ ...p })), active: profiles.find((p) => p.active)?.id ?? null });

  return {
    full: async () => full,
    onTick: (cb) => void setInterval(() => cb(snap()), 1000),
    checkNow: () => {},
    minimize: () => {},
    hide: () => {},
    openLog: () => {},
    refreshErrors: async () => errs,
    getPrefs: async () => ({ ...prefs }),
    setPrefs: async (p) => Object.assign(prefs, p),
    setLang: async () => {},
    gamesRunning: async () => [{ name: "Aion2.exe", path: "D:\\Games\\Aion 2\\Aion2.exe", dir: "D:\\Games\\Aion 2", mem_mb: 3120 }, { name: "Spotify.exe", path: "C:\\Users\\u\\AppData\\Roaming\\Spotify\\Spotify.exe", dir: "C:\\Users\\u\\AppData\\Roaming\\Spotify", mem_mb: 410 }],
    exeIcon: async () => "",
    gameServers: async () => (net.game.on ? [
      { ip: "198.51.100.77", port: 7777, network: "udp", host: "", bytes: 48_000_000, conns: 2, via: "Сингапур · Hysteria2" },
      { ip: "198.51.100.78", port: 443, network: "tcp", host: "login.archeage.example", bytes: 900_000, conns: 1, via: "Сингапур · Hysteria2" },
    ] : []),
    gameMeasure: () => later([
      { name: "Москва → Франкфурт", kind: "cascade" as const, legs: [{ name: "ПК → Москва", ms: 9 }, { name: "Москва → Франкфурт", ms: 28 }, { name: "Франкфурт → игра", ms: 2 }], total: 39, profile: null, note: "каскад не настроен — «Серверы» → «Каскад»" },
      { name: "Напрямую", kind: "direct" as const, legs: [{ name: "ПК → игра", ms: 61 }], total: 61, profile: null, note: "" },
      { name: "Хельсинки", kind: "server" as const, legs: [{ name: "ПК → Хельсинки", ms: 52 }, { name: "Хельсинки → игра", ms: 31 }], total: 83, profile: "helsinki", note: "" },
      { name: "Сингапур", kind: "server" as const, legs: [{ name: "ПК → Сингапур", ms: 160 }, { name: "Сингапур → игра", ms: null }], total: null, profile: "singapore", note: "" },
    ], 2500),
    profiles: async () => state(),
    profileSave: async (i: ProfileInput) => {
      if (!/^\d+\.\d+\.\d+\.\d+$/.test(i.server)) throw "Сервер — IPv4-адрес вида 203.0.113.50";
      const id = i.id ?? `p${Date.now()}`;
      const v: ProfileView = { id, name: i.name, server: i.server, http_port: i.http_port, socks_port: i.socks_port, username: i.username, has_password: !!i.password || !!profiles.find((p) => p.id === id)?.has_password, primary: i.primary, fallback: i.fallback, https: i.https, tls_sni: i.tls_sni, tls_insecure: i.tls_insecure, active: profiles.find((p) => p.id === id)?.active ?? false, endpoints: [], mode: "", cascade: null, origin: "", route: [] };
      profiles = profiles.some((p) => p.id === id) ? profiles.map((p) => (p.id === id ? v : p)) : [...profiles, v];
      return state();
    },
    profileDelete: async (id) => { profiles = profiles.filter((p) => p.id !== id); return state(); },
    linksParse: async (text) => text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => {
      const kind = l.split("://")[0];
      const known: Record<string, ProtoKind> = { vless: "vless", hysteria2: "hysteria2", hy2: "hysteria2", trojan: "trojan", ss: "shadowsocks" };
      const k = known[kind];
      return k
        ? { ok: true, kind: k, label: decodeURIComponent(l.split("#")[1] ?? k), summary: `${k.toUpperCase()} · ${l.split("@")[1]?.split(/[?/#]/)[0] ?? ""}`, udp: true, error: null }
        : { ok: false, kind: null, label: "", summary: "", udp: false, error: `Протокол «${kind}» не поддерживается` };
    }),
    linksProbe: async (text) => {
      await later(null, 2500);
      const n = text.split("\n").filter((l) => /^(vless|hysteria2|hy2|trojan|ss):\/\//.test(l.trim())).length;
      return Array.from({ length: n }, (_, i) => ({ index: i, label: `p${i}`, kind: "vless" as ProtoKind, summary: "", ok: i === 1 ? 0 : 3, rounds: 3,
        median_ms: i === 1 ? null : 300 + i * 170, best_ms: i === 1 ? null : 280 + i * 160, error: i === 1 ? "нет ответа (таймаут)" : null }));
    },
    profileImport: async (name, _text, mode) => {
      profiles = [...profiles, { id: `p${Date.now()}`, name, server: "", http_port: null, socks_port: null, username: "", has_password: false, primary: "http", fallback: false, https: false, tls_sni: "", tls_insecure: false, active: false, mode, cascade: null, origin: "", route: [],
        endpoints: [{ kind: "vless", label: name, summary: "VLESS · Reality · 127.0.0.1:24443" }] }];
      return state();
    },
    profileEditVpn: async (i) => {
      profiles = profiles.map((p) => p.id !== i.id ? p : { ...p, name: i.name, mode: i.mode,
        endpoints: [...i.order.map((k) => p.endpoints[k]), ...(i.add.trim() ? [{ kind: "vless" as ProtoKind, label: "новая", summary: "VLESS · новая" }] : [])] });
      return state();
    },
    routerRules: async (id) => id === "singapore"
      ? [{ server: "203.0.113.50", tcp: [59100, 59101], udp: [], what: ["HTTP", "SOCKS5"] }]
      : [{ server: "203.0.113.10", tcp: [443, 8443], udp: [443, 8443, 9443], what: ["Hysteria2", "VLESS", "AmneziaWG"] }],
    routerCheck: async () => { await later(null, 1500); return [{ server: "203.0.113.10", ok: true, detail: "Hysteria2 :8443/udp ✓ 412 мс · VLESS :8443 ✓ 1180 мс · AmneziaWG :9443/udp ✗ нет ответа (таймаут)" }]; },
    profileHistory: async (id) => profiles.find((x) => x.id === id)!.endpoints.map((_, i) => ({
      score: i === 1 ? null : { tries: 240, rate: i === 0 ? 0.99 : 0.93, ms: i === 0 ? 420 : 780, stall_rate: i === 0 ? 0 : 0.25, cost: 0, by_hour: true },
      best_hour: i === 1 ? null : i === 0 ? 4 : 13,
    })),
    profileProbe: async (id) => {
      await later(null, 1500);
      const p = profiles.find((x) => x.id === id)!;
      return p.endpoints.map((e, i) => ({ index: i, label: e.label, kind: e.kind, summary: e.summary, ok: i === 1 ? 0 : 3, rounds: 3,
        median_ms: i === 1 ? null : 400 + i * 300, best_ms: i === 1 ? null : 380 + i * 300, error: i === 1 ? "нет ответа (таймаут)" : null,
        bulk: i === 1 ? null : i === 0 ? { bytes: 16_800, ms: 9000, stalled: true } : { bytes: 262_144, ms: 2400, stalled: false } }));
    },
    routeSave: async (id, name, members, mode) => {
      const v: ProfileView = { id: id ?? `r${Date.now()}`, name, server: "", http_port: null, socks_port: null, username: "", has_password: false, primary: "http",
        fallback: false, https: false, tls_sni: "", tls_insecure: false, active: false, endpoints: [], mode, cascade: null, origin: "", route: members.map((m) => ({ id: m, name: profiles.find((p) => p.id === m)?.name ?? "?" })) };
      profiles = profiles.some((p) => p.id === v.id) ? profiles.map((p) => (p.id === v.id ? v : p)) : [...profiles, v];
      return state();
    },
    routeProbe: async (members) => { await later(null, 1500); return members.map((m, i) => ({ id: m, name: profiles.find((p) => p.id === m)?.name ?? "?", ok: i !== 2, best_ms: i === 2 ? null : 560 + i * 900, detail: i === 2 ? "нет ответа" : "отвечают 3 из 3 точек" })); },
    cascadeProbe: async (entry, exit) => {
      await later(null, 2000);
      if (entry === exit) throw "вход и выход каскада — один и тот же профиль";
      const r = (label: string, med: number): ProbeResult => ({ index: 0, label, kind: "vless", summary: "", ok: 3, rounds: 3, median_ms: med, best_ms: med - 60, error: null });
      return { entry: [r(profiles.find((p) => p.id === entry)?.name ?? "вход", 1102)], exit: [r(profiles.find((p) => p.id === exit)?.name ?? "выход", 2179)] };
    },
    cascadeSave: async (id, name, entry, exit) => {
      if (entry === exit) throw "вход и выход каскада — один и тот же профиль";
      const v = { ...cascadeOf(id ?? `c${Date.now()}`, name, entry, exit), active: profiles.find((p) => p.id === id)?.active ?? false };
      profiles = profiles.some((p) => p.id === v.id) ? profiles.map((p) => (p.id === v.id ? v : p)) : [...profiles, v];
      return state();
    },
    buildInfo: async () => ({ lab: q.has("lab"), version: "0.1.0" }),
    updateCheck: async () => {
      await later(null, 800);
      if (q.has("lab")) throw "в лабораторной сборке обновлений нет";
      return { version: "0.2.0", current: "0.1.0", notes: "Новое: …", date: null };
    },
    updateInstall: () => later(undefined, 1500),
    trialStart: async (id) => { await later(null, 1200); trial = { ...trialOf(id), running: true }; return trial; },
    trialStatus: async () => trial,
    trialCheck: async () => { await later(null, 1500); return trial; },
    trialStop: async () => { trial = { ...trial, running: false }; },
    trialBrowser: async () => "msedge.exe",
    trialSpeed: async () => { await later(null, 2500); return { at: Date.now(), ping_ms: 772, down_mbps: 29.1, up_mbps: 12.2, down_mb: 25, up_mb: 6, error: null }; },
    servers: async () => srvState(),
    serverFingerprint: async () => later("SHA256:mockmockmockmockmockmockmockmockmockmockmoc", 900),
    serverAdd: async (i) => {
      await steps([["step", `Подключаюсь к root@${i.host}:22 напрямую (мимо туннеля)`], ["ok", `Ключ сервера совпал: ${i.fingerprint ?? "SHA256:mock"}`], ["step", "Ставлю отдельный ключ wpx (пароль не сохраняется)"], ["ok", "Debian GNU/Linux 12 · Amsterdam, NL · 1 ядр. · 1024 МБ ОЗУ"]]);
      if (!i.password && !i.key_path) throw "Нужен пароль или файл ключа";
      servers.push({ ...srv("s" + Date.now(), i.name || "Amsterdam", i.host, "NL", "Amsterdam"), via: i.via, via_name: servers.find((s) => s.id === i.via)?.name ?? null });
      return srvState();
    },
    serverInspect: async (id) => { await steps([["step", "SSH"], ["ok", "осмотрено"]]); return srvState(id); },
    serverMtproxyLink: async () => ({ link: "tg://proxy?server=198.51.100.9&port=2053&secret=ee00", web: "https://t.me/proxy?server=198.51.100.9&port=2053&secret=ee00", qr: "" }),
    serverProfile: async (id) => {
      const s = servers.find((x) => x.id === id)!;
      await steps([["step", "Проверка с этого ПК через провайдера (песочница, мимо туннеля)"], ["ok", `${s.name} · VLESS: 3/3 · 1102 мс`],
        ["ok", `Профиль «${s.name}» готов — его можно сделать рабочим на вкладке «Профили»`]]);
      s.profile = "p-" + id;
      return { state: srvState(), profile: s.profile, note: null, probe: [
        { index: 0, label: `${s.name} · VLESS`, kind: "vless", summary: "", ok: 3, rounds: 3, median_ms: 1102, best_ms: 1040, error: null },
      ] };
    },
    serverInstall: async (id, vless, hy2, awg, xhttp, mtproxy, harden, cover) => {
      void harden;
      const s = servers.find((x) => x.id === id)!;
      const dest = cover && cover !== "auto" ? cover : cover === "auto" ? "www.microsoft.com" : s.vless?.dest ?? "www.apple.com";
      await steps([["step", "sing-box 1.14.4: образ Docker (закреплён по digest)"], ["ok", "sing-box на месте"], ["step", "Подбираю сайт-прикрытие"], ["ok", "Прикрытие: www.apple.com"],
        ["step", "Конфиг: проверка, замена, запуск (при сбое — откат)"], ["ok", "Запущено: TCP 443 · UDP 443"], ["step", "Проверка с этого ПК"], ["ok", `${s.name} · VLESS: 3/3 · 1102 мс`], ["warn", `${s.name} · Hysteria2: нет ответа (таймаут)`]]);
      s.vless = vless ? { port: 443, dest, public_key: "x", short_id: "y" } : null;
      s.hy2 = hy2 ? { port: 443, sni: "www.apple.com", cert_sha256: "z", hop: [23000, 23999] } : null;
      s.xhttp = xhttp ? { port: 8443, dest, public_key: "x", short_id: "y", path: "/a1b2c3" } : null;
      s.mtproxy = mtproxy ? { port: 2053, domain: "www.apple.com" } : null;
      s.awg = awg ? { port: 34567, server_public: "k", obf: [["Jc", "5"]] } : null;
      s.runtime = "docker";
      return { state: srvState(), profile: "p-" + id, note: null, probe: [
        { index: 0, label: `${s.name} · VLESS`, kind: "vless", summary: "", ok: 3, rounds: 3, median_ms: 1102, best_ms: 1040, error: null },
        ...(hy2 ? [{ index: 1, label: `${s.name} · Hysteria2`, kind: "hysteria2" as ProtoKind, summary: "", ok: 0, rounds: 3, median_ms: null, best_ms: null, error: "нет ответа (таймаут)" }] : []),
      ] };
    },
    serverHarden: async (id, bbr, autoupd, f2b) => {
      await steps([["step", "Усиливаю: BBR, автообновления безопасности, fail2ban для SSH"], ["ok", "BBR включён"], ["ok", "автообновления безопасности включены"], ["ok", "fail2ban стережёт SSH (адрес wpx — в исключениях)"]]);
      const f = servers.find((x) => x.id === id)!.facts!;
      Object.assign(f, { cc: bbr ? "bbr" : f.cc, autoupd: autoupd || f.autoupd, f2b: f2b || f.f2b });
      return srvState();
    },
    serverCascade: async (entry, exit, via) => {
      const e = servers.find((x) => x.id === entry)!, x = servers.find((s) => s.id === exit)!;
      void via;
      await steps([["step", `Труба на «${e.name}»: :8443 → ${x.host}`], ["ok", "Запущено: TCP 443 8443 · UDP 8443"], ["ok", `${e.name} → ${x.name} · VLESS: 3/3 · 1180 мс`]]);
      e.pipes = [...e.pipes.filter((p) => p.to !== exit), { to: exit, to_name: x.name, to_host: x.host, listen: 8443, to_port: 443, profile: "pp" }];
      x.entries = [...new Set([...x.entries, e.name])];
      return { state: srvState(), profile: "pp", note: null, probe: [{ index: 0, label: `${e.name} → ${x.name} · VLESS`, kind: "vless", summary: "", ok: 3, rounds: 3, median_ms: 1180, best_ms: 1100, error: null }] };
    },
    serverCascadeRemove: async (entry, exit) => {
      await steps([["ok", "Каскад убран"]]);
      const e = servers.find((x) => x.id === entry)!;
      e.pipes = e.pipes.filter((p) => p.to !== exit);
      return srvState();
    },
    serverUninstall: async (id) => {
      await steps([["step", "Удаляю sing-box и /opt/wpx"], ["ok", "С сервера убрано всё, что ставил wpx"]]);
      const s = servers.find((x) => x.id === id)!;
      Object.assign(s, { vless: null, hy2: null, awg: null, xhttp: null, mtproxy: null, pipes: [], runtime: "" });
      return srvState();
    },
    serverFirewall: async (id, on) => {
      await steps(on ? [["step", "Файрвол: открыто только SSH и VPN (TCP 22 443 · UDP 443 35248 50738)"], ["step", "Проверяю, что SSH пускает новым соединением (иначе через 90 с правила снимутся сами)"], ["ok", "Файрвол включён и переживёт перезагрузку"]]
        : [["step", "Выключаю файрвол wpx"], ["ok", "Файрвол wpx выключен"]]);
      const s = servers.find((x) => x.id === id)!;
      s.fw = on;
      s.facts!.fw = on;
      return srvState();
    },
    serverCheck: async (id) => {
      await later(null, 2500);
      const s = servers.find((x) => x.id === id)!;
      const blocked = q.get("blocked") === "1";
      return { server: s.name, verdict: blocked ? "bad" : "ok",
        summary: blocked ? `Сервер работает, а с вашего ПК до него не доходит — похоже, провайдер блокирует ${s.host}` : "Всё работает: сервер, его интернет и путь от ПК",
        steps: [
          blocked ? { title: "ПК → сервер (SSH)", verdict: "bad", detail: `напрямую не достучаться (таймаут), а через «Helsinki» — да: похоже, провайдер ПК блокирует адрес ${s.host}` } : { title: "ПК → сервер (SSH)", verdict: "ok", detail: "сервер отвечает напрямую" },
          { title: "Службы VPN на сервере", verdict: "ok", detail: "sing-box работает · AmneziaWG работает" },
          { title: "Сервер → интернет", verdict: "ok", detail: "есть · 10 мс · нагрузка 0.00 · свободно 78 МБ" },
          ...(blocked ? [] : [{ title: "Сервер видит ваш ПК", verdict: "ok" as const, detail: "ваш ПК на связи по AmneziaWG (рукопожатие 17 с назад) · 1 TCP-соединений VPN с вашего адреса" }]),
          { title: "ПК → VPN (через провайдера)", verdict: blocked ? "bad" : "ok", detail: blocked ? "не проходят: VLESS (таймаут) · Hysteria2 (таймаут) · AmneziaWG (таймаут)" : "работают: VLESS 1580 мс · Hysteria2 1174 мс · AmneziaWG 1424 мс" },
        ],
        advice: blocked ? [{ kind: "cascade", text: "Пустить через «Helsinki» (198.51.100.20): каскад, ключи не меняются", entry: "s2" }, { kind: "move", text: "Переехать на другой VPS: wpx перенесёт протоколы, ключи и доступы", entry: null }] : [] };
    },
    serverUpdate: async (id) => { await steps([["step", "sing-box → 1.14.4 (не поднимется — верну прежний)"], ["ok", "sing-box: новая версия работает"]]); servers.find((x) => x.id === id)!.updates = []; return srvState(); },
    serverMovePlan: async (from, to) => {
      const a = servers.find((x) => x.id === from)!, b = servers.find((x) => x.id === to)!;
      return { from: a.name, to: b.name, guests: a.guests.length, error: null, steps: [
        `На «${b.name}» ставлю VLESS+Reality, Hysteria2, AmneziaWG — с прежними ключами и портами, плюс защита сервера`,
        `Профиль «${a.name}» переедет на ${b.host} — правила, маршруты и резерв продолжат работать`,
        ...(a.guests.length ? [`Доступы (${a.guests.length}) переедут с прежними ключами — людям нужен новый QR: в нём адрес сервера`] : []),
      ] };
    },
    serverMove: async (from, to) => {
      await steps([["step", "Переезд: ставлю VPN с прежними ключами"], ["ok", "Запущено: TCP 443 · UDP 443"], ["ok", "Профиль теперь ведёт на новый сервер"], ["ok", "Переезд готов"]]);
      const a = servers.find((x) => x.id === from)!, b = servers.find((x) => x.id === to)!;
      Object.assign(b, { vless: a.vless, hy2: a.hy2, awg: a.awg, guests: a.guests, runtime: "docker" });
      return { state: srvState(), probe: [], profile: null, note: a.guests.length ? `Доступам (${a.guests.length}) нужен новый QR.` : null };
    },
    serverForget: async (id) => { await steps([["ok", "Ключ wpx убран с сервера"]]); servers = servers.filter((s) => s.id !== id); return srvState(); },
    onServerLog: (cb) => { srvLog = cb; },
    onServersChanged: () => {},
    leakCheck: async () => {
      await later(null, 2500);
      return { at: Date.now(), verdict: "ok", summary: "Утечек нет", items: [
        { key: "ip", title: "Ваш IP для сайтов", verdict: "ok", detail: "203.0.113.50, SG — адрес «Singapore»" },
        { key: "escape", title: "Выход мимо туннеля", verdict: "ok", detail: "закрыт — если VPN упадёт, интернет не пойдёт напрямую" },
        { key: "ipv6", title: "IPv6", verdict: "ok", detail: "у провайдера IPv6 нет — утечь нечему" },
        { key: "dns", title: "DNS", verdict: "ok", detail: "запросы к любым DNS перехватывает wpx — провайдер не видит, какие сайты вы открываете" },
        { key: "webrtc", title: "WebRTC (звонки в браузере)", verdict: "ok", detail: "UDP наружу закрыт — WebRTC адрес не выдаст" },
      ] };
    },
    supportReport: async () => { await later(null, 3000); return "C:\\Users\\you\\Downloads\\wpx-отчёт-2026-11-07-0240.txt"; },
    guestAdd: async (id, i) => {
      await steps([["step", `Новый доступ «${i.name || "Гость"}»: свои ключи`], ["step", "Конфиг: проверка, замена, запуск (при сбое — откат)"], ["ok", "Запущено: TCP 443 · UDP 443"],
        ["step", "AmneziaWG: ключи на лету, без перезапуска"], ["ok", "AmneziaWG: ключей на сервере 3 (с вашим)"], ["ok", `Доступ «${i.name || "Гость"}» готов — покажите QR или отправьте ссылку`]]);
      const s = servers.find((x) => x.id === id)!;
      const g = { id: "g" + Date.now(), name: i.name || "Гость", created: Date.now(), expires: i.expires, vless: i.vless, hy2: i.hy2, awg_ip: i.awg ? 5 : 0, via: i.via, off: false };
      s.guests = [...s.guests, g];
      return { state: srvState(), share: mockShare(s, g) };
    },
    guestUpdate: async (id, guest, off, expires) => {
      await steps([["step", off ? "отключаю доступ" : "включаю доступ"], ["ok", "Готово — остальные подключения не прерывались"]]);
      const s = servers.find((x) => x.id === id)!;
      s.guests = s.guests.map((g) => (g.id === guest ? { ...g, off, expires } : g));
      return srvState();
    },
    guestRemove: async (id, guest) => {
      await steps([["step", "Удаляю доступ и его ключи"], ["ok", "Больше не подключится; остальные не заметили"]]);
      const s = servers.find((x) => x.id === id)!;
      s.guests = s.guests.filter((g) => g.id !== guest);
      return srvState();
    },
    guestShare: async (id, guest) => {
      const s = servers.find((x) => x.id === id)!;
      return mockShare(s, s.guests.find((g) => g.id === guest)!);
    },
    guestSaveConf: async () => "C:\\Users\\you\\Downloads\\wpx-Singapore-iPhone.conf",
    guestStats: async () => [
      { id: "g1", handshake: Math.floor(Date.now() / 1000) - 95, rx: 1_250_000_000, tx: 86_000_000 },
      { id: "g2", handshake: Math.floor(Date.now() / 1000) - 3600 * 26, rx: 412_000_000, tx: 31_000_000 },
    ],
    profileTest: (i) => later({
      http: i.http_port ? { ok: true, connect_ms: 341, ready_ms: 702, err: null } : null,
      socks: i.socks_port ? { ok: false, connect_ms: null, ready_ms: null, err: "нет ответа (таймаут)" } : null,
    }),
    profileActivate: async (id) => {
      await later(null, 7000);
      engineKind = "wpx";
      profiles = profiles.map((p) => ({ ...p, active: p.id === id }));
      return ok();
    },
    engineInfo: async (): Promise<EngineInfo> => ({
      kind: engineKind, boot: engineKind === "wpx" ? boot : null, heal, net: { ...net }, interfaces: ["Ethernet", "Wi-Fi"],
      lists: [["ru-inside", "Заблокированное и замедленное в РФ — домены (itdoginfo, ~1200)"], ["telegram-ip", "Telegram — подсети"], ["meta-ip", "Meta — подсети"],
        ["discord-ip", "Discord — подсети (голос)"], ["twitter-ip", "X (Twitter) — подсети"], ["antifilter-ip", "antifilter: подсети от сообщества (~900)"], ["ru-outside", "Российские сайты, которые не открываются из-за границы (itdoginfo)"]],
      exits: [{ ip: "203.0.113.10", name: "Сингапур", ways: ["Hysteria2", "AmneziaWG", "VLESS"] }, { ip: "198.51.100.20", name: "Хельсинки", ways: ["Hysteria2 через Сингапур", "AmneziaWG через Сингапур", "VLESS через Сингапур"] }],
      presets: [["ai", "ИИ-сервисы (ChatGPT, Claude, Gemini, Perplexity, Grok, Copilot)"], ["youtube", "YouTube", ["youtube.com", "youtu.be", "googlevideo.com", "ytimg.com"]], ["telegram", "Telegram", ["telegram.org", "t.me"], ["telegram-ip"]], ["meta", "Instagram, WhatsApp, Facebook", ["instagram.com", "cdninstagram.com", "facebook.com", "fbcdn.net"]],
        ["discord", "Discord"], ["twitter", "X (Twitter)"], ["blocked", "Заблокированное и замедленное в РФ (itdoginfo, ~1200 сайтов)", [], ["ru-inside"]],
        ["ru", "Российские сайты (.ru, .рф, .su)", ["ru", "xn--p1ai", "su"], ["ru-outside"]]],
      wpx_dir: "C:\\ProgramData\\wpx\\engine",
      telemetry_list: ["events.data.microsoft.com", "telemetry.data.nvidia.com"], config_current: false, engine_outdated: false,
    }),
    setHeal: async (on) => { heal = on; return later(ok("Готово"), 1500); },
    engineUpdate: () => later(ok(), 5000),
    enginePause: async (on, minutes) => { await later(null, 300); paused = on; pauseUntil = on && minutes ? Date.now() + minutes * 60_000 : null; },
    conns: async () => {
      const apps = [["claude.exe", "api.anthropic.com"], ["Telegram.exe", "203.0.113.60"], ["chrome.exe", "www.youtube.com"], ["chrome.exe", "fonts.gstatic.com"], ["node.exe", "registry.npmjs.org"]];
      const direct = new Set(["fonts.gstatic.com", "registry.npmjs.org"]);
      t += 1;
      return {
        up_total: 210_000_000, down_total: 1_934_000_000,
        conns: apps.flatMap(([p, h], i) => Array.from({ length: i + 1 }, (_, k) => ({
          id: `${i}-${k}`, process: p, host: h, ip: "", port: 443, network: "tcp",
          up: (i + 1) * 4000 * t + k * 100, down: (i + 1) * 90_000 * t * (p === "chrome.exe" ? 4 : 1) + k * 1000,
          start: Date.now() - 60_000, via: direct.has(h) ? "DIRECT" : "wpx-1", rule: direct.has(h) ? "Match" : "DOMAIN-SUFFIX",
          route: direct.has(h) ? "direct" as const : "vpn" as const, label: direct.has(h) ? "" : "Сингапур · Hysteria2",
        }))),
      };
    },
    connsClose: async (ids) => ids.length,
    listItems: (id) => later({
      items: id.endsWith("-ip") ? ["91.108.4.0/22", "91.108.8.0/22", "149.154.160.0/20"]
        : [".ua", "1337x.to", "4pda.to", "chatgpt.com", "discord.com", "instagram.com", "linkedin.com", "medium.com", "rutracker.org", "youtube.com"],
      source: "fresh" as const, url: "https://raw.githubusercontent.com/itdoginfo/allow-domains/main/Russia/inside-clashx.lst",
    }, 700),
    speedTest: () => later({ at: Date.now(), ping_ms: 412, down_mbps: 13.6, up_mbps: 3.5, down_mb: 20.4, up_mb: 6, error: null }, 4000),
    speedHistory: async () => [{ at: Date.now() - 3_600_000, ping_ms: 398, down_mbps: 12.9, up_mbps: 3.6, down_mb: 19.4, up_mb: 6, error: null }],
    widgetToggle: () => window.open("/?view=widget", "wpxwidget", "width=240,height=150"),
    widgetClose: () => window.close(),
    widgetPin: async (on) => { pinned = on; return on; },
    widgetState: async () => ({ open: true, pinned, anchor: (new URLSearchParams(location.search).get("at") ?? "top") as import("./types").NotchAnchor, x: null, y: null, w: 240, h: 150 }),
    showMain: () => {},
    startResize: () => {},
    widgetShape: () => {},
    widgetMonitors: async () => [
      { name: "\\\\.\\DISPLAY1", label: "Экран 1 · 1920×1080 · основной", primary: true, current: true },
      { name: "\\\\.\\DISPLAY2", label: "Экран 2 · 2560×1440", primary: false, current: false },
    ],
    widgetSetMonitor: async () => {},
    widgetSetAnchor: async () => {},
    widgetDrag: async () => {},
    followForget: async (app, item) => { const r = net.rules.find((x) => x.kind === "app" && x.value.toLowerCase() === app.toLowerCase()); if (r) r.learned = (r.learned ?? []).filter((x) => x !== item); },
    dropInspect: async (path) => {
      await later(null, 250);
      if (/\.url$/i.test(path)) return { name: "youtube.com", site: "youtube.com", from: "url" };
      return { name: "Aion 2", exe: "D:\\Games\\Aion 2\\Binaries\\Win64\\Aion2.exe", dir: "D:\\Games\\Aion 2", icon: null, from: "lnk" };
    },
    netSave: async (n) => { net = n; },
    netCheck: async () => { await later(null, 900); return "Движок принял конфиг (sha256 3f9c1a2b7d4e)"; },
    engineApplyNet: () => later(ok(), 6000),
    restart: () => later(ok(), 6000),
    start: () => later(ok(), 4000),
    stop: () => later(ok("Движок остановлен"), 2000),
    setBoot: async (on) => { boot = on; return later(ok("Готово"), 1500); },
    deepTest: () => later(ok("Готово", '{"direct1":false,"direct2":false,"ipv6":false,"dns":false,"proxy":true}'), 8000),
    engineUninstall: () => later(ok(), 3000),
  };
}
