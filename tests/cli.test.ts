import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

import { runCli } from "../src/cli.ts";

describe("t3-limits CLI", () => {
  it("prints safe fixture data in JSON mode without requiring a token", async () => {
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...values: unknown[]) => output.push(values.join(" "));
    try {
      const fixturePath = fileURLToPath(new URL("../fixtures/usage-limits.json", import.meta.url));
      await runCli(["--fixture", fixturePath, "--json"]);
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
      await expect(runCli(["--url", "http://127.0.0.1:8318"])).rejects.toThrow(
        "Authentication required: set T3_LIMITS_TOKEN or pass --token-file <path>.",
      );
    } finally {
      if (originalToken === undefined) delete process.env.T3_LIMITS_TOKEN;
      else process.env.T3_LIMITS_TOKEN = originalToken;
    }
  });
});
