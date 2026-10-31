import { mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";

import * as Effect from "effect/Effect";

import { ProcessFailure, safeFailureMessage } from "../src/errors.ts";

const requiredFiles = [
  "providerUsageLimits.ts",
  "baseSchemas.ts",
  "providerInstance.ts",
  "usageLimitSourceId.ts",
] as const satisfies readonly string[];

const prepareContracts = Effect.gen(function* () {
  const command = Bun.which("nix");
  if (command === null) {
    return yield* new ProcessFailure({
      safeMessage: "Contract preparation requires Nix.",
    });
  }

  const sourcePath = yield* Effect.tryPromise({
    try: async () => {
      const child = Bun.spawn({
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
      });
      const [exitCode, output] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
      ]);
      if (exitCode !== 0) throw new Error("build failed");
      const path = output.trim();
      if (
        !path.startsWith("/nix/store/") ||
        path.includes("\n") ||
        !path.endsWith("-t3-contract-sources")
      ) {
        throw new Error("invalid build output");
      }
      return path;
    },
    catch: () =>
      new ProcessFailure({
        safeMessage: "Could not build the pinned T3 contract source subset.",
      }),
  });

  const sourceDirectory = join(
    import.meta.dir,
    "..",
    ".generated",
    "t3-contracts",
  );
  const sourceFiles = yield* Effect.tryPromise({
    try: async () => {
      const files = await Promise.all(
        requiredFiles.map(async (name) => {
          const file = Bun.file(join(sourcePath, name));
          if (!(await file.exists())) throw new Error("missing contract file");
          return [name, await file.text()] as const;
        }),
      );
      const license = Bun.file(join(sourcePath, "LICENSE"));
      if (!(await license.exists())) throw new Error("missing licence");
      return [...files, ["LICENSE", await license.text()] as const];
    },
    catch: () =>
      new ProcessFailure({
        safeMessage: "The pinned T3 contract source subset is incomplete.",
      }),
  });

  yield* Effect.tryPromise({
    try: async () => {
      await mkdir(sourceDirectory, { recursive: true });
      for (const [name, contents] of sourceFiles) {
        await Bun.write(join(sourceDirectory, name), contents);
      }

      const optionalSource = Bun.file(join(sourcePath, "secretReference.ts"));
      const optionalTarget = join(sourceDirectory, "secretReference.ts");
      if (await optionalSource.exists()) {
        await Bun.write(optionalTarget, await optionalSource.text());
      } else {
        try {
          await unlink(optionalTarget);
        } catch (error) {
          if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ENOENT"
          )
            return;
          throw error;
        }
      }
    },
    catch: () =>
      new ProcessFailure({
        safeMessage: "Could not write the generated T3 contract sources.",
      }),
  });
});

const program = Effect.matchEffect(prepareContracts, {
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
