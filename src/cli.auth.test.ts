import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "./cli.ts";

describe("t3-limits auth commands", () => {
  it("discovers the origin, issues a scoped token only on login, and stores it for that origin", async () => {
    const home = await mkdtemp(join(tmpdir(), "t3-limits-auth-"));
    const runtimeDir = join(home, ".t3", "userdata");
    await mkdir(runtimeDir, { recursive: true });
    await Bun.write(join(runtimeDir, "server-runtime.json"), JSON.stringify({ origin: "ws://localhost:8318/" }));
    let written: { readonly service: string; readonly name: string; readonly value: string } | undefined;
    let command: readonly string[] = [];
    const dependencies = {
      env: {},
      secrets: {
        get: async () => null,
        set: async (secret: { readonly service: string; readonly name: string; readonly value: string }) => { written = secret; },
        delete: async () => true,
      },
      readFile: async () => "",
      spawn: (args: readonly string[]) => {
        command = args;
        return {
          stdout: new Response("scoped-token\n").body ?? new ReadableStream<Uint8Array>(),
          exited: Promise.resolve(0),
          kill: () => {},
        };
      },
    } satisfies NonNullable<Parameters<typeof runCli>[1]>;

    try {
      await runCli(["auth", "login", "--home", home, "--t3-bin", "/installed/t3"], dependencies);
      expect(command[0]).toBe("/installed/t3");
      expect(command).toContain("orchestration:read");
      expect(command).toContain("1h");
      expect(command).toContain("--token-only");
      expect(written).toEqual({ service: "com.ryoppippi.t3-limits", name: "http://localhost:8318", value: "scoped-token" });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("does not mint for an explicitly empty token and logout only removes local storage", async () => {
    let deleteKey: { readonly service: string; readonly name: string } | undefined;
    let spawned = false;
    const dependencies = {
      env: { T3_LIMITS_TOKEN: "" },
      secrets: {
        get: async () => null,
        set: async () => {},
        delete: async (key: { readonly service: string; readonly name: string }) => { deleteKey = key; return true; },
      },
      readFile: async () => "",
      spawn: () => {
        spawned = true;
        throw new Error("must not mint");
      },
    } satisfies NonNullable<Parameters<typeof runCli>[1]>;

    await expect(runCli(["--url", "http://127.0.0.1:8318"], dependencies)).rejects.toThrow("T3_LIMITS_TOKEN is set but empty.");
    expect(spawned).toBe(false);
    await runCli(["auth", "logout", "--url", "ws://localhost:80"], dependencies);
    expect(deleteKey).toEqual({ service: "com.ryoppippi.t3-limits", name: "http://localhost" });
  });

  it("does not allow login with a URL override", async () => {
    await expect(runCli(["auth", "login", "--url", "http://localhost:8318"], {
      env: {},
      secrets: { get: async () => null, set: async () => {}, delete: async () => true },
      readFile: async () => "",
      spawn: () => { throw new Error("must not spawn"); },
    })).rejects.toThrow("auth login discovers the server origin from runtime state");
  });

  it("automatically issues and stores one token when the secret store has no token", async () => {
    const home = await mkdtemp(join(tmpdir(), "t3-limits-auto-auth-"));
    const runtimeDir = join(home, ".t3", "userdata");
    await mkdir(runtimeDir, { recursive: true });
    await Bun.write(join(runtimeDir, "server-runtime.json"), JSON.stringify({ origin: "ws://localhost:8318/" }));
    let gets = 0;
    let sets = 0;
    let spawns = 0;
    let stored: { readonly service: string; readonly name: string; readonly value: string } | undefined;
    let requested: { readonly origin: string; readonly token: string } | undefined;
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...values: unknown[]) => output.push(values.join(" "));
    try {
      await runCli(["--home", home], {
        env: {},
        secrets: {
          get: async () => { gets += 1; return null; },
          set: async (secret) => { sets += 1; stored = secret; },
          delete: async () => true,
        },
        readFile: async () => "unused",
        spawn: () => {
          spawns += 1;
          return {
            stdout: new Response("auto-token\n").body ?? new ReadableStream<Uint8Array>(),
            exited: Promise.resolve(0),
            kill: () => {},
          };
        },
        readUsageLimits: async ({ origin, token }) => {
          requested = { origin, token };
          return { providers: [], sources: [] };
        },
      });
    } finally {
      console.log = originalLog;
      await rm(home, { recursive: true, force: true });
    }

    expect(gets).toBe(1);
    expect(spawns).toBe(1);
    expect(sets).toBe(1);
    expect(stored).toEqual({ service: "com.ryoppippi.t3-limits", name: "http://localhost:8318", value: "auto-token" });
    expect(requested).toEqual({ origin: "ws://localhost:8318/", token: "auto-token" });
    expect(output.join("\n")).toContain("Usage limits retrieved");
  });

  it("does not issue on secret-store errors or when a stored token later fails RPC", async () => {
    let spawns = 0;
    const base = {
      env: {},
      secrets: { get: async () => null, set: async () => {}, delete: async () => true },
      readFile: async () => "unused",
      spawn: () => {
        spawns += 1;
        return { stdout: new Response("new-token").body ?? new ReadableStream<Uint8Array>(), exited: Promise.resolve(0), kill: () => {} };
      },
      readUsageLimits: async () => ({ providers: [], sources: [] }),
    } satisfies NonNullable<Parameters<typeof runCli>[1]>;

    await expect(runCli(["--url", "http://127.0.0.1:8318"], {
      ...base,
      secrets: { ...base.secrets, get: async () => { throw new Error("private keychain detail"); } },
    })).rejects.toThrow("Could not access the OS secret store.");
    expect(spawns).toBe(0);

    await expect(runCli(["--url", "http://127.0.0.1:8318"], {
      ...base,
      secrets: { ...base.secrets, get: async () => "expired-or-invalid-token" },
      readUsageLimits: async () => { throw new Error("RPC rejected token"); },
    })).rejects.toThrow("t3-limits auth login");
    expect(spawns).toBe(0);
  });

  it("does not bootstrap for a URL override that differs from runtime state", async () => {
    const home = await mkdtemp(join(tmpdir(), "t3-limits-url-guard-"));
    const runtimeDir = join(home, ".t3", "userdata");
    await mkdir(runtimeDir, { recursive: true });
    await Bun.write(join(runtimeDir, "server-runtime.json"), JSON.stringify({ origin: "http://localhost:8318" }));
    let spawns = 0;
    let sets = 0;
    try {
      await expect(runCli(["--url", "http://localhost:8319", "--home", home], {
        env: {},
        secrets: { get: async () => null, set: async () => { sets += 1; }, delete: async () => true },
        readFile: async () => "unused",
        spawn: () => { spawns += 1; throw new Error("must not issue"); },
        readUsageLimits: async () => ({ providers: [], sources: [] }),
      })).rejects.toThrow("The --url override does not match the runtime server");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
    expect(spawns).toBe(0);
    expect(sets).toBe(0);
  });

  it("does not bootstrap when explicit environment or file credentials are supplied", async () => {
    let spawns = 0;
    let secretReads = 0;
    const dependencies = {
      env: { T3_LIMITS_TOKEN: "explicit-env-token" },
      secrets: { get: async () => { secretReads += 1; return null; }, set: async () => {}, delete: async () => true },
      readFile: async () => "explicit-file-token",
      spawn: () => { spawns += 1; throw new Error("must not issue"); },
      readUsageLimits: async () => ({ providers: [], sources: [] }),
    } satisfies NonNullable<Parameters<typeof runCli>[1]>;

    await runCli(["--url", "http://127.0.0.1:8318"], dependencies);
    await runCli(["--url", "http://127.0.0.1:8318", "--token-file", "/token"], dependencies);
    expect(spawns).toBe(0);
    expect(secretReads).toBe(0);
  });

  it("does not expose an unknown auth flag in a missing-value error", async () => {
    await expect(runCli(["auth", "login", "--untrusted-flag"])).rejects.toThrow("Expected an option value.");
    await expect(runCli(["auth", "login", "--untrusted-flag"])).rejects.not.toThrow("--untrusted-flag");
  });

  it("rejects empty and relative configured executables before issuing", async () => {
    const home = await mkdtemp(join(tmpdir(), "t3-limits-executable-"));
    const runtimeDir = join(home, ".t3", "userdata");
    await mkdir(runtimeDir, { recursive: true });
    await Bun.write(join(runtimeDir, "server-runtime.json"), JSON.stringify({ origin: "http://localhost:8318" }));
    let spawns = 0;
    try {
      for (const executable of ["", "./untrusted/t3"]) {
        const dependencies = {
          env: { T3CODE_CLI_PATH: executable },
          secrets: { get: async () => null, set: async () => {}, delete: async () => true },
          readFile: async () => "",
          spawn: () => { spawns += 1; throw new Error("must not spawn"); },
        } satisfies NonNullable<Parameters<typeof runCli>[1]>;
        await expect(runCli(["--home", home], dependencies)).rejects.toThrow("absolute executable path");
        await expect(runCli(["auth", "login", "--home", home], dependencies)).rejects.toThrow("absolute executable path");
      }
      expect(spawns).toBe(0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
