import { describe, expect, it } from "bun:test";
import * as Effect from "effect/Effect";
import { fileURLToPath } from "node:url";

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

  it("rejects unknown, positional, repeated, and conflicting input before IO", async () => {
    const fixturePath = fileURLToPath(
      new URL("../fixtures/usage-limits.json", import.meta.url),
    );
    const fileReads = { value: 0 };
    const processSpawns = { value: 0 };
    const dependencies = noIoDependencies({ fileReads, processSpawns });
    const invalidCases = [
      ["--unknown-secret-looking-option", "do-not-print-this"],
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

  it("prints root help and agent help without dependency IO", async () => {
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
      await Effect.runPromise(runCli(["--help-for-agents"], dependencies));
    } finally {
      console.log = originalLog;
    }

    expect(helpOutputs).toEqual([guide.trimEnd(), guide.trimEnd()]);
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
