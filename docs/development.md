# Development

Run the test suite with Bun:

```sh
bun --no-env-file run test
```

The Nix flake packages the TypeScript source and uses Bun at runtime. It
supports `aarch64-darwin`, `aarch64-linux`, and `x86_64-linux`.

The runtime uses the latest stable Bun package from `github:ryoppippi/nix-bun`;
its `nixpkgs` input follows this flake's `nixpkgs`. `flake.lock` pins the
selected Bun release. To update it, run `gh-nix nix flake update nix-bun`
and commit the resulting lockfile change.
