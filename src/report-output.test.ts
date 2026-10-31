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

function withoutAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

describe("usage report output", () => {
  it("renders native provider tables and preserves report metadata", () => {
    const output = withoutAnsi(formatHumanReport(report));

    expect(output).toContain(
      "Usage limits retrieved at 2026-10-31T12:00:00.000Z",
    );
    expect(output).toContain(
      "Claude Code · claude · claude · source provider-source-1",
    );
    expect(output).toContain("enabled: true");
    expect(output).toContain("unavailable");
    expect(output).toContain("probeFailed");
    expect(output).toContain("checked 2026-10-31T11:58:00.000Z");
    expect(output).toContain("Window");
    expect(output).toContain("5-hour session");
    expect(output).toContain("72.5%");
    expect(output).toContain("27.5%");
    expect(output).toContain("2026-10-31T15:00:00.000Z");
    expect(output).toContain("300 min");
    expect(output).toContain("enabled: false");
    expect(output).toContain("notReported");
    expect(output).toContain("No usage windows reported.");
    expect(output).toContain("Notice: provider [31m failure continued");
    expect(output).toMatch(/\n(?:\+-{2,}\+|┌─{2,})/);
  });

  it("shows Markdown punctuation in provider fields and notices as literal text", () => {
    const provider = report.providers[0];
    const window = provider.windows[0];
    const output = withoutAnsi(
      formatHumanReport({
        ...report,
        providers: [
          {
            ...provider,
            label: "Cap | `focus` _today_",
            id: "instance [one](target)",
            sourceId: "<source>",
            windows: [
              {
                ...window,
                label: "5h | `window`",
              },
            ],
          },
        ],
        notices: ["See [provider](https://example.invalid) <raw> & _markup_."],
      }),
    );

    expect(output).toContain("Cap | `focus` _today_");
    expect(output).toContain("instance [one](target)");
    expect(output).toContain("<source>");
    expect(output).toContain("5h | `window`");
    expect(output).toContain(
      "See [provider](https://example.invalid) <raw> & _markup_.",
    );
    expect(output).not.toContain("provider (https://example.invalid)");
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
