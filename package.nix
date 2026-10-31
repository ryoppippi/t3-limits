{
  lib,
  stdenvNoCC,
  bun,
  bun2nix,
  makeWrapper,
  supportedSystems,
}:
let
  packageJson = lib.importJSON ./package.json;

  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./package.json
      ./bun.lock
      ./src
      ./fixtures
      ./docs
      ./README.md
      ./LICENSE
    ];
  };
in
stdenvNoCC.mkDerivation {
  pname = packageJson.name;
  inherit (packageJson) version;
  inherit src;

  nativeBuildInputs = [ bun bun2nix.hook makeWrapper ];

  bunDeps = bun2nix.fetchBunDeps {
    bunNix = ./nix/bun.nix;
  };

  dontUseBunBuild = true;
  dontRunLifecycleScripts = true;
  bunInstallFlags = [
    "--no-env-file"
    "--linker=isolated"
    "--production"
  ] ++ lib.optionals stdenvNoCC.hostPlatform.isDarwin [ "--backend=symlink" ];

  installPhase = ''
    runHook preInstall

    mkdir -p "$out/share/t3-limits" "$out/bin"
    cp -R src node_modules package.json fixtures docs README.md LICENSE "$out/share/t3-limits/"
    makeWrapper ${bun}/bin/bun "$out/bin/t3-limits" \
      --add-flags "--no-env-file run $out/share/t3-limits/src/cli.ts"

    runHook postInstall
  '';

  meta = {
    description = "Read usage limits from a running T3 Code server";
    mainProgram = "t3-limits";
    license = lib.licenses.mit;
    platforms = supportedSystems;
  };
}
