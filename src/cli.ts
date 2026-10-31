import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import {
  canonicalSecretOrigin,
  issueAndStoreScopedToken,
  readBearerToken,
  TOKEN_SERVICE,
  type SecretStore,
  type SessionSpawn,
} from "./auth.ts";
import { projectUsageLimits, type UsageLimitReport, type UsageLimitRow } from "./limits.ts";
import { readUsageLimitStreams, webSocketUrl } from "./rpc.ts";

interface CliOptions {
  readonly help: boolean;
  readonly json: boolean;
  readonly fixture?: string;
  readonly home?: string;
  readonly origin?: string;
  readonly tokenFile?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Expected a value after ${flag}.`);
    }
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
        if (fixture !== undefined) throw new Error("--fixture can only be used once.");
        fixture = takeValue(argument, index);
        index += 1;
        break;
      case "--home":
        if (home !== undefined) throw new Error("--home can only be used once.");
        home = takeValue(argument, index);
        index += 1;
        break;
      case "--url":
        if (origin !== undefined) throw new Error("--url can only be used once.");
        origin = takeValue(argument, index);
        index += 1;
        break;
      case "--token-file":
        if (tokenFile !== undefined) throw new Error("--token-file can only be used once.");
        tokenFile = takeValue(argument, index);
        index += 1;
        break;
      default:
        throw new Error("Unknown option. Run --help to see the supported flags.");
    }
  }

  if (fixture !== undefined && (home !== undefined || origin !== undefined || tokenFile !== undefined)) {
    throw new Error("--fixture cannot be combined with connection options.");
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

async function readJsonFile(path: string, failure: string): Promise<unknown> {
  try {
    return JSON.parse(await Bun.file(path).text()) as unknown;
  } catch {
    throw new Error(failure);
  }
}

async function fixtureReport(path: string): Promise<UsageLimitReport> {
  const fixture = await readJsonFile(path, "Could not read the usage-limits fixture.");
  if (!isRecord(fixture)) throw new Error("The usage-limits fixture must be a JSON object.");
  return projectUsageLimits({
    providers: fixture.providers,
    sources: fixture.sources,
  });
}

async function runtimeOrigin(home: string | undefined): Promise<string> {
  const statePath = join(home ?? homedir(), ".t3", "userdata", "server-runtime.json");
  const runtime = await readJsonFile(statePath, "T3 server runtime state could not be read.");
  if (!isRecord(runtime) || typeof runtime.origin !== "string") {
    throw new Error("T3 server runtime state does not contain a valid origin.");
  }
  return runtime.origin;
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

function configuredT3Executable(value: string | undefined): string {
  if (value === undefined) return "t3";
  if (!isAbsolute(value)) {
    throw new Error("T3CODE_CLI_PATH must be a non-empty absolute executable path.");
  }
  return value;
}

async function liveReport(options: CliOptions, dependencies: CliDependencies): Promise<UsageLimitReport> {
  const origin = options.origin ?? await runtimeOrigin(options.home);
  webSocketUrl(origin, true);
  const token = await readBearerToken({
    origin,
    tokenFile: options.tokenFile,
    env: dependencies.env,
    secrets: dependencies.secrets,
    readFile: dependencies.readFile,
    onMissing: async (missingOrigin) => {
      if (options.origin !== undefined) {
        const discoveredOrigin = await runtimeOrigin(options.home);
        if (canonicalSecretOrigin(missingOrigin) !== canonicalSecretOrigin(discoveredOrigin)) {
          throw new Error("The --url override does not match the runtime server. Provide T3_LIMITS_TOKEN or --token-file to use this URL without automatic token setup.");
        }
      }
      const executable = configuredT3Executable(dependencies.env.T3CODE_CLI_PATH);
      return issueAndStoreScopedToken({
        origin: missingOrigin,
        executable,
        baseDir: join(options.home ?? homedir(), ".t3"),
        secrets: dependencies.secrets,
        spawn: dependencies.spawn,
      });
    },
  });
  const data = await (dependencies.readUsageLimits ?? readUsageLimitStreams)({ origin, token }).catch(() => {
    throw new Error("Could not retrieve T3 usage limits. Check the server connection and credential; run `t3-limits auth login` to replace an expired stored token, or replace the supplied token.");
  });
  return projectUsageLimits(data);
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

function printReport(report: UsageLimitReport, json: boolean): void {
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
  if (command !== "login" && command !== "logout") throw new Error("Expected `auth login` or `auth logout`.");
  let home: string | undefined;
  let origin: string | undefined;
  let t3Bin: string | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error("Expected an option value.");
    if (flag === "--home") {
      if (home !== undefined) throw new Error("--home can only be used once.");
      home = value;
    } else if (flag === "--url") {
      if (origin !== undefined) throw new Error("--url can only be used once.");
      origin = value;
    } else if (flag === "--t3-bin") {
      if (t3Bin !== undefined) throw new Error("--t3-bin can only be used once.");
      t3Bin = value;
    } else {
      throw new Error("Unknown auth option. Run `t3-limits auth --help` to see supported options.");
    }
    index += 1;
  }
  if (home !== undefined && origin !== undefined) throw new Error("Use either --home or --url, not both.");
  if (command === "login" && origin !== undefined) throw new Error("auth login discovers the server origin from runtime state; --url is not supported.");
  if (command === "logout" && t3Bin !== undefined) throw new Error("--t3-bin is only supported by auth login.");
  return { command, ...(home === undefined ? {} : { home }), ...(origin === undefined ? {} : { origin }), ...(t3Bin === undefined ? {} : { t3Bin }) };
}

async function runAuth(args: readonly string[], dependencies: CliDependencies): Promise<void> {
  const options = parseAuthArgs(args);
  if (options === "help") {
    console.log(AUTH_HELP);
    return;
  }
  const origin = options.origin ?? await runtimeOrigin(options.home);
  const name = canonicalSecretOrigin(origin);
  const secretKey = { service: TOKEN_SERVICE, name };
  if (options.command === "logout") {
    try {
      await dependencies.secrets.delete(secretKey);
    } catch {
      throw new Error("Could not access the OS secret store to remove the local token. Ensure Bun 1.3+ and an available OS keychain (Linux: libsecret).");
    }
    console.log("Local token removed if present. Any issued server token remains valid until expiry.");
    return;
  }

  const executable = options.t3Bin ?? configuredT3Executable(dependencies.env.T3CODE_CLI_PATH);
  if (executable.trim().length === 0) throw new Error("T3CODE_CLI_PATH or --t3-bin must name the installed T3 CLI executable.");
  const baseDir = join(options.home ?? homedir(), ".t3");
  await issueAndStoreScopedToken({ origin, executable, baseDir, secrets: dependencies.secrets, spawn: dependencies.spawn });
  console.log(`Scoped token stored for ${name}; it expires in one hour.`);
}

export async function runCli(args: readonly string[], dependencies: CliDependencies = defaultDependencies): Promise<void> {
  if (args[0] === "auth") {
    await runAuth(args.slice(1), dependencies);
    return;
  }
  const options = parseArgs(args);
  if (options.help) {
    console.log(HELP);
    return;
  }
  const report = options.fixture === undefined
    ? await liveReport(options, dependencies)
    : await fixtureReport(options.fixture);
  printReport(report, options.json);
}

if (import.meta.main) {
  try {
    await runCli(Bun.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : "The command failed.";
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  }
}
