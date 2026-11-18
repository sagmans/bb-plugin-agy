Start, steer, and compact Google Antigravity (`agy`) threads directly inside bb
with the same composer controls, reasoning effort picker, native skill
typeahead, and quota visibility as built-in providers.

## What you get

- **First-class agent provider (`agy`):** Select Antigravity models and
  reasoning effort levels (`low`, `medium`, `high`, `xhigh`, `max`), or run
  `/compact` and `bb thread compact` on long sessions.
- **Official multicolor branding everywhere:** Renders the multicolor
  Antigravity mark across sidebar thread rows, new-thread and follow-up
  composer pickers, thread headers, **Settings -> Providers**, **Settings ->
  Installed plugins**, and both **Provider usage** surfaces.
- **Live quota windows:** Displays `7d · Gemini`, `5h · Gemini`,
  `7d · Claude/GPT`, and `5h · Claude/GPT` usage bars and reset times in
  **Settings -> Provider usage**, the sidebar usage card, and
  `bb settings usage`.

## How it works

Threads run through BB's ACP provider bridge over `agy acp` stdio on the
selected machine. Quota checks invoke `agy -p /usage --output-format json`
locally on that host so OAuth credentials remain inside your `agy` CLI login
and are never read or stored by the plugin.

## Requirements

- A signed-in `agy` CLI installation on the machine hosting your threads
  (`agy acp --login`; install instructions at
  <https://antigravity.google/docs>).
- Active Google Antigravity account access for model execution and quota
  reporting.
