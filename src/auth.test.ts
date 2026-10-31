import { describe, expect, it } from "bun:test";
import * as Effect from "effect/Effect";

import {
  issueScopedToken,
  readBearerToken,
  SESSION_ISSUE_TIMEOUT_MS,
  TOKEN_LABEL,
  TOKEN_SCOPE,
  TOKEN_TTL,
} from "./auth.ts";

describe("token selection and scoped issuance", () => {
  it("uses a token file before the environment and never issues a replacement", async () => {
    let issued = 0;
    const token = await Effect.runPromise(
      readBearerToken({
        origin: "http://127.0.0.1:8318",
        tokenFile: "/token",
        env: { T3_LIMITS_TOKEN: "environment-token" },
        readFile: async () => " file-token\n",
        onMissing: () =>
          Effect.sync(() => {
            issued += 1;
            return "issued-token";
          }),
      }),
    );

    expect(token).toBe("file-token");
    expect(issued).toBe(0);
  });

  it("uses an explicit environment token without reading a file or issuing", async () => {
    let fileReads = 0;
    let issued = 0;
    const token = await Effect.runPromise(
      readBearerToken({
        origin: "http://127.0.0.1:8318",
        env: { T3_LIMITS_TOKEN: " environment-token " },
        readFile: async () => {
          fileReads += 1;
          return "unused";
        },
        onMissing: () =>
          Effect.sync(() => {
            issued += 1;
            return "issued-token";
          }),
      }),
    );

    expect(token).toBe("environment-token");
    expect(fileReads).toBe(0);
    expect(issued).toBe(0);
  });

  it("does not fall through from empty, unreadable, or invalid explicit credentials", async () => {
    let issued = 0;
    const onMissing = () =>
      Effect.sync(() => {
        issued += 1;
        return "issued-token";
      });

    await expect(
      Effect.runPromise(
        readBearerToken({
          origin: "http://127.0.0.1:8318",
          env: { T3_LIMITS_TOKEN: "  " },
          readFile: async () => "unused",
          onMissing,
        }),
      ),
    ).rejects.toThrow("T3_LIMITS_TOKEN is set but empty.");
    await expect(
      Effect.runPromise(
        readBearerToken({
          origin: "http://127.0.0.1:8318",
          tokenFile: "/missing",
          env: { T3_LIMITS_TOKEN: "environment-token" },
          readFile: async () => {
            throw new Error("private file detail");
          },
          onMissing,
        }),
      ),
    ).rejects.toThrow("The token file could not be read.");
    await expect(
      Effect.runPromise(
        readBearerToken({
          origin: "http://127.0.0.1:8318",
          tokenFile: "/empty",
          env: {},
          readFile: async () => "\n ",
          onMissing,
        }),
      ),
    ).rejects.toThrow("The token file is empty.");

    expect(issued).toBe(0);
  });

  it("issues the fixed scope and one-minute TTL with bounded token-only capture", async () => {
    let command: readonly string[] = [];
    let options:
      | {
          readonly stdin: "ignore";
          readonly stdout: "pipe";
          readonly stderr: "ignore";
        }
      | undefined;
    let killed = false;
    const token = await Effect.runPromise(
      issueScopedToken({
        executable: "/installed/t3",
        baseDir: "/home/user/.t3",
        spawn: (args, spawnOptions) => {
          command = args;
          options = spawnOptions;
          return {
            stdout:
              new Response("single-token\n").body ??
              new ReadableStream<Uint8Array>(),
            exited: Promise.resolve(0),
            kill: () => {
              killed = true;
            },
          };
        },
      }),
    );

    expect(token).toBe("single-token");
    expect(TOKEN_TTL).toBe("1m");
    expect(SESSION_ISSUE_TIMEOUT_MS).toBe(15_000);
    expect(command).toEqual([
      "/installed/t3",
      "auth",
      "session",
      "issue",
      "--base-dir",
      "/home/user/.t3",
      "--scope",
      TOKEN_SCOPE,
      "--ttl",
      "1m",
      "--label",
      TOKEN_LABEL,
      "--token-only",
    ]);
    expect(options).toEqual({
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    expect(killed).toBe(false);
  });

  it("rejects malformed or failed output without exposing subprocess details", async () => {
    const issue = (output: string, exitCode: number) =>
      Effect.runPromise(
        issueScopedToken({
          executable: "t3",
          baseDir: "/home/user/.t3",
          spawn: () => ({
            stdout:
              new Response(output).body ?? new ReadableStream<Uint8Array>(),
            exited: Promise.resolve(exitCode),
            kill: () => {},
          }),
        }),
      );

    await expect(issue("one\ntwo", 0)).rejects.toThrow(
      "T3 scoped token issuance failed or timed out",
    );
    await expect(issue("provider-error-secret", 1)).rejects.toThrow(
      "T3 scoped token issuance failed or timed out",
    );
  });

  it("kills issuance that exceeds its timeout", async () => {
    let killed = false;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    await expect(
      Effect.runPromise(
        issueScopedToken({
          executable: "t3",
          baseDir: "/home/user/.t3",
          timeoutMs: 5,
          spawn: () => ({
            stdout: new ReadableStream<Uint8Array>({
              start: (stream) => {
                controller = stream;
              },
            }),
            exited: new Promise<number>(() => {}),
            kill: () => {
              killed = true;
              controller?.close();
            },
          }),
        }),
      ),
    ).rejects.toThrow("T3 scoped token issuance failed or timed out");
    expect(killed).toBe(true);
  });
});
