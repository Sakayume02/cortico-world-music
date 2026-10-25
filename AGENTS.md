# AGENTS.md

Release checklist for this Cortico World extension. How to write one:
[docs/worlds.md](https://github.com/Pal-AI-Lab/Cortico/blob/main/docs/worlds.md) and [docs/extensions.md](https://github.com/Pal-AI-Lab/Cortico/blob/main/docs/extensions.md).
`pnpm describe:extension <dir>` and `pnpm check:extension <dir>` run from the root of a Cortico
checkout; `<dir>` is this package's directory.

- [x] **Contract version**: `cortico.api` = world 6.
- [x] **Self-description**: after changing tools, event types or the env prompt, run `pnpm describe:extension <dir>`.
- [x] **Tags**: `voice`, `requires-key`, `sensitive-data`, `experimental` — all in TAGS.md.
- [x] **CHANGELOG.md** has a `## 0.2.0` section.
- [x] **`os`**: `["win32"]` (WASAPI + Windows media session only).
- [x] **`pnpm check:extension <dir>`** passes.
- [x] **PROJECT.md** carries the project/market introduction and component map.
- [ ] **Requests to the maintainers** (tag changes, certification, replacement, appeals): issues in
  [Pal-AI-Lab/cortico-extensions](https://github.com/Pal-AI-Lab/cortico-extensions) with the plain-text
  format from `check:extension`.
- [ ] **npm publish** and the official index request are done by the developer, not the agent.
