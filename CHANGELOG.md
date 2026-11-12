# Changelog

## 0.1.4

- "…and what it loads" no longer learns shared and background domains (Google, Microsoft, ad networks, browser
  extensions): x.com had pulled all of google.com into the tunnel.
- The Discord set took the Riot launcher (and anything else on Cloudflare or Google Cloud) along with it: its subnet
  list from itdoginfo also holds all of Cloudflare and big parts of Google Cloud. The set now uses only Discord's own
  networks, built into wpx; Discord's domains (voice included) are unchanged.
- Rules: tick several site rules → "into a set…" — the sites and what they load become one rule of a new or existing
  set of your own, with the same route.
- Cascades find their path. You set the first hop and the final server; before laying a pipe wpx checks from the
  first hop that the next server answers and the path holds (TCP over IPv4 and the server's IPv6, its SSH key must
  match, then about half a minute of steadiness — some filters let traffic through in waves). If IPv4 is filtered and
  IPv6 holds, the pipe goes over IPv6; if the direct path doesn't hold, wpx picks a middle one among your servers and
  says so: "PC → first hop → middle → final".
- Adding a server this PC can't reach directly: wpx finds one of your servers the path holds from and connects
  through it. Servers can be added by IPv6 address.
- Where it breaks: a step "entry → server" (both addresses, steadiness), and "it answers ping, but connections reach
  it from nowhere — looks like a block at the server's provider" with a note for the host.
- A cascade profile ("X via cascade") holds only paths through entries; the direct path to the server stays in its
  own profile (set it as the reserve profile if you want a fallback).
- "Profile on this PC" for a server reachable only through a jump no longer makes a direct profile that can't work.
- Self-healing no longer reports Hysteria2 port hopping as restarted right after installation.
- Profiles: "Take out of use" for the active profile (⋯). When no profile responds there is nothing to switch to, and
  the active profile, its server and its cascade couldn't be removed; now the engine stops, the PC is left without an
  active profile (direct internet, or none with the kill switch) and all of them can be removed. Start and Restart ask
  for an active profile first.
- Windows: an engine stopped by hand stays stopped after a reboot, as the Stop dialog says (Linux already did this).

## 0.1.3

- Your servers: self-healing on the server — every minute it checks wpx's services (containers, listening ports, the
  AmneziaWG interface and Docker's rule for its port, Hysteria2 port hopping) and restarts what fell; after five
  restarts in an hour it backs off. What it did is shown on the server card, in Maintenance and in "Where it breaks".
  Turned on with VPN or a cascade; on existing servers "Edit VPN" (or "Cascade" again for an entry without its own
  VPN) turns it on.
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
