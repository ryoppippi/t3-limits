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

describe("t3-limits CLI", () => {
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
      ["--help-for-agents"],
      ["--help-agent", "--unknown"],
      ["unexpected-positional"],
      ["--home", "auth", "login"],
      ["--url", "auth", "logout"],
      ["--home="],
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
      await Effect.runPromise(runCli(["--help-agent"], dependencies));
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
      "--help-agent",
    ]) {
      expect(helpOutputs[0]).toContain(option);
    }
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
