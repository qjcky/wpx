// Справка «Протоколы»: что это, как выглядит для провайдера, плюсы, минусы и
// когда брать.
// Открывается из «Путей», «Изменить VPN» и игрового режима.

import { esc, modal } from "../core/ui";

interface Proto { id: string; name: string; tag: string; short: string; looks: string; pros: string[]; cons: string[]; when: string }

const PROTOS: Proto[] = [
  {
    id: "wireguard", name: "AmneziaWG", tag: "UDP", short: "игры и звонки: самая низкая задержка",
    looks: "WireGuard с маскировкой: к рукопожатию добавляются пакеты-пустышки, служебные заголовки и размеры меняются — узнаваемого рисунка WireGuard не видно.",
    pros: ["минимальная задержка и накладные расходы", "стабилен, быстро переподключается при смене сети", "на телефоне — приложение AmneziaWG и один QR-код"],
    cons: ["только UDP: где режут UDP к зарубежным адресам, не работает", "один постоянный порт"],
    when: "игры, звонки, телефон — если UDP проходит",
  },
  {
    id: "hysteria2", name: "Hysteria2", tag: "UDP · QUIC", short: "плохой канал: держит скорость при потерях",
    looks: "QUIC, как у HTTP/3, со своим управлением скоростью. wpx может включить смену портов: клиент прыгает по диапазону UDP-портов, по одному порту не заблокировать.",
    pros: ["быстрый на плохих каналах: мобильный интернет, Wi-Fi, далёкий сервер", "низкая задержка — подходит для игр и видео"],
    cons: ["UDP: некоторые провайдеры душат QUIC к зарубежным адресам", "занимает канал напористо — на слабом роутере может мешать соседям по сети"],
    when: "мобильный интернет, далёкий сервер, потери пакетов",
  },
  {
    id: "vless", name: "VLESS + Reality", tag: "TCP", short: "проходит почти везде, похож на обычный HTTPS",
    looks: "Лёгкий протокол Xray. Reality выдаёт соединение за TLS 1.3 к настоящему популярному сайту (например, www.apple.com): своего домена и сертификата у сервера нет, а на проверочные запросы он отвечает как тот сайт.",
    pros: ["очень трудно отличить от обычного HTTPS", "TCP проходит там, где UDP режут", "понимают почти все приложения: v2RayTun, Happ, Streisand, Hiddify"],
    cons: ["TCP: при потерях пакетов всё ждёт повторов — игры и звонки подлагивают", "на некоторых сетях долгие соединения к зарубежным хостингам «замирают»"],
    when: "основной путь, когда UDP режут; сайты и приложения",
  },
  {
    id: "xhttp", name: "VLESS + XHTTP", tag: "TCP · HTTP", short: "запасной путь при жёсткой фильтрации",
    looks: "Тот же VLESS с Reality, но данные идут обычными HTTP-запросами — запрос и ответ разными потоками, без рисунка «TLS внутри TLS» и без одного долгого соединения.",
    pros: ["проходит там, где «замирают» долгие соединения и узнают VLESS", "можно пустить через CDN"],
    cons: ["медленнее и с большей задержкой — видно в «Путях»", "понимают не все приложения: v2RayTun, Happ, Hiddify, v2rayNG"],
    when: "когда VLESS замирает или его узнают",
  },
  {
    id: "mtproxy", name: "MTProxy", tag: "только Telegram", short: "Telegram без VPN-приложения",
    looks: "Прокси Telegram с маскировкой под HTTPS к выбранному сайту (FakeTLS).",
    pros: ["ссылка открывается прямо в Telegram — ничего ставить не нужно", "удобно раздать близким"],
    cons: ["работает только для Telegram"],
    when: "Telegram на чужом телефоне или ПК",
  },
  {
    id: "trojan", name: "Trojan", tag: "TCP · TLS", short: "HTTPS-маскировка со своим доменом",
    looks: "Выдаёт себя за обычный HTTPS-сайт; нужен свой домен и сертификат.",
    pros: ["похож на обычный сайт", "понимают почти все приложения"],
    cons: ["нужен домен", "в wpx — только по ссылке, сервер wpx его не ставит"],
    when: "если такой доступ дал провайдер VPN",
  },
  {
    id: "ss", name: "Shadowsocks", tag: "TCP и UDP", short: "старый простой шифрованный прокси",
    looks: "Шифрованный поток без маскировки под что-то знакомое.",
    pros: ["простой, быстрый, понимают все приложения"],
    cons: ["на многих сетях его уже распознают по виду трафика", "в wpx — только по ссылке"],
    when: "если другого нет",
  },
  {
    id: "http", name: "HTTP и SOCKS5 прокси", tag: "TCP", short: "нужен конкретный IP, а не обход блокировок",
    looks: "Обычный прокси: провайдер видит соединение с прокси, у HTTP-прокси нет UDP.",
    pros: ["нужен конкретный IP (платные прокси, работа)", "годится входом каскада"],
    cons: ["нет маскировки", "HTTP-прокси не передаёт UDP: звонки и игры через него не пойдут"],
    when: "нужен IP определённой страны или сети",
  },
];

/** Подпись пути → справка: «Hy2», «AWG», «XHTTP»… */
export function protoId(kind: string, net = "") {
  if (net === "xhttp") return "xhttp";
  return kind === "awg" ? "wireguard" : kind === "shadowsocks" ? "ss" : kind === "socks5" ? "http" : kind;
}

function card(p: Proto, open: boolean) {
  const li = (a: string[]) => a.map((x) => `<li>${esc(x)}</li>`).join("");
  return `<details class="pf-card" data-p="${p.id}" ${open ? "open" : ""}><summary><b>${esc(p.name)}</b><span class="tag">${esc(p.tag)}</span><small>${esc(p.short)}</small></summary>
    <p>${esc(p.looks)}</p>
    <div class="pf-pc"><div><h4>Плюсы</h4><ul>${li(p.pros)}</ul></div><div><h4>Минусы</h4><ul>${li(p.cons)}</ul></div></div>
    <p class="note">Когда брать: ${esc(p.when)}.</p></details>`;
}

const PICK = `<div class="pf-pick"><h3>Как выбрать</h3><ul>
  <li><b>Игры и звонки</b> — AmneziaWG, затем Hysteria2.</li>
  <li><b>Плохой канал, мобильный интернет, далёкий сервер</b> — Hysteria2.</li>
  <li><b>UDP режут или жёсткая фильтрация</b> — VLESS + Reality; замирает — XHTTP или каскад через сервер в России.</li>
  <li><b>Лучше держать в профиле несколько</b>: заблокируют один — wpx сам уйдёт на другой.</li></ul></div>`;

/** Открыть справку; `focus` — раскрыть этот протокол. */
export function showProtocols(focus?: string) {
  void modal("Протоколы", `${PICK}<div class="pf-list">${PROTOS.map((p) => card(p, p.id === focus)).join("")}</div>`, null, "Понятно");
  if (focus) window.setTimeout(() => document.querySelector(`.pf-card[data-p="${focus}"]`)?.scrollIntoView({ block: "nearest" }), 50);
}
