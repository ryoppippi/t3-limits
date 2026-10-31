import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { InputFailure } from "./errors.ts";

export function readJsonFile(
  path: string,
  message: string,
): Effect.Effect<unknown, InputFailure> {
  return Effect.flatMap(
    Effect.tryPromise({
      try: () => Bun.file(path).text(),
      catch: () => new InputFailure({ message }),
    }),
    (contents) =>
      Effect.mapError(
        Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
          contents,
        ),
        () => new InputFailure({ message }),
      ),
  );
}
