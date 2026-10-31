import { createConsola, LogLevels } from "consola/core";
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
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
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

function formatWindowTable(row: UsageLimitRow): string[] {
  const headers = ["Window", "Used", "Remaining", "Resets", "Duration"];
  const rows = row.windows.map((window) => [
    cleanText(window.label),
    `${window.usedPercent}%`,
    `${window.remainingPercent}%`,
    window.resetsAt === undefined ? "—" : cleanText(window.resetsAt),
    window.windowDurationMins === undefined
      ? "—"
      : `${window.windowDurationMins} min`,
  ]);
  const widths = headers.map((header, index) =>
    Math.max(
      Bun.stringWidth(header),
      ...rows.map((cells) => Bun.stringWidth(cells[index] ?? "")),
    ),
  );
  const rightAligned = new Set([1, 2]);
  const formatRow = (cells: readonly string[]) =>
    cells
      .map((cell, index) => {
        const width = widths[index] ?? 0;
        const padding = width - Bun.stringWidth(cell);
        const leftPadding = rightAligned.has(index) ? padding : 0;
        const rightPadding = padding - leftPadding;
        return `${" ".repeat(leftPadding)}${cell}${" ".repeat(rightPadding + (index === cells.length - 1 ? 0 : 2))}`;
      })
      .join("")
      .trimEnd();
  return [formatRow(headers), ...rows.map(formatRow)];
}

export function formatHumanReport(report: UsageLimitReport): string {
  const lines = [`Usage limits retrieved at ${cleanText(report.retrievedAt)}`];
  if (report.providers.length === 0) {
    lines.push("", "No provider usage limits were reported.");
  }
  for (const row of report.providers) {
    const source =
      row.sourceId === undefined ? "" : ` · source ${cleanText(row.sourceId)}`;
    const metadata = [
      row.enabled === undefined
        ? undefined
        : row.enabled
          ? "enabled"
          : "disabled",
      row.unavailable
        ? `unavailable (${row.reason ?? "invalidSnapshot"})`
        : undefined,
      row.checkedAt === undefined
        ? undefined
        : `checked ${cleanText(row.checkedAt)}`,
    ].filter((value) => value !== undefined);
    lines.push(
      "",
      `${cleanText(row.label)} · ${cleanText(row.driver)} · ${cleanText(row.id)}${source}`,
    );
    if (metadata.length > 0) lines.push(`  ${metadata.join(" · ")}`);
    if (row.windows.length === 0) {
      lines.push("  No usage windows reported.");
    } else {
      lines.push(...formatWindowTable(row));
    }
  }
  for (const notice of report.notices)
    lines.push(`Notice: ${cleanText(notice)}`);
  return lines.join("\n");
}

export function printUsageReport(
  report: UsageLimitReport,
  mode: ReportOutputMode,
): void {
  return Match.value(mode).pipe(
    Match.when("json", () => console.log(JSON.stringify(report, null, 2))),
    Match.when("agent", () => console.log(formatAgentReport(report))),
    Match.when("human", () =>
      createConsola({
        level: LogLevels.verbose,
        throttle: 0,
        // Default reporters add metadata and interpret provider label markup.
        reporters: [{ log: ({ args }) => console.log(...args) }],
      }).log(formatHumanReport(report)),
    ),
    Match.exhaustive,
  );
}
