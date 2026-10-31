{
  lib,
  stdenvNoCC,
  bun,
  bun2nix,
  t3Contracts,
  supportedSystems,
}:
let
  packageJson = lib.importJSON ./package.json;

  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./package.json
      ./bun.lock
      ./bunfig.toml
      ./tsconfig.json
      ./src
      ./scripts
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

  nativeBuildInputs = [ bun bun2nix.hook ];

  bunDeps = bun2nix.fetchBunDeps {
    bunNix = ./nix/bun.nix;
  };

  dontUseBunBuild = true;
  dontRunLifecycleScripts = true;
  dontStrip = true;
  dontPatchELF = true;
  __darwinAllowLocalNetworking = true;
  bunInstallFlags = [
    "--no-env-file"
    "--linker=isolated"
  ] ++ lib.optionals stdenvNoCC.hostPlatform.isDarwin [ "--backend=symlink" ];

  buildPhase = ''
    runHook preBuild

    mkdir -p .generated/t3-contracts
    cp -R ${t3Contracts}/. .generated/t3-contracts/

    ${bun}/bin/bun --no-env-file build --compile src/cli.ts \
      --outfile=t3-limits \
      --no-compile-autoload-dotenv \
      --no-compile-autoload-bunfig

    runHook postBuild
  '';

  doCheck = true;
  checkPhase = ''
    runHook preCheck

    ${bun}/bin/bun --no-env-file run check
    ${bun}/bin/bun --no-env-file run test

    runHook postCheck
  '';

  installPhase = ''
    runHook preInstall

    install -Dm755 t3-limits "$out/bin/t3-limits"
    install -Dm644 README.md "$out/share/doc/t3-limits/README.md"
    install -Dm644 LICENSE "$out/share/licenses/t3-limits/LICENSE"
    install -Dm644 .generated/t3-contracts/LICENSE "$out/share/licenses/t3-limits/t3code-LICENSE"
    install -Dm644 node_modules/effect/LICENSE "$out/share/licenses/t3-limits/effect-LICENSE"
    install -Dm644 node_modules/gunshi/LICENSE "$out/share/licenses/t3-limits/gunshi-LICENSE"
    mkdir -p "$out/share/t3-limits"
    cp -R docs fixtures "$out/share/t3-limits/"

    runHook postInstall
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck

    "$out/bin/t3-limits" --help >/dev/null
    "$out/bin/t3-limits" --fixture "$out/share/t3-limits/fixtures/usage-limits.json" --json > "$TMPDIR/fixture-report.json"
    grep -q '"providers"' "$TMPDIR/fixture-report.json"
    grep -q 'Claude Code' "$TMPDIR/fixture-report.json"
    grep -q 'CLI Proxy' "$TMPDIR/fixture-report.json"
    if grep -Eq 'private@example\.invalid|also-private@example\.invalid|private-plan-name|fixture-secret|fixture-fingerprint|fixture-credit|fixture-private-note|fixture-provider-error-must-not-be-printed|fixture-source-error-must-not-be-printed' "$TMPDIR/fixture-report.json"; then
      echo "The compiled fixture report included private input data." >&2
      exit 1
    fi

    runHook postInstallCheck
  '';

  meta = {
    description = "Read usage limits from a running T3 Code server";
    mainProgram = "t3-limits";
    license = lib.licenses.mit;
    platforms = supportedSystems;
  };
}
