export interface UsageLimitWindow {
  readonly id: string;
  readonly kind: "session" | "weekly" | "monthly" | "other";
  readonly label: string;
  readonly usedPercent: number;
  readonly remainingPercent: number;
  readonly resetsAt?: string;
  readonly windowDurationMins?: number;
}

export type UsageLimitUnavailableReason =
  | "unsupported"
  | "probeFailed"
  | "notReported"
  | "invalidSnapshot";

export interface UsageLimitRow {
  readonly id: string;
  readonly driver: string;
  readonly label: string;
  readonly sourceId?: string;
  readonly enabled?: boolean;
  readonly checkedAt?: string;
  readonly unavailable: boolean;
  readonly reason?: UsageLimitUnavailableReason;
  readonly windows: readonly UsageLimitWindow[];
}

export interface UsageLimitReport {
  readonly retrievedAt: string;
  readonly providers: readonly UsageLimitRow[];
  readonly notices: readonly string[];
}

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function checkedTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return undefined;
  return value;
}

function windowsFrom(value: unknown):
  | { readonly windows: readonly UsageLimitWindow[]; readonly invalid: false }
  | { readonly windows: readonly []; readonly invalid: true } {
  if (!Array.isArray(value)) return { windows: [], invalid: true };

  const windows: UsageLimitWindow[] = [];
  for (const item of value) {
    if (!isRecord(item)) return { windows: [], invalid: true };
    const id = stringValue(item.id);
    const label = stringValue(item.label);
    const usedPercent = item.usedPercent;
    const kind = item.kind;
    if (
      id === undefined ||
      label === undefined ||
      (kind !== "session" && kind !== "weekly" && kind !== "monthly" && kind !== "other") ||
      typeof usedPercent !== "number" ||
      !Number.isFinite(usedPercent) ||
      usedPercent < 0 ||
      usedPercent > 100
    ) {
      return { windows: [], invalid: true };
    }

    const resetsAt = checkedTimestamp(item.resetsAt);
    if (item.resetsAt !== undefined && resetsAt === undefined) return { windows: [], invalid: true };
    const windowDurationMins = item.windowDurationMins;
    if (
      windowDurationMins !== undefined &&
      (typeof windowDurationMins !== "number" ||
        !Number.isSafeInteger(windowDurationMins) ||
        windowDurationMins < 0)
    ) {
      return { windows: [], invalid: true };
    }
    windows.push({
      id,
      kind,
      label,
      usedPercent,
      remainingPercent: Math.round((100 - usedPercent) * 100) / 100,
      ...(resetsAt === undefined ? {} : { resetsAt }),
      ...(windowDurationMins !== undefined
        ? { windowDurationMins }
        : {}),
    });
  }
  return { windows, invalid: false };
}

function unavailableReason(value: unknown, missingLimits: boolean): UsageLimitUnavailableReason | undefined {
  if (missingLimits) return "notReported";
  if (!isRecord(value)) return "invalidSnapshot";
  if (value.unavailable === undefined) return undefined;
  if (!isRecord(value.unavailable)) return "invalidSnapshot";
  switch (value.unavailable.reason) {
    case "unsupported":
      return "unsupported";
    case "probeFailed":
      return "probeFailed";
    default:
      return "invalidSnapshot";
  }
}

function makeRow(input: {
  readonly id: unknown;
  readonly driver: unknown;
  readonly label: unknown;
  readonly sourceId?: string;
  readonly enabled?: unknown;
  readonly limits: unknown;
}): UsageLimitRow | undefined {
  const id = stringValue(input.id);
  const driver = stringValue(input.driver);
  const label = stringValue(input.label);
  if (id === undefined || driver === undefined || label === undefined) return undefined;

  const missingLimits = input.limits === undefined;
  const limits = isRecord(input.limits) ? input.limits : undefined;
  const parsedWindows = limits === undefined ? { windows: [], invalid: false as const } : windowsFrom(limits.windows);
  let reason = unavailableReason(limits, missingLimits);
  if (!missingLimits && (limits === undefined || checkedTimestamp(limits.checkedAt) === undefined || parsedWindows.invalid)) {
    reason = "invalidSnapshot";
  }
  const checkedAt = checkedTimestamp(limits?.checkedAt);

  return {
    id,
    driver,
    label,
    ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
    ...(typeof input.enabled === "boolean" ? { enabled: input.enabled } : {}),
    ...(checkedAt === undefined ? {} : { checkedAt }),
    unavailable: reason !== undefined,
    ...(reason === undefined ? {} : { reason }),
    windows: parsedWindows.windows,
  };
}

/** Projects the two T3 usage-limit streams onto a small, explicit output allowlist. */
export function projectUsageLimits(input: {
  readonly providers: unknown;
  readonly sources: unknown;
  readonly retrievedAt?: string;
}): UsageLimitReport {
  const retrievedAt = checkedTimestamp(input.retrievedAt) ?? new Date().toISOString();
  const rows: UsageLimitRow[] = [];
  const notices: string[] = [];

  if (!Array.isArray(input.providers) || !Array.isArray(input.sources)) {
    throw new Error("The usage-limits input must include provider and source arrays.");
  }

  for (const provider of input.providers) {
    if (!isRecord(provider)) {
      notices.push("Some provider usage-limit data was invalid and omitted.");
      continue;
    }
    const row = makeRow({
      id: provider.instanceId,
      driver: provider.driver,
      label: provider.displayName ?? provider.instanceId,
      enabled: provider.enabled,
      limits: provider.usageLimits,
    });
    if (row) rows.push(row);
    else notices.push("Some provider usage-limit data was invalid and omitted.");
  }

  for (const source of input.sources) {
    if (!isRecord(source)) {
      notices.push("Some usage-limit source data was invalid and omitted.");
      continue;
    }
    const sourceId = stringValue(source.id) ?? "unknown";
    const sourceLabel = stringValue(source.label) ?? "Usage limit source";
    const sourceCheckedAt = checkedTimestamp(source.checkedAt);
    if (stringValue(source.error) !== undefined) {
      notices.push(
        `Usage limit source ${sourceId} (${sourceLabel}) reported an error${sourceCheckedAt === undefined ? "" : `; checked at ${sourceCheckedAt}`}.`,
      );
    }

    if (!Array.isArray(source.accounts)) {
      notices.push(`Usage limit source ${sourceId} (${sourceLabel}) contained invalid data.`);
      continue;
    }
    const stableSourceId = stringValue(source.id);
    for (const account of source.accounts) {
      if (!isRecord(account)) {
        notices.push("Some usage-limit source data was invalid and omitted.");
        continue;
      }
      const accountId = stringValue(account.id);
      const row = makeRow({
        id: sourceId === undefined || accountId === undefined
          ? accountId
          : `${sourceId}/${accountId}`,
        driver: account.driver,
        label: accountId === undefined ? sourceLabel : `${sourceLabel} / ${accountId}`,
        ...(stableSourceId === undefined ? {} : { sourceId: stableSourceId }),
        limits: account.usageLimits,
      });
      if (row) rows.push(row);
      else notices.push("Some usage-limit source data was invalid and omitted.");
    }
  }

  return {
    retrievedAt,
    providers: rows,
    notices: [...new Set(notices)],
  };
}
