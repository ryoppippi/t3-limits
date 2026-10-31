# t3-limits

Read AI provider usage limits from a running [T3 Code](https://github.com/pingdotgg/t3code)
server:

```sh
nix run github:ryoppippi/t3-limits
nix run github:ryoppippi/t3-limits -- --json
```

This is a temporary script. It will no longer be needed once T3 Code ships an
MCP usage-limits tool ([PR #28212](https://github.com/pingdotgg/t3code/pull/28212)).

## How it works

1. Reads the server origin from `~/.t3/userdata/server-runtime.json`.
2. Issues a one-minute `orchestration:read` token with
   `t3 auth session issue`, so the `t3` CLI must be on `PATH`.
3. Sends one read-only `server.getConfig` request over the T3 WebSocket with
   `websocat` and prints each provider's usage windows.

It never refreshes or probes providers. The values are T3's cached snapshots;
`checkedAt` says how fresh each one is. `status` is `ok`, `unsupported`,
`probeFailed`, or `notReported` (T3 has no snapshot for that provider).

The token is passed to `websocat` as a command-line argument, so other local
users can see it in the process list for the few seconds it is valid.

## JSON output

`nix run . -- --json --fixture fixtures/get-config.json` prints
(abridged; see [`fixtures/expected.json`](fixtures/expected.json)):

```json
[
  {
    "id": "claudeAgent",
    "driver": "claudeAgent",
    "label": "Claude",
    "enabled": true,
    "checkedAt": "2026-10-31T11:58:00+00:00",
    "status": "ok",
    "windows": [
      {
        "id": "session",
        "label": "Session",
        "usedPercent": 72.5,
        "remainingPercent": 27.5,
        "resetsAt": "2026-10-31T15:00:00+00:00"
      }
    ]
  },
  {
    "id": "cursor",
    "driver": "cursor",
    "label": "cursor",
    "enabled": true,
    "checkedAt": "2026-10-31T11:57:00+00:00",
    "status": "unsupported",
    "windows": []
  }
]
```

## Development

`nix fmt` formats everything with treefmt. `nix flake check` checks formatting
and runs the script against the fixture, comparing the output with
`fixtures/expected.json`.
