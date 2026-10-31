import { describe, expect, it } from "bun:test";
import * as Exit from "effect/Exit";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";

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
    await expect(issue("", 0)).rejects.toThrow(
      "T3 scoped token issuance failed or timed out",
    );
  });

  it("redacts subprocess startup and credential file failures", async () => {
    const sentinel = "token-secret-sentinel-7f3d";
    const failures = await Promise.all([
      Effect.runPromise(
        issueScopedToken({
          executable: "t3",
          baseDir: "/home/user/.t3",
          spawn: () => {
            throw new Error(sentinel);
          },
        }),
      ).then(
        () => undefined,
        (failure: unknown) => failure,
      ),
      Effect.runPromise(
        readBearerToken({
          origin: "http://127.0.0.1:8318",
          tokenFile: "/token",
          env: {},
          readFile: async () => {
            throw new Error(sentinel);
          },
          onMissing: () => Effect.succeed("unused"),
        }),
      ).then(
        () => undefined,
        (failure: unknown) => failure,
      ),
    ]);

    for (const failure of failures) {
      expect(String(failure)).not.toContain(sentinel);
      expect(JSON.stringify(failure)).not.toContain(sentinel);
    }
  });

  it("bounds token output by UTF-8 bytes and rejects invalid UTF-8", async () => {
    const issueBytes = (bytes: Uint8Array) =>
      Effect.runPromise(
        issueScopedToken({
          executable: "t3",
          baseDir: "/home/user/.t3",
          spawn: () => ({
            stdout:
              new Response(new Uint8Array(bytes).buffer).body ??
              new ReadableStream<Uint8Array>(),
            exited: Promise.resolve(0),
            kill: () => {},
          }),
        }),
      );

    await expect(issueBytes(new Uint8Array(4097))).rejects.toThrow(
      "T3 scoped token issuance failed or timed out",
    );
    await expect(issueBytes(new Uint8Array([0xff]))).rejects.toThrow(
      "T3 scoped token issuance failed or timed out",
    );
  });

  it("kills the child and cancels stdout when the output bound is exceeded", async () => {
    let killed = false;
    let cancelled = false;
    await expect(
      Effect.runPromise(
        issueScopedToken({
          executable: "t3",
          baseDir: "/home/user/.t3",
          spawn: () => ({
            stdout: new ReadableStream<Uint8Array>({
              start: (controller) => controller.enqueue(new Uint8Array(4097)),
              cancel: () => {
                cancelled = true;
              },
            }),
            exited: new Promise<number>(() => {}),
            kill: () => {
              killed = true;
            },
          }),
        }),
      ),
    ).rejects.toThrow("T3 scoped token issuance failed or timed out");

    expect(killed).toBe(true);
    expect(cancelled).toBe(true);
  });

  it("kills issuance that exceeds its timeout", async () => {
    let killed = false;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const fiber = yield* issueScopedToken({
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
          }).pipe(Effect.forkChild);
          yield* TestClock.adjust("5 millis");
          return yield* Fiber.await(fiber);
        }),
        TestClock.layer(),
      ),
    );
    expect(Exit.isFailure(result)).toBe(true);
    expect(killed).toBe(true);
  });

  it("kills before starting stdout cancellation that never settles on timeout", async () => {
    const actions: string[] = [];
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const fiber = yield* issueScopedToken({
            executable: "t3",
            baseDir: "/home/user/.t3",
            timeoutMs: 5,
            spawn: () => ({
              stdout: new ReadableStream<Uint8Array>({
                pull: () => new Promise<void>(() => {}),
                cancel: () => {
                  actions.push("cancel");
                  return new Promise<void>(() => {});
                },
              }),
              exited: new Promise<number>(() => {}),
              kill: () => actions.push("kill"),
            }),
          }).pipe(Effect.forkChild);
          yield* TestClock.adjust("5 millis");
          return yield* Fiber.await(fiber);
        }),
        TestClock.layer(),
      ),
    );

    expect(Exit.isFailure(result)).toBe(true);
    expect(actions).toEqual(["kill", "cancel"]);
  });

  it("kills its child and cancels stdout when interrupted", async () => {
    let killed = false;
    let cancelled = false;
    let announceStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve;
    });
    const fiber = Effect.runFork(
      issueScopedToken({
        executable: "t3",
        baseDir: "/home/user/.t3",
        spawn: () => ({
          stdout: new ReadableStream<Uint8Array>({
            start: () => announceStarted?.(),
            cancel: () => {
              cancelled = true;
            },
          }),
          exited: new Promise<number>(() => {}),
          kill: () => {
            killed = true;
          },
        }),
      }),
    );

    await started;
    await Effect.runPromise(Fiber.interrupt(fiber));

    expect(killed).toBe(true);
    expect(cancelled).toBe(true);
  });

  it("finishes parent interruption when stdout cancellation never settles", async () => {
    const actions: string[] = [];
    let announceStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve;
    });
    const fiber = Effect.runFork(
      issueScopedToken({
        executable: "t3",
        baseDir: "/home/user/.t3",
        spawn: () => ({
          stdout: new ReadableStream<Uint8Array>({
            start: () => announceStarted?.(),
            cancel: () => {
              actions.push("cancel");
              return new Promise<void>(() => {});
            },
          }),
          exited: new Promise<number>(() => {}),
          kill: () => actions.push("kill"),
        }),
      }),
    );

    await started;
    await Effect.runPromise(Fiber.interrupt(fiber));

    expect(actions).toEqual(["kill", "cancel"]);
  });

  it("kills a child when its exit status cannot be observed without leaking failures", async () => {
    let killed = false;
    const failure = await Effect.runPromise(
      issueScopedToken({
        executable: "t3",
        baseDir: "/home/user/.t3",
        spawn: () => ({
          stdout: new ReadableStream<Uint8Array>({
            start: (controller) =>
              controller.error(new Error("private-output-sentinel")),
          }),
          exited: Promise.reject(new Error("private-exit-sentinel")),
          kill: () => {
            killed = true;
          },
        }),
      }),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    await Bun.sleep(0);
    expect(killed).toBe(true);
    expect(String(failure)).toContain(
      "T3 scoped token issuance failed or timed out.",
    );
    expect(String(failure)).not.toContain("private-");
    expect(JSON.stringify(failure)).not.toContain("private-");
  });

  it("kills a disposable Bun child on timeout while releasing stdout", async () => {
    let childExit: Promise<number> | undefined;
    let killed = false;
    await expect(
      Effect.runPromise(
        issueScopedToken({
          executable: "t3",
          baseDir: "/home/user/.t3",
          timeoutMs: 25,
          spawn: (_command, options) => {
            const child = Bun.spawn(
              [
                process.execPath,
                "-e",
                'process.stdout.write("partial"); setInterval(() => {}, 1000)',
              ],
              options,
            );
            if (!(child.stdout instanceof ReadableStream))
              throw new Error("Bun child stdout was not piped");
            childExit = child.exited;
            return {
              stdout: child.stdout,
              exited: child.exited,
              kill: (signal) => {
                killed = true;
                child?.kill(signal);
              },
            };
          },
        }),
      ),
    ).rejects.toThrow("T3 scoped token issuance failed or timed out.");

    expect(killed).toBe(true);
    expect(await childExit).toBeDefined();
  });
});
