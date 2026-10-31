# Authentication

The CLI needs a bearer token with the `orchestration:read` scope. Tokens are
never accepted as command-line arguments. Run Bun 1.3 or newer to use its native
OS secret store; Linux also needs an available `libsecret` service.

## Automatic setup

Normal retrieval checks token sources in this order:

1. An explicit `--token-file <path>`.
2. `T3_LIMITS_TOKEN`.
3. The OS secret store, keyed by the canonical server origin.

The first two sources bypass the secret store. An explicitly set but empty
`T3_LIMITS_TOKEN`, an unreadable token file, or a secret-store error fails
without trying another source. If the secret store has no token, the CLI asks
the local T3 CLI to issue an `orchestration:read` token with a one-hour
lifetime, then saves it to the OS secret store. It uses `t3` from `PATH`, or
the executable named by `T3CODE_CLI_PATH` (an absolute path).

An existing secret-store token is used as-is. An expired or invalid token is
not replaced automatically, and a failed RPC does not trigger token issuance.
For `--url` overrides, automatic setup is allowed only when the override's
canonical origin matches the origin in T3 runtime state. For a different local
server, pass a token explicitly with `--token-file` or `T3_LIMITS_TOKEN`.

The normal server origin comes from
`~/.t3/userdata/server-runtime.json`. `--home <directory>` selects the
operating-system home directory used to find that file and the T3 state
directory (`<directory>/.t3`); it does not name an arbitrary T3 home. A URL
override must be a loopback origin with no path, query, fragment, or embedded
credentials. Combine `--url` with `--home <directory>` to select the runtime
state file used to check whether automatic token setup is safe for that URL.

## Explicit setup and removal

To issue and save a token before retrieval, use the installed T3 CLI version
that matches the running server:

```sh
t3-limits auth login
t3-limits auth login --t3-bin /path/to/installed/t3
t3-limits auth logout
```

`auth login --home <directory>` uses that OS home directory. The executable can
also be set with `T3CODE_CLI_PATH`. Login discovers the origin from runtime
state and does not accept `--url`. Logout removes the local token entry only;
it does not revoke the issued server token. Tokens expire after one hour.

To provide a token explicitly:

```sh
bun --no-env-file run start --token-file /path/to/token --json
T3_LIMITS_TOKEN="$(t3 auth session issue --base-dir "$HOME/.t3" --scope orchestration:read --ttl 1h --label t3-limits --token-only)" \
  bun --no-env-file run start --json
```

The second form keeps the token out of terminal output and stores it only in
the command environment. Avoid shell tracing and logging around commands that
carry credentials.

## 1Password

Use a reference in an environment file; replace the names with your 1Password
vault, item, and field. This line is a reference, not a token:

```sh
T3_LIMITS_TOKEN=op://vault-name/item-name/field-name
```

Run the Nix wrapper through `op run`:

```sh
BUN_OPTIONS=--no-env-file op run --env-file=./t3-limits.env -- gh-nix nix run github:ryoppippi/t3-limits -- --json
```

The compiled executable disables implicit dotenv loading. The project's
`bunfig.toml` also sets `env = false` for normal Bun commands. Keep
`--no-env-file` on source commands so the setting holds even when the project
configuration is not discovered. `BUN_OPTIONS=--no-env-file` applies the same
setting to the 1Password example.
Use process environment injection through `op run` rather than a mounted
dotenv file.
