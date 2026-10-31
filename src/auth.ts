import * as Effect from "effect/Effect";

import { AuthFailure, ProcessFailure, type AppFailure } from "./errors.ts";

export const TOKEN_SCOPE = "orchestration:read";
export const TOKEN_TTL = "1m";
export const TOKEN_LABEL = "t3-limits";
export const SESSION_ISSUE_TIMEOUT_MS = 15_000;
const MAX_TOKEN_OUTPUT_BYTES = 4096;

export interface SessionIssueChild {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  kill(signal?: "SIGKILL"): void;
}

export type SessionSpawn = (
  command: readonly string[],
  options: {
    readonly stdin: "ignore";
    readonly stdout: "pipe";
    readonly stderr: "ignore";
  },
) => SessionIssueChild;

export function readBearerToken(input: {
  readonly origin: string;
  readonly tokenFile?: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly readFile: (path: string) => Promise<string>;
  readonly onMissing: (origin: string) => Effect.Effect<string, AppFailure>;
}): Effect.Effect<string, AppFailure> {
  return Effect.gen(function* () {
    let token: string;
    if (input.tokenFile !== undefined) {
      const tokenFile = input.tokenFile;
      token = yield* Effect.tryPromise({
        try: () => input.readFile(tokenFile),
        catch: () =>
          new AuthFailure({ safeMessage: "The token file could not be read." }),
      });
      if (token.trim().length === 0) {
        return yield* Effect.fail(
          new AuthFailure({ safeMessage: "The token file is empty." }),
        );
      }
    } else if (input.env.T3_LIMITS_TOKEN !== undefined) {
      token = input.env.T3_LIMITS_TOKEN;
      if (token.trim().length === 0) {
        return yield* Effect.fail(
          new AuthFailure({ safeMessage: "T3_LIMITS_TOKEN is set but empty." }),
        );
      }
    } else {
      token = yield* input.onMissing(input.origin);
    }

    const trimmed = token.trim();
    if (trimmed.length === 0) {
      return yield* Effect.fail(
        new AuthFailure({
          safeMessage: "Authentication required: the token must not be empty.",
        }),
      );
    }
    return trimmed;
  });
}

export function issueScopedToken(input: {
  readonly executable: string;
  readonly baseDir: string;
  readonly spawn: SessionSpawn;
  readonly timeoutMs?: number;
}): Effect.Effect<string, ProcessFailure> {
  return Effect.callback<string, ProcessFailure>((resume) => {
    let child: SessionIssueChild;
    try {
      child = input.spawn(
        [
          input.executable,
          "auth",
          "session",
          "issue",
          "--base-dir",
          input.baseDir,
          "--scope",
          TOKEN_SCOPE,
          "--ttl",
          TOKEN_TTL,
          "--label",
          TOKEN_LABEL,
          "--token-only",
        ],
        { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
      );
    } catch {
      resume(
        Effect.fail(
          new ProcessFailure({
            safeMessage:
              "Could not start the T3 CLI for scoped token issuance.",
          }),
        ),
      );
      return;
    }

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reader = child.stdout.getReader();
    const kill = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The process may have exited before cancellation reached it.
      }
    };
    const cancelOutput = () => {
      void reader.cancel().catch(() => {});
    };
    const finish = (token?: string) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (token === undefined) {
        kill();
        cancelOutput();
        resume(
          Effect.fail(
            new ProcessFailure({
              safeMessage: "T3 scoped token issuance failed or timed out.",
            }),
          ),
        );
      } else {
        resume(Effect.succeed(token));
      }
    };

    timer = setTimeout(
      () => finish(),
      input.timeoutMs ?? SESSION_ISSUE_TIMEOUT_MS,
    );
    void (async () => {
      try {
        const chunks: Uint8Array[] = [];
        let size = 0;
        const readOutput = async () => {
          while (true) {
            const { done, value } = await reader.read();
            if (done) return;
            size += value.byteLength;
            if (size > MAX_TOKEN_OUTPUT_BYTES) throw new Error("output");
            chunks.push(value);
          }
        };
        const [, status] = await Promise.all([readOutput(), child.exited]);
        if (status !== 0) return finish();
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const token = new TextDecoder("utf-8", { fatal: true })
          .decode(bytes)
          .trim();
        if (token.length === 0 || /\s|[\u0000-\u001f\u007f]/u.test(token))
          return finish();
        finish(token);
      } catch {
        finish();
      }
    })();

    return Effect.sync(() => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      kill();
      cancelOutput();
    });
  });
}
