# Development

Run the test suite with Bun:

```sh
bun --no-env-file run test
```

The Nix flake packages the TypeScript source and production dependencies for
offline runtime resolution. It supports `aarch64-darwin`, `aarch64-linux`, and
`x86_64-linux`.

The runtime uses the latest stable Bun package from `github:ryoppippi/nix-bun`;
its `nixpkgs` input follows this flake's `nixpkgs`. `flake.lock` pins the
selected Bun release. To update it, run `gh-nix nix flake update nix-bun`
and commit the resulting lockfile change.

To regenerate the Bun dependency expressions after changing `package.json`,
write the lockfile with Bun 1.3.14 (bun2nix 2.1.2 reads lockfile version 1),
then generate the Nix expressions:

```sh
bun --no-env-file x --package bun@1.3.14 bun --no-env-file install
bun --no-env-file run generate:nix
```

Commit both `bun.lock` and `nix/bun.nix` with the dependency change.
Update the npm generator and bun2nix flake input together, then regenerate and
verify the dependency expressions before committing either update.
