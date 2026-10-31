import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { CliFailure, InputFailure } from "./errors.ts";
import { readJsonFile } from "./json-file.ts";

const RuntimeStateSchema = Schema.Struct({ origin: Schema.String });

export function t3Home(home: string | undefined): string {
  return home ?? homedir();
}

export function t3BaseDir(home: string | undefined): string {
  return join(t3Home(home), ".t3");
}

export const runtimeOrigin = Effect.fnUntraced(function* (
  home: string | undefined,
): Effect.fn.Return<string, InputFailure> {
  const statePath = join(
    t3Home(home),
    ".t3",
    "userdata",
    "server-runtime.json",
  );
  const runtime = yield* readJsonFile(
    statePath,
    "T3 server runtime state could not be read.",
  );
  const decoded = yield* Effect.mapError(
    Schema.decodeUnknownEffect(RuntimeStateSchema)(runtime),
    () =>
      new InputFailure({
        message: "T3 server runtime state does not contain a valid origin.",
      }),
  );
  return decoded.origin;
});

export function configuredT3Executable(
  value: string | undefined,
): Effect.Effect<string, CliFailure> {
  if (value === undefined) return Effect.succeed("t3");
  if (!isAbsolute(value)) {
    return Effect.fail(
      new CliFailure({
        message:
          "T3CODE_CLI_PATH must be a non-empty absolute executable path.",
      }),
    );
  }
  return Effect.succeed(value);
}
