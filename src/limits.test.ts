import { describe, expect, it } from "bun:test";
import * as Effect from "effect/Effect";

import fixture from "../fixtures/usage-limits.json" with { type: "json" };
import { projectUsageLimits } from "./limits.ts";

describe("projectUsageLimits", () => {
  it("projects native and source accounts onto allowlisted fields with honest timestamps", () => {
    const report = Effect.runSync(
      projectUsageLimits({
        providers: fixture.providers,
        sources: fixture.sources,
        retrievedAt: "2026-10-31T12:00:00.000Z",
      }),
    );

    expect(report.retrievedAt).toBe("2026-10-31T12:00:00.000Z");
    expect(report.providers).toHaveLength(3);
    expect(report.providers[0]).toEqual({
      id: "claude",
      driver: "claude",
      label: "Claude Code",
      enabled: true,
      checkedAt: "2026-10-31T11:58:00.000Z",
      unavailable: false,
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
    });
    expect(report.providers[1]).toMatchObject({
      id: "codex",
      enabled: false,
      unavailable: true,
      reason: "notReported",
      windows: [],
    });
    expect(report.providers[2]).toMatchObject({
      id: "cliproxy-hub/account-a",
      sourceId: "cliproxy-hub",
      driver: "claude",
      label: "CLI Proxy / account-a",
      checkedAt: "2026-10-31T11:57:00.000Z",
    });
    expect(report.notices).toEqual([
      "Usage limit source cliproxy-hub (CLI Proxy) reported an error; checked at 2026-10-31T11:59:00.000Z.",
      "Usage limit source broken-source (Broken Source) reported an error; checked at 2026-10-31T11:56:00.000Z.",
    ]);

    const serialized = JSON.stringify(report);
    for (const privateValue of [
      "fixture-secret",
      "fixture-another-secret",
      "fixture-fingerprint",
      "fixture-source-fingerprint",
      "fixture-credit",
      "fixture-provider-error-must-not-be-printed",
      "fixture-source-error-must-not-be-printed",
      "fixture-account-secret",
      "private@example.invalid",
      "private-plan-name",
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
    expect(serialized).not.toContain("resetCredits");
    expect(serialized).not.toContain("credentialFingerprint");
  });

  it("marks unsupported and malformed snapshots without presenting malformed windows", () => {
    const report = Effect.runSync(
      projectUsageLimits({
        providers: [
          {
            instanceId: "unsupported",
            driver: "cursor",
            enabled: true,
            usageLimits: {
              checkedAt: "2026-10-31T11:00:00.000Z",
              windows: [],
              unavailable: {
                reason: "unsupported",
                message: "private provider detail",
              },
            },
          },
          {
            instanceId: "malformed",
            driver: "codex",
            usageLimits: {
              checkedAt: "not a timestamp",
              windows: [
                { id: "bad", label: "Bad", kind: "yearly", usedPercent: 20 },
              ],
            },
          },
        ],
        sources: [],
        retrievedAt: "2026-10-31T12:00:00.000Z",
      }),
    );

    expect(report.providers[0]).toMatchObject({
      unavailable: true,
      reason: "unsupported",
    });
    expect(report.providers[1]).toMatchObject({
      unavailable: true,
      reason: "invalidSnapshot",
      windows: [],
    });
    expect(JSON.stringify(report)).not.toContain("private provider detail");
  });

  it("retains last good bars after a failed probe and omits unknown fields", () => {
    const report = Effect.runSync(
      projectUsageLimits({
        providers: [
          {
            instanceId: "provider-one",
            driver: "claude",
            privateConfig: { token: "unknown-config-secret" },
            usageLimits: {
              checkedAt: "2026-10-31T11:00:00.000Z",
              unavailable: {
                reason: "probeFailed",
                message: "private provider failure",
              },
              windows: [
                {
                  id: "session",
                  kind: "session",
                  label: "Session",
                  usedPercent: 42,
                  providerPrivateField: "unknown-window-secret",
                },
              ],
            },
          },
        ],
        sources: [],
        retrievedAt: "2026-10-31T12:00:00.000Z",
      }),
    );

    expect(report.providers[0]).toMatchObject({
      unavailable: true,
      reason: "probeFailed",
      windows: [{ id: "session", usedPercent: 42, remainingPercent: 58 }],
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("unknown-config-secret");
    expect(serialized).not.toContain("unknown-window-secret");
    expect(serialized).not.toContain("private provider failure");
  });

  it("rejects malformed fixture roots instead of returning an empty report", () => {
    expect(() =>
      Effect.runSync(projectUsageLimits({ providers: undefined, sources: [] })),
    ).toThrow(
      "The usage-limits input must include provider and source arrays.",
    );
  });

  it("rejects empty window identifiers and labels", () => {
    for (const window of [
      { id: "", label: "Session", kind: "session", usedPercent: 10 },
      { id: "session", label: "", kind: "session", usedPercent: 10 },
    ]) {
      const report = Effect.runSync(
        projectUsageLimits({
          providers: [
            {
              instanceId: "provider",
              driver: "codex",
              usageLimits: {
                checkedAt: "2026-10-31T11:00:00.000Z",
                windows: [window],
              },
            },
          ],
          sources: [],
        }),
      );
      expect(report.providers[0]).toMatchObject({
        unavailable: true,
        reason: "invalidSnapshot",
        windows: [],
      });
    }
  });

  it("uses the upstream trimmed, non-blank usage-window contract", () => {
    const report = Effect.runSync(
      projectUsageLimits({
        providers: [
          {
            instanceId: "trimmed",
            driver: "codex",
            usageLimits: {
              checkedAt: "2026-10-31T11:00:00.000Z",
              windows: [
                {
                  id: " session ",
                  kind: "session",
                  label: "  Session  ",
                  usedPercent: 42,
                },
              ],
            },
          },
          {
            instanceId: "blank",
            driver: "codex",
            usageLimits: {
              checkedAt: "2026-10-31T11:00:00.000Z",
              windows: [
                {
                  id: "   ",
                  kind: "session",
                  label: "Session",
                  usedPercent: 42,
                },
              ],
            },
          },
        ],
        sources: [],
      }),
    );

    expect(report.providers[0]).toMatchObject({
      unavailable: false,
      windows: [
        {
          id: "session",
          label: "Session",
          usedPercent: 42,
          remainingPercent: 58,
        },
      ],
    });
    expect(report.providers[1]).toMatchObject({
      unavailable: true,
      reason: "invalidSnapshot",
      windows: [],
    });
  });
});
