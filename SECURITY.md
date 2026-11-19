# Security Policy

## Supported versions

Development is trunk-based on `main`. Security fixes land on `main` and ship in
the next signed SemVer tag.

| Version | Supported |
| --- | --- |
| `main` / latest `0.4.x` tag | Yes |
| `< 0.4.0` | Upgrade to latest |

## Reporting a vulnerability

Do **not** open a public GitHub issue for suspected vulnerabilities, credential
leaks, or bypasses.

Report security findings privately through GitHub Private Vulnerability
Reporting:

- <https://github.com/sagmans/bb-plugin-agy/security/advisories/new>

Include reproduction steps, affected commit SHA or version tag, and impact.

## Security model and boundaries

- **Zero credential handling:** OAuth tokens, refresh tokens, account emails,
  and browser sign-in URLs stay inside the `agy` CLI credential store. This
  plugin invokes only `agy acp` and `agy -p /usage --output-format json`.
- **Sanitized diagnostics:** Host subprocess failures log only structured
  operational metadata (`failureKind`, `exitCode`, `signal`, `elapsedMs`, and
  system error codes). Child `stderr` is never logged because CLI auth prompts
  can print OAuth URLs there.
- **Bounded subprocesses:** Every quota probe enforces a hard runtime deadline,
  a `1 MiB` stdio buffer ceiling, portable process-tree termination, and
  immediate stop on signed-out OAuth output.
- **Fail-closed provider health:** Host `readAccount` reports `"ready"` only on
  verified `"ok"` responses, `"unauthenticated"` on explicit sign-out prompts,
  and throws on `"error"`, `"expired"`, `"not_installed"`, or unsupported
  states so BB marks health `"unknown"` rather than falsely ready.
- **No remote installer execution:** `maintenance.installation` stays `false`
  so BB never executes unpinned remote shell scripts; `installUrl` directs users
  to manual CLI installation from official documentation.
- **Supply-chain gates:** `.npmrc` enforces `save-exact=true`,
  `ignore-scripts=true`, and `min-release-age=7`. Local `scripts/check` and
  `.githooks/pre-push` fail closed on `gitleaks`, `semgrep`, `osv-scanner`,
  `npm audit`, `lizard`, `jscpd`, and commit/tag signature verification.
