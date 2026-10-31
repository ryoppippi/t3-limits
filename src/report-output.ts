import * as Match from "effect/Match";

import type { UsageLimitReport, UsageLimitRow } from "./limits.ts";

export type ReportOutputMode = "agent" | "human" | "json";

export function reportOutputMode(options: {
  readonly json: boolean;
  readonly isAgent: boolean;
}): ReportOutputMode {
  return Match.value(options).pipe(
    Match.withReturnType<ReportOutputMode>(),
    Match.when({ json: true }, () => "json"),
    Match.when({ isAgent: true }, () => "agent"),
    Match.orElse(() => "human"),
  );
}

function cleanText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ");
}

function escapeMarkdownText(value: string): string {
  return cleanText(value).replace(
    /[!-/:-@[-`{-~]/g,
    (character) => `&#${character.charCodeAt(0)};`,
  );
}

function cleanAgentText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ");
}

function formatAgentRow(row: UsageLimitRow): string[] {
  const enabled =
    row.enabled === undefined ? "" : row.enabled ? " · enabled" : " · disabled";
  const checkedAt =
    row.checkedAt === undefined ? "" : ` · checked ${row.checkedAt}`;
  const lines = [
    `${cleanAgentText(row.label)} (${cleanAgentText(row.driver)} · ${cleanAgentText(row.id)})${enabled}${checkedAt}`,
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
      `  ${cleanAgentText(window.label)}: ${window.usedPercent}% used · ${window.remainingPercent}% remaining${reset}${duration}`,
    );
  }
  return lines;
}

export function formatAgentReport(report: UsageLimitReport): string {
  const lines = [`Usage limits retrieved at ${report.retrievedAt}`];
  if (report.providers.length === 0)
    lines.push("No provider usage limits were reported.");
  for (const row of report.providers) lines.push(...formatAgentRow(row));
  for (const notice of report.notices)
    lines.push(`Notice: ${cleanAgentText(notice)}`);
  return lines.join("\n");
}

function formatWindowMarkdownTable(row: UsageLimitRow): string[] {
  const headers = ["Window", "Used", "Remaining", "Resets", "Duration"];
  const rows = row.windows.map((window) => [
    escapeMarkdownText(window.label),
    `${window.usedPercent}%`,
    `${window.remainingPercent}%`,
    window.resetsAt === undefined ? "—" : escapeMarkdownText(window.resetsAt),
    window.windowDurationMins === undefined
      ? "—"
      : `${window.windowDurationMins} min`,
  ]);
  const formatRow = (cells: readonly string[]) => `| ${cells.join(" | ")} |`;
  const alignment = ["---", "---:", "---:", "---", "---:"];
  return [
    formatRow(headers.map(escapeMarkdownText)),
    formatRow(alignment),
    ...rows.map(formatRow),
  ];
}

export function formatHumanReport(report: UsageLimitReport): string {
  const lines = [
    `# Usage limits retrieved at ${escapeMarkdownText(report.retrievedAt)}`,
  ];
  if (report.providers.length === 0) {
    lines.push("", "No provider usage limits were reported.");
  }
  for (const row of report.providers) {
    const source =
      row.sourceId === undefined
        ? ""
        : ` · source ${escapeMarkdownText(row.sourceId)}`;
    const metadata = [
      row.enabled === undefined ? undefined : `enabled: ${row.enabled}`,
      row.unavailable
        ? `unavailable (${escapeMarkdownText(row.reason ?? "invalidSnapshot")})`
        : "available",
      row.checkedAt === undefined
        ? undefined
        : `checked ${escapeMarkdownText(row.checkedAt)}`,
    ].filter((value) => value !== undefined);
    lines.push(
      "",
      `## ${escapeMarkdownText(row.label)} · ${escapeMarkdownText(row.driver)} · ${escapeMarkdownText(row.id)}${source}`,
      "",
    );
    lines.push(...metadata.map((value) => `- ${value}`));
    if (row.windows.length === 0) {
      lines.push("", "No usage windows reported.");
    } else {
      lines.push("", ...formatWindowMarkdownTable(row));
    }
  }
  for (const notice of report.notices)
    lines.push("", `Notice: ${escapeMarkdownText(notice)}`);
  return Bun.markdown.ansi(lines.join("\n"), {
    colors: Boolean(process.stdout.isTTY) && !("NO_COLOR" in process.env),
    columns: 0,
    hyperlinks: false,
  });
}

export function printUsageReport(
  report: UsageLimitReport,
  mode: ReportOutputMode,
): void {
  return Match.value(mode).pipe(
    Match.when("json", () => console.log(JSON.stringify(report, null, 2))),
    Match.when("agent", () => console.log(formatAgentReport(report))),
    Match.when("human", () => console.log(formatHumanReport(report))),
    Match.exhaustive,
  );
}
