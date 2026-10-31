{
  description = "A small Bun CLI for reading T3 Code usage limits";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    nix-bun.url = "github:ryoppippi/nix-bun";
    nix-bun.inputs.nixpkgs.follows = "nixpkgs";
    bun2nix = {
      url = "github:nix-community/bun2nix/0456acb1b7394fc14c414b056aa889df5124943a";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    llm-agents = {
      url = "github:numtide/llm-agents.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { nixpkgs, nix-bun, bun2nix, llm-agents, ... }:
    let
      systems = [ "aarch64-darwin" "aarch64-linux" "x86_64-linux" ];
      eachSystem = nixpkgs.lib.genAttrs systems;
    in {
      packages = eachSystem (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          t3Source = llm-agents.packages.${system}.t3code.src;
          contractSources = pkgs.runCommand "t3-contract-sources" {} ''
            mkdir -p "$out"
            contract_dir="${t3Source}/packages/contracts/src"
            cp "$contract_dir/providerUsageLimits.ts" "$out/"
            cp "$contract_dir/baseSchemas.ts" "$out/"
            cp "$contract_dir/providerInstance.ts" "$out/"
            cp "$contract_dir/usageLimitSourceId.ts" "$out/"
            if [ -f "$contract_dir/secretReference.ts" ]; then
              cp "$contract_dir/secretReference.ts" "$out/"
            fi
            cp "${t3Source}/LICENSE" "$out/LICENSE"
          '';
          cli = pkgs.callPackage ./package.nix {
            bun = nix-bun.packages.${system}.bun;
            bun2nix = bun2nix.packages.${system}.default;
            t3Contracts = contractSources;
            supportedSystems = systems;
          };
        in {
          default = cli;
          t3-limits = cli;
          bun2nix = bun2nix.packages.${system}.default;
          contract-sources = contractSources;
        });
    };
}
