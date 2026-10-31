import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  issueScopedToken,
  readBearerToken,
  type SessionSpawn,
} from "./auth.ts";
import {
  AuthFailure,
  InputFailure,
  RpcFailure,
  type AppFailure,
} from "./errors.ts";
import { readJsonFile } from "./json-file.ts";
import { projectUsageLimits, type UsageLimitReport } from "./limits.ts";
import {
  canonicalLoopbackOrigin,
  readUsageLimitStreams,
  webSocketUrl,
} from "./rpc.ts";
import {
  configuredT3Executable,
  runtimeOrigin,
  t3BaseDir,
} from "./t3-runtime.ts";

export interface UsageReportOptions {
  readonly fixture?: string;
  readonly home?: string;
  readonly origin?: string;
  readonly tokenFile?: string;
}

export interface UsageReportDependencies {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly readFile: (path: string) => Promise<string>;
  readonly spawn: SessionSpawn;
  readonly readUsageLimits?: typeof readUsageLimitStreams;
}

export const defaultUsageReportDependencies: UsageReportDependencies = {
  env: Bun.env,
  readFile: (path) => Bun.file(path).text(),
  spawn: (command, options) => Bun.spawn([...command], options),
};

const FixtureSchema = Schema.Struct({
  providers: Schema.optional(Schema.Unknown),
  sources: Schema.optional(Schema.Unknown),
});

const fixtureReport = Effect.fnUntraced(function* (
  path: string,
): Effect.fn.Return<UsageLimitReport, InputFailure> {
  const fixture = yield* readJsonFile(
    path,
    "Could not read the usage-limits fixture.",
  );
  const decoded = yield* Effect.mapError(
    Schema.decodeUnknownEffect(FixtureSchema)(fixture),
    () =>
      new InputFailure({
        message: "The usage-limits fixture must be a JSON object.",
      }),
  );
  return yield* projectUsageLimits({
    providers: decoded.providers,
    sources: decoded.sources,
  });
});

const liveReport = Effect.fnUntraced(function* (
  options: UsageReportOptions,
  dependencies: UsageReportDependencies,
): Effect.fn.Return<UsageLimitReport, AppFailure> {
  const origin = options.origin ?? (yield* runtimeOrigin(options.home));
  yield* webSocketUrl(origin, true);
  const token = yield* readBearerToken({
    origin,
    tokenFile: options.tokenFile,
    env: dependencies.env,
    readFile: dependencies.readFile,
    onMissing: (missingOrigin) =>
      Effect.gen(function* () {
        if (options.origin !== undefined) {
          const discoveredOrigin = yield* runtimeOrigin(options.home);
          const missingName = yield* canonicalLoopbackOrigin(missingOrigin);
          const discoveredName =
            yield* canonicalLoopbackOrigin(discoveredOrigin);
          if (missingName !== discoveredName) {
            return yield* new AuthFailure({
              message:
                "The --url override does not match the runtime server. Provide T3_LIMITS_TOKEN or --token-file to use this URL without automatic token setup.",
            });
          }
        }
        const executable = yield* configuredT3Executable(
          dependencies.env.T3CODE_CLI_PATH,
        );
        return yield* issueScopedToken({
          executable,
          baseDir: t3BaseDir(options.home),
          spawn: dependencies.spawn,
        });
      }),
  });
  const data = yield* Effect.mapError(
    (dependencies.readUsageLimits ?? readUsageLimitStreams)({
      origin,
      token,
    }),
    () =>
      new RpcFailure({
        message:
          "Could not retrieve T3 usage limits. Check the server connection and supplied credential.",
      }),
  );
  return yield* projectUsageLimits(data);
});

export const readUsageReport = Effect.fnUntraced(function* (
  options: UsageReportOptions,
  dependencies: UsageReportDependencies,
): Effect.fn.Return<UsageLimitReport, AppFailure> {
  if (options.fixture !== undefined)
    return yield* fixtureReport(options.fixture);
  return yield* liveReport(options, dependencies);
});
