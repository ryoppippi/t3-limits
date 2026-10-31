{ pkgs, agent-skills, effect-skills }:

let
  agentLib = agent-skills.lib.agent-skills;
  sources.effect = {
    path = effect-skills;
    subdir = "skills";
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
in
{
  packages.agent-skills-bundle = bundle;
  apps.sync-agent-skills = {
    type = "app";
    program = pkgs.lib.getExe sync;
    meta.description = "Synchronize the repository-local Effect skill bundle";
  };
  checks.agent-skills = bundle;
}
