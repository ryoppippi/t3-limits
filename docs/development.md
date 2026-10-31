# Development

Run the test suite with Bun:

```sh
bun --no-env-file run test
```

The runtime uses Effect for CLI, authentication, process, and RPC failure
channels. Effect Schema decodes incoming boundaries, while report projection
copies only its explicit output fields. Run Bun's strict type checker with
`bun --no-env-file check`.

The Nix flake uses the production dependencies from the offline bun2nix cache
to compile `src/cli.ts` into a standalone Bun executable. It supports
`aarch64-darwin`, `aarch64-linux`, and `x86_64-linux`. This is native
compilation with `bun build --compile`, not native AOT; the packaged Bun
version does not provide `--aot`.

The compile disables `.env` and `bunfig.toml` autoloading so the executable
does not read code configuration from its working directory. It does not
inline environment values, so supported tokens remain available through the
process environment. `dontStrip = true` is required because Bun appends the
JavaScript payload to its executable and stripping it breaks the result.
The compiler's runtime is already patched for Nix; ELF fixups are disabled on
the completed executable as well.

The runtime uses the latest stable Bun package from `github:ryoppippi/nix-bun`;
its `nixpkgs` input follows this flake's `nixpkgs`. `flake.lock` pins the
selected Bun release. To update it, run `gh-nix nix flake update nix-bun`
and commit the resulting lockfile change.

To regenerate the Bun dependency expressions after changing `package.json`,
use the current Bun and the pinned Nix generator:

```sh
bun --no-env-file install
bun --no-env-file run generate:nix
```

Commit both `bun.lock` and `nix/bun.nix` with the dependency change.
Update the bun2nix flake input and regenerate the expressions together.
