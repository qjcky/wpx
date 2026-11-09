# Security notes

wpx changes system networking and handles credentials for proxies and servers. This page describes what it does to
stay safe and what it deliberately does not protect against.

## Privilege

- wpx runs as the normal user. Admin rights are requested per operation (UAC / polkit) and only for a generated script.
- Scripts are passed as an argument (`-EncodedCommand`, `bash -c`), not written to a file the user could swap.
- Files the elevated script takes from the user's folder (the staged config, the bundled mihomo) are **copied first and
  verified after copying** against a SHA-256 computed beforehand (config) or embedded at build time (mihomo). A copy
  that does not match is deleted and nothing changes.
- The engine folder is writable only by SYSTEM/administrators (Windows ACL) or root (Linux). On Windows the root
  `C:\ProgramData\wpx` is created with a locked ACL in one call; a folder made by someone else, or a link, is moved
  aside and never used.
- mihomo runs with its own home folder `engine/home/`: it may write only there (downloaded lists, cache). Nothing that
  SYSTEM or root executes lives in it.
- There is **no user-writable folder inside the engine**. mihomo checks its write paths only by text and follows
  links, so a link in a user-writable folder under its home would let a config pushed through the API write anywhere as
  SYSTEM/root. Rule lists for *follow* are therefore served by the wpx window on `127.0.0.1:9098`; the engine downloads
  them into its own folder (and keeps the last copy when wpx is not running). Old rule folders are removed on upgrade.
  *Follow* works only for rules that lead into the tunnel, so a list served by someone else who took the port first can
  at most send more traffic into the tunnel. Any local program can read these lists (names of found helpers and sites).
- Names that reach elevated scripts (adapter, TUN device, learned rules) are validated when saved and when read back
  from disk, and quoted for PowerShell (including typographic quotes) or filtered for nftables.
- Every change is guarded by a system-owned rollback timer; a crashed wpx cannot leave the PC half-configured.
- The elevated script reports its result into the user's data folder as a new file only (never into an existing one);
  a link planted there can at most make it create a small result file elsewhere.

## Secrets

- Proxy passwords, endpoint secrets and SSH keys are stored encrypted: DPAPI on Windows (bound to the Windows user),
  ChaCha20-Poly1305 with a per-user key file (`vault.key`, mode 0600) on Linux. On Linux this protects against copying
  the profile files alone, not against someone who can read your whole home folder — use disk encryption.
- mihomo requires credentials in its config in plain text; the config is readable by the user and written only by the
  elevated script. Temporary configs (`staged/`, sandbox runs) are deleted after use; the trial config keeps no secrets
  once the trial engine has started and is removed when it stops.
- The mihomo API listens on localhost with a random secret that is never shown in the UI. The wpx window runs as the
  user and needs this secret, so **any program running as the same user can read it and control the engine** (switch
  points, pause, replace the running config). This is a mitigation, not a boundary: wpx checks once per cycle that the
  running engine matches its own config (points, rules, rule sources, TUN, LAN access, routes, DNS hijack, mode) and
  restores it, with an
  event and a notification. A setting, rule or rule-source difference that stays even after wpx restores its own config
  is an engine quirk (e.g. mihomo sorts TUN exclusions), not tampering: that one check is turned off until wpx restarts,
  with an event but no notification. A foreign point, LAN access, TUN and mode are never turned off this way. Not
  visible through the API: a server swapped under an existing point name and a replaced DNS resolver — watch the
  "external IP" check.
- Streamer mode hides IPs, connection links, keys, UUIDs and QR codes on screen.

## Servers

- wpx uses its own SSH key per server; password login stays as it is (other tools may rely on it).
- On the first connection wpx shows the server's host key fingerprint **before** sending the password; compare it with
  the hosting panel or VNC console. A changed key later aborts the connection before any login.
- Server software is pinned: release checksums or container image digests.
- Clients and guests cannot reach the server's internal addresses (localhost, Docker networks, cloud metadata, the
  provider's LAN); AmneziaWG clients cannot reach each other.
- The firewall wpx installs opens only SSH and wpx's VPN ports and never removes rules of other software.

## Limitations

- The *direct exit* check runs from the wpx process. On Windows the kill switch allows wpx itself, and on Linux a user
  process cannot bypass the tunnel, so use **Engine → Deep check** for an honest kill switch test.
- On Linux the kill switch blocks everything that leaves past the tunnel without the engine's mark, including wpx's own
  direct checks while it is on.
- Without the kill switch, the blocks of direct DNS and IPv6 past the tunnel live only while the engine runs: they are
  switched on before mihomo starts and off when it exits, is stopped, or does not start at boot. Stopping the engine
  then gives the PC its normal internet (unprotected). With the kill switch they stay — nothing leaves past the tunnel.
- Auto-update trusts releases signed with the project's updater key (see [releasing](releasing.md)).

## Reporting a vulnerability

Please do not open a public issue for security problems. Contact the maintainer privately (see the repository profile)
with steps to reproduce; you will get an answer before anything is published.
