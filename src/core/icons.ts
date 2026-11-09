// Единый набор пиктограмм: 24×24, линия 1.6, цвет — currentColor.

const s = (body: string, extra = "") =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${body}</svg>`;

export const ICON = {
  pc: s('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8.5 20h7M12 16v4"/>'),
  lock: s('<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5M12 14v2.5"/>'),
  server: s('<rect x="4" y="4" width="16" height="7" rx="2"/><rect x="4" y="13" width="16" height="7" rx="2"/><path d="M8 7.5h.01M8 16.5h.01"/>'),
  entry: s('<circle cx="12" cy="12" r="8"/><path d="M8 12h8M13 9l3 3-3 3"/>'),
  app: s('<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 9h18M6.5 6.5h.01M9.5 6.5h.01"/>'),
  search: s('<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>'),
  pin: s('<path d="M12 21s-6.5-5.7-6.5-11.2a6.5 6.5 0 0 1 13 0C18.5 15.3 12 21 12 21z"/><circle cx="12" cy="9.8" r="2.4"/>'),
  globe: s('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>'),
  shield: s('<path d="M12 3l7 3v5.5c0 4.4-3 8-7 9.5-4-1.5-7-5.1-7-9.5V6z"/>'),
  shieldOk: s('<path d="M12 3l7 3v5.5c0 4.4-3 8-7 9.5-4-1.5-7-5.1-7-9.5V6z"/><path d="M9 12l2 2 4-4"/>'),
  layers: s('<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>'),
  bolt: s('<path d="M13 3L5 13.5h6L10 21l8-10.5h-6z"/>'),
  swap: s('<path d="M4 9h13l-3-3M20 15H7l3 3"/>'),
  cycle: s('<path d="M20 12a8 8 0 0 1-14.3 4.9M4 12a8 8 0 0 1 14.3-4.9"/><path d="M18.5 3v4.5H14M5.5 21v-4.5H10"/>'),
  power: s('<path d="M12 3v8"/><path d="M6.6 6.6a8 8 0 1 0 10.8 0"/>'),
  down: s('<path d="M12 4v15M6 13l6 6 6-6"/>'),
  up: s('<path d="M12 20V5M6 11l6-6 6 6"/>'),
  check: s('<circle cx="12" cy="12" r="9"/><path d="M8 12.2l2.7 2.7L16 9.6"/>'),
  alert: s('<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5h.01"/>'),
  off: s('<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>'),
  wait: s('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  link: s('<circle cx="6" cy="12" r="3"/><circle cx="18" cy="12" r="3"/><path d="M9 12h6"/>'),
  fork: s('<circle cx="5" cy="12" r="2.5"/><circle cx="19" cy="6" r="2.5"/><circle cx="19" cy="18" r="2.5"/><path d="M7.5 12H11c2 0 2.5-6 5.5-6M11 12c2 0 2.5 6 5.5 6"/>'),
  pulse: s('<path d="M3 12h4l2.5-6 4 12 2.5-6H21"/>'),
  game: s('<path d="M6 8h12a4 4 0 0 1 4 4v1a3.5 3.5 0 0 1-6.3 2.1L14.5 14h-5l-1.2 1.1A3.5 3.5 0 0 1 2 13v-1a4 4 0 0 1 4-4z"/><path d="M7 11v3M5.5 12.5h3"/><circle cx="16.5" cy="11.5" r=".6"/><circle cx="18.5" cy="13.5" r=".6"/>'),
};

/** Пиктограмма типа профиля: VPN — щит, прокси — парные стрелки, каскад — два узла, маршрут — развилка. */
export const TYPE_ICON = { vpn: ICON.shield, proxy: ICON.swap, cascade: ICON.link, route: ICON.fork, server: ICON.server };
