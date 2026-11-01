{
  lib,
  stdenvNoCC,
  writeShellApplication,
  nushell,
  websocat,
  installAgentSkills,
}:
let
  script = writeShellApplication {
    name = "t3-limits";
    runtimeInputs = [
      nushell
      websocat
    ];
    text = ''exec nu ${./t3-limits.nu} "$@"'';
  };
in
stdenvNoCC.mkDerivation {
  pname = "t3-limits";
  version = lib.trim (builtins.readFile ./version);
  src = ./skills;

  nativeBuildInputs = [ installAgentSkills ];

  dontBuild = true;

  installPhase = ''
    runHook preInstall
    mkdir -p $out/bin
    ln -s ${script}/bin/t3-limits $out/bin/t3-limits
    runHook postInstall
  '';

  meta = {
    description = "Read AI provider usage limits from a running T3 Code server";
    homepage = "https://github.com/ryoppippi/t3-limits";
    license = lib.licenses.mit;
    maintainers = [ lib.maintainers.ryoppippi ];
    platforms = lib.platforms.unix;
    mainProgram = "t3-limits";
  };
}
