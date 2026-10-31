# t3-limits guide

`t3-limits` reads the latest usage-limit data available from a running T3 Code
server. It subscribes to T3's usage-limit streams and does not start provider
probes.

## Setup and run

You need Nix with flakes enabled, read access to this private GitHub
repository, and a running T3 Code server with an installed T3 CLI compatible
with that server. For this private repository, configure Nix's GitHub
authentication or use authenticated SSH access instead:

```sh
nix run git+ssh://git@github.com/ryoppippi/t3-limits -- --json
```

The GitHub reference below assumes Nix already has access. You can substitute
the SSH reference in any of these commands.

```sh
nix run github:ryoppippi/t3-limits -- --json
```

If the installed T3 CLI is not on `PATH`, set its absolute executable path
(for example, when T3 installed it under `~/.t3/bin`):

```sh
T3CODE_CLI_PATH=$HOME/.t3/bin/t3 nix run github:ryoppippi/t3-limits -- --json
```

When a normal run falls through to the OS secret store and no token is stored,
`t3-limits` asks the installed T3 CLI to issue a one-hour `orchestration:read`
token and saves it in Bun's OS secret store. On Linux, the OS secret store
needs an available libsecret service.

## Commands and flags

```text
t3-limits [--json] [--home <directory>] [--url <origin>] [--token-file <path>]
t3-limits --fixture <path> [--json]
t3-limits auth login [--home <directory>] [--t3-bin <executable>]
t3-limits auth logout [--home <directory> | --url <origin>]
```

Here, `t3-limits ...` means `nix run github:ryoppippi/t3-limits -- ...`.
For example:

```sh
nix run github:ryoppippi/t3-limits -- auth login
nix run github:ryoppippi/t3-limits -- auth logout
```

Omit `--json` for a readable report. `--token-file` reads a token from the
given file; tokens are never accepted directly as command-line arguments.
`--t3-bin` selects the installed T3 executable for login. Login discovers
the server and does not accept `--url`. Logout accepts either `--home` or
`--url`. `--fixture` cannot be combined with connection options.
Use `-h` / `--help` or `--help-for-agents` for this guide, and
`-v` / `--version` for the package version.

## Authentication

For a request, credentials are checked in this order: `--token-file`,
`T3_LIMITS_TOKEN`, then the OS secret store for the server origin. If the store
has no token, first use can issue one as described above. An empty environment
token, unreadable token file, or secret-store error stops the request without
trying another source. An expired stored token is not automatically replaced;
issue or renew one with `t3-limits auth login [--home <directory>] [--t3-bin
<path>]`. Login reads the server origin from runtime state; it uses `t3` on
`PATH` or `T3CODE_CLI_PATH`, unless `--t3-bin` selects the executable directly.

`t3-limits auth logout [--home <directory> | --url <loopback-origin>]` removes
the local token for that server origin. It does not revoke the issued server
token.

The server origin normally comes from
`~/.t3/userdata/server-runtime.json`. `--url` accepts a loopback origin only,
with no path, query, fragment, or embedded credentials. `--home <directory>`
selects the OS home directory containing `.t3`; it does not select an
arbitrary T3 data directory. With a URL override, automatic token issuance is
allowed only when its origin matches the runtime server origin for that home.
For another loopback server, supply `--token-file` or `T3_LIMITS_TOKEN`.

## 1Password

Put a 1Password reference in `t3-limits.env` (replace these example names):

```sh
T3_LIMITS_TOKEN=op://vault-name/item-name/field-name
```

Run through `op run` so the token is injected into the process environment:

```sh
op run --env-file=./t3-limits.env -- nix run github:ryoppippi/t3-limits -- --json
```

The compiled CLI does not load dotenv files implicitly.

## JSON report

Use `--json` for a report with top-level `retrievedAt`, `providers`, and
`notices`. Each provider row contains `id`, `driver`, `label`, optional
`sourceId`, optional `enabled`, optional `checkedAt`, `unavailable`, optional
`reason`, and `windows`. Each window contains `id`, `kind`, `label`,
`usedPercent`, `remainingPercent`, and optional `resetsAt` and
`windowDurationMins`.

`retrievedAt` is when this CLI received the stream data. A row's `checkedAt`
is T3's timestamp for that usage-limit data, so it tells you how fresh the
cached result is. For example, this synthetic report excerpt shows a check at
11:58 and report retrieval at 12:00:

```json
{
  "retrievedAt": "2026-10-31T12:00:00.000Z",
  "providers": [
    {
      "id": "claude",
      "driver": "claude",
      "label": "Claude Code",
      "enabled": true,
      "checkedAt": "2026-10-31T11:58:00.000Z",
      "unavailable": false,
      "windows": [
        {
          "id": "session",
          "kind": "session",
          "label": "5-hour session",
          "usedPercent": 72.5,
          "remainingPercent": 27.5,
          "resetsAt": "2026-10-31T15:00:00.000Z",
          "windowDurationMins": 300
        }
      ]
    }
  ],
  "notices": []
}
```

An unavailable row can include a `reason` such as `notReported`, `unsupported`,
`probeFailed`, or `invalidSnapshot`. These describe the data already reported
by T3; this CLI does not start another probe. `notices` are sanitised messages
about source errors and invalid data.

From a clone of this repository, try the JSON projection without connecting
or authenticating:

```sh
nix run . -- --fixture fixtures/usage-limits.json --json
```

Both `t3-limits --help` and `t3-limits --help-for-agents` print this guide.
