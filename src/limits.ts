import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { InputFailure } from "./errors.ts";

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

const UsageWindowSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  kind: Schema.Literals(["session", "weekly", "monthly", "other"]),
  label: Schema.NonEmptyString,
  usedPercent: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  resetsAt: Schema.optional(Schema.String),
  windowDurationMins: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  ),
});

const UsageLimitsSchema = Schema.Struct({
  checkedAt: Schema.optional(Schema.Unknown),
  windows: Schema.optional(Schema.Unknown),
  unavailable: Schema.optional(Schema.Unknown),
});

const ProviderInputSchema = Schema.Struct({
  instanceId: Schema.optional(Schema.Unknown),
  driver: Schema.optional(Schema.Unknown),
  displayName: Schema.optional(Schema.Unknown),
  enabled: Schema.optional(Schema.Unknown),
  usageLimits: Schema.optional(Schema.Unknown),
});

const SourceInputSchema = Schema.Struct({
  id: Schema.optional(Schema.Unknown),
  label: Schema.optional(Schema.Unknown),
  checkedAt: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown),
  accounts: Schema.optional(Schema.Unknown),
});

const AccountInputSchema = Schema.Struct({
  id: Schema.optional(Schema.Unknown),
  driver: Schema.optional(Schema.Unknown),
  usageLimits: Schema.optional(Schema.Unknown),
});

const UsageLimitInputSchema = Schema.Struct({
  providers: Schema.Array(Schema.Unknown),
  sources: Schema.Array(Schema.Unknown),
});

const UsageLimitRowSchema = Schema.Struct({
  id: Schema.String,
  driver: Schema.String,
  label: Schema.String,
  sourceId: Schema.optional(Schema.String),
  enabled: Schema.optional(Schema.Boolean),
  checkedAt: Schema.optional(Schema.String),
  unavailable: Schema.Boolean,
  reason: Schema.optional(Schema.Literals(["unsupported", "probeFailed", "notReported", "invalidSnapshot"])),
  windows: Schema.Array(Schema.Struct({
    id: Schema.String,
    kind: Schema.Literals(["session", "weekly", "monthly", "other"]),
    label: Schema.String,
    usedPercent: Schema.Finite,
    remainingPercent: Schema.Finite,
    resetsAt: Schema.optional(Schema.String),
    windowDurationMins: Schema.optional(Schema.Int),
  })),
});

const UsageLimitReportSchema = Schema.Struct({
  retrievedAt: Schema.String,
  providers: Schema.Array(UsageLimitRowSchema),
  notices: Schema.Array(Schema.String),
});

type UsageWindowInput = typeof UsageWindowSchema.Type;
type UsageLimitsInput = typeof UsageLimitsSchema.Type;
type SourceInput = typeof SourceInputSchema.Type;

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function checkedTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return undefined;
  return value;
}

function decodeOption<S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown): S["Type"] | undefined {
  const decoded = Schema.decodeUnknownOption(schema)(value);
  return Option.isSome(decoded) ? decoded.value : undefined;
}

function windowsFrom(value: unknown):
  | { readonly windows: readonly UsageLimitWindow[]; readonly invalid: false }
  | { readonly windows: readonly []; readonly invalid: true } {
  if (!Array.isArray(value)) return { windows: [], invalid: true };
  const decoded = decodeOption(Schema.Array(UsageWindowSchema), value);
  if (decoded === undefined) return { windows: [], invalid: true };

  const windows: UsageLimitWindow[] = [];
  for (const item of decoded satisfies readonly UsageWindowInput[]) {
    const resetsAt = checkedTimestamp(item.resetsAt);
    if (item.resetsAt !== undefined && resetsAt === undefined) return { windows: [], invalid: true };
    windows.push({
      id: item.id,
      kind: item.kind,
      label: item.label,
      usedPercent: item.usedPercent,
      remainingPercent: Math.round((100 - item.usedPercent) * 100) / 100,
      ...(resetsAt === undefined ? {} : { resetsAt }),
      ...(item.windowDurationMins === undefined ? {} : { windowDurationMins: item.windowDurationMins }),
    });
  }
  return { windows, invalid: false };
}

function unavailableReason(value: UsageLimitsInput | undefined, missingLimits: boolean): UsageLimitUnavailableReason | undefined {
  if (missingLimits) return "notReported";
  if (value === undefined) return "invalidSnapshot";
  const unavailable = value.unavailable;
  if (unavailable === undefined) return undefined;
  const decoded = decodeOption(Schema.Struct({
    reason: Schema.Literals(["unsupported", "probeFailed"]),
  }), unavailable);
  return decoded?.reason ?? "invalidSnapshot";
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
  const limits = decodeOption(UsageLimitsSchema, input.limits);
  const parsedWindows = limits === undefined
    ? { windows: [], invalid: !missingLimits } as const
    : windowsFrom(limits.windows);
  let reason = unavailableReason(limits, missingLimits);
  if (
    !missingLimits &&
    (limits === undefined || checkedTimestamp(limits.checkedAt) === undefined || parsedWindows.invalid)
  ) {
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

function projectProvider(value: unknown): UsageLimitRow | undefined {
  const provider = decodeOption(ProviderInputSchema, value);
  if (provider === undefined) return undefined;
  return makeRow({
    id: provider.instanceId,
    driver: provider.driver,
    label: provider.displayName ?? provider.instanceId,
    enabled: provider.enabled,
    limits: provider.usageLimits,
  });
}

function projectSourceAccount(
  source: SourceInput,
  sourceId: string,
  sourceLabel: string,
  accountValue: unknown,
): UsageLimitRow | undefined {
  const account = decodeOption(AccountInputSchema, accountValue);
  if (account === undefined) return undefined;
  const accountId = stringValue(account.id);
  const stableSourceId = stringValue(source.id);
  return makeRow({
    id: accountId === undefined ? accountId : `${sourceId}/${accountId}`,
    driver: account.driver,
    label: accountId === undefined ? sourceLabel : `${sourceLabel} / ${accountId}`,
    ...(stableSourceId === undefined ? {} : { sourceId: stableSourceId }),
    limits: account.usageLimits,
  });
}

/** Projects the two T3 usage-limit streams onto a small, explicit output allowlist. */
export function projectUsageLimits(input: {
  readonly providers: unknown;
  readonly sources: unknown;
  readonly retrievedAt?: string;
}): Effect.Effect<UsageLimitReport, InputFailure> {
  const decodedInput = Schema.decodeUnknownEffect(UsageLimitInputSchema)({
    providers: input.providers,
    sources: input.sources,
  });
  return Effect.gen(function*() {
    const data = yield* Effect.mapError(
      decodedInput,
      () => new InputFailure({ safeMessage: "The usage-limits input must include provider and source arrays." }),
    );
    const retrievedAt = checkedTimestamp(input.retrievedAt) ?? new Date().toISOString();
    const rows: UsageLimitRow[] = [];
    const notices: string[] = [];

    for (const value of data.providers) {
      const row = projectProvider(value);
      if (row) rows.push(row);
      else notices.push("Some provider usage-limit data was invalid and omitted.");
    }

    for (const value of data.sources) {
      const source = decodeOption(SourceInputSchema, value);
      if (source === undefined) {
        notices.push("Some usage-limit source data was invalid and omitted.");
        continue;
      }
      const sourceId = stringValue(source.id) ?? "unknown";
      const sourceLabel = stringValue(source.label) ?? "Usage limit source";
      const checkedAt = checkedTimestamp(source.checkedAt);
      if (stringValue(source.error) !== undefined) {
        notices.push(
          `Usage limit source ${sourceId} (${sourceLabel}) reported an error${checkedAt === undefined ? "" : `; checked at ${checkedAt}`}.`,
        );
      }
      if (!Array.isArray(source.accounts)) {
        notices.push(`Usage limit source ${sourceId} (${sourceLabel}) contained invalid data.`);
        continue;
      }
      for (const account of source.accounts) {
        const row = projectSourceAccount(source, sourceId, sourceLabel, account);
        if (row) rows.push(row);
        else notices.push("Some usage-limit source data was invalid and omitted.");
      }
    }

    const report = {
      retrievedAt,
      providers: rows,
      notices: [...new Set(notices)],
    };
    return yield* Effect.mapError(
      Schema.decodeUnknownEffect(UsageLimitReportSchema)(report),
      () => new InputFailure({ safeMessage: "The usage-limits report could not be created safely." }),
    );
  });
}
