import * as Schema from "effect/Schema";

export class InputFailure extends Schema.TaggedError<InputFailure>()(
  "InputFailure",
  {
    message: Schema.String,
  },
) {}

export class AuthFailure extends Schema.TaggedError<AuthFailure>()(
  "AuthFailure",
  {
    message: Schema.String,
  },
) {}

export class ProcessFailure extends Schema.TaggedError<ProcessFailure>()(
  "ProcessFailure",
  {
    message: Schema.String,
  },
) {}

export class RpcFailure extends Schema.TaggedError<RpcFailure>()("RpcFailure", {
  message: Schema.String,
}) {}

export class CliFailure extends Schema.TaggedError<CliFailure>()("CliFailure", {
  message: Schema.String,
}) {}

export type AppFailure =
  InputFailure | AuthFailure | ProcessFailure | RpcFailure | CliFailure;

export const AppFailureSchema = Schema.Union([
  InputFailure,
  AuthFailure,
  ProcessFailure,
  RpcFailure,
  CliFailure,
]);

export const isAppFailure = Schema.is(AppFailureSchema);

export function safeFailureMessage(failure: AppFailure): string {
  return failure.message;
}
