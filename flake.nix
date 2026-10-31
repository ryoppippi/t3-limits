{
  description = "A small Bun CLI for reading T3 Code usage limits";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    nix-bun.url = "github:ryoppippi/nix-bun";
    nix-bun.inputs.nixpkgs.follows = "nixpkgs";
    bun2nix = {
      url = "github:nix-community/bun2nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { nixpkgs, nix-bun, bun2nix, ... }:
    let
      systems = [ "aarch64-darwin" "aarch64-linux" "x86_64-linux" ];
      eachSystem = nixpkgs.lib.genAttrs systems;
    in {
      packages = eachSystem (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          cli = pkgs.callPackage ./package.nix {
            bun = nix-bun.packages.${system}.bun;
            bun2nix = bun2nix.packages.${system}.default;
            supportedSystems = systems;
          };
        in {
          default = cli;
          t3-limits = cli;
        });
    };
}
