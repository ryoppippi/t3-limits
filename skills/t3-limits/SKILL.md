---
name: t3-limits
description: Read AI provider usage limits (Claude, Codex, Cursor, ...) from a running T3 Code server. Use when asked how much of a provider quota is left, when a usage window resets, or whether a provider is rate limited.
---

# t3-limits

`t3-limits` asks the running T3 Code server for every provider's usage
windows and prints them. T3 Code must be running and signed in, and the
`t3` CLI must be on `PATH`.

## Run

```sh
t3-limits          # table of every provider and window
t3-limits --json   # same data as JSON, for parsing
t3-limits --cached # T3's last snapshots, no refresh
```

Without `--cached` the server re-probes every provider before replying,
which can take tens of seconds. Prefer `--cached` when a recent answer is
enough, and check `checkedAt` to see how fresh each snapshot is.

If the command is not installed, use `nix run github:ryoppippi/t3-limits -- --json`.

## Read the output

Each provider has a `status`:

- `ok`: `windows` holds the usage windows.
- `unsupported`: the provider does not report limits.
- `probeFailed`: T3 could not reach the provider.
- `notReported`: T3 has no snapshot yet, for example right after it started.

Each window has `label`, `usedPercent`, `remainingPercent` and `resetsAt`
(ISO 8601, may be null). Report the remaining percentage and the reset time.
A window at 100 % is exhausted until `resetsAt`; one close to it is running
low, not yet blocked, and a `--cached` figure may already be out of date.

If the command fails with "T3 server did not answer", the server returned
something other than a provider list. The usual causes are T3 Code not
running or the user not being signed in; check those first and ask the user
to start T3 Code if so. Otherwise report the error as is. Do not retry in a
loop.
