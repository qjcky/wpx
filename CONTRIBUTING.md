# Contributing

Thanks for helping! Issues and pull requests are welcome in English or Russian.

## Before you start

- Bugs and ideas: open an [issue](https://github.com/qjcky/wpx/issues/new/choose). Security problems: see
  [SECURITY.md](SECURITY.md) — not a public issue.
- For a larger change, open an issue first so we can agree on the approach.
- Never paste real connection links, keys, passwords or your server addresses. The support report
  (Engine → Support report) hides addresses and contains no keys.

## Development

See [Build from source](README.md#build-from-source). Work in the **lab build** (`npm run lab`): it has its own data
folder and never changes the system, so it is safe next to an installed wpx. Before a pull request:

```bash
npm run typecheck
cd src-tauri && cargo test --lib
```

- Match the surrounding code: naming, comment density, no new frameworks in the frontend.
- New user-facing text: add the English translation to `src/locales/en.json`.
- Anything that runs with administrator / root rights (`src-tauri/src/engine/ops/`) needs a test and a short note on
  why it is safe.

## License of contributions

wpx is licensed under [GPL-3.0-or-later](LICENSE). By submitting a contribution you confirm that you wrote it (or have
the right to submit it), you license it under GPL-3.0-or-later, and you grant the maintainer of wpx a perpetual,
worldwide, non-exclusive, royalty-free, irrevocable license to use, modify, sublicense and distribute your contribution
under other license terms as well. This keeps the project able to ship builds where the GPL does not fit (for example,
app stores).
