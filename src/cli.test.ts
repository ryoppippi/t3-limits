import { describe, expect, it } from "bun:test";
import * as Effect from "effect/Effect";
import { fileURLToPath } from "node:url";

import { runCli } from "./cli.ts";

describe("t3-limits CLI", () => {
  it("prints safe fixture data in JSON mode without requiring a token", async () => {
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...values: unknown[]) => output.push(values.join(" "));
    try {
      const fixturePath = fileURLToPath(new URL("../fixtures/usage-limits.json", import.meta.url));
      await Effect.runPromise(runCli(["--fixture", fixturePath, "--json"]));
    } finally {
      console.log = originalLog;
    }

    const printed = output.join("\n");
    const report = JSON.parse(printed) as { providers: unknown[]; notices: string[] };
    expect(report.providers).toHaveLength(3);
    expect(report.notices).toHaveLength(2);
    expect(printed).not.toContain("fixture-secret");
    expect(printed).not.toContain("fixture-provider-error-must-not-be-printed");
    expect(printed).not.toContain("fixture-source-error-must-not-be-printed");
  });

  it("fails clearly before making a connection when authentication is missing", async () => {
    const originalToken = process.env.T3_LIMITS_TOKEN;
    process.env.T3_LIMITS_TOKEN = "";
    try {
      await expect(Effect.runPromise(runCli(["--url", "http://127.0.0.1:8318"]))).rejects.toThrow(
        "T3_LIMITS_TOKEN is set but empty.",
      );
    } finally {
      if (originalToken === undefined) delete process.env.T3_LIMITS_TOKEN;
      else process.env.T3_LIMITS_TOKEN = originalToken;
    }
  });

  it("rejects unknown, positional, repeated, and conflicting input before touching credentials", async () => {
    const fixturePath = fileURLToPath(new URL("../fixtures/usage-limits.json", import.meta.url));
    let credentialReads = 0;
    let fileReads = 0;
    let processSpawns = 0;
    const dependencies = {
      env: {},
      secrets: {
        get: async () => { credentialReads += 1; return null; },
        set: async () => { credentialReads += 1; },
        delete: async () => { credentialReads += 1; return true; },
      },
      readFile: async () => { fileReads += 1; return "unused"; },
      spawn: () => {
        processSpawns += 1;
        throw new Error("must not spawn");
      },
    } satisfies NonNullable<Parameters<typeof runCli>[1]>;
    const invalidCases = [
      ["--unknown-secret-looking-option", "do-not-print-this"],
      ["unexpected-positional"],
      ["--home", "auth", "login"],
      ["--url", "auth", "logout"],
      ["--home="],
      ["--", "after-terminator"],
      ["--home", "/first", "--home", "/second"],
      ["auth", "login", "--home", "/first", "--home", "/second"],
      ["--fixture", fixturePath, "--url", "http://127.0.0.1:8318"],
      ["--fixture", fixturePath, "extra-positional"],
      ["auth", "login", "--url", "http://127.0.0.1:8318"],
      ["auth", "logout", "--home", "/home", "--url", "http://127.0.0.1:8318"],
      ["auth", "logout", "--t3-bin", "/installed/t3"],
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

    expect(credentialReads).toBe(0);
    expect(fileReads).toBe(0);
    expect(processSpawns).toBe(0);
  });

  it("prints leaf help without resolving auth state", async () => {
    let credentialReads = 0;
    let fileReads = 0;
    let processSpawns = 0;
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...values: unknown[]) => output.push(values.join(" "));
    try {
      await Effect.runPromise(runCli(["auth", "login", "--help"], {
        env: {},
        secrets: {
          get: async () => { credentialReads += 1; return null; },
          set: async () => { credentialReads += 1; },
          delete: async () => { credentialReads += 1; return true; },
        },
        readFile: async () => { fileReads += 1; return "unused"; },
        spawn: () => {
          processSpawns += 1;
          throw new Error("must not spawn");
        },
      }));
    } finally {
      console.log = originalLog;
    }

    expect(output.join("\n")).toContain("t3-limits auth login");
    expect(credentialReads).toBe(0);
    expect(fileReads).toBe(0);
    expect(processSpawns).toBe(0);
  });

  it("prints the version without resolving auth state", async () => {
    let credentialReads = 0;
    let fileReads = 0;
    let processSpawns = 0;
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...values: unknown[]) => output.push(values.join(" "));
    try {
      await Effect.runPromise(runCli(["--version"], {
        env: {},
        secrets: {
          get: async () => { credentialReads += 1; return null; },
          set: async () => { credentialReads += 1; },
          delete: async () => { credentialReads += 1; return true; },
        },
        readFile: async () => { fileReads += 1; return "unused"; },
        spawn: () => {
          processSpawns += 1;
          throw new Error("must not spawn");
        },
      }));
    } finally {
      console.log = originalLog;
    }

    expect(output.join("\n")).toMatch(/\d+\.\d+\.\d+/);
    expect(credentialReads).toBe(0);
    expect(fileReads).toBe(0);
    expect(processSpawns).toBe(0);
  });
});
