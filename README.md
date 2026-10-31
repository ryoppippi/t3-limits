# t3-limits

`t3-limits` is a small Bun CLI that reads provider usage limits from a running
T3 Code server. It subscribes to the server configuration stream, waits for the
provider snapshot and its initial usage-limit source event, then closes the
connection. It does not refresh providers or call a mutation RPC.

The CLI uses only Bun and Node built-ins. Its output is an allowlisted view of
the two usage-limit streams; provider configuration, authentication data,
account emails, plans, credential fingerprints, reset credits, URLs, and raw
provider errors are omitted.

## Run

Provide a bearer token through the environment or a file read at runtime. The
token is never accepted as a command-line argument.

```sh
export T3_LIMITS_TOKEN
bun run src/cli.ts --json
```

By default the CLI reads the origin from
`~/.t3/userdata/server-runtime.json`. `--home <directory>` uses that directory
as the home directory for the same path. To choose a server origin directly,
use `--url <origin>`; it must be a loopback origin without a path, query,
fragment, or embedded credentials. Runtime-discovered origins are subject to
the same loopback check before the bearer token is sent.

The supplied bearer token must have the `orchestration:read` scope. An
MCP-scoped credential is not accepted for this WebSocket subscription. The
desktop app keeps its session token in memory, so this CLI does not discover or
reuse desktop sign-in state; provide a suitable token explicitly.

```sh
bun run src/cli.ts --token-file /path/to/token --json
bun run src/cli.ts --url http://127.0.0.1:8318 --json
```

For offline examples and projection checks, `--fixture <path>` reads a JSON
object with `providers` (from `snapshot.config.providers`) and `sources` (from
`usageLimitSourcesUpdated.payload.sources`). Fixture mode does not connect or
read a token.

```sh
bun run src/cli.ts --fixture fixtures/usage-limits.json --json
```

Use `--help` to see all options.

## Nix

Run the private repository's flake with an authenticated GitHub session:

```sh
gh-nix nix run github:ryoppippi/t3-limits -- --json
```

For a private GitHub repository, `gh-nix` needs an authenticated `gh` session,
or clone the repository with an authenticated GitHub setup first. From a local
checkout, run the synthetic fixture without a token:

```sh
gh-nix nix run . -- --fixture fixtures/usage-limits.json --json
```

## Output

The report contains `retrievedAt`, `providers`, and sanitised `notices`.
`retrievedAt` is when this CLI received the current data. Each provider row's
`checkedAt` is the timestamp reported by T3 for that provider's usage-limit
data, so reading the report again does not make cached provider data appear
newer.

Native providers are included even when they do not report usage limits. Those
rows have `unavailable: true` and `reason: "notReported"`. Other machine-readable
reasons are `unsupported`, `probeFailed`, and `invalidSnapshot`. Source account
rows have a qualified `id` and `sourceId`; the `label` includes the source label
to keep accounts with similar names distinguishable. Source error notices
identify the source and its checked time when available, while omitting the
server's error text.

Each window includes its `id`, `kind`, `label`, `usedPercent`,
`remainingPercent`, and any available `resetsAt` and `windowDurationMins`.
Percentages are numeric, and durations are in minutes.

For example, a provider entry is shaped like:

```json
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
```

## Development

```sh
bun test
```

The flake exposes `t3-limits` for `aarch64-darwin`, `x86_64-darwin`,
`aarch64-linux`, and `x86_64-linux`.
