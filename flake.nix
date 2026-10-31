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
      perSystem = system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          bun = nix-bun.packages.${system}.bun;
          bun2nixPackage = bun2nix.packages.${system}.default;
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
            inherit bun;
            bun2nix = bun2nixPackage;
            t3Contracts = contractSources;
            supportedSystems = systems;
          };
          bunFormatCheck = pkgs.runCommand "t3-limits-bun-format-check" {
            nativeBuildInputs = [ bun ];
            src = pkgs.lib.fileset.toSource {
              root = ./.;
              fileset = pkgs.lib.fileset.unions [
                ./.github/workflows/bun-ci.yaml
                ./README.md
                ./bunfig.toml
                ./docs
                ./package.json
                ./scripts
                ./src
                ./tsconfig.json
              ];
            };
          } ''
            cd "$src"
            bun --no-env-file run fmt:check
            touch "$out"
          '';
          bunNixCheck = pkgs.runCommand "t3-limits-bun-nix-check" {
            nativeBuildInputs = [ bun2nixPackage ];
            src = pkgs.lib.fileset.toSource {
              root = ./.;
              fileset = pkgs.lib.fileset.unions [
                ./bun.lock
                ./package.json
                ./nix/bun.nix
              ];
            };
          } ''
            cd "$src"
            bun2nix -o "$TMPDIR/generated-bun.nix"
            diff -u nix/bun.nix "$TMPDIR/generated-bun.nix"
            touch "$out"
          '';
        in {
          packages = {
            default = cli;
            t3-limits = cli;
            bun = bun;
            bun2nix = bun2nixPackage;
            contract-sources = contractSources;
          };
          checks = {
            package = cli;
            bun-format = bunFormatCheck;
            bun-nix = bunNixCheck;
          };
        };
    in {
      packages = eachSystem (system: (perSystem system).packages);
      checks = eachSystem (system: (perSystem system).checks);
    };
}
