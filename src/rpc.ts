import { isIP } from "node:net";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  Rpc,
  RpcClient,
  RpcClientError,
  RpcGroup,
  RpcSerialization,
} from "effect/rpc";
import * as Socket from "effect/socket/Socket";

import { RpcFailure } from "./errors.ts";

export const USAGE_LIMIT_TIMEOUT_MS = 10_000;
const ORCHESTRATION_PROTOCOL_VERSION = "2";
const PING_INTERVAL_MS = 5_000;

const RPC_MESSAGES = {
  invalidUrl: "The T3 server URL is invalid.",
  invalidOrigin:
    "The T3 server URL must be an origin without credentials, path, query, or fragment.",
  loopback: "The --url override must point to a loopback address.",
  timeout: "Timed out waiting for T3 usage limits.",
  connect: "Could not connect to the T3 server.",
  connection: "The T3 server connection failed.",
  closed:
    "The T3 server closed the connection before the initial data arrived.",
  ended: "T3 usage-limit subscription ended before the initial data arrived.",
  failed: "T3 usage-limit subscription failed.",
  read: "Could not read the T3 usage-limit stream.",
  sources: "T3 server sent invalid usage-limit source data.",
  snapshot: "T3 server sent an invalid usage-limits snapshot.",
} as const satisfies Record<string, string>;

// Only the read-only cached subscription is declared, so the client cannot
// issue refreshes, probes, or any other T3 RPC.
const SubscribeServerConfig = Rpc.make("subscribeServerConfig", {
  payload: {
    usageLimitSources: Schema.Literal(true),
    workspaceSnapshotsOnDemand: Schema.Literal(true),
  },
  success: Schema.Unknown,
  error: Schema.Unknown,
  stream: true,
});

const ServerConfigRpcs = RpcGroup.make(SubscribeServerConfig);

const SnapshotEventSchema = Schema.Struct({
  type: Schema.Literal("snapshot"),
  config: Schema.Struct({ providers: Schema.Array(Schema.Unknown) }),
});

const SourcesEventSchema = Schema.Struct({
  type: Schema.Literal("usageLimitSourcesUpdated"),
  payload: Schema.Struct({ sources: Schema.Array(Schema.Unknown) }),
});

const EventHeaderSchema = Schema.Struct({ type: Schema.String });

function isLoopbackHostname(hostname: string): boolean {
  const unwrapped =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  const normalized = unwrapped.toLowerCase();
  if (normalized === "localhost" || normalized.endsWith(".localhost"))
    return true;
  if (isIP(unwrapped) === 6) return normalized === "::1";
  if (isIP(unwrapped) !== 4) return false;
  return Number(unwrapped.split(".")[0]) === 127;
}

export function isLoopbackUrl(origin: string): boolean {
  try {
    return isLoopbackHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}

export const webSocketUrl = Effect.fnUntraced(function* (
  origin: string,
  requireLoopback = true,
): Effect.fn.Return<string, RpcFailure> {
  const url = yield* Effect.try({
    try: () => new URL(origin),
    catch: () => new RpcFailure({ message: RPC_MESSAGES.invalidUrl }),
  });

  if (
    !["http:", "https:", "ws:", "wss:"].includes(url.protocol) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    return yield* new RpcFailure({ message: RPC_MESSAGES.invalidOrigin });
  }
  if (requireLoopback && !isLoopbackHostname(url.hostname)) {
    return yield* new RpcFailure({ message: RPC_MESSAGES.loopback });
  }

  url.protocol =
    url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.searchParams.set("orchestrationProtocol", ORCHESTRATION_PROTOCOL_VERSION);
  return url.toString();
});

export const canonicalLoopbackOrigin = Effect.fnUntraced(function* (
  origin: string,
): Effect.fn.Return<string, RpcFailure> {
  const value = yield* webSocketUrl(origin, true);
  const socketUrl = new URL(value);
  socketUrl.protocol = socketUrl.protocol === "wss:" ? "https:" : "http:";
  socketUrl.pathname = "/";
  socketUrl.search = "";
  return socketUrl.origin;
});

export interface UsageLimitStreams {
  readonly providers: readonly unknown[];
  readonly sources: readonly unknown[];
}

interface InitialState {
  readonly providers: Option.Option<readonly unknown[]>;
  readonly sources: Option.Option<readonly unknown[]>;
}

const projectEvent = Effect.fnUntraced(function* (
  state: InitialState,
  event: unknown,
): Effect.fn.Return<
  readonly [InitialState, ReadonlyArray<UsageLimitStreams>],
  RpcFailure
> {
  const header = Option.getOrUndefined(
    Schema.decodeUnknownOption(EventHeaderSchema)(event),
  );
  const next = yield* Match.value(header?.type).pipe(
    Match.when("snapshot", () =>
      Schema.decodeUnknownEffect(SnapshotEventSchema)(event).pipe(
        Effect.map((snapshot) => ({
          ...state,
          providers: Option.some(snapshot.config.providers),
        })),
        Effect.mapError(
          () => new RpcFailure({ message: RPC_MESSAGES.snapshot }),
        ),
      ),
    ),
    Match.when("usageLimitSourcesUpdated", () =>
      Schema.decodeUnknownEffect(SourcesEventSchema)(event).pipe(
        Effect.map((sourceEvent) => ({
          ...state,
          sources: Option.some(sourceEvent.payload.sources),
        })),
        Effect.mapError(
          () => new RpcFailure({ message: RPC_MESSAGES.sources }),
        ),
      ),
    ),
    Match.orElse(() => Effect.succeed(state)),
  );
  return Option.isSome(next.providers) && Option.isSome(next.sources)
    ? [next, [{ providers: next.providers.value, sources: next.sources.value }]]
    : [next, []];
});

// Server-provided errors, defects, and close reasons can carry provider text
// or credentials, so only fixed messages ever leave this module.
function safeFailure(error: unknown): RpcFailure {
  if (error instanceof RpcFailure) return error;
  if (!(error instanceof RpcClientError.RpcClientError))
    return new RpcFailure({ message: RPC_MESSAGES.failed });
  return Match.value(error.reason._tag).pipe(
    Match.when(
      "SocketOpenError",
      () => new RpcFailure({ message: RPC_MESSAGES.connect }),
    ),
    Match.when(
      "SocketCloseError",
      () => new RpcFailure({ message: RPC_MESSAGES.closed }),
    ),
    Match.when(
      "RpcClientDefect",
      () => new RpcFailure({ message: RPC_MESSAGES.read }),
    ),
    Match.orElse(() => new RpcFailure({ message: RPC_MESSAGES.connection })),
  );
}

function redactCause<A>(
  effect: Effect.Effect<A, unknown>,
): Effect.Effect<A, RpcFailure> {
  return Effect.catchCause(effect, (cause) => {
    if (Cause.hasInterruptsOnly(cause))
      return Effect.failCause(cause as Cause.Cause<never>);
    const error = Cause.findErrorOption(cause);
    return Effect.fail(
      Option.isSome(error)
        ? safeFailure(error.value)
        : new RpcFailure({ message: RPC_MESSAGES.failed }),
    );
  });
}

// Bun's WebSocket accepts the handshake headers the DOM typing omits.
const BunWebSocket = WebSocket as unknown as new (
  url: string,
  options?: Socket.WebSocketConstructorOptions,
) => Socket.WebSocketLike;

const bunWebSocketConstructor = Layer.succeed(Socket.WebSocketConstructor)(
  (url, options) => new BunWebSocket(url, options),
);

function protocolLayer(url: string, token: string, timeoutMs: number) {
  // The overall deadline must be what ends a silent server, so the library's
  // own open and ping timeouts are kept beyond it.
  const libraryTimeoutMs = timeoutMs + PING_INTERVAL_MS;
  return RpcClient.layerProtocolSocket({
    pingInterval: PING_INTERVAL_MS,
    pingTimeout: libraryTimeoutMs,
    retryTransientErrors: false,
    retryPolicy: Schedule.recurs(0),
  }).pipe(
    Layer.provide([
      Socket.layerWebSocket(url, {
        headers: { Authorization: `Bearer ${token}` },
        openTimeout: libraryTimeoutMs,
      }).pipe(Layer.provide(bunWebSocketConstructor)),
      RpcSerialization.layerJson,
    ]),
  );
}

export const readUsageLimitStreams = Effect.fnUntraced(function* (input: {
  readonly origin: string;
  readonly token: string;
  readonly timeoutMs?: number;
}): Effect.fn.Return<UsageLimitStreams, RpcFailure> {
  const url = yield* webSocketUrl(input.origin, true);
  const timeoutMs = input.timeoutMs ?? USAGE_LIMIT_TIMEOUT_MS;

  const initialData = Effect.gen(function* () {
    const client = yield* RpcClient.make(ServerConfigRpcs, {
      disableTracing: true,
    });
    return yield* client
      .subscribeServerConfig({
        usageLimitSources: true,
        workspaceSnapshotsOnDemand: true,
      })
      .pipe(
        Stream.mapAccumEffect(
          (): InitialState => ({
            providers: Option.none(),
            sources: Option.none(),
          }),
          projectEvent,
        ),
        Stream.runHead,
      );
  }).pipe(
    Effect.scoped,
    Effect.provide(protocolLayer(url, input.token, timeoutMs)),
    // The RPC client logs unexpected transport causes, which may include
    // server-provided text.
    Effect.provideService(References.MinimumLogLevel, "None"),
    redactCause,
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(new RpcFailure({ message: RPC_MESSAGES.ended })),
        onSome: Effect.succeed,
      }),
    ),
  );

  return yield* Effect.timeoutOrElse(initialData, {
    duration: timeoutMs,
    orElse: () =>
      Effect.fail(new RpcFailure({ message: RPC_MESSAGES.timeout })),
  });
});
