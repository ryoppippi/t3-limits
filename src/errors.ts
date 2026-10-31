import * as Data from "effect/Data";

export class InputFailure extends Data.TaggedError("InputFailure")<{
  readonly safeMessage: string;
}> {
  override get message(): string {
    return this.safeMessage;
  }
}

export class AuthFailure extends Data.TaggedError("AuthFailure")<{
  readonly safeMessage: string;
}> {
  override get message(): string {
    return this.safeMessage;
  }
}

export class ProcessFailure extends Data.TaggedError("ProcessFailure")<{
  readonly safeMessage: string;
}> {
  override get message(): string {
    return this.safeMessage;
  }
}

export class RpcFailure extends Data.TaggedError("RpcFailure")<{
  readonly safeMessage: string;
}> {
  override get message(): string {
    return this.safeMessage;
  }
}

export class CliFailure extends Data.TaggedError("CliFailure")<{
  readonly safeMessage: string;
}> {
  override get message(): string {
    return this.safeMessage;
  }
}

export type AppFailure =
  InputFailure | AuthFailure | ProcessFailure | RpcFailure | CliFailure;

export function safeFailureMessage(failure: AppFailure): string {
  switch (failure._tag) {
    case "InputFailure":
    case "AuthFailure":
    case "ProcessFailure":
    case "RpcFailure":
    case "CliFailure":
      return failure.safeMessage;
  }
}
