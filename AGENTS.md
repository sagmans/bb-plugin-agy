# AGENTS.md

A bb plugin that registers Google Antigravity (`agy` CLI) as an ACP agent
provider, with multicolor brand icons and a `provider-usage.v1` quota source.
For install and usage, see [`README.md`](README.md). The marketplace listing
text is in [`PLUGIN_OVERVIEW.md`](PLUGIN_OVERVIEW.md).

## Runtime boundary

bb loads three bundles from `package.json` → `bb`:

| Entry | Runs in | Owns |
| --- | --- | --- |
| `server.ts` | bb server | Provider registration, usage RPC source |
| `host.ts` | host daemon, on the thread's machine | ACP bridge, `agy` dialect, `agy` processes |
| `app.tsx` | bb web UI | Multicolor icon on provider slots |

Shared values live in `src/constants.ts` (ids, CLI args, timeouts, paths) and
`src/icon-spec.ts` (brand geometry). Do not put literals inline. Add a named
constant there instead.

## Stable invariants

- The plugin id, provider id, ACP dialect id and icon name are all `agy`. The
  plugin id comes from the package name `bb-plugin-agy`. Icon names are
  namespaced by plugin id (`agy/agy`), so these ids must stay equal. Thread rows
  persist the provider id, so a change orphans existing threads.
- The id `antigravity` belongs to another marketplace plugin. Do not use it.
- Credentials stay inside the `agy` CLI. The plugin only spawns
  `agy -p /usage --output-format json` and `agy acp`. It must never read, store
  or log tokens, account emails or OAuth URLs.
- Every `agy` spawn has a timeout and a buffer cap (`USAGE_TIMEOUT_MS`,
  `USAGE_MAX_BUFFER_BYTES`). A signed-out `agy` blocks on browser OAuth, so
  without the timeout a usage request hangs.
- `@get-bb/plugin-sdk` APIs prefixed `experimental_` can change between bb
  releases. Pin the SDK exactly, and re-test after each bump.

## Commands

| Goal | Command |
| --- | --- |
| Install from the lockfile | `npm ci --ignore-scripts` |
| Turn on the hooks (once per clone) | `scripts/setup-hooks` |
| Full gate (what pre-push runs) | `npm run check` |
| Lint, types | `npm run lint`, `npm run typecheck` |
| Smoke (fixtures, id wiring, live read if signed in) | `npm run smoke` |
| Build, install, reload in bb | `bb plugin build . && bb plugin install --yes .`, then `bb plugin reload agy` |

## Hooks and delivery

- `.githooks/` holds generic hooks copied from a shared template. Never edit
  `.githooks/{pre-commit,pre-push,commit-msg,...}` or `.githooks/lib/` here.
  Repository checks go in `.githooks/<hook>.d/NN-name` and in `scripts/check`.
- pre-commit scans the staged change (secrets, whitespace, Markdown) and runs
  `.githooks/pre-commit.d/`. pre-push checks every pushed commit (signature,
  DCO, secrets, SAST, dependencies, complexity), then runs `scripts/check`
  once on each pushed tip. `scripts/check` is the list of project checks.
- Commits use Conventional Commits with a body, and are signed with DCO
  (`git commit -s -S`). Do not use `--no-verify`.
- Development is trunk-based on `main`.

## Dependencies

- `.npmrc` holds the supply-chain policy (exact pins, no install scripts, a
  minimum release age). Keep every version pinned exactly. Add a dependency
  only after you check its advisories. `npm audit` must report zero findings.
- `dist/` and `node_modules/` are build output. Do not commit them.

## References

- bb: <https://github.com/get-bb/bb> (MIT). Plugin authoring guide: run
  `bb guide plugins`, or use bb's built-in `bb-plugin-authoring` skill.
- bb marketplace: <https://github.com/get-bb/marketplace>
- Antigravity CLI docs: <https://antigravity.google/docs>
