{
  description = "A small Bun CLI for reading T3 Code usage limits";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { nixpkgs, ... }:
    let
      package = builtins.fromJSON (builtins.readFile ./package.json);
      systems = [ "aarch64-darwin" "aarch64-linux" "x86_64-linux" ];
      eachSystem = nixpkgs.lib.genAttrs systems;
    in {
      packages = eachSystem (system:
        let
          pkgs = import nixpkgs { inherit system; };
          cli = pkgs.stdenvNoCC.mkDerivation {
            pname = package.name;
            version = package.version;
            src = ./.;
            nativeBuildInputs = [ pkgs.makeWrapper ];
            dontBuild = true;
            installPhase = ''
              mkdir -p "$out/share/t3-limits" "$out/bin"
              cp -R src fixtures docs README.md LICENSE "$out/share/t3-limits/"
              makeWrapper ${pkgs.bun}/bin/bun "$out/bin/t3-limits" \
                --add-flags "--no-env-file run $out/share/t3-limits/src/cli.ts"
            '';
            meta = {
              description = "Read usage limits from a running T3 Code server";
              mainProgram = "t3-limits";
              license = pkgs.lib.licenses.mit;
              platforms = systems;
            };
          };
        in {
          default = cli;
          t3-limits = cli;
        });
    };
}
