# Changelog

## 0.1.3

- Your servers: a watchdog on the server checks wpx's services every minute (containers, listening ports, the
  AmneziaWG interface and Docker's rule for its port, Hysteria2 port hopping) and restarts what fell; after five
  restarts in an hour it backs off. What it did is shown on the server card, in Maintenance and in "Where it breaks".
  Installed with VPN or a cascade; on existing servers "Edit VPN" (or "Cascade" again for an entry without its own
  VPN) puts it there.
- AmneziaWG on the server: the container had too little memory (100 MB), and under steady traffic the kernel killed
  amneziawg-go while the container kept "running" — AWG was down until a manual restart. Now 384 MB with a Go memory
  limit, and the container restarts itself when its interface is gone.
- Where it breaks: says when AmneziaWG was killed for memory; no longer reports this PC's keys as missing while the
  interface is down; one piece of advice per action.

## 0.1.2

- Rules: tick several rules and change their route at once ("N selected → route through…").
- "…and everything it launches" and "…and what it loads" learn only addresses that don't open directly. Russian zones
  (.ru, .su, .рф), Windows and certificate service domains and sites with a "direct" rule are never added; a removed
  item doesn't come back; such sites learned by earlier versions are cleaned up on start.
- Share: connecting through a cascade entry is an explicit choice ("How the person will connect").
- Where it breaks: checks that AmneziaWG on the server really accepts traffic (interface up, Docker's rule for its
  port in place) and that this PC's AmneziaWG keys are on the server; the fix is restarting VPN with the same keys.

## 0.1.1

- Your servers: if a path through a cascade entry has no AmneziaWG key of its own yet (cascades made before 0.1.0),
  the route now says so and how to fix it — run *Cascade* again; the pipe stays, only the key is added on the exit.
- Maintenance shows fresh server facts right after installing VPN or a cascade (sing-box version, ports, updates).
- The route line on a server card no longer takes up 150 px of empty space.
- Release checksums (`SHA256SUMS-*.txt`) list plain file names on Windows too.

## 0.1.0 — first public version

- Whole-PC tunnel on mihomo (TUN) with kill switch and transactional, self-rolling-back changes.
- Engine shipped with wpx (pinned mihomo v1.19.33, SHA-256 verified on install), one-click install and removal.
- Profiles from links (VLESS/XHTTP + Reality, Hysteria2, Trojan, Shadowsocks, AmneziaWG, HTTP(S), SOCKS5), cascades,
  routes, reserve profile, fixed exit IPs.
- Rules per app / site / set, "…and everything it launches" with live updates, game mode with login redirect.
- Own servers over SSH: VLESS + Reality, Hysteria2, AmneziaWG, XHTTP + Reality, MTProxy; firewall, cascades,
  guests, one-click move, core updates.
- Notch at any screen edge or corner, drag-and-drop, themes, streamer mode, Russian and English.
- Windows and Linux (systemd, polkit, nftables); signed auto-updates from GitHub Releases.
