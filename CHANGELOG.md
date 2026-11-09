# Changelog

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
