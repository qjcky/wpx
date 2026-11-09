//! Пинг с самих серверов (по SSH): до сервера игры и до остальных своих
//! серверов — из этого складываются пути «ПК → сервер → игра» и каскады
//! «ПК → вход → выход → игра». Только замер: на серверах ничего не меняет.

use super::*;
use std::net::IpAddr;

/// Что намерил один сервер.
pub struct Survey {
    pub id: String,
    pub name: String,
    pub host: String,
    /// TCP-порт, по которому мерить с ПК: VLESS, иначе SSH.
    pub tcp_port: u16,
    /// Сервер → игра, мс.
    pub game: Option<u32>,
    /// Сервер → другой свой сервер (id, мс).
    pub peers: Vec<(String, Option<u32>)>,
    /// Входы, у которых есть труба на этот сервер (каскад уже настроен).
    pub entries: Vec<String>,
    pub err: Option<String>,
}

/// Лучшее из ICMP и TCP-рукопожатия (порт 0 — только ICMP); «-» — не ответил.
/// Соседи — строками «id=адрес=порт SSH».
const SCRIPT: &str = r#"
rtt() {
  b=""
  for t in $(ping -n -c 3 -i 0.2 -W 1 "$1" 2>/dev/null | sed -n 's/.*time=\([0-9.]*\).*/\1/p'); do
    v=${t%.*}; if [ -z "$b" ] || [ "$v" -lt "$b" ]; then b=$v; fi
  done
  if [ "$2" != 0 ]; then
    for i in 1 2 3; do
      s=$(date +%s%N)
      if timeout 2 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null; then
        v=$(( ($(date +%s%N) - s) / 1000000 ))
        if [ -z "$b" ] || [ "$v" -lt "$b" ]; then b=$v; fi
      fi
    done
  fi
  echo "${b:--}"
}
echo "WPX-GAME $(rtt "$WPX_IP" "$WPX_PORT")"
for p in $WPX_PEERS; do r=${p#*=}; echo "WPX-PEER ${p%%=*} $(rtt "${r%=*}" "${r##*=}")"; done
"#;

/// Разобрать вывод SCRIPT: (до игры, [(id, мс)]).
fn parse(out: &str) -> (Option<u32>, Vec<(String, Option<u32>)>) {
    let ms = |v: &str| v.trim().parse().ok();
    let mut game = None;
    let mut peers = vec![];
    for l in out.lines() {
        if let Some(v) = l.strip_prefix("WPX-GAME ") {
            game = ms(v);
        } else if let Some((id, v)) = l.strip_prefix("WPX-PEER ").and_then(|r| r.split_once(' ')) {
            peers.push((id.to_string(), ms(v)));
        }
    }
    (game, peers)
}

/// Замер со всех своих серверов разом. `tcp_port` 0 — игра по UDP, только ICMP.
pub async fn survey(ip: IpAddr, tcp_port: u16) -> Vec<Survey> {
    let store = Arc::new(load());
    let jobs: Vec<_> = (0..store.servers.len())
        .map(|i| {
            let store = store.clone();
            tauri::async_runtime::spawn(async move { one(&store, &store.servers[i], ip, tcp_port).await })
        })
        .collect();
    let mut out = vec![];
    for j in jobs {
        if let Ok(s) = j.await {
            out.push(s);
        }
    }
    out
}

async fn one(store: &Store, s: &Server, ip: IpAddr, tcp_port: u16) -> Survey {
    // Соседи: IPv6 и адреса с пробелами или кавычками не берём.
    let peers: Vec<String> = store
        .servers
        .iter()
        .filter(|x| x.id != s.id && !x.host.is_empty() && !x.host.contains([':', ' ', '\'', '"', '=']))
        .map(|x| format!("{}={}={}", x.id, x.host, x.port))
        .collect();
    let log: Log = Arc::new(|_, _| {});
    let res = async {
        let c = open(store, s, &log).await?;
        let env = [("WPX_IP", ip.to_string()), ("WPX_PORT", tcp_port.to_string()), ("WPX_PEERS", peers.join(" "))];
        let o = c.sh(&env, SCRIPT, b"", 60).await;
        c.close().await;
        o.map(|o| parse(&o.out))
    }
    .await;
    let entries = store.servers.iter().filter(|x| x.pipes.iter().any(|p| p.to == s.id)).map(|x| x.id.clone()).collect();
    let tcp_port = s.vless.as_ref().map(|v| v.port).unwrap_or(s.port);
    let base = Survey { id: s.id.clone(), name: s.name.clone(), host: s.host.clone(), tcp_port, game: None, peers: vec![], entries, err: None };
    match res {
        Ok((game, peers)) => Survey { game, peers, ..base },
        Err(e) => Survey { err: Some(e), ..base },
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn parses_survey() {
        let (g, p) = super::parse("WPX-GAME 31\nWPX-PEER s2 24\nWPX-PEER s3 -\nмусор\n");
        assert_eq!(g, Some(31));
        assert_eq!(p, vec![("s2".to_string(), Some(24)), ("s3".to_string(), None)]);
        assert_eq!(super::parse("WPX-GAME -\n").0, None);
    }
}
