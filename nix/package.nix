{
  perSystem =
    { pkgs, lib, ... }:
    let
      script = pkgs.writeShellApplication {
        name = "t3-limits";
        runtimeInputs = with pkgs; [
          nushell
          websocat
        ];
        text = ''exec nu ${../t3-limits.nu} "$@"'';
      };
    in
    {
      packages.default = pkgs.stdenvNoCC.mkDerivation {
        pname = "t3-limits";
        version = lib.trim (builtins.readFile ../version);
        src = ../skills;
        nativeBuildInputs = [ pkgs.installAgentSkills ];
        dontBuild = true;
        installPhase = ''
          runHook preInstall
          mkdir -p $out/bin
          ln -s ${script}/bin/t3-limits $out/bin/t3-limits
          runHook postInstall
        '';
        meta.mainProgram = "t3-limits";
      };
    };
}
