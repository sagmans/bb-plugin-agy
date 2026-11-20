# AGENTS.md

A bb plugin that registers Google Antigravity (`agy` CLI) as an ACP agent
provider, with multicolor brand icons, a `provider-usage.v1` quota source, and
configurable auto-compaction. For install and usage, see
[`README.md`](README.md). Marketplace overview text lives in
[`PLUGIN_OVERVIEW.md`](PLUGIN_OVERVIEW.md); security and disclosure rules live
in [`SECURITY.md`](SECURITY.md).

## Runtime boundary and module map

bb loads three bundles from `package.json` → `bb`:

| Entry / Module | Runs in | Owns |
| --- | --- | --- |
| `server.ts` | bb server | Provider registration, startup `pluginId` check, quota RPC + auto-compact wiring |
| `host.ts` | host daemon | ACP bridge registration for the `agy` dialect |
| `app.tsx` | bb web UI | Multicolor SVG icon slots (`agy`, `acp-antigravity-acp`, `agy/agy`) |
| `src/constants.ts` | shared | IDs, CLI args, cache/timeout budgets, customization roots, setting keys |
| `src/icon-spec.ts`, `icons/*.svg` | web UI / static | Arch path, `16x16` viewBox, and radial gradients (checked for parity in smoke) |
| `src/dialect.ts` | host daemon | Fail-closed `readAccount` health probe and unsettled-probe cache coalescing |
| `src/usage.ts`, `src/usage-exec.ts` | host daemon | Portable streaming `agy -p /usage`, early OAuth stop, `AgyUsageFailureKind`, bucket normalization |
| `src/usage-source.ts`, `src/usage-rpc-contract.ts` | bb server | `provider-usage.v1` RPC schema, label mapping, 60 s passive cache, `refresh` queuing |
| `src/auto-compact*.ts` | bb server | Event analysis, policy, LRU state, SQLite journal, startup recovery, SDK transport, coordinator |
| `skills/agy-provider/SKILL.md` | bb skill loader | Provider and auto-compaction configuration reference for sessions |

Do not put magic literals inline. Define shared constants in `src/constants.ts`
(or `src/icon-spec.ts` for brand geometry) and module-local constants at the top
of each file.

## Stable invariants

- **Synchronized IDs:** Plugin id, provider id, ACP dialect id, and icon key are
  all `agy` (`DECLARED_PLUGIN_ICON_NAME` = `agy/agy`). `server.ts` fails closed
  if `bb.pluginId !== PROVIDER_ID`. Thread rows persist `providerId`, so
  changing it orphans existing threads.
- **No marketplace collision:** The id `antigravity` belongs to another
  marketplace plugin. Never use it.
- **Credential isolation:** Credentials stay inside the `agy` CLI. This plugin
  spawns only `agy acp` and `agy -p /usage --output-format json` via
  `experimental_spawnPortableProcess`. Never read, store, or log tokens, account
  emails, or child `stderr` OAuth URLs.
- **Fail-closed health & installers:** `readAccount` returns `{ email: null }`
  only when `usage.status === "ok"`, `null` on `"unauthenticated"`, and throws
  on `"error"`, `"expired"`, `"not_installed"`, or unsupported results so BB
  reports health `"unknown"`. Keep `maintenance.installation: false` so BB never
  runs unpinned remote installer scripts.
- **Bounded subprocesses:** Every `agy` probe enforces `USAGE_TIMEOUT_MS`,
  `USAGE_MAX_BUFFER_BYTES`, `USAGE_KILL_SETTLE_TIMEOUT_MS`, and immediate stop
  once `AGY_AUTH_REQUIRED_MARKER` appears on `stdout`.
- **TypeScript & size gates:** `tsconfig.json` enables `erasableSyntaxOnly: true`
  so Node `>=22.18` (`engines.node`) runs TypeScript contributor scripts
  directly without a build step (bb executes built plugin bundles inside its own
  runtime). Avoid `enum` and constructor parameter properties. Keep every
  authored file under 500 physical lines, `jscpd --threshold 0` at zero clones,
  and `lizard -C 15 -L 100` warning-free.

## Commands

| Goal | Command |
| --- | --- |
| Install from the lockfile | `npm ci --ignore-scripts` |
| Turn on the hooks (once per clone) | `scripts/setup-hooks` |
| Full gate (matches `pre-push` scanners) | `npm run check` |
| Lint, types, duplication | `npm run lint`, `npm run typecheck`, `npm run duplicates` |
| Smoke (subprocess, dialect, RPC, compaction, SVG parity, live read) | `npm run smoke` |
| Build, install, reload in bb | `bb plugin build . && bb plugin install --yes . && bb plugin reload agy` |

## Hooks and delivery

- `.githooks/` holds generic hooks copied from a shared template. Never edit
  `.githooks/{pre-commit,pre-push,commit-msg,...}` or `.githooks/lib/` here.
  Repository checks go in `.githooks/<hook>.d/NN-name`, `scripts/check`, and
  `scripts/lint-sh`.
- `pre-commit` checks the staged index snapshot with Biome (`10-project`) and
  with `shellcheck` + `shfmt` when shell scripts change (`20-shell-lint`).
- `scripts/check` runs `gitleaks`, Biome, `tsc`, `jscpd`, `lizard`, `semgrep`,
  `npm audit`, `osv-scanner`, `bb plugin build`, `shellcheck`, `shfmt`,
  `markdownlint-cli2`, and `npm run smoke`.
- Commits use Conventional Commits with a WHY-focused body and are signed with
  DCO (`git commit -s -S`). Release tags use signed annotated tags
  (`git tag -s vX.Y.Z -m "..."`). Do not use `--no-verify`.
- Development is trunk-based on `main`.

## Dependencies

- `.npmrc` enforces `save-exact=true`, `ignore-scripts=true`, and
  `min-release-age=7`. Keep every version pinned exactly, and bump
  `@get-bb/plugin-sdk` (`bb plugin types`) only once the target SDK version
  satisfies the 7-day minimum release age and passes `npm audit` and
  `osv-scanner`.
- `dist/` and `node_modules/` are build output. Do not commit them.

## References

- bb: <https://github.com/get-bb/bb> (MIT). Plugin authoring guide: run
  `bb guide plugins`, or use bb's built-in `bb-plugin-authoring` skill.
- bb marketplace: <https://github.com/get-bb/marketplace>
- Antigravity CLI docs: <https://antigravity.google/docs>
