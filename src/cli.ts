import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { cli, define, type CommandContext } from "gunshi";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import packageJson from "../package.json" with { type: "json" };
import guide from "../docs/guide.md" with { type: "text" };

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
import {
  projectUsageLimits,
  type UsageLimitReport,
  type UsageLimitRow,
} from "./limits.ts";
import {
  canonicalSecretOrigin,
  readUsageLimitStreams,
  webSocketUrl,
} from "./rpc.ts";

interface CliOptions {
  readonly json: boolean;
  readonly fixture?: string;
  readonly home?: string;
  readonly origin?: string;
  readonly tokenFile?: string;
}

function readJsonFile(
  path: string,
  safeMessage: string,
): Effect.Effect<unknown, InputFailure> {
  return Effect.tryPromise({
    try: async () => JSON.parse(await Bun.file(path).text()) as unknown,
    catch: () => new InputFailure({ safeMessage }),
  });
}

const FixtureSchema = Schema.Struct({
  providers: Schema.optional(Schema.Unknown),
  sources: Schema.optional(Schema.Unknown),
});

function fixtureReport(
  path: string,
): Effect.Effect<UsageLimitReport, InputFailure> {
  return Effect.gen(function* () {
    const fixture = yield* readJsonFile(
      path,
      "Could not read the usage-limits fixture.",
    );
    const decoded = yield* Effect.mapError(
      Schema.decodeUnknownEffect(FixtureSchema)(fixture),
      () =>
        new InputFailure({
          safeMessage: "The usage-limits fixture must be a JSON object.",
        }),
    );
    return yield* projectUsageLimits({
      providers: decoded.providers,
      sources: decoded.sources,
    });
  });
}

const RuntimeStateSchema = Schema.Struct({ origin: Schema.String });

function runtimeOrigin(
  home: string | undefined,
): Effect.Effect<string, InputFailure> {
  const statePath = join(
    home ?? homedir(),
    ".t3",
    "userdata",
    "server-runtime.json",
  );
  return Effect.gen(function* () {
    const runtime = yield* readJsonFile(
      statePath,
      "T3 server runtime state could not be read.",
    );
    const decoded = yield* Effect.mapError(
      Schema.decodeUnknownEffect(RuntimeStateSchema)(runtime),
      () =>
        new InputFailure({
          safeMessage:
            "T3 server runtime state does not contain a valid origin.",
        }),
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

function configuredT3Executable(
  value: string | undefined,
): Effect.Effect<string, CliFailure> {
  if (value === undefined) return Effect.succeed("t3");
  if (!isAbsolute(value)) {
    return Effect.fail(
      new CliFailure({
        safeMessage:
          "T3CODE_CLI_PATH must be a non-empty absolute executable path.",
      }),
    );
  }
  return Effect.succeed(value);
}

function liveReport(
  options: CliOptions,
  dependencies: CliDependencies,
): Effect.Effect<UsageLimitReport, AppFailure> {
  return Effect.gen(function* () {
    const origin = options.origin ?? (yield* runtimeOrigin(options.home));
    yield* webSocketUrl(origin, true);
    const token = yield* readBearerToken({
      origin,
      tokenFile: options.tokenFile,
      env: dependencies.env,
      secrets: dependencies.secrets,
      readFile: dependencies.readFile,
      onMissing: (missingOrigin) =>
        Effect.gen(function* () {
          if (options.origin !== undefined) {
            const discoveredOrigin = yield* runtimeOrigin(options.home);
            const missingName = yield* canonicalSecretOrigin(missingOrigin);
            const discoveredName =
              yield* canonicalSecretOrigin(discoveredOrigin);
            if (missingName !== discoveredName) {
              return yield* Effect.fail(
                new AuthFailure({
                  safeMessage:
                    "The --url override does not match the runtime server. Provide T3_LIMITS_TOKEN or --token-file to use this URL without automatic token setup.",
                }),
              );
            }
          }
          const executable = yield* configuredT3Executable(
            dependencies.env.T3CODE_CLI_PATH,
          );
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
      (dependencies.readUsageLimits ?? readUsageLimitStreams)({
        origin,
        token,
      }),
      () =>
        new RpcFailure({
          safeMessage:
            "Could not retrieve T3 usage limits. Check the server connection and credential; run `t3-limits auth login` to replace an expired stored token, or replace the supplied token.",
        }),
    );
    return yield* projectUsageLimits(data);
  });
}

function cleanText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ");
}

function formatRow(row: UsageLimitRow): string[] {
  const enabled =
    row.enabled === undefined ? "" : row.enabled ? " · enabled" : " · disabled";
  const checkedAt =
    row.checkedAt === undefined ? "" : ` · checked ${row.checkedAt}`;
  const lines = [
    `${cleanText(row.label)} (${cleanText(row.driver)} · ${cleanText(row.id)})${enabled}${checkedAt}`,
  ];
  if (row.unavailable)
    lines.push(`  unavailable: ${row.reason ?? "invalidSnapshot"}`);
  for (const window of row.windows) {
    const reset =
      window.resetsAt === undefined ? "" : ` · resets ${window.resetsAt}`;
    const duration =
      window.windowDurationMins === undefined
        ? ""
        : ` · ${window.windowDurationMins} min window`;
    lines.push(
      `  ${cleanText(window.label)}: ${window.usedPercent}% used · ${window.remainingPercent}% remaining${reset}${duration}`,
    );
  }
  return lines;
}

function printReport(
  report: UsageLimitReport,
  json: boolean,
): Effect.Effect<void> {
  return Effect.sync(() => {
    if (json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    console.log(`Usage limits retrieved at ${report.retrievedAt}`);
    if (report.providers.length === 0)
      console.log("No provider usage limits were reported.");
    for (const row of report.providers) {
      for (const line of formatRow(row)) console.log(line);
    }
    for (const notice of report.notices)
      console.log(`Notice: ${cleanText(notice)}`);
  });
}

interface AuthOptions {
  readonly command: "login" | "logout";
  readonly home?: string;
  readonly origin?: string;
  readonly t3Bin?: string;
}

type CliInvocation =
  | { readonly kind: "report"; readonly options: CliOptions }
  | { readonly kind: "auth"; readonly options: AuthOptions }
  | { readonly kind: "guide" };

function parserFailure(message: string): never {
  throw new CliFailure({ safeMessage: message });
}

function validateParsedArguments(ctx: Readonly<CommandContext>): void {
  if (ctx.values.help === true || ctx.values.version === true) return;

  if (
    ctx.callMode === "unexpected" ||
    ctx.positionals.length !== ctx.commandPath.length ||
    ctx.positionals.some((value, index) => value !== ctx.commandPath[index]) ||
    ctx.rest.length > 0 ||
    ctx.tokens.some((token) => token.kind === "option-terminator")
  ) {
    parserFailure(
      "Unexpected positional argument. Run --help to see the supported commands.",
    );
  }

  const optionNames = new Map<string, string>();
  const booleanOptions = new Set<string>();
  for (const [name, schema] of Object.entries(ctx.args)) {
    if (schema.type === "positional") continue;
    if (schema.type === "boolean") {
      booleanOptions.add(name);
      if (schema.short !== undefined) booleanOptions.add(schema.short);
      continue;
    }
    optionNames.set(name, name);
    if (schema.short !== undefined) optionNames.set(schema.short, name);
  }

  const seen = new Set<string>();
  for (const token of ctx.tokens) {
    if (token.kind !== "option" || token.name === undefined) continue;
    if (booleanOptions.has(token.name) && token.inlineValue === true) {
      parserFailure("Boolean options do not accept a value.");
    }
    const name = optionNames.get(token.name);
    if (name === undefined) continue;
    if (seen.has(name)) parserFailure(`--${name} can only be used once.`);
    seen.add(name);
    if (ctx.values[name] === undefined || ctx.values[name] === "")
      parserFailure(`Expected a value after --${name}.`);
  }
}

function createCommands(setInvocation: (invocation: CliInvocation) => void) {
  const report = define({
    name: packageJson.name,
    description: "Read usage limits from a running T3 Code server",
    args: {
      json: {
        type: "boolean",
        description: "Print an allowlisted JSON report",
      },
      fixture: {
        type: "string",
        description: "Read synthetic usage data from a JSON file",
        conflicts: ["home", "url", "token-file"],
      },
      url: {
        type: "string",
        description: "Connect to a loopback server origin",
      },
      home: {
        type: "string",
        description: "Use this OS home for runtime and auth state",
      },
      "token-file": {
        type: "string",
        description: "Read a bearer token from a file",
      },
      "help-for-agents": {
        type: "boolean",
        description: "Print the complete setup and usage guide",
      },
    },
    run: (ctx) => {
      if (ctx.values["help-for-agents"] === true) {
        setInvocation({ kind: "guide" });
        return;
      }
      const { fixture, home, url: origin } = ctx.values;
      const tokenFile = ctx.values["token-file"];
      setInvocation({
        kind: "report",
        options: {
          json: ctx.values.json === true,
          ...(fixture === undefined ? {} : { fixture }),
          ...(home === undefined ? {} : { home }),
          ...(origin === undefined ? {} : { origin }),
          ...(tokenFile === undefined ? {} : { tokenFile }),
        },
      });
    },
  });

  const login = define({
    name: "login",
    description: "Issue and store a scoped usage token",
    args: {
      home: {
        type: "string",
        description: "Use this OS home for runtime and auth state",
      },
      "t3-bin": { type: "string", description: "Path to the installed T3 CLI" },
    },
    run: (ctx) => {
      const { home } = ctx.values;
      const t3Bin = ctx.values["t3-bin"];
      setInvocation({
        kind: "auth",
        options: {
          command: "login",
          ...(home === undefined ? {} : { home }),
          ...(t3Bin === undefined ? {} : { t3Bin }),
        },
      });
    },
  });

  const logout = define({
    name: "logout",
    description: "Remove the local usage token",
    args: {
      home: {
        type: "string",
        description: "Use this OS home for runtime and auth state",
        conflicts: "url",
      },
      url: {
        type: "string",
        description: "Connect to a loopback server origin",
        conflicts: "home",
      },
    },
    run: (ctx) => {
      const { home, url: origin } = ctx.values;
      setInvocation({
        kind: "auth",
        options: {
          command: "logout",
          ...(home === undefined ? {} : { home }),
          ...(origin === undefined ? {} : { origin }),
        },
      });
    },
  });

  const auth = define({
    name: "auth",
    description: "Manage the local usage token",
    subCommands: { login, logout },
    run: () => parserFailure("Expected `auth login` or `auth logout`."),
  });

  return { report, auth };
}

function runAuth(
  options: AuthOptions,
  dependencies: CliDependencies,
): Effect.Effect<void, AppFailure> {
  return Effect.gen(function* () {
    const origin = options.origin ?? (yield* runtimeOrigin(options.home));
    const name = yield* canonicalSecretOrigin(origin);
    const secretKey = { service: TOKEN_SERVICE, name };
    if (options.command === "logout") {
      yield* Effect.tryPromise({
        try: () => dependencies.secrets.delete(secretKey),
        catch: () =>
          new AuthFailure({
            safeMessage:
              "Could not access the OS secret store to remove the local token. Ensure Bun 1.3+ and an available OS keychain (Linux: libsecret).",
          }),
      });
      yield* Effect.sync(() =>
        console.log(
          "Local token removed if present. Any issued server token remains valid until expiry.",
        ),
      );
      return;
    }

    const executable =
      options.t3Bin === undefined
        ? yield* configuredT3Executable(dependencies.env.T3CODE_CLI_PATH)
        : options.t3Bin;
    if (executable.trim().length === 0) {
      return yield* Effect.fail(
        new CliFailure({
          safeMessage:
            "T3CODE_CLI_PATH or --t3-bin must name the installed T3 CLI executable.",
        }),
      );
    }
    const baseDir = join(options.home ?? homedir(), ".t3");
    yield* issueAndStoreScopedToken({
      origin,
      executable,
      baseDir,
      secrets: dependencies.secrets,
      spawn: dependencies.spawn,
    });
    yield* Effect.sync(() =>
      console.log(`Scoped token stored for ${name}; it expires in one hour.`),
    );
  });
}

export function runCli(
  args: readonly string[],
  dependencies: CliDependencies = defaultDependencies,
): Effect.Effect<void, AppFailure> {
  return Effect.gen(function* () {
    let invocation: CliInvocation | undefined;
    const parsed = yield* Effect.tryPromise({
      try: async () => {
        const { report, auth } = createCommands((value) => {
          invocation = value;
        });
        const usage = await cli([...args], report, {
          name: packageJson.name,
          version: packageJson.version,
          description: "Read usage limits from a running T3 Code server",
          subCommands: { auth },
          fallbackToEntry: true,
          strict: true,
          usageSilent: true,
          renderHeader: async () => "",
          renderUsage: async () => guide,
          renderValidationErrors: async () => "",
          onBeforeCommand: validateParsedArguments,
        });
        if (usage !== undefined) {
          console.log(usage.trimEnd());
          return undefined;
        }
        if (invocation === undefined) {
          throw new CliFailure({
            safeMessage: "Expected `auth login` or `auth logout`.",
          });
        }
        return invocation;
      },
      catch: (error) =>
        isAppFailure(error)
          ? error
          : new CliFailure({
              safeMessage:
                "Invalid command-line arguments. Run --help to see the supported flags.",
            }),
    });

    if (parsed === undefined) return;
    if (parsed.kind === "guide") {
      console.log(guide.trimEnd());
      return;
    }
    if (parsed.kind === "auth") {
      yield* runAuth(parsed.options, dependencies);
      return;
    }
    const report =
      parsed.options.fixture === undefined
        ? yield* liveReport(parsed.options, dependencies)
        : yield* fixtureReport(parsed.options.fixture);
    yield* printReport(report, parsed.options.json);
  });
}

function isAppFailure(error: unknown): error is AppFailure {
  return (
    error instanceof InputFailure ||
    error instanceof AuthFailure ||
    error instanceof ProcessFailure ||
    error instanceof RpcFailure ||
    error instanceof CliFailure
  );
}

if (import.meta.main) {
  const reportFailure = (failure: AppFailure) =>
    Effect.sync(() => {
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
  await Effect.runPromise(
    Effect.catchDefect(program, () =>
      Effect.sync(() => {
        console.error("Error: The command failed unexpectedly.");
        process.exitCode = 1;
      }),
    ),
  );
}
