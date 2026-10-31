import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
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

const BearerToken = Schema.Trim.check(Schema.isNonEmpty());

const IssuedToken = BearerToken.check(
  Schema.isPattern(/^[^\s\u0000-\u001f\u007f]+$/u),
);

const bearerToken =
  (emptyMessage: string) =>
  (token: string): Effect.Effect<string, AuthFailure> =>
    Effect.mapError(
      Schema.decodeUnknownEffect(BearerToken)(token),
      () => new AuthFailure({ message: emptyMessage }),
    );

export const readBearerToken = (input: {
  readonly origin: string;
  readonly tokenFile?: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly readFile: (path: string) => Promise<string>;
  readonly onMissing: (origin: string) => Effect.Effect<string, AppFailure>;
}): Effect.Effect<string, AppFailure> =>
  Effect.suspend(() =>
    Match.value({
      tokenFile: input.tokenFile,
      envToken: input.env.T3_LIMITS_TOKEN,
    }).pipe(
      Match.when({ tokenFile: Match.string }, ({ tokenFile }) =>
        Effect.tryPromise({
          try: () => input.readFile(tokenFile),
          catch: () =>
            new AuthFailure({ message: "The token file could not be read." }),
        }).pipe(Effect.flatMap(bearerToken("The token file is empty."))),
      ),
      Match.when({ envToken: Match.string }, ({ envToken }) =>
        bearerToken("T3_LIMITS_TOKEN is set but empty.")(envToken),
      ),
      Match.orElse(() =>
        Effect.flatMap(
          input.onMissing(input.origin),
          bearerToken("Authentication required: the token must not be empty."),
        ),
      ),
    ),
  );

export const issueScopedToken = Effect.fnUntraced(function* (input: {
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

  const text = yield* Effect.try({
    try: () =>
      new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(captured.chunks, captured.size),
      ),
    catch: () => new ProcessFailure({ message: TOKEN_ISSUE_FAILURE }),
  });
  return yield* Effect.mapError(
    Schema.decodeUnknownEffect(IssuedToken)(text),
    () => new ProcessFailure({ message: TOKEN_ISSUE_FAILURE }),
  );
}, Effect.scoped);
