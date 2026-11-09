# Third-party software

## Shipped with wpx

| Component | Version | License | Source |
|---|---|---|---|
| mihomo (tunnel engine, unmodified binary `wpx-mihomo`) | v1.19.33 | GPL-3.0 | <https://github.com/MetaCubeX/mihomo> |
| Tauri and its plugins | 2.x | MIT / Apache-2.0 | <https://github.com/tauri-apps/tauri> |
| Rust crates (see `src-tauri/Cargo.lock`) | — | MIT, Apache-2.0, BSD, ISC and others | crates.io |
| `@tauri-apps/api` | 2.x | MIT / Apache-2.0 | <https://github.com/tauri-apps/tauri> |

mihomo is a separate program: wpx starts it as a process and talks to it over its local API. Its source code for the
shipped version is available at the link above (tag `v1.19.33`); `scripts/fetch-mihomo.mjs` pins the exact release
archives by SHA-256.

## Installed on your servers (downloaded at deploy time)

| Component | Version | License | Source |
|---|---|---|---|
| sing-box (VLESS + Reality, Hysteria2) | 1.14.4 | GPL-3.0-or-later | <https://github.com/SagerNet/sing-box> |
| Xray-core (XHTTP + Reality) | 26.3.27 | MPL-2.0 | <https://github.com/XTLS/Xray-core> |
| mtg (MTProxy) | 2.3.0 | MIT | <https://github.com/9seconds/mtg> |
| amneziawg-go (AmneziaWG) | 3.1.20260828 | MIT | <https://github.com/amnezia-vpn/amneziawg-go> |

These are pulled from their official releases or container images (pinned by checksum or digest) directly on the
server; wpx does not redistribute them.

## Rule lists

Optional lists of blocked resources are downloaded by mihomo from their public sources at runtime (e.g.
[itdoginfo/allow-domains](https://github.com/itdoginfo/allow-domains)); they are not part of wpx.
