//! Путь между своими серверами: доходит ли с одного (вход, промежуточный) до
//! порта другого — по IPv4 и по IPv6 — и отвечает ли там именно этот сервер
//! (ключ SSH), и держится ли путь, а не мелькает. Из России до части
//! зарубежных адресов IPv4 режут, IPv6 где-то проходит, а где-то пропускается
//! «волнами» (секунд 10–20 открыто, потом с минуту нет); а по адресу из «своей»
//! IPv6-подсети может ответить чужая машина.

use super::*;

/// Попыток TCP на адрес; путь годится, если открылось не меньше `PASS`.
const TRIES: u8 = 3;
const PASS: u8 = 2;
/// Устойчивость: попыток раз в 4 с (около полуминуты) и сколько должно пройти.
pub(super) const STEADY_TRIES: u8 = 8;
const STEADY_PASS: u8 = 7;

/// Держится ли путь: «волны» фильтра быстрая проба не отличит от рабочего пути.
const STEADY: &str = r#"
ok=0
for i in $(seq "$TRIES"); do timeout 3 bash -c "</dev/tcp/$ADDR/$PORT" 2>/dev/null && ok=$((ok+1)); sleep 4; done
echo "steady $ok"
"#;

/// На сервере, откуда смотрим: по каждому адресу — TCP на порт, ping и ключи SSH.
/// TCP — первым: первое соединение по IPv6 бывает долгим или теряется, попытки
/// «прогревают» путь; ключи — следом, с повтором.
const PROBE: &str = r#"
for a in $ADDRS; do
  ok=0
  for i in $(seq "$TRIES"); do timeout 3 bash -c "</dev/tcp/$a/$PORT" 2>/dev/null && ok=$((ok+1)); done
  ping -c 2 -W 2 "$a" >/dev/null 2>&1 && p=1 || p=0
  echo "tcp $a $ok $p"
  for t in 1 2; do
    k=$(ssh-keyscan -T 6 -p "$SSHP" "$a" 2>/dev/null | ssh-keygen -lf - 2>/dev/null | awk -v a="$a" '{print "key " a " " $2}')
    [ -n "$k" ] && { echo "$k"; break; }
  done
done
true
"#;

/// Как с одного сервера доходит до одного адреса другого.
#[derive(Clone, Debug, Default, PartialEq)]
pub(super) struct Reach {
    pub addr: String,
    /// Сколько из `TRIES` попыток TCP открылось.
    pub tcp: u8,
    pub ping: bool,
    /// Отпечатки ключей SSH на этом адресе (пусто — ssh-keyscan нет или не ответил).
    pub keys: Vec<String>,
}

impl Reach {
    pub fn family(&self) -> &'static str {
        if self.addr.contains(':') { "IPv6" } else { "IPv4" }
    }

    /// Ключ SSH на адресе — того же сервера: да, нет или не узнать (ключей нет
    /// или сервер ещё не добавлен и его ключ неизвестен).
    fn same(&self, s: &Server) -> Option<bool> {
        (!self.keys.is_empty() && !s.host_key.is_empty()).then(|| self.keys.iter().any(|k| ssh::same_fingerprint(k, &s.host_key)))
    }

    /// Годится для трубы: проходит, и это тот самый сервер. Основной адрес wpx
    /// уже проверил по ключу сам; другой (IPv6) — только при совпавшем ключе.
    pub fn fits(&self, s: &Server) -> bool {
        self.tcp >= PASS && self.same(s) != Some(false) && (self.addr == s.host || self.same(s) == Some(true))
    }

    /// «IPv6 2a12:…: TCP 3 из 3» — для хода операции и «Где рвётся?».
    pub fn line(&self, s: &Server) -> String {
        let mut t = format!("{} {}: TCP {} из {TRIES}", self.family(), self.addr, self.tcp);
        if self.same(s) == Some(false) {
            t.push_str(", отвечает чужой сервер (другой ключ SSH)");
        } else if self.tcp < PASS && self.ping {
            t.push_str(", ping проходит");
        }
        t
    }
}

/// Адреса сервера для трубы: основной и IPv6, если он есть.
pub(super) fn addrs(s: &Server) -> Vec<String> {
    let mut v = vec![s.host.clone()];
    if let Some(a) = s.facts.as_ref().map(|f| f.ipv6.clone()).filter(|a| !a.is_empty() && *a != s.host) {
        v.push(a);
    }
    v
}

/// Этот адрес — сервера `s` (основной или IPv6).
pub(super) fn at(s: &Server, addr: &str) -> bool {
    addrs(s).iter().any(|a| a == addr)
}

/// По какому порту судить о пути: TCP-порт VPN, иначе SSH.
fn port_of(s: &Server) -> u16 {
    s.vless.as_ref().map(|v| v.port).or(s.xhttp.as_ref().map(|x| x.port)).unwrap_or(s.port)
}

/// Сколько из `STEADY_TRIES` попыток за полминуты прошло до адреса `addr` сервера `to`.
pub(super) async fn steady(c: &Conn, to: &Server, addr: &str) -> Result<u8, String> {
    let env = [("ADDR", addr.to_string()), ("PORT", port_of(to).to_string()), ("TRIES", STEADY_TRIES.to_string())];
    let o = c.sh(&env, STEADY, b"", 120).await?;
    Ok(o.out.lines().find_map(|l| l.strip_prefix("steady ")).and_then(|v| v.trim().parse().ok()).unwrap_or(0))
}

/// Держится: прошло достаточно из `STEADY_TRIES`.
pub(super) fn holds(n: u8) -> bool {
    n >= STEADY_PASS
}

/// С сервера соединения `c` — до всех адресов `to`.
pub(super) async fn probe(c: &Conn, to: &Server) -> Result<Vec<Reach>, String> {
    let env = [("ADDRS", addrs(to).join(" ")), ("PORT", port_of(to).to_string()), ("SSHP", to.port.to_string()), ("TRIES", TRIES.to_string())];
    Ok(parse(&c.sh(&env, PROBE, b"", 120).await?.out))
}

fn parse(out: &str) -> Vec<Reach> {
    let mut r: Vec<Reach> = vec![];
    for line in out.lines() {
        let f: Vec<&str> = line.split_whitespace().collect();
        match f.as_slice() {
            ["tcp", a, ok, p] => r.push(Reach { addr: a.to_string(), tcp: ok.parse().unwrap_or(0), ping: *p == "1", keys: vec![] }),
            ["key", a, fp] => {
                if let Some(x) = r.iter_mut().find(|x| x.addr == *a) {
                    x.keys.push(fp.to_string());
                }
            }
            _ => {}
        }
    }
    r
}

/// Адрес для трубы: первый годный (основной раньше IPv6).
pub(super) fn pick<'a>(r: &'a [Reach], s: &Server) -> Option<&'a Reach> {
    r.iter().find(|x| x.fits(s))
}

/// Все адреса одной строкой — для «Где рвётся?» и ошибок.
pub(super) fn summary(r: &[Reach], s: &Server) -> String {
    r.iter().map(|x| x.line(s)).collect::<Vec<_>>().join(" · ")
}

/// Не доходит ни по одному адресу: что видно и почему так бывает.
fn blocked(from: &Server, to: &Server, r: &[Reach]) -> String {
    let why = if r.iter().any(|x| x.ping) { " — ping проходит, значит, соединения режут по пути или у провайдера" } else { "" };
    format!("С «{}» до «{}» соединения не доходят ({}){why}.", from.name, to.name, summary(r, to))
}

/// Адрес `to` для трубы с сервера `from` (соединение `c`): проверяет оба адреса,
/// потом — что выбранный держится, и пишет в ход операции, что выбрал и почему;
/// не дошло или рвётся — объяснение.
pub(super) async fn choose(c: &Conn, from: &Server, to: &Server, log: &Log) -> Result<String, String> {
    log("step", format!("Проверяю путь «{}» → «{}»", from.name, to.name));
    let r = probe(c, to).await?;
    let fit: Vec<&Reach> = r.iter().filter(|x| x.fits(to)).collect();
    if fit.is_empty() {
        return Err(blocked(from, to, &r));
    }
    log("step", "Проверяю, что путь держится, — около полуминуты".into());
    let mut shaky = vec![];
    for x in fit {
        let n = steady(c, to, &x.addr).await?;
        if holds(n) {
            let how = if x.addr == to.host { String::new() } else { format!(" — труба пойдёт по {}", x.family()) };
            log("ok", format!("{} · держится: {n} из {STEADY_TRIES}{how}", x.line(to)));
            return Ok(x.addr.clone());
        }
        shaky.push(format!("{} {}: TCP {n} из {STEADY_TRIES}", x.family(), x.addr));
    }
    Err(shaky_path(from, to, &shaky))
}

/// Проходит, но рвётся: VPN по такому пути обрывался бы каждую минуту.
fn shaky_path(from: &Server, to: &Server, shaky: &[String]) -> String {
    format!(
        "С «{}» до «{}» соединения проходят рывками ({} за полминуты) — похоже на фильтр, что пропускает их волнами: VPN по такому пути будет обрываться.",
        from.name, to.name, shaky.join(" · ")
    )
}

/// Путь с сервера соединения `c` до `to` держится — по любому его годному адресу.
async fn holds_to(c: &Conn, to: &Server) -> bool {
    let Ok(r) = probe(c, to).await else { return false };
    for x in r.iter().filter(|x| x.fits(to)) {
        if steady(c, to, &x.addr).await.is_ok_and(holds) {
            return true;
        }
    }
    false
}

/// Промежуточный для каскада `from` → `to`, когда напрямую не держится: свой
/// сервер, до которого держится путь с `from` (соединение `c`) и с которого —
/// до `to`. Порядок задаёт человек (первый прыжок и конечный), wpx лишь
/// находит, через что их соединить.
pub(super) async fn middle(st: &Store, c: &Conn, from: &Server, to: &Server, log: &Log) -> Option<Server> {
    let quiet: Log = Arc::new(|_, _| {});
    for m in st.servers.iter().filter(|m| m.id != from.id && m.id != to.id) {
        log("step", format!("Пробую через «{}» — около минуты", m.name));
        if !holds_to(c, m).await {
            continue;
        }
        let Ok(cm) = open(st, m, &quiet).await else { continue };
        let ok = holds_to(&cm, to).await;
        cm.close().await;
        if ok {
            return Some(m.clone());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exit() -> Server {
        let mut s = Server { host: "203.0.113.20".into(), host_key: "SHA256:ZXhpdC1zZXJ2ZXIta2V5LWZvci10ZXN0cy1vbmx5AA".into(), ..Default::default() };
        s.facts = Some(Facts { ipv6: "2001:db8:503d::2".into(), ..Default::default() });
        s
    }

    #[test]
    fn picks_ipv6_when_ipv4_is_filtered() {
        let s = exit();
        let out = "tcp 203.0.113.20 0 1\ntcp 2001:db8:503d::2 3 0\nkey 2001:db8:503d::2 SHA256:ZXhpdC1zZXJ2ZXIta2V5LWZvci10ZXN0cy1vbmx5AA\n";
        let r = parse(out);
        assert_eq!(pick(&r, &s).map(|x| x.addr.as_str()), Some("2001:db8:503d::2"));
        assert!(r[0].line(&s).ends_with("TCP 0 из 3, ping проходит"));
        assert!(at(&s, "2001:db8:503d::2") && at(&s, "203.0.113.20") && !at(&s, "2001:db8:503d::3"));
    }

    #[test]
    fn never_picks_a_stranger() {
        // Бывает: по IPv6 «своей» подсети отвечает чужая машина.
        let s = exit();
        let r = parse("tcp 203.0.113.20 0 1\ntcp 2001:db8:503d::2 3 1\nkey 2001:db8:503d::2 SHA256:c3RyYW5nZXItbWFjaGluZS1rZXktZm9yLXRlc3RzAA\n");
        assert_eq!(pick(&r, &s), None);
        assert!(r[1].line(&s).contains("чужой сервер"));
        // Без ssh-keyscan: основной адрес годится (его wpx проверил сам), IPv6 — нет.
        let r = parse("tcp 203.0.113.20 3 1\ntcp 2001:db8:503d::2 3 1\n");
        assert_eq!(pick(&r, &s).map(|x| x.addr.as_str()), Some("203.0.113.20"));
        let r = parse("tcp 203.0.113.20 0 1\ntcp 2001:db8:503d::2 3 1\n");
        assert_eq!(pick(&r, &s), None);
        // Сервер ещё не добавлен — его ключ неизвестен: основной адрес годится по TCP.
        let new = Server { host: "203.0.113.20".into(), ..Default::default() };
        let r = parse("tcp 203.0.113.20 3 1\nkey 203.0.113.20 SHA256:ZXhpdC1zZXJ2ZXIta2V5LWZvci10ZXN0cy1vbmx5AA\n");
        assert_eq!(pick(&r, &new).map(|x| x.addr.as_str()), Some("203.0.113.20"));
    }

    #[test]
    fn explains_a_dead_path() {
        let s = exit();
        let from = Server { name: "msk".into(), ..Default::default() };
        let to = Server { name: "Вена".into(), ..s.clone() };
        let r = parse("tcp 203.0.113.20 0 1\n");
        let e = blocked(&from, &to, &r);
        assert_eq!(e, "С «msk» до «Вена» соединения не доходят (IPv4 203.0.113.20: TCP 0 из 3, ping проходит) — ping проходит, значит, соединения режут по пути или у провайдера.");
        let w = shaky_path(&from, &to, &["IPv6 2001:db8:503d::2: TCP 3 из 8".into()]);
        assert!(w.contains("(IPv6 2001:db8:503d::2: TCP 3 из 8 за полминуты)") && !holds(3) && holds(7), "{w}");
    }
}
