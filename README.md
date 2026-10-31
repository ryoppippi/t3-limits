# t3-limits

`t3-limits` reads and sanitises provider usage limits from a running T3 Code
server. It subscribes to the server's read-only usage-limit streams and closes
the connection after receiving their initial data.

Run it with the Nix wrapper:

```sh
gh-nix nix run github:ryoppippi/t3-limits -- --json
```

On first use, the CLI may issue and save a one-hour `orchestration:read` token
to the OS secret store. See [Authentication](docs/authentication.md) for token
setup and 1Password use, [Output](docs/output.md) for report fields, and
[Development](docs/development.md) for tests and platform support.

The Nix flake supports `aarch64-darwin`, `aarch64-linux`, and `x86_64-linux`.

Usage-limit retrieval is read-only. Automatic token setup issues a credential
and writes it to local auth state; explicit `auth login` does the same.
