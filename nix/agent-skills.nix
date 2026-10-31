{ pkgs, agent-skills }:

let
  agentLib = agent-skills.lib.agent-skills;
  sources = agentLib.sourcesFromLock {
    manifestsDir = ../registry/sources;
    lockFile = ../registry/sources.lock.json;
  };
  catalog = agentLib.discoverCatalog sources;
  allowlist = agentLib.allowlistFor {
    inherit catalog sources;
    enable = [ "effect-ts" ];
  };
  selection = agentLib.selectSkills {
    inherit catalog sources allowlist;
    skills = { };
  };
  bundle = agentLib.mkBundle {
    inherit pkgs selection;
  };
  targets = {
    agents = agentLib.defaultLocalTargets.agents // {
      enable = true;
      structure = "link";
    };
    claude = agentLib.defaultLocalTargets.claude // {
      enable = true;
      structure = "link";
    };
  };
  sync = agentLib.mkLocalInstallProgram {
    inherit pkgs bundle targets;
  };
  sourceLockProgram = agentLib.mkSourceLockProgram {
    inherit pkgs;
  };
in
{
  packages.agent-skills-bundle = bundle;
  apps.sync-agent-skills = {
    type = "app";
    program = pkgs.lib.getExe sync;
    meta.description = "Synchronize the repository-local Effect skill bundle";
  };
  apps.skills-sources-lock = {
    type = "app";
    program = pkgs.lib.getExe sourceLockProgram;
    meta.description = "Update pinned agent skill source revisions";
  };
  checks.agent-skills = bundle;
}
