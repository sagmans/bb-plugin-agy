# bb-plugin-agy

A [bb](https://github.com/get-bb/bb) plugin that runs Google Antigravity
(`agy`) as a first-class agent provider. It shows the official multicolor
Antigravity mark on every provider surface. It also shows live quota in bb's
**Provider usage** page and sidebar card.

The plugin id and the provider id are both `agy`. This id is different from the
`antigravity` plugin in the bb marketplace, so you can install both.

## Requirements

- bb `0.49` or later (`@get-bb/plugin-sdk` `0.6.132` or later).
- Node.js `22.18` or later (runs the TypeScript scripts without a build step).
- The `agy` CLI, installed and signed in (`agy acp --login`). Install
  instructions: <https://antigravity.google/docs>.

## Install

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
  modes, `/compact`, native skill roots, sign-in hint), the `provider-usage.v1`
  RPC source, and automatic compaction.
- **`src/auto-compact.ts`, `src/auto-compact-policy.ts`**: Defines the
  auto-compaction settings, inspects tool boundaries, compacts `agy` threads at
  the configured token threshold, and automatically resumes active sessions.
- **`app.tsx`**: Mounts the multicolor SVG on
  `app.slots.experimental_providerIcon` and `app.experimental_icons`, with
  per-instance `useId()` paint-server IDs.
- **`host.ts`**: Runs bb's ACP provider bridge with the `agy` dialect.
- **`src/dialect.ts`**: Supplies the sign-in command, account state, and cached
  host-side quota reads.
- **`src/usage.ts`**: Runs `agy -p /usage --output-format json` with a GUI
  `PATH` fallback and explicit timeouts.
- **`src/usage-source.ts`**: Serves `provider-usage.v1` with concurrent-call
  deduplication and a `refresh` cache bypass.
- **`src/constants.ts`, `src/icon-spec.ts`**: Shared constants and brand
  geometry.

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

Antigravity reports two model groups (`Gemini` and `Claude/GPT`). Each group
has a weekly bucket and a five-hour bucket
(`usedPercent = (1 - remaining_fraction) * 100`).

## Development

```sh
scripts/setup-hooks   # once per clone: turns on the repository Git hooks
npm run check         # every check that the pre-push hook runs
npm run smoke         # usage parser fixtures, plus a live read when signed in
```

The hooks need `gitleaks`, `semgrep`, `osv-scanner`, `lizard`,
`markdownlint-cli2`, `shellcheck` and `shfmt` on `PATH`. A missing tool blocks
the hook. All checks must pass before a push. Do not use `--no-verify`.

Commits are signed (`git commit -s -S`) and use Conventional Commits. See
[`AGENTS.md`](AGENTS.md) for the project map and rules.

## License

[MIT](LICENSE). bb itself is also MIT-licensed.
