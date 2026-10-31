import { describe, expect, it } from "bun:test";

import {
  canonicalSecretOrigin,
  issueScopedToken,
  issueAndStoreScopedToken,
  readBearerToken,
  TOKEN_LABEL,
  TOKEN_SCOPE,
  TOKEN_TTL,
  TOKEN_SERVICE,
  type SecretStore,
} from "./auth.ts";

function secrets(overrides: Partial<SecretStore> = {}): SecretStore {
  return {
    get: async () => null,
    set: async () => {},
    delete: async () => true,
    ...overrides,
  };
}

describe("scoped token helpers", () => {
  it("uses environment injection without consulting the secret store", async () => {
    const token = await readBearerToken({
      origin: "http://127.0.0.1:8318",
      env: { T3_LIMITS_TOKEN: " env-token " },
      secrets: secrets({ get: async () => { throw new Error("must not be called"); } }),
      readFile: async () => "unused",
    });

    expect(token).toBe("env-token");
  });

  it("does not fall through from an explicitly empty environment variable", async () => {
    let secretReads = 0;
    let issued = 0;
    await expect(readBearerToken({
      origin: "http://127.0.0.1:8318",
      env: { T3_LIMITS_TOKEN: "  " },
      secrets: secrets({ get: async () => { secretReads += 1; return "stored-token"; } }),
      readFile: async () => "unused",
      onMissing: async () => { issued += 1; return "new-token"; },
    })).rejects.toThrow("T3_LIMITS_TOKEN is set but empty.");
    expect(secretReads).toBe(0);
    expect(issued).toBe(0);
  });

  it("loads an explicit token file before environment and secret storage", async () => {
    let secretReads = 0;
    const token = await readBearerToken({
      origin: "http://127.0.0.1:8318",
      tokenFile: "/injected/token",
      env: { T3_LIMITS_TOKEN: "environment-token" },
      secrets: secrets({ get: async () => { secretReads += 1; return "stored-token"; } }),
      readFile: async (path) => path === "/injected/token" ? " file-token\n" : "",
    });

    expect(token).toBe("file-token");
    expect(secretReads).toBe(0);
  });

  it("calls onMissing only when the origin has no stored token", async () => {
    let issued = 0;
    const onMissing = async () => { issued += 1; return "new-token"; };
    const token = await readBearerToken({
      origin: "http://127.0.0.1:8318",
      env: {},
      secrets: secrets(),
      readFile: async () => "unused",
      onMissing,
    });

    expect(token).toBe("new-token");
    expect(issued).toBe(1);
    await expect(readBearerToken({
      origin: "http://127.0.0.1:8318",
      env: {},
      secrets: secrets({ get: async () => "expired-token" }),
      readFile: async () => "unused",
      onMissing,
    })).resolves.toBe("expired-token");
    expect(issued).toBe(1);
  });

  it("does not call onMissing when a token file or environment token is selected", async () => {
    let issued = 0;
    const onMissing = async () => { issued += 1; return "new-token"; };
    const read = (input: { readonly tokenFile?: string; readonly env: Readonly<Record<string, string | undefined>>; readonly readFile: (path: string) => Promise<string> }) => readBearerToken({
      origin: "http://127.0.0.1:8318",
      ...input,
      secrets: secrets({ get: async () => { throw new Error("must not read secrets"); } }),
      onMissing,
    });

    expect(await read({ tokenFile: "/token", env: { T3_LIMITS_TOKEN: "env-token" }, readFile: async () => "file-token" })).toBe("file-token");
    expect(await read({ env: { T3_LIMITS_TOKEN: "env-token" }, readFile: async () => "unused" })).toBe("env-token");
    await expect(read({ tokenFile: "/empty-token", env: {}, readFile: async () => " " })).rejects.toThrow("Authentication required");
    expect(issued).toBe(0);
  });

  it("sanitises secret-store errors and binds equivalent URL forms to one origin", async () => {
    await expect(readBearerToken({
      origin: "http://localhost:80",
      env: {},
      secrets: secrets({ get: async () => { throw new Error("secret-value must not leak"); } }),
      readFile: async () => "unused",
    })).rejects.toThrow("Could not access the OS secret store.");
    expect(canonicalSecretOrigin("http://localhost:80")).toBe("http://localhost");
    expect(canonicalSecretOrigin("ws://localhost/")).toBe("http://localhost");
    expect(canonicalSecretOrigin("https://localhost:443")).toBe("https://localhost");
    expect(canonicalSecretOrigin("http://127.0.0.1:8318")).not.toBe("http://localhost");
  });

  it("issues only the fixed scope and TTL, capturing a single token from stdout", async () => {
    let issuedCommand: readonly string[] = [];
    let spawnOptions: { readonly stdin: "ignore"; readonly stdout: "pipe"; readonly stderr: "ignore" } | undefined;
    const token = await issueScopedToken({
      executable: "/installed/t3",
      baseDir: "/home/user/.t3",
      spawn: (command, options) => {
        issuedCommand = command;
        spawnOptions = options;
        return {
          stdout: new Response("single-token\n").body ?? new ReadableStream<Uint8Array>(),
          exited: Promise.resolve(0),
          kill: () => {},
        };
      },
    });

    expect(token).toBe("single-token");
    expect(issuedCommand).toEqual([
      "/installed/t3", "auth", "session", "issue",
      "--base-dir", "/home/user/.t3",
      "--scope", TOKEN_SCOPE,
      "--ttl", TOKEN_TTL,
      "--label", TOKEN_LABEL,
      "--token-only",
    ]);
    expect(spawnOptions).toEqual({ stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    expect(TOKEN_SERVICE).toBe("com.ryoppippi.t3-limits");
  });

  it("stores an issued token by canonical origin", async () => {
    let stored: { readonly service: string; readonly name: string; readonly value: string } | undefined;
    await issueAndStoreScopedToken({
      origin: "ws://localhost:8318/",
      executable: "t3",
      baseDir: "/home/user/.t3",
      secrets: secrets({ set: async (secret) => { stored = secret; } }),
      spawn: () => ({
        stdout: new Response("stored-token").body ?? new ReadableStream<Uint8Array>(),
        exited: Promise.resolve(0),
        kill: () => {},
      }),
    });
    expect(stored).toEqual({ service: TOKEN_SERVICE, name: "http://localhost:8318", value: "stored-token" });
  });

  it("rejects multiline or failed issuance without exposing subprocess output", async () => {
    const spawn = (output: string, exitCode: number) => async () => issueScopedToken({
      executable: "t3",
      baseDir: "/home/user/.t3",
      spawn: () => ({
        stdout: new Response(output).body ?? new ReadableStream<Uint8Array>(),
        exited: Promise.resolve(exitCode),
        kill: () => {},
      }),
    });

    await expect(spawn("one\ntwo", 0)()).rejects.toThrow("T3 scoped token issuance failed or timed out");
    await expect(spawn("provider-error-secret", 1)()).rejects.toThrow("T3 scoped token issuance failed or timed out");
  });

  it("kills a session issuance process that exceeds its timeout", async () => {
    let killed = false;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    await expect(issueScopedToken({
      executable: "t3",
      baseDir: "/home/user/.t3",
      timeoutMs: 5,
      spawn: () => ({
        stdout: new ReadableStream<Uint8Array>({ start: (stream) => { controller = stream; } }),
        exited: new Promise<number>(() => {}),
        kill: () => { killed = true; controller?.close(); },
      }),
    })).rejects.toThrow("T3 scoped token issuance failed or timed out");
    expect(killed).toBe(true);
  });
});
