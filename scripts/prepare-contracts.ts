import { mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";

import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { acquireChildProcess } from "../src/child-process.ts";
import { ProcessFailure, safeFailureMessage } from "../src/errors.ts";

const requiredFiles = [
  "providerUsageLimits.ts",
  "baseSchemas.ts",
  "providerInstance.ts",
  "usageLimitSourceId.ts",
] as const satisfies readonly string[];

const preparationFailure = (message: string) => new ProcessFailure({ message });

const prepareContracts = Effect.fnUntraced(function* (): Effect.fn.Return<
  void,
  ProcessFailure,
  Scope.Scope
> {
  const command = Bun.which("nix");
  if (command === null) {
    return yield* preparationFailure("Contract preparation requires Nix.");
  }

  const managed = yield* acquireChildProcess(
    Effect.try({
      try: () =>
        Bun.spawn({
          cmd: [
            command,
            "build",
            ".#contract-sources",
            "--no-link",
            "--print-out-paths",
          ],
          cwd: join(import.meta.dir, ".."),
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
        }),
      catch: () =>
        preparationFailure(
          "Could not start the pinned T3 contract source build.",
        ),
    }),
    "SIGTERM",
  );

  const output = Stream.fromReadableStream({
    evaluate: () => managed.child.stdout,
    onError: () => preparationFailure("Could not read the Nix build output."),
    releaseLockOnEnd: true,
  }).pipe(
    Stream.runFold(
      () => "",
      (captured, chunk) => captured + new TextDecoder().decode(chunk),
    ),
  );
  const exitCode = Effect.tryPromise({
    try: () => managed.exited,
    catch: () => preparationFailure("The Nix contract source build failed."),
  });
  const [capturedOutput, status] = yield* Effect.all([output, exitCode], {
    concurrency: 2,
  });
  if (status !== 0) {
    return yield* preparationFailure(
      "Could not build the pinned T3 contract source subset.",
    );
  }
  const sourcePath = capturedOutput.trim();
  if (
    !sourcePath.startsWith("/nix/store/") ||
    sourcePath.includes("\n") ||
    !sourcePath.endsWith("-t3-contract-sources")
  ) {
    return yield* preparationFailure(
      "Could not build the pinned T3 contract source subset.",
    );
  }

  const sourceDirectory = join(
    import.meta.dir,
    "..",
    ".generated",
    "t3-contracts",
  );
  const files = yield* Effect.forEach(
    [...requiredFiles, "LICENSE"],
    (name) =>
      Effect.tryPromise({
        try: async () => {
          const file = Bun.file(join(sourcePath, name));
          if (!(await file.exists())) throw new Error("missing file");
          return [name, await file.text()] as const;
        },
        catch: () =>
          preparationFailure(
            "The pinned T3 contract source subset is incomplete.",
          ),
      }),
    { concurrency: 4 },
  );

  yield* Effect.tryPromise({
    try: () => mkdir(sourceDirectory, { recursive: true }),
    catch: () =>
      preparationFailure("Could not write the generated T3 contract sources."),
  });
  yield* Effect.forEach(
    files,
    ([name, contents]) =>
      Effect.tryPromise({
        try: () => Bun.write(join(sourceDirectory, name), contents),
        catch: () =>
          preparationFailure(
            "Could not write the generated T3 contract sources.",
          ),
      }),
    { concurrency: 4, discard: true },
  );

  const optionalSource = Bun.file(join(sourcePath, "secretReference.ts"));
  const optionalTarget = join(sourceDirectory, "secretReference.ts");
  if (
    yield* Effect.tryPromise({
      try: () => optionalSource.exists(),
      catch: () =>
        preparationFailure(
          "The pinned T3 contract source subset is incomplete.",
        ),
    })
  ) {
    const contents = yield* Effect.tryPromise({
      try: () => optionalSource.text(),
      catch: () =>
        preparationFailure(
          "The pinned T3 contract source subset is incomplete.",
        ),
    });
    yield* Effect.tryPromise({
      try: () => Bun.write(optionalTarget, contents),
      catch: () =>
        preparationFailure(
          "Could not write the generated T3 contract sources.",
        ),
    });
  } else if (
    yield* Effect.tryPromise({
      try: () => Bun.file(optionalTarget).exists(),
      catch: () =>
        preparationFailure(
          "Could not write the generated T3 contract sources.",
        ),
    })
  ) {
    yield* Effect.tryPromise({
      try: () => unlink(optionalTarget),
      catch: () =>
        preparationFailure(
          "Could not write the generated T3 contract sources.",
        ),
    });
  }
});

const program = Effect.matchEffect(Effect.scoped(prepareContracts()), {
  onSuccess: () =>
    Effect.sync(() =>
      console.log("Prepared the pinned T3 contract source subset."),
    ),
  onFailure: (failure) =>
    Effect.sync(() => {
      console.error(safeFailureMessage(failure));
      process.exitCode = 1;
    }),
});

await Effect.runPromise(
  Effect.catchDefect(program, () =>
    Effect.sync(() => {
      console.error("Contract preparation failed unexpectedly.");
      process.exitCode = 1;
    }),
  ),
);
