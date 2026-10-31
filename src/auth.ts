import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import {
  acquireChildProcess,
  type ChildProcessWithOutput,
} from "./child-process.ts";
import { AuthFailure, ProcessFailure, type AppFailure } from "./errors.ts";

export const TOKEN_SCOPE = "orchestration:read";
export const TOKEN_TTL = "1m";
export const TOKEN_LABEL = "t3-limits";
export const SESSION_ISSUE_TIMEOUT_MS = 15_000;
const MAX_TOKEN_OUTPUT_BYTES = 4096;
const TOKEN_ISSUE_FAILURE = "T3 scoped token issuance failed or timed out.";

export interface SessionIssueChild extends ChildProcessWithOutput {}

export type SessionSpawn = (
  command: readonly string[],
  options: {
    readonly stdin: "ignore";
    readonly stdout: "pipe";
    readonly stderr: "ignore";
  },
) => SessionIssueChild;

export const readBearerToken = Effect.fnUntraced(function* (input: {
  readonly origin: string;
  readonly tokenFile?: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly readFile: (path: string) => Promise<string>;
  readonly onMissing: (origin: string) => Effect.Effect<string, AppFailure>;
}): Effect.fn.Return<string, AppFailure> {
  let token: string;
  if (input.tokenFile !== undefined) {
    const tokenFile = input.tokenFile;
    token = yield* Effect.tryPromise({
      try: () => input.readFile(tokenFile),
      catch: () =>
        new AuthFailure({ message: "The token file could not be read." }),
    });
    if (token.trim().length === 0) {
      return yield* new AuthFailure({ message: "The token file is empty." });
    }
  } else if (input.env.T3_LIMITS_TOKEN !== undefined) {
    token = input.env.T3_LIMITS_TOKEN;
    if (token.trim().length === 0) {
      return yield* new AuthFailure({
        message: "T3_LIMITS_TOKEN is set but empty.",
      });
    }
  } else {
    token = yield* input.onMissing(input.origin);
  }

  const trimmed = token.trim();
  if (trimmed.length === 0) {
    return yield* new AuthFailure({
      message: "Authentication required: the token must not be empty.",
    });
  }
  return trimmed;
});

const issueScopedTokenInScope = Effect.fnUntraced(function* (input: {
  readonly executable: string;
  readonly baseDir: string;
  readonly spawn: SessionSpawn;
  readonly timeoutMs?: number;
}): Effect.fn.Return<string, ProcessFailure, Scope.Scope> {
  const managed = yield* acquireChildProcess(
    Effect.try({
      try: () =>
        input.spawn(
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
        ),
      catch: () =>
        new ProcessFailure({
          message: "Could not start the T3 CLI for scoped token issuance.",
        }),
    }),
    "SIGKILL",
  );
  const output = Stream.fromReadableStream({
    evaluate: () => managed.child.stdout,
    onError: () => new ProcessFailure({ message: TOKEN_ISSUE_FAILURE }),
    releaseLockOnEnd: true,
  }).pipe(
    Stream.runFoldEffect(
      () => ({ chunks: [] as Uint8Array[], size: 0 }),
      (captured, chunk) => {
        const size = captured.size + chunk.byteLength;
        if (size > MAX_TOKEN_OUTPUT_BYTES) {
          return Effect.fail(
            new ProcessFailure({ message: TOKEN_ISSUE_FAILURE }),
          );
        }
        return Effect.succeed({
          chunks: [...captured.chunks, chunk],
          size,
        });
      },
    ),
  );
  const exitCode = Effect.tryPromise({
    try: () => managed.exited,
    catch: () => new ProcessFailure({ message: TOKEN_ISSUE_FAILURE }),
  });
  const [captured, status] = yield* Effect.timeoutOrElse(
    Effect.all([output, exitCode], { concurrency: 2 }),
    {
      duration: input.timeoutMs ?? SESSION_ISSUE_TIMEOUT_MS,
      orElse: () =>
        Effect.fail(new ProcessFailure({ message: TOKEN_ISSUE_FAILURE })),
    },
  );

  if (status !== 0) {
    return yield* new ProcessFailure({ message: TOKEN_ISSUE_FAILURE });
  }

  const bytes = new Uint8Array(captured.size);
  let offset = 0;
  for (const chunk of captured.chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const token = yield* Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim(),
    catch: () => new ProcessFailure({ message: TOKEN_ISSUE_FAILURE }),
  });
  if (token.length === 0 || /\s|[\u0000-\u001f\u007f]/u.test(token)) {
    return yield* new ProcessFailure({ message: TOKEN_ISSUE_FAILURE });
  }

  return token;
});

export const issueScopedToken = (input: {
  readonly executable: string;
  readonly baseDir: string;
  readonly spawn: SessionSpawn;
  readonly timeoutMs?: number;
}): Effect.Effect<string, ProcessFailure> =>
  Effect.scoped(issueScopedTokenInScope(input));
