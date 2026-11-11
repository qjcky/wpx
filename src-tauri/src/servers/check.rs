//! «Где рвётся» до самого сервера: ПК → SSH → службы VPN на сервере →
//! интернет сервера → протоколы с ПК (с проверкой на заморозку). Только
//! чтение. Итог — понятный вердикт и что сделать: каскад через другой
//! свой сервер, переезд, перезапуск VPN, вопрос хостеру.

use super::*;

#[derive(Serialize, Clone, Debug)]
pub struct Step {
    pub title: String,
    /// "ok" | "bad" | "warn" | "skip"
    pub verdict: &'static str,
    pub detail: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct Advice {
    /// "cascade" — пустить через вход `entry`; "move" — переезд;
    /// "redeploy" — перезапустить VPN на сервере; "hoster" — к хостеру.
    pub kind: &'static str,
    pub text: String,
    pub entry: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct ServerCheck {
    pub server: String,
    /// "ok" | "bad" | "warn"
    pub verdict: &'static str,
    pub summary: String,
    pub steps: Vec<Step>,
    pub advice: Vec<Advice>,
}

/// Состояние служб и сети на сервере (только чтение).
const STATE: &str = r#"
if docker inspect wpx-singbox >/dev/null 2>&1; then echo "sb=$(docker inspect -f '{{.State.Running}}' wpx-singbox)"
elif [ -f /etc/systemd/system/wpx-singbox.service ]; then systemctl is-active --quiet wpx-singbox && echo sb=true || echo sb=false
else echo sb=none; fi
if docker inspect wpx-awg >/dev/null 2>&1; then
  echo "awg=$(docker inspect -f '{{.State.Running}}' wpx-awg)"
  docker exec wpx-awg awg show wg0 latest-handshakes 2>/dev/null | sed 's/^/hs=/'
  # Интерфейс поднят на своём порту и правило Docker для порта есть (его стирает
  # перезагрузка правил файрвола — контейнер «работает», а пакеты не доходят).
  echo "awg_port=$(docker exec wpx-awg awg show wg0 listen-port 2>/dev/null)"
  echo "awg_oom=$(journalctl -k --since -2d 2>/dev/null | grep -c 'Killed process.*amneziawg-go')"
  if [ -n "${AWGP:-}" ] && command -v iptables >/dev/null 2>&1; then
    echo "awg_nat=$(iptables -t nat -S 2>/dev/null | grep -c -- "--dport $AWGP ")"
  fi
else echo awg=none; fi
for p in $TCP; do ss -tlnH "sport = :$p" | grep -q . && echo "tcp_ok=$p" || echo "tcp_no=$p"; done
for p in $UDP; do ss -ulnH "sport = :$p" | grep -q . && echo "udp_ok=$p" || echo "udp_no=$p"; done
if command -v curl >/dev/null 2>&1; then echo "net=$(curl -s -o /dev/null -m 6 -w '%{http_code} %{time_total}' http://www.gstatic.com/generate_204)"
else wget -q -T 6 -O /dev/null http://www.gstatic.com/generate_204 && echo "net=204 0" || echo "net=000 0"; fi
getent hosts www.google.com >/dev/null 2>&1 && echo dns=1 || echo dns=0
me="${WPX_ME:-}"; echo "me=$me"
if [ -n "$me" ] && [ -n "$TCP" ]; then
  echo "pc_tcp=$(ss -tnH state established 2>/dev/null | awk -v m="$me" -v ps=" $TCP " '{l=$3; sub(/.*:/,"",l); r=$4; sub(/:[0-9]+$/,"",r); gsub(/[][]/,"",r); sub(/^::ffff:/,"",r); if (r==m && index(ps," "l" ")) c++} END{print c+0}')"
fi
# Без шума: «invalid connection» — сканеры и пробы, Reality их и должен отбивать.
clean() { sed 's/\x1b\[[0-9;]*m//g' | grep -iE 'error|fatal' | grep -viE 'invalid connection|connection reset|i/o timeout|EOF' | tail -3 | sed 's/^/err=/'; }
if docker inspect wpx-singbox >/dev/null 2>&1; then docker logs --since 30m wpx-singbox 2>&1 | clean
else journalctl -u wpx-singbox --since '-30min' --no-pager -o cat 2>/dev/null | clean; fi
echo "load=$(cut -d' ' -f1 /proc/loadavg)"; free -m | awk 'NR==2{print "avail="$7}'
true
"#;

#[derive(Default, Debug)]
struct State {
    sb: String,
    awg: String,
    /// Порт, на котором слушает интерфейс AWG в контейнере (пусто — не поднят).
    awg_port: String,
    /// Сколько правил NAT Docker ведут на порт AWG (None — не проверить).
    awg_nat: Option<u32>,
    /// Сколько раз за 2 дня система убила amneziawg-go за нехватку памяти.
    awg_oom: u32,
    hs: Vec<(String, i64)>,
    tcp_no: Vec<u16>,
    udp_no: Vec<u16>,
    net_code: String,
    net_s: f64,
    dns: bool,
    me: String,
    pc_tcp: Option<u32>,
    errs: Vec<String>,
    load: String,
    avail: u32,
}

fn parse_state(out: &str) -> State {
    let mut s = State::default();
    for line in out.lines() {
        let Some((k, v)) = line.split_once('=') else { continue };
        match k {
            "sb" => s.sb = v.trim().into(),
            "awg" => s.awg = v.trim().into(),
            "awg_port" => s.awg_port = v.trim().into(),
            "awg_nat" => s.awg_nat = v.trim().parse().ok(),
            "awg_oom" => s.awg_oom = v.trim().parse().unwrap_or(0),
            "hs" => {
                let mut f = v.split_whitespace();
                if let (Some(k), Some(t)) = (f.next(), f.next()) {
                    s.hs.push((k.into(), t.parse().unwrap_or(0)));
                }
            }
            "tcp_no" => s.tcp_no.extend(v.trim().parse::<u16>().ok()),
            "udp_no" => s.udp_no.extend(v.trim().parse::<u16>().ok()),
            "net" => {
                let mut f = v.split_whitespace();
                s.net_code = f.next().unwrap_or("").into();
                s.net_s = f.next().and_then(|x| x.parse().ok()).unwrap_or(0.0);
            }
            "dns" => s.dns = v.trim() == "1",
            "me" => s.me = v.trim().into(),
            "pc_tcp" => s.pc_tcp = v.trim().parse().ok(),
            "err" => s.errs.push(v.chars().take(200).collect()),
            "load" => s.load = v.trim().into(),
            "avail" => s.avail = v.trim().parse().unwrap_or(0),
            _ => {}
        }
    }
    s
}

fn step(title: impl Into<String>, verdict: &'static str, detail: impl Into<String>) -> Step {
    Step { title: title.into(), verdict, detail: detail.into() }
}

/// SSH: как обычно; не вышло напрямую — через другой свой сервер (признак
/// блокировки IP у провайдера ПК). Возвращает соединение и через кого вошли.
async fn reach(st: &Store, s: &Server) -> (Option<Conn>, Option<String>, String) {
    let quiet: Log = Arc::new(|_, _| {});
    match open(st, s, &quiet).await {
        Ok(c) => (Some(c), s.via.clone(), String::new()),
        Err(e) if s.via.is_none() => {
            for o in st.servers.iter().filter(|o| o.id != s.id && o.via.is_none()) {
                let tmp = Server { via: Some(o.id.clone()), ..s.clone() };
                if let Ok(c) = open(st, &tmp, &quiet).await {
                    return (Some(c), Some(o.id.clone()), e);
                }
            }
            (None, None, e)
        }
        Err(e) => (None, None, e),
    }
}

pub(super) async fn run(id: &str) -> Result<ServerCheck, String> {
    let st = load();
    let s = st.servers.iter().find(|x| x.id == id).cloned().ok_or("сервер не найден")?;
    if s.vless.is_none() && s.hy2.is_none() && s.awg.is_none() && s.pipes.is_empty() {
        return Err("На сервере ещё нет VPN от wpx — сначала «Установить VPN»".into());
    }
    let sec = secrets_of(&s)?;
    let name = |id: &str| st.servers.iter().find(|x| x.id == id).map(|x| x.name.clone()).unwrap_or_default();

    // Точки, которыми ПК реально ходит к серверу: напрямую (если доступен) и трубы входов.
    let mut eps = vec![];
    if s.via.is_none() {
        eps.extend(endpoints(&s, &sec, &s.host, Ports::of(&s), &format!("{} напрямую", s.name), None));
    }
    for e in st.servers.iter().filter(|e| e.id != s.id && e.via.is_none()) {
        let pipes: Vec<Pipe> = e.pipes.iter().filter(|p| p.to == s.id).cloned().collect();
        if !pipes.is_empty() {
            eps.extend(endpoints(&s, &sec, &e.host, Ports::via(&s, &pipes), &format!("через {}", e.name), Some(&e.id)));
        }
    }
    let (tcp, mut udp) = our_ports(&s);
    udp.extend(s.awg.iter().map(|a| a.port));
    let list = |v: &[u16]| v.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(" ");

    let probe = async {
        if eps.is_empty() {
            return Ok(vec![]);
        }
        let opt = sandbox::Options { interface: Some(netcfg::load().interface), rounds: 2, timeout_ms: 8000, bulk: true, ..Default::default() };
        sandbox::probe(eps.clone(), opt).await
    };
    let remote = async {
        let (c, via, err) = reach(&st, &s).await;
        let Some(c) = c else { return (None, via, err) };
        let awgp = s.awg.as_ref().map(|a| a.port.to_string()).unwrap_or_default();
        let o = c.sh(&[("TCP", list(&tcp)), ("UDP", list(&udp)), ("AWGP", awgp)], STATE, b"", 60).await;
        c.close().await;
        (o.ok().map(|o| parse_state(&o.out)), via, err)
    };
    let (probe, (state, via, ssh_err)) = tokio::join!(probe, remote);
    let probe = probe.unwrap_or_default();

    let mut steps = vec![];
    let mut advice = vec![];
    // 1. SSH.
    let blocked_ssh = s.via.is_none() && via.is_some();
    match (&state, &via) {
        (None, _) => steps.push(step("ПК → сервер (SSH)", "bad", format!("не отвечает ни напрямую, ни через другие ваши серверы: {ssh_err}"))),
        (Some(_), Some(v)) if blocked_ssh => steps.push(step("ПК → сервер (SSH)", "bad", format!("напрямую не достучаться ({ssh_err}), а через «{}» — да: похоже, провайдер ПК блокирует адрес {}", name(v), s.host))),
        (Some(_), Some(v)) => steps.push(step("ПК → сервер (SSH)", "ok", format!("через «{}» — как и задумано", name(v)))),
        (Some(_), None) => steps.push(step("ПК → сервер (SSH)", "ok", "сервер отвечает напрямую")),
    }
    // 2–4. Сервер изнутри.
    let mut services_bad = false;
    let mut net_bad = false;
    if let Some(x) = &state {
        let mut bits = vec![];
        let mut bad = false;
        if s.vless.is_some() || s.hy2.is_some() || !s.pipes.is_empty() {
            match x.sb.as_str() {
                "true" => bits.push("sing-box работает".to_string()),
                "none" => {
                    bad = true;
                    bits.push("sing-box не установлен".into())
                }
                _ => {
                    bad = true;
                    bits.push("sing-box остановлен".into())
                }
            }
        }
        if let Some(a) = &s.awg {
            if x.awg != "true" {
                bad = true;
                bits.push("AmneziaWG не запущен".into());
            } else if x.awg_port != a.port.to_string() {
                bad = true;
                bits.push(if x.awg_oom > 0 { "AmneziaWG упал: не хватило памяти контейнеру" } else { "AmneziaWG: контейнер запущен, но интерфейс не поднят" }.into());
            } else if x.awg_nat == Some(0) {
                // Правило стёрла перезагрузка правил файрвола на сервере — порт
                // «слушает», а снаружи до AmneziaWG ничего не доходит.
                bad = true;
                bits.push(format!("AmneziaWG: пропало правило Docker для порта {}/udp — снаружи до него не доходит", a.port));
            } else {
                bits.push("AmneziaWG работает".into());
            }
        }
        if !x.tcp_no.is_empty() || !x.udp_no.is_empty() {
            bad = true;
            let mut miss: Vec<String> = x.tcp_no.iter().map(|p| format!(":{p}")).collect();
            miss.extend(x.udp_no.iter().map(|p| format!(":{p}/udp")));
            bits.push(format!("не слушает {}", miss.join(", ")));
        }
        if !x.errs.is_empty() {
            bits.push(format!("ошибки за 30 мин: {}", x.errs.join(" / ")));
        }
        services_bad = bad;
        steps.push(step("Службы VPN на сервере", if bad { "bad" } else { "ok" }, bits.join(" · ")));
        if bad {
            advice.push(Advice { kind: "redeploy", text: "Перезапустить VPN на сервере (конфиг и ключи прежние)".into(), entry: None });
        }
        net_bad = x.net_code != "204" || !x.dns;
        steps.push(step(
            "Сервер → интернет",
            if net_bad { "bad" } else { "ok" },
            if net_bad {
                format!("у сервера нет нормального выхода в интернет (ответ {}, DNS {}) — вопрос к хостеру", if x.net_code.is_empty() { "—" } else { &x.net_code }, if x.dns { "есть" } else { "нет" })
            } else {
                format!("есть · {:.0} мс · нагрузка {} · свободно {} МБ", x.net_s * 1000.0, x.load, x.avail)
            },
        ));
        if net_bad {
            advice.push(Advice { kind: "hoster", text: "Написать хостеру: на сервере не работает исходящий интернет или DNS".into(), entry: None });
        }
        // Видит ли сервер ваш ПК: рукопожатие AWG вашего ключа и TCP-соединения с вашего адреса.
        let mut seen = vec![];
        if let Ok(pk) = wg_public(&sec.awg_client_private) {
            if let Some((_, t)) = x.hs.iter().find(|(k, _)| *k == pk) {
                let ago = chrono::Utc::now().timestamp() - t;
                if *t > 0 && ago < 600 {
                    seen.push(format!("ваш ПК на связи по AmneziaWG (рукопожатие {ago} с назад)"));
                }
            }
        }
        if let (Some(n), false) = (x.pc_tcp, x.me.is_empty() || via.is_some()) {
            if n > 0 {
                seen.push(format!("{n} TCP-соединений VPN с вашего адреса"));
            }
        }
        if !seen.is_empty() {
            steps.push(step("Сервер видит ваш ПК", "ok", seen.join(" · ")));
        }
        // Ключи AmneziaWG этого ПК (напрямую и через входы): нет на сервере —
        // их убрали (wpx с другого ПК переписал список); есть, но рукопожатий
        // давно нет — сервер их просто не получает (режет сеть).
        if s.awg.as_ref().is_some_and(|a| x.awg == "true" && x.awg_port == a.port.to_string()) {
            let mut mine: Vec<(String, String)> = vec![];
            if let Ok(pk) = wg_public(&sec.awg_client_private) {
                mine.push(("напрямую".into(), pk));
            }
            for p in &s.awg_paths {
                if let Some(pk) = sec.awg_paths.iter().find(|k| k.via == p.via).and_then(|k| wg_public(&k.private).ok()) {
                    mine.push((format!("через {}", name(&p.via)), pk));
                }
            }
            let now = chrono::Utc::now().timestamp();
            let missing: Vec<&str> = mine.iter().filter(|(_, pk)| !x.hs.iter().any(|(k, _)| k == pk)).map(|(n, _)| n.as_str()).collect();
            let last = mine.iter().filter_map(|(_, pk)| x.hs.iter().find(|(k, _)| k == pk).map(|(_, t)| *t)).max().unwrap_or(0);
            if !missing.is_empty() {
                steps.push(step(
                    "Ключи AmneziaWG этого ПК",
                    "bad",
                    format!("на сервере их нет ({}) — список ключей переписали, например wpx с другого ПК", missing.join(", ")),
                ));
                advice.push(Advice { kind: "redeploy", text: "Вернуть ключи AmneziaWG этого ПК на сервер (VPN перезапустится, ключи прежние)".into(), entry: None });
            } else if !mine.is_empty() && (last == 0 || now - last > 600) {
                steps.push(step(
                    "Ключи AmneziaWG этого ПК",
                    "warn",
                    if last == 0 { "на месте, но рукопожатий не было — AmneziaWG с этого ПК не доходит до сервера (провайдер режет?)".to_string() } else { format!("на месте, последнее рукопожатие {} мин назад — сейчас AmneziaWG не доходит (провайдер режет?)", (now - last) / 60) },
                ));
            }
        }
    } else {
        steps.push(step("Службы VPN на сервере", "skip", "не проверить — нет SSH"));
    }
    // 5. Протоколы с ПК.
    let ok: Vec<&ProbeResult> = probe.iter().filter(|r| r.ok > 0 && !r.bulk.as_ref().is_some_and(|b| b.stalled)).collect();
    let frozen: Vec<&ProbeResult> = probe.iter().filter(|r| r.ok > 0 && r.bulk.as_ref().is_some_and(|b| b.stalled)).collect();
    let dead: Vec<&ProbeResult> = probe.iter().filter(|r| r.ok == 0).collect();
    let line = |v: &[&ProbeResult], f: &dyn Fn(&ProbeResult) -> String| v.iter().map(|r| f(r)).collect::<Vec<_>>().join(" · ");
    if !probe.is_empty() {
        let mut d = vec![];
        if !ok.is_empty() {
            d.push(format!("работают: {}", line(&ok, &|r| format!("{} {} мс", r.label, r.median_ms.unwrap_or(0)))));
        }
        if !frozen.is_empty() {
            d.push(format!("замерзают: {}", line(&frozen, &|r| format!("{} ({})", r.label, r.bulk.as_ref().and_then(|b| b.note()).unwrap_or_default()))));
        }
        if !dead.is_empty() {
            d.push(format!("не проходят: {}", line(&dead, &|r| format!("{} ({})", r.label, r.error.clone().unwrap_or("нет ответа".into())))));
        }
        steps.push(step("ПК → VPN (через провайдера)", if ok.is_empty() { "bad" } else if dead.is_empty() && frozen.is_empty() { "ok" } else { "warn" }, d.join(" · ")));
    }

    // Вердикт и советы.
    let server_fine = state.is_some() && !services_bad && !net_bad;
    let unreachable = (blocked_ssh || (!probe.is_empty() && ok.is_empty())) && server_fine;
    if unreachable {
        // Вход каскада — свой сервер, доступный с ПК напрямую.
        for e in st.servers.iter().filter(|e| e.id != s.id && e.via.is_none() && !e.pipes.iter().any(|p| p.to == s.id)) {
            advice.push(Advice { kind: "cascade", text: format!("Пустить через «{}» ({}): каскад, ключи не меняются", e.name, e.host), entry: Some(e.id.clone()) });
        }
        advice.push(Advice { kind: "move", text: "Переехать на другой VPS: wpx перенесёт протоколы, ключи и доступы".into(), entry: None });
    }
    let (verdict, summary) = if state.is_none() && ok.is_empty() {
        ("bad", "Сервер не отвечает — возможно, выключен или у хостера сбой".to_string())
    } else if services_bad {
        ("bad", "Сервер на связи, но VPN на нём не работает".to_string())
    } else if net_bad {
        ("bad", "VPN на сервере работает, но у самого сервера нет интернета".to_string())
    } else if unreachable {
        ("bad", format!("Сервер работает, а с вашего ПК до него не доходит — похоже, провайдер блокирует {}", s.host))
    } else if !frozen.is_empty() && ok.is_empty() {
        ("bad", "Соединение есть, но данные замерзают — похоже на ТСПУ".to_string())
    } else if !dead.is_empty() || !frozen.is_empty() {
        ("warn", "Работает, но часть протоколов провайдер режет — wpx держит рабочие".to_string())
    } else {
        ("ok", "Всё работает: сервер, его интернет и путь от ПК".to_string())
    };
    if state.is_none() && ok.is_empty() {
        advice.push(Advice { kind: "hoster", text: "Проверьте сервер в панели хостера (включён ли, не закончилась ли аренда)".into(), entry: None });
    }
    let mut seen = std::collections::HashSet::new();
    advice.retain(|a| seen.insert((a.kind, a.entry.clone())));
    Ok(ServerCheck { server: s.name.clone(), verdict, summary, steps, advice })
}

#[tauri::command]
pub async fn server_check(id: String) -> Result<ServerCheck, String> {
    run(&id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_server_state() {
        let out = "sb=true\nawg=true\nhs=AAA= 1793990000\nhs=BBB= 0\ntcp_no=8443\nnet=204 0.031\ndns=1\nme=203.0.113.9\npc_tcp=2\nerr=level=error msg=x\nload=0.05\navail=900\n";
        let s = parse_state(out);
        assert_eq!((s.sb.as_str(), s.awg.as_str(), s.net_code.as_str(), s.dns), ("true", "true", "204", true));
        assert_eq!(s.hs, vec![("AAA=".to_string(), 1793990000), ("BBB=".to_string(), 0)]);
        assert_eq!((s.tcp_no.clone(), s.pc_tcp, s.avail), (vec![8443], Some(2), 900));
        // Интерфейс AWG и правило Docker для его порта.
        assert_eq!(s.errs.len(), 1);
        let a = parse_state("awg=true\nawg_port=41064\nawg_nat=0\n");
        assert_eq!((a.awg_port.as_str(), a.awg_nat), ("41064", Some(0)));
        assert_eq!(parse_state("awg=true\nawg_port=\n").awg_nat, None);
        assert_eq!(parse_state("awg=true\nawg_port=\nawg_oom=2\n").awg_oom, 2);
    }
}
