# t3-limits

Read AI provider usage limits from a running [T3 Code](https://github.com/pingdotgg/t3code)
server:

```sh
nix run github:ryoppippi/t3-limits
nix run github:ryoppippi/t3-limits -- --json
nix run github:ryoppippi/t3-limits -- --cached
```

This is a temporary script. It will no longer be needed once T3 Code ships an
MCP usage-limits tool ([PR #28212](https://github.com/pingdotgg/t3code/pull/28212)).

## How it works

1. Reads the server origin from `userdata/server-runtime.json` in the T3 Code
   data directory: `$T3CODE_HOME` when set, otherwise `~/.t3`.
2. Issues a five-minute `orchestration:read` token with
   `t3 auth session issue`, so the `t3` CLI must be on `PATH`. T3 closes the
   socket when the session expires, so it must outlast a full refresh.
3. Sends one `server.refreshProviders` request over the T3 WebSocket with
   `websocat` and prints each provider's usage windows from the reply.

T3 keeps provider snapshots in memory and in `caches/<instanceId>.json` under
its data directory, and only re-probes them on a background interval while a
client is active, so an unrefreshed read can be stale. `server.refreshProviders` is the call T3's own
Usage page makes: it re-probes every provider before replying, which can take
tens of seconds. It does not rediscover models or reload secrets.

`--cached` sends `server.getConfig` instead and returns immediately with T3's
last snapshots. `checkedAt` says how fresh each one is; right after T3 restarts
they have no usage limits until its first probe finishes.

`status` is `ok`, `unsupported`, `probeFailed`, or `notReported` (T3 has no
snapshot for that provider).

The token is passed to `websocat` as a command-line argument, so other local
users can see it in the process list while the request runs. The session is
revoked as soon as the reply arrives.

## JSON output

`nix run . -- --json` prints (abridged):

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

## Agent skill

The package ships an [agent skill](https://github.com/agentskills/agentskills)
at `share/skills/t3-limits/t3-limits/SKILL.md`, installed with nixpkgs'
`installAgentSkills` hook. This is the layout
[llm-agents.nix](https://github.com/numtide/llm-agents.nix) and nixpkgs use,
so any skill registry that reads `share/skills` from a package, such as
[agent-skills-nix](https://github.com/Kyure-A/agent-skills-nix), can pick it
up by pointing at this flake's default package. The source lives in
[skills/t3-limits/SKILL.md](skills/t3-limits/SKILL.md).
