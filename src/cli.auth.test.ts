import { describe, expect, it } from "bun:test";
import * as Effect from "effect/Effect";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "./cli.ts";
import { RpcFailure } from "./errors.ts";

function runCliEffect(
  args: readonly string[],
  dependencies?: NonNullable<Parameters<typeof runCli>[1]>,
) {
  return Effect.runPromise(runCli(args, dependencies));
}

async function makeHome(origin = "ws://localhost:8318/"): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "t3-limits-auth-"));
  const runtimeDir = join(home, ".t3", "userdata");
  await mkdir(runtimeDir, { recursive: true });
  await Bun.write(
    join(runtimeDir, "server-runtime.json"),
    JSON.stringify({ origin }),
  );
  return home;
}

describe("live CLI authentication", () => {
  it("issues a new one-minute scoped token for each retrieval and keeps it in memory", async () => {
    const home = await makeHome();
    const commands: (readonly string[])[] = [];
    let tokenNumber = 0;
    const requested: string[] = [];
    const originalLog = console.log;
    console.log = () => {};
    try {
      const dependencies = {
        env: {},
        readFile: async () => "unused",
        spawn: (command: readonly string[]) => {
          commands.push(command);
          tokenNumber += 1;
          return {
            stdout:
              new Response(`token-${tokenNumber}\n`).body ??
              new ReadableStream<Uint8Array>(),
            exited: Promise.resolve(0),
            kill: () => {},
          };
        },
        readUsageLimits: ({ token }: { readonly token: string }) =>
          Effect.sync(() => {
            requested.push(token);
            return { providers: [], sources: [] };
          }),
      } satisfies NonNullable<Parameters<typeof runCli>[1]>;

      await runCliEffect(["--home", home], dependencies);
      await runCliEffect(["--home", home], dependencies);
    } finally {
      console.log = originalLog;
      await rm(home, { recursive: true, force: true });
    }

    expect(requested).toEqual(["token-1", "token-2"]);
    expect(commands).toHaveLength(2);
    for (const command of commands) {
      expect(command[0]).toBe("t3");
      expect(command).toContain("orchestration:read");
      expect(command).toContain("1m");
      expect(command).toContain("t3-limits");
      expect(command).toContain("--token-only");
      expect(command).toContain(join(home, ".t3"));
    }
  });

  it("accepts only a nonempty absolute configured T3 CLI path", async () => {
    const home = await makeHome();
    let executable = "";
    let spawns = 0;
    const base = {
      readFile: async () => "unused",
      spawn: (command: readonly string[]) => {
        spawns += 1;
        executable = command[0] ?? "";
        return {
          stdout:
            new Response("path-token").body ?? new ReadableStream<Uint8Array>(),
          exited: Promise.resolve(0),
          kill: () => {},
        };
      },
      readUsageLimits: () => Effect.succeed({ providers: [], sources: [] }),
    } satisfies Omit<NonNullable<Parameters<typeof runCli>[1]>, "env">;
    try {
      const originalLog = console.log;
      console.log = () => {};
      try {
        await runCliEffect(["--home", home], {
          ...base,
          env: { T3CODE_CLI_PATH: "/custom/bin/t3" },
        });
      } finally {
        console.log = originalLog;
      }

      expect(executable).toBe("/custom/bin/t3");
      for (const value of ["", "./t3"]) {
        await expect(
          runCliEffect(["--home", home], {
            ...base,
            env: { T3CODE_CLI_PATH: value },
          }),
        ).rejects.toThrow("absolute executable path");
      }
      expect(spawns).toBe(1);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("does not issue or discover runtime state when explicit credentials are supplied", async () => {
    let spawns = 0;
    let fileReads = 0;
    const originalLog = console.log;
    console.log = () => {};
    try {
      const dependencies = {
        env: { T3_LIMITS_TOKEN: "environment-token" },
        readFile: async () => {
          fileReads += 1;
          return "file-token";
        },
        spawn: () => {
          spawns += 1;
          throw new Error("must not spawn");
        },
        readUsageLimits: () => Effect.succeed({ providers: [], sources: [] }),
      } satisfies NonNullable<Parameters<typeof runCli>[1]>;

      await runCliEffect(["--url", "http://127.0.0.1:8318"], dependencies);
      await runCliEffect(
        ["--url", "http://127.0.0.1:8318", "--token-file", "/token"],
        dependencies,
      );
    } finally {
      console.log = originalLog;
    }

    expect(spawns).toBe(0);
    expect(fileReads).toBe(1);
  });

  it("does not issue a replacement when an explicit token is rejected by RPC", async () => {
    let spawns = 0;
    await expect(
      runCliEffect(["--url", "http://127.0.0.1:8318"], {
        env: { T3_LIMITS_TOKEN: "rejected-token" },
        readFile: async () => "unused",
        spawn: () => {
          spawns += 1;
          throw new Error("must not issue a replacement");
        },
        readUsageLimits: () =>
          Effect.fail(new RpcFailure({ safeMessage: "rejected token detail" })),
      }),
    ).rejects.toThrow("Check the server connection and supplied credential.");
    expect(spawns).toBe(0);
  });

  it("stops on empty, unreadable, or invalid explicit credentials without fallback", async () => {
    let spawns = 0;
    const dependencies = {
      env: { T3_LIMITS_TOKEN: "" },
      readFile: async () => "file-token",
      spawn: () => {
        spawns += 1;
        throw new Error("must not spawn");
      },
      readUsageLimits: () => Effect.succeed({ providers: [], sources: [] }),
    } satisfies NonNullable<Parameters<typeof runCli>[1]>;

    await expect(
      runCliEffect(["--url", "http://127.0.0.1:8318"], dependencies),
    ).rejects.toThrow("T3_LIMITS_TOKEN is set but empty.");
    await expect(
      runCliEffect(["--url", "http://127.0.0.1:8318", "--token-file", ""], {
        ...dependencies,
        env: {},
      }),
    ).rejects.toThrow("Expected a value after --token-file.");
    await expect(
      runCliEffect(
        ["--url", "http://127.0.0.1:8318", "--token-file", "/missing"],
        {
          ...dependencies,
          env: { T3_LIMITS_TOKEN: "environment-token" },
          readFile: async () => {
            throw new Error("private file path detail");
          },
        },
      ),
    ).rejects.toThrow("The token file could not be read.");
    await expect(
      runCliEffect(
        ["--url", "http://127.0.0.1:8318", "--token-file", "/empty"],
        { ...dependencies, env: {}, readFile: async () => " \n" },
      ),
    ).rejects.toThrow("The token file is empty.");
    expect(spawns).toBe(0);
  });

  it("requires an automatic-issuance URL override to match runtime state", async () => {
    const home = await makeHome("http://localhost:8318");
    let spawns = 0;
    try {
      await expect(
        runCliEffect(["--url", "http://localhost:8319", "--home", home], {
          env: {},
          readFile: async () => "unused",
          spawn: () => {
            spawns += 1;
            throw new Error("must not issue");
          },
          readUsageLimits: () => Effect.succeed({ providers: [], sources: [] }),
        }),
      ).rejects.toThrow("The --url override does not match the runtime server");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
    expect(spawns).toBe(0);
  });

  it("does not retry issuance after an RPC failure and redacts the cause", async () => {
    const home = await makeHome("http://127.0.0.1:8318");
    let spawns = 0;
    try {
      const failure = await runCliEffect(["--home", home], {
        env: {},
        readFile: async () => "unused",
        spawn: () => {
          spawns += 1;
          return {
            stdout:
              new Response("issued-token").body ??
              new ReadableStream<Uint8Array>(),
            exited: Promise.resolve(0),
            kill: () => {},
          };
        },
        readUsageLimits: () =>
          Effect.fail(new RpcFailure({ safeMessage: "private RPC detail" })),
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(String(failure)).toContain(
        "Check the server connection and supplied credential.",
      );
      expect(String(failure)).not.toContain("private RPC detail");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
    expect(spawns).toBe(1);
  });

  it("rejects removed auth commands before touching files or spawning", async () => {
    let fileReads = 0;
    let spawns = 0;
    const dependencies = {
      env: {},
      readFile: async () => {
        fileReads += 1;
        return "unused";
      },
      spawn: () => {
        spawns += 1;
        throw new Error("must not spawn");
      },
    } satisfies NonNullable<Parameters<typeof runCli>[1]>;

    await expect(runCliEffect(["auth", "login"], dependencies)).rejects.toThrow(
      "Unexpected positional argument",
    );
    await expect(
      runCliEffect(["auth", "logout"], dependencies),
    ).rejects.toThrow("Unexpected positional argument");
    expect(fileReads).toBe(0);
    expect(spawns).toBe(0);
  });
});
