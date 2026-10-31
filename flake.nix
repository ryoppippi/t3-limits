{
  description = "A small Bun CLI for reading T3 Code usage limits";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs = { nixpkgs, ... }:
    let
      systems = [ "aarch64-darwin" "x86_64-darwin" "aarch64-linux" "x86_64-linux" ];
      eachSystem = nixpkgs.lib.genAttrs systems;
    in {
      packages = eachSystem (system:
        let
          pkgs = import nixpkgs { inherit system; };
          cli = pkgs.stdenvNoCC.mkDerivation {
            pname = "t3-limits";
            version = "0.1.0";
            src = ./.;
            nativeBuildInputs = [ pkgs.makeWrapper ];
            dontBuild = true;
            installPhase = ''
              mkdir -p "$out/share/t3-limits" "$out/bin"
              cp -R src fixtures README.md "$out/share/t3-limits/"
              makeWrapper ${pkgs.bun}/bin/bun "$out/bin/t3-limits" \
                --add-flags "run $out/share/t3-limits/src/cli.ts"
            '';
            meta = {
              description = "Read usage limits from a running T3 Code server";
              mainProgram = "t3-limits";
              platforms = systems;
            };
          };
        in {
          default = cli;
          t3-limits = cli;
        });
    };
}
