import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  issueAndStoreScopedToken,
  readBearerToken,
  TOKEN_SERVICE,
  type SecretStore,
  type SessionSpawn,
} from "./auth.ts";
import {
  AuthFailure,
  CliFailure,
  InputFailure,
  ProcessFailure,
  RpcFailure,
  safeFailureMessage,
  type AppFailure,
} from "./errors.ts";
import { projectUsageLimits, type UsageLimitReport, type UsageLimitRow } from "./limits.ts";
import { canonicalSecretOrigin, readUsageLimitStreams, webSocketUrl } from "./rpc.ts";

interface CliOptions {
  readonly help: boolean;
  readonly json: boolean;
  readonly fixture?: string;
  readonly home?: string;
  readonly origin?: string;
  readonly tokenFile?: string;
}

function failure(message: string): never {
  throw new CliFailure({ safeMessage: message });
}

function parseArgs(args: readonly string[]): CliOptions {
  let help = false;
  let json = false;
  let fixture: string | undefined;
  let home: string | undefined;
  let origin: string | undefined;
  let tokenFile: string | undefined;

  const takeValue = (flag: string, index: number): string => {
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) failure(`Expected a value after ${flag}.`);
    return value;
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case "--help":
      case "-h":
        help = true;
        break;
      case "--json":
        json = true;
        break;
      case "--fixture":
        if (fixture !== undefined) failure("--fixture can only be used once.");
        fixture = takeValue(argument, index);
        index += 1;
        break;
      case "--home":
        if (home !== undefined) failure("--home can only be used once.");
        home = takeValue(argument, index);
        index += 1;
        break;
      case "--url":
        if (origin !== undefined) failure("--url can only be used once.");
        origin = takeValue(argument, index);
        index += 1;
        break;
      case "--token-file":
        if (tokenFile !== undefined) failure("--token-file can only be used once.");
        tokenFile = takeValue(argument, index);
        index += 1;
        break;
      default:
        failure("Unknown option. Run --help to see the supported flags.");
    }
  }

  if (fixture !== undefined && (home !== undefined || origin !== undefined || tokenFile !== undefined)) {
    failure("--fixture cannot be combined with connection options.");
  }
  return {
    help,
    json,
    ...(fixture === undefined ? {} : { fixture }),
    ...(home === undefined ? {} : { home }),
    ...(origin === undefined ? {} : { origin }),
    ...(tokenFile === undefined ? {} : { tokenFile }),
  };
}

function parseWithSafeFailure<A>(parse: () => A): Effect.Effect<A, CliFailure> {
  return Effect.try({
    try: parse,
    catch: (error) => error instanceof CliFailure
      ? error
      : new CliFailure({ safeMessage: "Invalid command-line arguments." }),
  });
}

function readJsonFile(path: string, safeMessage: string): Effect.Effect<unknown, InputFailure> {
  return Effect.tryPromise({
    try: async () => JSON.parse(await Bun.file(path).text()) as unknown,
    catch: () => new InputFailure({ safeMessage }),
  });
}

const FixtureSchema = Schema.Struct({
  providers: Schema.optional(Schema.Unknown),
  sources: Schema.optional(Schema.Unknown),
});

function fixtureReport(path: string): Effect.Effect<UsageLimitReport, InputFailure> {
  return Effect.gen(function*() {
    const fixture = yield* readJsonFile(path, "Could not read the usage-limits fixture.");
    const decoded = yield* Effect.mapError(
      Schema.decodeUnknownEffect(FixtureSchema)(fixture),
      () => new InputFailure({ safeMessage: "The usage-limits fixture must be a JSON object." }),
    );
    return yield* projectUsageLimits({ providers: decoded.providers, sources: decoded.sources });
  });
}

const RuntimeStateSchema = Schema.Struct({ origin: Schema.String });

function runtimeOrigin(home: string | undefined): Effect.Effect<string, InputFailure> {
  const statePath = join(home ?? homedir(), ".t3", "userdata", "server-runtime.json");
  return Effect.gen(function*() {
    const runtime = yield* readJsonFile(statePath, "T3 server runtime state could not be read.");
    const decoded = yield* Effect.mapError(
      Schema.decodeUnknownEffect(RuntimeStateSchema)(runtime),
      () => new InputFailure({ safeMessage: "T3 server runtime state does not contain a valid origin." }),
    );
    return decoded.origin;
  });
}

interface CliDependencies {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly secrets: SecretStore;
  readonly readFile: (path: string) => Promise<string>;
  readonly spawn: SessionSpawn;
  readonly readUsageLimits?: typeof readUsageLimitStreams;
}

const defaultDependencies: CliDependencies = {
  env: Bun.env,
  secrets: Bun.secrets,
  readFile: (path) => Bun.file(path).text(),
  spawn: (command, options) => Bun.spawn([...command], options),
};

function configuredT3Executable(value: string | undefined): Effect.Effect<string, CliFailure> {
  if (value === undefined) return Effect.succeed("t3");
  if (!isAbsolute(value)) {
    return Effect.fail(new CliFailure({ safeMessage: "T3CODE_CLI_PATH must be a non-empty absolute executable path." }));
  }
  return Effect.succeed(value);
}

function liveReport(options: CliOptions, dependencies: CliDependencies): Effect.Effect<UsageLimitReport, AppFailure> {
  return Effect.gen(function*() {
    const origin = options.origin ?? (yield* runtimeOrigin(options.home));
    yield* webSocketUrl(origin, true);
    const token = yield* readBearerToken({
      origin,
      tokenFile: options.tokenFile,
      env: dependencies.env,
      secrets: dependencies.secrets,
      readFile: dependencies.readFile,
      onMissing: (missingOrigin) => Effect.gen(function*() {
        if (options.origin !== undefined) {
          const discoveredOrigin = yield* runtimeOrigin(options.home);
          const missingName = yield* canonicalSecretOrigin(missingOrigin);
          const discoveredName = yield* canonicalSecretOrigin(discoveredOrigin);
          if (missingName !== discoveredName) {
            return yield* Effect.fail(new AuthFailure({
              safeMessage: "The --url override does not match the runtime server. Provide T3_LIMITS_TOKEN or --token-file to use this URL without automatic token setup.",
            }));
          }
        }
        const executable = yield* configuredT3Executable(dependencies.env.T3CODE_CLI_PATH);
        return yield* issueAndStoreScopedToken({
          origin: missingOrigin,
          executable,
          baseDir: join(options.home ?? homedir(), ".t3"),
          secrets: dependencies.secrets,
          spawn: dependencies.spawn,
        });
      }),
    });
    const data = yield* Effect.mapError(
      (dependencies.readUsageLimits ?? readUsageLimitStreams)({ origin, token }),
      () => new RpcFailure({
        safeMessage: "Could not retrieve T3 usage limits. Check the server connection and credential; run `t3-limits auth login` to replace an expired stored token, or replace the supplied token.",
      }),
    );
    return yield* projectUsageLimits(data);
  });
}

function cleanText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ");
}

function formatRow(row: UsageLimitRow): string[] {
  const enabled = row.enabled === undefined ? "" : row.enabled ? " · enabled" : " · disabled";
  const checkedAt = row.checkedAt === undefined ? "" : ` · checked ${row.checkedAt}`;
  const lines = [`${cleanText(row.label)} (${cleanText(row.driver)} · ${cleanText(row.id)})${enabled}${checkedAt}`];
  if (row.unavailable) lines.push(`  unavailable: ${row.reason ?? "invalidSnapshot"}`);
  for (const window of row.windows) {
    const reset = window.resetsAt === undefined ? "" : ` · resets ${window.resetsAt}`;
    const duration = window.windowDurationMins === undefined
      ? ""
      : ` · ${window.windowDurationMins} min window`;
    lines.push(
      `  ${cleanText(window.label)}: ${window.usedPercent}% used · ${window.remainingPercent}% remaining${reset}${duration}`,
    );
  }
  return lines;
}

function printReport(report: UsageLimitReport, json: boolean): Effect.Effect<void> {
  return Effect.sync(() => {
    if (json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    console.log(`Usage limits retrieved at ${report.retrievedAt}`);
    if (report.providers.length === 0) console.log("No provider usage limits were reported.");
    for (const row of report.providers) {
      for (const line of formatRow(row)) console.log(line);
    }
    for (const notice of report.notices) console.log(`Notice: ${cleanText(notice)}`);
  });
}

const HELP = `t3-limits — read usage limits from a running T3 Code server

Usage:
  t3-limits [--json] [--url <loopback-origin>] [--home <home-directory>]
            [--token-file <path>]
  t3-limits --fixture <path> [--json]
  t3-limits auth login [--home <home-directory>] [--t3-bin <path>]
  t3-limits auth logout [--home <home-directory> | --url <loopback-origin>]

Options:
  --json               Print an allowlisted JSON report.
  --url <origin>       Connect to a loopback server origin.
  --home <directory>   Use this OS home for <home>/.t3 runtime and auth state.
  --token-file <path>  Read a bearer token; otherwise use T3_LIMITS_TOKEN or the OS secret store.
  --fixture <path>     Read synthetic { providers, sources } data without connecting.
  -h, --help           Show this help.
`;

const AUTH_HELP = `Usage:
  t3-limits auth login [--home <home-directory>] [--t3-bin <path>]
  t3-limits auth logout [--home <home-directory> | --url <loopback-origin>]

login issues a one-hour orchestration:read token and stores it in the OS secret store.
logout removes only the local token; it does not revoke the server session.
`;

interface AuthOptions {
  readonly command: "login" | "logout";
  readonly home?: string;
  readonly origin?: string;
  readonly t3Bin?: string;
}

function parseAuthArgs(args: readonly string[]): AuthOptions | "help" {
  const command = args[0];
  if (args.length === 2 && (command === "login" || command === "logout") && (args[1] === "--help" || args[1] === "-h")) return "help";
  if (args.length === 1 && (command === "--help" || command === "-h")) return "help";
  if (command !== "login" && command !== "logout") failure("Expected `auth login` or `auth logout`.");
  let home: string | undefined;
  let origin: string | undefined;
  let t3Bin: string | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) failure("Expected an option value.");
    if (flag === "--home") {
      if (home !== undefined) failure("--home can only be used once.");
      home = value;
    } else if (flag === "--url") {
      if (origin !== undefined) failure("--url can only be used once.");
      origin = value;
    } else if (flag === "--t3-bin") {
      if (t3Bin !== undefined) failure("--t3-bin can only be used once.");
      t3Bin = value;
    } else {
      failure("Unknown auth option. Run `t3-limits auth --help` to see supported options.");
    }
    index += 1;
  }
  if (home !== undefined && origin !== undefined) failure("Use either --home or --url, not both.");
  if (command === "login" && origin !== undefined) failure("auth login discovers the server origin from runtime state; --url is not supported.");
  if (command === "logout" && t3Bin !== undefined) failure("--t3-bin is only supported by auth login.");
  return { command, ...(home === undefined ? {} : { home }), ...(origin === undefined ? {} : { origin }), ...(t3Bin === undefined ? {} : { t3Bin }) };
}

function runAuth(args: readonly string[], dependencies: CliDependencies): Effect.Effect<void, AppFailure> {
  return Effect.gen(function*() {
    const options = yield* parseWithSafeFailure(() => parseAuthArgs(args));
    if (options === "help") {
      yield* Effect.sync(() => console.log(AUTH_HELP));
      return;
    }
    const origin = options.origin ?? (yield* runtimeOrigin(options.home));
    const name = yield* canonicalSecretOrigin(origin);
    const secretKey = { service: TOKEN_SERVICE, name };
    if (options.command === "logout") {
      yield* Effect.tryPromise({
        try: () => dependencies.secrets.delete(secretKey),
        catch: () => new AuthFailure({
          safeMessage: "Could not access the OS secret store to remove the local token. Ensure Bun 1.3+ and an available OS keychain (Linux: libsecret).",
        }),
      });
      yield* Effect.sync(() => console.log("Local token removed if present. Any issued server token remains valid until expiry."));
      return;
    }

    const executable = options.t3Bin === undefined
      ? yield* configuredT3Executable(dependencies.env.T3CODE_CLI_PATH)
      : options.t3Bin;
    if (executable.trim().length === 0) {
      return yield* Effect.fail(new CliFailure({ safeMessage: "T3CODE_CLI_PATH or --t3-bin must name the installed T3 CLI executable." }));
    }
    const baseDir = join(options.home ?? homedir(), ".t3");
    yield* issueAndStoreScopedToken({ origin, executable, baseDir, secrets: dependencies.secrets, spawn: dependencies.spawn });
    yield* Effect.sync(() => console.log(`Scoped token stored for ${name}; it expires in one hour.`));
  });
}

export function runCli(args: readonly string[], dependencies: CliDependencies = defaultDependencies): Effect.Effect<void, AppFailure> {
  return Effect.gen(function*() {
    if (args[0] === "auth") {
      yield* runAuth(args.slice(1), dependencies);
      return;
    }
    const options = yield* parseWithSafeFailure(() => parseArgs(args));
    if (options.help) {
      yield* Effect.sync(() => console.log(HELP));
      return;
    }
    const report = options.fixture === undefined
      ? yield* liveReport(options, dependencies)
      : yield* fixtureReport(options.fixture);
    yield* printReport(report, options.json);
  });
}

if (import.meta.main) {
  const reportFailure = (failure: AppFailure) => Effect.sync(() => {
    console.error(`Error: ${safeFailureMessage(failure)}`);
    process.exitCode = 1;
  });
  const program = Effect.catchTags(runCli(Bun.argv.slice(2)), {
    InputFailure: reportFailure,
    AuthFailure: reportFailure,
    ProcessFailure: reportFailure,
    RpcFailure: reportFailure,
    CliFailure: reportFailure,
  });
  await Effect.runPromise(Effect.catchDefect(program, () => Effect.sync(() => {
    console.error("Error: The command failed unexpectedly.");
    process.exitCode = 1;
  })));
}
