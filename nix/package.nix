{
  perSystem =
    { pkgs, ... }:
    {
      packages.default = pkgs.writeShellApplication {
        name = "t3-limits";
        runtimeInputs = with pkgs; [
          nushell
          websocat
        ];
        text = ''exec nu ${../t3-limits.nu} "$@"'';
      };
    };
}
