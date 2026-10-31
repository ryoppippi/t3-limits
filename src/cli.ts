import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

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
  if (home !== undefined && origin !== undefined) {
    throw new Error("Use either --home or --url, not both.");
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
    return JSON.parse(await readFile(path, "utf8")) as unknown;
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

async function bearerToken(tokenFile: string | undefined): Promise<string> {
  let token: string | undefined;
  if (tokenFile !== undefined) {
    try {
      token = await readFile(tokenFile, "utf8");
    } catch {
      throw new Error("The token file could not be read.");
    }
  } else {
    token = process.env.T3_LIMITS_TOKEN;
  }

  const trimmed = token?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    throw new Error("Authentication required: set T3_LIMITS_TOKEN or pass --token-file <path>.");
  }
  return trimmed;
}

async function liveReport(options: CliOptions): Promise<UsageLimitReport> {
  const token = await bearerToken(options.tokenFile);
  const origin = options.origin ?? await runtimeOrigin(options.home);
  webSocketUrl(origin, true);
  const data = await readUsageLimitStreams({ origin, token });
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
  t3-limits [--json] [--url <loopback-origin> | --home <home-directory>]
            [--token-file <path>]
  t3-limits --fixture <path> [--json]

Options:
  --json               Print an allowlisted JSON report.
  --url <origin>       Connect to a loopback server origin.
  --home <directory>   Read .t3/userdata/server-runtime.json from this home directory.
  --token-file <path>  Read a bearer token at runtime; otherwise use T3_LIMITS_TOKEN.
  --fixture <path>     Read synthetic { providers, sources } data without connecting.
  -h, --help           Show this help.
`;

export async function runCli(args: readonly string[]): Promise<void> {
  const options = parseArgs(args);
  if (options.help) {
    console.log(HELP);
    return;
  }
  const report = options.fixture === undefined
    ? await liveReport(options)
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
