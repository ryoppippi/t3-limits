import { cli, define, type CommandContext } from "gunshi";
import { getAgentProfile } from "gunshi/agent";
import { string } from "gunshi/combinators";
import * as Effect from "effect/Effect";
import packageJson from "../package.json" with { type: "json" };
import guide from "../docs/guide.md" with { type: "text" };

import {
  CliFailure,
  isAppFailure,
  safeFailureMessage,
  type AppFailure,
} from "./errors.ts";
import { printUsageReport, reportOutputMode } from "./report-output.ts";
import {
  defaultUsageReportDependencies,
  readUsageReport,
  type UsageReportDependencies,
  type UsageReportOptions,
} from "./usage-report.ts";

interface CliOptions extends UsageReportOptions {
  readonly json: boolean;
}

type CliInvocation =
  | { readonly kind: "report"; readonly options: CliOptions }
  | { readonly kind: "guide" };

function parserFailure(message: string): never {
  throw new CliFailure({ message: message });
}

function rejectUnsupportedCliSyntax(ctx: Readonly<CommandContext>): void {
  if (ctx.values.help === true || ctx.values.version === true) return;

  if (
    ctx.positionals.length > 0 ||
    ctx.rest.length > 0 ||
    ctx.tokens.some((token) => token.kind === "option-terminator")
  ) {
    parserFailure(
      "Unexpected positional argument. Run --help to see the supported commands.",
    );
  }

  const seen = new Set<string>();
  for (const token of ctx.tokens) {
    if (token.kind !== "option" || token.name === undefined) continue;
    const schema = ctx.args[token.name];
    if (schema === undefined) continue;
    if (schema.type === "boolean" && token.inlineValue === true) {
      parserFailure("Boolean options do not accept a value.");
    }
    if (schema.type !== "string") continue;
    if (seen.has(token.name))
      parserFailure(`--${token.name} can only be used once.`);
    seen.add(token.name);
  }
}

function createCommands(setInvocation: (invocation: CliInvocation) => void) {
  const report = define({
    name: packageJson.name,
    description: "Read usage limits from a running T3 Code server",
    args: {
      json: {
        type: "boolean",
        description: "Print allowlisted JSON instead of the readable report",
      },
      fixture: {
        ...string({
          minLength: 1,
          description: "Read synthetic usage data from a JSON file",
        }),
        conflicts: ["home", "url", "token-file"],
      },
      url: string({
        minLength: 1,
        description: "Connect to a loopback server origin",
      }),
      home: string({
        minLength: 1,
        description: "Use this OS home for T3 runtime state",
      }),
      "token-file": string({
        minLength: 1,
        description: "Read a bearer token from a file",
      }),
      helpForAgents: {
        type: "boolean",
        description: "Print the complete setup and usage guide",
      },
    },
    run: (ctx) => {
      if (ctx.values.helpForAgents === true) {
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

  return { report };
}

export const runCli = Effect.fnUntraced(function* (
  args: readonly string[],
  dependencies: UsageReportDependencies = defaultUsageReportDependencies,
): Effect.fn.Return<void, AppFailure> {
  let invocation: CliInvocation | undefined;
  const parsed = yield* Effect.tryPromise({
    try: async () => {
      const { report } = createCommands((value) => {
        invocation = value;
      });
      const usage = await cli([...args], report, {
        name: packageJson.name,
        version: packageJson.version,
        description: "Read usage limits from a running T3 Code server",
        strict: true,
        usageSilent: true,
        renderHeader: async () => "",
        renderValidationErrors: async () => "",
        onBeforeCommand: rejectUnsupportedCliSyntax,
      });
      if (usage !== undefined) {
        console.log(usage.trimEnd());
        return undefined;
      }
      if (invocation === undefined) {
        throw new CliFailure({
          message: "Invalid command-line arguments.",
        });
      }
      return invocation;
    },
    catch: (error) =>
      isAppFailure(error)
        ? error
        : new CliFailure({
            message:
              "Invalid command-line arguments. Run --help to see the supported flags.",
          }),
  });

  if (parsed === undefined) return;
  if (parsed.kind === "guide") {
    console.log(guide.trimEnd());
    return;
  }
  const { json, ...reportOptions } = parsed.options;
  const report = yield* readUsageReport(reportOptions, dependencies);
  yield* Effect.sync(() =>
    printUsageReport(
      report,
      reportOutputMode({ json, isAgent: getAgentProfile().isAgent }),
    ),
  );
});

if (import.meta.main) {
  const reportFailure = (failure: AppFailure) =>
    Effect.sync(() => {
      console.error(`Error: ${safeFailureMessage(failure)}`);
      process.exitCode = 1;
    });
  const program = Effect.matchEffect(runCli(Bun.argv.slice(2)), {
    onFailure: reportFailure,
    onSuccess: () => Effect.void,
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
