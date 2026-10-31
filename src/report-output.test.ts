import { describe, expect, it } from "bun:test";

import type { UsageLimitReport } from "./limits.ts";
import { formatAgentReport, formatHumanReport } from "./report-output.ts";

const report = {
  retrievedAt: "2026-10-31T12:00:00.000Z",
  providers: [
    {
      id: "claude",
      driver: "claude",
      label: "Claude Code",
      sourceId: "provider-source-1",
      enabled: true,
      checkedAt: "2026-10-31T11:58:00.000Z",
      unavailable: true,
      reason: "probeFailed",
      windows: [
        {
          id: "session",
          kind: "session",
          label: "5-hour session",
          usedPercent: 72.5,
          remainingPercent: 27.5,
          resetsAt: "2026-10-31T15:00:00.000Z",
          windowDurationMins: 300,
        },
      ],
    },
    {
      id: "codex",
      driver: "codex",
      label: "Codex",
      enabled: false,
      unavailable: true,
      reason: "notReported",
      windows: [],
    },
  ],
  notices: ["provider\u001b[31m failure\ncontinued"],
} satisfies UsageLimitReport;

describe("usage report output", () => {
  it("formats readable per-provider tables and preserves report metadata", () => {
    const lines = formatHumanReport(report).split("\n");

    expect(lines).toContain(
      "Usage limits retrieved at 2026-10-31T12:00:00.000Z",
    );
    expect(lines).toContain(
      "Claude Code · claude · claude · source provider-source-1",
    );
    expect(lines).toContain(
      "  enabled · unavailable (probeFailed) · checked 2026-10-31T11:58:00.000Z",
    );
    expect(lines).toContain("  disabled · unavailable (notReported)");
    expect(lines).toContain("  No usage windows reported.");
    expect(lines).toContain("Notice: provider [31m failure continued");

    const header = lines.find((line) => line.startsWith("Window"));
    const window = lines.find((line) => line.startsWith("5-hour session"));
    expect(header).toBeDefined();
    expect(window).toBeDefined();
    expect(window).toContain("2026-10-31T15:00:00.000Z");
    expect(window).toContain("300 min");
    expect(window).toContain("72.5%");
    expect(window).toContain("27.5%");
    expect((window ?? "").indexOf("2026-10-31T15:00:00.000Z")).toBe(
      (header ?? "").indexOf("Resets"),
    );
    expect((window ?? "").indexOf("72.5%") + Bun.stringWidth("72.5%")).toBe(
      (header ?? "").indexOf("Used") + Bun.stringWidth("Used"),
    );
    expect((window ?? "").indexOf("27.5%") + Bun.stringWidth("27.5%")).toBe(
      (header ?? "").indexOf("Remaining") + Bun.stringWidth("Remaining"),
    );
    expect(Bun.stringWidth(header ?? "")).toBeGreaterThan(
      Bun.stringWidth("Window"),
    );
  });

  it("aligns columns by terminal width for non-ASCII labels", () => {
    const provider = report.providers[0];
    const window = provider.windows[0];
    const output = formatHumanReport({
      ...report,
      providers: [
        {
          ...provider,
          windows: [
            { ...window, label: "五時間" },
            { ...window, label: "Week" },
          ],
        },
      ],
    });
    const lines = output.split("\n");
    const columns = ["五時間", "Week"].map((label) => {
      const line = lines.find((line) => line.startsWith(label)) ?? "";
      const resetIndex = line.indexOf("2026-10-31T15:00:00.000Z");
      expect(resetIndex).toBeGreaterThan(0);
      return Bun.stringWidth(line.slice(0, resetIndex));
    });
    expect(columns[0]).toBe(columns[1]);
  });

  it("retains the existing enumerated output for detected agents", () => {
    expect(formatAgentReport(report)).toBe(
      [
        "Usage limits retrieved at 2026-10-31T12:00:00.000Z",
        "Claude Code (claude · claude) · enabled · checked 2026-10-31T11:58:00.000Z",
        "  unavailable: probeFailed",
        "  5-hour session: 72.5% used · 27.5% remaining · resets 2026-10-31T15:00:00.000Z · 300 min window",
        "Codex (codex · codex) · disabled",
        "  unavailable: notReported",
        "Notice: provider [31m failure continued",
      ].join("\n"),
    );
  });

  it("explains empty reports and retains notices", () => {
    const emptyReport = {
      retrievedAt: "2026-10-31T12:00:00.000Z",
      providers: [],
      notices: ["No provider snapshots were received."],
    } satisfies UsageLimitReport;

    expect(formatHumanReport(emptyReport)).toContain(
      "No provider usage limits were reported.",
    );
    expect(formatHumanReport(emptyReport)).toContain(
      "Notice: No provider snapshots were received.",
    );
  });
});
