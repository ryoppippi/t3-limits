import { describe, expect, it } from "bun:test";
import * as Effect from "effect/Effect";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "./cli.ts";

const noIoDependencies = (counts: {
  readonly fileReads: { value: number };
  readonly processSpawns: { value: number };
}) =>
  ({
    env: {},
    readFile: async () => {
      counts.fileReads.value += 1;
      return "unused";
    },
    spawn: () => {
      counts.processSpawns.value += 1;
      throw new Error("must not spawn");
    },
  }) satisfies NonNullable<Parameters<typeof runCli>[1]>;

const fixturePath = fileURLToPath(
  new URL("../fixtures/usage-limits.json", import.meta.url),
);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));

function cliEnvironment(agent?: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) env[name] = value;
  }
  for (const name of [
    "AI_AGENT",
    "CLAUDECODE",
    "CLAUDE_CODE",
    "REPL_ID",
    "GEMINI_CLI",
    "CODEX_SANDBOX",
    "CODEX_THREAD_ID",
    "OPENCODE",
    "AUGMENT_AGENT",
    "GOOSE_PROVIDER",
    "EDITOR",
    "CURSOR_AGENT",
    "TERM_PROGRAM",
  ]) {
    delete env[name];
  }
  if (env.PATH !== undefined) {
    env.PATH = env.PATH.split(process.platform === "win32" ? ";" : ":")
      .filter((entry) => !/[\\/]?\.pi[\\/]agent(?:[\\/]|$)/.test(entry))
      .join(process.platform === "win32" ? ";" : ":");
  }
  if (agent !== undefined) env.AI_AGENT = agent;
  return env;
}

async function runCliProcess(
  args: readonly string[],
  agent?: string,
  environment: Readonly<Record<string, string>> = {},
): Promise<{
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}> {
  const env = cliEnvironment(agent);
  Object.assign(env, environment);
  const child = Bun.spawn(
    [process.execPath, "run", "src/cli.ts", "--fixture", fixturePath, ...args],
    {
      cwd: projectRoot,
      env,
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stderr, stdout };
}

describe("t3-limits CLI", () => {
  it("prints a readable table by default outside an agent", async () => {
    for (const level of ["0", "100"]) {
      const child = await runCliProcess([], undefined, {
        CONSOLA_LEVEL: level,
        NODE_ENV: "test",
      });

      expect(child.exitCode).toBe(0);
      expect(child.stderr).toBe("");
      expect(child.stdout.startsWith("Usage limits retrieved at ")).toBe(true);
      expect(child.stdout).toContain("Window");
      expect(child.stdout).toContain("72.5%");
      expect(child.stdout).toContain("Claude Code · claude · claude");
      expect(child.stdout).toContain(
        "CLI Proxy / account-a · claude · cliproxy-hub/account-a",
      );
      expect(child.stdout).not.toContain("Claude Code (claude · claude)");
      expect(child.stdout).not.toContain("fixture-secret");
    }
  });

  it("preserves enumerated output when Gunshi detects an agent", async () => {
    const child = await runCliProcess([], "codex");

    expect(child.exitCode).toBe(0);
    expect(child.stderr).toBe("");
    expect(child.stdout).toContain(
      "Claude Code (claude · claude) · enabled · checked 2026-10-31T11:58:00.000Z",
    );
    expect(child.stdout).toContain(
      "  5-hour session: 72.5% used · 27.5% remaining",
    );
    expect(child.stdout).not.toContain("Window");
    expect(child.stdout).not.toContain("fixture-secret");
  });

  it("lets explicit JSON output override the human default", async () => {
    const child = await runCliProcess(["--json"]);

    expect(child.exitCode).toBe(0);
    expect(child.stderr).toBe("");
    expect(JSON.parse(child.stdout)).toHaveProperty("providers");
    expect(child.stdout).not.toContain("Usage limits retrieved at");
  });

  it("lets explicit JSON output override agent detection", async () => {
    const child = await runCliProcess(["--json"], "codex");

    expect(child.exitCode).toBe(0);
    expect(child.stderr).toBe("");
    const report = JSON.parse(child.stdout) as {
      readonly notices: string[];
      readonly providers: unknown[];
      readonly retrievedAt: string;
    };
    expect(report.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(report.providers).toHaveLength(3);
    expect(report.notices).toHaveLength(2);
  });

  it("prints safe fixture data in JSON mode without requiring a token", async () => {
    const output: string[] = [];
    const fileReads = { value: 0 };
    const processSpawns = { value: 0 };
    const originalLog = console.log;
    console.log = (...values: unknown[]) => output.push(values.join(" "));
    try {
      const fixturePath = fileURLToPath(
        new URL("../fixtures/usage-limits.json", import.meta.url),
      );
      await Effect.runPromise(
        runCli(
          ["--fixture", fixturePath, "--json"],
          noIoDependencies({ fileReads, processSpawns }),
        ),
      );
    } finally {
      console.log = originalLog;
    }

    const printed = output.join("\n");
    const report = JSON.parse(printed) as {
      providers: unknown[];
      notices: string[];
    };
    expect(report.providers).toHaveLength(3);
    expect(report.notices).toHaveLength(2);
    expect(fileReads.value).toBe(0);
    expect(processSpawns.value).toBe(0);
    expect(printed).not.toContain("fixture-secret");
    expect(printed).not.toContain("fixture-provider-error-must-not-be-printed");
    expect(printed).not.toContain("fixture-source-error-must-not-be-printed");
  });

  it("maps malformed fixture JSON without exposing its contents", async () => {
    const directory = await mkdtemp(join(tmpdir(), "t3-limits-json-"));
    const fixturePath = join(directory, "fixture.json");
    const sentinel = "fixture-token-secret-sentinel-1dc4";
    await Bun.write(fixturePath, `{"token":"${sentinel}"`);

    try {
      const failure = await Effect.runPromise(
        runCli(
          ["--fixture", fixturePath],
          noIoDependencies({
            fileReads: { value: 0 },
            processSpawns: { value: 0 },
          }),
        ),
      ).then(
        () => undefined,
        (reason: unknown) => reason,
      );

      expect(String(failure)).toContain(
        "Could not read the usage-limits fixture.",
      );
      expect(String(failure)).not.toContain(sentinel);
      expect(JSON.stringify(failure)).not.toContain(sentinel);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects unknown, positional, repeated, and conflicting input before IO", async () => {
    const fixturePath = fileURLToPath(
      new URL("../fixtures/usage-limits.json", import.meta.url),
    );
    const fileReads = { value: 0 };
    const processSpawns = { value: 0 };
    const dependencies = noIoDependencies({ fileReads, processSpawns });
    const invalidCases = [
      ["--unknown-secret-looking-option", "do-not-print-this"],
      ["--help-agent"],
      ["--help-for-agents"],
      ["--helpForAgents", "--unknown"],
      ["unexpected-positional"],
      ["--home", "auth", "login"],
      ["--url", "auth", "logout"],
      ["--home"],
      ["--home="],
      ["--fixture="],
      ["--url="],
      ["--token-file="],
      ["--json=false"],
      ["--", "after-terminator"],
      ["--home", "/first", "--home", "/second"],
      ["--fixture", fixturePath, "--url", "http://127.0.0.1:8318"],
      ["--fixture", fixturePath, "extra-positional"],
      ["auth", "login"],
      ["auth", "logout"],
      ["auth", "login", "--unknown"],
    ] as const;

    for (const args of invalidCases) {
      let failure = "";
      try {
        await Effect.runPromise(runCli(args, dependencies));
      } catch (error) {
        failure = String(error);
      }
      expect(failure).not.toBe("");
      expect(failure).not.toContain("do-not-print-this");
      expect(failure).not.toContain("unknown-secret-looking-option");
    }

    expect(fileReads.value).toBe(0);
    expect(processSpawns.value).toBe(0);
  });

  it("prints generated help and the agent guide without dependency IO", async () => {
    const guide = await Bun.file(
      fileURLToPath(new URL("../docs/guide.md", import.meta.url)),
    ).text();
    const helpOutputs: string[] = [];
    const fileReads = { value: 0 };
    const processSpawns = { value: 0 };
    const dependencies = noIoDependencies({ fileReads, processSpawns });
    const originalLog = console.log;
    console.log = (...values: unknown[]) => helpOutputs.push(values.join(" "));
    try {
      await Effect.runPromise(runCli(["--help"], dependencies));
      await Effect.runPromise(runCli(["-h"], dependencies));
      await Effect.runPromise(runCli(["--helpForAgents"], dependencies));
    } finally {
      console.log = originalLog;
    }

    expect(helpOutputs).toHaveLength(3);
    expect(helpOutputs[0]).toContain("USAGE:");
    expect(helpOutputs[0]).toContain("OPTIONS:");
    for (const option of [
      "--json",
      "--fixture",
      "--url",
      "--home",
      "--token-file",
      "--helpForAgents",
    ]) {
      expect(helpOutputs[0]).toContain(option);
    }
    expect(helpOutputs[0]).not.toContain("--help-agent");
    expect(helpOutputs[0]).not.toContain("--help-for-agents");
    expect(helpOutputs[0]).not.toContain("# t3-limits guide");
    expect(helpOutputs[0]).not.toContain("Authentication");
    expect(helpOutputs[0]).not.toContain("1Password");
    expect(helpOutputs[1]).toBe(helpOutputs[0]);
    expect(helpOutputs[2]).toBe(guide.trimEnd());
    expect(fileReads.value).toBe(0);
    expect(processSpawns.value).toBe(0);
  });

  it("prints the version without resolving auth state", async () => {
    const output: string[] = [];
    const fileReads = { value: 0 };
    const processSpawns = { value: 0 };
    const originalLog = console.log;
    console.log = (...values: unknown[]) => output.push(values.join(" "));
    try {
      await Effect.runPromise(
        runCli(["--version"], noIoDependencies({ fileReads, processSpawns })),
      );
    } finally {
      console.log = originalLog;
    }

    expect(output.join("\n")).toMatch(/\d+\.\d+\.\d+/);
    expect(fileReads.value).toBe(0);
    expect(processSpawns.value).toBe(0);
  });
});
