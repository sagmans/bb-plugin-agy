# bb-plugin-agy

A [bb](https://github.com/get-bb/bb) plugin that runs Google Antigravity
(`agy`) as a first-class agent provider. It renders the official multicolor
Antigravity mark across every provider surface, surfaces live host quota in
**Provider usage**, and enforces configurable auto-compaction with automatic
continuation.

The plugin id and the provider id are both `agy`. This id is distinct from the
`antigravity` plugin in the bb marketplace, so both can be installed side by
side.

## Requirements

- bb `0.49` or later (`@get-bb/plugin-sdk` `0.6.132` or later).
- A signed-in `agy` CLI installation on the machine hosting your threads
  (`agy acp --login`). Install instructions: <https://antigravity.google/docs>.
- Node.js `22.18` or later when running contributor TypeScript scripts locally
  (`npm run smoke`, `npm run check`); bb itself runs built plugin bundles inside
  its own runtime and does not enforce `engines.node`.

## Install

Install directly from GitHub with bb:

```sh
bb plugin install https://github.com/sagmans/bb-plugin-agy
```

Or build and install from a local clone for development:

```sh
git clone https://github.com/sagmans/bb-plugin-agy.git
cd bb-plugin-agy
npm ci --ignore-scripts
bb plugin build .
bb plugin install --yes .
```

After a local edit:

```sh
bb plugin build . && bb plugin reload agy
```

## Architecture

- **`server.ts`**: Registers the `agy` provider (models, reasoning levels, ACP
  permission modes, `/compact`, native skill roots, sign-in hint), verifies
  `bb.pluginId === "agy"`, and attaches quota RPCs and auto-compaction.
- **`src/auto-compact.ts`, `src/auto-compact-client.ts`,
  `src/auto-compact-state.ts`, `src/auto-compact-policy.ts`,
  `src/auto-compact-events.ts`**: Defines auto-compaction settings, inspects
  event boundaries, yields active turns safely between tool calls to compact and
  immediately resume, and compacts idle threads in place.
- **`app.tsx`, `src/icon-spec.ts`, `icons/*.svg`**: Mounts the multicolor SVG on
  `app.slots.experimental_providerIcon` and `app.experimental_icons` with
  instance-unique `useId()` paint-server IDs.
- **`host.ts`, `src/dialect.ts`**: Registers the `agy` ACP dialect with
  fail-closed `readAccount` health checks and unsettled-probe cache coalescing.
- **`src/usage.ts`, `src/usage-exec.ts`**: Spawns
  `agy -p /usage --output-format json` portably with GUI `PATH` fallbacks,
  immediate stop on signed-out OAuth output, and typed failure classification.
- **`src/usage-source.ts`, `src/usage-rpc-contract.ts`**: Defines the
  `provider-usage.v1` schema and window mappers with 60-second passive caching,
  concurrent request coalescing, and `refresh` queuing.
- **`src/constants.ts`, `skills/agy-provider/SKILL.md`**: Shared constants and
  bundled provider skill.

## Auto-compaction

`agy` has no native setting to lower its backend compaction ceiling. This plugin
monitors reported token usage on `agy` threads and triggers compaction once
`usedTokens` reaches the configured threshold (default `250000` tokens):

- **Active turns:** At the next tool-free step boundary, the plugin yields the
  turn cleanly on the same live ACP process, runs compaction, and immediately
  resumes the session with an agent-only continuation turn so work never stops
  or pauses.
- **Idle turns:** If a turn completes above the threshold on its own, compaction
  runs in place on the idle thread without restarting `agy`.

Configure under **Settings -> Installed plugins -> Antigravity** or via CLI:

```sh
bb plugin config agy
bb plugin config agy set autoCompactEnabled true
bb plugin config agy set autoCompactTokenThreshold 250000
```

| Setting | Default | Range |
| --- | --- | --- |
| `autoCompactEnabled` | `true` | `true` or `false` |
| `autoCompactTokenThreshold` | `250000` | integer `1000`–`2000000` |

## Usage mapping

Antigravity reports two model groups (`Gemini` and `Claude/GPT`), each with a
weekly bucket and a five-hour bucket
(`usedPercent = Math.round((1 - remaining_fraction) * 100)`):

- **Sidebar usage card:** Abbreviates weekly windows to `7d · Gemini` and
  `7d · Claude/GPT` alongside `5h · Gemini` and `5h · Claude/GPT`.
- **Settings -> Provider usage:** Renders weekly windows with their model group
  (`Weekly · Gemini`, `Weekly · Claude/GPT`) alongside `5h · Gemini` and
  `5h · Claude/GPT` (`bb settings usage` prints raw host labels
  `5 hours · …`).

## Development

```sh
scripts/setup-hooks   # once per clone: turns on the repository Git hooks
npm run check         # runs every lint, type, security, complexity, build, and smoke check
npm run smoke         # subprocess, dialect, RPC, compaction, and SVG checks + live quota read
```

`scripts/check` and `.githooks/pre-push` require `gitleaks`, `semgrep`,
`osv-scanner`, `lizard`, `markdownlint-cli2`, `shellcheck`, and `shfmt` on
`PATH`. A missing tool blocks the check. Do not use `--no-verify`.

Commits are signed (`git commit -s -S`) and use Conventional Commits. See
[`AGENTS.md`](AGENTS.md) for contributor rules and [`SECURITY.md`](SECURITY.md)
for security boundaries and vulnerability reporting.

## License

[MIT](LICENSE). bb itself is also MIT-licensed.
