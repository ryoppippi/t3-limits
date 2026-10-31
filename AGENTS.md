# Agent instructions

Before changing the CLI, read `node_modules/@gunshi/docs/README.md` and the relevant installed guide and API files; prefer Gunshi's built-in argument parsing and validation over custom handling.

Before implementing or reviewing Effect code, use the official Effect skills from https://github.com/Effect-TS/skills. If the repository-local skill is not installed, run `nix run .#sync-agent-skills` from the repository root.

Update skill sources from the repository root with `nix run .#skills-sources-lock`.

Read `node_modules/effect/AGENTS.md` completely, then follow the relevant guides it references so your guidance matches the installed Effect version.
